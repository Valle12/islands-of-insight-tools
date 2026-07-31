# The three captured boards nothing proves

`matchThreeTest47`, `matchThreeTest50` and `matchThreeTest51` are the boards
`test/match-three-solver/engine.solve.slow.test.ts` names in `BEYOND_BUDGET`.
They are legal game states like every other fixture; what no engine here can do
is exhaust every shorter length for them. This file records what each of them
actually costs, so the next attempt starts from measurements rather than from
scratch.

**All three now have a witness** (2026-07-31). That is new — test50 and test51
had never produced one from any arm at any budget. What settled both was NRPA
with restarts; the story is under "NRPA, and why restarts are the whole trick"
below. Every one of the three is still *unproven*, and the reason has not
changed: exhausting the nineteen-to-twenty-two shorter lengths is orders of
magnitude away.

| | moves | found by | cost |
| --- | --- | --- | --- |
| test47 | **20** (proven optimal in a 46-min run) | `bnb`, or nrpa seeds 0/7 | 8–15 s |
| test50 | **23** | nrpa, 6 of 8 seeds | 0.9–32 s |
| test51 | **15** | nrpa, 8 of 8 seeds | 1.9–12 s |

| | test47 | test50 | test51 |
| --- | --- | --- | --- |
| Size | 11×12 | 9×23 | 13×14 |
| Blocks | 69 | 105 | 90 |
| Distinct symbols | 8 | 8 | 5 |
| `maxDepth` = ⌊blocks/3⌋ | 23 | 35 | 30 |
| Legal moves at the root | 19 | 14 | 24 |

## What each engine gets (measured 2026-07-31, one core)

| | test47 | test50 | test51 |
| --- | --- | --- | --- |
| TS engine, 30 s | nothing, ruled out 9 | nothing, ruled out 8 | nothing, ruled out 7 |
| TS engine, 120 s | **20 moves** | — | — |
| TS engine, 300 s | — | nothing, ruled out 10 | nothing, ruled out 10 |
| native cascade, 30 s | **20 moves**, ruled out 8 | nothing, ruled out 8 | nothing, ruled out 7 |
| native cascade, 300 s | **20 moves**, ruled out 13 | nothing, ruled out 10 | nothing, ruled out 10 |
| the page, isolated, 6 arms, 300 s | **20 moves in ~25 s**, ruled out 10 | nothing, ruled out 10 | nothing, ruled out 9 |

The page row is Chromium on the real dev server, cross-origin isolated, with the
in-module race live. It gets through ~320 M positions in the 300 s budget (about
1.07 M/s across six threads) and still finds nothing on test50 or test51.

`20 moves` is the optimum: a deepening run with the budget lifted proved it
minimal in 46 min 42 s (2026-07-31, before this work). So both engines find the
best possible answer for test47 in seconds — neither can prove that no 19-move
answer exists.

## Why the proof is out of reach, and what the arms actually do

Cost per extra depth level measures ×2.4–2.9 in both time and states, in both
engines. Proving test47 minimal means exhausting depth 19; 300 s of native
search reaches 13. That is six levels short, or roughly 2.5⁶ ≈ 250× more time —
not something a budget bump, a faster kernel, or a handful of threads closes.

What DOES work is the **dive** (`bnb`): one depth-23 search covers every path of
length ≤ 23, so it can stumble onto a 20-move answer where a deepening search
would have to climb through nineteen exhausted levels first. This is the whole
reason test47 turned from "Gave up" into a real answer, and it is why the
TypeScript engine gained the same arm (`Search.runDive`).

test50 and test51 resist even the dive. Both are wider at the root (14 and 24
legal moves, sustained after a move) and deeper (35 and 30). Neither produced a
single witness from any systematic search — the arm that eventually cracked both
does not search systematically at all.

## NRPA, and why restarts are the whole trick

Nested Rollout Policy Adaptation (`SearchNrpa.cpp`, `nrpa.ts`) holds the records
on SameGame and Morpion Solitaire, and SameGame is close enough to this puzzle —
clear groups of like-coloured blocks under gravity — that the transfer was worth
trying. It found test51 immediately (15 moves, 1.9 s) and test50 not at all,
until three separate things were fixed. Each one is load-bearing:

**1. The greedy arms barely randomised.** Their score was
`alive*1e6 + cleared*256 + rng()*255`, and that noise term is strictly *smaller
than one unit of `cleared`*, so it could only break exact ties. Measured on
test51: **4000 restarts produced two distinct outcomes.** Softmax sampling over
`cleared` (temperature 3, best of four policies tried) took the same rollouts
from 19 blocks stuck to 7 left, and 2 → 1517 distinct outcomes. A noise term
smaller than one unit of the score it perturbs is not randomisation.

**2. NRPA optimises fewest-blocks-left, so its best line is usually PARTIAL.**
Returning it as a solution emitted a move list that does not clear the board.
`fixtures_test` caught it. Both engines now return a solution or nothing.

**3. It gave up with two thirds of its budget unspent.** A level-N search
exhausts its iterations and returns; on test50 the losing runs came back after
~16 s of a 45 s slice and the arm simply stopped. Restarting with a fresh policy
took test50 from **2 of 8 seeds to 5 of 8**, and leading the restart ladder with
its cheapest rung took it to **6 of 8**.

### The plateau is usually a proven dead end

This is the measurement that explains everything above. NRPA plateaus on test50
at 7–9 of 105 blocks left. Harvesting four plateau states and handing each to the
exact prover — the endgame is tiny, so `unsolvable` there is a real proof —
`src/util/harvestMatchThree.ts`:

| seed | plateau | endgame verdict |
| --- | --- | --- |
| 0 | 9 left after 20 moves, 27 000 playouts | **proven unsolvable** |
| 1 | — | **SOLVED, 23 moves** |
| 2 | 9 left after 20 moves, 26 958 playouts | **proven unsolvable** |
| 3 | 7 left after 20 moves, 27 000 playouts | **proven unsolvable** |

So a run that plateaus has not run out of search — it has run out of *this
policy*, and no amount of extra time on a dead attractor helps. That is the whole
argument for restarts, and it is why the arm now restarts instead of grinding.

### The restart ladder, and the mistake worth not repeating

No single rung wins everywhere. At a fixed 45 s on test50, seed 4 answers *only*
to level 4 (1.6 s) and fails at both 2 and 3; seeds 0 and 1 answer only to level
2. So cycling the level across restarts is right — but the first two attempts at
it both went *backwards*, and the reason is worth writing down.

A rung costs `iterations ^ level` playouts. The natural-looking counts are wildly
unequal:

| rung | playouts | ≈ wall time at ~1700 playouts/s |
| --- | --- | --- |
| level 2 × 100 | 10 000 | 6 s |
| level 3 × 30 | 27 000 | 16 s |
| level 4 × 20 | **160 000** | **94 s** |

A 45 s slice cannot hold that last rung at all. A ladder containing it gets one
cheap restart, one medium one, and then nothing — the expensive rung swallows
every second that was left. Measured on test50, eight seeds, 45 s each:

| configuration | test50 | test47 | test51 |
| --- | --- | --- | --- |
| level 2 × 100 pinned, no cycling | **6 / 8** | — | 8 / 8 |
| level 3 × 30 pinned, no cycling | 5 / 8 | 2 / 8 | 8 / 8 |
| ladder {3×30, 2×100, 4×20} | 4 / 8 | 2 / 8 | 8 / 8 |
| ladder {2×100, 3×30, 4×20} | 2 / 8 | 4 / 8 | 8 / 8 |
| ladder {2×100, 3×22, 4×10} — equal cost | 2 / 8 | **5 / 8** | 8 / 8 |

Equalising the rungs is right — it is what makes the level a diversity axis
rather than a lottery on how much budget the cycle happens to reach, and it is
what the ladder ships (all three rungs ~10 000 playouts). It bought test47 its
best rate of anything measured.

**But it did not rescue test50, and that is the real conclusion of this table:
no single NRPA configuration wins both boards.** test50 wants the cheap rung over
and over (6/8 pinned, 2/8 cycling); test47 wants the level to vary (5/8 cycling,
2/8 pinned). Chasing one number kept costing the other, across five
configurations, which is the point at which the answer stops being "tune it".

So the portfolio races **both**: `kPortfolio` carries one nrpa arm pinned at level
2 × 100 for test50, one on the ladder for test47, and a second pinned arm for a
redundant test50 draw. That is what a portfolio is for, and it is why no further
tuning was done here.

### Two bounds the restart loop needs

- **`kBarrenRestarts = 64`.** Restarts are otherwise unbounded on a board nothing
  can clear: `best_.left` never reaches 0, so the loop spins to the deadline and
  the prover waits out the whole slice before it can say `unsolvable`. Four unit
  tests timed out on exactly that. The counter is on *barren restarts*, not on
  restarts-since-improvement-within-a-run: on test50 the winning restart goes from
  9 blocks left straight to 0 while every other restart also reaches 9, so
  "stop when nothing is improving" would cut off precisely the draw that wins.
- **A stranded-symbol check at the root.** A symbol already down to one or two
  blocks can never line up again, so no playout can clear the board. Exact, free,
  and it is the difference between the prover being told immediately and the
  slice being spent first.

Bounding the loop also took the whole `bun test` suite from 596 s to 366 s.

Its per-seed nature is also why the portfolio now races **three** nrpa arms with
different seeds rather than one arm thinking longer: a seed is an independent
draw.

## Why the tree stays wide (measured, distinct states per depth)

| depth | test47 states | ×prev | test50 states | ×prev | test51 states | ×prev |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 19 | — | 14 | — | 24 | — |
| 2 | 186 | 9.8 | 128 | 9.1 | 302 | 12.6 |
| 3 | 1 232 | 6.6 | 878 | 6.9 | 2 531 | 8.4 |
| 4 | 6 107 | 5.0 | 4 906 | 5.6 | 15 315 | 6.1 |
| 5 | 23 851 | 3.9 | 23 146 | 4.7 | 69 375 | 4.5 |
| 6 | 75 272 | 3.2 | 94 303 | 4.1 | 240 026 | 3.5 |
| 7 | 194 680 | 2.6 | 336 390 | 3.6 | — | — |

Branching *does* decay — 10× at the root to under 4× by depth 7 — and it still
loses. Extrapolating test50's 3.6× to the depth 29 its block count implies is a
number not worth writing down; even test47's depth 19 comes out somewhere
between a day and a few weeks of continuous search, depending on how much
further the decay goes.

The reason the board stays crowded is arithmetic: a move clears 3.5 cells on
average, so ten moves into test50 only about a third of its 105 blocks are gone.
Measured at depth 7, its states still hold **48 to 81** blocks.

## Why the deadlock prune helps test47 and not test50

`hasStrandedSymbol` (a symbol down to one or two blocks can never line up again)
is the load-bearing prune, and how hard it bites depends entirely on the board's
symbol counts:

| | symbol counts | children killed at depth 6 |
| --- | --- | --- |
| test47 | 12, 9, 6, 12, 6, 6, 6, 12 | **19 %** (17 631 of 92 903) |
| test50 | 18, 18, 18, 21, 3, 9, 9, 9 | 1 % (952 of 95 255) |
| test51 | 20, 23, 12, 16, 19 | 0.8 % (1 986 of 242 012) |

test47's four six-block symbols reach one-or-two quickly, so whole branches die
early. test50 and test51 keep 9–23 blocks of everything, so almost nothing dies.
**That difference, not size, is why test47 is the crackable one.**

The check is also arithmetically complete: every count ≥3 can be written as a sum
of removals of ≥3 (3, 4, 5, 3+3, …), so one and two are the only counts a
counting argument alone can refute. There is no cheap extension here.

## Ideas measured and rejected

- **Region decomposition — refuted 2026-07-31.** Rolling-blocks got its biggest
  win from it, and these boards *look* like candidates: big regular blockade
  walls, test51 nearly four columns of play. A block genuinely cannot leave its
  4-connected component of non-blocked cells (swaps are adjacent, gravity is
  within a column), so a per-component count of 1 or 2 would be just as dead as
  a global one — and invisible to the global check. **All three boards are ONE
  component.** The walls never close; the bottom rows join everything. Measured
  over the whole depth-1..6 frontier of each board, a per-component check kills
  exactly **zero** states the global check does not. The walls make the boards
  look decomposable and they are not.
- **Raising the budget.** ×2.5 per level makes every arithmetic increase
  irrelevant, and the old unbounded table died at 19 GB RSS long before time
  ran out. The bounded table (256 MB/arm) removed the crash, not the wall.
- **A "remaining × 3 cells" admissible bound.** A move clears *at least*
  three cells, never at most — one swap can cascade the whole board away — so
  the bound cuts off exactly the cascade solutions worth finding. Tried in the
  TypeScript engine and reverted; `engine.test.ts`'s `CASCADE_CLEARS` is the
  case that catches it.
- **The alignment bound — derived, correct, and far too weak. Measured
  2026-08-01, do not rebuild it.** This is the one genuinely admissible lower
  bound this puzzle has, so it is worth writing down properly, and worth writing
  down that it does not pay.

  The argument. A block changes column **only** via a horizontal swap, exactly
  one column at a time — gravity and cascades are vertical. A swap of two *equal*
  symbols is not a legal move (`rules.ts`, `Rules.cpp`), so a horizontal swap
  moves exactly two blocks of two *different* symbols by one column each.
  Therefore **per move a given symbol gains at most one unit of horizontal
  displacement**, and a move contributes at most two units in total. To clear
  symbol `s` at all, three of its blocks must at some point be
  collinear-adjacent: three in one column, or one in each of three consecutive
  columns of one row. Blocks are never created, so those three come from the ones
  present now. Let `cost(s)` be the least total horizontal displacement reaching
  either shape (vertical positions treated as free, which is what keeps it
  admissible — it under-estimates). Then

      moves >= max_s cost(s)                and    moves >= ceil(sum_s cost(s) / 2)

  Take the max of both. Unlike the rejected `remaining × 3` bound this one is
  immune to cascades, because cascades move nothing horizontally.

  What it is worth: **nothing.** Computed over the full depth-1..5 frontier of
  test47, test50, test51, test44 and test13 — about 15 000 states — it pruned
  **zero** of them.

  | board | root bound | max bound seen to depth 5 | what the prover already proves |
  | --- | --- | --- | --- |
  | test47 | 1 | 7 | 13 |
  | test50 | 7 | 7 | 8–10 |
  | test51 | **0** | 0 | 9–10 |
  | test44 | 2 | 4 | 14 (proven optimal) |
  | test13 | 6 | 9 | 10 (proven optimal) |

  The bound is below what the deepening already establishes on every single
  board, and on test51 it is identically zero at every state — a board with five
  symbols and 90 blocks always has three of something nearly aligned. The
  "vertical positions are free" relaxation is what costs most of the strength,
  and tightening it means reasoning about which vertical arrangements gravity can
  actually produce, which is a much harder problem than the one being solved.
