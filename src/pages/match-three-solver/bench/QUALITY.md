# How good is the answer, and how fast?

The solver returns the **first solution it can play**, not the shortest one.
That was a deliberate trade, and this file is the measurement behind it.
Measured 2026-08-01 on the 52-fixture captured corpus (`bun run bench:mt`,
`bun run bench:mt --exe default`; baselines beside this file).

## What stopping early costs

Almost nothing — and this was measured *before* the change rather than after.
Comparing the first streamed solution against the proven minimum the old
deepening engine returned, over every board it could prove:

| | boards |
| --- | --- |
| first solution found IS the proven minimum | **48 / 49** |
| first solution one move longer | 1 (`matchThreeTest46`, 8 against 7) |
| first solution shorter, or missing entirely | 0 |

Two boards pay, one move each:

- **`matchThreeTest46`** — 8 moves where 7 exist.
- **`matchThreeTest47`** — the lone exhaustive arm returns 21 where the optimum
  is 20, because it takes the first line it reaches at `maxDepth` instead of
  re-diving under a tighter bound. **The page still returns 20**, because its
  portfolio races NRPA seeds that find it.

Nothing else changed length, and no board that used to be answered stopped
being answered.

`matchThreeTest47`'s 20 is a genuine optimum: a 46-minute deepening run in July
2026 proved it, back when the engine could still prove such a thing. The number
is kept because it was expensive to obtain, not because anything still checks it.

## What it buys

The whole corpus, on the real page. Chromium against the dev server,
cross-origin isolated on 16 cores, so the wasm portfolio races on real threads
beside the TypeScript worker; driven through the page's own upload and Solve
buttons, one fresh page per fixture
(`MT_SLOW_E2E=1 bunx playwright test e2e/match-three-solver/corpusTiming.slow.test.ts`).

| | before (proving) | after (first solution) |
| --- | --- | --- |
| boards that finish | 49 of 52 settle; 3 never do | **52 of 52** |
| median | 361 ms | **104 ms** |
| slowest | 453 ms proven, plus 3 boards at the 300 s budget | **7.9 s** |
| whole corpus | ~15 minutes | **16.9 s** |

The three that used to run the budget out:

| fixture | before | after |
| --- | --- | --- |
| matchThreeTest47 (11×12, 69 blocks) | answer at 3.2 s, then 300 s of proving | **20 moves in 2.4 s** |
| matchThreeTest50 (9×23, 105 blocks) | answer at 1.8 s, then 300 s of proving | **23 moves in 1.4 s** |
| matchThreeTest51 (13×14, 90 blocks) | answer at 10.2 s, then 300 s of proving | **16 moves in 7.9 s** |

Natively the same thing shows up as the bench halving: 92.1 s → 50.3 s over the
corpus, with `matchThreeTest47` going from *budget* to solved in 16 s and
`matchThreeTest51` from 30 s down to 3.8 s.

## Where the answers come from

**Greedy alone answers 38 of the 52 boards, worst case 4 ms**, and every one of
those 38 is what an exhaustive search would have called optimal anyway. It says
nothing about the other 14 (11, 13, 17, 35, 39, 42–47, 49, 50, 51) — those are
what the beam, NRPA and the exhaustive search are for.

`matchThreeTest50` and `51` are answered by **NRPA**, which is stochastic:
test51 comes back with 15 or 16 depending on the seed. Neither is a systematic
search result; both are witnesses a rollout arm found and the replay oracle then
validated. The measurements behind that arm — why a plateau is usually a
*provably* dead end, and why its restart ladder leads with its cheapest rung —
are in `../a-star/bench/HARD-BOARDS.md`.

## What still guarantees the answer is real

Nothing here is proven minimal, but everything here is proven **playable**, and
that check matters more now rather than less:

- every witness from either engine is replayed through `rules.applyMove` before
  it can reach the viewer (`solveClient.ts`), before it can pass either corpus
  sweep, and inside `fuzz:mt`;
- `fuzz:mt` cross-checks the two engines on solvability, which is now the main
  automated guard against a rules divergence;
- the per-fixture length tables survive as **ceilings** rather than pins — a
  quality net that catches an arm-ordering regression returning fifteen-move
  answers where seven exist.
