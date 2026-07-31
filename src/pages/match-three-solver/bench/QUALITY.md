# How good are the unproven solutions?

The solver ships answers it cannot prove minimal, so the first question is how
sub-optimal they actually are. Measured 2026-07-31 on the 52-fixture captured
corpus (`bun run bench:mt`, `bun run bench:mt --exe default`; baselines beside
this file).

## The 49 boards that get proven

| metric | value |
| --- | --- |
| boards where an arm found a solution | 49 / 49 |
| boards where the answer is proven minimal | 49 / 49 |
| first streamed best already at the proven-minimal length | **49 / 49** |
| mean / max overshoot of the first best | **0.00 / 0 moves** |
| first best slower than 100 ms | none |

What that table does *not* say — and an earlier version of this file wrongly
did — is that greedy alone answers every solvable board. Measured over all 52
with the arm run on its own (`--engine greedy`, 2026-07-31): **it answers 38, and
every one of those 38 answers is already the proven optimum, worst case 4 ms.**
It says nothing at all about the other 14 (11, 13, 17, 35, 39, 42–47, 49, 50, 51)
— those are what the beam, the dive, NRPA and the prover are for. The row above
is about the *first streamed best from the whole pipeline*, not about greedy.

Everything after the arm that finds a solution only proves that length and tidies
which of the equally short answers gets shown. The beam ladder never shortened
anything greedy found on this corpus, which is why both engines now skip it once
any witness is in hand — that budget is worth more to the provers, and on test47
it was the difference between an answer and none.

Both engines agree on all 49 lengths — `bench:mt --diff` across a TypeScript
baseline and a native one reports no differences, and
`test/match-three-solver/wasm.slow.test.ts` pins the same table through wasm.

## How long the whole corpus takes on the page

Measured 2026-08-01 in Chromium against the dev server, cross-origin isolated on
16 cores — so the wasm portfolio races on real threads inside one module beside
the TypeScript worker, which is what a user actually gets. Driven through the
page's own upload button and Solve button, one fresh page per fixture
(`MT_SLOW_E2E=1 bunx playwright test e2e/match-three-solver/corpusTiming.slow.test.ts`).

| | boards | time |
| --- | --- | --- |
| proven minimal, search settles on its own | 49 | 94–453 ms each, **median 361 ms**, 16.9 s for all 49 |
| answered but never proven | 3 | 1.8 s, 3.2 s and 10.2 s to the answer |

**All 52 answers in about 32 seconds**, if the three unproven boards are stopped
once their answer arrives — which is exactly what the "Stop — use best so far"
button is for, and it is live from the moment a solution streams in. Left alone
those three run the full 300 s budget each, so the corpus takes ~15 minutes to go
quiet: not because the answers are slow, but because *disproving* a shorter one
never finishes.

Two things worth reading off that table. No proven board takes even half a
second, so the budget is irrelevant to 49 of 52. And the gap is a cliff, not a
slope — the slowest proven board is 453 ms and the fastest unproven one is 1.8 s
with no proof at any budget.

matchThreeTest51 came back with **16** moves in this run where the native arms
found 15. Both are honest: NRPA is stochastic, and 15 and 16 both turn up across
seeds. The page says "not proven to be the shortest solution" precisely because
of this.

## The three that do not

All three now get an answer. None of the three is proven, and that is unlikely
ever to change — see `../a-star/bench/HARD-BOARDS.md`.

| fixture | before this work | now |
| --- | --- | --- |
| matchThreeTest47 (11×12, 69 blocks) | Gave up at 30 s | **20 moves**, and 20 is the optimum |
| matchThreeTest50 (9×23, 105 blocks) | Gave up at any budget | **23 moves**, 0.9–32 s |
| matchThreeTest51 (13×14, 90 blocks) | Gave up at any budget | **15 moves**, 1.9–12 s |

Verified on the real page, not only in the harnesses (Chromium against the dev
server, cross-origin isolated, 16 cores — so the whole portfolio races inside one
module on real threads). Loading `matchThreeTest50.json` through the page's own
upload button and pressing Solve, the page reads

> Best so far: 23 moves (not yet proven shortest) — ruling out 10 moves —
> 161,103,669 positions checked

with the Cancel button now offering *"Stop — use best so far"*. Pressing it hands
over the solution rather than discarding the search: **Step 1 of 23**, the two
cells ringed, and the step text *"Swap the block at Column 2, Row 22 with the one
at Column 2, Row 23. That clears 6 blocks."* Stepping to 23 of 23 leaves exactly
the six blocks that last swap takes. The unproven note is visible throughout.

How sub-optimal are the two that have no proof at all? Unknown, and honestly so —
the page labels them unproven. Two things bound the guess. Every seed that solves
test50 returns **23 moves** and every seed that solves test51 returns 15 or 16,
across eight seeds and three nesting levels, which is what you would expect of an
optimum and not of a lucky long line. And the corpus's proven boards run 3.5–5.1
blocks per move; 105/23 = 4.6 and 90/15 = 6.0 sit inside or just above that band.

**matchThreeTest47's 20 moves are the optimum** — a deepening run with the
budget lifted proved it minimal in 46 min 42 s (2026-07-31, before this work).
Measured in Chromium on the real page, cross-origin isolated, six arms racing in
one module: the answer appears after ~25 s and 49.6 M positions, and the page
reads

> Best so far: 20 moves (not yet proven shortest) — ruling out 10 moves —
> 49,591,582 positions checked

with the Stop button offering to take it. What proving it would take, and why
neither engine can, is in `../a-star/bench/HARD-BOARDS.md`.

The arm that finds it is the **dive** (`bnb`): one search at the deepest length
worth trying covers every shorter path too, so it can reach a 20-move answer
that a deepening search would have to climb nineteen exhausted levels to see.
Both engines have it; the TypeScript one alone needs ~120 s, so the page would
answer test47 within its 300 s budget even with no wasm at all.

test50 and test51 resist even the dive: wider at the root (14 and 24 legal
moves, sustained after a move) and deeper (35 and 30). What answers them is
**NRPA** — policy-adapting rollouts, with restarts. Neither is a systematic
search result; both are witnesses a stochastic arm found and the replay oracle
then validated. The measurements behind that, including why a plateau is usually
a *provably* dead end and why the restart ladder leads with its cheapest rung,
are in `../a-star/bench/HARD-BOARDS.md`.
