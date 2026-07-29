#include "AStarOptimizer.h"

#include "SolverClock.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {

// Full id-aware state: blocks in INPUT order plus the satisfied set. The
// optimizer must not use the search's canonical (id-blind) encoding — two
// canonically equal states can bind ids to poses differently, and the turns
// being rewritten reference ids.
struct State {
  std::vector<Block> blocks;
  boost::dynamic_bitset<> satisfied;
};

std::string stateKey(const State &s) {
  std::string key;
  key.reserve(s.blocks.size() * 5 + s.satisfied.size() / 8 + 1);
  for (const auto &b : s.blocks) {
    key.push_back(static_cast<char>(b.x));
    key.push_back(static_cast<char>(b.y));
    key.push_back(static_cast<char>(b.width));
    key.push_back(static_cast<char>(b.depth));
    key.push_back(static_cast<char>(b.height));
  }
  for (size_t i = 0; i < s.satisfied.size(); i += 8) {
    uint8_t byte = 0;
    for (size_t bit = 0; bit < 8 && i + bit < s.satisfied.size(); bit++) {
      if (s.satisfied.test(i + bit)) {
        byte |= static_cast<uint8_t>(1u << bit);
      }
    }
    key.push_back(static_cast<char>(byte));
  }
  return key;
}

State initialState(const replay::Puzzle &puzzle) {
  State s{.blocks = puzzle.blocks,
          .satisfied = boost::dynamic_bitset(puzzle.cells.size())};
  for (const auto &b : s.blocks) {
    s.satisfied =
        b.updateMustTouchCells(puzzle.gridWidth, puzzle.cells, s.satisfied);
  }
  return s;
}

bool applyTurn(const replay::Puzzle &puzzle, State &s, const Turn &turn) {
  const auto it = std::ranges::find_if(
      s.blocks, [&](const Block &b) { return b.id == turn.blockId; });
  if (it == s.blocks.end()) {
    return false;
  }
  it->roll(turn.direction);
  if (!it->checkValidity(puzzle.gridWidth, puzzle.gridHeight, puzzle.cells,
                         s.blocks, s.satisfied)) {
    return false;
  }
  s.satisfied =
      it->updateMustTouchCells(puzzle.gridWidth, puzzle.cells, s.satisfied);
  return true;
}

bool validates(const replay::Puzzle &puzzle, const std::vector<Turn> &turns) {
  const auto [legal, solvedAtEnd, firstSolvedAt] =
      replay::replayTurns(puzzle, turns);
  return legal && solvedAtEnd;
}

// All intermediate states of a (legal) solution, states[k] = after k turns.
std::vector<State> replayStates(const replay::Puzzle &puzzle,
                                const std::vector<Turn> &turns) {
  std::vector<State> states;
  states.reserve(turns.size() + 1);
  states.push_back(initialState(puzzle));
  for (const auto &turn : turns) {
    State next = states.back();
    if (!applyTurn(puzzle, next, turn)) {
      return {};
    }
    states.push_back(std::move(next));
  }
  return states;
}

bool truncatePass(const replay::Puzzle &puzzle, std::vector<Turn> &turns) {
  const replay::Outcome outcome = replay::replayTurns(puzzle, turns);
  if (outcome.firstSolvedAt == SIZE_MAX ||
      outcome.firstSolvedAt >= turns.size()) {
    return false;
  }
  turns.resize(outcome.firstSolvedAt);
  return true;
}

// Cut [i, j) whenever state j exactly repeats state i: with a monotone
// satisfied set an exact repeat proves the loop did nothing, and because the
// repeat is id-aware the suffix replays identically.
bool loopCutPass(const replay::Puzzle &puzzle, std::vector<Turn> &turns) {
  const std::vector<State> states = replayStates(puzzle, turns);
  if (states.empty()) {
    return false;
  }
  std::unordered_map<std::string, size_t> firstSeen;
  for (size_t k = 0; k < states.size(); k++) {
    const auto [it, inserted] = firstSeen.try_emplace(stateKey(states[k]), k);
    if (!inserted) {
      std::vector<Turn> shorter;
      shorter.reserve(turns.size() - (k - it->second));
      shorter.insert(shorter.end(), turns.begin(),
                     turns.begin() + static_cast<ptrdiff_t>(it->second));
      shorter.insert(shorter.end(),
                     turns.begin() + static_cast<ptrdiff_t>(k), turns.end());
      if (validates(puzzle, shorter)) {
        turns = std::move(shorter);
        return true;
      }
    }
  }
  return false;
}

bool isInverse(const Turn &a, const Turn &b) {
  if (a.blockId != b.blockId) {
    return false;
  }
  using enum Direction;
  switch (a.direction) {
  case UP:
    return b.direction == DOWN;
  case DOWN:
    return b.direction == UP;
  case LEFT:
    return b.direction == RIGHT;
  case RIGHT:
    return b.direction == LEFT;
  }
  return false;
}

bool withoutRange(const replay::Puzzle &puzzle, std::vector<Turn> &turns,
                  const size_t from, const size_t count) {
  std::vector<Turn> shorter;
  shorter.reserve(turns.size() - count);
  shorter.insert(shorter.end(), turns.begin(),
                 turns.begin() + static_cast<ptrdiff_t>(from));
  shorter.insert(shorter.end(),
                 turns.begin() + static_cast<ptrdiff_t>(from + count),
                 turns.end());
  if (!validates(puzzle, shorter)) {
    return false;
  }
  turns = std::move(shorter);
  return true;
}

bool inversePairPass(const replay::Puzzle &puzzle, std::vector<Turn> &turns) {
  for (size_t i = 0; i + 1 < turns.size(); i++) {
    if (isInverse(turns[i], turns[i + 1]) &&
        withoutRange(puzzle, turns, i, 2)) {
      return true;
    }
  }
  return false;
}

bool singleRemovalPass(const replay::Puzzle &puzzle, std::vector<Turn> &turns,
                       const uint64_t deadline) {
  for (size_t i = 0; i < turns.size(); i++) {
    if (deadline != 0 && nowMs() >= deadline) {
      return false;
    }
    if (withoutRange(puzzle, turns, i, 1)) {
      return true;
    }
  }
  return false;
}

// Breadth-first exact reconnection from `from` to `target` in fewer than
// `maxDepth` moves. Bounded by a node cap so a wide window on a many-block
// board cannot blow up the post-processing budget. When `allowedIds` is
// given, only those blocks may move — restricting a reconnection to the
// blocks the original stretch used keeps the search in THEIR pose space (a
// single block has at most 64*64*6 poses, so the search completes exactly)
// instead of the full joint space.
std::optional<std::vector<Turn>> connect(
    const replay::Puzzle &puzzle, const State &from,
    const std::string &targetKey, const size_t maxDepth,
    const uint64_t deadline, const std::vector<uint8_t> *allowedIds = nullptr,
    const size_t nodeCap = 20000) {
  constexpr std::array kDirs = {Direction::UP, Direction::RIGHT,
                                Direction::DOWN, Direction::LEFT};

  struct Entry {
    State state;
    size_t parent;
    Turn turn;
    size_t depth;
  };
  std::vector<Entry> arena;
  arena.push_back({.state = from, .parent = SIZE_MAX, .turn = {}, .depth = 0});
  std::unordered_set<std::string> visited;
  visited.insert(stateKey(from));

  for (size_t head = 0; head < arena.size(); head++) {
    if (arena.size() > nodeCap || (deadline != 0 && nowMs() >= deadline)) {
      return std::nullopt;
    }
    // Copy: growing the arena below may reallocate it.
    const State current = arena[head].state;
    const size_t depth = arena[head].depth;
    if (depth >= maxDepth) {
      continue;
    }
    for (const auto &block : current.blocks) {
      if (allowedIds != nullptr &&
          !std::ranges::contains(*allowedIds, block.id)) {
        continue;
      }
      for (const auto dir : kDirs) {
        State next = current;
        if (!applyTurn(puzzle, next, {.blockId = block.id, .direction = dir})) {
          continue;
        }
        std::string const key = stateKey(next);
        if (!visited.insert(key).second) {
          continue;
        }
        arena.push_back({.state = std::move(next),
                         .parent = head,
                         .turn = {.blockId = block.id, .direction = dir},
                         .depth = depth + 1});
        if (key == targetKey) {
          std::vector<Turn> path;
          for (size_t k = arena.size() - 1; k != SIZE_MAX && k != 0;
               k = arena[k].parent) {
            path.push_back(arena[k].turn);
          }
          std::ranges::reverse(path);
          return path;
        }
      }
    }
  }
  return std::nullopt;
}

// Reconnects every stretch between consecutive must-touch events with a
// provably shortest replacement. Depth-first arms (the cracker above all)
// meander enormously BETWEEN touches, and those stretches never repeat a
// full state (the satisfied set differs before/after each touch), so the
// loop-cut pass cannot see them — but each stretch usually moves ONE block,
// whose pose space is tiny. Splicing runs right-to-left so earlier segment
// boundaries stay valid without recomputing the replay. Measured trigger: a
// fuzz board whose cracker solution was 15,606 turns against a 213-turn
// witness.
bool segmentPass(const replay::Puzzle &puzzle, std::vector<Turn> &turns,
                 const uint64_t deadline) {
  const std::vector<State> states = replayStates(puzzle, turns);
  if (states.empty()) {
    return false;
  }
  std::vector<size_t> bounds{0};
  for (size_t k = 1; k < states.size(); k++) {
    if (states[k].satisfied.count() != states[k - 1].satisfied.count()) {
      bounds.push_back(k);
    }
  }
  if (bounds.back() != states.size() - 1) {
    bounds.push_back(states.size() - 1);
  }

  const std::vector<Turn> backup = turns;
  bool changed = false;
  for (size_t i = bounds.size() - 1; i-- > 0;) {
    if (deadline != 0 && nowMs() >= deadline) {
      break;
    }
    const size_t a = bounds[i];
    const size_t b = bounds[i + 1];
    if (b - a < 2) {
      continue;
    }
    std::vector<uint8_t> movedIds;
    for (size_t t = a; t < b; t++) {
      if (!std::ranges::contains(movedIds, turns[t].blockId)) {
        movedIds.push_back(turns[t].blockId);
      }
    }
    const auto shorter =
        connect(puzzle, states[a], stateKey(states[b]), b - a - 1, deadline,
                &movedIds, 150000);
    if (!shorter) {
      continue;
    }
    turns.erase(turns.begin() + static_cast<ptrdiff_t>(a),
                turns.begin() + static_cast<ptrdiff_t>(b));
    turns.insert(turns.begin() + static_cast<ptrdiff_t>(a), shorter->begin(),
                 shorter->end());
    changed = true;
  }
  if (changed && !validates(puzzle, turns)) {
    // Reconnections target exact id-aware states, so this should be
    // unreachable — but the replay oracle stays the last word.
    turns = backup;
    return false;
  }
  return changed;
}

bool windowPass(const replay::Puzzle &puzzle, std::vector<Turn> &turns,
                const size_t window, const uint64_t deadline) {
  const std::vector<State> states = replayStates(puzzle, turns);
  if (states.empty()) {
    return false;
  }
  for (size_t i = 0; i + 2 < states.size(); i += std::max<size_t>(1, window / 2)) {
    if (deadline != 0 && nowMs() >= deadline) {
      return false;
    }
    const size_t j = std::min(i + window, states.size() - 1);
    if (j <= i + 1) {
      continue;
    }
    const auto shorter =
        connect(puzzle, states[i], stateKey(states[j]), j - i - 1, deadline);
    if (!shorter) {
      continue;
    }
    std::vector<Turn> next;
    next.reserve(turns.size() - (j - i) + shorter->size());
    next.insert(next.end(), turns.begin(),
                turns.begin() + static_cast<ptrdiff_t>(i));
    next.insert(next.end(), shorter->begin(), shorter->end());
    next.insert(next.end(), turns.begin() + static_cast<ptrdiff_t>(j),
                turns.end());
    if (next.size() < turns.size() && validates(puzzle, next)) {
      turns = std::move(next);
      return true;
    }
  }
  return false;
}

} // namespace

namespace optimizer {

std::vector<Turn> optimize(const replay::Puzzle &puzzle,
                           std::vector<Turn> turns, const uint32_t maxMs) {
  if (turns.empty() || !validates(puzzle, turns)) {
    return turns;
  }
  const uint64_t deadline = deadlineFrom(maxMs);

  bool changed = true;
  while (changed && (deadline == 0 || nowMs() < deadline)) {
    changed = truncatePass(puzzle, turns);
    changed = loopCutPass(puzzle, turns) || changed;
    changed = segmentPass(puzzle, turns, deadline) || changed;
    changed = inversePairPass(puzzle, turns) || changed;
    changed = singleRemovalPass(puzzle, turns, deadline) || changed;
  }

  bool windowChanged = true;
  while (windowChanged && (deadline == 0 || nowMs() < deadline)) {
    windowChanged = false;
    for (const size_t window : {8u, 12u, 16u}) {
      if (windowPass(puzzle, turns, window, deadline)) {
        windowChanged = true;
        break;
      }
    }
  }

  return turns;
}

} // namespace optimizer
