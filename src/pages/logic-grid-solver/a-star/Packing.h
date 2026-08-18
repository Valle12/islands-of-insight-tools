#pragma once

#include "Puzzle.h"
#include "Search.h"

// A region PACKER for boards whose color is decided region by region.
//
// A board whose every clue names a REGION rather than a cell — an area number,
// or a letter saying "these cells share one region and no other letter's do" —
// and whose clue cells the puzzle already paints, asks one question and only
// one: can regions of exactly the demanded sizes be laid out so that no two of
// the same color touch? What is left over is the other color, and where the
// board says nothing more about it that is the answer rather than an
// approximation.
//
// The DFS cannot see that. It decides one cell at a time and a region clue says
// nothing until its whole region is closed, so on the captured 11x11 with
// eleven area clues (two of them 24 and 26) it reaches 21 million nodes with 13
// of 121 cells decided and no refutations at all, at 120 s just as at 20 s. The
// sweep declines it and the router does not model it.
//
// The packer answers it in well under a second, by never enumerating the big
// regions at all:
//
//   - Demands small enough to enumerate whole are tried as SHAPES, compact ones
//     first. What the big regions need is free space, and the compact shape is
//     the one that spends least of it.
//   - The big ones are decided by a LOOKAHEAD that grows them a cell at a time
//     and gives up on a branch the moment another big clue's cell can no longer
//     reach its own size. That test only ever gets harder as more regions land,
//     so running it on a PARTIAL placement is sound — which is what lets a bad
//     prefix be cut before the small regions are finished.
//
// The second board class it takes is the 12x12 pentomino board: `areas` fixes
// every dark region at five, eight letter pairs each pin one of them, six area
// numbers ask for the rest, and `distinct-shapes-dark` says no two are
// congruent — so the twelve regions are the twelve free pentominoes, one each.
// There the demands come from the LETTER GROUPS as much as from the numbers,
// the shape rule is a filter on what may be placed next, and `connect-light`
// is a test the finished packing has to pass; the search is the same one.
//
// Like the router it is a CONSTRUCTION: it answers `Solved` or `Unsolved` and
// never `Unsolvable`, because failing to build a packing proves nothing about
// whether one exists. And like the router, every coloring it builds goes
// through `verify::check` before it is returned, so a construction that misread
// the board yields nothing rather than something wrong.
namespace lg::packing {

/// A demand bigger than this is never enumerated as whole shapes; it is grown
/// by the lookahead instead. Eight is where the shape count per clue is still
/// in the thousands.
inline constexpr int kMaxShapeCells = 8;

/// A demand whose shape list would pass this is not worth enumerating, so the
/// board is declined rather than paid for.
inline constexpr int kMaxShapesPerClue = 200000;

/// How many states that enumeration may keep PENDING. Not the same bound as
/// the one above and not implied by it: that caps what the walk KEEPS, while
/// every state it expands queues one successor per border cell, so the pending
/// stack outgrows it long before it trips.
inline constexpr int kMaxPendingShapes = 200000;

/**
 * Whether this board is one the packer can usefully try.
 *
 * The gate is about not wasting budget, NOT about correctness — the witness is
 * verified either way. It asks for exactly the shape the construction assumes:
 * every clue an area number or a letter, no merged cells (it packs squares),
 * every clue cell painted by the puzzle in ONE color, and no rule beyond the
 * two connect rules and a shape rule on that same color. A letter demand has
 * no size of its own, so a board carrying letters also needs the single
 * `areas` instance that gives every region of the color one.
 *
 * Cells the puzzle paints that carry no clue are allowed and mean what they
 * say: one in the clue color has to end up inside some region, one in the
 * other color may never be claimed by any.
 */
[[nodiscard]] bool applicable(const Model &model);

/**
 * One verified solution, or nothing.
 *
 * Never `Unsolvable`: this is a construction, and a construction that fails has
 * proved nothing about the board.
 */
[[nodiscard]] Outcome runPacking(const Model &model, const Config &cfg);

} // namespace lg::packing
