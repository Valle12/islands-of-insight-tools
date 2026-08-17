#include "Packing.h"

#include "Bitboard.h"
#include "Budget.h"
#include "Rules.h"
#include "Verify.h"

#include <algorithm>
#include <array>
#include <cstdint>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace lg::packing {
namespace {

using rules::Rule;

/// A demand that no letter pins, which is every demand an area number raises.
constexpr uint8_t kNoLetter = 0xFF;

/**
 * One region the packing has to build: the cells it must contain and how many
 * cells it has altogether.
 *
 * An area number raises a demand for the single cell it sits on. A letter
 * raises one for ALL the cells carrying it, since the puzzle says they share a
 * region — and a letter demand carries the letter, because two of them may
 * never turn out to be the same region while two area numbers of one value
 * happily may.
 *
 * `id` is its position in the list the board was read into, and it is what
 * tells a demand from the others: the working lists are COPIES in a different
 * order, so comparing addresses would say every demand differs from itself and
 * no letter would ever find a shape.
 */
struct Demand {
  Bits required;
  /// The lowest required cell: where shape enumeration and the lookahead start.
  int cell = 0;
  int size = 0;
  int id = 0;
  uint8_t letter = kNoLetter;
};

/// What the board asks of the regions BESIDE their sizes.
enum class ShapeRule : uint8_t { None, Distinct, Same };

/// The board as the packer reads it, once.
struct Terms {
  /// Every square a region may claim: playable, minus what the puzzle paints
  /// the other colour.
  Bits room;
  /// Every square painted the clue colour. Each has to end up in some region,
  /// since a claimed cell is the only cell that colour ever reaches.
  Bits mustCover;
  uint8_t color = kDark;
  ShapeRule shapes = ShapeRule::None;
  /// Whether the clue colour, and the other one, have to come out as one
  /// region each.
  bool connectClue = false;
  bool connectRest = false;
};

struct BitsHash {
  std::size_t operator()(const Bits &bits) const {
    uint64_t hash = 0xcbf2'9ce4'8422'2325ULL;
    for (const uint64_t word : bits.words) {
      hash ^= word;
      hash *= 0x0000'0100'0000'01b3ULL;
      // The bucket index is the LOW bits, so the mix has to reach them.
      hash ^= hash >> 29;
    }
    return static_cast<std::size_t>(hash);
  }
};

using BitsSet = std::unordered_set<Bits, BitsHash>;

std::vector<int> cellsOf(const Bits &bits) {
  std::vector<int> out;
  for (int i = bits.nextSet(0); i >= 0; i = bits.nextSet(i + 1))
    out.push_back(i);
  return out;
}

/// Whether a set is all one region. Empty passes: a colour with no cells at
/// all has no two regions to keep together.
bool oneComponent(const Bits &set) {
  const int first = set.nextSet(0);
  return first < 0 || component(first, set).count() == set.count();
}

/**
 * Whether a shape holding one of `other`'s cells could still be `demand`'s.
 *
 * A region containing ONE cell of a demand IS that demand's region, so it has
 * to contain the rest of it and be the right size. Two letters can never share
 * one region whatever the sizes say — that is the whole of what a letter means
 * — while two area numbers of one value happily may, and the captured 11x11
 * has no packing at all unless its two 3-clues do.
 */
bool mayAbsorb(const Demand &demand, const Bits &shape, const Demand &other) {
  if (other.id == demand.id || !shape.intersects(other.required))
    return true;
  if (demand.letter != kNoLetter && other.letter != kNoLetter)
    return false;
  return other.required.isSubsetOf(shape) && other.size == demand.size;
}

/// How many demands a shape would settle at once.
int satisfiedBy(const Bits &shape, const std::vector<Demand> &demands) {
  return static_cast<int>(
      std::ranges::count_if(demands, [&shape](const Demand &demand) {
        return shape.intersects(demand.required);
      }));
}

/**
 * Every connected `size`-cell set of `room` reachable from the demand's
 * anchor, or nothing when there are more of them than are worth listing.
 *
 * Three ways to give up, and the PENDING one is not redundant. The other two
 * bound what this keeps; the stack is what it has queued, and every state
 * expanded pushes one successor per border cell — so on a big open board the
 * stack outgrows both caps long before either trips, by hundreds of megabytes
 * of `Bits`. The budget is the same argument about time: this runs inside
 * `prepare`, before the packing search that would otherwise be the only thing
 * watching the clock. Declining early costs a construction nothing.
 */
BitsSet growAll(const Bits &room, const Demand &demand, Budget &budget) {
  Bits seedBits;
  seedBits.set(demand.cell);
  BitsSet found;
  BitsSet seen;
  std::vector<Bits> stack{seedBits};
  while (!stack.empty()) {
    if (budget.exhausted() ||
        stack.size() > static_cast<std::size_t>(kMaxPendingShapes))
      return {};
    const Bits current = stack.back();
    stack.pop_back();
    if (current.count() == demand.size) {
      found.insert(current);
      if (found.size() > static_cast<std::size_t>(kMaxShapesPerClue))
        return {};
      continue;
    }
    if (!seen.insert(current).second)
      continue;
    if (seen.size() > static_cast<std::size_t>(kMaxShapesPerClue))
      return {};
    for (const int cell : cellsOf(current.border() & room)) {
      Bits bigger = current;
      bigger.set(cell);
      stack.push_back(bigger);
    }
  }
  return found;
}

/**
 * The shapes this demand may take, best first.
 *
 * Compact first, and sets satisfying more demands before that. Both orderings
 * say the same thing — leave the big regions as much room as possible — and on
 * the captured 11x11 the difference is between well under a second and a
 * minute.
 */
std::vector<Bits> shapesFor(const Bits &room, const Demand &demand,
                            const std::vector<Demand> &demands,
                            Budget &budget) {
  std::vector<Bits> shapes;
  for (const Bits &shape : growAll(room, demand, budget)) {
    if (!demand.required.isSubsetOf(shape))
      continue;
    if (std::ranges::all_of(demands, [&demand, &shape](const Demand &other) {
          return mayAbsorb(demand, shape, other);
        }))
      shapes.push_back(shape);
  }

  std::ranges::sort(shapes, [&demands](const Bits &left, const Bits &right) {
    if (const int clues = satisfiedBy(left, demands) - satisfiedBy(right, demands);
        clues != 0)
      return clues > 0;
    if (const int edges = left.border().count() - right.border().count();
        edges != 0)
      return edges < 0;
    // Any total order will do — this one only has to be deterministic, so the
    // same board packs the same way on every run and `bench:lg` can diff it.
    return left.words < right.words;
  });
  return shapes;
}

/// One region grown from `anchor` out of `room`, exactly `size` cells. Only
/// ever called where `room`'s component around the anchor is big enough, and
/// connectivity then makes the growth always possible.
Bits carve(const int anchor, const int size, const Bits &room) {
  Bits region;
  region.set(anchor);
  while (region.count() < size) {
    const Bits fringe = region.border() & room;
    const int next = fringe.nextSet(0);
    if (next < 0)
      return region;
    region.set(next);
  }
  return region;
}

class Packer {
public:
  Packer(const Model &model, const Terms &terms, Budget &budget)
      : model_(model), terms_(terms), budget_(budget) {}

  /// The demand lists, and whether the board is worth trying at all.
  bool prepare(const std::vector<Demand> &demands) {
    if (!split(demands))
      return false;
    options_.reserve(small_.size());
    // An empty shape list means the demand cannot be placed at all, or that it
    // has more shapes than are worth listing. Either way the board is declined,
    // which a construction is always free to do.
    if (!std::ranges::all_of(small_, [this, &demands](const Demand &demand) {
          options_.push_back(
              shapesFor(terms_.room, demand, demands, budget_));
          return !options_.back().empty();
        })) {
      // Told apart the way every arm here tells them apart: an enumeration cut
      // short by the clock has shown nothing at all, while a list this board
      // simply cannot fill is a real decline.
      stopped_ = budget_.expired();
      return false;
    }
    if (big_.empty())
      orderByChoice();
    noteEconomical(demands);
    return true;
  }

  /**
   * The claimed cells of a full packing, or nothing.
   *
   * The ECONOMICAL reading first: every demand takes a shape satisfying as many
   * as it possibly can, so same-valued neighbours share one region rather than
   * taking one each. Fewer regions means less halo and so more room, which is
   * exactly what the big clues are short of — and on the captured 11x11 the
   * shared reading is the only one that packs at all. The general pass follows
   * and gives nothing up; it is just far more expensive, because proving that a
   * pair of demands CANNOT each have its own region means exhausting that whole
   * subtree. Measured there: about half a second against fifteen.
   */
  bool run(Bits &claimed) {
    if (placeSmall(0, Bits{}, Bits{}, claimed, true))
      return true;
    if (stopped_)
      return false;
    keys_.clear();
    return placeSmall(0, Bits{}, Bits{}, claimed, false);
  }

  [[nodiscard]] bool stopped() const { return stopped_; }

private:
  /// Splits the demands into the ones worth enumerating whole and the ones the
  /// lookahead grows, and refuses what neither half can carry.
  bool split(const std::vector<Demand> &demands) {
    for (const Demand &demand : demands) {
      if (demand.size <= kMaxShapeCells)
        small_.push_back(demand);
      else
        big_.push_back(demand);
    }
    // The lookahead grows one cell at a time from one anchor and keeps no shape
    // key, so it can carry neither a demand of several cells nor a shape rule.
    // Both are declined rather than approximated.
    if (!big_.empty() && terms_.shapes != ShapeRule::None)
      return false;
    if (std::ranges::any_of(big_, [](const Demand &demand) {
          return demand.required.count() > 1;
        }))
      return false;
    // Big first among themselves, so the lookahead grows the region that boxes
    // the others in soonest rather than the one with most room.
    std::ranges::sort(big_, [](const Demand &left, const Demand &right) {
      return left.size > right.size;
    });
    if (!big_.empty())
      orderByCrowding();
    return true;
  }

  /// Small demands NEAREST a big one first. The lookahead can only prune once
  /// the free space around a big demand has actually been cut, so committing
  /// the regions that crowd it first is what lets a bad prefix die at depth two
  /// instead of at the bottom. Measured on the captured 11x11: minutes in clue
  /// order, well under a second in this one.
  void orderByCrowding() {
    std::ranges::sort(small_, [this](const Demand &left, const Demand &right) {
      if (const int gap = nearestBig(left.cell) - nearestBig(right.cell);
          gap != 0)
        return gap < 0;
      return left.cell < right.cell;
    });
  }

  /**
   * With no big demand to crowd, FEWEST CHOICES first.
   *
   * There is nothing to leave room for then, so the ordering that pays is the
   * ordinary one: settle the demand with least freedom while the board is still
   * open and let it cut the ones that follow. On the 12x12 pentomino board the
   * letter pairs four cells apart have six shapes each and the loosest area
   * number has two hundred and twenty-two; leading with the six is the
   * difference between two hundred thousand nodes and not finishing.
   */
  void orderByChoice() {
    std::vector<std::size_t> order(small_.size());
    for (std::size_t i = 0; i < order.size(); i++)
      order[i] = i;
    std::ranges::sort(order, [this](const std::size_t left,
                                    const std::size_t right) {
      if (options_[left].size() != options_[right].size())
        return options_[left].size() < options_[right].size();
      return small_[left].cell < small_[right].cell;
    });
    std::vector<Demand> demands;
    std::vector<std::vector<Bits>> options;
    demands.reserve(order.size());
    options.reserve(order.size());
    for (const std::size_t at : order) {
      demands.push_back(small_[at]);
      options.push_back(std::move(options_[at]));
    }
    small_ = std::move(demands);
    options_ = std::move(options);
  }

  /// How many of each list's shapes satisfy as many demands as that one ever
  /// can. They sort first, so it is a prefix — see `run` for what it buys.
  void noteEconomical(const std::vector<Demand> &demands) {
    for (const std::vector<Bits> &shapes : options_) {
      const int best = satisfiedBy(shapes.front(), demands);
      std::size_t prefix = 0;
      while (prefix < shapes.size() &&
             satisfiedBy(shapes[prefix], demands) == best)
        prefix++;
      economical_.push_back(prefix);
    }
  }

  /// Whether every demand in `rest` still has a component of its own size, and
  /// demands sharing one component have room for all of them.
  [[nodiscard]] static bool roomLeft(const Bits &free,
                                     const std::vector<Demand> &rest) {
    // One flood per demand, kept — this runs at every node of the lookahead,
    // and flooding again for the demand pass doubled the arm's whole cost.
    std::vector<Bits> comps;
    comps.reserve(rest.size());
    for (const Demand &demand : rest) {
      if (!free.test(demand.cell))
        return false;
      comps.push_back(component(demand.cell, free));
      if (comps.back().count() < demand.size)
        return false;
    }
    for (const Bits &comp : comps) {
      int demanded = 0;
      for (std::size_t j = 0; j < rest.size(); j++) {
        if (comp.test(rest[j].cell) && !sharedWithEarlier(comp, rest, j))
          demanded += rest[j].size;
      }
      if (comp.count() < demanded)
        return false;
    }
    return true;
  }

  /// Whether an EARLIER demand of this component could share `j`'s region.
  ///
  /// Two demands of one size that are close enough may share a region, so
  /// counting a region for each would refuse boards that come out. Being within
  /// reach does not make sharing possible, only conceivable, which is the right
  /// way round for a prune.
  [[nodiscard]] static bool sharedWithEarlier(const Bits &comp,
                                              const std::vector<Demand> &rest,
                                              const std::size_t j) {
    for (std::size_t k = 0; k < j; k++) {
      if (comp.test(rest[k].cell) && rest[k].size == rest[j].size &&
          distance(rest[k].cell, rest[j].cell) <= rest[j].size - 1)
        return true;
    }
    return false;
  }

  /// How far this cell is from the nearest demand the lookahead grows.
  [[nodiscard]] int nearestBig(const int cell) const {
    int best = kMaxCells;
    for (const Demand &demand : big_)
      best = std::min(best, distance(cell, demand.cell));
    return best;
  }

  static int distance(const int left, const int right) {
    const int leftX = left % kStride;
    const int leftY = left / kStride;
    const int rightX = right % kStride;
    const int rightY = right / kStride;
    return (leftX > rightX ? leftX - rightX : rightX - leftX) +
           (leftY > rightY ? leftY - rightY : rightY - leftY);
  }

  /// The big demands alone, packed into `free`. Sound as a prune on a PARTIAL
  /// placement: free space only shrinks as more regions land, so a set of big
  /// demands that does not fit now will not fit later either.
  bool bigsFit(const Bits &free, const std::vector<Demand> &rest,
               Bits *claimed) {
    if (rest.empty())
      return true;
    if (!roomLeft(free, rest))
      return false;
    if (rest.size() == 1) {
      // One region left is decided by counting, not by searching: its component
      // is connected, so a connected subset of exactly that size containing the
      // demand can always be grown out of it, and `roomLeft` just counted it.
      if (claimed != nullptr)
        *claimed |= carve(rest[0].cell, rest[0].size, free);
      return true;
    }

    const Demand head = rest[0];
    BitsSet seen;
    Bits seedBits;
    seedBits.set(head.cell);
    std::vector<Bits> stack{seedBits};
    while (!stack.empty()) {
      if (budget_.exhausted()) {
        stopped_ = true;
        return false;
      }
      const Bits region = stack.back();
      stack.pop_back();
      if (!seen.insert(region).second)
        continue;
      std::vector<Demand> left;
      if (!settlesLegally(region, rest, left))
        continue;
      const Bits room = free.without(region).without(region.border());
      if (!roomLeft(room, left))
        continue;
      if (region.count() != head.size) {
        pushGrown(stack, region, free);
        continue;
      }
      if (!bigsFit(room, left, claimed))
        continue;
      if (claimed != nullptr)
        *claimed |= region;
      return true;
    }
    return false;
  }

  /// The demands `region` leaves for the others, into `left` — or false when it
  /// swallows one asking for a different size, which no single region can serve.
  [[nodiscard]] static bool settlesLegally(const Bits &region,
                                           const std::vector<Demand> &rest,
                                           std::vector<Demand> &left) {
    for (std::size_t j = 1; j < rest.size(); j++) {
      if (!region.test(rest[j].cell))
        left.push_back(rest[j]);
      else if (rest[j].size != rest[0].size)
        return false;
    }
    return true;
  }

  /// Every one-cell growth of `region` that stays inside `free`.
  static void pushGrown(std::vector<Bits> &stack, const Bits &region,
                        const Bits &free) {
    for (const int cell : cellsOf(region.border() & free)) {
      Bits bigger = region;
      bigger.set(cell);
      stack.push_back(bigger);
    }
  }

  /// Cached because the same free space is reached by many orders of the same
  /// small regions, and proving the big demands do not fit is the expensive
  /// half.
  bool bigsFitCached(const Bits &free) {
    if (const auto found = cache_.find(free); found != cache_.end())
      return found->second;
    const bool fits = bigsFit(free, big_, nullptr);
    if (stopped_)
      return false;
    cache_.try_emplace(free, fits);
    return fits;
  }

  /// Whether a shape may join the ones already placed under the board's shape
  /// rule. `keys_` holds one canonical shape per region placed so far.
  [[nodiscard]] bool shapeAllowed(const Bits &shape) const {
    if (terms_.shapes == ShapeRule::None || keys_.empty())
      return true;
    const Bits key = canonicalShape(shape);
    const bool seen = std::ranges::find(keys_, key) != keys_.end();
    return terms_.shapes == ShapeRule::Distinct ? !seen : key == keys_.front();
  }

  /// What a finished packing still has to satisfy: everything the board paints
  /// in the clue colour claimed, and each connect rule met. Neither can be read
  /// off a partial placement, so both land here.
  [[nodiscard]] bool finished(const Bits &regions) const {
    if (!terms_.mustCover.isSubsetOf(regions))
      return false;
    if (terms_.connectClue && !oneComponent(regions))
      return false;
    return !terms_.connectRest || oneComponent(model_.playable.without(regions));
  }

  bool placeSmall(const std::size_t index, const Bits &used,
                  const Bits &blocked, Bits &claimed, const bool economical) {
    if (budget_.exhausted()) {
      stopped_ = true;
      return false;
    }
    // A cell the board paints the clue colour that no region may claim any more
    // — it borders one, and joining would merge the two — can never take that
    // colour, and nothing further down puts it back.
    if (blocked.intersects(terms_.mustCover))
      return false;
    const Bits free = terms_.room.without(used).without(blocked);
    if (!bigsFitCached(free))
      return false;
    if (index == small_.size()) {
      Bits regions = used;
      if (!bigsFit(free, big_, &regions) || !finished(regions))
        return false;
      claimed = regions;
      return true;
    }
    if (used.test(small_[index].cell))   // swallowed by an earlier region
      return placeSmall(index + 1, used, blocked, claimed, economical);
    return tryShapes(index, used, blocked, claimed, economical);
  }

  bool tryShapes(const std::size_t index, const Bits &used, const Bits &blocked,
                 Bits &claimed, const bool economical) {
    const std::vector<Bits> &shapes = options_[index];
    const std::size_t tries = economical ? economical_[index] : shapes.size();
    for (std::size_t k = 0; k < tries; k++) {
      const Bits &shape = shapes[k];
      if (shape.intersects(used) || shape.intersects(blocked))
        continue;
      // Touching an existing region of this colour would merge the two into
      // one, which is a different region size than either demand asked for.
      if (shape.border().intersects(used))
        continue;
      if (!shapeAllowed(shape))
        continue;
      keys_.push_back(canonicalShape(shape));
      const bool done = placeSmall(index + 1, used | shape,
                                   blocked | shape.border(), claimed,
                                   economical);
      keys_.pop_back();
      if (done)
        return true;
      if (stopped_)
        return false;
    }
    return false;
  }

  const Model &model_;
  Terms terms_;
  Budget &budget_;
  std::vector<Demand> small_;
  std::vector<Demand> big_;
  std::vector<std::vector<Bits>> options_;
  std::vector<std::size_t> economical_;
  std::vector<Bits> keys_;
  std::unordered_map<Bits, bool, BitsHash> cache_;
  bool stopped_ = false;
};

/// Every claimed cell takes the clues' colour and every other playable one the
/// opposite, which is what makes the claimed regions the ONLY regions of that
/// colour — exactly the packing the search just built.
Colors paint(const Model &model, const Bits &claimed, const uint8_t color) {
  Colors colors{};
  colors.fill(kUnplayable);
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1))
    colors[slot(i)] = claimed.test(i) ? color : opposite(color);
  return colors;
}

/// The one colour every clue cell is painted, or kUnknown when the board does
/// not paint them all the same.
uint8_t clueColorOf(const Model &model) {
  uint8_t color = kUnknown;
  for (const Clue &clue : model.puzzle.clues) {
    const uint8_t given = model.puzzle.givens[slot(clue.index)];
    if (given != kDark && given != kLight)
      return kUnknown;
    if (color != kUnknown && color != given)
      return kUnknown;
    color = given;
  }
  return color;
}

/// The size every region of the clue colour has, or 0 when the board does not
/// say. Zero is not a legal size, so it doubles as "no instance" safely.
int uniformSize(const Model &model, const uint8_t color) {
  for (const rules::SizedRule &area : model.puzzle.areas)
    if (area.color == color)
      return area.value;
  return 0;
}

/**
 * The rules the packing expresses, or false when the board carries one it does
 * not.
 *
 * A shape rule is taken only on the CLUE colour: the other colour is whatever
 * the packing leaves over, and the search steers none of it. A connect rule on
 * either colour is fine — neither prunes, both are tested on the finished
 * packing.
 */
bool readRules(const Model &model, Terms &terms) {
  using enum Rule;
  const bool dark = terms.color == kDark;
  const Rule distinct = dark ? DistinctShapesDark : DistinctShapesLight;
  const Rule same = dark ? SameShapeDark : SameShapeLight;
  if (model.hasRule(distinct))
    terms.shapes = ShapeRule::Distinct;
  if (model.hasRule(same)) {
    // Both at once says the colour has at most one region — a legal board, but
    // not one the two filters below can express together, so it is declined.
    if (terms.shapes != ShapeRule::None)
      return false;
    terms.shapes = ShapeRule::Same;
  }
  terms.connectClue = model.hasRule(dark ? ConnectDark : ConnectLight);
  terms.connectRest = model.hasRule(dark ? ConnectLight : ConnectDark);

  const auto known =
      std::to_array<Rule>({ConnectDark, ConnectLight, distinct, same});
  for (int index = 0; index < rules::kRuleCount; index++) {
    if (const auto rule = static_cast<Rule>(index);
        model.hasRule(rule) && !std::ranges::contains(known, rule))
      return false;
  }
  return true;
}

/// What the puzzle paints, split into the two things the packer does with it.
void readGivens(const Model &model, Terms &terms) {
  terms.room = model.playable;
  for (int i = model.playable.nextSet(0); i >= 0;
       i = model.playable.nextSet(i + 1)) {
    if (const uint8_t given = model.puzzle.givens[slot(i)];
        given == terms.color)
      terms.mustCover.set(i);
    else if (given != kUnknown)
      terms.room.reset(i);
  }
}

/// The board's demands, or nothing when a clue raises one this cannot carry.
/// Letters come first so their groups are built before the numbers that may
/// share a region with one.
std::vector<Demand> demandsOf(const Model &model, const int uniform) {
  std::array<Bits, kLetterCount> groups;
  for (const Clue &clue : model.puzzle.clues) {
    if (clue.kind == kClueLetter)
      groups[slot(clue.value)].set(clue.index);
  }
  std::vector<Demand> demands;
  for (int letter = 0; letter < kLetterCount; letter++) {
    if (const Bits &group = groups[slot(letter)]; group.any())
      demands.push_back({.required = group,
                         .cell = group.nextSet(0),
                         .size = uniform,
                         .id = static_cast<int>(demands.size()),
                         .letter = static_cast<uint8_t>(letter)});
  }
  for (const Clue &clue : model.puzzle.clues) {
    if (clue.kind != kClueArea)
      continue;
    // With a uniform size in force a number naming a different one is a
    // contradiction, which is for the arms that prove things to report.
    if (uniform != 0 && clue.value != uniform)
      return {};
    demands.push_back({.required = oneCell(clue.index),
                       .cell = clue.index,
                       .size = clue.value,
                       .id = static_cast<int>(demands.size())});
  }
  return demands;
}

/// Everything the board says, read once. Empty `demands` means declined.
struct Reading {
  Terms terms;
  std::vector<Demand> demands;
};

Reading readBoard(const Model &model) {
  Reading reading;
  if (model.hasShapes || !model.puzzle.runs.empty())
    return reading;
  if (model.puzzle.clues.size() < 2)
    return reading;
  if (std::ranges::any_of(model.puzzle.clues, [](const Clue &clue) {
        return clue.kind != kClueArea && clue.kind != kClueLetter;
      }))
    return reading;

  reading.terms.color = clueColorOf(model);
  if (reading.terms.color == kUnknown)
    return reading;
  // One instance, and on the clue colour: an instance on the OTHER colour
  // would size the regions the packing merely leaves over, which it never
  // enumerates and so cannot honour.
  const int uniform = uniformSize(model, reading.terms.color);
  if (model.puzzle.areas.size() > (uniform == 0 ? 0U : 1U))
    return reading;
  // A letter says which cells share a region, never how big it is, so a board
  // carrying one needs the instance that gives every region of the colour a
  // size.
  if (uniform == 0 &&
      std::ranges::any_of(model.puzzle.clues, [](const Clue &clue) {
        return clue.kind == kClueLetter;
      }))
    return reading;
  if (!readRules(model, reading.terms))
    return reading;

  readGivens(model, reading.terms);
  std::vector<Demand> demands = demandsOf(model, uniform);
  if (demands.size() < 2 ||
      std::ranges::any_of(demands, [&model](const Demand &demand) {
        return demand.size < 1 || demand.size > model.playableCount;
      }))
    return reading;
  reading.demands = std::move(demands);
  return reading;
}

} // namespace

bool applicable(const Model &model) { return !readBoard(model).demands.empty(); }

Outcome runPacking(const Model &model, const Config &cfg) {
  Outcome outcome;
  const auto &[terms, demands] = readBoard(model);
  if (demands.empty())
    return outcome;

  Budget budget(cfg, "packing", outcome.stats);
  Packer packer(model, terms, budget);
  if (!packer.prepare(demands))
    return outcome;
  Bits claimed;
  if (!packer.run(claimed) || packer.stopped())
    return outcome;

  const Colors answer = paint(model, claimed, terms.color);
  // The net every construction here keeps: a packing built from a misread board
  // yields nothing rather than something wrong.
  if (verify::check(model, answer) != verify::Violation::None)
    return outcome;
  outcome.status = Status::Solved;
  outcome.colors = answer;
  outcome.decided = model.playable.count();
  outcome.witnesses.push_back(answer);
  return outcome;
}

} // namespace lg::packing
