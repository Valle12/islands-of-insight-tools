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

/**
 * What a merged cell must agree with itself about: one colour across every
 * square, and at most one clue between them.
 *
 * The colour half matters because `applyGivens` assigns each given in turn, so
 * a cell painted half dark and half light would come back "unsolvable" with
 * nothing pointing at why. The clue half is what "a merged cell is ONE cell"
 * means for `oneSymbolPerArea` and for the region clue counts.
 */
Problem shapeAgreement(const Puzzle &puzzle, const Bits &mask) {
  using enum Problem;
  const uint8_t given = puzzle.givens[slot(mask.nextSet(0))];
  int clues = 0;
  for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1)) {
    if (puzzle.givens[slot(i)] != given)
      return ShapeGivensDisagree;
    clues += static_cast<int>(std::ranges::count_if(
        puzzle.clues, [i](const Clue &clue) { return clue.index == i; }));
  }
  return clues > 1 ? ShapeCluesDisagree : None;
}

Problem shapesProblem(const Puzzle &puzzle) {
  using enum Problem;
  const Bits board = boardMask(puzzle.width, puzzle.height);
  Bits used;
  for (const std::vector<int> &shape : puzzle.shapes) {
    // A cell of one square is a PLAIN cell. Rejecting the other spelling keeps
    // `representatives` and `cellMask` from having two ways to say one thing.
    if (shape.size() < 2)
      return ShapeTooSmall;
    Bits mask;
    for (const int index : shape) {
      if (index < 0 || index >= kMaxCells || !board.test(index))
        return ShapeOffBoard;
      if (!isPlayable(puzzle.givens[slot(index)]))
        return ShapeOnGap;
      // Also catches one square listed twice inside a single shape.
      if (used.test(index))
        return ShapeOverlaps;
      used.set(index);
      mask.set(index);
    }
    if (component(shape.front(), mask) != mask)
      return ShapeSplit;
    if (const Problem problem = shapeAgreement(puzzle, mask); problem != None)
      return problem;
  }
  return None;
}

/// Where this square's CELL already appears in the clause being built, or -1.
int existingLiteral(const Model &model, const Clause &clause, const int index) {
  const int shape = model.shapeAt[slot(index)];
  for (int i = 0; i < clause.count; i++) {
    if (const int held = clause.cells[slot(i)];
        held == index || (shape >= 0 && model.shapeAt[slot(held)] == shape))
      return i;
  }
  return -1;
}

/// Lays one pattern over the anchor (x, y). False when it falls off the board
/// or across a gap — in either case that arrangement simply cannot occur, so
/// there is nothing to forbid.
bool instantiate(const Model &model, const rules::Pattern &pattern, const int x,
                 const int y, Clause &out) {
  const Puzzle &puzzle = model.puzzle;
  out.count = 0;
  for (int i = 0; i < pattern.count; i++) {
    const auto &[dx, dy, color] = pattern.cells[slot(i)];
    const int cx = x + dx;
    const int cy = y + dy;
    if (cx < 0 || cx >= puzzle.width || cy < 0 || cy >= puzzle.height)
      return false;
    const int index = cellIndex(cx, cy);
    if (!model.playable.test(index))
      return false;
    // A merged cell takes ONE colour, so two of its squares under one pattern
    // are one literal. Asking for the same colour twice says nothing new — and
    // LEAVING the duplicate in would stop the clause ever firing as a unit,
    // because `propagateClause` reads the second copy as a second free cell.
    // Asking for both colours describes an arrangement that cannot occur, and
    // like one running off the board there is then nothing to forbid.
    if (const int at = existingLiteral(model, out, index); at >= 0) {
      if (out.colors[slot(at)] != color)
        return false;
      continue;
    }
    out.cells[slot(out.count)] = index;
    out.colors[slot(out.count)] = color;
    out.count++;
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
      if (Clause clause; instantiate(model, pattern, x, y, clause))
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

/**
 * The merged cells as masks, plus the square-to-shape map and the one square
 * that stands for each cell.
 *
 * Runs FIRST in `buildModel`: `shapeAt` is value-initialised to zeroes, which
 * would read as "every square is in shape 0", and clause construction consults
 * it.
 */
void buildShapes(Model &model) {
  model.shapeAt.fill(-1);
  model.representatives = model.playable;
  model.hasShapes = !model.puzzle.shapes.empty();

  int id = 0;
  for (const std::vector<int> &shape : model.puzzle.shapes) {
    Bits mask;
    for (const int index : shape) {
      mask.set(index);
      model.shapeAt[slot(index)] = static_cast<int16_t>(id);
    }
    // Every square of a merged cell but its lowest stands for nothing: the
    // search enumerates cells, and one square has to speak for the rest.
    model.representatives = model.representatives.without(mask);
    if (const int first = mask.nextSet(0); first >= 0)
      model.representatives.set(first);
    model.shapes.push_back(mask);
    id++;
  }

  // A shape on a gap is rejected by `structureProblem`, but `buildModel` is
  // also reachable from tests that never validate, and a representative off the
  // playable set would make `cellCount` count a cell nothing can colour.
  model.representatives &= model.playable;
  model.cellCount = model.representatives.count();
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

/// An area clue naming fewer squares than the merged cell it sits on is asking
/// for a region smaller than one of its own members.
Problem areaFitsCell(const Model &model) {
  const bool bad =
      std::ranges::any_of(model.areaClues, [&model](const int id) {
        const Clue &clue = model.puzzle.clues[slot(id)];
        return model.cellSize(clue.index) > clue.value;
      });
  return bad ? Problem::AreaSmallerThanCell : Problem::None;
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
  case ShapeOffBoard:
    return "A merged cell claims a square outside the board";
  case ShapeOnGap:
    return "A merged cell claims an unplayable square";
  case ShapeOverlaps:
    return "A square belongs to more than one merged cell";
  case ShapeTooSmall:
    return "A merged cell holds fewer than two squares";
  case ShapeSplit:
    return "A merged cell is not one connected shape";
  case ShapeCluesDisagree:
    return "A merged cell carries more than one clue";
  case ShapeGivensDisagree:
    return "A merged cell is painted in two colours";
  case AreaExceedsRegion:
    return "An area number is larger than the region it sits in";
  case AreaSmallerThanCell:
    return "An area number is smaller than the merged cell it sits on";
  case LetterSplitByGaps:
    return "Cells with the same letter are cut apart by unplayable cells";
  case TooManyLettersForConnected:
    return "Both colours are connected, so the board has at most two regions "
           "and cannot hold three different letters";
  }
  return "Unknown problem";
}

Problem structureProblem(const Puzzle &puzzle) {
  using enum Problem;
  if (puzzle.width < 1 || puzzle.width > kMaxSide || puzzle.height < 1 ||
      puzzle.height > kMaxSide)
    return GridSize;
  if (const Problem problem = cellValueProblem(puzzle); problem != None)
    return problem;
  if (const Problem problem = cluesProblem(puzzle); problem != None)
    return problem;
  return shapesProblem(puzzle);
}

int Model::areaValueAt(const int index) const {
  const int id = clueAt[slot(index)];
  if (id < 0)
    return 0;
  const Clue &clue = puzzle.clues[slot(id)];
  return clue.kind == kClueArea ? clue.value : 0;
}

Bits Model::cellMask(const int index) const {
  const int shape = shapeAt[slot(index)];
  return shape < 0 ? oneCell(index) : shapes[slot(shape)];
}

int Model::representativeOf(const int index) const {
  const int shape = shapeAt[slot(index)];
  return shape < 0 ? index : shapes[slot(shape)].nextSet(0);
}

int Model::cellSize(const int index) const {
  const int shape = shapeAt[slot(index)];
  return shape < 0 ? 1 : shapes[slot(shape)].count();
}

Model buildModel(const Puzzle &puzzle) {
  Model model;
  model.puzzle = puzzle;
  model.board = boardMask(puzzle.width, puzzle.height);
  model.playable = playableMask(puzzle);
  model.playableCount = model.playable.count();
  buildShapes(model);
  buildClauses(model);
  buildClauseIndex(model);
  buildClueTables(model);
  return model;
}

Problem contradiction(const Model &model) {
  using enum Problem;
  if (const Problem problem = areaFitsRegion(model); problem != None)
    return problem;
  if (const Problem problem = areaFitsCell(model); problem != None)
    return problem;
  if (const Problem problem = lettersReachable(model); problem != None)
    return problem;
  return letterCountForConnected(model);
}

} // namespace lg
