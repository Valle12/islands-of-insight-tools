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

## The three that do not

All three now get an answer. None of the three is proven, and that is unlikely
ever to change — see `../a-star/bench/HARD-BOARDS.md`.

| fixture | before this work | now |
| --- | --- | --- |
| matchThreeTest47 (11×12, 69 blocks) | Gave up at 30 s | **20 moves**, and 20 is the optimum |
| matchThreeTest50 (9×23, 105 blocks) | Gave up at any budget | **23 moves**, 0.9–32 s |
| matchThreeTest51 (13×14, 90 blocks) | Gave up at any budget | **15 moves**, 1.9–12 s |

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
