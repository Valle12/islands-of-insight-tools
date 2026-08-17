#include "Profile.h"

#include "Budget.h"
#include "Puzzle.h"
#include "Rules.h"
#include "Search.h"
#include "Types.h"
#include "Verify.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace lg::profile {
namespace {

using rules::Rule;

constexpr uint8_t kNoClass = 0xFF;
constexpr uint8_t kNoTag = 0xFF;

/// How many states the sweep may accumulate over the whole board before it
/// gives up. At five bytes of trail each this is about half a gigabyte, and
/// `logicGridTest67` — the widest thing in the corpus at 15 — needs 76 million
/// of them. Boards that stay narrow use a few thousand.
constexpr size_t kDefaultStateCap = 100'000'000;

/// How far back a forbidden arrangement may reach BEYOND the frontier before
/// the board is declined. The frontier already carries the last `width` cells,
/// so a two-row pattern costs a bit or two and a tall one costs a row; every
/// bit doubles the state count in the worst case, which is what the ceiling is
/// really about. The runtime cap catches what gets past it.
constexpr int kMaxHistoryBits = 24;

/// How many dart clues the sweep will carry counters for, and how many states
/// their counters may take together at any one cell. A dart's counter is only
/// live between the first and last cell of its ray, so darts on different rows
/// of the sweep cost nothing at all.
constexpr int kMaxDarts = 4;
constexpr int kMaxDartStates = 4096;

/**
 * The widest frontier the sweep will take, which is NOT `kMaxSide`.
 *
 * The state count grows steeply with the frontier's width — 15 already reaches
 * 4.7 million live states — so anything past 16 is out of reach whatever the
 * memory ceiling, and declining is both honest and free. Keeping the bound here
 * rather than at 32 halves `Frontier`, and since the sweep's cost is dominated
 * by random access into a hash set of millions of them, that halves the part
 * that actually hurts. Measured in the browser on `logicGridTest67`.
 */
constexpr int kMaxProfileWidth = 16;
/// Room for one class per slot, plus the id a fresh class takes while the one
/// it replaces is still counted.
constexpr int kProfileClasses = kMaxProfileWidth + 2;

/**
 * The frontier, canonicalised.
 *
 * `cls` is a restricted-growth string — the first slot in a class gets the next
 * unused id — so two frontiers describing the same partition are byte-equal and
 * collapse into one state. Without that normalisation the sweep would keep one
 * copy per labelling and gain nothing.
 *
 * Colour is held PER CLASS rather than per slot: every cell of a region shares
 * it, so a bit per class is the whole of it.
 */
struct Frontier {
  std::array<uint8_t, kMaxProfileWidth> cls{};
  /// The letter each class carries, or kNoTag. Indexed by class, not by slot.
  std::array<uint8_t, kProfileClasses> tag{};
  uint8_t classes = 0;
  /// bit0: a dark region has already closed; bit1: a light one has. Reach it
  /// through `hasClosed` / `closedBit` rather than by hand. Sits HERE, beside
  /// `classes` and behind the two byte arrays, so the pair fills what would
  /// otherwise be alignment padding: this struct is copied and compared
  /// millions of times a sweep, and on the widest board its size is most of
  /// what the sweep costs.
  std::byte closed{};
  /// Bit k set when class k is dark.
  uint32_t darkMask = 0;
  /**
   * The colours of the cells that have already left the frontier but a
   * forbidden arrangement can still reach: bit i is the cell `width + 1 + i`
   * scan positions back, set when it is dark.
   *
   * The frontier's own slots ARE the last `width` cells in scan order, so this
   * only has to carry what a pattern needs beyond them — one bit for a 2x2, a
   * row for a three-tall T. Unplayable cells go in as light and are never read:
   * a pattern instance every one of whose cells is not playable is dropped when
   * the plan is built, so it can never fire.
   */
  uint32_t hist = 0;
  /// Dark cells counted so far on each dart's ray, in `Plan::darts` order, and
  /// back to zero once that dart has been checked.
  std::array<uint8_t, kMaxDarts> darts{};

  bool operator==(const Frontier &other) const = default;
};

/// The forced-set pass keeps every layer's frontiers plus two transition
/// indices per state, so a state costs `sizeof(Frontier)` plus eight bytes
/// rather than the trail's five. The cap is correspondingly tighter.
constexpr size_t kForcedBytes = sizeof(Frontier) + 8;
constexpr size_t kDefaultForcedCap = 12'000'000;

/// The `closed` bit belonging to a colour. Only kDark and kLight ever close.
constexpr std::byte closedBit(const uint8_t color) {
  return color == kDark ? std::byte{1} : std::byte{2};
}

/// Whether a region of this colour has already left the frontier for good.
constexpr bool hasClosed(const Frontier &f, const uint8_t color) {
  return (f.closed & closedBit(color)) != std::byte{};
}

/**
 * FNV-1a over the part of the frontier that carries information.
 *
 * It reads `width` slots and `classes` tags rather than the whole fixed arrays
 * — on a 15-wide board that is a third of the bytes, and this runs once per
 * state per cell, which is the sweep's hot loop. Equality still compares the
 * arrays in full, and `canonicalise` resets both tails to a fixed filler, so
 * equal frontiers agree on the prefix and therefore hash alike.
 */
struct FrontierHash {
  int width = 0;
  /// How many dart counters carry information on this board. The rest of the
  /// array is always zero, so leaving it out of the hash is free.
  int darts = 0;

  [[nodiscard]] size_t hashOf(const Frontier &f) const {
    uint64_t hash = 1469598103934665603ULL;
    const auto eat = [&hash](const uint8_t byte) {
      hash ^= byte;
      hash *= 1099511628211ULL;
    };
    for (int j = 0; j < width; j++)
      eat(f.cls[slot(j)]);
    for (uint8_t k = 0; k < f.classes; k++)
      eat(f.tag[slot(k)]);
    for (int i = 0; i < 4; i++)
      eat(static_cast<uint8_t>(f.darkMask >> (8 * i)));
    for (int i = 0; i < 4; i++)
      eat(static_cast<uint8_t>(f.hist >> (8 * i)));
    for (int i = 0; i < darts; i++)
      eat(f.darts[slot(i)]);
    eat(f.classes);
    eat(std::to_integer<uint8_t>(f.closed));
    return static_cast<size_t>(hash);
  }
};

/**
 * The de-duplicating index over the layer being built.
 *
 * Flat and open-addressed, holding INDICES into that layer. Both of those are
 * measured decisions on the widest board, where a layer reaches 4.7 million
 * states and the whole sweep inserts 76 million:
 *
 *  - **Indices, not frontiers**, so each state is stored once rather than twice.
 *  - **Flat, not `std::unordered_set`**, which is node-based and would allocate
 *    once per insertion — 76 million allocations, each a pointer chase to probe.
 *    Linear probing over one `uint32_t` array keeps the probe in cache and the
 *    allocator out of the hot loop entirely.
 */
class SlotIndex {
public:
  void reset(const size_t expected, const FrontierHash hash) {
    hash_ = hash;
    size_t capacity = 64;
    while (capacity < (expected + 1) * 2)
      capacity <<= 1U;
    slots_.assign(capacity, kEmpty);
    mask_ = capacity - 1;
    count_ = 0;
  }

  /// True when `at` was not already present. `pool[at]` must be live.
  bool insert(const std::vector<Frontier> &pool, const uint32_t at) {
    return place(pool, at) == at;
  }

  /// Where this frontier ends up living: `at` when it was new, otherwise the
  /// slot already holding an equal one. The forced-set pass needs the answer
  /// rather than just "was it new", because it records where each transition
  /// LANDS.
  uint32_t insertOrFind(const std::vector<Frontier> &pool, const uint32_t at) {
    return place(pool, at);
  }

private:
  static constexpr uint32_t kEmpty = 0xFFFFFFFFU;

  uint32_t place(const std::vector<Frontier> &pool, const uint32_t at) {
    // Half full at most: linear probing degrades badly past that, and the
    // layers grow smoothly enough that this rarely fires after the reserve.
    if ((count_ + 1) * 2 > slots_.size())
      grow(pool);
    size_t i = hash_.hashOf(pool[at]) & mask_;
    while (slots_[i] != kEmpty) {
      if (pool[slots_[i]] == pool[at])
        return slots_[i];
      i++;
      i &= mask_;
    }
    slots_[i] = at;
    count_++;
    return at;
  }

  void grow(const std::vector<Frontier> &pool) {
    std::vector old(slots_.size() * 2, kEmpty);
    slots_.swap(old);
    mask_ = slots_.size() - 1;
    count_ = 0;
    for (const uint32_t at : old) {
      if (at == kEmpty)
        continue;
      // Straight in: rehashing cannot produce a duplicate, and going through
      // `place` here would recurse into `grow`.
      size_t i = hash_.hashOf(pool[at]) & mask_;
      while (slots_[i] != kEmpty) {
        i++;
        i &= mask_;
      }
      slots_[i] = at;
      count_++;
    }
  }

  std::vector<uint32_t> slots_;
  size_t mask_ = 0;
  size_t count_ = 0;
  FrontierHash hash_;
};

/**
 * What each layer keeps FOREVER, which is only what the answer is read back
 * out of: whose state this came from, and the colour that got here.
 *
 * The frontiers themselves are needed to build the next layer and never again,
 * so exactly two of them are alive at a time. That split is what makes the
 * sweep fit: `logicGridTest67` reaches 76 million states across its layers but
 * peaks at 4.7 million in any one of them, so keeping frontiers everywhere
 * would cost gigabytes where five bytes a state costs a few hundred megabytes.
 */
struct Trail {
  std::vector<uint32_t> parent;
  std::vector<uint8_t> chose;
};

/**
 * The board as the sweep walks it.
 *
 * Two choices, and they are not equally important:
 *
 *  - **Across the shorter side.** The state count grows with the frontier's
 *    WIDTH, steeply, so a 4x10 board is swept as ten rows of four rather than
 *    four rows of ten. This decides the axis and nothing else may override it.
 *  - **From the clued end.** An unlettered region is unconstrained, so rows
 *    with no clue in them do nothing but enumerate frontiers; every check this
 *    sweep has fires on a region that carries a LETTER. Board 67 keeps five of
 *    its eight clues on one edge, so entering from that edge starts pruning
 *    immediately instead of after seven free rows.
 */
struct Scan {
  bool transposed = false;
  bool reversed = false;
  int width = 0;
  int height = 0;

  [[nodiscard]] int cellAt(const int x, const int y) const {
    const int row = reversed ? height - 1 - y : y;
    return transposed ? cellIndex(row, x) : cellIndex(x, row);
  }

  /// Where a board cell falls in the sweep's order.
  [[nodiscard]] int posOf(const int index) const {
    const int ox = columnOf(index);
    const int oy = rowOf(index);
    const int x = transposed ? oy : ox;
    const int row = transposed ? ox : oy;
    const int y = reversed ? height - 1 - row : row;
    return y * width + x;
  }
};

Scan scanOf(const Model &model) {
  const bool transposed = model.width() > model.height();
  const Scan best{.transposed = transposed,
                  .reversed = false,
                  .width = transposed ? model.height() : model.width(),
                  .height = transposed ? model.width() : model.height()};

  // The axis is settled; only the direction is open, so pick the one that meets
  // the clues soonest. Summing positions rather than taking the first keeps a
  // single outlying clue from deciding it.
  Scan flipped = best;
  flipped.reversed = true;
  long long straight = 0;
  long long reverse = 0;
  for (const Clue &clue : model.puzzle.clues) {
    straight += best.posOf(clue.index);
    reverse += flipped.posOf(clue.index);
  }
  return reverse < straight ? flipped : best;
}

/**
 * One forbidden arrangement, anchored on the LAST of its cells in scan order.
 *
 * `back[i]` counts scan positions back from that cell, so the whole
 * arrangement is readable the moment the anchor is coloured and never before.
 * An instance is built per POSITION, which is what lets the plan drop the ones
 * that would fall off the board or onto a gap: a pattern needing a cell no
 * colouring ever reaches can never fire, and dropping it here is what keeps
 * the history short.
 */
struct PatternCheck {
  std::array<uint8_t, rules::kMaxPatternCells> back{};
  std::array<uint8_t, rules::kMaxPatternCells> color{};
  uint8_t count = 0;
};

/// One dart, as the sweep counts it: always the DARK cells on its ray, with
/// the light reading taken as the rest of the ray, so one counter serves
/// whichever colour the dart's own square asks for.
struct DartPlan {
  /// Counts the sweep accepts, bit per count. `countMatches` is folded in here
  /// once rather than consulted per state.
  uint64_t accept = 0;
  int rayCells = 0;
  bool wantDark = false;
};

/// Everything about the puzzle the sweep needs, precomputed once.
struct Plan {
  Scan scan;
  /// The letter on each scan cell, or kNoTag.
  std::vector<uint8_t> letterAt;
  /// The last scan position at which each letter appears; -1 when it does not.
  std::array<int, kLetterCount> lastPos{};
  /// Arrangements to test when each scan position is coloured.
  std::vector<std::vector<PatternCheck>> checks;
  /// Darts whose ray this position is on, and darts this position settles.
  std::vector<std::vector<uint8_t>> dartInc;
  std::vector<std::vector<uint8_t>> dartDue;
  std::vector<DartPlan> darts;
  uint32_t histMask = 0;
  int histBits = 0;
  bool connectDark = false;
  bool connectLight = false;
  /// False when something about the board outgrew what the state can carry.
  bool usable = true;
};

/**
 * The pattern cell that comes LAST in scan order, which every offset is taken
 * back from.
 *
 * Compared as the PAIR (dy, dx) rather than as `dy * width + dx`. The two agree
 * only while a pattern is narrower than the frontier, and on a 3-wide board a
 * five-cell run is not — the flattened form would then tie two cells at the
 * same offset, hand back an anchor that is not last, and leave another cell
 * with a NEGATIVE distance back from it.
 */
int anchorOf(const rules::Pattern &pattern) {
  int best = 0;
  for (int i = 1; i < pattern.count; i++) {
    const auto &[dx, dy, color] = pattern.cells[slot(i)];
    const auto &[bx, by, unused] = pattern.cells[slot(best)];
    if (dy > by || (dy == by && dx > bx))
      best = i;
  }
  return best;
}

/// This pattern laid on the board with its anchor at (x, y), or nothing when
/// some cell of it falls off the board or onto a square no colouring reaches.
bool instanceAt(const Model &model, const Scan &scan,
                const rules::Pattern &pattern, const int x, const int y,
                PatternCheck &out) {
  const auto &[ax, ay, unused] = pattern.cells[slot(anchorOf(pattern))];
  out.count = 0;
  for (int i = 0; i < pattern.count; i++) {
    const auto &[dx, dy, color] = pattern.cells[slot(i)];
    const int cx = x + dx - ax;
    const int cy = y + dy - ay;
    if (cx < 0 || cx >= scan.width || cy < 0 || cy >= scan.height)
      return false;
    if (!model.playable.test(scan.cellAt(cx, cy)))
      return false;
    out.back[slot(out.count)] =
        static_cast<uint8_t>((y - cy) * scan.width + (x - cx));
    out.color[slot(out.count)] = color;
    out.count++;
  }
  return true;
}

/// How far back of the frontier this check's deepest cell reads.
int deepestOf(const PatternCheck &check) {
  int deepest = 0;
  for (int i = 0; i < check.count; i++)
    deepest = std::max(deepest, static_cast<int>(check.back[slot(i)]));
  return deepest;
}

/// Every arrangement the rules forbid, laid out per scan position, and how far
/// back of the frontier the deepest of them reaches.
void planPatterns(const Model &model, Plan &plan) {
  const int cells = plan.scan.width * plan.scan.height;
  plan.checks.assign(slot(cells), {});
  // Empty instance lists: the sized families are refused by `applicable`, so
  // the flag mask is the whole of what this board forbids.
  const rules::Patterns patterns =
      rules::patternsFor(model.puzzle.ruleMask, {}, {});
  int deepest = 0;
  for (int pos = 0; pos < cells; pos++) {
    const int x = pos % plan.scan.width;
    const int y = pos / plan.scan.width;
    for (const rules::Pattern &pattern : patterns) {
      if (PatternCheck check;
          instanceAt(model, plan.scan, pattern, x, y, check)) {
        deepest = std::max(deepest, deepestOf(check));
        plan.checks[slot(pos)].push_back(check);
      }
    }
  }
  plan.histBits = std::max(0, deepest - plan.scan.width);
  plan.histMask = plan.histBits == 0
                      ? 0
                      : static_cast<uint32_t>((uint64_t{1} << plan.histBits) - 1);
  if (plan.histBits > kMaxHistoryBits)
    plan.usable = false;
}

/// The counts a dart accepts, folded into a bitmask so the sweep never has to
/// consult the model. Counts past the ray's length cannot occur.
uint64_t acceptedCounts(const Model &model, const int value, const int ray) {
  uint64_t accept = 0;
  for (int count = 0; count <= ray; count++) {
    if (verify::countMatches(model, count, value))
      accept |= uint64_t{1} << count;
  }
  return accept;
}

/// Every dart, with the positions that feed and settle its counter. False when
/// the board carries more of them, or more counter states at one cell, than
/// the frontier will hold.
bool planDarts(const Model &model, Plan &plan) {
  const int cells = plan.scan.width * plan.scan.height;
  plan.dartInc.assign(slot(cells), {});
  plan.dartDue.assign(slot(cells), {});
  std::vector<int> first;
  std::vector<int> last;
  for (const Clue &clue : model.puzzle.clues) {
    if (clue.kind != kClueDart)
      continue;
    if (plan.darts.size() >= static_cast<size_t>(kMaxDarts))
      return false;
    const auto index = static_cast<uint8_t>(plan.darts.size());
    const auto [stepX, stepY] = kDirectionSteps[slot(clue.direction)];
    int ray = 0;
    int firstPos = cells;
    int lastPos = plan.scan.posOf(clue.index);
    for (int x = columnOf(clue.index) + stepX, y = rowOf(clue.index) + stepY;
         x >= 0 && x < model.width() && y >= 0 && y < model.height();
         x += stepX, y += stepY) {
      const int cell = cellIndex(x, y);
      if (!model.playable.test(cell))
        continue;
      const int pos = plan.scan.posOf(cell);
      plan.dartInc[slot(pos)].push_back(index);
      firstPos = std::min(firstPos, pos);
      lastPos = std::max(lastPos, pos);
      ray++;
    }
    plan.dartDue[slot(lastPos)].push_back(index);
    first.push_back(std::min(firstPos, lastPos));
    last.push_back(lastPos);
    // `applicable` has already refused a dart whose own square the board does
    // not paint, so the colour it counts is known here and stays known.
    const uint8_t own = model.puzzle.givens[slot(clue.index)];
    plan.darts.push_back({.accept = acceptedCounts(model, clue.value, ray),
                          .rayCells = ray,
                          .wantDark = opposite(own) == kDark});
  }

  for (int pos = 0; pos < cells; pos++) {
    long long states = 1;
    for (size_t i = 0; i < plan.darts.size(); i++) {
      if (first[i] <= pos && pos <= last[i])
        states *= plan.darts[i].rayCells + 1;
    }
    if (states > kMaxDartStates)
      return false;
  }
  return true;
}

Plan planOf(const Model &model) {
  Plan plan;
  plan.scan = scanOf(model);
  plan.letterAt.assign(slot(plan.scan.width * plan.scan.height), kNoTag);
  plan.lastPos.fill(-1);
  plan.connectDark = model.hasRule(Rule::ConnectDark);
  plan.connectLight = model.hasRule(Rule::ConnectLight);

  // Letters and darts only, and `applicable` below has already refused any
  // board that carries anything else — without which a clue this sweep cannot
  // express would be silently skipped here and the answer claimed as proved.
  for (const Clue &clue : model.puzzle.clues) {
    if (clue.kind != kClueLetter)
      continue;
    const int pos = plan.scan.posOf(clue.index);
    plan.letterAt[slot(pos)] = static_cast<uint8_t>(clue.value);
    plan.lastPos[slot(clue.value)] =
        std::max(plan.lastPos[slot(clue.value)], pos);
  }
  planPatterns(model, plan);
  if (!planDarts(model, plan))
    plan.usable = false;
  return plan;
}

/// Relabels classes into restricted-growth order and drops the ones that no
/// slot mentions any more. Both array tails are reset so byte equality is
/// exactly frontier equality.
Frontier canonicalise(const Frontier &raw, const int width) {
  std::array<uint8_t, kProfileClasses> remap{};
  remap.fill(kNoClass);

  Frontier out;
  out.cls.fill(kNoClass);
  out.tag.fill(kNoTag);
  out.closed = raw.closed;
  // Neither of these is indexed by CLASS, so relabelling must leave them alone.
  out.hist = raw.hist;
  out.darts = raw.darts;

  uint8_t next = 0;
  for (int j = 0; j < width; j++) {
    const uint8_t old = raw.cls[slot(j)];
    if (old == kNoClass)
      continue;
    if (remap[slot(old)] == kNoClass) {
      remap[slot(old)] = next;
      out.tag[slot(next)] = raw.tag[slot(old)];
      if ((raw.darkMask & (1U << old)) != 0)
        out.darkMask |= 1U << next;
      next++;
    }
    out.cls[slot(j)] = remap[slot(old)];
  }
  out.classes = next;
  return out;
}

/// The colour a class holds.
uint8_t colorOf(const Frontier &f, const uint8_t cls) {
  return (f.darkMask & (1U << cls)) != 0 ? kDark : kLight;
}

void setColor(Frontier &f, const uint8_t cls, const uint8_t color) {
  if (color == kDark)
    f.darkMask |= 1U << cls;
  else
    f.darkMask &= ~(1U << cls);
}

/// Whether this colour is required to form a single region. Only meaningful
/// for kDark and kLight, which are the only colours a class ever holds.
constexpr bool mustConnect(const Plan &plan, const uint8_t color) {
  return color == kDark ? plan.connectDark : plan.connectLight;
}

/// Where the sweep is, and what the frontier held at that slot on the way in.
struct Site {
  int width = 0;
  int x = 0;
  int y = 0;
  int pos = 0;
  /// The class occupying this slot before the step. It leaves the frontier
  /// unless the new colour joins it.
  uint8_t leaving = kNoClass;
};

/// Rewrites every slot carrying `from` to `to`. The merge half of `joinAt`.
void relabel(Frontier &work, const int width, const uint8_t from,
             const uint8_t to) {
  for (int j = 0; j < width; j++) {
    if (work.cls[slot(j)] == from)
      work.cls[slot(j)] = to;
  }
}

/// Whether any slot still carries `cls`.
bool stillOnFrontier(const Frontier &work, const int width,
                     const uint8_t cls) {
  const auto end = work.cls.begin() + width;
  return std::find(work.cls.begin(), end, cls) != end;
}

/// Whether any class still on the frontier carries `letter`.
bool anyOpenClassHolds(const Frontier &work, const int width,
                       const uint8_t letter) {
  for (int j = 0; j < width; j++) {
    if (const uint8_t cls = work.cls[slot(j)];
        cls != kNoClass && work.tag[slot(cls)] == letter)
      return true;
  }
  return false;
}

/// The lowest class id no slot is using, or kNoClass when the frontier is
/// full. At most `width` classes can be live plus the one about to leave, so
/// on a board the sweep accepts an id always exists.
uint8_t freeClass(const Frontier &work, const int width) {
  std::array<bool, kProfileClasses> used{};
  for (int j = 0; j < width; j++) {
    if (work.cls[slot(j)] != kNoClass)
      used[slot(work.cls[slot(j)])] = true;
  }
  const auto at = std::ranges::find(used, false);
  return at == used.end() ? kNoClass
                          : static_cast<uint8_t>(at - used.begin());
}

/// What joining this cell to its neighbours settled.
struct Join {
  /// The class the cell takes, or kNoClass when nothing adjacent carries the
  /// colour and a fresh region has to start.
  uint8_t cls = kNoClass;
  /**
   * Whether the class leaving the frontier was ABSORBED rather than dropped.
   *
   * This is the distinction the whole sweep turns on. A merge and a close both
   * make a label vanish, and they mean opposite things: a merge is two pieces
   * of one region meeting, a close is a region that can never grow again.
   * Reading the first as the second rejects perfectly good boards — measured,
   * it threw out the known answer to `logicGridTest67` at the very last cell.
   */
  bool merged = false;
  /// False for the one illegal join: one region, two letters.
  bool legal = true;
};

/// Joins the cell to the neighbour on its left, the one leaving from above, or
/// both — merging their classes when they are two pieces of one region.
Join joinAt(Frontier &work, const Site &site, const uint8_t color) {
  Join join;
  if (const uint8_t left = site.x > 0 ? work.cls[slot(site.x - 1)] : kNoClass;
      left != kNoClass && colorOf(work, left) == color)
    join.cls = left;

  const uint8_t above = site.y > 0 ? site.leaving : kNoClass;
  if (above == kNoClass || colorOf(work, above) != color)
    return join;
  if (join.cls == kNoClass) {
    join.cls = above;
    return join;
  }
  if (join.cls == above)
    return join;

  const uint8_t mineTag = work.tag[slot(join.cls)];
  const uint8_t aboveTag = work.tag[slot(above)];
  if (mineTag != kNoTag && aboveTag != kNoTag && mineTag != aboveTag) {
    join.legal = false; // one region, two letters
    return join;
  }
  work.tag[slot(join.cls)] = mineTag != kNoTag ? mineTag : aboveTag;
  relabel(work, site.width, above, join.cls);
  join.merged = true;
  return join;
}

/// What painting the cell settled: whether it was legal at all, and whether it
/// absorbed the class leaving the frontier.
struct Painted {
  bool legal = false;
  bool merged = false;
};

/// Gives the cell its colour and class, starting a fresh region when nothing
/// adjacent carries the colour.
Painted paint(const Plan &plan, Frontier &work, const Site &site,
              const uint8_t color) {
  // A colour whose region already closed cannot appear again: that would be a
  // second region of a colour the board says is all one.
  if (mustConnect(plan, color) && hasClosed(work, color))
    return {};

  const auto [cls, joined, legal] = joinAt(work, site, color);
  if (!legal)
    return {};

  uint8_t mine = cls;
  if (mine == kNoClass) {
    mine = freeClass(work, site.width);
    if (mine == kNoClass)
      return {};
    work.tag[slot(mine)] = kNoTag;
  }
  work.cls[slot(site.x)] = mine;
  setColor(work, mine, color);

  const Painted painted{.legal = true, .merged = joined};
  const uint8_t letter = plan.letterAt[slot(site.pos)];
  if (letter == kNoTag)
    return painted;
  if (const uint8_t held = work.tag[slot(mine)];
      held != kNoTag && held != letter)
    return {};
  work.tag[slot(mine)] = letter;
  return painted;
}

/// The checks a class leaving the frontier FOR GOOD has to pass: its letter
/// must be complete and unique, and a must-connect colour may only close once.
bool closeClass(const Plan &plan, Frontier &work, const Site &site) {
  if (const uint8_t letter = work.tag[slot(site.leaving)]; letter != kNoTag) {
    // The region can never grow again, so every cell of its letter must
    // already be inside it, and no other open region may claim the letter.
    if (plan.lastPos[slot(letter)] > site.pos)
      return false;
    if (anyOpenClassHolds(work, site.width, letter))
      return false;
  }
  const uint8_t color = colorOf(work, site.leaving);
  if (!mustConnect(plan, color))
    return true;
  if (hasClosed(work, color))
    return false; // a second region of a must-connect colour
  work.closed |= closedBit(color);
  return true;
}

/**
 * The colour a cell `back` scan positions before the one being coloured holds.
 *
 * Three sources, and the split is the whole reason the extra history is as
 * short as it is: the cell itself, then the frontier — whose `width` slots ARE
 * the last `width` cells in scan order — and only past that the history bits.
 */
uint8_t colorBack(const Plan &plan, const Frontier &in, const int x,
                  const int back, const uint8_t current) {
  if (back == 0)
    return current;
  if (back <= plan.scan.width) {
    const uint8_t cls =
        in.cls[slot((x - back + plan.scan.width) % plan.scan.width)];
    return cls == kNoClass ? kUnplayable : colorOf(in, cls);
  }
  return ((in.hist >> (back - plan.scan.width - 1)) & 1U) != 0 ? kDark : kLight;
}

/// Whether colouring this cell completes a forbidden arrangement.
bool patternsHold(const Plan &plan, const Frontier &in, const Site &site,
                  const uint8_t color) {
  for (const PatternCheck &check : plan.checks[slot(site.pos)]) {
    bool present = true;
    for (int i = 0; i < check.count && present; i++)
      present = colorBack(plan, in, site.x, check.back[slot(i)], color) ==
                check.color[slot(i)];
    if (present)
      return false;
  }
  return true;
}

/// Feeds this cell to every dart counting it, then settles the darts this cell
/// finishes and puts their counters back to zero so states can merge again.
bool countDarts(const Plan &plan, Frontier &work, const Site &site,
                const uint8_t color) {
  for (const uint8_t index : plan.dartInc[slot(site.pos)]) {
    if (color == kDark)
      work.darts[slot(index)]++;
  }
  for (const uint8_t index : plan.dartDue[slot(site.pos)]) {
    const auto &[accept, rayCells, wantDark] = plan.darts[slot(index)];
    const int dark = work.darts[slot(index)];
    const int count = wantDark ? dark : rayCells - dark;
    work.darts[slot(index)] = 0;
    if (((accept >> count) & 1U) == 0)
      return false;
  }
  return true;
}

/// One cell of the sweep. False when the choice is already illegal.
bool step(const Plan &plan, const Frontier &in, const int x, const int y,
          const uint8_t color, Frontier &out) {
  const int width = plan.scan.width;
  const Site site{.width = width,
                  .x = x,
                  .y = y,
                  .pos = y * width + x,
                  .leaving = in.cls[slot(x)]};
  if (!patternsHold(plan, in, site, color))
    return false;
  Frontier work = in;
  bool merged = false;
  // Before the slot is overwritten: the cell leaving the frontier is the one
  // the history takes on, and an unplayable one goes in as light — nothing a
  // pattern can read, since a pattern instance touching a gap was dropped.
  if (plan.histBits > 0) {
    const bool leavingDark =
        site.leaving != kNoClass && colorOf(in, site.leaving) == kDark;
    work.hist = ((in.hist << 1U) | (leavingDark ? 1U : 0U)) & plan.histMask;
  }
  if (!countDarts(plan, work, site, color))
    return false;

  if (color == kUnplayable) {
    work.cls[slot(x)] = kNoClass;
  } else {
    const auto [legal, absorbed] = paint(plan, work, site, color);
    if (!legal)
      return false;
    merged = absorbed;
  }

  // Short-circuit order is the whole point: `closeClass` mutates, and it may
  // only run for a class that really left. A merged one did not.
  if (site.leaving != kNoClass && !merged &&
      !stillOnFrontier(work, width, site.leaving) &&
      !closeClass(plan, work, site))
    return false;

  out = canonicalise(work, width);
  return true;
}

/// Whether a frontier that has consumed the whole board is a solution. Every
/// class left open closes at once here, which is the last chance to catch a
/// letter spread across two regions.
bool accepts(const Plan &plan, const Frontier &f) {
  std::array<bool, kLetterCount> seen{};
  int darkOpen = 0;
  int lightOpen = 0;
  for (uint8_t cls = 0; cls < f.classes; cls++) {
    if (colorOf(f, cls) == kDark)
      darkOpen++;
    else
      lightOpen++;
    const uint8_t letter = f.tag[slot(cls)];
    if (letter == kNoTag)
      continue;
    if (seen[slot(letter)])
      return false;
    seen[slot(letter)] = true;
  }
  if (plan.connectDark && darkOpen + (hasClosed(f, kDark) ? 1 : 0) > 1)
    return false;
  if (plan.connectLight && lightOpen + (hasClosed(f, kLight) ? 1 : 0) > 1)
    return false;
  return true;
}

/// The colours this cell may take: a given allows only itself, a gap only the
/// gap, anything else both.
struct Options {
  std::array<uint8_t, 2> colors{};
  int count = 0;
};

Options optionsAt(const Model &model, const Plan &plan, const int pos) {
  const int width = plan.scan.width;
  if (const uint8_t given =
          model.puzzle.givens[slot(plan.scan.cellAt(pos % width, pos / width))];
      given != kUnknown)
    return {.colors = {given, kUnknown}, .count = 1};
  return {.colors = {kDark, kLight}, .count = 2};
}

/// Where the sweep is in scan order, and what that cell may hold.
struct Cursor {
  int x = 0;
  int y = 0;
  Options options;
};

Cursor cursorAt(const Model &model, const Plan &plan, const int pos) {
  const int width = plan.scan.width;
  return {.x = pos % width,
          .y = pos / width,
          .options = optionsAt(model, plan, pos)};
}

/// One cell's worth of the witness sweep: the layer coming in, the one being
/// built, its de-duplicating index, and the trail written alongside.
struct Layer {
  const std::vector<Frontier> &prev;
  std::vector<Frontier> &next;
  SlotIndex &index;
  std::vector<uint32_t> &parent;
  std::vector<uint8_t> &chose;
};

/**
 * Everything the underclued sweep builds and then reads back out.
 *
 * Unlike the witness sweep this one KEEPS every layer's frontiers, because the
 * backward pass has to ask each of them what it can still reach. That is the
 * whole cost of the mode, and it is why its cap is far tighter.
 */
struct Forced {
  std::vector<std::vector<Frontier>> layers;
  /// Where each (state, colour) transition lands, or -1. Two entries a state.
  std::vector<std::vector<int32_t>> links;
  /// Which states can still reach an accepting end.
  std::vector<std::vector<uint8_t>> alive;
};

/// One cell's worth of the forced sweep's forward pass.
struct LinkLayer {
  const std::vector<Frontier> &from;
  std::vector<Frontier> &into;
  SlotIndex &index;
  std::vector<int32_t> &link;
};

/// Crosses one frontier with the colours on offer, recording where each
/// transition lands so the backward pass can follow them.
void linkOne(const Plan &plan, const Cursor &cursor, const LinkLayer &layer,
             const uint32_t from) {
  for (int k = 0; k < cursor.options.count; k++) {
    Frontier produced;
    if (!step(plan, layer.from[static_cast<size_t>(from)], cursor.x, cursor.y,
              cursor.options.colors[slot(k)], produced))
      continue;
    layer.into.push_back(produced);
    const auto at = static_cast<uint32_t>(layer.into.size() - 1);
    const uint32_t lives = layer.index.insertOrFind(layer.into, at);
    if (lives != at)
      layer.into.pop_back();
    layer.link[static_cast<size_t>(from) * 2 + slot(k)] =
        static_cast<int32_t>(lives);
  }
}

/// Forward: every layer, de-duplicated, with the transition table beside it.
/// False when the sweep stopped early — `outcome` then already says why.
bool sweepForward(const Model &model, const Plan &plan, Budget &budget,
                  const size_t cap, Forced &forced, Outcome &outcome) {
  const int width = plan.scan.width;
  const int cells = width * plan.scan.height;
  SlotIndex index;
  size_t held = 1;
  for (int pos = 0; pos < cells; pos++) {
    if (budget.exhaustedNow())
      return false;
    const Cursor cursor = cursorAt(model, plan, pos);
    const std::vector<Frontier> &from = forced.layers[slot(pos)];
    std::vector<Frontier> &into = forced.layers[slot(pos + 1)];
    std::vector<int32_t> &link = forced.links[slot(pos)];
    link.assign(from.size() * 2, -1);
    index.reset(from.size() + from.size() / 2,
                FrontierHash{.width = width,
                             .darts = static_cast<int>(plan.darts.size())});

    const LinkLayer layer{
        .from = from, .into = into, .index = index, .link = link};
    for (uint32_t i = 0; i < from.size(); i++) {
      linkOne(plan, cursor, layer, i);
      outcome.stats.nodesExpanded++;
    }
    held += into.size();
    if (held > cap) {
      outcome.stats.stoppedOnMemory = true;
      return false;
    }
    if (into.empty()) {
      outcome.status = Status::Unsolvable;
      return false;
    }
  }
  return true;
}

/// Whether any transition out of this state reaches a state that can still
/// finish.
bool reachesAlive(const Forced &forced, const int pos, const size_t from,
                  const int options) {
  const std::vector<int32_t> &link = forced.links[slot(pos)];
  for (int k = 0; k < options; k++) {
    if (const int32_t to = link[from * 2 + slot(k)];
        to >= 0 && forced.alive[slot(pos + 1)][static_cast<size_t>(to)] != 0)
      return true;
  }
  return false;
}

/// Backward: which states can still reach an accepting end. A state that
/// cannot is forward-reachable but dead, and counting its choices would report
/// colours no solution actually uses.
void markAlive(const Plan &plan, const int cells, Forced &forced) {
  for (int pos = 0; pos <= cells; pos++)
    forced.alive[slot(pos)].assign(forced.layers[slot(pos)].size(), 0);
  const std::vector<Frontier> &last = forced.layers[slot(cells)];
  for (size_t i = 0; i < last.size(); i++)
    forced.alive[slot(cells)][i] = accepts(plan, last[i]) ? 1 : 0;
  for (int pos = cells - 1; pos >= 0; pos--) {
    const size_t states = forced.layers[slot(pos)].size();
    for (size_t i = 0; i < states; i++)
      forced.alive[slot(pos)][i] = reachesAlive(forced, pos, i, 2) ? 1 : 0;
  }
}

/// Which colours a live path may take out of one state.
struct Taken {
  bool dark = false;
  bool light = false;
};

Taken takenFrom(const Forced &forced, const int pos, const size_t from,
                const Options &options) {
  Taken taken;
  const std::vector<int32_t> &link = forced.links[slot(pos)];
  for (int k = 0; k < options.count; k++) {
    if (const int32_t to = link[from * 2 + slot(k)];
        to < 0 || forced.alive[slot(pos + 1)][static_cast<size_t>(to)] == 0)
      continue;
    taken.dark = taken.dark || options.colors[slot(k)] == kDark;
    taken.light = taken.light || options.colors[slot(k)] == kLight;
  }
  return taken;
}

/// A cell is forced when every surviving path paints it the same way. Both
/// halves matter: the state has to be reachable from the start AND able to
/// finish, or the colour it offers belongs to no solution.
int readForced(const Model &model, const Plan &plan, const Forced &forced,
               const int cells, Colors &colors) {
  const int width = plan.scan.width;
  int decided = 0;
  for (int pos = 0; pos < cells; pos++) {
    const int cell = plan.scan.cellAt(pos % width, pos / width);
    if (!model.playable.test(cell))
      continue;
    const Options options = optionsAt(model, plan, pos);
    const std::vector<uint8_t> &here = forced.alive[slot(pos)];
    Taken taken;
    for (size_t i = 0; i < here.size(); i++) {
      const auto [dark, light] =
          here[i] == 0 ? Taken{} : takenFrom(forced, pos, i, options);
      taken.dark = taken.dark || dark;
      taken.light = taken.light || light;
    }
    if (taken.dark == taken.light) {
      colors[slot(cell)] = kUnknown;
      continue;
    }
    colors[slot(cell)] = taken.dark ? kDark : kLight;
    decided++;
  }
  return decided;
}

/// The colour this state should take, preferring the `wanted`-th option so
/// successive witnesses differ where the board allows it. -1 at a dead end.
int preferredStep(const Forced &forced, const int pos, const uint32_t from,
                  const Options &options, const int wanted) {
  const std::vector<int32_t> &link = forced.links[slot(pos)];
  for (int offset = 0; offset < options.count; offset++) {
    const int k = (offset + wanted) % options.count;
    if (const int32_t to = link[static_cast<size_t>(from) * 2 + slot(k)];
        to >= 0 && forced.alive[slot(pos + 1)][static_cast<size_t>(to)] != 0)
      return k;
  }
  return -1;
}

/// One example solution, walked straight down the live states.
Colors walkWitness(const Model &model, const Plan &plan, const Forced &forced,
                   const int cells, const int wanted) {
  const int width = plan.scan.width;
  Colors witness{};
  witness.fill(kUnplayable);
  uint32_t at = 0;
  for (int pos = 0; pos < cells; pos++) {
    const Options options = optionsAt(model, plan, pos);
    const int taken = preferredStep(forced, pos, at, options, wanted);
    if (taken < 0)
      break;
    witness[slot(plan.scan.cellAt(pos % width, pos / width))] =
        options.colors[slot(taken)];
    at = static_cast<uint32_t>(
        forced.links[slot(pos)][static_cast<size_t>(at) * 2 + slot(taken)]);
  }
  return witness;
}

/// Example solutions for the page to check the claim against. Alternating
/// which colour is preferred is what makes them DIFFERENT from each other
/// where the board allows it. False when the oracle refused one, which is a
/// bug in a propagator rather than a puzzle.
bool addWitnesses(const Model &model, const Plan &plan, const Forced &forced,
                  const int cells, Outcome &outcome, const int limit) {
  for (int wanted = 0; wanted < limit; wanted++) {
    const Colors witness = walkWitness(model, plan, forced, cells, wanted);
    if (verify::check(model, witness) != verify::Violation::None) {
      outcome.stats.oracleRejections++;
      return false;
    }
    if (std::ranges::find(outcome.witnesses, witness) ==
        outcome.witnesses.end())
      outcome.witnesses.push_back(witness);
  }
  return true;
}

/// Crosses one frontier with the colours on offer, appending whatever is new
/// and recording where each survivor came from.
void expandOne(const Plan &plan, const Cursor &cursor, const Layer &layer,
               const uint32_t from) {
  for (int k = 0; k < cursor.options.count; k++) {
    const uint8_t color = cursor.options.colors[slot(k)];
    Frontier produced;
    if (!step(plan, layer.prev[static_cast<size_t>(from)], cursor.x, cursor.y,
              color, produced))
      continue;
    // Appended first so the index has something to hash; taken straight back
    // off when the frontier turns out to be one already seen.
    layer.next.push_back(produced);
    if (const auto at = static_cast<uint32_t>(layer.next.size() - 1);
        !layer.index.insert(layer.next, at)) {
      layer.next.pop_back();
      continue;
    }
    layer.parent.push_back(from);
    layer.chose.push_back(color);
  }
}

} // namespace

/**
 * Whether this sweep can express the board at all.
 *
 * A WHITELIST on both axes, and that is the whole point of it. Declining is a
 * correctness requirement rather than a tidiness one: `runProfileForced` sets
 * `proven` with no oracle gate on its forced set, so a sweep blind to some part
 * of the puzzle enumerates a SUPERSET of the solutions and then claims the
 * cells they disagree about were proved to go either way. A denylist gets that
 * right for everything written the day it was written and wrong for the next
 * clue kind or rule appended, silently — which is exactly what it did when
 * darts arrived, since a dart-only board named no area clue and no listed rule.
 * Listed the other way round, anything new declines by default and costs at
 * worst a re-measurement.
 *
 * What it can express: letter clues, dart clues on a square the puzzle paints,
 * the two connect rules, `Underclued` — which is not a colouring rule at all —
 * and every rule whose WHOLE content is a forbidden local arrangement, since
 * those compile to `patternsFor` and the frontier now carries enough recent
 * colour to read one. The families deliberately left out are the ones a
 * pattern table cannot say all of: an area or a run instance (`patternsFor`
 * itself records that its trominoes are only half of what an area means), the
 * one-symbol rules, the region-shape rules, and `OffByOne`, which changes what
 * every count means rather than what any arrangement is.
 */
bool applicable(const Model &model) {
  // A merged cell spans several squares, and the frontier carries one class
  // slot per COLUMN joined only leftwards and upwards, over a `y * width + x`
  // sweep. Nothing in it can say "this square takes the colour a square two
  // rows back already took", and carrying that would mean a per-column cell
  // identity plus a colour commitment for cells still open — a different
  // design, not a bigger constant.
  if (model.hasShapes)
    return false;
  // The sized rule instances live OUTSIDE the mask, so the whitelist loop
  // below cannot see them — they are declined here explicitly. Each would
  // need per-class state the frontier does not carry: an area instance every
  // open class's size, a run instance a running length along rows the sweep
  // crosses as well as the one it follows.
  if (!model.puzzle.areas.empty() || !model.puzzle.runs.empty())
    return false;
  // An area clue would need each open class's SIZE in the state. A dart needs
  // only a running count, but the colour it counts is the opposite of its OWN
  // square's, so a dart the board leaves unpainted would need that square's
  // colour carried too, long after it has left the frontier.
  if (std::ranges::any_of(model.puzzle.clues, [&model](const Clue &clue) {
        if (clue.kind == kClueLetter)
          return false;
        if (clue.kind != kClueDart || !isDirection(clue.direction))
          return true;
        const uint8_t own = model.puzzle.givens[slot(clue.index)];
        return own != kDark && own != kLight;
      }))
    return false;
  using enum Rule;
  // Every rule here is a containment rule and nothing else: "this arrangement
  // never occurs". `patternsFor` is then the whole of what the board forbids,
  // which is what makes reading it off recent colour sound.
  constexpr auto kSupported = std::to_array<Rule>(
      {ConnectDark, ConnectLight, Underclued, NoDark2x2, NoLight2x2,
       NoCheckerboard, NoDarkLightDark, NoLightDarkLight, NoDarkT, NoLightT,
       NoThreeDarkOneLight, NoThreeLightOneDark, NoDarkDiagonal,
       NoLightDiagonal, NoDarkElbow, NoLightElbow, NoDarkEll, NoLightEll,
       NoDarkAnyDark, NoLightAnyLight, NoLightCrossedDarkT,
       NoDarkCrossedLightT, NoDarkLongT, NoLightLongT, NoDarkKnight,
       NoLightKnight, NoDarkLightDarkElbow, NoLightDarkLightElbow});
  for (int index = 0; index < rules::kRuleCount; index++) {
    if (const auto rule = static_cast<Rule>(index);
        model.hasRule(rule) && !std::ranges::contains(kSupported, rule))
      return false;
  }
  if (scanOf(model).width > kMaxProfileWidth)
    return false;
  // Last, because it is the only part that costs anything: whether the
  // arrangements this board forbids reach further back than the state carries,
  // and whether its darts want more counter states than it will hold.
  return planOf(model).usable;
}

Outcome runProfile(const Model &model, const Config &cfg) {
  Outcome outcome;
  outcome.arm = "profile";
  if (!applicable(model))
    return outcome;

  Budget budget(cfg, "profile", outcome.stats);
  const Plan plan = planOf(model);
  const int width = plan.scan.width;
  const int height = plan.scan.height;
  const int cells = width * height;
  // Five bytes a state is what the trail costs; the working frontiers are two
  // layers on top of that. Sizing the cap off the trail keeps the arithmetic
  // honest without pretending to know the peak layer in advance.
  const size_t cap = cfg.maxHeapBytes > 0
                         ? std::max<size_t>(1, cfg.maxHeapBytes / 5)
                         : kDefaultStateCap;

  std::vector<Trail> trail(slot(cells + 1));

  Frontier start;
  start.cls.fill(kNoClass);
  start.tag.fill(kNoTag);
  std::vector prev{start};
  std::vector<Frontier> next;
  SlotIndex index;

  size_t held = 1;
  for (int pos = 0; pos < cells; pos++) {
    // `exhaustedNow`, not `exhausted`: the sampled form only looks at the clock
    // every few thousand calls, and this loop runs once per CELL — 225 times on
    // the largest board — so it would sample the deadline approximately never
    // and the sweep would ignore its budget entirely. One iteration here is a
    // whole layer, which is exactly the "coarse enough to deserve a real check"
    // case the unsampled form is for.
    if (budget.exhaustedNow())
      return outcome;
    const Cursor cursor = cursorAt(model, plan, pos);

    next.clear();
    // Layers grow smoothly, so the previous one is a good guess for this one.
    // Without it a layer of millions rehashes its way up from nothing, which
    // measured as a third of the sweep's time on the widest board.
    index.reset(prev.size() + prev.size() / 2,
                FrontierHash{.width = width,
                             .darts = static_cast<int>(plan.darts.size())});
    next.reserve(prev.size() + prev.size() / 2);
    auto &[parent, chose] = trail[slot(pos + 1)];
    parent.reserve(prev.size());
    chose.reserve(prev.size());
    const Layer layer{.prev = prev,
                      .next = next,
                      .index = index,
                      .parent = parent,
                      .chose = chose};
    for (uint32_t i = 0; i < prev.size(); i++) {
      expandOne(plan, cursor, layer, i);
      outcome.stats.nodesExpanded++;
    }

    held += next.size();
    if (held > cap) {
      // Out of room, and that proves NOTHING — say so rather than letting an
      // empty answer read as "no solution".
      outcome.stats.stoppedOnMemory = true;
      return outcome;
    }
    if (next.empty()) {
      outcome.status = Status::Unsolvable;
      return outcome;
    }
    prev.swap(next);
    budget.note(0, 0);
  }

  // Pick an accepting frontier and walk the choices back out. Only the trail is
  // needed for that, which is why the frontiers could be dropped as they went.
  auto at = static_cast<uint32_t>(prev.size());
  for (uint32_t i = 0; i < prev.size(); i++) {
    if (accepts(plan, prev[static_cast<size_t>(i)])) {
      at = i;
      break;
    }
  }
  if (at == prev.size()) {
    outcome.status = Status::Unsolvable;
    return outcome;
  }

  Colors colors{};
  colors.fill(kUnplayable);
  for (int pos = cells - 1; pos >= 0; pos--) {
    const auto &[parent, chose] = trail[slot(pos + 1)];
    colors[slot(plan.scan.cellAt(pos % width, pos / width))] =
        chose[static_cast<size_t>(at)];
    at = parent[static_cast<size_t>(at)];
  }

  // The sweep re-derives the rules, so it is checked against the oracle exactly
  // like every other arm rather than trusted.
  if (verify::check(model, colors) != verify::Violation::None) {
    outcome.stats.oracleRejections++;
    return outcome;
  }

  outcome.status = Status::Solved;
  outcome.colors = colors;
  outcome.decided = model.playableCount;
  outcome.witnesses.push_back(colors);
  return outcome;
}

Outcome runProfileForced(const Model &model, const Config &cfg) {
  Outcome outcome;
  outcome.arm = "profile";
  if (!applicable(model))
    return outcome;

  Budget budget(cfg, "profile", outcome.stats);
  const Plan plan = planOf(model);
  const int cells = plan.scan.width * plan.scan.height;
  const size_t cap = cfg.maxHeapBytes > 0
                         ? std::max<size_t>(1, cfg.maxHeapBytes / kForcedBytes)
                         : kDefaultForcedCap;

  Forced forced;
  forced.layers.resize(slot(cells + 1));
  forced.links.resize(slot(cells));
  forced.alive.resize(slot(cells + 1));

  Frontier start;
  start.cls.fill(kNoClass);
  start.tag.fill(kNoTag);
  forced.layers[0].push_back(start);

  if (!sweepForward(model, plan, budget, cap, forced, outcome))
    return outcome;

  markAlive(plan, cells, forced);
  if (forced.alive[0][0] == 0) {
    outcome.status = Status::Unsolvable;
    return outcome;
  }

  Colors colors{};
  colors.fill(kUnplayable);
  const int decided = readForced(model, plan, forced, cells, colors);

  if (!addWitnesses(model, plan, forced, cells, outcome, cfg.witnessLimit))
    return outcome;

  outcome.status = Status::Deduced;
  outcome.colors = colors;
  outcome.decided = decided;
  // The sweep enumerated the whole space, so every cell it left blank was
  // PROVED to take either colour rather than merely not settled.
  outcome.proven = true;
  return outcome;
}

} // namespace lg::profile
