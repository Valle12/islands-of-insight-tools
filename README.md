# Islands of Insight Tools

A small collection of puzzle solvers for the game
[_Islands of Insight_](https://store.steampowered.com/app/2071500/Islands_of_Insight/).

**→ [valle12.github.io/islands-of-insight-tools](https://valle12.github.io/islands-of-insight-tools/)**

Some of the game's puzzle types are quick to recognise but slow to work out by
hand — especially the larger grids, where a wrong first move can cost several
minutes of undoing. These tools let you recreate a puzzle you are stuck on and
get a solution back.

Every tool works the same way: **describe the puzzle you see in the game**, press
solve, and follow the answer. The solving happens entirely in your browser, so
the puzzles you enter are never sent anywhere, and each one can be saved to a
JSON file and loaded again later.

## The tools

### Match Three Solver

For the grids of coloured blocks that clear when three or more line up. Paint the
board with the blocks and blockades you see, and the solver returns a **sequence
of swaps that clears the whole board**, one step at a time — each step showing
exactly which two blocks to exchange. Most boards answer in well under a second.

### Phasic Dial Solver

For the puzzles where a row of dials all has to be turned back to centre, and
every button turns several dials at once. Enter how many sides each dial has and
where it currently points, then what each button does to each dial, and the
solver returns how many times to press each button — using as few presses as it
can.

### Rolling Blocks Solver

For the puzzles where blocks are rolled around a board to cover marked tiles or
reach a goal. Lay out the board and the blocks, and the solver returns the rolls
that solve it.

### Shifting Mosaic Solver

For the sliding-block puzzles where a goal block has to reach a highlighted zone
past a crowd of obstructions. Draw the obstructions and the goal block, place the
goal zone, and the solver walks you through the moves.

## Running it locally

The site is published with GitHub Pages at the link above, so you do not need to
run anything to use it. To work on it:

```bash
bun install
bun run dev      # http://localhost:3000
```

See `CLAUDE.md` for how the project is put together.
