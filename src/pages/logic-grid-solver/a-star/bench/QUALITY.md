# Logic grid: what the engine is measured against

## The two claims, and what checks each one

| Claim | Checked by |
|---|---|
| An answer satisfies every rule and clue | `Verify.cpp` at every complete assignment, `verify.ts` before anything is drawn |
| The search did not lose a solution along the way | `Reference.cpp` — brute force over the whole colouring space |

The second is the one worth being careful about. `Verify` catches an answer
that is not a solution; **nothing at runtime catches a propagator that removes a
colouring which was one.** In normal mode that surfaces only as a different
valid answer. Underclued, it is a wrong answer that looks entirely reasonable:
"this cell is forced" is a claim that no other solution exists, so a propagator
that quietly deleted the other solution makes the claim come out true.

So the engine is compared against brute force on whole **solution sets** and
exact **forced sets**, not on one answer:

- `test/reference_test.cpp` sweeps 11 board shapes × 11 rule sets, and for each
  asserts the engine and brute force agree on solvability, that the forced set
  matches exactly, and that every witness verifies. **The profile sweep is
  checked there too**, on every shape it accepts — a DP with a subtly wrong
  transition is exactly the bug that would otherwise ship as a confident wrong
  answer on the boards nothing else can do.
  **A new rule needs a shape it can fire on**, or its row in the sweep is 11
  vacuous cases that look like coverage: the 1x5 pair came with the 5-wide
  `wide` shape because every other shape here is at most four across.
- `bun run fuzz:lg` does the same on generated boards, where the sharpest check
  needs no enumeration at all: the generator colours the board first and reads
  the clues off the result, so **every cell reported forced must match that
  colouring**.

## The captured corpus

111 boards from the game, 3×3 up to 21×15, measured 2026-08-02:

- **All 111 answer.** 55 of 55 plain boards come back solved with every answer
  verified, and **56 of 56 underclued boards come back `deduced` AND `proven`**.
- **38.8 s of search for the whole corpus, and 37 s of that is one board**
  (`logicGridTest67`). Only two others pass 200 ms.
- **48 never branch at all** — they come out of `cascade:deduce`, propagation
  plus look-ahead and no search whatsoever. That is the design working as
  intended: these puzzles are built to be worked out by hand.
- **No two boards are the same puzzle.** Checked pairwise under all eight square
  symmetries, both for exact equality and by cell distance; nothing came within
  12%. Worth knowing how that check can lie: comparing only the clue layer
  reported four "duplicate" 7×7 boards, because boards with no clues and no gaps
  all look alike once you throw the colours away. The colour layer IS the puzzle
  on an underclued board.
- `ctest -L logic-grid`: **287 tests**, with the clang-tidy gate enforced on
  every TU and reporting nothing.

**Rules the corpus does not exercise.** The 1x5 pair is used by exactly one
board (`logicGridTest58`, underclued); `one-symbol-dark` / `one-symbol-light` by
none at all, because they arrived after the last capture. Both are covered
instead by the reference sweep — `wide × bothRuns5` and the three `oneSymbol`
rule sets, all compared against brute force — by both `Verify` oracles' own
cases, and by `fuzz:lg`, which draws from the full rule pool.

**The rule indices were regrouped once**, before the site went live, and all 69
fixtures were rewritten in the same change. The check that made that safe is
worth repeating if it ever happens again: snapshot each board's rule IDs and its
solver answer, renumber, then assert the cells, the symbols, the dimensions, the
rule ID SET and the exact answer are all unchanged. 69 of 69 came back
identical.

## The board that needed a second engine

`logicGridTest67` is 15×15 with four letter pairs and no rules. Nothing in the
solver could touch it: the cascade ran ten million nodes, a shortest-path router
failed 4 000 times out of 4 000, and simulated annealing across forty seeds and
sixteen million flips never closed the last constraint. Its answer is four
**nested spiral arms** of 127 / 62 / 28 / 8 cells — a global shape that no
amount of local propagation sees coming.

**A wrong turn worth recording.** I first concluded the board was *impossible*,
from analogues of the same shape shrunk down:

| board | result | nodes |
|---|---|---|
| 5×4 | unsolvable (brute force agrees) | 86 |
| 6×5 | unsolvable | 4 390 |
| 7×6 | unsolvable | 1 357 188 |
| 8×7 and up | budget ran out | 10M+ |

Those refutations are real, and the conclusion drawn from them was not. Two
letter pairs whose ends alternate around the boundary do have to cross — but
only when every terminal is on the outer face and there is no room to go around.
Board 67's `(5,13)` is interior and the board is big, so the regions **nest**
instead. The small boards fail for lack of space, and the argument does not
scale with them. `Profile.InterleavedPairsWithNoRoomAreImpossible` pins the 3×3
where the obstruction is genuine, immediately beside a note that the same
shape with room is perfectly solvable.

**What actually solves it** is `Profile.cpp`, a connectivity-profile sweep: walk
the board cell by cell, and keep only what the rest of it needs to know about
the part already decided — the colour of each frontier cell, which frontier
cells share a region, and which letter each of those regions carries. Partial
colourings that agree on that are interchangeable and collapse into one state,
so the cost becomes the number of distinct frontiers instead of the number of
colourings. Measured on this corpus:

| board | before | after |
|---|---|---|
| `logicGridTest47` (8×8) | 8 200 ms | **2 ms** |
| `logicGridTest67` (15×15) | never | **38 s** native, **45 s** browser |
| `logicGridTest37`, `44`, `32`, `41` | ms | ms (deduction still wins) |

Frontier states peak at 4.7 million on board 67 and 76 million accumulate over
the whole sweep, which is why the layers keep only five bytes a state — the
frontiers themselves are needed to build the next layer and never again.

It is complete, so `Unsolvable` from it is a real proof, and `reference_test`
checks it against brute force on every shape it accepts.

**And completeness is what makes it answer the underclued mode.** A cell is
forced exactly when every path that still reaches an accepting end paints it the
same way, so one backward pass over the swept space gives the whole forced set —
where `runForced` proves each candidate cell with a search of its own. On a
letter-only board with no rules those searches have nothing to prune with, which
is where they stalled:

| board | `forced` | sweep |
|---|---|---|
| `logicGridTest96` (11×11) | 60 s, nothing | **1.0 s** |
| `logicGridTest108` (8×8) | 60 s, 5 of 64 unproven | **12 ms** |
| `logicGridTest109` (7×7) | 60 s, 7 of 49 unproven | **1 ms** |
| `logicGridTest107` (6×6) | 13.3 s | **1 ms** |

Both routes are held to the same standard in `reference_test`: the EXACT forced
set from brute force, not a subset. They were also run against each other on
every underclued board in the corpus the sweep accepts — 6 of 18, the rest
having area clues — and agreed on all of them.

## Earlier measurements

Taken before the corpus arrived, and still the guard against a propagator
regression:

- an ad-hoc sweep of 1500 random boards (2×2 to 4×4, random gaps, givens, area
  and letter clues, random rule subsets) plus the 100 fixed shape × rule-set
  combinations: **12 906 checks, 0 disagreements** with brute force, including
  every forced set;
- `bun run fuzz:lg --count 200`: 0 divergences, alternating clued and
  underclued boards at 4×4 to 8×8;
- `bun run fuzz:lg --count 400 --width 4 --height 5`: 0 divergences, and small
  enough that `--brute` actually engages — spot-checked boards had 30, 118 and
  181 solutions each, with the engine's forced set matching full enumeration
  exactly.

Those are the numbers to beat when a propagator changes.

**One trap, learned by writing it wrong.** The first version of the campaign
compared the solver's *complete* answer against the generator's colouring and
reported 110 "divergences" out of 150. All of them were the harness: a clued
board usually has many solutions, and the generator holds one of them, so two
different valid answers prove nothing. The witness comparison applies to
**forced** cells only — which is why the campaign now alternates the two kinds
by seed rather than defaulting to clued boards it cannot check that way.

## Keeping it honest

`bun run bench:lg` writes the baseline; its `--diff` gates on **fewer cells
decided or a proof lost**, not only on a slower clock, because the underclued
mode can trade one for the other. With 68 of the 69 boards inside ~110 ms the
clock is not the interesting number — what a regression looks like here is a
board falling out of `cascade:deduce` into the sweep, out of the sweep into the
DFS, or out of the DFS entirely.

The shape of the risk, for whoever measures first:

- **Connectivity is the hard constraint**, and the profile sweep is the answer
  to it wherever it applies — which is boards with no area clues and no pattern
  rules. Outside that gate a plain DFS is still bad at proving "this colour
  cannot be connected here", and the two open moves remain: teaching the sweep
  area clues (each open region would have to carry its size) or learning the cut
  as a clause in the DFS. Neither is built.
- **Underclued cost is not about board size but about how much is forced.** Few
  clues means most cells are free, and two solutions that disagree settle each
  of them for nothing. Many clues plus rule 10 means most cells *are* forced,
  and each one owes a full search that finds nothing. That is where this design
  would need clause learning shared across the refutations rather than a fresh
  search per candidate.
