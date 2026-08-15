#include "Budget.h"
#include "Rules.h"
#include "Search.h"
#include "TransTable.h"

#include <algorithm>
#include <vector>

// A level-synchronous beam over move count, widening while the budget lasts.
// Proves nothing, but unlike the greedy rollouts it carries many lines at once,
// which is what lets it get past a board whose every locally-best move is a
// trap. Because levels advance one move at a time, the first full clear a beam
// reaches is the shortest that beam can produce.
namespace mt {

namespace {

/// Widths tried in order, unless the config names one.
constexpr auto kWidths = std::to_array({128, 512, 2048});

struct Node {
  Board board;
  Moves path;
  int blocks = 0;
};

/// Everything a beam run reuses across its levels.
struct Frontier {
  std::vector<Node> current;
  std::vector<Node> next;
  std::vector<rules::PackedMove> moves;
  Board probe;
  Board child;
  rules::Mask mask{};
};

/// Expands one frontier state: stranded children pruned, duplicates within the
/// level collapsed through `seen`. Returns a full path the moment a child
/// clears the board.
Moves expandNode(const Node &node, Frontier &scratch, TransTable &seen) {
  scratch.moves.clear();
  rules::legalMovesInto(node.board, scratch.probe, scratch.moves);
  for (const rules::PackedMove packed : scratch.moves) {
    const int cleared =
        rules::applyPacked(node.board, scratch.child, packed, scratch.mask,
                           nullptr)
            .cleared;
    const int left = node.blocks - cleared;
    if (left == 0) {
      Moves solution = node.path;
      solution.push_back(rules::decodeMove(packed, node.board.width));
      return solution;
    }
    if (rules::hasStrandedSymbol(scratch.child))
      continue;
    // The table's depth semantics are unused here: storing at 1 and probing at
    // 1 makes it a plain exact-key seen-set, bounded and evicting — and an
    // eviction only ever re-admits a duplicate, which a beam tolerates.
    if (seen.probe(scratch.child, 1))
      continue;
    seen.store(scratch.child, 1);
    auto &[childBoard, childPath, childBlocks] = scratch.next.emplace_back();
    // copyBoard, never plain assignment: `Board::cells` is the fixed kMaxCells
    // inline array, so `=` moves 1024 bytes on every child whatever the board's
    // size — and this line runs once per surviving legal move per node, which
    // is the hottest allocation-free copy in the arm. See Types.h.
    copyBoard(scratch.child, childBoard);
    childPath = node.path;
    childPath.push_back(rules::decodeMove(packed, node.board.width));
    childBlocks = left;
  }
  return {};
}

/// One beam of the given width. Empty when it runs out of frontier, budget, or
/// room under `bound`.
Moves beamRun(const Board &start, const int blocks, const int width,
              const int bound, Frontier &scratch, Budget &budget) {
  scratch.current.clear();
  Node &root = scratch.current.emplace_back();
  copyBoard(start, root.board);
  root.blocks = blocks;

  for (int level = 1; level < bound && !scratch.current.empty(); level++) {
    scratch.next.clear();
    TransTable seen(start.cellCount(), kDefaultTableBytes / 8);
    for (const Node &node : scratch.current) {
      if (budget.exhausted())
        return {};
      if (Moves solution = expandNode(node, scratch, seen); !solution.empty())
        return solution;
    }
    std::ranges::sort(scratch.next, {}, &Node::blocks);
    if (static_cast<int>(scratch.next.size()) > width)
      scratch.next.resize(static_cast<size_t>(width));
    scratch.current.swap(scratch.next);
  }
  return {};
}

} // namespace

Outcome runBeam(const Board &board, const Config &cfg, Bounds &bounds) {
  Outcome outcome;
  outcome.arm = "beam";
  Budget budget(cfg, bounds, "beam", outcome.stats);

  const int blocks = rules::blockCount(board);
  if (blocks == 0)
    return outcome;

  Frontier scratch;
  scratch.probe.width = board.width;
  scratch.probe.height = board.height;
  scratch.child.width = board.width;
  scratch.child.height = board.height;

  const int known = bounds.bestLength();
  int bound = known == kNoLength ? blocks / kMinRun + 1 : known;
  Moves best;
  const auto widths =
      cfg.beamWidth > 0 ? std::vector{cfg.beamWidth}
                        : std::vector(kWidths.begin(), kWidths.end());
  for (const int width : widths) {
    if (budget.exhaustedNow())
      break;
    Moves found = beamRun(board, blocks, width, bound, scratch, budget);
    if (found.empty() || static_cast<int>(found.size()) >= bound)
      continue;
    bound = static_cast<int>(found.size());
    best = found;
    bounds.offer(best);
  }

  outcome.moves = best;
  return outcome;
}

} // namespace mt
