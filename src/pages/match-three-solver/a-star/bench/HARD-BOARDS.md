# The three captured boards nothing proves

`matchThreeTest47`, `matchThreeTest50` and `matchThreeTest51` are the boards
`test/match-three-solver/engine.solve.slow.test.ts` names in `BEYOND_BUDGET`.
They are legal game states like every other fixture; what no engine here can do
is exhaust every shorter length for them. This file records what each of them
actually costs, so the next attempt starts from measurements rather than from
scratch.

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
legal moves, sustained after a move) and deeper (35 and 30), and neither has
produced a single witness in any run so far.

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
