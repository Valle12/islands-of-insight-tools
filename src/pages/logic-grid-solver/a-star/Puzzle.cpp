#include "Puzzle.h"

#include "Bitboard.h"
#include "Rules.h"
#include "Types.h"

#include <algorithm>
#include <array>
#include <vector>

namespace lg {
namespace {

using rules::Rule;

/// Every on-board cell that can take a colour at all.
Bits playableMask(const Puzzle &puzzle) {
  Bits out;
  for (int y = 0; y < puzzle.height; y++) {
    for (int x = 0; x < puzzle.width; x++) {
      if (const int index = cellIndex(x, y);
          isPlayable(puzzle.givens[slot(index)]))
        out.set(index);
    }
  }
  return out;
}

Problem cellValueProblem(const Puzzle &puzzle) {
  for (int y = 0; y < puzzle.height; y++) {
    for (int x = 0; x < puzzle.width; x++) {
      if (puzzle.givens[slot(cellIndex(x, y))] >= kColorLimit)
        return Problem::CellValue;
    }
  }
  return Problem::None;
}

Problem clueValueProblem(const Clue &clue, const int playableCount) {
  using enum Problem;
  if (clue.kind == kClueArea)
    return clue.value >= 1 && clue.value <= playableCount ? None : AreaValue;
  return clue.value >= 0 && clue.value < kLetterCount ? None : LetterValue;
}

Problem cluesProblem(const Puzzle &puzzle) {
  using enum Problem;
  const Bits board = boardMask(puzzle.width, puzzle.height);
  const int playableCount = playableMask(puzzle).count();
  Bits seen;
  for (const Clue &clue : puzzle.clues) {
    if (clue.index < 0 || clue.index >= kMaxCells || !board.test(clue.index))
      return ClueOffBoard;
    if (clue.kind >= kClueKindCount)
      return ClueKind;
    if (puzzle.givens[slot(clue.index)] == kUnplayable)
      return ClueOnGap;
    if (seen.test(clue.index))
      return ClueDuplicated;
    seen.set(clue.index);
    if (const Problem problem = clueValueProblem(clue, playableCount);
        problem != None)
      return problem;
  }
  return None;
}

/// Lays one pattern over the anchor (x, y). False when it falls off the board
/// or across a gap — in either case that arrangement simply cannot occur, so
/// there is nothing to forbid.
bool instantiate(const Puzzle &puzzle, const Bits &playable,
                 const rules::Pattern &pattern, const int x, const int y,
                 Clause &out) {
  out.count = pattern.count;
  for (int i = 0; i < pattern.count; i++) {
    const auto &[dx, dy, color] = pattern.cells[slot(i)];
    const int cx = x + dx;
    const int cy = y + dy;
    if (cx < 0 || cx >= puzzle.width || cy < 0 || cy >= puzzle.height)
      return false;
    const int index = cellIndex(cx, cy);
    if (!playable.test(index))
      return false;
    out.cells[slot(i)] = index;
    out.colors[slot(i)] = color;
  }
  return true;
}

/// Every placement of one pattern that lands wholly on playable cells. The
/// ones that fall off the board or across a gap are dropped rather than
/// clamped: that arrangement simply cannot occur, so there is nothing to
/// forbid. It is also why this table may only ever hold CONTAINMENT rules.
void addClausesFor(Model &model, const rules::Pattern &pattern) {
  for (int y = 0; y < model.puzzle.height; y++) {
    for (int x = 0; x < model.puzzle.width; x++) {
      if (Clause clause;
          instantiate(model.puzzle, model.playable, pattern, x, y, clause))
        model.clauses.push_back(clause);
    }
  }
}

void buildClauses(Model &model) {
  for (const rules::Patterns patterns =
           rules::patternsFor(model.puzzle.ruleMask);
       const rules::Pattern &pattern : patterns)
    addClausesFor(model, pattern);
}

/// The per-cell occurrence lists, as a counting sort into a CSR.
void buildClauseIndex(Model &model) {
  model.clauseStart.assign(kMaxCells + 1, 0);
  for (const Clause &clause : model.clauses) {
    for (int i = 0; i < clause.count; i++)
      model.clauseStart[slot(clause.cells[slot(i)] + 1)]++;
  }
  for (int i = 0; i < kMaxCells; i++)
    model.clauseStart[slot(i + 1)] += model.clauseStart[slot(i)];

  std::vector<int> cursor = model.clauseStart;
  model.clauseIndex.assign(slot(model.clauseStart[slot(kMaxCells)]), 0);
  int id = 0;
  for (const Clause &clause : model.clauses) {
    for (int i = 0; i < clause.count; i++)
      model.clauseIndex[slot(cursor[slot(clause.cells[slot(i)])]++)] = id;
    id++;
  }
}

void buildClueTables(Model &model) {
  model.clueAt.assign(kMaxCells, -1);
  model.letterAt.assign(kMaxCells, -1);
  std::array<int, kLetterCount> groupOf{};
  groupOf.fill(-1);

  int id = 0;
  for (const auto &[index, kind, value] : model.puzzle.clues) {
    model.clueAt[slot(index)] = id;
    if (kind == kClueArea) {
      model.areaClues.push_back(id);
    } else {
      int &group = groupOf[slot(value)];
      if (group < 0) {
        group = static_cast<int>(model.letters.size());
        model.letters.emplace_back();
        model.letters.back().letter = value;
      }
      LetterGroup &target = model.letters[slot(group)];
      target.cells.push_back(index);
      target.mask.set(index);
      model.letterAt[slot(index)] = group;
    }
    id++;
  }
}

/// An area clue can never name more cells than its own playable region holds.
Problem areaFitsRegion(const Model &model) {
  const bool bad =
      std::ranges::any_of(model.areaClues, [&model](const int id) {
        const Clue &clue = model.puzzle.clues[slot(id)];
        return component(clue.index, model.playable).count() < clue.value;
      });
  return bad ? Problem::AreaExceedsRegion : Problem::None;
}

/// Every cell of one letter shares a region, so the gaps must not have cut
/// them apart before a colour is even chosen.
Problem lettersReachable(const Model &model) {
  const bool bad =
      std::ranges::any_of(model.letters, [&model](const LetterGroup &group) {
        const Bits reach = component(group.cells.front(), model.playable);
        return !group.mask.isSubsetOf(reach);
      });
  return bad ? Problem::LetterSplitByGaps : Problem::None;
}

/**
 * With both colours connected there are at most two regions on the whole
 * board — one dark, one light — and a region holds at most one letter. A third
 * letter therefore has nowhere to go.
 */
Problem letterCountForConnected(const Model &model) {
  using enum Problem;
  if (!model.hasRule(Rule::ConnectDark) || !model.hasRule(Rule::ConnectLight))
    return None;
  return model.letters.size() > 2 ? TooManyLettersForConnected : None;
}

} // namespace

const char *describe(const Problem problem) {
  using enum Problem;
  switch (problem) {
  case None:
    return "";
  case GridSize:
    return "Grid must be between 1 and 32 on each side";
  case CellValue:
    return "A cell value is outside the known colours";
  case ClueOffBoard:
    return "A clue sits outside the board";
  case ClueKind:
    return "A clue names an unknown kind";
  case ClueOnGap:
    return "A clue sits on an unplayable cell";
  case ClueDuplicated:
    return "A cell carries more than one clue";
  case AreaValue:
    return "An area number is larger than the board";
  case LetterValue:
    return "A letter is outside A to Z";
  case AreaExceedsRegion:
    return "An area number is larger than the region it sits in";
  case LetterSplitByGaps:
    return "Cells with the same letter are cut apart by unplayable cells";
  case TooManyLettersForConnected:
    return "Both colours are connected, so the board has at most two regions "
           "and cannot hold three different letters";
  }
  return "Unknown problem";
}

Problem structureProblem(const Puzzle &puzzle) {
  if (puzzle.width < 1 || puzzle.width > kMaxSide || puzzle.height < 1 ||
      puzzle.height > kMaxSide)
    return Problem::GridSize;
  if (const Problem problem = cellValueProblem(puzzle);
      problem != Problem::None)
    return problem;
  return cluesProblem(puzzle);
}

int Model::areaValueAt(const int index) const {
  const int id = clueAt[slot(index)];
  if (id < 0)
    return 0;
  const Clue &clue = puzzle.clues[slot(id)];
  return clue.kind == kClueArea ? clue.value : 0;
}

Model buildModel(const Puzzle &puzzle) {
  Model model;
  model.puzzle = puzzle;
  model.board = boardMask(puzzle.width, puzzle.height);
  model.playable = playableMask(puzzle);
  model.playableCount = model.playable.count();
  buildClauses(model);
  buildClauseIndex(model);
  buildClueTables(model);
  return model;
}

Problem contradiction(const Model &model) {
  if (const Problem problem = areaFitsRegion(model); problem != Problem::None)
    return problem;
  if (const Problem problem = lettersReachable(model);
      problem != Problem::None)
    return problem;
  return letterCountForConnected(model);
}

} // namespace lg
