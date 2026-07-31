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

/// How one search pass ended.
enum class Step : uint8_t { Found, Expired, Continue };

/// Which arm the shared engine is being driven as.
enum class Mode : uint8_t { Deepening, Bounded };

class Prover {
public:
  Prover(const Board &board, const Config &cfg, Bounds &bounds, const Mode mode)
      : board_(board), bounds_(bounds), mode_(mode),
        table_(board.cellCount(), cfg.tableBytes),
        budget_(cfg, bounds, mode == Mode::Deepening ? "prove" : "bnb",
                stats_) {}

  Outcome run();

private:
  const Board &board_;
  Bounds &bounds_;
  Mode mode_;
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
  bool stopAtFirst_ = true;
  bool passFound_ = false;
  uint64_t solutions_ = 0;
  Moves best_;
  int bestSwitches_ = INT32_MAX;

  Outcome runDeepening(int blocks, int natural);
  Outcome runBounded(int blocks, int natural);
  Step runDepth(int depth, int blocks);
  Step runPass(int depth, int blocks);
  void tidyGrouping(int blocks);
  void explore(const Board &board, int remaining, int blocks);
  bool exploreInner(const Board &board, int remaining, int blocks);
  bool exploreLeaf(const Board &board, int blocks);
  static int collectMoves(const Board &board, Level &scratch);
  static void buildChildren(const Board &board, Level &scratch, int count);
  void sortChildren(Level &scratch, int count) const;
  void pushStep(const Level &scratch, int child);
  void popStep(const Level &scratch, int child);
  [[nodiscard]] bool hasStrandedSymbol() const;
  [[nodiscard]] int countSwitches() const;
  void keepSolution();
  [[nodiscard]] Moves decodePath() const;
  [[nodiscard]] Outcome finish(bool proven) const;
};

/// The grouping metric of a solution found elsewhere, replayed to read each
/// swap's pre-swap symbols — so an equal-grouping rearrangement cannot oust
/// an incumbent for nothing.
int movesSwitches(const Board &board, const Moves &moves) {
  Board current = board;
  Board next;
  rules::Mask mask{};
  int previous = -1;
  int switches = 0;
  for (const Move &move : moves) {
    const int first = current.at(move.ax, move.ay) - kFirstSymbol;
    const int second = current.at(move.bx, move.by) - kFirstSymbol;
    const int symbols = (first << 4) | second;
    if (previous >= 0 && !sharesSymbol(previous, symbols))
      switches++;
    previous = symbols;
    rules::ApplyResult applied;
    if (!rules::applyMove(current, move, next, mask, applied))
      break;
    current = next;
  }
  return switches;
}

Outcome Prover::finish(const bool proven) const {
  Outcome outcome;
  outcome.moves = best_;
  outcome.proven = proven;
  outcome.ruledOut = bounds_.ruledOut();
  outcome.stats = stats_;
  outcome.stats.statesStored = table_.size();
  outcome.arm = "iddfs";
  return outcome;
}

Outcome Prover::run() {
  const int blocks = rules::blockCount(board_);
  if (blocks == 0)
    return finish(true);

  rules::symbolCountsInto(board_, symbolCounts_);
  const int natural = blocks / kMinRun;
  best_ = bounds_.best();
  if (!best_.empty())
    bestSwitches_ = movesSwitches(board_, best_);
  pathMoves_.assign(static_cast<size_t>(natural) + 1, 0);
  pathSymbols_.assign(static_cast<size_t>(natural) + 1, 0);
  levels_.resize(static_cast<size_t>(natural) + 2);
  for (Level &scratch : levels_) {
    scratch.probe.width = board_.width;
    scratch.probe.height = board_.height;
    scratch.leaf.width = board_.width;
    scratch.leaf.height = board_.height;
  }

  return mode_ == Mode::Deepening ? runDeepening(blocks, natural)
                                  : runBounded(blocks, natural);
}

Outcome Prover::runDeepening(const int blocks, const int natural) {
  // With an incumbent in hand, exhausting every shorter length is a proof of
  // its minimality — the deepening never has to visit its own depth.
  const int cap = best_.empty()
                      ? natural
                      : std::min(natural, static_cast<int>(best_.size()) - 1);

  for (int depth = 0; depth <= cap; depth++) {
    const Step step = runDepth(depth, blocks);
    if (step == Step::Found)
      return finish(true);
    if (step == Step::Expired)
      return finish(false);
    bounds_.raiseRuledOut(depth);
  }

  if (best_.empty()) {
    Outcome outcome = finish(false);
    outcome.unsolvable = true;
    return outcome;
  }
  // Every shorter length is searched out: the incumbent is minimal.
  tidyGrouping(blocks);
  return finish(true);
}

/// One search per bound: at depth B every path of length <= B is covered, so
/// coming back empty proves nothing shorter than B+1 exists. A solution found
/// instead tightens B and the loop goes again.
Outcome Prover::runBounded(const int blocks, const int natural) {
  for (;;) {
    const int known = static_cast<int>(best_.size());
    const int bound = best_.empty() ? natural : std::min(natural, known - 1);
    if (bound <= 0) {
      // A one-move solution cannot be beaten, and depth 0 clears nothing.
      bounds_.raiseRuledOut(0);
      return finish(!best_.empty());
    }

    const Step step = runPass(bound, blocks);
    if (step == Step::Expired)
      return finish(false);
    if (step == Step::Found)
      continue;

    bounds_.raiseRuledOut(bound);
    if (best_.empty()) {
      Outcome outcome = finish(false);
      outcome.unsolvable = true;
      return outcome;
    }
    tidyGrouping(blocks);
    return finish(true);
  }
}

Step Prover::runDepth(const int depth, const int blocks) {
  const Step step = runPass(depth, blocks);
  if (step != Step::Found)
    return step;
  // The length is settled — shorter than anything known. Spend what is left of
  // the budget looking for it arranged more conveniently.
  stopAtFirst_ = false;
  explore(board_, depth, blocks);
  return Step::Found;
}

Step Prover::runPass(const int depth, const int blocks) {
  depth_ = depth;
  passFound_ = false;
  stopAtFirst_ = true;
  explore(board_, depth, blocks);
  if (passFound_)
    return Step::Found;
  // The pass the clock interrupted proved nothing.
  return budget_.expired() ? Step::Expired : Step::Continue;
}

/// Re-enumerates solutions at the proven length to pick the best-grouped one.
/// Never touches the move count, only which of the equally short answers the
/// player is shown.
void Prover::tidyGrouping(const int blocks) {
  depth_ = static_cast<int>(best_.size());
  stopAtFirst_ = false;
  explore(board_, depth_, blocks);
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
    if (budget_.exhausted() || (stopAtFirst_ && passFound_))
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
    if (budget_.exhausted() || (stopAtFirst_ && passFound_))
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

/// Biggest clear first while the length is still in question — that is the
/// order that reaches an empty board soonest. Only once the length is settled
/// is it worth spending the ordering on staying with one symbol, which is a
/// property of the answer rather than a way of finding it. Insertion sort,
/// stable: descending score, ties in enumeration order.
void Prover::sortChildren(Level &scratch, const int count) const {
  const int previous =
      stopAtFirst_ || pathLength_ == 0
          ? -1
          : pathSymbols_[slot(pathLength_ - 1)];
  for (int i = 0; i < count; i++) {
    const auto slot = static_cast<size_t>(i);
    const bool stay =
        previous >= 0 && sharesSymbol(scratch.symbols[slot], previous);
    scratch.scores[slot] = (stay ? 65536 : 0) + scratch.cleared[slot];
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

int Prover::countSwitches() const {
  int switches = 0;
  for (int i = 1; i < pathLength_; i++) {
    if (!sharesSymbol(pathSymbols_[slot(i - 1)],
                      pathSymbols_[static_cast<size_t>(i)]))
      switches++;
  }
  return switches;
}

void Prover::keepSolution() {
  solutions_++;
  passFound_ = true;
  const int length = pathLength_;
  const int switches = countSwitches();
  if (!best_.empty()) {
    const int known = static_cast<int>(best_.size());
    if (length > known)
      return;
    if (length == known && switches >= bestSwitches_)
      return;
  }
  bestSwitches_ = switches;
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

Outcome proveIddfs(const Board &board, const Config &cfg, Bounds &bounds) {
  Prover prover(board, cfg, bounds, Mode::Deepening);
  return prover.run();
}

Outcome runBnb(const Board &board, const Config &cfg, Bounds &bounds) {
  Prover prover(board, cfg, bounds, Mode::Bounded);
  Outcome outcome = prover.run();
  outcome.arm = "bnb";
  return outcome;
}

} // namespace mt
