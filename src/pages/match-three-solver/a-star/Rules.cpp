#include "Rules.h"

#include <algorithm>

namespace mt::rules {

namespace {

/// Marks every run of kMinRun or more along one line: `length` cells at
/// `start`, `start + step`, and so on. Reading one past the end as kEmpty is
/// what closes a run that reaches the edge. Rows and columns share this
/// through the stride alone.
bool markLineRuns(const std::array<uint8_t, kMaxCells> &cells, Mask &mask,
                  const int start, const int step, const int length) {
  bool found = false;
  uint8_t runValue = kEmpty;
  int runStart = 0;
  for (int position = 0; position <= length; position++) {
    const uint8_t value =
        position < length
            ? cells[slot(start + position * step)]
            : kEmpty;
    if (value == runValue && isSymbol(value))
      continue;

    if (isSymbol(runValue) && position - runStart >= kMinRun) {
      for (int k = runStart; k < position; k++)
        mask[slot(start + k * step)] = 1;
      found = true;
    }
    runValue = value;
    runStart = position;
  }
  return found;
}

/// Clears every marked cell, counting what went and — when asked — which
/// symbols it was.
int clearMask(Board &board, const Mask &mask, SymbolCounts *deltas) {
  int cleared = 0;
  const int cells = board.cellCount();
  for (int i = 0; i < cells; i++) {
    if (mask[static_cast<size_t>(i)] == 0)
      continue;
    if (const uint8_t value = board.cells[static_cast<size_t>(i)];
        deltas != nullptr && isSymbol(value))
      (*deltas)[slot(value - kFirstSymbol)]++;
    board.cells[static_cast<size_t>(i)] = kEmpty;
    cleared++;
  }
  return cleared;
}

/// Records the swap when it is in bounds, between two different symbols, and
/// actually clears something. `probe` holds a copy of the board and is
/// restored before returning.
void tryMove(Board &probe, const int aIndex, const int down,
             std::vector<PackedMove> &out) {
  const int width = probe.width;
  const int x = aIndex % width;
  const int y = aIndex / width;
  const int bx = down == 1 ? x : x + 1;
  const int by = down == 1 ? y + 1 : y;
  if (bx >= width || by >= probe.height)
    return;

  const int bIndex = by * width + bx;
  const uint8_t a = probe.cells[static_cast<size_t>(aIndex)];
  const uint8_t b = probe.cells[static_cast<size_t>(bIndex)];
  if (!isSymbol(b) || a == b)
    return;

  probe.cells[static_cast<size_t>(aIndex)] = b;
  probe.cells[static_cast<size_t>(bIndex)] = a;
  const bool clears = hasRunThrough(probe, x, y) || hasRunThrough(probe, bx, by);
  probe.cells[static_cast<size_t>(aIndex)] = a;
  probe.cells[static_cast<size_t>(bIndex)] = b;
  if (clears)
    out.push_back(packMove(aIndex, down));
}

} // namespace

bool findMatchesInto(const Board &board, Mask &mask) {
  const int width = board.width;
  const int height = board.height;
  std::fill_n(mask.begin(), static_cast<size_t>(board.cellCount()), uint8_t{0});
  bool found = false;
  for (int y = 0; y < height; y++) {
    if (markLineRuns(board.cells, mask, y * width, 1, width))
      found = true;
  }
  for (int x = 0; x < width; x++) {
    if (markLineRuns(board.cells, mask, x, width, height))
      found = true;
  }
  return found;
}

bool markRunsThrough(const Board &board, const int x, const int y, Mask &mask) {
  const int width = board.width;
  const uint8_t value = board.at(x, y);
  if (!isSymbol(value))
    return false;
  bool found = false;

  int left = x;
  while (left > 0 && board.at(left - 1, y) == value)
    left--;
  int right = x;
  while (right + 1 < width && board.at(right + 1, y) == value)
    right++;
  if (right - left + 1 >= kMinRun) {
    for (int k = left; k <= right; k++)
      mask[slot(y * width + k)] = 1;
    found = true;
  }

  int top = y;
  while (top > 0 && board.at(x, top - 1) == value)
    top--;
  int bottom = y;
  while (bottom + 1 < board.height && board.at(x, bottom + 1) == value)
    bottom++;
  if (bottom - top + 1 >= kMinRun) {
    for (int k = top; k <= bottom; k++)
      mask[slot(k * width + x)] = 1;
    found = true;
  }

  return found;
}

bool hasRunThrough(const Board &board, const int x, const int y) {
  const uint8_t value = board.at(x, y);
  if (!isSymbol(value))
    return false;

  int across = 1;
  for (int i = x - 1; i >= 0 && board.at(i, y) == value; i--)
    across++;
  for (int i = x + 1; i < board.width && board.at(i, y) == value; i++)
    across++;
  if (across >= kMinRun)
    return true;

  int down = 1;
  for (int j = y - 1; j >= 0 && board.at(x, j) == value; j--)
    down++;
  for (int j = y + 1; j < board.height && board.at(x, j) == value; j++)
    down++;
  return down >= kMinRun;
}

void applyGravity(Board &board) {
  const int width = board.width;
  const int height = board.height;
  for (int x = 0; x < width; x++) {
    int write = height - 1;
    for (int y = height - 1; y >= 0; y--) {
      const uint8_t value = board.cells[slot(y * width + x)];
      if (value == kBlocked) {
        write = y - 1;
        continue;
      }
      if (value == kEmpty)
        continue;
      board.cells[slot(y * width + x)] = kEmpty;
      board.cells[slot(write * width + x)] = value;
      write--;
    }
  }
}

int blockCount(const Board &board) {
  int count = 0;
  const int cells = board.cellCount();
  for (int i = 0; i < cells; i++) {
    if (isSymbol(board.cells[static_cast<size_t>(i)]))
      count++;
  }
  return count;
}

void symbolCountsInto(const Board &board, SymbolCounts &counts) {
  counts.fill(0);
  const int cells = board.cellCount();
  for (int i = 0; i < cells; i++) {
    if (const uint8_t value = board.cells[static_cast<size_t>(i)];
        isSymbol(value))
      counts[slot(value - kFirstSymbol)]++;
  }
}

bool hasStrandedSymbol(const Board &board) {
  SymbolCounts counts{};
  symbolCountsInto(board, counts);
  return std::ranges::any_of(
      counts, [](const int32_t count) { return count > 0 && count < kMinRun; });
}

ApplyResult resolve(Board &board, Mask &mask) {
  ApplyResult result;
  while (findMatchesInto(board, mask)) {
    result.cleared += clearMask(board, mask, nullptr);
    applyGravity(board);
    result.cascades++;
  }
  return result;
}

BoardProblem boardProblem(const Board &board) {
  using enum BoardProblem;
  for (int y = 0; y < board.height - 1; y++) {
    for (int x = 0; x < board.width; x++) {
      if (!isSymbol(board.at(x, y)))
        continue;
      if (board.at(x, y + 1) == kEmpty)
        return Floating;
    }
  }
  Mask mask{};
  return findMatchesInto(board, mask) ? Matching : None;
}

const char *describe(const BoardProblem problem) {
  using enum BoardProblem;
  switch (problem) {
  case Floating:
    return "a block floats above an empty cell; the board has not settled";
  case Matching:
    return "a line of three is still standing; the board has not settled";
  case None:
  default:
    return "";
  }
}

void legalMovesInto(const Board &board, Board &probe,
                    std::vector<PackedMove> &out) {
  copyBoard(board, probe);
  const int width = board.width;
  const int height = board.height;
  for (int y = 0; y < height; y++) {
    for (int x = 0; x < width; x++) {
      const int index = y * width + x;
      if (!isSymbol(board.cells[static_cast<size_t>(index)]))
        continue;
      tryMove(probe, index, 0, out);
      tryMove(probe, index, 1, out);
    }
  }
}

ApplyResult applyPacked(const Board &from, Board &into, const PackedMove packed,
                        Mask &mask, SymbolCounts *deltas) {
  copyBoard(from, into);
  const int width = into.width;
  const int aIndex = moveIndex(packed);
  const int bIndex = partnerIndex(packed, width);
  const uint8_t held = into.cells[static_cast<size_t>(aIndex)];
  into.cells[static_cast<size_t>(aIndex)] =
      into.cells[static_cast<size_t>(bIndex)];
  into.cells[static_cast<size_t>(bIndex)] = held;

  std::fill_n(mask.begin(), static_cast<size_t>(into.cellCount()), uint8_t{0});
  // Only through the two swapped cells: the swap is pre-proven legal, and on
  // a settled board every new match passes through a cell that moved.
  markRunsThrough(into, aIndex % width, aIndex / width, mask);
  markRunsThrough(into, bIndex % width, bIndex / width, mask);

  ApplyResult result;
  result.cleared = clearMask(into, mask, deltas);
  result.cascades = 1;
  applyGravity(into);
  while (findMatchesInto(into, mask)) {
    result.cleared += clearMask(into, mask, deltas);
    applyGravity(into);
    result.cascades++;
  }
  return result;
}

bool applyMove(const Board &from, const Move &move, Board &into, Mask &mask,
               ApplyResult &result) {
  const int width = from.width;
  if (move.ax >= width || move.bx >= width || move.ay >= from.height ||
      move.by >= from.height)
    return false;
  const int aIndex = move.ay * width + move.ax;
  const int bIndex = move.by * width + move.bx;
  // b has to be a's right or down neighbor — the only two directions a move
  // is ever expressed in.
  if (const bool adjacent = (bIndex == aIndex + 1 && move.by == move.ay) ||
                            bIndex == aIndex + width;
      !adjacent)
    return false;
  const uint8_t a = from.cells[static_cast<size_t>(aIndex)];
  const uint8_t b = from.cells[static_cast<size_t>(bIndex)];
  if (!isSymbol(a) || !isSymbol(b) || a == b)
    return false;

  // Legality: the swap has to clear something. Checked with a full rescan
  // rather than the targeted marking, so this path never assumes the board
  // was settled — it is the oracle the search's fast kernel is checked
  // against.
  copyBoard(from, into);
  into.cells[static_cast<size_t>(aIndex)] = b;
  into.cells[static_cast<size_t>(bIndex)] = a;
  if (!findMatchesInto(into, mask))
    return false;

  result.cleared = clearMask(into, mask, nullptr);
  result.cascades = 1;
  applyGravity(into);
  const auto [restCleared, restCascades] = resolve(into, mask);
  result.cleared += restCleared;
  result.cascades += restCascades;
  return true;
}

} // namespace mt::rules
