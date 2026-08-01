#include "Budget.h"
#include "ForcedClear.h"
#include "Search.h"
#include "TransTable.h"

#include <algorithm>
#include <vector>

// The two arms that can PROVE something, sharing one node-expansion engine
// ported from src/pages/match-three-solver/engine.ts.
//
//   iddfs — deepens from zero. Depth d is only reported once every shorter
//           length has been searched out, so a reported move count is always
//           minimal; and because every move clears at least kMinRun cells, the
//           deepening terminates on its own, which is what makes "unsolvable"
//           a real proof rather than a timeout in disguise.
//   bnb   — goes straight to one move below the incumbent. A single depth-B
//           search covers every path of length <= B, so searching it out
//           proves the incumbent minimal in one pass instead of climbing to
//           it; a solution found on the way just tightens B and restarts.
//
// Both end with the same grouping pass, so an answer either arm produces is
// arranged the way the TypeScript engine would have arranged it.
namespace mt {

namespace {

/// Whether two packed symbol pairs share a symbol. A pair is a move's two
/// pre-swap symbols, packed `(a << 4) | b`.
bool sharesSymbol(const int left, const int right) {
  const int leftA = left >> 4;
  const int leftB = left & 15;
  const int rightA = right >> 4;
  const int rightB = right & 15;
  return leftA == rightA || leftA == rightB || leftB == rightA ||
         leftB == rightB;
}

/// Per-recursion-level scratch, allocated once and reused by every node that
/// ever runs at that depth. This is what makes a node expansion
/// allocation-free.
struct Level {
  std::vector<Board> boards;
  std::vector<rules::PackedMove> moves;
  std::vector<int> symbols;
  std::vector<int> cleared;
  std::vector<int> scores;
  std::vector<int> order;
  std::vector<rules::SymbolCounts> deltas;
  Board probe;
  rules::Mask mask{};
  Board leaf;
};

class Prover {
public:
  Prover(const Board &board, const Config &cfg, Bounds &bounds)
      : board_(board), bounds_(bounds),
        table_(board.cellCount(), cfg.tableBytes),
        budget_(cfg, bounds, "exhaustive", stats_) {}

  Outcome run();

private:
  const Board &board_;
  Bounds &bounds_;
  TransTable table_;
  SearchStats stats_;
  Budget budget_;

  /// One entry per recursion depth, sized once in `run`. Never resized while
  /// the recursion is live: a deeper frame's `emplace_back` would reallocate
  /// and leave every enclosing frame's `Level &` dangling.
  std::vector<Level> levels_;
  rules::SymbolCounts symbolCounts_{};
  std::vector<rules::PackedMove> pathMoves_;
  std::vector<int> pathSymbols_;
  int pathLength_ = 0;

  int depth_ = 0;
  uint64_t solutions_ = 0;
  Moves best_;

  void explore(const Board &board, int remaining, int blocks);
  bool exploreInner(const Board &board, int remaining, int blocks);
  bool exploreLeaf(const Board &board, int blocks);
  static int collectMoves(const Board &board, Level &scratch);
  static void buildChildren(const Board &board, Level &scratch, int count);
  static void sortChildren(Level &scratch, int count);
  void pushStep(const Level &scratch, int child);
  void popStep(const Level &scratch, int child);
  [[nodiscard]] bool hasStrandedSymbol() const;
  void keepSolution();
  [[nodiscard]] Moves decodePath() const;
  [[nodiscard]] Outcome finish() const;
};

Outcome Prover::finish() const {
  Outcome outcome;
  outcome.moves = best_;
  outcome.stats = stats_;
  outcome.stats.statesStored = table_.size();
  outcome.arm = "exhaustive";
  return outcome;
}

/// One exhaustive pass at the deepest length worth trying, stopping the moment
/// it finds anything.
///
/// `natural = blocks / kMinRun` is a real ceiling, because every move clears at
/// least kMinRun cells — so a pass that searches out having found nothing has
/// PROVEN the board cannot be cleared. That is the only proof left in this
/// engine, and it is about existence rather than length.
Outcome Prover::run() {
  const int blocks = rules::blockCount(board_);
  if (blocks == 0)
    return finish();

  rules::symbolCountsInto(board_, symbolCounts_);
  const int natural = blocks / kMinRun;
  best_ = bounds_.best();
  pathMoves_.assign(static_cast<size_t>(natural) + 1, 0);
  pathSymbols_.assign(static_cast<size_t>(natural) + 1, 0);
  levels_.resize(static_cast<size_t>(natural) + 2);
  for (Level &scratch : levels_) {
    scratch.probe.width = board_.width;
    scratch.probe.height = board_.height;
    scratch.leaf.width = board_.width;
    scratch.leaf.height = board_.height;
  }

  if (natural <= 0) {
    Outcome outcome = finish();
    outcome.unsolvable = true;
    return outcome;
  }

  depth_ = natural;
  explore(board_, natural, blocks);

  Outcome outcome = finish();
  // Searched out with nothing found, and the clock never interrupted it.
  if (outcome.moves.empty() && !budget_.expired())
    outcome.unsolvable = true;
  return outcome;
}

void Prover::explore(const Board &board, const int remaining, const int blocks) {
  if (blocks == 0) {
    keepSolution();
    return;
  }
  if (remaining == 0)
    return;
  if (hasStrandedSymbol())
    return;
  // The forced-single-clear bound. Admissible, so a proof stays a proof: it
  // only ever says "this needs MORE moves than are left". Gated on the counts
  // the search already maintains, so the O(cells) scan behind it runs only
  // where it can possibly say something. See ForcedClear.h.
  if (forced::anyForcedCount(symbolCounts_)) {
    const int need = forced::bound(board);
    if (need != forced::kNoBound && need > remaining)
      return;
  }
  if (table_.probe(board, remaining))
    return;

  const uint64_t found = solutions_;
  const bool searchedOut = remaining == 1
                               ? exploreLeaf(board, blocks)
                               : exploreInner(board, remaining, blocks);

  // Only a subtree that was searched to the end, and came back with nothing,
  // may be written off — an entry from an abandoned subtree would prune a
  // branch that still holds the answer.
  if (searchedOut && solutions_ == found)
    table_.store(board, remaining);
}

bool Prover::exploreInner(const Board &board, const int remaining,
                          const int blocks) {
  Level &scratch = levels_[static_cast<size_t>(pathLength_)];
  const int moveCount = collectMoves(board, scratch);
  buildChildren(board, scratch, moveCount);
  sortChildren(scratch, moveCount);

  for (int i = 0; i < moveCount; i++) {
    if (budget_.exhausted() || !best_.empty())
      return false;
    const int child = scratch.order[static_cast<size_t>(i)];
    pushStep(scratch, child);
    explore(scratch.boards[static_cast<size_t>(child)], remaining - 1,
            blocks - scratch.cleared[static_cast<size_t>(child)]);
    popStep(scratch, child);
  }
  return true;
}

/// The last ply, where a move only matters if it clears the whole board: each
/// candidate is played into one scratch and thrown away, with no sort, no
/// keying and no child bookkeeping. The leaf ply is the majority of all
/// expansions in the tree, which is why it gets its own lean path.
bool Prover::exploreLeaf(const Board &board, const int blocks) {
  Level &scratch = levels_[static_cast<size_t>(pathLength_)];
  const int moveCount = collectMoves(board, scratch);

  for (int i = 0; i < moveCount; i++) {
    if (budget_.exhausted() || !best_.empty())
      return false;
    const rules::PackedMove packed = scratch.moves[static_cast<size_t>(i)];
    const rules::ApplyResult applied =
        rules::applyPacked(board, scratch.leaf, packed, scratch.mask, nullptr);
    if (applied.cleared != blocks)
      continue;
    const int aIndex = rules::moveIndex(packed);
    const int bIndex = rules::partnerIndex(packed, board.width);
    pathMoves_[static_cast<size_t>(pathLength_)] = packed;
    pathSymbols_[static_cast<size_t>(pathLength_)] =
        ((board.cells[static_cast<size_t>(aIndex)] - kFirstSymbol) << 4) |
        (board.cells[static_cast<size_t>(bIndex)] - kFirstSymbol);
    pathLength_++;
    keepSolution();
    pathLength_--;
  }
  return true;
}

int Prover::collectMoves(const Board &board, Level &scratch) {
  scratch.moves.clear();
  rules::legalMovesInto(board, scratch.probe, scratch.moves);
  const auto count = static_cast<int>(scratch.moves.size());
  const auto needed = static_cast<size_t>(count);
  if (scratch.boards.size() < needed) {
    scratch.boards.resize(needed);
    scratch.symbols.resize(needed);
    scratch.cleared.resize(needed);
    scratch.scores.resize(needed);
    scratch.order.resize(needed);
    scratch.deltas.resize(needed);
  }
  return count;
}

void Prover::buildChildren(const Board &board, Level &scratch,
                           const int count) {
  for (int i = 0; i < count; i++) {
    const auto slot = static_cast<size_t>(i);
    const rules::PackedMove packed = scratch.moves[slot];
    const int aIndex = rules::moveIndex(packed);
    const int bIndex = rules::partnerIndex(packed, board.width);
    scratch.symbols[slot] =
        ((board.cells[static_cast<size_t>(aIndex)] - kFirstSymbol) << 4) |
        (board.cells[static_cast<size_t>(bIndex)] - kFirstSymbol);
    scratch.deltas[slot].fill(0);
    scratch.cleared[slot] =
        rules::applyPacked(board, scratch.boards[slot], packed, scratch.mask,
                           &scratch.deltas[slot])
            .cleared;
  }
}

/// Biggest clear first — the order that reaches an empty board soonest, which
/// is now the only thing the ordering is for. Insertion sort, stable:
/// descending score, ties in enumeration order.
void Prover::sortChildren(Level &scratch, const int count) {
  for (int i = 0; i < count; i++) {
    const auto slot = static_cast<size_t>(i);
    scratch.scores[slot] = scratch.cleared[slot];
    scratch.order[slot] = i;
  }
  for (int i = 1; i < count; i++) {
    const int entry = scratch.order[static_cast<size_t>(i)];
    const int score = scratch.scores[static_cast<size_t>(entry)];
    int j = i - 1;
    while (j >= 0 &&
           scratch.scores[static_cast<size_t>(
               scratch.order[static_cast<size_t>(j)])] < score) {
      scratch.order[slot(j + 1)] =
          scratch.order[static_cast<size_t>(j)];
      j--;
    }
    scratch.order[slot(j + 1)] = entry;
  }
}

void Prover::pushStep(const Level &scratch, const int child) {
  const auto slot = static_cast<size_t>(child);
  pathMoves_[static_cast<size_t>(pathLength_)] = scratch.moves[slot];
  pathSymbols_[static_cast<size_t>(pathLength_)] = scratch.symbols[slot];
  pathLength_++;
  for (size_t symbol = 0; symbol < static_cast<size_t>(kSymbolCount); symbol++)
    symbolCounts_[symbol] -= scratch.deltas[slot][symbol];
}

void Prover::popStep(const Level &scratch, const int child) {
  const auto slot = static_cast<size_t>(child);
  pathLength_--;
  for (size_t symbol = 0; symbol < static_cast<size_t>(kSymbolCount); symbol++)
    symbolCounts_[symbol] += scratch.deltas[slot][symbol];
}

/// True once some symbol is down to one or two blocks — nothing can ever clear
/// those, so the board is dead. Eight reads, because the counts are patched as
/// moves are pushed and popped rather than rescanned per node.
bool Prover::hasStrandedSymbol() const {
  return std::ranges::any_of(symbolCounts_, [](const int32_t count) {
    return count > 0 && count < kMinRun;
  });
}

/// The first solution reached is the answer; the search unwinds right after.
void Prover::keepSolution() {
  solutions_++;
  if (!best_.empty())
    return;
  best_ = decodePath();
  // Published as early as it exists: a racing arm's deepening cap and the
  // page's best-so-far both read this.
  bounds_.offer(best_);
}

Moves Prover::decodePath() const {
  Moves moves;
  moves.reserve(static_cast<size_t>(pathLength_));
  for (int i = 0; i < pathLength_; i++) {
    const rules::PackedMove packed = pathMoves_[static_cast<size_t>(i)];
    const int aIndex = rules::moveIndex(packed);
    const int x = aIndex % board_.width;
    const int y = aIndex / board_.width;
    const bool down = rules::moveIsDown(packed);
    moves.push_back({.ax = static_cast<uint8_t>(x),
                     .ay = static_cast<uint8_t>(y),
                     .bx = static_cast<uint8_t>(down ? x : x + 1),
                     .by = static_cast<uint8_t>(down ? y + 1 : y)});
  }
  return moves;
}

} // namespace

Outcome runExhaustive(const Board &board, const Config &cfg, Bounds &bounds) {
  Prover prover(board, cfg, bounds);
  return prover.run();
}

} // namespace mt
