// AStar: the solution post-processor.
//
// A* with weighted / non-admissible heuristics returns a valid but not
// necessarily optimal plan. optimizeSolution() shortens it with local
// rewrites, each accepted only if a full replay confirms it still solves.

#include "ClangdCompat.h" // must stay first; see the header

#include "AStar.h"
#include "MemoryProbe.h"
#include "SolverClock.h"

#include <algorithm>
#include <functional>
#include <utility>

// ===========================================================================
// Solution post-processing
//
// A* with weighted/non-admissible heuristics returns a *valid* but not
// necessarily *optimal* solution. This pass shortens it with a handful of
// local rewrites, each one accepted only if a full replay confirms the
// candidate is still a valid solution that is no longer than the input. That
// replay check (`replaySolves`) is the single source of truth — every rewrite
// rule is just a *candidate generator*, so a buggy generator can never produce
// an invalid or longer solution, only miss an improvement.
//
// Rewrites, applied greedily to a fixed point:
//   * truncation        — drop everything after the goal block first reaches
//                         goalAnchor.
//   * run-pair cancel   — a block slides one way and later the opposite way;
//                         cancel the overlapping part of both slides.
//   * run removal       — a block's entire slide turns out to be unnecessary.
//   * single removal    — one stray turn is unnecessary.
//   * reorder / merge   — "A slides, B slides, A slides the same way again":
//                         do both of A's slides back-to-back (one player
//                         drag) when no collision forbids it.
// ===========================================================================

std::vector<AStar::MoveRun> AStar::computeRuns(const std::vector<Turn> &turns) {
  std::vector<MoveRun> runs;
  for (size_t i = 0; i < turns.size(); i++) {
    if (!runs.empty() && runs.back().blockId == turns[i].blockId &&
        runs.back().dir == turns[i].direction) {
      runs.back().len++;
    } else {
      runs.emplace_back(i, 1, turns[i].blockId, turns[i].direction);
    }
  }
  return runs;
}

// Player steps as the UI counts them (solutionView.ts): one step = a maximal
// run of consecutive turns of the SAME BLOCK, across direction changes — the
// player performs it as a single polyline drag. (computeRuns is finer: it
// splits on direction too, because the rewrite passes operate on straight
// legs.)
size_t AStar::countSteps(const std::vector<Turn> &turns) {
  size_t steps = 0;
  for (size_t i = 0; i < turns.size(); i++)
    if (i == 0 || turns[i].blockId != turns[i - 1].blockId)
      steps++;
  return steps;
}

bool AStar::replaySolves(const std::vector<Turn> &turns) const {
  std::vector<Position> anchors = initialAnchors_;
  for (const auto &[blockId, direction] : turns) {
    if (blockId >= anchors.size())
      return false;
    const auto d = std::to_underlying(direction);
    const Position next{.x = static_cast<int8_t>(anchors[blockId].x + DX[d]),
                        .y = static_cast<int8_t>(anchors[blockId].y + DY[d])};
    if (!inBounds(blockId, next))
      return false;
    anchors[blockId] = next;
    if (collidesWithOthers(blockId, next, anchors))
      return false;
  }
  return anchors[goalIndex_] == goalAnchor_;
}

size_t AStar::firstSolvingPrefixLen(const std::vector<Turn> &turns) const {
  std::vector<Position> anchors = initialAnchors_;
  if (anchors[goalIndex_] == goalAnchor_)
    return 0;
  for (size_t i = 0; i < turns.size(); i++) {
    const auto &[blockId, direction] = turns[i];
    // Same bounds guard replaySolves() carries. optimizeSolution() calls this
    // FIRST, and the exported optimize() binding (wasm_bindings.cpp) builds
    // `turns` straight from caller-supplied JS with no validation, so an
    // out-of-range blockId/direction would otherwise be an out-of-bounds heap
    // write / static-array read inside wasm linear memory.
    if (blockId >= anchors.size())
      return i;
    // Direction's underlying type is unsigned, so only the upper bound can be
    // violated by a caller-supplied value.
    const auto d = std::to_underlying(direction);
    if (d > 3)
      return i;
    anchors[blockId] = {.x = static_cast<int8_t>(anchors[blockId].x + DX[d]),
                        .y = static_cast<int8_t>(anchors[blockId].y + DY[d])};
    if (blockId == goalIndex_ && anchors[goalIndex_] == goalAnchor_)
      return i + 1;
  }
  return turns.size();
}

// A block slides `dir` for `runA` turns and later slides the opposite way for
// `runB` turns. The overlapping min(lenA, lenB) cells are a pure detour: try
// to delete that many turns from each run (largest overlap first).
bool AStar::tryRunPairCancellation(std::vector<Turn> &turns) const {
  const auto runs = computeRuns(turns);
  for (size_t a = 0; a < runs.size(); a++) {
    for (size_t b = a + 1; b < runs.size(); b++) {
      if (runs[a].blockId != runs[b].blockId)
        continue;
      if ((std::to_underlying(runs[a].dir) + 2) % 4 !=
          std::to_underlying(runs[b].dir))
        continue; // not opposite directions
      const size_t maxC = std::min(runs[a].len, runs[b].len);
      for (size_t c = maxC; c >= 1; c--) {
        const size_t aLo = runs[a].start + runs[a].len - c;
        const size_t aHi = runs[a].start + runs[a].len;
        const size_t bLo = runs[b].start;
        const size_t bHi = runs[b].start + c;
        std::vector<Turn> cand;
        cand.reserve(turns.size() - 2 * c);
        for (size_t k = 0; k < turns.size(); k++) {
          if (k >= aLo && k < aHi)
            continue;
          if (k >= bLo && k < bHi)
            continue;
          cand.push_back(turns[k]);
        }
        if (replaySolves(cand)) {
          turns = std::move(cand);
          return true;
        }
      }
    }
  }
  return false;
}

// An entire slide of a block may be superfluous (e.g. a block edged aside for
// a clearance that the rest of the solution never actually needed).
bool AStar::tryRunRemoval(std::vector<Turn> &turns) const {
  const auto runs = computeRuns(turns);
  // `turns` is reassigned on success, so the bound is read once up front.
  const size_t n = turns.size();
  for (const auto &r : runs) {
    std::vector<Turn> cand;
    cand.reserve(n - r.len);
    for (size_t k = 0; k < n; k++) {
      if (k >= r.start && k < r.start + r.len)
        continue;
      cand.push_back(turns[k]);
    }
    if (replaySolves(cand)) {
      turns = std::move(cand);
      return true;
    }
  }
  return false;
}

// General clean-up: drop any single turn whose removal still leaves a valid
// solution. Looped, this also unwinds detours one cell at a time.
bool AStar::trySingleRemoval(std::vector<Turn> &turns) const {
  // `turns` is reassigned on success, so the bound is read once up front.
  const size_t n = turns.size();
  for (size_t k = 0; k < n; k++) {
    std::vector<Turn> cand;
    cand.reserve(n - 1);
    for (size_t m = 0; m < n; m++)
      if (m != k)
        cand.push_back(turns[m]);
    if (replaySolves(cand)) {
      turns = std::move(cand);
      return true;
    }
  }
  return false;
}

// "A slides, B slides, A slides the same way again." If nothing forbids it,
// run both of A's slides back-to-back so the player performs a single drag.
// Turn count is unchanged; the player-step count drops by one. Only A's two
// runs are relocated past *other* blocks' runs — A's own move order is never
// reordered — so the run brought adjacent always merges.
bool AStar::tryReorderMerge(std::vector<Turn> &turns) const {
  const auto runs = computeRuns(turns);
  const size_t baseSteps = runs.size();
  std::vector prevRunOfBlock(shapes_.size(), -1);
  for (size_t j = 0; j < runs.size(); j++) {
    const int prev = prevRunOfBlock[runs[j].blockId];
    prevRunOfBlock[runs[j].blockId] = static_cast<int>(j);
    if (prev < 0)
      continue;
    const auto &ri = runs[static_cast<size_t>(prev)];
    const auto &rj = runs[j];
    if (ri.dir != rj.dir)
      continue; // different dir → cannot merge cleanly
    if (static_cast<size_t>(prev) + 1 == j)
      continue; // already adjacent
    const size_t riEnd = ri.start + ri.len;

    // Candidate 1: pull run j left, right after run i.
    {
      const size_t rjEnd = rj.start + rj.len;
      std::vector<Turn> cand;
      cand.reserve(turns.size());
      for (size_t k = 0; k < riEnd; k++)
        cand.push_back(turns[k]);
      for (size_t k = rj.start; k < rjEnd; k++)
        cand.push_back(turns[k]);
      for (size_t k = riEnd; k < rj.start; k++)
        cand.push_back(turns[k]);
      for (size_t k = rjEnd; k < turns.size(); k++)
        cand.push_back(turns[k]);
      if (countSteps(cand) < baseSteps && replaySolves(cand)) {
        turns = std::move(cand);
        return true;
      }
    }
    // Candidate 2: push run i right, just before run j.
    {
      std::vector<Turn> cand;
      cand.reserve(turns.size());
      for (size_t k = 0; k < ri.start; k++)
        cand.push_back(turns[k]);
      for (size_t k = riEnd; k < rj.start; k++)
        cand.push_back(turns[k]);
      for (size_t k = ri.start; k < riEnd; k++)
        cand.push_back(turns[k]);
      for (size_t k = rj.start; k < turns.size(); k++)
        cand.push_back(turns[k]);
      if (countSteps(cand) < baseSteps && replaySolves(cand)) {
        turns = std::move(cand);
        return true;
      }
    }
  }
  return false;
}

std::vector<Turn>
AStar::optimizeSolution(const std::vector<Turn> &input) const {
  std::vector<Turn> cur = input;
  cur.resize(firstSolvingPrefixLen(cur));

  // Every accepted rewrite strictly lowers (turns, then steps), both bounded
  // below by 0, so the loop terminates; the cap is only a paranoia guard.
  // The wall-clock cap and cancel check are NOT paranoia: without them a long
  // plan polishes for minutes while the caller's budget has already expired.
  constexpr int kMaxIterations = 100000;
  const uint64_t deadline =
      cfg_.optimizeMaxMs == 0 ? 0 : nowMs() + cfg_.optimizeMaxMs;
  for (int iter = 0; iter < kMaxIterations; iter++) {
    if (deadline != 0 && nowMs() >= deadline)
      break;
    if (cfg_.cancel && cfg_.cancel->load(std::memory_order_relaxed))
      break;
    if (const bool improved = tryRunPairCancellation(cur) ||
                              tryRunRemoval(cur) || trySingleRemoval(cur) ||
                              tryReorderMerge(cur);
        !improved)
      break;
    cur.resize(firstSolvingPrefixLen(cur));
  }
  return cur;
}
