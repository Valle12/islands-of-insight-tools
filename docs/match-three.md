# Match-three: the solver, the encoding and the rendering

Long-form notes split out of `CLAUDE.md`. Read this before touching
`src/pages/match-three-solver/` or its `a-star/` engine.

## The match-three solver

The rules are in `rules.ts` and the TypeScript search in `engine.ts`; both are pure and synchronous so the unit tests never touch a worker. `src/pages/match-three-solver/a-star/` holds a second engine in C++, and `rules.ts` remains the **definition of record** for both: `solutionView.ts` renders a solution by replaying it through `rules.applyMove`, so a witness those rules refuse is unplayable no matter which engine produced it.

The rules, unchanged by any of the optimization work:

- **Matches** are the union of every horizontal run ≥3 and every vertical run ≥3. `+`, `T` and `L` need no special case — they are just cells that both passes mark. Gravity is per column and stops at `BLOCKED`, so a column is a set of independent segments; clear/drop repeats until stable (a *cascade*).
- **A move** swaps two orthogonally adjacent cells that are both blocks and hold different symbols, and is legal only if it clears something. Candidate generation only probes right/down neighbors (all four would offer each swap twice) and only checks the two moved cells, since a new match must pass through one of them.
- **The board must already have settled.** `boardProblem` refuses a floating block or a line still standing rather than repairing it — solving a repaired board would answer a puzzle the player never had. This is a *solver*-level check, deliberately not a validator one: `config.ts` passes any well-formed file, so the editor will happily hold a half-drawn board that Solve then refuses by name.
- **The forced-single-clear bound** (`forcedClear.ts`, `a-star/ForcedClear.h`) is the one admissible lower bound that pays, and it is a prune in both provers. Every clear takes ≥3 blocks of the symbol it clears, so a symbol at exactly **4 or 5** blocks must lose all of them in ONE clear — taking 3 strands the rest. All of them must therefore reach one clearing shape, and that costs moves: a block changes column only via a horizontal swap of one column, and such a swap moves blocks of two *different* symbols, so a symbol gains at most one unit of horizontal displacement per move. Measured while the search still proved: test47's `ruledOut` went 11 → 12 at a 60 s budget, with *fewer* nodes — the prune survived the drop of proving because it is a prune, not a proof. **Four cells can only clear as a straight run of four, but five can also clear as a T/L/plus** (perpendicular 3+3 sharing a cell) — pricing five as a straight run only would over-estimate, and an over-estimating bound in a prover is not conservative, it is wrong. `forcedClear.test.ts` pins that case.
- **Region decomposition does not apply**, unlike the rolling-blocks cascade's. Measured: all three hard boards are ONE 4-connected component, and splitting on the depth-1..6 frontier killed zero extra states. Gravity plus cascades couple the whole board.
- **Do not add a "`remaining` moves clear at most `remaining * 3` cells" prune.** A move clears *at least* three, never at most: one swap can cascade the whole board away. That bound was tried and it cut off exactly the cascade solutions (caught by `engine.test.ts`'s `CASCADE_CLEARS`). There is consequently **no admissible lower bound at all**, which is why nothing here is A*-shaped: pressure has to come from above, as an upper bound to search under.
- The load-bearing prune is the **stranded symbol** — a symbol down to one or two blocks can never line up again. Both engines keep per-symbol counts incrementally and check them in O(1) per node rather than rescanning the board.

**The search stops at the first solution it can play, and claims nothing about its length.** `SolveResult` is `{status:"solved", moves}` | `{status:"unsolvable"}` | `{status:"budget"}`:

- There is no `proven`, no `groupingProven` and no `ruledOut`. Proving a length minimal was the whole reason the hard boards ran to the budget, and it bought almost nothing. The measurement behind that: of the 52 captured boards, 49 have a PROVEN optimum to compare a first find against — the other three are the stochastic NRPA boards (`matchThreeTest47/50/51`), whose best known lengths are ceilings, not proofs — and over those 49, run through the page's portfolio, **the first solution found is the minimal one on 48**: only `matchThreeTest46` pays (8 moves where 7 exist). One more board pays in one execution mode only — the single-arm native cascade returns 21 for `matchThreeTest47` where 20 is the best known; the page's portfolio still returns 20.
- `unsolvable` is the ONE proof left, and it is about existence rather than length: reached by exhausting `maxDepth = floor(blocks / MIN_RUN)`, which terminates on its own because every move clears ≥ MIN_RUN cells.
- `budget` means nothing was found. It no longer carries a number, because nothing is being ruled out.
- The page opens the solution viewer by itself the moment a solution arrives. There is no "not proven to be the shortest" note and no "Stop — use best so far" button; Cancel is a plain cancel, and reaching it means nothing was found.

**The arms, in the order they run.** Both engines have the same set (`fastSolvers.ts` + `engine.ts` in TypeScript, `Search*.cpp` + `SolverArms.cpp` in C++), and both give the fast ones a *cap* on the budget rather than a floor, so an easy board pays nothing for them:

1. **greedy** — rollouts, biggest clear first, refusing to strand a symbol unless every move does. Rollout one is purely greedy; every restart after it samples from a softmax over `cleared`. Measured over all 52 captured boards with the arm run alone: **it answers 38, and every one of those 38 answers is already the proven optimum, worst case 4 ms.** It says nothing about the other 14. Gives up after 60 restarts without an improvement.
2. **beam** — level-synchronous over move count, widening 128 → 512 → 2048. Never shortened anything greedy found on this corpus.
3. **NRPA** (`nrpa.ts`, `SearchNrpa.cpp`) — Nested Rollout Policy Adaptation: a weight per move code, playouts sampling ∝ `exp(weight)`, each nesting level nudging the policy toward the best sequence it saw. **This is the arm that cracked `matchThreeTest50` (23 moves) and `matchThreeTest51` (15–16) — both of which every systematic arm returns nothing for at any budget**, and on the page it is also what answers `matchThreeTest47` at 20 rather than the exhaustive search's 21. Its details are the subject of `a-star/bench/HARD-BOARDS.md`; three things about it are load-bearing and easy to undo:
   - **It optimizes fewest-blocks-left, so its best line is usually PARTIAL.** Returning that as a solution emitted a move list that does not clear the board (`fixtures_test` caught it). An arm returns a solution or nothing.
   - **It must RESTART when a level-N search exhausts its iterations**, with a fresh policy. Without that it stopped with two thirds of its slice unspent; restarts took test50 from 2 of 8 seeds to 5 of 8. The reason is measured: a plateau state is *provably dead* 3 times in 4 (`bun run harvest:mt` harvests them and hands each to the exact prover — the endgame is tiny, so `unsolvable` there is a real proof). A run that plateaus has run out of *this policy*, not out of search.
   - **The restart loop needs two bounds or it spins on a dead board.** `kBarrenRestarts = 64` (measured: four unit tests timed out without it, and it took the whole `bun test` from 596 s to 366 s), plus a stranded-symbol check at the root. The counter is on *barren restarts*, deliberately NOT on restarts-since-improvement: test50's winning restart jumps from 9 blocks left straight to 0 while every other restart also reaches 9, so the tempting version would cut off exactly the draw that wins.
   - **The restart ladder's rungs cost the same on purpose** (~10 000 playouts each). A rung is `iterations ^ level` playouts, so the natural-looking counts are 16× apart — level 4 × 20 is 160 000 playouts, about 94 s, more than a whole slice, and a ladder containing it gets two restarts and then nothing.
   - **No single NRPA configuration wins both hard boards, so the portfolio races two.** Measured over eight seeds at 45 s: level 2 × 100 pinned takes test50 6/8 but test47 2/8; the cycling ladder takes test47 5/8 but test50 2/8. Five configurations were tried and each gain cost the other board. `kPortfolio` therefore carries one pinned arm, one ladder arm, and one redundant pinned arm — do not "simplify" them to one config.
   - Success is **per-seed** as well as per-config, so more arms beat one arm thinking longer.
4. **`exhaustive`** — one pass at `maxDepth`, returning the moment it finds anything. It is both the finder of last resort (it answers `matchThreeTest47`) and **the only arm that can report `unsolvable`**, which it does by searching that depth out with nothing found. It inherits whatever the cheaper arms did not spend. This replaced two arms, `iddfs` and `bnb`: iterative deepening existed only to guarantee the first find was the shortest, and one dive to `maxDepth` does both jobs once that guarantee is dropped.

**Every arm is skipped once any witness exists**, since the search returns on the first one. `findsOnly` in the C++ cascade's leg list survives on `beam` and `nrpa` to say they could never have done anything else.

**A noise term smaller than one unit of the score it perturbs is not randomisation.** The greedy arms scored `alive*1e6 + cleared*256 + rng()*255`, so the noise could only break exact ties: measured on test51, **4000 restarts produced two distinct outcomes.** Real sampling took the same rollouts from 19 blocks stuck to 7 left, and 2 → 1517 outcomes. Worth remembering anywhere a "randomised restart" is not diversifying.

**The transposition table is bounded and evicts** (`transTable.ts`, `TransTable.h`): 4-bit-packed exact keys in a flat `Uint32Array`, 4-way buckets, a 256 MB ceiling per arm. Eviction is sound — an entry only ever prevents re-searching a subtree already proven barren at that remaining depth, so losing one re-searches to the same conclusion, slower. What would be unsound is a **false hit**, which is why keys are compared in full and never by hash alone, or recording a budget-aborted subtree, which the `searchedOut && no solutions found` discipline excludes. Two measured traps live in those files:

- **The hash must avalanche.** The bucket index is the hash's LOW bits, and a bare multiply's low bits never see the operands' high bits; without a murmur-style finalizer, boards differing only in high-nibble cells all landed in one bucket and the grow-on-overflow path ballooned a 229-entry table to its ceiling, then evicted entries a live search still needed. A shadow-`Map` harness over a full solve is what caught it.
- **Do not resize the per-depth scratch mid-recursion.** A deeper frame's `emplace_back` on the `levels_` vector reallocates and leaves every enclosing frame's `Level &` dangling; it is sized once, up front.

This replaced a `Map<string, number>` whose ~200-char keys cost a measured 284 bytes each and grew without bound — the reason `matchThreeTest50/51` used to die at 19.1 GB and 7.4 GB RSS. At a 300 s budget they now hold ~500 MB flat.

**The budget is 60 s** (`SOLVE_BUDGET_MS`), and it now bounds only the boards where NOTHING is found — the search returns as soon as it has an answer. Measured on the real page over the 52 captured boards: **52/52 finish, total 16.9 s, median 104 ms, slowest 7.9 s**, so a minute is roughly eight times the worst case anything real has needed. Every test that leans on a budget still passes an explicit one.

**How the bridge races the two engines** (`solveClient.ts`). One `Merged` object collects from both sides — the TypeScript worker and every wasm arm — and it has one rule left, the load-bearing one: **a candidate is accepted only after being replayed through `rules.applyMove`.** `Merged.done` is then simply `alreadyClear || unsolvable || best !== null`, and the first accepted candidate ends the race. With no proving left, that replay is the ONLY thing between a bad witness and the viewer.

One case needs naming because a browser found it and no unit test would have: an **empty board**'s zero-move answer looks exactly like "this arm found nothing", so `Merged` knows a cleared board is its own answer.

**`WasmHandle.terminate` must set `settled`**, not just kill the workers. `retire` and `spawnNext` guard only on that flag, so a `done` message that reaches `finish()` synchronously falls through to `retire` and back-fills a FRESH worker after the portfolio was torn down — one that runs its whole budget with nobody listening. Rare while the race ended on a proof; the normal case now that the first witness ends it with most of the portfolio still queued.

`solutionView.ts` replays the move list through `rules.applyMove` rather than being handed board snapshots, so the engine stays the single source of truth. It marks **only** the two cells to swap (`data-swap="a"|"b"`, plus a `↔`/`↕` badge straddling the gap between them). Outlining what the move clears as well was tried and removed: on a move that takes a dozen blocks it left the board unreadable, and the step text gives the count anyway.

The step text names cells by **position, never by tile** — several tiles cannot be named usefully ("Purple 2", "Nude"), the ringed cells already say which two, and every symbol appended makes naming worse.

## The match-three cell encoding

`src/pages/match-three-solver/cell.ts` is the single definition: **a cell is one number**, never a string. `EMPTY = 0`, `BLOCKED = 1`, `FIRST_SYMBOL = 2`, and the symbol at index `i` of `symbols.ts` is stored as `FIRST_SYMBOL + i` — so `cells` in the config JSON is a flat integer grid and `isSymbol` is one comparison. Go through `symbolCell` / `symbolIndexOf` / `isSymbol` rather than open-coding the `+ 2`. The `data-kind` DOM attribute (`empty` / `blocked` / `symbol`) is a *rendering* detail for CSS and e2e selectors — it is not what the model stores.

## The match-three symbols

`src/pages/match-three-solver/symbols.ts` owns `SYMBOLS`, an ordered list of the game's own block tiles (`id`, `label`, and the PNG from `images/`). There is **no per-board palette**: a cell stores an index into this global list, the tool row always offers every symbol, and the config carries no symbol mapping at all.

**The list is append-only.** Inserting or reordering an entry silently repaints every board ever saved, because saved boards reference symbols by index. Appending is always safe and needs no migration — a board simply never mentions the indices it does not use, which is what lets new tiles land without touching existing fixtures.

Renaming an entry is safe — nothing is stored by name, only by position — but **moving one is not**. Index 2 was `pink` before the tile now at index 5 arrived; only the ids changed, the artwork stayed put.

To add one: drop a 96px PNG in `images/` (`ffmpeg -i in.png -vf scale=96:96:flags=lanczos out.png` if it is bigger — `pngDataUrl` inlines every PNG into the page as base64, so full-resolution art costs ~90 KB a tile), then append an entry to `SYMBOLS`. Nothing else needs editing: the chip row, the validator's cell ceiling and the e2e suite all read the list's length.

The chips show the tile and nothing else — with eight symbols a name beside each was noise. The label survives as the chip's `aria-label`/`title`, which is what `e2e/match-three-solver/symbols.ts` reads. `#tool-status` names the *kind* of tool only ("Color", "Blocked", "Eraser") for the same reason: which tile is selected is the highlighted chip's job to show, and printing "Purple 2" at the player was not useful.

`BLOCKER_IMAGE` is the game's blockade texture and is deliberately **not** in `SYMBOLS`: a blocked cell is the structural value `BLOCKED`, and giving it a slot would shift every index and repaint every saved board. It only renders alongside them — as the cell background, and as the chip that *leads* the row carrying `data-tool="blocked"` instead of a `data-symbol-index`. Any selector that means "the symbols" must therefore say `[data-symbol-index]`; an unscoped `.symbol-chip` includes the blockade.

Eraser and Reset are `md-icon` buttons (`ink_eraser`, `refresh`). Both names had to be added to the `icon_names` subset in `src/common/common.css` — without that they render as garbage text, not a missing icon.

Cells get their tile from a `--symbol-image` custom property set by `cellView.ts`, with `background-image: var(--symbol-image)` in the stylesheet. Not set as `background-image` directly, for two reasons: which image is a runtime choice but *that* it is the background is a rule, and happy-dom silently rejects a `background-image` whose URL is a Windows path — which is exactly what a PNG import resolves to under `bun test`, where there is no `pngDataUrl` plugin. Assert on `style.getPropertyValue("--symbol-image")`, never `style.backgroundImage`.

Because symbols are fixed and named, e2e assertions may use them: cells are labelled `Column 3, Row 2, Blue` and carry `data-symbol="blue"`. The e2e suite still does not import `symbols.ts` — Playwright's loader cannot resolve the PNG imports — so `e2e/match-three-solver/symbols.ts` reads the list off the page's own chip row instead, and appending a symbol needs no e2e edit.

## Match-three rendering (the reason a 32×32 board stays responsive)

Unlike the rolling-blocks page, this editor does **not** rebuild the grid on every edit. Three rules, all of them load-bearing at the 32×32 cap (1024 cells, where one full rebuild measures ~3.5 ms and a pointermove-per-cell drag would have run one per event):

- `Board.renderGrid` is the only full rebuild. It fills a `DocumentFragment` and `replaceChildren`s it in one go, and caches the buttons in `cellElements`.
- `paintCell` rewrites that one cached button via `dressCell` and returns early when the cell already holds the value — a drag fires many pointermoves per cell, and all but the first must be free. It calls `solver.hideSolution()` only, **never** `solver.render()`.
- Picking a tool or a symbol calls `renderTools()` (the two chip rows), not `render()`. Only a board *replacement* — resize, reset, config load — calls `render()`.

`Board` registers all its listeners against an internal `AbortController`, and the editor's `replaceBoard` calls `dispose()` before swapping. `#grid` outlives any single `Board`, so a board that kept listening would keep painting into its own dead `cells` and make every later stroke do the work once per board ever created — which typing a two-digit grid size creates several of.
