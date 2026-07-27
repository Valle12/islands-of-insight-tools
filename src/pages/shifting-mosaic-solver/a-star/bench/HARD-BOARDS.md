# Hard fuzz boards (`fuzz-<seed>-hard.json`)

Generated boards banked from the fuzz campaigns (`bun run fuzz:sm`; every board
is solvable by construction — goal starts on its anchor, then a long random
shuffle). Reproduce any of them with `--generate --seed <seed>` (1M shuffles
unless noted). All use the standard fixture schema and load with
`--fixture <path>` in the bench CLI.

## ALL SIX SOLVED (2026-07-19, IIT-21) — the 10k campaign is at 100%

The six survivors of the 10,000-board campaign (9,994 solved) were compact
dense jam boards; the frontier-BFS depth bounds below are proven lower bounds
on the optimal drag count. The root cause of their difficulty was DIAGNOSED
and FIXED: on 0-cut boards the cut-suffix heuristic is a near-constant, so
every search was gradient-blind. The levers that ended it — `--jam-guide N`
(per-expansion dig-cost Dijkstra, inadmissible f term; designed against the
replayed optimal 12366 trajectory, Spearman 0.69-0.76 vs remaining drags),
`--bands` (corridor-band pseudo-cuts for the FLAT engine), elite-retention
restarts (failed rounds bank their deepest partial; later rounds warm-start
from it), and the guided beam:

| seed  | board  | density | optimum (drags) | status |
|-------|--------|---------|-----------------|--------|
| 10276 | 11x11  | 67%     | >= 11 (apex, layers x4.5/level) | **SOLVED 49-59s**: drag+jamg8-w4-settled-pea64 (170t/56s) and jamg16-w6 |
| 4722  | 16x18  | 48%     | >= 6  | **SOLVED 12s**: drag+jamg16-w6-settled-pea64 (76t/29s) |
| 9164  | 17x11  | 56%     | >= 9  | **SOLVED 39-59s**: drag+bands-w4-settled-pea64 (65t/17s) |
| 11386 | 18x12  | 44%     | >= 5  | **SOLVED ~600s** (CPU-contended): corridor engine (hier+bands, 33 passes) at 900s budget (195t/31s); pure flat bands reach progress 17/~20 but need hier's backtracking to close |
| 3870  | 17x9   | 65%     | >= 25 (1.13B states exhaustive through depth 24) | **SOLVED 230s** (browser-budget!): guided beam `--engine beam --bands --beam 500000 --jam-penalty 8` (128t/50s, 1 round, 7.6M expansions) — breadth × dig gradient × bands cracked the deepest board |
| 8697  | 20x11  | 56%     | >= 10 | **SOLVED ~2.5h**: elite-retention jam marathon `--engine jam --bands --budget-ms 10800000` (386t/103s, 110 rounds, 150M expansions; the elite pool ratcheted the dig term 152→8). The hardest: its solution crosses a dig-cost RIDGE (unlike 3870, whose winning trajectory is 96% gradient-monotone), so every single-shot gradient search and beams to 2M width wall identically; only the cross-round elite ratchet crossed it |

Productized as cascade/portfolio arms "jam" (`searchJamRestarts`: diversified
winner-first restart rounds, node-capped and wasm-heap-safe) and "beam"
(`searchBeamJam`: guided beam with arena reconstruction), both gated by
`jamProfile()` (0 real cuts + aspect <= 2.6 + density >= 40%; fires on all 7
banked jams, not on the corridor boards). Regression gauntlet (2026-07-19):
native gtests 71/71, wasm tests 194/0, 44-fixture cascade diff "No
regressions", banked boards 1022/3058/3086 still solve, and 10276/4722/9164
solve through the FULL production cascade via the new jamrestart stage.
Note: 11386's ~600s corridor solve exceeds the browser's default 300s/arm
budget — reaching it in the browser needs a raised SOLVE_BUDGET_MS or the
anytime-UX letting the corridor arm run longer.

## Campaign v2 (2026-07-20): fresh 10k, seeds 20000-29999

Independent validation on a NON-OVERLAPPING seed range (1M shuffles, 30s/
stage sweep + escalation ladder: 900s cascade → 3h elite jam → 1h wide beam;
`fuzz:sm --retry`). **9,998 / 10,000 solved (99.98%)**: 9,992 at the 30s
sweep (173 trivial), plus 6 recovered by the ladder — every ladder recovery
landed on the FIRST rung (900s cascade), i.e. they were budget-limited, not
hard; seed 29849 (7x28, 57%) was solved afterwards by a direct corridor run
(`--engine corridor -w3 --settled --pea 48`, 334s, 116t/28s) — its profile
is corridor-class (goal mobility 9, 14 bands synthesize), not jam-class.
Sweep stage wins: corridor 7907, hier 1787, unit 39, drag 32, relevant 31,
assembly 12, **jamrestart 8** — the new jam arm wins organically on fresh
boards at a 30s budget.

Two genuinely hard finds (both exhausted the FULL ladder incl. the 3h elite
marathon) — note both are THIN-DENSE, a different geometry from the six
compact jams above, so they are a new class rather than a repeat:

| seed  | board | density | status |
|-------|-------|---------|--------|
| 23444 | 8x25, aspect 3.13 | 57% | open — resists ALL THREE gradients: jam ratchet frozen at 48 across 856 rounds, corridor stalls at band-progress 4/7 across three 90m-3h runs (w3 settled=4, w3 no-settle=2, w2=4). Structurally hard, not tuning-hard |
| 29534 | 12x9, aspect 1.33 | 63% | open — ladder + 1366-round marathon exhausted; **optimum >9 drags** (frontier bits 30, depth 9 clean, 242M states; table filled during depth 10) |

### Diagnostic campaign (2026-07-24): both CLASSIFIED, both still open

Fixtures now banked here (`fuzz-{23444,29534}-hard.json`; regenerate bit-identical
with `--generate --seed N --shuffle 1000000`) — they previously lived only in
`test-results/`, which `playwright test` CLEARS on every run.

Ran the best SHIPPED config, which had never been used at marathon scale on
these two (the earlier marathons predate `jamMaxElites`/`jamLuby`: they used the
old 6-elite single-lineage pool). Sequential 2h runs, native build:
`--engine jam --bands --jam-luby --jam-elites 64 --jam-round-cap 20000`.

| seed | rounds | minJamTerm | maxProgress | front trajectory | verdict |
|------|--------|-----------|-------------|------------------|---------|
| 29534 | 4091 | **8** | 0 | 52 → 20 → 8 | depth-limited; wide pool BROKE the old 20-wall |
| 23444 | 2613 | **48** | 4 | 80 → 72 → 48 | structural ridge; identical to the old run |

**The wide elite pool is a real gain on 29534** (20 → 8; the old marathon froze
at 20 for 1366 rounds) — the `jamMaxElites` widening does what it was built for.
It is NOT a gain on 23444.

**`minJamTerm` IS NOT A PROXY FOR REMAINING DEPTH — do not read it as
distance-to-go.** 29534 reaches jam 8 with `maxProgress 0`: the goal's dig ROUTE
is nearly clear while the goal itself has never moved, and committing it
re-blocks the route. Proven by DECOMPOSITION (new `--dump-elite` writes the
deepest elite as a residual fixture, `--dump-elite-turns` its root→elite prefix,
`--verify` legality-replays any turn stream): the jam-8 elite (78 drags) handed
to the FULL CASCADE fails — 448s, 22.8M nodes, `stage:"none"`. Together with the
parent ratchet's 2h of rounds warm-started from jam-8 elites, jam 8 is a
PLATEAU, not a near-solution. Decomposition adds nothing here.

**Breadth from the root is much weaker than the warm-started ratchet**: beam
500k/30min on 29534 reaches only minJamTerm 32 vs the ratchet's 8. (Width 2M was
hard-killed — the beam's per-layer arena outgrows what the box will hand it.)

**THE BAND-LENGTH GUARD WAS DENYING 29534 ANY PROGRESS GRADIENT (2026-07-24) —
a real latent bug, fixed, but it does not crack the board.** `computeCutSchedule`
synthesizes corridor bands only when `path.size() >= 8` (now
`Config::corridorBandMinPath`, CLI `--band-min-path`, default 8 = unchanged).
29534's goal journey is 6 cells (5 middle path anchors), so it fell UNDER the
guard: 0 real cuts AND no pseudo-cuts ⇒ `progressOf` BINARY ⇒ the corridor arm
declined outright ("no bands synthesized") and every other arm searched with no
progress signal at all. **The guard is length-based, but this board's difficulty
is density-based** (63%, a 12-cell goal block on 12x9) — so a board that needed
bands most was the one excluded. Note this also means the earlier `maxProgress:0`
telemetry did NOT mean "the goal never advanced"; there was no metric to advance.

At `--band-min-path 5` the board synthesizes 6 bands, and the effect is large:

| run | maxProgress | minJamTerm | work |
|-----|-------------|------------|------|
| jam, NO bands (2h, baseline) | **0** | 8 | 4091 rounds |
| corridor + bands (15m / 30m) | 2 / **2** | — | 24 / 48 passes, 18 / 35 backtracks |
| jam + bands (1h / 3h) | 5 / **5** | 8 / 8 | 1786 / 5449 rounds, 130M / 416M nodes |

The goal advances 5 of 6 bands where it previously never left 0, and the jam
front descends faster (44→8 vs 52→20→8). **The two gradients do NOT conflict
here** — contrary to the 11386 note, dig-cost + bands COMPOSE on this board.
But both arms hit a hard ceiling that TIME DOES NOT MOVE: corridor 2→2 across a
2x budget, jam 5→5 across a 3x budget (3x rounds, 3.2x expansions, identical
maxProgress AND minJamTerm). Band 5 / jam 8 is a wall, not a budget edge.
**29534 stays open.** Kept as an opt-in knob (default preserves current
behaviour bit-for-bit; NOT wired into any production arm — doing so would change
band synthesis on every 0-cut board with a 4-7 anchor path and needs the full
44-fixture + fuzz regression first). Unlike recombination below this is NOT
"ruled out": it demonstrably deepens the attack (0→5) and any future
short-journey dense board would hit the same trap — it simply does not finish
this one.

**ELITE RECOMBINATION: TRIED, RULED OUT, AND REMOVED (2026-07-24, 23444) — do
not re-attempt.** The mechanism (briefly `Config::jamRecombine` /
`--jam-recombine`, since deleted): once the front stagnates 24+ rounds, replay a
SECOND elite's drag chain onto the deepest elite's state, keeping the drags
still reachable there — a move-sequence crossover carrying two lineages' unlocks
into one start state, since the ratchet otherwise only ever MUTATES one elite.
Distinct from the ruled-out bidirectional bridging, which spliced far-apart
forward/backward frontier states; these are siblings from one pool. Result on
23444: 2620 rounds / 173.9M expansions / minJamTerm 48 — statistically identical
to the 2613-round / 173.2M baseline, same 80→72→48 trajectory. **The ridge is
not a diversity failure**, so combining lineages is the wrong axis. Removed per
the project's pattern for ruled-out levers (as with bidirectional, deadlock
patterns, PDBs); recover from git history if a future idea needs the crossover.

**Hardness is a property of the BOARD DISTRIBUTION, and it is measurable
(2026-07-20).** Sampling checkpoints of a board's ground-truth walk at a fixed
15s/stage cascade gives a hard FRACTION. Measured:

| board | grid | cells | density | hard fraction |
|-------|------|-------|---------|---------------|
| 41152 (control) | 5x15 (75) | 56 | 74.7% | **8/8** |
| 29534 | 12x9 (108) | 68 | 63%   | **21/24** |
| 23444 | 8x25 (200) | 113 | 56.5% | **18/24** |
| 41186 (control) | 19x6 (114) | 64 | 56.1% | 0/8 |
| 41169 (control) | 19x7 (133) | 72 | 54.1% | 0/8 |

Density alone does NOT explain it: 23444 (56.5%) is 75% hard while control
41186 (56.1%) is 0% hard — a 0.4-point difference with opposite outcomes.
23444 is ~2x the grid and cells of 41186, so the working hypothesis is
hardness ~ density x SCALE, i.e. **the two open boards are hard for different
reasons** (29534 by density, 23444 by scale/journey length) — which is why one
uniform ladder failed on both. n=5 boards, one budget, one engine chain: treat
as hypothesis, not fact. Boards of any target profile can now be generated on
demand by scanning seeds for the profile (compact high-density boards are RARE
— 0 matches in the first 119 seeds — which is why a 10k campaign surfaces only
a couple).

Fixtures in `test-results/sm-fuzz10k-v2/shard-{2,7}/`.

**Gate hypothesis TESTED AND LARGELY FALSIFIED (2026-07-20).** The theory
that `jamProfile()`'s aspect bound (2.6) was starving these boards of the
jam arms does NOT explain them: 29534 has aspect 1.33 and **already passes
the gate** (so the cascade's jamrestart/jambeam stages did run on it), and
23444 received the jam/beam arms anyway because the CLI `jam`/`beam`
engines are UNGATED (`--engine jam` calls searchJamRestarts directly) — it
had 3h elite + 1h wide beam and still failed. Widening the bound is a
production-ROUTING fix, not a crack. Measured cost at bound 4.2: 5 more
boards pass the geometry test (Test12/28/3/37, bench 3058), all of which
are solved by EARLIER cascade stages so the jam stages never execute on
them; the 40% density floor still rejects the true corridor boards (1022 at
22%, 3086 at 33%). Cheap, but unproven — do not claim it solves anything.

### Ground-truth trajectories and round throughput (2026-07-20)

`--generate-turns <path>` dumped the generator's reverse walk: a valid,
search-free ground-truth solution for ANY generated board (verified — 23444
and 29534 regenerate BIT-IDENTICAL to their banked fixtures and both
trajectories replay to goalDigCost 0). Wildly non-optimal (1M turns; the
optimizer's truncation rule only shrinks them 1.5-3.2x, still far past the
optimizer's O(n^2) replay), so it was a STUDY instrument, not a solution
source.

> **Removed 2026-07-23.** `--generate-turns`, `--analyze`/`jamFeatures` and
> the dumped `gt-*-turns.json` trajectories are gone from the tree along with
> frontier BFS (see the note at the end of "What has been tried"). The
> findings they produced are recorded here; the instruments themselves only
> ever ran on the CLI and could never serve the browser. Reconstruct from
> git history if a future study needs them.

**Round throughput is the jam driver's real budget unit.** `searchJamRestarts`
rounds are node-CAPPED (1.5M), not time-capped: on 23444 that is 3 rounds per
240s (~80s each). Seed 8697 — the only board ever cracked by the elite
ratchet — needed 110 rounds, so the ladder's 3h marathon bought these boards
only ~135 rounds. New `--jam-round-cap N` / `--jam-elites N` (Config
`jamRoundNodeCap`/`jamMaxElites`, both zero-touch at defaults, gtest
`JamRoundShapingStaysValidAndDefaultsUnchanged` pins bit-identical defaults):
at cap 150k the SAME ~4.8M expansions yield **36 rounds instead of 3**, and
the elite pool spans jam 68..500 instead of collapsing onto the six lowest
jam values (one lineage). 12x the lottery tickets for the same silicon.

A FIXED small cap is the wrong production answer — 10276/4722 were cracked by
a single DEEP jamg round, which a small cap truncates. `--jam-luby`
(`jamLubyRestarts`) scales the cap by the Luby sequence
(1,1,2,1,1,2,4,... × jamRoundNodeCap, clamped to the round's own cap): mostly
cheap rounds with periodic deep ones, the standard restart answer to not
knowing the right cap in advance. `DragSolver::lubyUnit` is public and pinned
by gtest `LubyUnitMatchesTheClassicSequence` (the sequence is easy to get
subtly wrong — the first implementation failed to re-derive k after folding i
into the prefix, underflowing k past zero into UB; the test caught it).

**MORE ROUNDS IS NOT THE MISSING INGREDIENT FOR 29534 (measured, 2026-07-20).**
A 90-minute `--jam-round-cap 150000 --jam-elites 32` marathon delivered **1,366
restart rounds** / 203M expansions — 10x what the entire 3h ladder ever gave
this board, and 12x the 110 rounds that cracked 8697. The ratchet responded as
designed (`minJamTerm` 64 -> 48 -> 40 -> **20**, this board's best ever) but it
did NOT solve. 8697 went 152 -> 8 and fell; 29534 stalls at 20 with 12x the
tickets. Conclusion: the throughput lever is real and improves the ratchet's
REACH, but round starvation is not what makes 29534 hard — do not spend another
multi-hour marathon on it expecting a different answer.

**Browser implication — MEASURED on the hard-instance family (2026-07-21).**
`ParallelCascade` arm 6 calls `searchJamRestarts` with the stock caps, so at
the 300s/arm browser budget it gets roughly FOUR restart rounds; seed 8697
needed 110. Config eval at the 300s browser budget (7 hard-family instances,
graded by mean minJamTerm since none SOLVE at 300s — the family is that hard):

| config | mean minJamTerm | best | vs stock |
|--------|-----------------|------|----------|
| stock-jam        | 40.0 | 8 | —    |
| cap150k-e32      | 31.4 | 8 | -21% |
| cap60k-e64       | 28.6 | 8 | -29% |
| luby60k-e32      | 24.0 | 8 | -40% |
| **luby20k-e64**  | **21.7** | **4** | **-46%** |

Monotonic: more rounds descends the ratchet deeper, and Luby-shaped rounds
descend deepest. CAVEAT: NOTHING solved at 300s — this is "the browser jam arm
gets substantially closer," not "the hard tail solves in-browser."

**SHIPPED (2026-07-21).** Luby (base cap 20000, 64 elites) wired into the
jam-restart arm at all three production call sites — `ParallelCascade.h` arm 6
(browser threaded portfolio), `main.cpp` cascade `jamrestart` stage
(native/CLI), and `wasm_bindings.cpp` `runJamArm` (wasm cascade + the TS
portfolio `jam` arm, which inherits the new wasm defaults). All gated by the
existing jamProfile(); the wasm keys stay opt<>-overridable so the
caller-facing `jam` engine can still sweep. Regression gate PASSED: native
gtests green (LubyUnit, JamRoundShaping zero-touch-defaults, JamRestarts
validity, ParallelCascade race); 84-fixture cascade diff vs the pre-Luby
stock-jam baseline (bench/after-cascade.json, same cascade/w3/60s/20M) =
"No regressions" — zero fixtures lost, identical turns/steps everywhere (two
boards shifted node counts with unchanged solutions, benign). Not yet
committed — staged in the working tree for review.

**Trajectory checkpoints are samples, NOT a difficulty gradient — do not
binary-search them.** A checkpoint at walk index k is a valid same-class
instance, but the walk is DIFFUSIVE: measured on 23444, a ~9.9k-turn window
net-moves all 18 blocks (one by 20 cells), so checkpoints ~10k apart are
near-independent draws from the shuffle distribution and solvability is NOT
monotone in k. An early bisection here produced a convincing but meaningless
"sharp cliff" (k=207190 solved in 3.0s, k=197324 unsolved after 903s/93M
states) — that is sampling noise between independent configurations, not a
gate. The valid use is SAMPLING: classify many checkpoints at a fixed budget
to measure the hard fraction of the board's distribution and bank a FAMILY of
same-class hard instances (tuning has only ever had all-or-nothing boards).

Generalization evidence: the 500-board fuzz sample surfaced fresh jam board
seed 1117 (17x13, 47%, aspect 1.3 — profile fires), which the ENTIRE old
cascade fails at 30s/stage; the new jam arm solves it in 223s (111t/30s,
first restart round) — a board never used for tuning, cracked within the
browser arm budget.

Ruled out with recorded evidence (see the IIT-21 plan/memory) and since
REMOVED from the codebase: bidirectional meet-in-middle, deadlock-pattern
pruning (vacuous by reversibility theorem), jam-mode assembly (even given
the ground-truth pre-shuffle arrangement), unit pair PDBs (1.73x speedup on
12366 but no new cracks). Still in the tree: relevance+POR (production jam
arm).

**Frontier BFS and frontier→dive were removed on 2026-07-23.** Every depth
bound quoted in this file was proven by them and stands as recorded history,
but the engines needed a filesystem and 8-17GB of RAM, so they could never
run in the browser — the one place the solver actually has to work. Their
surviving descendant is the guided beam arm (`--engine beam`), which applies
the same breadth-over-a-flat-gradient strategy inside a browser heap. The
escalation they pointed at (disk-based visited sets, ~x1.6 resources per +1
depth, or a bits-32 34GB hash) was already out of budget when they were
live; recover them from git history if that ever changes.

## Campaigns v3-v5 and the shipped-path audit (2026-07-25/27, IIT-21)

Everything below was measured against `--engine parallel`, a CLI engine added
in this work that calls `solveArmsParallel` directly — the SAME function the
threaded wasm build runs for a cross-origin-isolated page. The older campaigns
used `--engine cascade`, the SEQUENTIAL chain, which is a different algorithm;
measuring that and reporting it as browser behaviour was an error corrected
here.

| campaign | seeds | config | result |
|---|---|---|---|
| v3 | 30000-39999 | sequential cascade, 30s/stage | 9,984 sweep, 9,993 after a partial ladder |
| v4 | 40000-49999 | **shipped race**, 300s | **9,995 / 10,000**, 0 invalid |
| v5 | 52000-61999 | shipped race, relaxed jam gate, deadline enforced, 8GB cap | **9,994 / 10,000**, 0 invalid, **0 boards over budget** |

v4 vs v5 is the comparison that matters: same solve rate, but v4 had FOUR
boards exceeding their own 300s budget (worst 789s) while v5's maximum is
278s. The budget became real without costing solve rate.

### The budget was never enforced (fixed)

`AStar::search` runs up to three passes (guided, stride-1, BFS fallback) and
handed each the full `maxMs`, while `runAStar` restarts its clock per call — a
3x ceiling. `DragSolver::search` already passed an absolute deadline; AStar was
the outlier. Two suspects were investigated and CLEARED by measurement, noted
so they are not re-investigated: the post-processor (`--no-post` was no faster,
618s vs 601s on seed 45501) and solver teardown (60-79ms).

The residual overshoot was `std::unordered_map` rehashing — relinking tens of
millions of separately-allocated nodes inside one loop iteration, which no
deadline check can preempt. Replacing the state map (below) took the overshoot
from 1.2-1.4x down to 1.02-1.13x.

### Memory, not time, bounds the hard tail

Of 19 hard-tail boards profiled at 8GB: the 8 that FIT solve in <= 71s against
a 300s budget; the 11 that do not need 13-28GB. Nothing lies between 6.6GB and
13GB. Raising the time budget cannot help this class — heap is the lever, and
the browser races all 8 arms inside ONE shared heap (8GB memory64, 4GB wasm32;
verified in Chrome 150 that `threads-mem64` is the variant actually selected).

Per-arm peaks differ by ~100x, which is how one arm starves seven others:

| arm | seed 48368 | seed 45501 |
|---|---|---|
| drag | 14.2GB | 26.8GB |
| unit | 8.7GB | 14.2GB |
| hier | 4.2GB | 12.0GB |
| corridor | 3.1GB | 9.4GB |
| jam | 1.6GB | 5.7GB |
| beam | 0.16GB | 0.49GB |

### Per-state footprint: 462 -> 282 bytes (measured, seed 45501)

`NodeKey` is 48 bytes and was stored 3-4x per state (map key, the parent link,
every open-heap entry, `nodeStore`). Two changes, both verified BIT-IDENTICAL
across 111 fixture/engine runs — nothing iterates the state maps, so a pure
representation change cannot alter which states are explored:

1. Parent links and heap entries became pointers into the map: `StateInfo`
   72->32, `DragHeapEntry` 64->32, `AStar::StateInfo` 64->24, and popping a
   state no longer costs a `find()`. **462 -> 369 B/state.**
2. `StateTable` (new) replaced `std::unordered_map`: an open-addressed index
   table over a block arena whose entries never move — required, because the
   pointers from step 1 must stay valid, and a textbook open-addressing table
   relocates on growth. **369 -> 282 B/state**, and states explored in a fixed
   120s rose 27.9M -> 33.7M (+21%) with a malloc per state gone.

Net: the browser's 8GB heap holds ~30.5M states instead of ~18.6M.

### jamProfile() gate relaxed to 4.125x aspect / 35% density

The gate excluded boards the jam machinery solves outright. Both legs had to
move together: on seed 41193 (37x9, 39.0% density) relaxing either alone
changes nothing, because it fails both. Full treatment — 56-fixture bench diff
(0 regressions, 1 new solve: `fuzz-3058-hard` 131.7s -> 11.2s), 2,000-board
paired fuzz (0 regressions, 0 invalid), then campaign v5.

Converted from unsolvable to won IN THE RACE: 41193 (49s), 42889 (179s) and
45501 (201s) — the last previously profiled at 26.8GB and written off.

### Arm ranking on boards the race LOSES

All 8 arms run standalone against the 12 race-losing boards (96 runs, 300s and
8GB each, ungated) — the population the sequential fallback actually serves:

| arm | wins/12 | median win | fastest |
|---|---|---|---|
| jamrestart | **7** | 81s | 11ms |
| unit | 1 | 52s | |
| jam | 1 | 77s | |
| corridor | 1 | 251s | |
| hier / drag / assembly / jambeam | 0 | | |

Nearly the INVERSE of the easy-board distribution (2,000 fuzz boards: unit 45%
of wins, corridor 35%, jamrestart 1.5% and fifth). Ordering the sequential
phase from general fuzz statistics would have put the only arm that wins hard
boards last. 4 of the 12 (41926, 48368, 60672, 60758) are solved by no arm.

### Two-phase solve

When the race returns empty, the same arms re-run ONE AT A TIME, each with the
whole heap and UNGATED, ordered by the table above. Measured recoveries: 41193
(gate-excluded — arm 6 solves it in 12ms) and 42889 (starved — arm 2 needs
6.24GB, which the shared heap never leaves free). A control board fails bounded
at the phase cap. The UI announces the phase, because it is much slower.

### Methodology notes worth keeping

- `--max-nodes` bounds nodes per SEARCH PASS, not per run. `hier` starts a pass
  per segment and `jam` one per restart round, so both ignore it in aggregate
  and run to the wall clock — which also makes them useless as a determinism
  baseline. Only `drag` and `unit` are genuinely node-bounded.
- `--engine jam` is NOT arm 6: it builds a default config without Luby restarts
  or 64 elites. Measuring it and calling the result "per-arm" compares the
  wrong solver — it produced the false conclusion that no arm could solve seed
  45501, which arm 6 wins in 142s. Use `--engine arm --arm N`, which routes
  through `cascade::runArm` and therefore cannot drift from the race.
- The shipped race is NONDETERMINISTIC, so "identical solved set" is an
  unachievable bar for boards finishing within ~10% of the deadline. Seed 50329
  failed one sweep then solved 3/3 on re-run (299-307s), won by a DIFFERENT arm
  each time. Compare solved sets excluding that band.
- Fixtures regenerate bit-exactly from `--generate --seed N --shuffle 1000000`,
  so campaign artifacts need not be preserved. Do keep them out of the
  `test-results/` root: Playwright's default `outputDir` is that directory and
  it WIPES it, which destroyed the v3 and v4 artifacts once (now scoped to
  `test-results/playwright`).
- Run heavy boards SEQUENTIALLY. Two concurrent hard boards committed 44GB
  against 32GB physical and drove the machine into the pagefile.

### Correctness bugs found by review (2026-07-27)

- The `valid` field the fuzz harness reports came from a goal-position-only
  replay: no bounds check, no collision check. Every "0 invalid" claim before
  this date could not have detected an illegal plan. Now backed by the BitGrid
  legality replay that previously only `--verify` reached.
- `ParallelCascade.h` re-declared the jam-gate defaults (42/40) as function
  default arguments, so the relaxation above never reached the wasm callers
  that omit them: the browser ran the OLD gate while the CLI ran the new one.
- `settledOnly` tested the raw `progressIndex_` table instead of mirroring
  `progressOf()`, so on a 0-cut board the winning drag home was filtered out
  entirely — crippling the 4 of 8 arms that set it, plus `searchAssembly`'s
  final goal leg.
- `searchBeamJam` decoded a symmetry-CANONICALIZED key into per-block anchors,
  so round 0's plan always failed replay on any board with same-shape blocks.
- The COI shim's reload was keyed on `!serviceWorker.controller`; the shim
  calls `clients.claim()`, so a controller exists while the DOCUMENT is still
  un-isolated, and first visits silently fell back to the non-threaded
  portfolio. Key it on `!crossOriginIsolated`.

## Solved — kept as regression/benchmark cases

| seed  | board  | status |
|-------|--------|--------|
| 12366 | 10x13, 72% | solved OPTIMALLY by frontier BFS: 24 drags / 52 turns (596s, 158M states); unit engine needs ~790s for 38 drags |
| 3058  | 9x24, 42%  | solved by long-budget rerun; failed at both 1M and 10M shuffles (difficulty is structural) |
| 3086  | 44x8, 33%  | from the 10M-shuffle partial run; solved by cascade at longer budget |
| 1022  | 11x50, 22% | 100k shuffles, seed-base 1000 campaign; 0 real cuts + 37-anchor goal journey — the board that motivated the corridor-band lever (now solves in ~86ms) |
