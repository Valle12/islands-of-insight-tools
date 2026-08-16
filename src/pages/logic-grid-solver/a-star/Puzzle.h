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
  /**
   * The sized rule instances — the config's `areas` and `runs` keys: every
   * region of `color` has exactly `value` cells, and no straight run of
   * `value` cells of `color`. Conjunctive: several instances per family and
   * colour all hold at once, and both areas 2 AND 3 on one colour is not a
   * contradiction — it is satisfied exactly when the colour is absent, every
   * one of its zero regions being both sizes.
   *
   * Always in canonical order (dark before light, values ascending) with no
   * duplicates. Intake REFUSES anything else rather than sorting, and the
   * asymmetry with the page's validator — which accepts any order and
   * canonicalises on output — is deliberate: this side reads only committed
   * fixtures and already-validated payloads, so a disordered list means a
   * hand-edited file, and repair would hide that.
   */
  std::vector<rules::SizedRule> areas;
  std::vector<rules::SizedRule> runs;
  /**
   * The merged cells: each one the squares it fuses, in the order they were
   * entered. Empty on a plain board, and the config's `shapes` key is then
   * omitted entirely.
   *
   * A merged cell is the game's irregular tile — any connected polyomino. It
   * takes ONE colour for all of its squares and carries at most one clue, but
   * it still contributes its full SQUARE count to an area number and is
   * adjacent to everything any of its squares touches.
   *
   * Indices rather than a `Bits` here, deliberately: this is the boundary
   * object, so the entry order has to survive `fixtureio::save`, and "two
   * shapes claim the same square" has to stay REJECTABLE rather than be
   * silently absorbed by a set union.
   */
  std::vector<std::vector<int>> shapes;

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

/// One dart's geometry, worked out once because it never changes: rays are a
/// property of the board, not of the colouring. See `Model::darts`.
struct Dart {
  int clueId = 0;
  int index = 0;
  int value = 0;
  int direction = kDirUp;
  Bits ray;
};

/// One lotus's geometry, worked out once like a dart's ray: the axis point in
/// DOUBLED coordinates — a seat on a grid line is then still an integer — and
/// where every square of the board reflects to. See `Model::lotuses`.
struct Lotus {
  int clueId = 0;
  int index = 0;
  int axis = kAxisHorizontal;
  int cx2 = 0;
  int cy2 = 0;
  /// The strided index each square reflects to, or -1 for off the board.
  std::array<int16_t, kMaxCells> mirror{};
};

/// One viewpoint's geometry, worked out once like a dart's ray: where it sits,
/// its count, and the squares of each of its four rays in WALKING order.
struct Viewpoint {
  int clueId = 0;
  int index = 0;
  int value = 0;
  /**
   * The squares outward per direction, truncated at the first gap or the edge
   * — sight stops at a hole in the board, where a dart's line steps over one.
   *
   * Ordered vectors rather than a `Bits`, because the propagator reasons about
   * LEADING runs and a set cannot say which square comes first. And unlike a
   * dart's ray these KEEP the squares of the clue's own cell: a viewpoint
   * counts its own colour, so an own-cell square on a ray is simply a square
   * already known to hold what is being counted — where the dart counts the
   * opposite colour, which its own cell can never be.
   */
  std::array<std::vector<int16_t>, kDirectionCount> rays;
};

/// One galaxy's geometry, worked out once like a lotus's mirrors: where every
/// square of the board lands under a HALF TURN about the galaxy's own square.
/// Plain square coordinates — a galaxy has no seat, so no doubled scheme.
/// See `Model::galaxies`.
struct Galaxy {
  int clueId = 0;
  int index = 0;
  /// The strided index each square reflects to, or -1 for off the board.
  std::array<int16_t, kMaxCells> mirror{};
};

/**
 * The TRUE counts a numeric clue's displayed value allows, as an exact SET of
 * at most two values.
 *
 * With the rules as they stand that is the displayed value alone. Under
 * `off-by-one` it is the displayed value ± 1 — never the value itself —
 * filtered against the kind's structural floor, which is how a displayed 0
 * means exactly 1 and a displayed area 1 exactly 2. Everything reading it must
 * treat it as the SET it is, never as the interval between its ends: a count
 * equal to the displayed value sits between the two candidates and satisfies
 * neither.
 */
struct ClueCandidates {
  std::array<int, 2> values{};
  int count = 0;

  [[nodiscard]] bool empty() const { return count == 0; }
  [[nodiscard]] int lo() const { return values[0]; }
  [[nodiscard]] int hi() const { return values[slot(count - 1)]; }

  void add(const int value) {
    values[slot(count)] = value;
    count++;
  }

  /// The candidates a count between `atLeast` and `atMost` could still reach —
  /// asked PER CANDIDATE, which is what makes the middle gap real: with
  /// everything decided at the displayed value itself, both candidates fail
  /// here while an interval test would pass.
  [[nodiscard]] ClueCandidates feasible(const int atLeast,
                                        const int atMost) const {
    ClueCandidates kept;
    for (int i = 0; i < count; i++) {
      if (const int value = values[slot(i)];
          value >= atLeast && value <= atMost)
        kept.add(value);
    }
    return kept;
  }
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
  /**
   * The four clue families whose geometry has to be WALKED — a dart's ray, a
   * lotus's mirror, a viewpoint's sight lines, a galaxy's half turn — each as
   * the clue indices in clue order plus the precomputed geometry itself.
   *
   * One nested struct rather than eight sibling fields: `Model` carried 25
   * (cpp:S1820), and these eight are the ones that genuinely travel together —
   * every one of them is built by the same pass and read by the same walk.
   */
  struct Walked {
    /// ...and of every dart, which `darts` below carries the geometry for.
    std::vector<int> dartClues;
    /// ...and of every lotus, which `lotuses` below carries the mirrors for.
    std::vector<int> lotusClues;
    /// ...and of every viewpoint, which `viewpoints` below carries the rays for.
    std::vector<int> viewpointClues;
    /// ...and of every galaxy. Its geometry is one point reflection about its
    /// own square, precomputed in `galaxies` below.
    std::vector<int> galaxyClues;

    /**
     * Every dart's line, precomputed: the playable squares from its own square to
     * the edge of the board in the direction it points, MINUS the squares of its
     * own cell.
     *
     * Gaps are stepped over rather than stopping the line — a dart sees past a
     * hole — so this is not a run and cannot be found by shifting until something
     * blocks.
     *
     * Taking the dart's own cell out is a correctness requirement, not a
     * tightening. Every square of that cell holds the dart's own colour, so none
     * of them can ever be the colour it counts; left in, the "the line is exactly
     * full" branch would assign the OTHER colour to one of them, `Domains::
     * exclude` would fan that over the whole cell, and the dart would refute
     * itself. Out, `ray.count()` is also exactly the largest number the dart
     * could legally carry.
     */
    std::vector<Dart> darts;

    /**
     * Every lotus's reflection map, precomputed like a dart's ray: mirrors are a
     * property of the board and its seat, never of the colouring. A clue whose
     * axis or seat cannot be read stays in `lotusClues` but not here, so
     * `verify::check` refuses every colouring rather than quietly solving the
     * board without it — the same net `buildDarts` has.
     */
    std::vector<Lotus> lotuses;

    /**
     * Every viewpoint's four rays, precomputed the same way. No net here,
     * deliberately: a viewpoint carries no direction or seat that could be
     * unreadable, so every clue `structureProblem` accepts gets its geometry.
     */
    std::vector<Viewpoint> viewpoints;

    /**
     * Every galaxy's point-reflection map, precomputed like a lotus's mirrors.
     * No net either, for the viewpoint's reason: a galaxy carries no value,
     * direction or seat that could be unreadable, so every clue
     * `structureProblem` accepts gets its geometry.
     */
    std::vector<Galaxy> galaxies;
  };
  Walked walked;
  std::vector<LetterGroup> letters;
  /// Index into `letters` for each cell, or -1.
  std::vector<int> letterAt;


  /**
   * The playable squares of the board's outer perimeter in cyclic order —
   * built only when BOTH connect rules are on, and empty otherwise, which is
   * the switch `borderArcs` in Propagate.cpp runs on.
   *
   * The two-arc lemma it exists for: with dark and light each one region, the
   * decided colours around this cycle can hold no D,L,D,L subsequence. Four
   * such cells would force a dark path and a light path between interleaved
   * endpoints on the outer face of a planar graph — the paths would have to
   * share a cell. Gaps are simply skipped: the endpoints stay on the outer
   * face, so the argument never needed the perimeter to be contiguous.
   */
  std::vector<int16_t> borderCycle;

  /**
   * The merged cells as masks, in `puzzle.shapes` order, and which one each
   * square belongs to (-1 where the square is its own cell).
   *
   * The whole shape layer lives on the VARIABLE side and nowhere else: `Bits`
   * and `Colors` stay square-granular, and `Domains::exclude` fans out over
   * `cellMask` so that every square of a merged cell holds an identical domain
   * at every point of the search. Everything downstream reads those square sets
   * unchanged and comes out right because of it — `flood`/`component` can never
   * split a merged cell across two regions, `border`/`grown` give "adjacent to
   * whatever any of its squares touches", and `count` counts squares, which is
   * what an area number wants.
   *
   * `shapeAt` is a `std::array` rather than a `std::vector` like the tables
   * above it because it is read inside `Domains::exclude`, the hottest function
   * in the solver: inline in the Model it is one load rather than two. It is
   * filled by `buildShapes`, which runs FIRST in `buildModel` — value
   * initialisation would leave it reading as "every square is in shape 0".
   */
  std::vector<Bits> shapes;
  std::array<int16_t, kMaxCells> shapeAt{};
  /**
   * One square per CELL: every plain playable square, plus the lowest-indexed
   * square of each merged cell. This is the variable set anything ENUMERATING
   * choices has to walk — the search's guess order, the look-ahead's candidate
   * list, the underclued mode's refutation list, brute force's free set.
   */
  Bits representatives;
  int cellCount = 0;
  bool hasShapes = false;

  [[nodiscard]] int width() const { return puzzle.width; }
  [[nodiscard]] int height() const { return puzzle.height; }
  [[nodiscard]] bool hasRule(const rules::Rule rule) const {
    return rules::has(puzzle.ruleMask, rule);
  }
  /// The area clue's value for a cell carrying one, 0 otherwise.
  [[nodiscard]] int areaValueAt(int index) const;
  /// The true counts this NUMERIC clue's displayed value allows — see
  /// `ClueCandidates`. Only meaningful for the number-carrying kinds: an area
  /// number, a dart or a viewpoint. A letter's value is not a count, and the
  /// valueless kinds have nothing to ask about.
  [[nodiscard]] ClueCandidates candidatesFor(const Clue &clue) const;

  /// Every square this square's CELL occupies — just itself for a plain
  /// square, the whole polyomino for a merged one.
  [[nodiscard]] Bits cellMask(int index) const;
  /// The square that stands for this square's cell.
  [[nodiscard]] int representativeOf(int index) const;
  /// How many squares this square's cell occupies, which is what it counts for
  /// towards an area number.
  [[nodiscard]] int cellSize(int index) const;
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
  DartValue,
  DartDirection,
  DartExceedsLine,
  LotusValue,
  LotusAxis,
  LotusSeat,
  LotusDiagonalSeat,
  SeatOnWrongKind,
  LotusMirrorLeavesBoard,
  ShapeOffBoard,
  ShapeOnGap,
  ShapeOverlaps,
  ShapeTooSmall,
  ShapeSplit,
  ShapeGivensDisagree,
  AreaExceedsRegion,
  AreaSmallerThanCell,
  LetterSplitByGaps,
  TooManyLettersForConnected,
  ViewpointValue,
  ViewpointExceedsSight,
  GalaxyValue,
  GalaxyMirrorLeavesBoard,
  /// Not a problem — the count, which `describe`'s table asserts itself
  /// against so an enumerator appended above without a message stops
  /// compiling. Keep it last, and never return it.
  Count,
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
