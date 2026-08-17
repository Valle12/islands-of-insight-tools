# Logic grid: the page and the solver

Long-form notes split out of `CLAUDE.md`. Read this before touching
`src/pages/logic-grid-solver/` or its `a-star/` engine.

## The logic grid page

The newest page. Its answer is a finished board rather than a sequence of steps,
so `#solution-view` holds one grid and a Back button — no Previous/Next — but it
is a real view that replaces `#editor-section`, and the room beside the grid is
where a per-cell explanation of *why* would go.

**A cell carries two independent layers.** `cell.ts` owns the colour only
(`UNKNOWN` 0, `DARK` 1, `LIGHT` 2, `UNPLAYABLE` 3) and `cells` is a flat
column-major integer grid of exactly that. Clues live in a **separate sparse
`symbols` array** of `{x, y, type, value}`, which is what makes the game's
colourless clue representable: a clue on an `UNKNOWN` cell is one whose colour
has still to be deduced, and colouring the cell later leaves the clue alone. A
clue takes the colour of the cell it sits on and has none of its own — that is
why `cellView.ts` draws it as the element's own **text**, with the ink following
`data-color`, rather than as a background image the way match-three does.

**`rules.ts` and `symbols.ts` are both append-only catalogues**, for the same
reason `match-three-solver/symbols.ts` is: a config stores the INDEX of an
active rule and of a clue's kind, so inserting or reordering an entry silently
rewrites every puzzle ever saved. Appending is always safe. Both rows are
rendered from the list by JS (`#rule-row`, `#symbol-row`) precisely so a new
entry costs no markup and no test edit. The validator **rejects** an index it
does not know rather than ignoring it — a silently dropped rule would load a
different puzzle under the same name.

**The rule list was REGROUPED once, and that is the only time it may happen.**
It reads: forbidden arrangements 0–10 (dark before light in every pair), then
`connect-dark`/`connect-light` 11–12, `one-symbol-dark`/`one-symbol-light`
13–14, `underclued` at 15 because it alone changes what the answer is, then
every later batch appended in arrival order — areas two/four/five at 16–21,
the mixed triples 22–23, the T pair 24–25, the 3+1 pair 26–27, the diagonals
28–29, area three 30–31, and the galaxy-era batch 32–52 (`off-by-one`, elbows,
Ls, the distance pair, areas six/seven, the crossed and long Ts, area
twenty-four, knights, mixed elbows), and the region-shape pairs at 53–56.
That reorder was safe only because
nothing was live and the captured fixtures were the only saved configs — all
of the 69 then captured were rewritten in the same change and checked to
produce a byte-identical answer afterwards. Once a player has a downloaded
config it can never happen again: appending is the only safe edit. Rule 31's
bit is also past what a positive `int` can spell, which is why `RuleMask` is
`uint64_t` and the CLI's `--rules` an `int64_t`.

**Since format version 2 the two SIZED families are data, not indices.** The
22 entries that were the same rule at different sizes — `no-<colour>-1xN` and
`<colour>-regions-have-area-N` — are no longer legal in a config's `rules`
list. A current file stores the number beside the colour instead:
`areas?: {color: "dark"|"light", size: 1..9999}[]` and `runs?: {color, length:
2..8}[]`, both optional and omitted when empty (the `shapes` discipline), dark
before light then values ascending, duplicates refused. **Several `runs`
instances per colour are legal and conjunctive** — "no dark 1x2" and "no dark
1x4" are two separate bans, both enforceable and at worst redundant — but
**`areas` takes one per colour**, refused by name on every layer: areas 2 AND
3 on one colour hold together exactly where the colour is ABSENT, all zero of
its regions being both sizes at once, which is not a puzzle anyone means. The
editor says the same thing by dropping an area control's `+` once it holds a
slot (`SizedControlSpec.onePerColor`, `SizedListSpec.perColor`). The bounds
are deliberate:
the area cap is a FORMAT limit, NOT capped by board size — an area larger
than the board loads fine and simply forces its colour ABSENT (all zero of
its regions are the right size); Solve answers Unsolvable only where a given
or clue demands that colour anyway, the honesty rule — while the run cap is
the ENGINE's `kMaxRunLength = kMaxPatternCells` — a forbidden run is enforced
only by its compiled pattern, so a length the table cannot hold is refused by
name rather than accepted and silently not enforced. The 22 retired entries stay in
`RULES` (each carrying its `sized` origin marker) and in the C++ `Rule` enum
(with `kLegacyAreas`/`kLegacyRuns`/`kSizedRuleBits` beside it) because they
are v1 bit positions: the migration, the CLI's v1-style `--rules` mask and the
generator's rule table still speak them, and `splitLegacyMask` is the one
translator. The TS validator ACCEPTS the lists in any order and canonicalises
on output; the C++ intakes (`wasm_bindings`, `FixtureIo`) REFUSE a
non-canonical or duplicated list — they read only committed fixtures and
already-validated payloads, so disorder there means a hand-edited file.

**The row is drawn from `RULE_ROW`, a display catalogue the format never
sees.** The row is a column of four headed bands (`arrangement`, `region`,
`symbol`, `answer`); a dark/light pair is folded into ONE control — a shared
concept label and two INDEPENDENT segments, both able to be on at once, each
segment the same `.tool-button.rule-chip` with `data-rule`, `data-rule-index`
and `aria-pressed` a chip always was, wearing its colour as a SWATCH (the
paint tools' own visual, dark drawn first whatever the ids spell) and the
full rule name as its accessible name; a rule with no sibling keeps its plain
chip; and
each sized family-and-colour is ONE value control (`.rule-sized`) holding a
field per instance plus a `+` that appends another (`.rule-size-add`,
deliberately NOT a `.tool-button` — `chipFrom` means "a rule or clue chip").
**Only `ruleRowMarkup`, in `toolRowMarkup.ts`, reads `RULE_ROW`.** `toggleRule`
reads the segment's `data-rule-index` and `refreshRuleRow` queries by
`data-rule` id, so both are position-independent — as are the e2e suites, which
address chips by id.
`catalog.test.ts` pins the coverage invariants rather than the order: every
flag in exactly one control, no sized id anywhere, pairs dark-then-light, each
control in the band its rules' `group` names. The sized value fields keep raw
per-slot strings (the `symbolValues` pattern): the row is never rebuilt on
interaction, a refresh writes a field only when its text differs (the caret
guard), an emptied slot is dropped on `focusout` — never mid-typing — and a
family is active exactly while it holds one usable value. All of that,
including building and focusing a new slot, is `sizedRuleControls.ts`: those
fields are the one part of either row that is created and destroyed while the
page runs, so the text and the elements have a single owner.

**Indices are copied in four places, and one of them cannot be avoided.**
`catalog.test.ts` and `rules_test.cpp` pin every index on both sides — that is
the point of them. `e2e/logic-grid-solver/config.test.ts` derives what it
needs from `RULES` rather than restating it. The unavoidable one is
`test/logic-grid-solver/mem64.node.test.mjs`, which runs under node and cannot
import TypeScript, so its board carries literal indices; the regroup moved
`connect-dark` from 2 to 11 and silently turned that board into "no runs of
two of either colour", and that test failing is what caught it. The sized
families no longer need listing — they are instance data, and "walk the
family" now means "walk `puzzle.areas`/`puzzle.runs`" — but the INDEPENDENCE
discipline survives them: the reducers in `Rules.cpp`, the oracle walks in
`Verify.cpp` and the walks in `verify.ts` read the same instance lists without
sharing any code, so they can only agree by both being right. A DERIVED fact
goes beside the family rather than into it: `impliedRun` is what knows an area
of N forbids a run of N+1, deliberately kept out of `shortestRun` so that
reducer keeps meaning what its two oracle mirrors mean.

**The FORMAT takes one area per colour; the ENGINE still walks the list, and
that difference is deliberate.** "Every dark region has area 2" and "…has area
3" are satisfied together exactly where dark is absent — all zero of its
regions are both sizes at once — which is not a puzzle anyone means, so all
three intakes (`validateConfig`, `wasm_bindings`, `fixtureio::load`) refuse a
second entry per colour by name. Three producers of a conjunctive list survive
that refusal, none of them an intake: `rules::splitLegacyMask` from a v1
`--rules` mask, `reference_test.cpp`'s hand-built puzzles, and the v1
migration on its way INTO the validator. So the reducers may not collapse the
family to a scalar. `rules::smallestArea` exists for `impliedRun` and
`mergeLimits` ALONE, where the min is sound because the instances are
conjunctive and the smallest cap on growth binds; `propagateRegionAreas`,
`addAreaShapes` and both oracles iterate the instances instead. A caller that
reached for the min as "the size a region must be" would force two dark cells
onto a board whose only answer has none.

The generator is the one place the two halves meet: it draws each rule of
`kColorRules` independently, so roughly half its masks name two sizes on one
colour, and every board it writes is read straight back through
`fixtureio::load`. `keepOneAreaPerColor` in `GenerateCommands.cpp` collapses a
drawn mask to the smallest size per colour, AFTER every rng decision so no
seed's stream moves — only what an already-drawn mask means.
An area of ONE — a size the old catalogue never had — is the reason
`regionArea`'s isolated-singleton sweep is gated to `area >= 2`: at one the
singleton IS the legal shape, and the ungated sweep would exclude the colour
from exactly the cells the rule wants it on, poisoning underclued's proven
forced set. `reference_test.cpp`'s brute force referees that gate.

**The region-SHAPE rules (53–56) are the first family since the sized ones to
add nothing to the pattern table, and the first whose propagator reads a target
it works out from the NODE.** The table may only hold rules a bounded window can
state; these relate regions arbitrarily far apart and depend on each region's
maximality, so `patternsFor` has no row for them and `rules_test.cpp` pins that
the mask compiles to nothing.

"Same shape" is CONGRUENCE — the eight dihedral images, rotations and
reflections both, so an S and a Z are one shape and an L and a J are one shape.
`canonicalShape` in `Bitboard.h` is the key: the smallest of a region's eight
normalised images, compared only for equality, so which of the eight wins is
arbitrary as long as it is deterministic. Every image is a bijection, so the
SIZE rides in the key and "shape and size" is one predicate. It counts SQUARES,
like every other geometric predicate here — a merged cell is itself a polyomino
rather than a point, so a region "as a set of cells" has no shape to compare —
and two regions with one footprint are therefore one shape however the merges
beneath them differ. Both rules of a colour may be on together: they then say
the colour has at most ONE region, which is an ordinary thing for a board to be,
so they are two independent flags rather than two sides of a switch.

Everything the propagator deduces rests on CLOSURE — a region no cell can still
join, which is `(region.border() & possible(color)).any() == false`, reading
`possible` and never `undecided`. Domains only shrink, so closure is MONOTONE: a
closed region stays closed and stays exactly itself for the whole subtree. That
is what makes the deductions sound, and it is why the family is right at a
complete assignment for free — there `possible` and `definite` agree, every
region is closed, and the checks ARE the oracle, which keeps `oracleRejections`
at zero. `distinctShapes` refutes two closed regions of one key and forces an
open region that matches a closed one when it has exactly one CELL to grow into.
`sameShape` deduces NOTHING until a region closes — taking the first or biggest
open region as the target is precisely the over-prune this family invites — and
then borrows `regionArea(color, |K|)` whole, since congruent regions all hold
`|K|` cells. The near misses that must survive: two OPEN congruent regions
(which may grow apart, or merge into one), an open region matching a closed one
with more than one way out, and a singleton target, where `regionArea`'s
`area >= 2` gate is what stops the colour being emptied. `reference_test.cpp` is
the only thing that can catch any of that going wrong, which is why the family
landed with ten new rule sets there. The generator draws these rules only from
an explicit `--rules` mask: `kColorRules` leaves them out because `cost()` has
no sound gradient for either — `distinct` has no per-region distance at all,
since separating one colliding pair routinely creates another, and `sameShape`'s
target is itself a free variable.

**A clue kind is a split control, and its value field lives INSIDE the row.**
Each kind renders as chip + divider + its own `<input class="symbol-value">`,
in the shape of a Material split button, rather than one shared field below the
row — a shared field has to keep saying which clue it belongs to, and every kind
added makes that worse. Typing in a field selects its kind, so a field can never
be edited while a different chip is armed, and each field reports its **own**
validity (`aria-invalid`) rather than the selected kind's.

**A DIRECTED kind seats four more controls on the same pill.** `dart` (index 2)
carries a number *and* one of four directions, so its control is chip, divider,
field, divider, four `.direction-toggle` buttons — inline rather than behind a
menu, because there are only four and one click has to be enough. Aiming one
selects the kind, exactly as typing a value does. Three things about them:
they must NOT carry `.symbol-chip`, which means "the clue kinds" and is counted
by both `logicGridSolver.test.ts` and `e2e/.../tools.test.ts`; whichever
element is LAST in the pill carries its rounded right-hand corners, so
`.symbol-value` gives them up when a directed kind puts arrows after it; and
the field is sized to the longest value its OWN kind can hold rather than every
kind paying for the widest, or four arrows make the dart's control enormous.

**One arrow glyph, turned four ways, drawn in three places.** `arrow_right_alt`
is the only long arrow Material Symbols ships and it only points right, so
`data-direction` both seats it (one `flex-direction`) and turns it (one
`rotate`) — which is why those CSS rules key on the bare attribute rather than
on `.grid-cell`. Two measured facts about that glyph are what the sizing rests
on, and both were found by looking rather than guessing:

- **`md-icon` is a SQUARE box of its font size, and the ink fills neither axis
  of it** — measured against the loaded font, `arrow_right_alt` is `0.67` of the
  font size across and `0.505` down, centred. So a 28px icon draws an arrow
  19px long with 4.6px of nothing at each end, and it is that dead space, not
  the arrow, that a tile stacking a number above one runs out of room for.
  `--arrow-size` is therefore the length of the ARROW and the two ratios turn it
  back into a font size and a box; every context sets that one number and what
  it sets is what shows up.
- **`rotate` transposes what is painted and changes no layout**, so the two
  quarter-turned seats reserved a slot as wide as the arrow is long — which is
  what pushed the number out to the edge of the tile while the arrow appeared to
  have room to spare. The box has to keep its shape or the rotation produces the
  wrong one, so it is the MARGINS that trade the two axes. Swapping `width` and
  `height` instead looks like the same fix and is not: it rotates to a visual
  box the layout then does not match either.

A longer number turns `--arrow-size` down, because on the up/down seats the
number and the arrow sit side by side and share the tile's width; those two
seats also spread the pair with `justify-content: space-evenly` rather than a
fixed gap, since how much there is to share depends on how long the number is.

**Trimming that box is what makes the browser's own focus ring wrong**, so
`.grid-cell` spells its focus ring out. `outline-style: auto` is drawn around an
element's PAINT bounds, and those include a child's ink overflow — the arrow's
glyph box is 36px inside a 24px element box, so the default ring bulged nine
pixels out of the square to wrap it. An outline with a real style follows the
border box. Anywhere a glyph is deliberately larger than the box holding it,
that ring has to be spelled out too. The four `arrow_upward`-style glyphs were tried first and are
a stubbier arrow that reads badly at the size a tile can spare. The three
places are the board, the answer's read-only grid, and the clue kind's own
chip, which draws a MINIATURE of the tile through the same `dressClue` — a chip
that spelled its own arrow out would be free to drift from what it stamps.

**Per-kind bounds live on the kind, not on the page.** `LogicGridSymbolKind`
gained `minValue` and — replacing the old `directed` boolean — `aims: "none" |
"compass" | "axis"`, and `symbolValueMax(kind, size)` takes the board's two
dimensions rather than its area: an area number is bounded by the board's
AREA, a dart by its longest LINE (`max(w, h) - 1`), and a valueless kind by
nothing, which it reports as 0. Zero is a real dart and not a real area, which
is why `MIN_AREA_VALUE` stopped being the one floor and why `nextNumberValue`
in `boardKeys.ts` no longer refuses a leading zero outright. The error strings are
still built from `${kind.label}` and the bounds, so a new kind gets its
message for nothing.

**The lotus (kind 3, label "Symmetry") is the first VALUELESS kind and the
first whose `direction` is an AXIS.** `valueKind: "none"` is what renders its
control as chip + four `.direction-toggle`s carrying `data-axis` and NO field
— `logicGridSolver.test.ts` counts `.symbol-value`s per value-carrying kind
now, and `refreshSymbolRow` refreshes the field only where one exists, since
an early return on the missing field would silently skip the selection and
toggle refresh too. The four axes are one glyph turned 0/45/90/135° by
`[data-axis]`, the dart-arrow trick again: `horizontal_align_center` (added to
the icon subset) natively draws a VERTICAL bar with an arrow either side, so
the horizontal axis is the quarter turn and the diagonals the 45° steps. The
`AXES` catalogue (`horizontal`, `diagonal-down`, `vertical`, `diagonal-up` —
45° clockwise turns) is a file format exactly as `DIRECTIONS` is.

**A lotus's position is DATA twice over**, which is why it has a SEAT.
Its square is the player's, like every clue's; its `seat` is how it sits on the
grid LINES (0 centre and omitted, 1 right-edge midpoint, 2 bottom-edge
midpoint, 3 corner — two half-square offsets from its home square, always the
seat's top-left neighbour). Seat-carrying is a CAPABILITY, `seating` on the
kind, not a property of aiming: the galaxy carries one too, and where a seat
may sit differs by kind — `"cell"` for the lotus, inside its own merged cell,
and `"board"` for the galaxy, anywhere on the grid (see its own section below).
The lotus's seat legality: seams need the square beyond as a
shape-mate, a corner needs at least THREE of its four squares in the cell (a
2x2's centre has four, an L-tromino's natural middle has three), and the two
DIAGONAL axes refuse the seam seats outright — their reflection would map
square centres onto square corners, so the combination is refused by name on
every layer rather than defined. Placement snaps the pointerdown to the
nearest legal seat (a press past ~¾ of the square leans onto the seam, which
also catches a press on the invisible bridge); re-clicking the same seat turns
45° clockwise skipping the impossible diagonals, a different seat re-seats,
ArrowLeft/Right STEP a focused one (compass keys don't name axes, so absolute
aiming stays dart-only and Up/Down keep scrolling), and digits do nothing —
`nextClue` returns null for a valueless kind so typing cannot cost it its
clue. Rendering slides the glyph by `data-seat` — `translate` composes with
`rotate` as independent transform properties — in the editor grid, the
solution grid, and never on the chip.

**The SEAMS are clickable while a seated clue is armed**, which is what makes a
point between squares reachable: the clue's point IS the gap, so asking the
player to hit a square and lean is backwards, and the crossing where four
squares meet was the one place nothing was listening. `Board.syncSeamTargets`
puts `data-seams` on `#grid`, and the stylesheet then gives every square the
merged cells' own bridge pseudo-elements — the same geometry, each seam covered
ONCE by the square left of or above it and the corner by the top-left of the
four. Covering each seam once is the load-bearing part: overlapping halves from
both sides leave the crossing on a boundary between four boxes, where the hit
test picks none of them. Only while a seated clue is armed, because a colour
has no meaning in a gap and widening those targets would change what a drag
across the board paints. The offsets are declared on the CELL so
both seated glyphs read them, and a seated cell takes `z-index: 1`: its glyph
paints outside its own square, and grid items paint in DOM order. The lotus
never needed that, because its seat only ever exists inside a merged cell whose
squares paint nothing; a galaxy's seat may run between two ordinary squares.

That is why both rows are **built once and refreshed in place**:
`buildSymbolRow` / `buildRuleRow` write `innerHTML` and run only from `render()`
(board replacement), while `refreshSymbolRow` / `refreshRuleRow` toggle classes
and attributes on every selection change. Rebuilding on selection would destroy
the field being typed into, and `refreshSymbolRow` additionally skips writing
`input.value` when it already matches — assigning it moves the caret to the end.
The same discipline is what keeps a rule chip focused after a keyboard toggle.
`buildSymbolRow` / `refreshSymbolRow` live in `symbolRowView.ts` and take the
row element plus the editor's per-kind arrays; `buildRuleRow` /
`refreshRuleRow` stay on the editor, which owns `activeRules`.

Four things about the board are load-bearing. Three of them are decided in
`strokes.ts` — what a press MEANS, before anything is written — and the digit
run is `boardKeys.ts`, along with the keyboard half of the other three:

- **The right mouse button is a real input here.** The selected chip drives the
  left button; the right one paints the *other* colour for `dark`/`light` and
  erases for everything else, so the untouched page is left-dark/right-light
  with nothing clicked. `contextmenu` on `#grid` is `preventDefault`ed, or a
  right-drag pops the menu and ends the stroke on the first cell.
- **The re-click-erases rule commits once, at `pointerdown`.** A stroke that
  would write what the cell already holds clears it instead, and that decision
  is then applied to every cell the drag touches. Deciding it per cell makes a
  drag across a half-painted row alternate between painting and erasing.
- **Digits accumulate per cell.** An area number runs past nine, so consecutive
  digits typed on one focused cell grow the number; painting, or moving to
  another cell, ends the run. A leading zero is ignored where the kind's floor
  is 1 rather than clamped, and a number the kind cannot use leaves the last
  good value standing.
- **A DIRECTED clue TURNS where any other would be lifted.** `turnsInstead`
  reads "the same clue apart from where it points" as a request to point it
  somewhere else, so clicking a placed dart takes it one step clockwise and four
  clicks bring it back — while a different VALUE still overwrites, and lifting
  becomes the right button's job alone. Arrow keys aim a focused dart
  absolutely; everywhere else they still scroll, which is what they always did.
  **Dragging the arrow was tried first and removed**: the arrow is a small
  target inside a cell that also paints, so a miss placed a clue instead of
  turning one, and there was no way to tell the two gestures apart before the
  drag had already done the wrong thing.

Painting `UNPLAYABLE` drops the cell's clue (a gap is not clued, and the
validator refuses a file that says otherwise); the eraser clears both layers;
colouring a clued cell keeps its clue.

**A clue's `direction` is the config's third optional key**, and it follows
`shapes`' rule exactly: written only where there is one, in the page's writer,
in `fixtureio::save` and in `validateConfig`'s rebuild, because every fixture
predating darts has to keep round-tripping byte-identically. It crosses the wasm
boundary as **-1 when absent** rather than being omitted, so a kind that needs
one is refused by name instead of quietly pointing up. **`seat` is the fourth
optional key and `value` became conditionally absent**, both by the same rule:
a lotus writes `direction` (its axis), writes `seat` only off its 0 default,
and writes NO `value` key at all — a value on it is refused rather than
dropped, on every layer. Three writers have to agree about all of this
(`board.ts getSymbols`, `validateConfig`'s rebuild, `fixtureio::save`), and
the 489-fixture byte-identical sweep is the guard. At the wasm boundary
`value` and `seat` default to 0 instead of -1 — a lotus with a nonzero value
is refused by name, so the default cannot mask a real one.

**Two things put the answer's merged cells in the wrong place, and both are
easy to undo.** `#solution-grid` needs `position: relative` as much as `#grid`
does — the outline layer is absolutely positioned, and without a positioned
ancestor it anchors to the page, drawing every merged cell in the top-left
corner while its squares (which paint nothing themselves) leave holes in the
answer. And `.grid-cell` needs an explicit `box-sizing: border-box`, because the
outline is traced from `--logic-cell` plus `--logic-seam` and so assumes a
square is EXACTLY that tall: the editor's squares are `<button>`s, which the UA
stylesheet already makes border-box, while the answer's are `<div>`s, which are
not — one pixel of border per side put every row 1.14px below where the outline
expected it, and by the fourth row a merged cell sat visibly higher than the
plain squares beside it. Two elements sharing a class have to mean the same box.
`e2e/.../solve.test.ts` measures both, which is the only way to catch either.

**And the outline layer must be SIZED even when it draws nothing.** An `<svg>`
with no `width`, `height` or `viewBox` falls back to the replaced element's
default **300x150**, and this one is absolutely positioned inside the grid — so
on a board with no merged cells at all that phantom box lands in the scrollable
overflow of the shell around it. Measured on a 4x4: a 186px grid in a 214px
shell reporting a 300px scroll width, i.e. a horizontal scrollbar over empty
background plus the 15px of height it reserves. The EDITOR hid it because
`#grid-shell` is stretched wide by the tool rows above; `#solution-grid-shell`
shrinks to its board, so every small answer showed it. `drawShapeOutlines`
therefore sets the three attributes before the empty-shapes early return, not
after it.

**Grid tracks are FIXED-SIZE (`repeat(N, var(--logic-cell))`), never
`minmax(0, 1fr)`.** The grid is a flex item of its scrollable shell, and a
minmax-0 track happily shrinks below the squares' hard width — the squares
then OVERLAP sideways while the outline SVG, sized from `--logic-cell`, keeps
its natural width: a squeezed board under a full-width overlay, i.e. a
horizontal scrollbar into blank space. Measured on the 26×19 capture at half
a display's width. Fixed tracks plus `flex: none` on the grid and
`justify-content: safe center` on the shell (plain `center` hides overflow
past the LEFT edge where no scrollbar reaches) make the shell scroll instead;
`e2e/logic-grid-solver/layout.test.ts` pins the pitch, the scroll extent and
the reachable first column. Match-three and rolling-blocks had the identical
latent squeeze and got the identical fix (`--mt-cell`/`--rb-cell`);
shifting-mosaic is fluid by design (cells `width: 100%`) and is the one page
this rule does not apply to.

**Every SQUARE of a merged cell carries its own clue slot, and nothing
re-homes one.** A clue lands on the square the press landed on, `loadConfig`
keeps the square the file names, and the validator asks only that a SQUARE
carry at most one — a merged cell may hold SEVERAL, which the game's hardest
boards really do (two darts on one domino). Pressing another square of a
clued cell therefore ADDS a clue there; the pressed square's own clue is what
lifts (or, directed, turns) on a re-press, and the right button, Delete and
typing all reach only the focused square's slot. Combinations no colouring
can satisfy — two different letters on one cell, area numbers whose candidate
sets intersect empty — are deliberately NOT structural errors: the file
loads, and Solve answers Unsolvable, the same honesty rule the givens follow.
The engine needed nothing for any of this beyond deleting the one-clue checks
(`shapeAgreement`'s clue counter, `config.ts`'s shapes check): clue tables,
region absorption and the one-symbol counts were per-square all along, and
the reference sweep's `twoDartsOneCell`/`areasDisagreeOnCell`/
`twoLettersOneCell` boards brute-force-referee what each combination admits —
under off-by-one, two disagreeing areas on one cell even go SOLVABLE, the
off-by-2 trick landing on a single cell.

That replaced two rules in turn. First an "anchor" rule: the clue was stored
at the member square nearest the cell's bounding-box centre, `loadConfig`
re-homed every clue there on the way in, and `config.ts` **rejected** a dart
anywhere else — wrong about the game, because a dart's line starts at its own
square, so on a merged cell each square is a different puzzle. Then a
one-clue-per-cell rule, wrong about the game the same way one batch later.
`dartInMergedBoard` in `boards.ts` pins the first correction (the forced set
names the column the dart's own square puts its line down);
`twoDartsOneCellBoard` pins the second (two darts on one domino forcing their
two columns DIFFERENTLY, which no one-clue collapse could express).

**A cell is not always one grid square.** The game's harder boards fuse several
squares into one irregular **cell** — a 1x3 bar, an L, even a glyph shaped like
a digital "2". `shapes.ts` is that third layer (`ShapeLayer`, flat
`y * gridWidth + x` indices, ids internal and never saved), and the rest of the
page treats a merged cell as one thing for COLOUR: one colour across every
square, every colour stroke fanned out over `cellSquares` — while each square
keeps its own clue slot.

- **The gestures are per SQUARE, and the stroke's target is fixed at
  pointerdown.** Left-drag grows the cell under the first square (a new one when
  that square was plain); every square the drag touches joins it and *leaves*
  whatever cell it was in. Right-drag takes each square it touches back out.
  Enter joins the focused square to the neighbour before it in reading order, so
  the tool is not pointer-only. The chip sits in `#color-row` beside the gap
  tool rather than in `#command-row`: like that one it changes what the board
  IS, rather than doing something to it once.
- **The donor settles immediately, the target only at pointerup.** Pulling
  squares out really does leave the rest in pieces — right-dragging the middle of
  a 3x3 gives a donut and a loose square — so `normalize` splits it into
  4-connected components and dissolves any piece down to one square. The target
  is left alone until the stroke ends because mid-drag it is *allowed* to be a
  single square or briefly in two pieces (a fast drag skips squares between two
  pointermoves), and settling it then dissolves the cell out from under its own
  stroke. That was the first bug this feature had.
- **Restructuring clears.** Every square a merge or split touched goes back to
  uncoloured and unclued: the squares coming together may disagree about both,
  and picking a winner would be a rule nobody could predict from the board.
- A clue is stored and drawn on **whichever member square the player put it
  on**, in and out, with no canonical position anywhere — see above.

**A merged cell is drawn as ONE SVG path, not out of its squares' borders.**
`shapeOutline.ts` traces the cell's footprint — the squares, the gap between
each pair of shape-mates, and the little square between four of them only where
all four belong to the cell — and emits one path with arcs on the convex
corners and square concave ones. `outlineLayer.ts` puts those paths in an
`<svg>` behind the squares, shared by the editor and the solution view; the
squares of a merged cell then paint NOTHING and keep only the clue text and the
clicking.

That is not a stylistic choice, and reverting it to CSS will bring the bug back:

- **Several boxes cannot draw one straight edge.** Borders on each square plus a
  pseudo-element bridging each gap means the edge is several independently
  painted boxes, and Blink snaps each to the device pixel grid on its own — so
  at most zoom levels the rim steps sideways wherever two of them meet. Measured
  across 100/110/125/150/175/200/250/300/400/500%: only a few ratios come out
  clean. `contain`, `isolation`, `opacity`, 2D and 3D transforms, dropping the
  bridge's `z-index` and reshaping the bridge were all measured and none help,
  because none makes it one painted object. One path is one rasterisation, and
  measures straight at every one of those ratios.
- **The path is pulled half a stroke INSIDE the footprint.** An SVG stroke
  straddles its path while a CSS border sits inside the box, so without that a
  merged cell's rim would sit half a pixel proud of a plain cell's and blur
  across two device pixels at 100%.
- **The rule that stops the squares painting has to come AFTER the `data-color`
  rules.** They have the same specificity, so ordered the other way a merged
  square goes on painting its own rounded fill and its corners bite into the
  tile at every square boundary.
- **The geometry is read from `--logic-cell` at draw time, and retraced by a
  `ResizeObserver`.** The outline is in pixels, and the mobile breakpoint moves
  a square from 42px to 34px.
- **The seams are still real gaps, so the bridges survive as INVISIBLE hit
  targets.** A pseudo-element hit-tests as its originating element, which is
  what makes the whole tile clickable rather than only its squares; they paint
  nothing at all.
## The logic grid solver

`src/pages/logic-grid-solver/a-star/` (the directory name is the repo's
convention, not a claim about the algorithm — match-three's is the same, and the
CI wasm cache key globs `src/pages/*/a-star/*`). There is **no TypeScript
engine**; `verify.ts` is the page's own rule checker and nothing else, in the
same role as rolling-blocks' `replay.ts`.

**A painted cell is a GIVEN.** The answer has to keep it, which is what lets a
half-finished board be handed back for checking — and why a board painted wrong
comes back unsolvable rather than quietly re-solved.

**`Underclued` (rule 15) changes what the answer IS, not what a legal colouring
is.** Normally the answer is one complete board; underclued, it is the set of
cells that hold the same colour in **every** solution, and the rest stay blank.
That is a different computation, not a different search, and it is why the
result carries `proven`: a partial deduction that says it is partial is worth
showing, and one that pretends to be the whole answer is not.

**A merged cell is ONE variable spanning several squares, and the whole of that
lives in `Domains::exclude`.** `Bits` and `Colors` stay square-granular, and the
only place a domain shrinks fans out over the cell's mask — which makes
**every square of a merged cell hold an identical domain at every point of the
search**. Everything downstream then reads those square sets unchanged and comes
out right *because* of it: `flood`/`component` can never split a cell across two
regions, `grown`/`border` give "adjacent to whatever any of its squares
touches", and `count` counts squares, which is what an area number wants. The
rule for touching this: **anything that READS a `Bits`/`Colors` needs no change;
anything that WRITES a domain, ENUMERATES variables, or BUILDS a clause does.**

Five things follow, and each is load-bearing:

- **The arrangement rules count SQUARES, not cells.** A merged dark 1x2 *is* a
  dark 1x2. `Rules.cpp` is untouched by any of this, and `hasSquare` /
  `longestRun` / `hasCheckerboard` in both oracles are correct unmodified — that
  is the decision made executable. The one wrinkle is at clause construction: a
  pattern instance may now name the same cell twice. Two of its squares wanting
  the same colour **collapse to one literal** (left in, the second copy reads as
  a second free cell and the clause can never fire as a unit — sound but deaf),
  and wanting *both* colours **drops the instance**, like one running off the
  board.
- **A clause can now hold ONE literal, and nothing used to look at those.**
  Clauses are only rescanned off the queue of newly decided squares, and at the
  root that queue holds the givens. A plain board cannot produce a unit clause;
  a merged 1x3 bar under "no dark 1x3" compiles to exactly one — "this cell is
  not dark" — so `applyGivens` sweeps the clause list once at the root. Without
  that the sharpest thing about merged cells silently does nothing.
- **`Domains::exclude` must not short-circuit on the first failure.** Bailing
  early leaves one square with nothing it can be while its mates are still
  undecided, i.e. the invariant broken in the window where the failure is still
  unwinding through callers that go on reading squares.
- **`Verify` gains `fusedProblem`, and it earns its keep outside the search.**
  Nothing the search produces can split a cell — but `verify::check` also gates a
  fixture's own `solution` key, the page's `verify` export taking an arbitrary
  array from JS, and brute force. It is the one place that says out loud what a
  merged cell is, and what entitles every check after it to read squares.
- **`Profile::applicable` declines any board with a merged cell**, first, ahead
  of everything else. The frontier carries one class slot per COLUMN joined only
  leftwards and upwards, so nothing in it can say "this square takes the colour a
  square two rows back already took" — and `runProfileForced` sets `proven` with
  no oracle gate, so a sweep blind to the fusion would enumerate a superset and
  then claim the cells they disagree about were proved free.

Everything that enumerates *choices* moved to one entry per cell — `Model::
representatives` — because a probe is two full propagations and a refutation is a
whole search: `Probe::probeToFixpoint`, `Search::buildOrder` (which also pulls a
merged cell into the frontier whole, so a 1x5 bar is one hop from a clue rather
than five), `Underclued::candidatesFrom`, and `Reference::enumerate`, whose
`kMaxFreeCells` now counts cells. `Underclued` additionally had to write the
whole `cellMask`, not just the representative — that answer is what the page
draws, and a merged cell reported half painted would be drawn half painted.

The engine's load-bearing pieces:

- **`Verify.cpp` and `verify.ts` share nothing with the search.** Both re-scan
  the whole board per rule rather than reading the compiled clause list. An
  oracle built out of the thing it checks only proves the two agree. On the page
  side, `solver.ts` runs every answer through `verify.ts` before it can be
  drawn, and **drops** an arm that fails rather than ranking it low.
- **`Reference.cpp` is the only thing that can catch over-pruning.** `Verify`
  catches an answer that is not a solution; nothing at runtime catches a
  propagator that removes a colouring which WAS one — in normal mode that is
  just a different valid answer, and underclued it is a confidently wrong one.
  `reference_test.cpp` compares whole solution sets and exact forced sets
  against brute force over a board × rule-set sweep. Do not delete it, and do
  not let it stop covering a propagator you added. (Its local `Shape` struct was
  renamed `Board` when merged cells arrived — a shape is now a merged cell.) It
  enumerates one bit per CELL, which makes it depend on
  `representatives`/`cellMask`, so `CellEnumerationMatchesSquareEnumeration`
  buys that independence back: sweep every colouring of the SQUARES on a small
  merged board, keep what the oracle accepts, and the survivors must be exactly
  what `enumerate` produced. That is what makes `fusedProblem` and `cellMask`
  mutually load-bearing.
- **The pattern table is the extensibility claim, and it has been cashed in.**
  Rules 0–10 compile into one list of forbidden arrangements in `Rules.cpp`, and
  one propagator drives all of them. The 1x5 pair (rules 8/9)
  was added afterwards and cost one row in `shortestRun`, one enum entry, one
  row in each of the two `Verify` oracles, and no new code anywhere — which is
  what the claim was. The only thing to watch is `kMaxPatternCells`: it sizes
  `Clause`, so a pattern longer than every existing one has to raise it (a
  `static_assert` in `fromCells` catches the omission at compile time). Three
  things happen there beyond translation: a shorter run rule **subsumes** the longer
  ones for its colour (generating both only adds instances that can never fire),
  both connect rules being on **implies** the checkerboard patterns — a
  Jordan-curve argument, spelled out in the source, that holds with holes in the
  board — and an area rule contributes its **trominoes**, below. The table may
  only ever hold *containment* rules: instances touching a gap are dropped, which
  is right for "this arrangement never occurs" and wrong for anything else.
- **"Regions have area 2" (rules 16/17) is HALF a pattern rule, and that is the
  second time the claim above was cashed in.** "No region bigger than two" is a
  forbidden arrangement after all: a connected set of three or more cells always
  contains a connected THREE, and the connected trominoes are exactly the two
  straight ones plus the four bent ones. So that half compiles into the table and
  costs no solver code at all — it rides unit propagation, the occurrence lists,
  the DFS and `GenerateCommands::cost()`. The straight pair is left to `addRuns`
  via `impliedRun`, because a duplicate clause would make one broken straight
  score **two** in that cost function and bias the generator's local search.
  "No region SMALLER than two" is the half the table cannot hold, and it shows
  why the containment restriction is real: "this cell dark and all four
  neighbours light" is only forbidden where all four neighbours exist, and an
  instance running off the board or across a gap is DROPPED rather than
  shortened — which is exactly where the rule bites. It is `regionArea` in
  `Propagate.cpp` instead: a cheap four-shift sweep for cells with nothing
  beside them that could ever join them, then a walk over the components of the
  colour applying `areaKnownColor`'s reasoning to each — too big, no room to
  reach the number, exactly full, exactly one way to grow. That propagator is
  **not** an optimisation — `oracleRejections` is asserted zero in three suites,
  so a rule the propagators cannot finish enforcing fails tests rather than
  merely running slowly. `cardinality` has no exact target to use because zero
  cells of a colour is legal, and `Reference.cpp` cost zero lines because it
  takes its legality entirely from `Verify`.
- **"Regions have area 5" (rules 20/21) is `regionArea`'s again, and it is what
  moved `kMaxPatternCells` to SIX.** `impliedRun` folds an area of five into a
  forbidden straight run of six, and `runPattern` writes `cells[i]` with NO
  assert of its own — only hand-listed `fromCells` patterns are guarded by the
  static_assert — so the constant must never lag the longest implied run any
  rule set can produce. `AnAreaOfFiveImpliesARunOfSix` pins the pattern's last
  cell BY POSITION for exactly that reason, and `reference_test`'s `wide6`
  board (6x2 — 2^12, where a 6x4 would have been 16.7M enumerations per rule
  set) is the first board the six-cell clause can even fire on. Everything
  else is two rows per family table, as the area-4 note below promises.
- **The mixed-colour triples (rules 22/23) and the T rules (24/25) are pure
  table rules.** The checkerboard already proved the table speaks mixed
  colours, so `no-dark-light-dark` is two three-cell rows per rule; the T is
  four `fromCells` rotations per colour, and it is SUBSUMED when
  `impliedRun(colour)` is 3 or shorter — every T contains a straight three, so
  those instances could add no pruning and would bias `GenerateCommands::
  cost()` by double-scoring one broken bar (area-two folds in via the implied
  run, so one comparison covers both subsumers; the reference cross product is
  what proves the drop sound). Both oracles gained `hasTriple`/`hasTee` scans
  written with explicit colour equality — a gap equals neither colour, so the
  checkerboard's real-colour guard is not needed and not copied.
- **The 3+1 rules (26/27) and the diagonal rules (28/29) are table rules too,
  and the diagonal pair is the subsumption story's other end.** A 3+1 is four
  four-cell mixed patterns per rule, dropped when `impliedRun(colour)` is 2,
  when `smallestArea(colour)` is EXACTLY 2, or under the colour's
  diagonal rule — the area gate must stay `== 2`, because an area of THREE
  lays out no trominoes and a bent tromino with the odd corner the other
  colour is legal everywhere except under this rule
  (`AnAreaOfThreeDoesNotSubsumeTheThreeOne` pins it). A diagonal rule is two
  2-cell patterns forbidding EVERY corner touch of the colour, blob or not,
  so its regions are straight bars; nothing subsumes it, and it subsumes the
  colour's monochrome 2x2, tees, bent trominoes and 3+1, plus BOTH
  checkerboard patterns from either colour's rule (the connect-implied
  emission included) — each drop gated at its own builder and refereed by the
  reference cross product, while the collinear runs and triples keep their
  work.
- **"Regions have area 3" (rules 30/31) is two rows per family table, exactly
  as the area-4 note promises.** `regionArea` carries both halves, the table
  sees only the implied straight run of four, and `addAreaShapes`'s `!= 2`
  guard already declines it — the 17 non-straight tetrominoes sit on the
  pentominoes' side of the trade.
- **"Regions have area 4" (rules 18/19) is where that trade STOPS paying, and
  the asymmetry is deliberate.** The same argument at four asks for every
  connected FIVE — the 61 non-straight fixed pentominoes, the straight one being
  `addRuns`'s as ever — which is roughly 15 000 clause instances per colour on
  the largest board against the trominoes' 1 200, every one of them rescanned
  whenever a square it names is decided, in the hot path of every probe. So
  `addAreaShapes` still fires only at two, and four is `regionArea`'s alone,
  which enforces both halves at any size for the cost of one component walk.
  `impliedRun` is unchanged and still free: an area of four forbids a run of
  five, and `kMaxPatternCells` was already 5 for the 1x5 rules. What the walk
  cannot see, and the pentominoes would have, is that colouring one particular
  cell welds two legal pieces into an illegal one — a pentomino minus its centre
  can be disconnected. That is bought back by seeding `mergeLimits` and
  `regionsConsistent` from `smallestArea`, which is three lines.
- **The elbow-era shapes (rules 33–38, 43–46, 49–52) are the table cashed in
  seven more times, and the subsumption web got real.** The elbow pair reuses
  `bentPatterns` — the area-two trominoes standing alone, with an `== 2` dedup
  gate so both rules together lay the four out once; the L pair is eight
  `fromCells` tetrominoes (BOTH handednesses); the long-T pair four
  T-pentominoes; the mixed pairs flip one cell of a T (the crossing —
  `no-light-crossed-dark-t` names the ARMS' colour last) and of a bent tromino
  (the corner). The knight and distance pairs are 2-cell patterns like the
  diagonals — and the distance pair's middle square is deliberately NOT named,
  which is what makes `no-dark-any-dark` purely positional: the clause fires
  ACROSS a gap (`AGapBetweenDoesNotLiftTheBan` pins it in both oracles), and
  two squares of one merged cell two apart collapse to a unit clause. Every
  drop is gated at its own builder with a named near-miss beside it
  (`AnAreaOfThreeDoesNotSubsumeTheElbow`, `AnAreaOfFourDoesNotSubsumeTheEll`,
  `AnAreaOfFiveDoesNotSubsumeTheLongTee`,
  `TheOtherMixedElbowKeepsTheThreeOne`); the distance pair is the first
  subsumer the triples ever had, the mixed elbows subsume the checkerboards
  the way the diagonals do, and nothing subsumes a knight. The reference
  cross product referees every drop.
- **Areas 6, 7 and 24 (rules 39–42, 47–48) are family rows again — and the
  table's ceiling became CODE.** Six and seven imply straight runs of seven
  and eight, which moved `kMaxPatternCells` to 8
  (`AnAreaOfSixImpliesARunOfSeven` pins `cells[6]` by position); twenty-four
  implies a run of 25 nothing should lay out, so `addRuns` now SKIPS any
  implied run past the constant rather than trusting the prose rule —
  `regionArea` alone carries that size,
  `AnAreaOfTwentyFourEmitsNoRunPattern` pins the cap, and `regionsOffSize` in
  the generator prices a region at its distance to the NEARER legal outcome
  (grow to the number or vanish), without which area-24 masks marooned the
  local search on boards that cannot hold one.
- **Connect + elbow compiles to COLLINEARITY, and both connects grew a
  border-arc propagator — the first captures of the galaxy-era rules are what
  demanded both.** `connectColor` (reachability refutation + fringe
  exclusion, per connect rule) has existed since the first commit, and the
  Probe already manufactures articulation and pocket deductions from it — so
  when four captured boards (connect + underclued + one shape rule, 1–3
  givens, no clues) ran 97 M nodes deciding nothing, the gap was
  theorem-level rule COMBINATION knowledge, not a missing propagator. Two
  landed, each in the checkerboard lemma's mould: `addCollinearPairs` in
  `Rules.cpp` — connect(colour) + the colour's elbow ban pin every pair of
  the colour to one row or column (any path between off-axis cells turns, and
  the turn is a forbidden bent tromino), compiled as every off-axis 2-cell
  pair, ends-only like the distance pair so it fires across gaps and
  collapses to a unit clause inside a bent merged cell; and `borderArcs` in
  `Propagate.cpp` — with BOTH colours connected, the decided colours around
  the outer perimeter (`Model::borderCycle`) form at most one arc each, since
  four alternating arcs force a dark and a light path that would have to
  cross; more than two cyclic transitions refutes, and an open square
  strictly inside an arc loses the other colour because a cyclic
  subsequence's transitions never exceed the full cycle's. Measured:
  `logicGridTest366` went 8.9 s → 0 ms and `logicGridTest369` from 90 s
  UNSOLVED to 2 ms proven, with every other underclued answer byte-identical.
  The subsumption gates that used to ask for a colour's diagonal RULE now ask
  `hasDiagonalBan` — rule or implied family — and the family dedups its
  (1,1) and knight members against those rules' own builders
  (`TheDiagonalAndKnightMembersAreNotLaidTwice`). A deliberately ABSENT third
  lever: probe-first refutation in the underclued loop was designed and then
  skipped, because after these two nothing measurable needed it.
- **`off-by-one` (rule 32) bends every NUMERIC clue — area, dart, viewpoint —
  to display its true count ± 1 and never the truth.** The engine holds each
  clue's allowed true counts as `Model::candidatesFor`'s exact SET of at most
  two values, floor-filtered per kind so the game's "one true value" cases
  fall out (displayed 0 ⇒ 1; displayed area or viewpoint 1 ⇒ 2). Every
  consumer filters PER CANDIDATE against its held..room bracket — never the
  interval, whose middle gap would wave through a region closed at exactly
  the displayed value — and at a complete assignment the filter equals the
  oracle's `|actual − v| == 1`, which is what keeps `oracleRejections` at
  zero. `Regions` grew an `areaLo`/`areaHi` band whose exact intersection IS
  the off-by-2 trick ({a±1} ∩ {b±1} is the middle value when |a−b| == 2), and
  two zero sentinels had to die for the displayed 0: `cardinality`'s target
  and `absorbSquare`'s read of `areaValueAt`. The displayed bounds widen by
  one at both ends on every layer — `clueValueProblem`, the TS validator (the
  `LogicGridSize` ctx gained `offByOne`, computed from the file's own rules
  AFTER `rulesError`), the editor's fields (min/max re-set in place by
  `refreshSymbolRow` on the chip toggle, since the row is not rebuilt) and
  the keystroke floor (`Board.setOffByOne`, pushed in because the board
  cannot see `activeRules`). The generator perturbs each derived value with
  ONE appended draw reachable only from explicit `--rules` masks: `OffByOne`
  never joins `kColorRules`, Underclued's own exclusion ground, so no
  maskless seed shifted and no fuzz baseline went stale for it.
- **"One symbol per area" (rules 13/14) is two deductions, and the game names
  them.** *Exactly one means less than two* is a refutation — a finished piece
  already holding two clues can never be legal, and a cell that would weld two
  clued pieces together cannot take that colour (`mergeLimits`). *Exactly one
  means more than zero* is the half that paints: every cell of the colour has to
  end up sharing a region with a clue, so a cell no clue can REACH is a cell that
  cannot hold it. That reach is bounded by an area number's own value, which is
  what the game calls **tethering**; feed the cells it settles to the pattern
  clauses and **area reach** falls out too. Neither of those has its own code and
  neither should: they are this rule met by propagation, the same way the rest of
  the technique list is.
- **The dart (clue kind 2) is the first clue whose POSITION matters, and the
  first added since the model was written.** It counts the squares of the
  opposite colour along a straight line from its own square to the edge of the
  board, stepping over gaps rather than stopping at them, and counting a merged
  cell once per square the line crosses. Four things about it:
  - **Every `if kind == area … else letter` had to become three-way**, and each
    of those was a real bug waiting: `clueValueProblem` would have validated a
    dart's number as a letter, `buildClueTables` would have put it in a letter
    group and indexed a 26-entry array with it, and `Regions::absorbClue` would
    have read its number as its region's required size. A dart *is* counted as a
    symbol for "one symbol per area", which needs no change and is right.
  - **The line EXCLUDES the dart's own cell**, and that is a correctness
    requirement rather than a tightening. Every square of that cell holds the
    dart's own colour, so none of them can be the colour it counts; left in, the
    "the line is exactly full" branch would assign the other colour to one of
    them, `Domains::exclude` would fan that over the whole cell, and the dart
    would refute itself. Out, `ray.count()` is also exactly the largest number
    the dart could legally carry, which is what `DartExceedsLine` reports.
  - **`dartCardinality` walks CELLS, not squares** — taking each cell the first
    time one of its squares turns up on the line, never by intersecting with
    `representatives`, which would drop every merged cell whose lowest-indexed
    square lies off the line. That is what makes the game's *forced multitiles*
    fall out of the counting: a cell putting three squares on the line is
    excluded as soon as three would overshoot. Its `held`/`room` are computed
    once and go stale as cells are decided, which can only weaken the two tests;
    `propagate` re-runs to a fixpoint, so nothing is lost.
  - **The rest of the technique list needs no code.** *Dart minimax* is the
    zero and full ends of that same counting. *Dart pattern maximums* — a dart's
    count interacting with the run and domino rules — is `Probe`: colour one
    cell, let the clauses and the count meet, and the contradiction appears.
    *Overloading darts*, two same-direction darts on one line fixing the count
    between them, is the one that would need its own pairwise propagator, and it
    is deliberately absent until a captured board asks for it; `reference_test`
    already carries a `twoDarts` board so it cannot land unchecked.
- **The lotus (clue kind 3) is the first clue that is a CONSTRAINT SHAPE rather
  than a count**: the connected same-colour region holding it must map to
  itself across an axis through its seat — every region square's mirror
  on-board, playable, and the same colour. Six things about it:
  - **The geometry lives in doubled coordinates** (`cx2 = 2x + (seat & 1)`,
    `cy2 = 2y + (seat >> 1)`), so a seat on a grid line is still an integer,
    and `mirrorSquare` in `Types.h` is the DEFINITION of what an axis does —
    shared at `kDirectionSteps` altitude, while the per-lotus mirror MAP stays
    with `buildLotuses` and `verify::lotusProblem` re-derives everything from
    the clue, the `dartProblem` discipline. `buildLotuses` has `buildDarts`'
    net: a clue with an unreadable axis or seat stays in `lotusClues` but out
    of `lotuses`, so the oracle refuses every colouring rather than the board
    quietly solving without it.
  - **`propagateLotuses` fires only with the lotus's own colour DECIDED**: the
    decided-connected core's mirrors are forced to the colour (opposing cells,
    with off-board/unplayable mirrors — opposing nulls — as refutations), and
    a fringe cell any of whose squares mirrors somewhere the colour can never
    be is kept out whole. At a complete assignment the core IS the region and
    the loop equals the oracle, which is what keeps `oracleRejections` at 0.
    **With the colour's CONNECT rule on, both nets widen to the whole board**:
    the region is provably the entire colour, so one symmetry clue plus one
    connectivity rule folds the board in half — both colours, since a mirror
    that cannot take the lotus's colour is forced the other way. The argument
    is spelled out on `lotusSymmetry`; `logicGridTest325` is the board that
    demanded it — seven viewpoints on a 9×9, 90 s unsolved at 104 M nodes
    without the fold, 2 ms of pure deduction with it.
  - **"Uncoloured symmetry" is the probe, not code**: probing the lotus's cell
    runs the propagator under both colours and keeps the intersection, which
    is exactly the game's technique. The "connection restriction" (two
    same-direction lotuses share an axis or a region) emerges too — parallel
    axes force a translation that walks the region off the board — and
    `reference_test`'s `twoLotuses` board is what referees both.
  - **Every kind switch became a-branch-per-kind, not three-way.** The
    trailing block of `clueValueProblem` is the DART's by exhaustion, and
    `buildClueTables`' trailing `else` is the LETTER's — a lotus falling into
    either would be axis-validated as a compass direction or filed under
    letter group A. `structureProblem` validates the seat AFTER the shapes
    (`lotusSeats` needs the merged cell), and `contradiction()` names
    `LotusMirrorLeavesBoard`: a square of the lotus's own cell reflecting off
    the board or onto a gap is unsolvable before any colouring.
  - **Free, verified rather than re-implemented**: `Profile::applicable`
    declines it as a non-letter clue, `symbolCountProblem` counts it as a
    symbol for the one-symbol rules, `clueReach` over-approximates it as a
    whole component, and `Reference.cpp` cost zero lines because legality
    comes entirely from `Verify`.
  - **The generator's `--lotus PERCENT` is the dart roll's pattern appended
    once more** — after the dart roll, behind the same `> 0` short circuit, so
    `--lotus 0` byte-reproduces every seed (measured). Unlike a dart there is
    no value to derive: an axis is drawn, then `lotusHoldsAt` CHECKS the
    colouring's region really mirrors and draws nothing, so a failed check
    just costs the region its clue. Yield is best on rule-free or underclued
    boards (a single-cell region mirrors across anything), so raise the
    percentage well above `--darts` — and note every batch joining
    `kColorRules` shifts every generated seed, so a fuzz baseline predating
    the newest entry is stale.
- **The viewpoint (clue kind 4) is the first counting clue with no direction:
  its number is its own square plus the leading same-colour run along each of
  the four rays.** Sight STOPS at a gap — where the dart's line steps over one
  — and at the first other-coloured square or the edge; merged cells count
  once per square a ray crosses, and an own-cell square OFF the rays does not
  count at all — the walk is plain square-level colour geometry, no cell
  awareness anywhere. Structural bounds: 1 (it always sees itself, so zero is
  refused) to `w + h - 1` (the CROSS — which is why `LogicGridSymbolKind`
  gained `reach: "board" | "line" | "cross"` with `symbolValueMax` dispatching
  on it, and `reach: "cross"` is also what makes `dressClue` draw the four
  `chevron_right` glyphs, one glyph turned four ways like the dart's arrow and
  already in the icon subset). Six things:
  - **`propagateViewpoints` brackets every ray between `held` (leading run
    already decided) and `room` (as long as it could still grow)**, refuting
    when the total leaves `value - 1` unreachable and forcing each ray
    against what the other three can supply or spare — the game's *maximal
    viewpoints* and *viewpoint expansions* are the bracket's two ends, and
    the lo/hi scheme is `viewpointSight`'s own doc comment. Stale bounds
    re-run to a fixpoint (`dartCardinality`'s discipline), and at a complete
    assignment the refutation equals the oracle, which is what keeps
    `oracleRejections` at 0.
  - **An uncoloured viewpoint reasons through the probe**, like an uncoloured
    lotus: `viewpointColorChoice` only rules out a colour NO completion could
    satisfy, and the probe running the propagator under each colour of a ray
    square is what the game's *no domino viewpoint trick* and *perpendicular
    viewpoints* fall out of — `reference_test`'s `twoViewpoints` board is the
    referee, and `AnUncolouredViewpointFallsOutOfTheProbe` the propagate pin.
  - **`Viewpoint::rays` are ORDERED and KEEP the clue's own cell's squares** —
    both the opposite of the dart's line, both argued on the field's own doc
    comment — and `contradiction()` names `ViewpointExceedsSight` when the
    value outgrows what the gap-cut rays could ever show.
  - **`clueValueProblem`'s viewpoint branch IGNORES a stray `direction`**
    rather than refusing it by name — the first kind to invert that
    discipline, argued at the branch; the TS validator still refuses the key
    via `aims: "none"`, and `SeatOnWrongKind` covers the seat generically.
  - **Free, verified rather than re-implemented**: `Profile::applicable`
    declines it as a non-letter clue, it counts as a symbol for the one-symbol
    rules, `clueReach` over-approximates it as a whole component, the editor's
    control is chip + field with no toggles purely from `aims: "none"` +
    `valueKind: "number"`, and `Reference.cpp` cost zero lines.
  - **The generator's `--viewpoints PERCENT` is the roll pattern a third
    time**, appended after the lotus roll behind the same zero-skip contract
    (byte-reproduction measured); `viewpointValueAt` reads the count off the
    colouring, so every roll that fires places a satisfiable clue.
- **The galaxy (clue kind 5) is the lotus's half-turn twin, and the first
  chip-only kind.** Its centre may be a square's own centre, the midpoint of an
  edge or a corner where four squares meet, so the geometry is `halfTurn` in the
  same DOUBLED coordinates `mirrorSquare` uses — a centre on a grid line is then
  still an integer. A half turn maps square centres to square centres at every
  seat parity, so unlike the axis there is no `diagonalSeatValid` twin and no
  seat a galaxy has to refuse. Seven things about it:
  - **The turn carries a SIGN, and that is the whole of what a seat changes.**
    Centred on a square, that square is its own image, so the sign can only
    PRESERVE colour and the rule is what it always was — the seatless galaxy is
    the special case, not the rule. Centred between squares of DIFFERENT
    colours it INVERTS: every cell's image holds the opposite colour, so the
    dark region and the light region touching the centre are each other's
    image. The sign is read off the home square and its partner, which always
    exist. SCOPE is every region touching the centre — up to two at an edge,
    four at a corner — and walking all of them is load-bearing rather than
    thorough: the turn is an involution, so one region's image lies IN the
    other, but the other may reach further and only its own walk says so. A
    corner whose two pairs disagree about the sign needs no check of its own,
    since the second pair's squares are themselves in scope.
  - **The propagator is the lotus's, shared rather than cloned.**
    `lotusSymmetry`'s whole fold — decided core, connect-rule widening to the
    whole colour, cell-granular fringe, open-mirror guard — reads nothing but
    the mirror map, so it became `mirrorSymmetry(model, domains, mirror,
    index, color, target)` and both kinds dispatch into it; the extra parameter
    is a TARGET COLOUR rather than a flag, so a lotus passes `target == color`
    and is untouched. `propagateGalaxies` skips while the SIGN is unknown
    rather than while the clue's own cell is open, which is strictly stronger:
    at a corner, two squares decided across the centre unlock the fold even
    with the clue's square still open. `Sign::Inconsistent` refutes outright.
    At a complete assignment the fold equals `verify::galaxyProblem`, keeping
    `oracleRejections` at zero; an uncoloured galaxy reasons through the probe,
    the lotus's uncoloured-symmetry story over again. Deliberately absent: the
    XOR chain — `colour(c) ^ colour(image(c))` is the same bit for every square
    in scope, so three decided cells force the fourth without the sign being
    known at all. That is a 2-XOR propagator, a new shape of reasoning here,
    and it waits for a captured board to ask for it.
  - **"Galaxies cannot touch" is a THEOREM and is deliberately coded
    nowhere**: two half turns compose to a translation no finite region
    survives, so it emerges from the fold meeting the probe —
    `TwoGalaxiesCannotBeWeldedTogether` and the `twoGalaxies` reference board
    referee it, exactly as `twoLotuses` does the connection restriction.
  - **Valueless and unaimed, but SEATED — and seat-carrying is a capability of
    its own.** `valueKind: "none"` + `aims: "none"` make the control a bare
    chip, the re-click a lift (`turnsInstead` never fires without a direction),
    typing and arrows inert; a value is refused by `GalaxyValue` and a stray
    direction is IGNORED, the viewpoint's discipline. But a seat is NOT refused
    any more, and that is why `seating` exists beside `aims`: seat-carrying rode
    on `aims === "axis"` only because the lotus happened to be both, and a
    galaxy — seated yet aiming nowhere — is exactly the kind that coincidence
    mis-reads. `"none"` is the square's centre and nothing else, `"cell"` the
    lotus's (inside its own merged cell, because an axis is a LINE a tile has to
    draw), `"board"` the galaxy's (any point of the grid, because a half turn
    needs nothing to hold its point up). C++ says the same through
    `carriesSeat`, beside `isValuelessKind` and for its reason. WHERE a seat may
    sit stays per kind: `lotusSeats` after the shapes, and the galaxy's bounds
    check inside `clueValueProblem`, which needs only the dimensions.
    **Playability is deliberately not asked**: a gap painted beside an already
    seated galaxy would break the invariant anyway, so the file loads and the
    contradiction names it, the honesty rule impossible clue combinations
    already follow. `FixtureIo`'s lotus-only value branches became
    `isValuelessKind`, and its lotus-only seat WRITER became `carriesSeat` —
    a seat of 0 is still omitted, so every captured galaxy round-trips
    byte-identically.
  - **The tile is one glyph, and the kind SAYS so.** `LogicGridSymbolKind`
    gained an optional `icon` field (`GALAXY_ICON = "cyclone"`, added to the
    common.css subset); `dressClue` branches on it FIRST and every other
    branch sheds the `data-icon` hook, or a restamped cell keeps icon
    centring on text. `describeCell` gained the valueless-and-axis-less
    branch, without which a galaxy read as "Galaxy undefined".
  - **A galaxy BOUNDS its region's reach, and that is known before a single
    cell is coloured.** Its region maps onto itself under the turn, so a cell
    whose image is off the board or on a gap can never be in it — purely
    geometric, and true whatever the colours or the sign. `clueReach` applies it
    by flooding from the clue through cells that can turn back onto the board
    rather than trimming afterwards, since a cell reachable only THROUGH a
    forbidden one is not reachable at all. Under `one symbol per area` that is
    what tethers the rest of the board: a galaxy near an edge can only ever
    share a region with the half that turns onto itself, so every cell of its
    colour outside that half has to belong to some other clue. `logicGridTest12`
    is the captured case — an underclued 8x8 whose 23 forced cells all sit in
    the three columns the galaxy's turn cannot reach, and which took the
    per-cell refutation past two minutes without proving one of them. With the
    bound it is deduction alone, in a second and a half.
  - **`GalaxyMirrorLeavesBoard` now fires on plain squares too.** At seat 0 a
    plain square turns onto itself, so it could only ever fire through a merged
    cell; on a grid line or a corner a square at the board's edge turns straight
    off it, and one beside a gap turns onto the gap. The check widened from the
    clue's own cell to every playable cell touching the centre.
  - **The generator's `--galaxies PERCENT` is the roll pattern a fourth
    time**, appended after the viewpoint roll behind the same zero-skip
    contract — a roll which previously FELL OFF the end of `clueOneRegion`
    with no trailing `return`, the bug appending one more kind would have
    armed. `galaxyHoldsAt` checks the colouring and draws nothing, so like
    `--lotus` its yield wants a percentage well above `--darts`. It places
    galaxies at seat 0 only, so every seed still byte-reproduces; a
    `--galaxy-seats` roll would be an appended draw behind the same zero-skip
    contract, and is deliberately not one yet.
  - **No format version bump, and the mechanics settle it.** No key changed
    meaning and strictly more files are legal — the `direction`/`seat`/`shapes`
    precedent exactly. The version is `configVersion(MIGRATIONS)`, derived from
    the list's LENGTH, so a bump is unspellable without a migration, which here
    would be the identity; and `fixtureio::load` refuses any version but the
    current one, so a bump would force rewriting every fixture to record that
    nothing changed. Nothing in the corpus exercises a seat, so the coverage is
    the hand-built `seatedGalaxyBoard` in `wasm.test.ts` and the seated boards
    in `reference_test.cpp`.
- **The letter boards get a ROUTER, and it is a construction rather than a
  search.** `Routing.cpp` is the third arm on a board whose only clues are
  letters. It treats the puzzle as what it really is — give each letter a
  region of its own and keep the regions apart — and solves it the way a global
  router does: route every net through the cheapest cells, charge for the cells
  two nets both want, and repeat with the price rising until nobody overlaps.
  Six things about it:
  - **It answers `Solved` or `Unsolved` and never `Unsolvable`.** Failing to
    build something proves nothing about whether it exists, which is exactly
    the claim `profile` may make and this may not.
  - **Every colouring goes through `verify::check` before it is returned.**
    That is what makes the gate a budget question rather than a correctness
    one: a construction that misreads the puzzle produces nothing, not a wrong
    answer. `applicable` still declines rules, non-letter clues and merged
    cells, because "everything unclaimed takes the other colour" breaks all but
    the emptiest rule set and the oracle would simply throw the result away.
  - **The price has to GROW.** A flat congestion price oscillates — two nets
    swap the same cell forever — so the pressure factor rises every round and
    the HISTORY of a contested cell is charged even once it is free. Measured
    on the 23x21 board: a flat price never converges, halving the growth rate
    takes seven seconds to sixteen, doubling it to eight.
  - **A halo is charged at HALF an overlap.** Two regions of one colour that
    merely touch are one region, so the halo is a real conflict — but pricing
    it like an overlap prices most of the board out of reach and measurably
    stops the router settling anywhere.
  - **No random jitter in the search.** A weight redrawn on every relaxation is
    not a weight: Dijkstra needs a cell to cost the same however it is reached,
    and noise the size of the base step swamps the differences the price exists
    to express. Variation comes from the order the nets are rerouted in.
  - **It is what settles `logicGridTest454`** — 23x21, 110 given dark cells in
    a lattice with eight letter pairs between them, no rules. The DFS reached
    127 of 483 cells with zero refutations and stayed there at 60 s, 90 s AND
    240 s; the sweep's frontier is 21 wide where 16 is the ceiling, and widening
    it ran out of memory at 202 million states. The router takes about seven
    seconds. Boards whose letters are pinned to DIFFERENT colours by their
    givens — `logicGridTest67` is the captured case — are outside the
    construction and fall through to the sweep, which is why both arms exist.
- **The region-clued boards get a PACKER, on exactly the router's terms.**
  `Packing.cpp` is the fourth arm, for a board whose every clue names a REGION
  rather than a cell — an area number, or a letter — sitting on a square the
  puzzle already paints, all in one colour. That board asks one question and
  only one: can regions of exactly the demanded sizes be laid out with no two
  of a colour touching? What is left over is the other colour, and where the
  board says nothing more about it that is the answer rather than an
  approximation. Like the router it says only `Solved` or `Unsolved` and
  verifies every colouring before returning it. Five things about it, all
  measured on `logicGridTest476`:
  - **Small clues are tried as whole SHAPES, compact first.** What the big
    regions are short of is room, and the compact shape is the one that spends
    least of it. `kMaxShapeCells` is 8, where the shape count per clue is still
    in the thousands.
  - **Big clues are never enumerated.** They are decided by a LOOKAHEAD that
    grows one of them a cell at a time and abandons a branch the moment another
    big clue's cell can no longer reach its own size. The result is MONOTONE in
    the free space, which is the whole point: free space only shrinks as more
    regions land, so running the lookahead on a PARTIAL placement is a sound
    prune, and a hopeless prefix dies before the small regions are finished.
  - **The last region left needs no search at all.** Its component is
    connected, so a connected subset of exactly the right size containing the
    clue can always be carved out of it — counting is the exact test, not a
    relaxation of one.
  - **Small clues are ordered NEAREST A BIG CLUE FIRST.** The lookahead can
    only prune once the space around a big clue has actually been cut, so the
    regions that crowd it have to be committed first. In fixture order the same
    search runs for minutes; in this one it takes seven seconds.
  - **Two clues of one value may share ONE region**, and `logicGridTest476` has
    no packing at all unless its two 3-clues do — the reading where each takes
    a region of its own is exhaustively impossible. So the shape lists keep the
    sets that swallow a same-valued neighbour and sort them first, and the
    room-left bound counts one region for a group rather than one per clue.
    Being within reach does not make sharing possible, only conceivable, which
    is the right way round for a prune.

  It is what settles `logicGridTest476` — 11x11, eleven area clues including a
  24 and a 26, no rules — where the DFS sits at 13 of 121 cells after 21
  million nodes, at 120 s just as at 20 s, and both other constructions decline.
  Its cascade slice is 70% rather than the router's 15%, because where the
  packer applies the arms after it have nothing to offer, and where it does not
  it declines on one predicate.

  **The second class it takes is `logicGridTest481`, the 12x12 pentomino
  board**, and four more things carry that one:
  - **A LETTER raises a demand too**, for all the cells carrying it at once,
    since the puzzle says they share a region. What it never says is how big
    that region is, so a board with letters needs the single `areas` instance
    that gives every region of the colour a size, and is declined without one.
    A letter demand also carries its letter, because two letters may never come
    out as one region however well the sizes fit — the one thing a letter says
    that a number does not.
  - **The rules it takes are the ones it can honour.** A shape rule
    (`distinct-shapes` / `same-shape`) on the CLUE colour is a filter on what
    may be placed next, so it prunes; on the other colour it is declined, since
    the search steers none of those regions and could only build something the
    oracle then throws away. Both connect rules are taken and tested on the
    FINISHED packing, inside the search so it backtracks — checking them after
    the arm returned would turn a solvable board into no answer at all.
  - **Givens that carry no clue are read, not refused.** One in the clue colour
    is a square some region has to swallow; one in the other colour is a square
    no region may claim. The first also gives a cheap prune with real bite: a
    must-cover square that has landed in the halo of a placed region can never
    be claimed by anything, so the branch is dead — which is also what took
    `logicGridTest476` from 13.4 M nodes to 8.8 M.
  - **With no big demand to crowd, order by FEWEST SHAPES.** There is nothing
    to leave room for then, so the ordinary most-constrained-first ordering is
    what pays: on the 12x12 the letter pairs four cells apart have six shapes
    each and the loosest area number has 222, and leading with the six is the
    difference between two hundred thousand nodes and not finishing.

  That board is `areas` dark = 5 with `distinct-shapes-dark` and
  `connect-light`, eight letter pairs and six area numbers — so its twelve dark
  regions are the twelve free pentominoes, one each. The DFS reaches 35 of 144
  cells in 60 s; the packer answers in 81 ms. `logicGridTest482` is the same
  puzzle with a player's own deductions painted in, which is what exercises the
  given handling above; it answers in 129 ms and to the same colouring.
- **An aborted look-ahead proves nothing.** `ProbeResult` is tri-state for that
  reason. Reading a budget-expired probe as a refutation is the standard way
  this kind of solver goes quietly unsound, and the underclued mode rests
  entirely on telling "no solution exists" apart from "I stopped looking".
- **`Profile.cpp` is a second engine, not a heuristic, and it is what makes the
  letter-only boards tractable.** It sweeps cell by cell keeping a FRONTIER —
  the colour of each boundary cell, which of them are in the same region, and
  which letter each region carries — so partial colourings that agree on that
  much collapse into one state and the cost becomes the number of distinct
  frontiers rather than the number of colourings. It is complete, so it answers
  `Unsolvable` honestly. Measured: `logicGridTest47` went **8 200 ms → 2 ms**,
  and `logicGridTest67`, which no search or local method could touch, comes out
  in 38 s natively and **45 s in the browser**. Four things about it are load-bearing:
  - **A class that MERGES is not a class that CLOSED.** Both make a label
    vanish from the frontier and they mean opposite things — a merge is two
    pieces of one region meeting, a close is a region that can never grow. The
    first version conflated them and threw out the known answer to board 67 at
    the very last cell.
  - **Class ids can reach `width`, so the per-class arrays are sized above it.**
    An id one past the end read as letter 0 (`A`) in the prototype and quietly
    corrupted the tags; in C++ that is a buffer overrun rather than a wrong
    answer.
  - **`applicable()` is a WHITELIST on both axes, and that is not tidiness.**
    It takes letter clues, darts on a square the puzzle paints, `connect-dark`,
    `connect-light`, `Underclued`, and every rule whose WHOLE content is a
    forbidden local arrangement. It refuses everything else. Written
    as a denylist it was wrong the moment the catalogue grew: a dart-only board
    named no area clue and no listed rule, so it was ACCEPTED, `planOf` reads
    letters only and skipped the dart, and `runProfileForced` then set `proven`
    on a forced set with no oracle behind it — a superset of the solutions,
    reported as proof. Nothing downstream could have caught that (`Verify` gates
    `runProfile`'s witness, not the forced set), which is why anything
    unrecognised has to decline by default and cost a re-measurement at worst.
    Refusing costs nothing anyway: those boards are exactly the ones propagation
    finishes in milliseconds. Running out of room sets `stoppedOnMemory` and
    claims NOTHING, because an empty sweep must never read as "no solution".
  - **An ARRANGEMENT is read off recent colour, and that is why those rules are
    on the list.** The frontier's `width` slots ARE the last `width` cells in
    scan order, so a forbidden pattern anchored on its last cell needs only
    what reaches further back than that — one bit for a 2x2, a row for a
    three-tall T — and `Frontier::hist` carries exactly those. Each instance is
    built PER POSITION, so one that would fall off the board or onto a gap is
    dropped when the plan is built and can never fire; `kMaxHistoryBits`
    declines a board whose patterns reach further than the state will hold,
    which is what keeps a tall run rule out. What stays off the list is
    everything with region-level content, however local it looks: an area or a
    run instance — `patternsFor`'s own comment records that its trominoes are
    only half of what an area means — the one-symbol rules, the shape rules,
    and `OffByOne`, which changes what every count means rather than what any
    arrangement is.
  - **A DART is one running count, and only on a PAINTED square.** The sweep
    counts the DARK cells on the ray and takes the light reading as the rest of
    it, so one counter serves either colour; the counter goes back to zero the
    moment the dart is settled, so states merge again and a dart on another row
    of the sweep costs nothing at all. What it cannot do is a dart the board
    leaves unpainted: a dart counts the OPPOSITE of its own square's colour, so
    an unpainted one would need that square's colour carried long after it left
    the frontier. This is what settles `logicGridTest487` — 13x7, underclued,
    `connect-dark` + `no-dark-T` + two darts — 23 of 91 cells PROVEN in 26 ms,
    where `runForced` never found a single witness in 30 million nodes and so
    reported nothing at all. Note what the answer contains: `(9,1)` is forced
    light and deduction never sees it, so a `forced` run would have had to
    exhaust the space with that cell dark to prove it.
  - **It answers the UNDERCLUED mode too, and that is where it pays most.**
    `runProfileForced` reads the forced set straight off one backward pass —
    mark the states that can still reach an accepting end, and a cell is forced
    exactly when every surviving path paints it the same way. `runForced` gets
    the same answer by proving each candidate cell with its own search, which on
    a letter-only board with no rules has nothing to prune with. Measured on the
    captured boards that stalled: `logicGridTest96` 60 s → 1.0 s,
    `logicGridTest108` and `109` from timing out to 12 ms and 1 ms,
    `logicGridTest107` 13.3 s → 1 ms. It keeps every layer's frontiers where the
    witness sweep keeps five bytes a state, so its cap is much tighter and it
    declines rather than thrashes.
  - **Only seed 0 runs it, and the other cascade arms are not started at all**
    (`armIsUseful` in `SolverArms.cpp`) when it applies. It is deterministic, so
    those arms would repeat identical work, and their DFS cannot finish the
    boards it exists for. This is the single biggest number in the whole change:
    every thread in the in-module race shares one wasm heap and one allocator
    lock, and leaving three useless arms running took board 67 from **45 s to
    160 s** in the browser — the difference between fitting the page's budget
    and not. `SOLVE_BUDGET_MS` is 120 s for the same reason: 45 s measured with
    almost nothing else in the corpus above a tenth of a second.
- **The DFS keeps its own stack, and must not go back to recursing.**
  `Dfs::descend` is a loop over a `std::vector<Frame>`. Written the natural
  recursive way it costs one machine frame per GUESSED cell, and the compiler
  inlines `pickCell`'s several `Bits` temporaries into that frame — measured at
  roughly 900 bytes. Emscripten's default stack is 64 KB, so a 10×7 board with
  no rules (seventy cells, nearly all of them guessed) overflowed it and the
  module trapped with `RuntimeError: Out of bounds memory access`, while the
  native build solved the same board in 32 ms. **Raising `STACK_SIZE` is not the
  fix**: the depth bound is the playable-cell count, up to `kMaxCells` = 1024,
  which is close to a megabyte of frames on a board the editor accepts — the
  native build is not far from its own limit either. Boards with few rules are
  what reach that depth, because rules are what let propagation decide cells
  instead of guessing them. `deepSearchBoard` in `boards.ts` goes through the
  real wasm on every run to keep this from coming back; **only the wasm lane can
  catch it**, so it must not be moved to a native-only test.
  **The lg wasm variants additionally set `STACK_SIZE` (and, threaded,
  `DEFAULT_PTHREAD_STACK_SIZE`) to 1 MB** — matching what MSVC gives native
  threads — because the iterative DFS still runs propagation chains carrying
  several KB of `Regions`/`Bits` locals per call, five million times per arm,
  on FOUR pthread stacks whose emscripten default is the same 64 KB this
  solver already overflowed once. A pthread stack overflow lands in the
  SHARED heap, which is how the first captured galaxy board
  (`logicGridTest377`, a 17 s four-arm DFS race) intermittently killed the
  whole tab with STATUS_ACCESS_VIOLATION or surfaced an Emscripten "unwind"
  instead of trapping cleanly; with the megabyte stacks it solved three
  browser runs back-to-back. The crash never reproduced under the harness, so
  this is mechanism-matched hardening, not a bisected root cause.

The underclued answer is a sandwich — what deduction proved ⊆ what is really
forced ⊆ what every solution found so far agrees on — and only the gap between
the ends costs anything. Deduction gives the lower end for nothing and is
usually most of the answer, because these puzzles are built to be worked out by
hand. Each remaining candidate is settled by searching the whole space with that
cell painted the other way: nothing found proves it, and a solution found
instead knocks out every other candidate it disagrees with.

Deliberately absent: a transposition table (states essentially never recur along
different paths of a fixed-variable CSP), a rollback union-find (every region
question is a flood fill over 1024-bit boards, which needs no undo), and
restarts in the DFS (a restarting search that keeps nothing it learned is not
complete, and "there is no solution" is only worth anything from a complete
one — diversity comes from a random starting colour instead).

`Bitboard.h` is why the row pitch is a fixed 32 rather than the board's width:
one 64-bit word holds exactly two rows, so up/down are a 32-bit shift and
left/right are a 1-bit shift after masking the column that would wrap. The two
boundaries that speak the packed `y * width + x` layout — the wasm bridge and
`FixtureIo` — convert, which they were already doing because the config's
`cells` is column-major.

## The config format version

A logic-grid download opens with `"version": 2`, and **a file with no tag at all IS version 1** — the format as it stood before the tag existed. That default is what lets every board downloaded before the tag keep loading: it reads as 1 and migrates.

Version 2 is the first REAL migration (`sizedRulesIntoFamilies`): it moves the 22 sized indices out of a v1 file's `rules` into canonical `areas`/`runs` entries, leaves anything malformed exactly where it was for the validator to name, and DISCARDS any `areas`/`runs` keys a v1 file already carried — v1 semantics dropped unknown keys, and migrating is not the moment to start honouring them. The current validator then refuses a sized index in `rules` by name.

When the format changes in a way an old file cannot satisfy, three things move together:

1. a migration is **appended** to `MIGRATIONS` in the page's `config.ts`, which is what raises `CONFIG_VERSION` — the version is `configVersion(MIGRATIONS)`, derived from the list's LENGTH, so a bump with no migration (old files unreadable) and a migration with no bump (never runs) are both unspellable;
2. the committed fixtures are rewritten to the new shape in the same change, because `fixtureio::load` **refuses** any version but the current one — the native tools read only this repo's own files, so migrating there would be machinery for a case that means the rewrite was forgotten;
3. anyone loading an older file gets the board *and* a banner saying to download it again, since what is stale is the copy on disk.

Four things are load-bearing:

- **The list is append-only and addressed by position.** Entry 0 turns a version 1 file into a version 2 one; a version 1 file on a version 4 build runs all three in order. Reordering or removing an entry re-reads every file ever saved — the same rule the rule and clue catalogues live under.
- **Migration runs before a single structural check**, since a migration is exactly what makes an old shape make sense to the current validator. A non-object passes straight through so the page's own "must be an object" message is the one shown.
- **A file from a NEWER build is refused by name** rather than read as far as it parses. There is nothing to migrate backwards, and quietly dropping what this build does not recognise would load a different puzzle.
- **`version` is required on `LogicGridTest`, not optional.** Absent means 1 on the way IN; everything this build writes says which version it is, and making the field required is what stops a writer forgetting — there are three (`currentConfig`, `validateConfig`'s rebuild, `fixtureio::save`) and they must all stamp it.

`test/configVersion.test.ts` drives the machinery with migration lists it makes up, which is the only way to prove the chain runs, runs in order, and runs only the steps a given file still needs. The REAL chain's behaviour — the v1 conversion, its garbage tolerance, the discarded v1 keys — lives in `config.test.ts`'s "The v1 migration" describe, the banner path in `logicGridSolver.test.ts` and e2e. `LogicGridCorpus.EveryBoardIsTheCurrentFormatVersion` is what catches fixtures a rewrite missed: the fixture sweep `GTEST_SKIP`s a load error, so without that check a stale corpus would go green while testing nothing — and since version 2 `fixtureio` refuses a MISSING tag too, absent-means-1 being exactly the stale state.

