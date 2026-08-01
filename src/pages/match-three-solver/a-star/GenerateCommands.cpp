#include "GenerateCommands.h"

#include "FixtureIo.h"
#include "Rules.h"
#include "SeededRng.h"

#include <algorithm>
#include <iostream>
#include <vector>

namespace mt::generate {

namespace {

/// Attempts before the generator settles for whatever it has.
constexpr int kAttempts = 40;

/// Where a cell may be filled: within a column, contiguously up from the bottom
/// of each blockade-free segment, so the result needs no settling — it is
/// already the shape gravity would leave. Returned bottom-up row-major, which
/// is the order the placement pass wants: when it reaches a cell, the only
/// filled neighbours are the ones it has to check against.
std::vector<int> fillSlots(const Board &board, SeededRng &rng) {
  std::vector fillable(slot(board.cellCount()), false);
  for (int x = 0; x < board.width; x++) {
    int y = board.height - 1;
    while (y >= 0) {
      if (board.at(x, y) == kBlocked) {
        y--;
        continue;
      }
      // One segment: from here up to the next blockade.
      int top = y;
      while (top >= 0 && board.at(x, top) != kBlocked)
        top--;
      const int height = y - top;
      // Leave a random slice of the segment's top empty, the way a partly
      // cleared board looks.
      const int filled = rng.uniform(height / 2, height);
      for (int k = 0; k < filled; k++)
        fillable[flat(board.width, x, y - k)] = true;
      y = top;
    }
  }

  std::vector<int> slots;
  for (int y = board.height - 1; y >= 0; y--) {
    for (int x = 0; x < board.width; x++) {
      if (fillable[flat(board.width, x, y)])
        slots.push_back(y * board.width + x);
    }
  }
  return slots;
}

/// A bag of symbol tokens whose per-symbol totals are all multiples of kMinRun.
/// A symbol left with one or two blocks can never clear, so a board whose
/// counts do not divide this way is dead before the first move — which is what
/// made the naive generator produce nothing but unsolvable boards.
std::vector<uint8_t> buildBag(const int count, const int symbols,
                              SeededRng &rng) {
  const int groups = count / kMinRun;
  std::vector perSymbol(slot(symbols), 0);
  for (int i = 0; i < groups; i++) {
    // Every symbol gets a group first, so none arrives already stranded.
    const int index = i < symbols ? i : rng.uniform(0, symbols - 1);
    perSymbol[slot(index)]++;
  }

  std::vector<uint8_t> bag;
  bag.reserve(slot(groups * kMinRun));
  for (int index = 0; index < symbols; index++) {
    const int tokens = perSymbol[slot(index)] * kMinRun;
    for (int k = 0; k < tokens; k++)
      bag.push_back(static_cast<uint8_t>(kFirstSymbol + index));
  }
  for (int i = static_cast<int>(bag.size()) - 1; i > 0; i--)
    std::swap(bag[slot(i)], bag[slot(rng.uniform(0, i))]);
  return bag;
}

/// Whether putting `value` at (x, y) would complete a run of three among the
/// cells already filled — those to the left and those below.
bool wouldRun(const Board &board, const int x, const int y,
              const uint8_t value) {
  int across = 1;
  for (int i = x - 1; i >= 0 && board.at(i, y) == value; i--)
    across++;
  if (across >= kMinRun)
    return true;
  int below = 1;
  for (int j = y + 1; j < board.height && board.at(x, j) == value; j++)
    below++;
  return below >= kMinRun;
}

/// Places the bag into the slots, skipping any token that would leave a line
/// standing. A slot no token fits stays empty, which is why the caller
/// re-checks the finished board rather than trusting the bag's arithmetic.
void place(Board &board, const std::vector<int> &slots,
           std::vector<uint8_t> &bag) {
  for (const int index : slots) {
    if (bag.empty())
      return;
    const int x = index % board.width;
    const int y = index / board.width;
    size_t pick = bag.size();
    for (size_t candidate = 0; candidate < bag.size(); candidate++) {
      if (!wouldRun(board, x, y, bag[candidate])) {
        pick = candidate;
        break;
      }
    }
    if (pick == bag.size())
      continue;
    board.cells[slot(index)] = bag[pick];
    bag.erase(bag.begin() + static_cast<ptrdiff_t>(pick));
  }
}

/// True when the board is worth handing to a solver: it has blocks, no symbol
/// is already stranded, it is a state the game could be in, and there is at
/// least one move to make.
bool usable(const Board &board) {
  if (rules::blockCount(board) == 0 || rules::hasStrandedSymbol(board))
    return false;
  if (rules::boardProblem(board) != rules::BoardProblem::None)
    return false;
  Board probe;
  probe.width = board.width;
  probe.height = board.height;
  std::vector<rules::PackedMove> moves;
  rules::legalMovesInto(board, probe, moves);
  return !moves.empty();
}

Board attempt(const Options &opts, SeededRng &rng) {
  // "cluster" is the profile that produces SOLVABLE boards: small, few
  // symbols, few blockades, so a symbol's blocks can still reach each other.
  // "random" is the wider net — most of its boards turn out unsolvable, which
  // exercises the proving arms rather than the witness path.
  const bool cluster = opts.kind == "cluster";
  // The profile's ceilings are lifted out rather than nested in the draws:
  // they are pure, so naming them cannot move an rng draw. The draws
  // themselves must stay inside their conditionals — hoisting one would
  // consume a number even when the caller pinned that dimension, and every
  // generated board downstream of it would change.
  const int side = cluster ? 6 : 10;
  const int palette = cluster ? 3 : 5;
  const int sparse = cluster ? 6 : 22;
  Board board;
  // A pinned dimension is clamped to the engine's own ceiling. Board::cells is
  // a kMaxCells array and the per-symbol counters are kSymbolCount wide, so
  // --width 33 --height 32 would fill 1056 of 1024 entries and --symbols 9
  // would emit a cell value that indexes SymbolCounts out of bounds. Clamping
  // rather than drawing keeps every rng draw where it was: a pinned dimension
  // consumes no number, so boards downstream of one are unchanged.
  board.width = opts.width > 0 ? std::min(opts.width, kMaxSide)
                               : rng.uniform(4, side);
  board.height = opts.height > 0 ? std::min(opts.height, kMaxSide)
                                 : rng.uniform(4, side);
  const int symbols = opts.symbols > 0 ? std::min(opts.symbols, kSymbolCount)
                                       : rng.uniform(2, palette);
  const int blockade = opts.blockadePercent >= 0 ? opts.blockadePercent
                                                 : rng.uniform(0, sparse);
  const int cells = board.cellCount();
  for (int i = 0; i < cells; i++)
    board.cells[slot(i)] = rng.uniform(0, 99) < blockade ? kBlocked : kEmpty;

  const std::vector<int> slots = fillSlots(board, rng);
  std::vector<uint8_t> bag =
      buildBag(static_cast<int>(slots.size()), symbols, rng);
  place(board, slots, bag);
  return board;
}

} // namespace

Result board(const Options &opts) {
  SeededRng rng(opts.seed);
  Result result;
  for (int tries = 0; tries < kAttempts; tries++) {
    result.board = attempt(opts, rng);
    if (usable(result.board)) {
      result.usable = true;
      break;
    }
  }
  return result;
}

int run(const std::string &path, const Options &opts) {
  const Result generated = board(opts);
  // Nothing is written when no attempt produced a usable board: saving the last
  // candidate and printing a success line would hand the fuzz harness a fixture
  // this function's own contract says it does not produce.
  if (!generated.usable) {
    std::cerr << "no usable board after " << kAttempts << " attempts (seed "
              << opts.seed << ")\n";
    return 1;
  }
  std::cout << "generated " << generated.board.width << "x"
            << generated.board.height << " board with "
            << rules::blockCount(generated.board) << " blocks -> " << path
            << "\n";
  fixtureio::save(path, generated.board);
  return 0;
}

} // namespace mt::generate
