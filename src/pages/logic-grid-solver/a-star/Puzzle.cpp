#include "Puzzle.h"

#include "Bitboard.h"
#include "Rules.h"
#include "Types.h"

#include <algorithm>
#include <array>
#include <utility>
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

/// A lotus carries no number: the axis and the seat are the whole clue. Split
/// out of `clueValueProblem`'s branch for that one's cognitive complexity —
/// the branch-per-kind order there is what carries the meaning, so this stays
/// the lotus's block rather than growing into a general validator.
Problem lotusValueProblem(const Clue &clue) {
  using enum Problem;
  if (clue.value != 0)
    return LotusValue;
  if (!isAxis(clue.direction))
    return LotusAxis;
  if (!isSeat(clue.seat))
    return LotusSeat;
  // A diagonal axis through an edge-midpoint seat maps square centres onto
  // square CORNERS — there is no reflection on the grid, so the combination is
  // refused rather than defined. Whether the seat fits its merged cell is
  // `lotusSeats`' question, asked once the shapes are validated.
  return isDiagonalAxis(clue.direction) && !diagonalSeatValid(clue.seat)
             ? LotusDiagonalSeat
             : None;
}

/**
 * What each kind's `value` — and, for a directed one, its `direction` — may be.
 *
 * One branch per kind, and never a two-way `if area else letter`: read as a
 * letter, a dart's number would be validated against 0..25 and then indexed
 * into a 26-entry array by `buildClueTables` — and read as a dart, a lotus
 * would have its axis range-checked as a compass direction. The trailing block
 * is the DART's, exact because every other kind returns above it and
 * `cluesProblem` has already refused an unknown kind.
 */
Problem clueValueProblem(const Clue &clue, const Puzzle &puzzle,
                         const int playableCount) {
  using enum Problem;
  // Under `off-by-one` every numeric clue DISPLAYS its true count ± 1, so the
  // displayed bounds widen by one at both ends: a displayed 0 means a true 1,
  // and a displayed max-plus-one means the true maximum.
  const int slack = rules::has(puzzle.ruleMask, Rule::OffByOne) ? 1 : 0;
  if (clue.kind == kClueArea)
    return clue.value >= 1 - slack && clue.value <= playableCount + slack
               ? None
               : AreaValue;
  if (clue.kind == kClueLetter)
    return clue.value >= 0 && clue.value < kLetterCount ? None : LetterValue;
  if (clue.kind == kClueLotus)
    return lotusValueProblem(clue);
  if (clue.kind == kClueViewpoint) {
    // Its own square always counts, so the floor is one; the ceiling is the
    // whole cross — its row and its column, the own square counted once. The
    // direction is IGNORED, like an area number's: the C++ default is a real
    // direction and the TypeScript validator keeps the key off the kind, so
    // demanding a sentinel here would only trap hand-built puzzles. A count
    // too big for the rays the gaps really leave is named in `contradiction`.
    const int cross = puzzle.width + puzzle.height - 1;
    return clue.value >= 1 - slack && clue.value <= cross + slack
               ? None
               : ViewpointValue;
  }
  if (clue.kind == kClueGalaxy) {
    // Valueless like the lotus, and its direction is IGNORED like the
    // viewpoint's, for the viewpoint's reason. A seat is already refused for
    // every non-lotus kind by `cluesProblem`, so the number is all that is
    // left to ask about.
    return clue.value == 0 ? None : GalaxyValue;
  }

  if (clue.direction < 0 || clue.direction >= kDirectionCount)
    return DartDirection;
  // Bounded by the board's longest line rather than by its own line, which the
  // model has not been built yet to know. A dart too long for the line it
  // really sits on is caught by name in `contradiction`. The floor stays at
  // zero whatever the rules: a displayed minus-one is not a number the game
  // shows.
  const int longest = std::max(puzzle.width, puzzle.height) - 1;
  return clue.value >= 0 && clue.value <= longest + slack ? None : DartValue;
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
    // A seat on a kind that has none would look like part of the puzzle and
    // change nothing, so it is refused outright — the same rule the TypeScript
    // validator applies to a stray `direction`.
    if (clue.kind != kClueLotus && clue.seat != 0)
      return SeatOnWrongKind;
    if (const Problem problem = clueValueProblem(clue, puzzle, playableCount);
        problem != None)
      return problem;
  }
  return None;
}

/**
 * What a merged cell must agree with itself about: one colour across every
 * square. It matters because `applyGivens` assigns each given in turn, so a
 * cell painted half dark and half light would come back "unsolvable" with
 * nothing pointing at why.
 *
 * Deliberately NOT here: a clue count. The game's harder boards put several
 * clues on one merged cell — two darts on one domino — so each square may
 * carry its own (`ClueDuplicated` still guards the square). A combination no
 * colouring can satisfy (two different letters, disagreeing area numbers) is
 * refused by the search, not by structure: the letter groups can never
 * separate, the area bands intersect empty, and the answer is an honest
 * Unsolvable rather than a refused file.
 */
Problem shapeAgreement(const Puzzle &puzzle, const Bits &mask) {
  using enum Problem;
  const uint8_t given = puzzle.givens[slot(mask.nextSet(0))];
  for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1)) {
    if (puzzle.givens[slot(i)] != given)
      return ShapeGivensDisagree;
  }
  return None;
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

/**
 * Where a lotus's seat may sit: the centre of its own square, or — inside a
 * merged cell — the midpoint of an edge between two of the cell's squares, or
 * a corner at least THREE of whose four surrounding squares the cell owns.
 * Three rather than four on purpose: a 2x2 block's centre has four, and an
 * L-tromino's natural middle is the corner it wraps, which has three.
 *
 * Runs after `shapesProblem`, because a seat is validated against the merged
 * cell holding it — which the clue-level checks cannot see.
 */
Problem lotusSeats(const Puzzle &puzzle) {
  for (const Clue &clue : puzzle.clues) {
    if (clue.kind != kClueLotus || clue.seat == 0)
      continue;
    const auto cell =
        std::ranges::find_if(puzzle.shapes, [&clue](const auto &shape) {
          return std::ranges::contains(shape, clue.index);
        });
    // Off a merged cell there is nothing between squares to sit on.
    if (cell == puzzle.shapes.end())
      return Problem::LotusSeat;
    const int x = columnOf(clue.index);
    const int y = rowOf(clue.index);
    // Bounds first: at the board's edge `cellIndex(x + 1, y)` would wrap to
    // the next row and could falsely match a shape member there.
    const auto owns = [&cell, &puzzle](const int cx, const int cy) {
      return cx < puzzle.width && cy < puzzle.height &&
             std::ranges::contains(*cell, cellIndex(cx, cy));
    };
    if (clue.seat == 1 && !owns(x + 1, y))
      return Problem::LotusSeat;
    if (clue.seat == 2 && !owns(x, y + 1))
      return Problem::LotusSeat;
    if (clue.seat == 3) {
      const int members = 1 + static_cast<int>(owns(x + 1, y)) +
                          static_cast<int>(owns(x, y + 1)) +
                          static_cast<int>(owns(x + 1, y + 1));
      if (members < 3)
        return Problem::LotusSeat;
    }
  }
  return Problem::None;
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
  // One branch per kind, the LETTER branch last and only because every other
  // kind is named above it: a bare `else` here once meant "letter or anything
  // appended later", and a lotus falling into it would land in letter group A
  // — `groupOf` subscripted with the lotus's zero value.
  for (const Clue &clue : model.puzzle.clues) {
    model.clueAt[slot(clue.index)] = id;
    if (clue.kind == kClueArea) {
      model.areaClues.push_back(id);
    } else if (clue.kind == kClueDart) {
      model.dartClues.push_back(id);
    } else if (clue.kind == kClueLotus) {
      model.lotusClues.push_back(id);
    } else if (clue.kind == kClueViewpoint) {
      model.viewpointClues.push_back(id);
    } else if (clue.kind == kClueGalaxy) {
      model.galaxyClues.push_back(id);
    } else {
      int &group = groupOf[slot(clue.value)];
      if (group < 0) {
        group = static_cast<int>(model.letters.size());
        model.letters.emplace_back();
        model.letters.back().letter = clue.value;
      }
      LetterGroup &target = model.letters[slot(group)];
      target.cells.push_back(clue.index);
      target.mask.set(clue.index);
      model.letterAt[slot(clue.index)] = group;
    }
    id++;
  }
}

/**
 * Each dart's line, worked out once: rays depend on the board, never on the
 * colouring.
 *
 * Gaps are stepped over rather than ending the walk, and the dart's own cell is
 * taken out at the end — see `Model::darts` for why that is a correctness
 * requirement rather than a tightening.
 */
void buildDarts(Model &model) {
  for (const int id : model.dartClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    // Only a puzzle that skipped validation can fail this. Left out of `darts`
    // it constrains nothing — but it stays in `dartClues`, so `verify::check`
    // refuses every colouring and the board comes back unsolvable rather than
    // quietly solved without it.
    if (!isDirection(clue.direction))
      continue;
    const auto [stepX, stepY] = kDirectionSteps[slot(clue.direction)];
    Bits ray;
    for (int x = columnOf(clue.index) + stepX, y = rowOf(clue.index) + stepY;
         x >= 0 && x < model.width() && y >= 0 && y < model.height();
         x += stepX, y += stepY) {
      if (const int at = cellIndex(x, y); model.playable.test(at))
        ray.set(at);
    }
    model.darts.push_back({.clueId = id,
                           .index = clue.index,
                           .value = clue.value,
                           .direction = clue.direction,
                           .ray = ray.without(model.cellMask(clue.index))});
  }
}

/// Where every square lands across this lotus's axis, or -1 where the
/// reflection leaves the board — which `lotusMirrorsFit` then refuses for the
/// lotus's own cell, and `propagateLotuses` reads as an opposing null.
void fillMirror(const Model &model, Lotus &lotus) {
  lotus.mirror.fill(-1);
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (const auto [mx, my] =
              mirrorSquare(lotus.axis, lotus.cx2, lotus.cy2, x, y);
          mx >= 0 && mx < model.width() && my >= 0 && my < model.height())
        lotus.mirror[slot(cellIndex(x, y))] =
            static_cast<int16_t>(cellIndex(mx, my));
    }
  }
}

/**
 * Each lotus's reflection map, worked out once: mirrors depend on the board
 * and the seat, never on the colouring.
 *
 * The guard mirrors `buildDarts`': only a puzzle that skipped validation can
 * carry an unreadable axis or seat, and such a clue is left out of `lotuses`
 * while staying in `lotusClues` — so `verify::check` refuses every colouring
 * and the board comes back unsolvable rather than quietly solved without it.
 */
void buildLotuses(Model &model) {
  for (const int id : model.lotusClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    if (!isAxis(clue.direction) || !isSeat(clue.seat) ||
        (isDiagonalAxis(clue.direction) && !diagonalSeatValid(clue.seat)))
      continue;
    Lotus lotus;
    lotus.clueId = id;
    lotus.index = clue.index;
    lotus.axis = clue.direction;
    lotus.cx2 = seatX2(clue.index, clue.seat);
    lotus.cy2 = seatY2(clue.index, clue.seat);
    fillMirror(model, lotus);
    model.lotuses.push_back(lotus);
  }
}

/// One ray of a viewpoint's sight, from the square beyond its own outward. It
/// stops at the first gap or the board's edge — sight does not step over a
/// hole the way a dart's line does; see `Viewpoint::rays` for why that is the
/// semantics rather than a tightening.
std::vector<int16_t> sightRay(const Model &model, const int index,
                              const int direction) {
  const auto [stepX, stepY] = kDirectionSteps[slot(direction)];
  std::vector<int16_t> ray;
  for (int x = columnOf(index) + stepX, y = rowOf(index) + stepY;
       x >= 0 && x < model.width() && y >= 0 && y < model.height();
       x += stepX, y += stepY) {
    const int at = cellIndex(x, y);
    if (!model.playable.test(at))
      break;
    ray.push_back(static_cast<int16_t>(at));
  }
  return ray;
}

/**
 * Each viewpoint's four rays, worked out once: they depend on the board, never
 * on the colouring.
 *
 * The rays keep the squares of the clue's own cell — again `Viewpoint::rays`'
 * own argument. Nothing here can fail to build, so there is no
 * `buildDarts`-style net: a viewpoint carries no direction or seat that could
 * be unreadable.
 */
void buildViewpoints(Model &model) {
  for (const int id : model.viewpointClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    Viewpoint viewpoint;
    viewpoint.clueId = id;
    viewpoint.index = clue.index;
    viewpoint.value = clue.value;
    for (int direction = 0; direction < kDirectionCount; direction++)
      viewpoint.rays[slot(direction)] = sightRay(model, clue.index, direction);
    model.viewpoints.push_back(std::move(viewpoint));
  }
}

/**
 * Each galaxy's point-reflection map, worked out once: mirrors depend on the
 * board, never on the colouring. No `buildDarts`-style net, deliberately: a
 * galaxy carries no value, direction or seat that could be unreadable, so
 * every clue `structureProblem` accepts gets its geometry.
 */
/// The galaxy twin of the lotus's `fillMirror`, and an overload of it because
/// it means the same thing: the half turn is about the clue's own SQUARE, so
/// this map needs no seat and no axis. `index` must already be set.
void fillMirror(const Model &model, Galaxy &galaxy) {
  galaxy.mirror.fill(-1);
  const int gx = columnOf(galaxy.index);
  const int gy = rowOf(galaxy.index);
  for (int y = 0; y < model.height(); y++) {
    for (int x = 0; x < model.width(); x++) {
      if (const auto [mx, my] = pointMirror(gx, gy, x, y);
          mx >= 0 && mx < model.width() && my >= 0 && my < model.height())
        galaxy.mirror[slot(cellIndex(x, y))] =
            static_cast<int16_t>(cellIndex(mx, my));
    }
  }
}

void buildGalaxies(Model &model) {
  for (const int id : model.galaxyClues) {
    const Clue &clue = model.puzzle.clues[slot(id)];
    Galaxy galaxy;
    galaxy.clueId = id;
    galaxy.index = clue.index;
    fillMirror(model, galaxy);
    model.galaxies.push_back(galaxy);
  }
}

/// A dart can never name more squares than its own line holds — under
/// `off-by-one`, more than its SMALLEST candidate count: the weakest reading
/// is the one a contradiction must survive. The board-wide bound in
/// `clueValueProblem` cannot see this one: the line is shortened by every gap
/// on it and by the dart's own merged cell. A displayed 0 means a true 1
/// under the rule, so such a dart on an empty line is named here too.
Problem dartFitsLine(const Model &model) {
  const bool bad = std::ranges::any_of(model.darts, [&model](const Dart &dart) {
    const Clue &clue = model.puzzle.clues[slot(dart.clueId)];
    return model.candidatesFor(clue).lo() > dart.ray.count();
  });
  return bad ? Problem::DartExceedsLine : Problem::None;
}

/// Every square of a lotus's own cell is in its region whatever the colours,
/// so each must reflect onto a playable square — a mirror off the board or on
/// a gap makes the board unsolvable before a single cell is coloured.
Problem lotusMirrorsFit(const Model &model) {
  for (const Lotus &lotus : model.lotuses) {
    const Bits mask = model.cellMask(lotus.index);
    for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1)) {
      if (const int reflected = lotus.mirror[slot(i)];
          reflected < 0 || !model.playable.test(reflected))
        return Problem::LotusMirrorLeavesBoard;
    }
  }
  return Problem::None;
}

/// Every square of a galaxy's own cell is in its region whatever the colours,
/// so each must point-reflect onto a playable square. A PLAIN square always
/// reflects onto itself, so this can only ever fire through a merged cell —
/// which is exactly the case worth naming before a single cell is coloured.
Problem galaxyMirrorsFit(const Model &model) {
  for (const Galaxy &galaxy : model.galaxies) {
    const Bits mask = model.cellMask(galaxy.index);
    for (int i = mask.nextSet(0); i >= 0; i = mask.nextSet(i + 1)) {
      if (const int reflected = galaxy.mirror[slot(i)];
          reflected < 0 || !model.playable.test(reflected))
        return Problem::GalaxyMirrorLeavesBoard;
    }
  }
  return Problem::None;
}

/// A viewpoint can never see more squares than its four rays hold — under
/// `off-by-one`, its smallest candidate count is the one that has to fit. The
/// board-wide bound in `clueValueProblem` cannot see this one: every ray is
/// cut short by the first gap on it.
Problem viewpointsFitSight(const Model &model) {
  const bool bad = std::ranges::any_of(
      model.viewpoints, [&model](const Viewpoint &viewpoint) {
        int sight = 1;
        for (const std::vector<int16_t> &ray : viewpoint.rays)
          sight += static_cast<int>(ray.size());
        const Clue &clue = model.puzzle.clues[slot(viewpoint.clueId)];
        return model.candidatesFor(clue).lo() > sight;
      });
  return bad ? Problem::ViewpointExceedsSight : Problem::None;
}

/// An area clue can never name more cells than its own playable region holds —
/// under `off-by-one`, its smallest candidate count must still fit. A clue
/// with NO candidates at all is `areaFitsCell`'s to name: only the merged-cell
/// floor can empty the set.
Problem areaFitsRegion(const Model &model) {
  const bool bad =
      std::ranges::any_of(model.areaClues, [&model](const int id) {
        const Clue &clue = model.puzzle.clues[slot(id)];
        const ClueCandidates candidates = model.candidatesFor(clue);
        if (candidates.empty())
          return false;
        return component(clue.index, model.playable).count() <
               candidates.lo();
      });
  return bad ? Problem::AreaExceedsRegion : Problem::None;
}

/// An area clue naming fewer squares than the merged cell it sits on is asking
/// for a region smaller than one of its own members. Under `off-by-one` that
/// reads "even its LARGEST candidate is smaller" — which is exactly when the
/// candidate set comes back empty, its floor being this very cell size.
Problem areaFitsCell(const Model &model) {
  const bool bad =
      std::ranges::any_of(model.areaClues, [&model](const int id) {
        const Clue &clue = model.puzzle.clues[slot(id)];
        const ClueCandidates candidates = model.candidatesFor(clue);
        return candidates.empty() ||
               model.cellSize(clue.index) > candidates.hi();
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

/// One `Problem` and the sentence the CLI, the page and the fixture tests all
/// show for it. Paired with its enumerator by NAME rather than by position, so
/// an enumerator inserted rather than appended cannot silently shift every
/// message after it onto the wrong problem.
struct ProblemMessage {
  Problem problem;
  const char *text;
};

} // namespace

/**
 * A table rather than a `switch` — the shape matters, because the switch's
 * value was the compiler telling you about a `Problem` nobody had worded.
 * `static_assert` below is that guard, and it is not weaker: it fires on
 * exactly the omission `-Wswitch` caught (an enumerator added with no message),
 * it fires on the native build as well as the clang one, and the lookup is by
 * enumerator so the table may be written in any order.
 */
const char *describe(const Problem problem) {
  using enum Problem;
  static constexpr std::array kMessages{
      ProblemMessage{.problem = None, .text = ""},
      ProblemMessage{.problem = GridSize,
                     .text = "Grid must be between 1 and 32 on each side"},
      ProblemMessage{.problem = CellValue,
                     .text = "A cell value is outside the known colours"},
      ProblemMessage{.problem = ClueOffBoard,
                     .text = "A clue sits outside the board"},
      ProblemMessage{.problem = ClueKind,
                     .text = "A clue names an unknown kind"},
      ProblemMessage{.problem = ClueOnGap,
                     .text = "A clue sits on an unplayable cell"},
      ProblemMessage{.problem = ClueDuplicated,
                     .text = "A cell carries more than one clue"},
      ProblemMessage{.problem = AreaValue,
                     .text = "An area number is larger than the board"},
      ProblemMessage{.problem = LetterValue,
                     .text = "A letter is outside A to Z"},
      ProblemMessage{.problem = DartValue,
                     .text = "A dart's number is larger than the board's "
                             "longest line"},
      ProblemMessage{.problem = DartDirection,
                     .text = "A dart does not say which way it points"},
      ProblemMessage{.problem = DartExceedsLine,
                     .text = "A dart's number is larger than the number of "
                             "squares in its line"},
      ProblemMessage{.problem = LotusValue,
                     .text = "A symmetry symbol carries no number"},
      ProblemMessage{.problem = LotusAxis,
                     .text = "A symmetry symbol does not say which way its "
                             "axis lies"},
      ProblemMessage{.problem = LotusSeat,
                     .text = "A symmetry symbol's seat is not inside its own "
                             "merged cell"},
      ProblemMessage{.problem = LotusDiagonalSeat,
                     .text = "A diagonal symmetry on a grid-line seat has no "
                             "reflection on the square grid"},
      ProblemMessage{.problem = SeatOnWrongKind,
                     .text = "Only a symmetry symbol carries a seat"},
      ProblemMessage{.problem = LotusMirrorLeavesBoard,
                     .text = "A symmetry symbol's own cell reflects off the "
                             "board or onto an unplayable cell"},
      ProblemMessage{.problem = ShapeOffBoard,
                     .text = "A merged cell claims a square outside the board"},
      ProblemMessage{.problem = ShapeOnGap,
                     .text = "A merged cell claims an unplayable square"},
      ProblemMessage{.problem = ShapeOverlaps,
                     .text = "A square belongs to more than one merged cell"},
      ProblemMessage{.problem = ShapeTooSmall,
                     .text = "A merged cell holds fewer than two squares"},
      ProblemMessage{.problem = ShapeSplit,
                     .text = "A merged cell is not one connected shape"},
      ProblemMessage{.problem = ShapeGivensDisagree,
                     .text = "A merged cell is painted in two colours"},
      ProblemMessage{.problem = AreaExceedsRegion,
                     .text = "An area number is larger than the region it "
                             "sits in"},
      ProblemMessage{.problem = AreaSmallerThanCell,
                     .text = "An area number is smaller than the merged cell "
                             "it sits on"},
      ProblemMessage{.problem = LetterSplitByGaps,
                     .text = "Cells with the same letter are cut apart by "
                             "unplayable cells"},
      ProblemMessage{.problem = TooManyLettersForConnected,
                     .text = "Both colours are connected, so the board has at "
                             "most two regions and cannot hold three "
                             "different letters"},
      ProblemMessage{.problem = ViewpointValue,
                     .text = "A viewpoint's number must be between one and "
                             "its whole row and column"},
      ProblemMessage{.problem = ViewpointExceedsSight,
                     .text = "A viewpoint's number is larger than the number "
                             "of squares its sight can reach"},
      ProblemMessage{.problem = GalaxyValue,
                     .text = "A galaxy symbol carries no number"},
      ProblemMessage{.problem = GalaxyMirrorLeavesBoard,
                     .text = "A galaxy symbol's own cell reflects off the "
                             "board or onto an unplayable cell"},
  };
  // Every enumerator has a message. This must count against `Count` and not
  // against the last real enumerator: measured, an appended one leaves that
  // one's value alone, so the assert held and the new problem described itself
  // as "Unknown problem" — the exact omission the switch used to catch.
  static_assert(static_cast<int>(kMessages.size()) ==
                std::to_underlying(Count));
  const auto found =
      std::ranges::find(kMessages, problem, &ProblemMessage::problem);
  return found == kMessages.end() ? "Unknown problem" : found->text;
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
  if (const Problem problem = shapesProblem(puzzle); problem != None)
    return problem;
  // After the shapes: a seat is validated against the merged cell it sits in.
  return lotusSeats(puzzle);
}

int Model::areaValueAt(const int index) const {
  const int id = clueAt[slot(index)];
  if (id < 0)
    return 0;
  const Clue &clue = puzzle.clues[slot(id)];
  return clue.kind == kClueArea ? clue.value : 0;
}

ClueCandidates Model::candidatesFor(const Clue &clue) const {
  // The structural floor no true count can sit under: an area includes its own
  // cell — every square of it, on a merged one — and a viewpoint always sees
  // itself, while a dart may see nothing at all.
  int floor = 0;
  if (clue.kind == kClueArea)
    floor = cellSize(clue.index);
  else if (clue.kind == kClueViewpoint)
    floor = 1;

  ClueCandidates candidates;
  if (!hasRule(Rule::OffByOne)) {
    candidates.add(clue.value);
    return candidates;
  }
  if (clue.value - 1 >= floor)
    candidates.add(clue.value - 1);
  if (clue.value + 1 >= floor)
    candidates.add(clue.value + 1);
  return candidates;
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

namespace {

/// The playable perimeter in clockwise cyclic order, for `Model::borderCycle`
/// — see the field's comment for the lemma it feeds. Corners appear once.
void buildBorderCycle(Model &model) {
  using enum Rule;
  if (!model.hasRule(ConnectDark) || !model.hasRule(ConnectLight))
    return;
  const int w = model.puzzle.width;
  const int h = model.puzzle.height;
  const auto take = [&model](const int x, const int y) {
    if (const int index = cellIndex(x, y); model.playable.test(index))
      model.borderCycle.push_back(static_cast<int16_t>(index));
  };
  for (int x = 0; x < w; x++)
    take(x, 0);
  for (int y = 1; y < h; y++)
    take(w - 1, y);
  if (h > 1)
    for (int x = w - 2; x >= 0; x--)
      take(x, h - 1);
  if (w > 1)
    for (int y = h - 2; y >= 1; y--)
      take(0, y);
}

} // namespace

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
  // After the clue tables, which is where `dartClues` comes from, and after the
  // shapes, since a dart's line has its own cell taken out of it.
  buildDarts(model);
  buildLotuses(model);
  buildViewpoints(model);
  buildGalaxies(model);
  buildBorderCycle(model);
  return model;
}

Problem contradiction(const Model &model) {
  using enum Problem;
  if (const Problem problem = areaFitsRegion(model); problem != None)
    return problem;
  if (const Problem problem = areaFitsCell(model); problem != None)
    return problem;
  if (const Problem problem = dartFitsLine(model); problem != None)
    return problem;
  if (const Problem problem = lotusMirrorsFit(model); problem != None)
    return problem;
  if (const Problem problem = galaxyMirrorsFit(model); problem != None)
    return problem;
  if (const Problem problem = viewpointsFitSight(model); problem != None)
    return problem;
  if (const Problem problem = lettersReachable(model); problem != None)
    return problem;
  return letterCountForConnected(model);
}

} // namespace lg
