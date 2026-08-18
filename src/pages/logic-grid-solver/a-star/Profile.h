#pragma once

#include "Puzzle.h"
#include "Search.h"

// A connectivity-profile ("plug") sweep over the board.
//
// The DFS in `Search.cpp` decides one cell at a time and only learns that a
// letter's region was cut off once it has painted its way into the corner. On a
// board whose ONLY constraints are connectivity that is hopeless: the answers
// are globally nested shapes, and no amount of local propagation sees them
// coming. `logicGridTest67` — 15x15, four letter pairs, no rules — is the
// measured case. Its answer is four nested spiral arms, and the DFS does not
// find it in ten million nodes.
//
// This sweeps the board cell by cell instead, keeping a FRONTIER: the boundary
// between the cells already decided and the rest. Everything the remaining
// board needs to know about the decided part is
//
//   - the color of each frontier cell,
//   - which frontier cells are in the same region,
//   - which letter each of those regions carries,
//
// and that is a bounded amount of information. Two partial colorings agreeing
// on it are interchangeable, so they collapse into ONE state and the sweep
// shares all their work. That is the whole idea: the cost stops being the
// number of colorings and becomes the number of distinct frontiers.
//
// It is COMPLETE. Reaching the end proves a solution exists, and reaching it
// with nothing proves none does — so unlike a beam or a local search this can
// answer `Unsolvable` honestly.
//
// Measured against the letter-only boards in the corpus, peak frontier states:
// 4 (logicGridTest33) to 2 864 (logicGridTest37), all under 100 ms. Board 47
// takes 448 states and 27 ms where the DFS needs about eight seconds.
namespace lg::profile {

/**
 * Whether this board is one the sweep can take.
 *
 * Two things are out of scope, and both are refusals rather than silent wrong
 * answers:
 *
 *   - **Area clues.** An exact region size would have to be carried per open
 *     region, and the state count is multiplied by the size range for every one
 *     of them. Deciding that is a different design, not a bigger constant.
 *   - **The pattern rules** (2x2, the runs, checkerboard). They are perfectly
 *     expressible — each needs the cell diagonally behind the frontier, or a
 *     per-column run counter — but boards carrying them are exactly the boards
 *     propagation already finishes in milliseconds, so the sweep would buy
 *     nothing and cost state. The connectivity rules ARE handled.
 *
 * A gate that is wrong in the PERMISSIVE direction is a correctness bug, not a
 * slow path, so it is written as a whitelist. `Verify` gates the witness
 * `runProfile` returns — but `runProfileForced` sets `proven` on a forced set
 * with no oracle behind it at all, and a sweep blind to part of the puzzle
 * enumerates a superset of the solutions and then reports the cells they
 * disagree about as proved to go either way. Nothing downstream could catch
 * that, which is why anything unrecognized declines here by default.
 */
bool applicable(const Model &model);

/**
 * One solution, or a proof there is none.
 *
 * Returns `Status::Unsolved` without proving anything when the frontier grows
 * past the state cap — the caller must treat that as "did not finish", never as
 * a negative. `stats.stoppedOnMemory` is set in that case so the difference is
 * visible rather than inferred.
 */
Outcome runProfile(const Model &model, const Config &cfg);

/**
 * The underclued answer: the cells that hold the same color in EVERY solution.
 *
 * The sweep already enumerates the whole space, so this needs no per-cell
 * refutation at all — one backward pass marks the states that can still reach
 * an accepting end, and a cell is forced exactly when every surviving path
 * paints it the same way. `runForced` answers the same question by proving each
 * candidate cell separately, which on a board with no rules to prune with is
 * one hopeless search per cell.
 *
 * Same gate and the same honesty as `runProfile`: `Status::Unsolved` with
 * nothing claimed when the board is out of scope, the budget goes, or the state
 * cap is hit — and `proven` is only ever true off a completed sweep.
 */
Outcome runProfileForced(const Model &model, const Config &cfg);

} // namespace lg::profile
