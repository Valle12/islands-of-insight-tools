# Rolling-blocks hard boards

Fuzz-campaign survivors kept as `fuzz-<seed>-hard.json` (the app/fixture
format; regenerate bit-identical with
`a_star --generate <out> --seed <seed> --kind <kind> --shuffle 1000000`).
Solvable by construction — every one shipped a replay-validated witness at
generation time — so an UNSOLVED result is always a solver gap, never a
puzzle property.

Campaign log (seeds 5000–5029 at 50k shuffles, 7000–7044 at 1M shuffles,
60 s cascade budget, 2026-07-29): 73/75 solved. The two survivors below are
both **two-block coverage** boards — the one class deliberately left open:
the cracker's touch-greedy ordering cannot coordinate two interleaved
coverage walks (its gate is `blocks == 1` for exactly that reason, measured
against fixture 34), the greedy arm lands only some of them, and weighted A*
drowns in the positions × 2^mustTouch space.

| board | size | blocks | mustTouch | survived |
|---|---|---|---|---|
| fuzz-7007-hard | 64×28 | 2 (unit-ish) | 306 | cascade 60 s, cascade 900 s, cracker 1 h; beam-wide interrupted |
| fuzz-7043-hard | 15×43 | 2 | 65 | cascade 60 s (retry ladder not reached before the campaign was stopped) |

Next algorithmic candidates for the class, in rough order of promise:

1. **Must-touch partition + per-block coverage**: assign each unsatisfied
   cell to one block (nearest / balanced flood regions), then run the
   single-block cracker per block against its share — turns the coordination
   problem back into the solved single-block one. A partition is a
   relaxation-with-commitment, so it needs restarts over partitions.
2. **Cracker with joint frontier ordering**: score moves across BOTH blocks
   by (touches, onward options of the moved block, distance to the nearest
   unsatisfied cell of ITS partition) instead of per-move greediness.
3. Seed-diversified greedy restarts (greedy already cracks several of these
   solo; it currently gets one deterministic shot per cascade).

Also recorded from these campaigns: solutions on very large coverage boards
can run far past the witness length (seed 7040: 15,606 turns vs a 213-turn
witness) — the optimizer's windowed BFS re-solve saturates its 20k node cap
on 2-block boards. Raising the cap adaptively or window-solving per block
are the obvious levers.
