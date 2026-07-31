# How good are the fast arms' solutions?

The anytime pipeline ships sub-optimal answers when the proof does not
finish, so the first question is how sub-optimal they actually are. Measured
2026-07-31 on the 52-fixture captured corpus (`bun run bench:mt --budget-ms
30000`, data in `baseline-ts-anytime.json`; proven optima from
`baseline-ts-30s.json`).

## The 49 boards the sweep proves

| metric | value |
| --- | --- |
| boards where the arms found a solution | 49 / 49 |
| first streamed best already at the proven-minimal length | **49 / 49** |
| mean / max overshoot of the first best | **0.00 / 0 moves** |
| first best slower than 100 ms | none |

The greedy rollout restarter alone delivers a minimal-length solution within
100 ms on every solvable captured board — the prover then proves it minimal
and only ever improves the grouping. The beam ladder never shortened
anything greedy found on this corpus; its value, if any, is insurance for
hand-drawn boards between "test44-hard" and "impossible", of which the
corpus has none.

## The three beyond-budget boards

| fixture | at 30 s | first best |
| --- | --- | --- |
| matchThreeTest47 (11×12, 69 blocks) | `budget`, ruled out 9 | none |
| matchThreeTest50 (9×23, 105 blocks) | `budget`, ruled out 8 | none |
| matchThreeTest51 (13×14, 90 blocks) | `budget`, ruled out 7 | none |

**Neither fast arm finds anything on these three.** Greedy rollouts dead-end
(against their blockade walls, near every shortsighted line strands a
symbol), and the beam's frontiers empty for the same reason at every width
up to 2048. So the labeled best-so-far UX, though fully wired, never fires
for them yet: at the page's 300 s budget they still end in an honest "Gave
up" — with memory flat around 500 MB where the old engine died at 19 GB
(see the Stage-1 measurements in the commit history).

The implication for the C++/wasm stage: the hard boards do not need a
faster greedy — they need arms that can afford to look ahead. Deeper beams,
randomized bounded DFS (`bnb`), and the root-split prover on real threads
are the candidates; whichever first produces *any* witness on 47/50/51 also
turns on the anytime UI for them.

test47 remains the one hard board with a known answer (20 moves, proven in
46 min 42 s by the pre-optimization engine): the wasm portfolio's target is
that proof inside the page's 300 s budget.
