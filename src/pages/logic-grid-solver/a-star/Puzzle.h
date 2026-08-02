#pragma once

#include "Bitboard.h"
#include "Rules.h"
#include "Types.h"

#include <array>
#include <cstdint>
#include <vector>

// A puzzle as it arrives, and the compiled form everything downstream reads.
//
// The split matters: `Puzzle` is exactly what crossed a boundary — the wasm
// bridge, or a fixture file — and is validated on the way in; `Model` is the
// derived structure the propagators walk, built once per solve. Nothing in the
// search rebuilds any of it, and nothing in the search mutates it.
namespace lg {

/// A colouring, one entry per cell of the strided space. kUnknown where no
/// colour has been decided, kUnplayable for the board's gaps.
using Colors = std::array<uint8_t, kMaxCells>;

/// A puzzle as entered.
struct Puzzle {
  int width = 0;
  int height = 0;
  /**
   * The colour layer as the player left it, in the strided index space:
   * kUnknown where the colour is still to be found, kDark/kLight for a cell
   * already painted, kUnplayable for a gap in the board.
   *
   * A painted cell is a GIVEN — the answer has to keep it. That is what lets a
   * half-finished board be handed back for checking, and it is why a board
   * painted wrong comes back unsolvable rather than quietly re-solved.
   */
  Colors givens{};
  Clues clues;
  rules::RuleMask ruleMask = 0;

  [[nodiscard]] uint8_t at(const int x, const int y) const {
    return givens[slot(cellIndex(x, y))];
  }
};

/**
 * A forbidden arrangement laid over this board: the colouring is illegal if
 * every listed cell holds its listed colour.
 *
 * Read the other way round it is a clause — "at least one of these cells holds
 * the other colour" — which is what makes unit propagation over it textbook
 * sound. Nothing else in the solver is allowed to be this cheap about
 * soundness, and nothing else needs to be.
 */
struct Clause {
  std::array<int, rules::kMaxPatternCells> cells{};
  std::array<uint8_t, rules::kMaxPatternCells> colors{};
  int count = 0;
};

/// Every clue carrying one letter. All of them share a region, so they share a
/// colour too — which is the whole of "letter colour deduction".
struct LetterGroup {
  int letter = 0;
  std::vector<int> cells;
  /// Every cell of the group at once, for the connectivity propagator.
  Bits mask;
};

/// The compiled puzzle.
struct Model {
  Puzzle puzzle;
  /// Every index the board occupies, and the subset that can take a colour.
  Bits board;
  Bits playable;
  int playableCount = 0;

  std::vector<Clause> clauses;
  /**
   * The clauses mentioning each cell, as a CSR: the ids for cell `i` span
   * `[clauseStart[i], clauseStart[i + 1])` of `clauseIndex`.
   *
   * Plain occurrence lists with a rescan, deliberately, rather than the two
   * watched literals a SAT solver would use. Every clause here holds at most
   * `kMaxPatternCells` literals, so a rescan is a handful of domain tests, and
   * an occurrence list is immutable — there is no watch to move and nothing to
   * undo on backtrack.
   * Watches visit fewer clauses and are the upgrade if profiling ever asks for
   * it; they are not worth their failure modes at this size.
   */
  std::vector<int> clauseIndex;
  std::vector<int> clauseStart;

  /// Index into `puzzle.clues` for each cell, or -1 where there is no clue.
  std::vector<int> clueAt;
  /// Indices into `puzzle.clues` of every area clue, in clue order.
  std::vector<int> areaClues;
  std::vector<LetterGroup> letters;
  /// Index into `letters` for each cell, or -1.
  std::vector<int> letterAt;

  [[nodiscard]] int width() const { return puzzle.width; }
  [[nodiscard]] int height() const { return puzzle.height; }
  [[nodiscard]] bool hasRule(const rules::Rule rule) const {
    return rules::has(puzzle.ruleMask, rule);
  }
  /// The area clue's value for a cell carrying one, 0 otherwise.
  [[nodiscard]] int areaValueAt(int index) const;
};

/// Why a puzzle cannot be read or cannot possibly be solved.
enum class Problem : uint8_t {
  None = 0,
  GridSize,
  CellValue,
  ClueOffBoard,
  ClueKind,
  ClueOnGap,
  ClueDuplicated,
  AreaValue,
  LetterValue,
  AreaExceedsRegion,
  LetterSplitByGaps,
  TooManyLettersForConnected,
};

const char *describe(Problem problem);

/**
 * Whether this puzzle is well formed, ignoring whether it can be solved.
 *
 * The TypeScript validator checks the same things, and this deliberately does
 * not trust it: a `Puzzle` also arrives from a fixture file and from the CLI.
 */
Problem structureProblem(const Puzzle &puzzle);

Model buildModel(const Puzzle &puzzle);

/**
 * A reason this puzzle can have no solution at all, found without searching,
 * or `Problem::None` when none of the cheap checks fires.
 *
 * A convenience, never a substitute for the search: propagation at the root
 * catches far more, and answers "unsolvable" with no name attached. The point
 * of the named ones is that every puzzle in the game is solvable, so an
 * unsolvable board means the player mis-entered it — and naming which two
 * things cannot hold together is worth more than saying nothing. Adding a
 * check is one function and one line in `contradiction`.
 */
Problem contradiction(const Model &model);

} // namespace lg
