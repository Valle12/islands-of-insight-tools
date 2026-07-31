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

## The one idea worth trying next

All three boards are close to left-right mirror-symmetric and carry large
regular blockade walls — test51 in particular is nearly four separate columns of
play joined at the bottom. Rolling-blocks got its biggest single win from
**region decomposition** (a footprint cannot straddle an unplayable cell, so
regions are independent sub-puzzles). Match-three has no such clean argument —
gravity and cascades cross column segments — but a weaker version might hold:
symbols confined to one blockade-walled column group can only ever clear within
it, so the board may split into sub-problems whose solutions concatenate.
Confirming or refuting that on test51 is the highest-value next experiment.

Ideas already measured and rejected:

- **Raising the budget.** ×2.5 per level makes every arithmetic increase
  irrelevant, and the old unbounded table died at 19 GB RSS long before time
  ran out. The bounded table (256 MB/arm) removed the crash, not the wall.
- **A "remaining × 3 cells" admissible bound.** A move clears *at least*
  three cells, never at most — one swap can cascade the whole board away — so
  the bound cuts off exactly the cascade solutions worth finding. Tried in the
  TypeScript engine and reverted; `engine.test.ts`'s `CASCADE_CLEARS` is the
  case that catches it.
