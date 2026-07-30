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

| board | size | blocks | mustTouch | status |
|---|---|---|---|---|
| fuzz-7007-hard | 64×28 | 2 (2×1×1 dominoes) | 306 | STILL OPEN — the leg-order search covers 215/306 before the dense right blob deadlocks |
| fuzz-7043-hard | 15×43 | 2 | 65 | SOLVED by the split scheme (82 turns, ~54 s via the region cascade) |

An earlier revision of this file claimed the alternation reached 241/306.
That was a misread: the `total=` field in its diagnostics was the plan
length in TURNS, not cells covered. Both the greedy scheme and the search
that replaced it are measured by the `open` count — cells still
unsatisfied — and the honest numbers are 96 (greedy) and 91 (search).

The two-block machinery in `SolverArms.cpp::runSplitCoverage`, all wired
into the cracker arm behind the widened `coverageProfile` gate, is now
three phases (budget 1/6 → 3/4 → last eighth):

1. **Plain sequential split**: partition unsatisfied cells by nearest
   block, single-block cracker per leg with the idle block parked as a
   wall (2 orders × 2 foreign-cell styles), replay-validate the
   concatenation. Cracked 7043; also what now carries fixture 34 fast
   (344 ms / 36 k expansions vs 4.2 s / 1.38 M via wastar before).
2. **Leg-order search** (`LegOrderSearch`): every position is a node,
   every leg an edge, and the frontier is expanded best-first on how
   healthy the REMAINING board looks. Each leg is a *required-subset*
   cracker search (`Config::requiredCells` — succeed once the target cells
   are satisfied; every other must-touch cell keeps real one-shot
   semantics, so leg plans replay legally by construction), and the
   successor set spans both blocks, several target ranks, and chunk sizes
   from a share-proportional bulk sweep down to a single cell. Guardrails,
   all of which exist because 7007 failed without them: a pose-space
   coverability field (a domino needs two consecutive free cells to stand
   up — cell BFS lies), an orphan prune plus a **coverage-intact prune**
   inside the cracker (`Config::coveragePartner`: after every touching
   move, every open cell must stay coverable by the active block or the
   parked partner via a two-seed pose BFS), and a dead-cell gate on every
   child.

   This replaced a greedy chunk sequence with bounded rewinding. Four
   things were measured on the way and are worth not rediscovering:
   progress must dominate the position score LEXICALLY (a shape penalty
   big enough to outweigh one satisfied cell makes the frontier abandon
   the line it just advanced, and the search thrashes at 227 open); the
   frontier needs a reserve to fall back on (a pure bounded beam starved
   to zero in 2.3 s of a 180 s budget, because most legs fail); the bulk
   chunk must be share-proportional, not a constant (share/8 turns a
   20-cell ask into an 80-cell sweep, since the walk satisfies whatever it
   crosses — a fixed 32 just fails); and alternation has to be structural,
   because a score dominated by progress otherwise hands every leg to
   whichever block just gained the most and mono-block dives into a wall.
3. **Joint finisher / joint last word**: the two-block cracker with the
   same intact prune in joint mode (`Config::jointCoverageIntact`), on the
   remaining endgame once it shrinks under ~100 cells, and on the whole
   board as the final phase.

7007 still resists, and the leg-order search says something useful about
why. It reaches 91 open where the greedy scheme reached 96 — an
improvement, but a marginal one — and quadrupling its expansions (1819 vs
521 at 300 s) buys exactly one more cell. Both attempts end with a live
frontier, so this is not a budget wall: the search has plenty of
alternatives left and none of them help. Around 90 open cells the dense
right-hand blob simply has no leg-granular ordering that works, which
means searching leg order harder is the wrong axis.

That leaves the second candidate, and the evidence now points at it
directly: a constraint/SAT-style formulation of the cell ORDER inside the
blob, which reasons about the covering sequence itself instead of
sampling it one cracker call at a time. Note this would reopen the SAT
decision taken at the start of the overhaul (the vendored CaDiCaL was
deleted) and add a solver dependency to the wasm build.

`fuzz-7007-endgame.json` is the frozen stuck state as a standalone
fixture, for iterating on the hard core in seconds instead of minutes —
but treat it as a probe, not a target: it is a position the OLD scheme
painted itself into and may simply be lost.

Note the reality anchor: real captured game boards top out at 13×15 with 83
must-touch cells — 7007 is a 64×28 stress artifact 4.5× beyond anything the
game has shown, and every guardrail it forced (orphan prune, pose-space
coverability, intact invariant) sped up or shortened the real-board
fixtures (34: 12× faster and 2 turns shorter; 37: fewer expansions; suite
wall time 80 s → 48 s).

Also recorded from these campaigns, then FIXED: solutions on very large
coverage boards ran far past the witness length (seed 7040: 15,606 turns vs
a 213-turn witness). Two changes brought that board to 665 turns (≈3× the
hard floor of ceil(274 cells / footprint 2)):

1. The cracker orders zero-touch (transit) moves by a distance field to the
   nearest unsatisfied cell — strictly BELOW Warnsdorff's onward count.
   Distance-first was measured to walk into snake traps (a solving cracker
   found nothing on the same board); as a tie-break it replaces random
   jitter with progress. The field caches by satisfied count (per-frame
   rebuilds were 12× slower per node).
2. The optimizer's touch-segmented reconnection pass: split at must-touch
   events, reconnect each stretch optimally with the search restricted to
   the blocks that stretch moves (single-block stretches solve exactly in
   ≤24k pose space). Meanders never repeat a full state (the satisfied set
   is monotone), so the loop-cut pass structurally cannot see them — this
   pass can.
