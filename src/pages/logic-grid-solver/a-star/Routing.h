#pragma once

#include "Puzzle.h"
#include "Search.h"

// A negotiated-congestion ROUTER for boards whose only constraints are letters.
//
// The DFS decides one cell at a time and the profile sweep enumerates whole
// frontiers; between them they cover every letter board in the corpus except
// the widest. On a board like the captured 23x21 — a lattice of given dark
// cells with eight letter PAIRS between them and no rules at all — neither
// works. Propagation has nothing to say before a color is chosen, so the DFS
// wanders (measured: 21.9 million nodes, 127 of 483 cells decided, zero
// refutations, and the same numbers at 60 s, 90 s and 240 s), while the sweep's
// frontier is 21 wide where 16 is already the practical ceiling.
//
// What those boards really ask is a ROUTING question: give each letter a
// connected region of its own, and keep the regions apart. That is the shape of
// a global-routing problem, and the standard answer is negotiated congestion —
// route every net through the cheapest cells, charge for the cells two nets
// both want, and repeat until nobody overlaps. It finds a coloring for the
// 23x21 board in milliseconds where both other arms are hopeless.
//
// It is INCOMPLETE and says so: it answers `Solved` or `Unsolved` and can never
// report `Unsolvable`, because failing to route proves nothing. That is also
// why it is cheap to be wrong — every coloring it builds goes through
// `verify::check` before it is returned, so a construction that misreads the
// puzzle produces nothing rather than a wrong answer.
namespace lg::routing {

/**
 * Whether this board is one the router can usefully try.
 *
 * The gate is about not wasting budget, NOT about correctness — the witness is
 * verified either way. It asks for the shape the construction assumes: every
 * clue a letter, at least two letter groups to keep apart, no merged cells (the
 * router paints per square), and no rules, since "every cell the router did not
 * claim takes the other color" breaks all but the emptiest rule set and the
 * oracle would simply throw the result away.
 */
bool applicable(const Model &model);

/**
 * One verified solution, or nothing.
 *
 * Never `Unsolvable`: this is a construction, and a construction that fails has
 * proved nothing about the board.
 */
Outcome runRouting(const Model &model, const Config &cfg);

} // namespace lg::routing
