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

The greedy rollout arm alone delivers a minimal-length solution within 100 ms on
every solvable captured board. Everything after it only proves that length and
tidies which of the equally short answers gets shown. The beam ladder never
shortened anything greedy found on this corpus; its value is insurance for
hand-drawn boards, of which the corpus has none.

Both engines agree on all 49 lengths — `bench:mt --diff` across a TypeScript
baseline and a native one reports no differences, and
`test/match-three-solver/wasm.slow.test.ts` pins the same table through wasm.

## The three that do not

| fixture | before this work | now, on the page at 300 s |
| --- | --- | --- |
| matchThreeTest47 (11×12, 69 blocks) | Gave up at 30 s | **20 moves in ~25 s**, labelled unproven |
| matchThreeTest50 (9×23, 105 blocks) | Gave up at 30 s | gives up, having ruled out 10 |
| matchThreeTest51 (13×14, 90 blocks) | Gave up at 30 s | gives up, having ruled out 9 |

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
moves, sustained after a move) and deeper (35 and 30), and no run so far has
produced a single witness for either.
