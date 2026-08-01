// Is an NRPA plateau a trap, or just short of the finish?
//
// Usage: bun run harvest:mt [--fixture matchThreeTest50] [--seeds 0,1,2,3]
//                           [--level N] [--iterations N] [--ms 60000]
//                           [--exe <path>]
//
// NRPA optimises fewest-blocks-left, so a run that fails still ends somewhere —
// on matchThreeTest50 it reaches 7 of 105 blocks left and stops. Those are two
// very different worlds. Either the endgames are winnable and the search just
// needs to push, or they are dead and the region the policy converged on is a
// cul-de-sac. Which one it is decides whether the answer is "more budget" or
// "a different policy", and guessing wrong wastes hours.
//
// So: run NRPA at several seeds, replay each plateau line to the board it
// stopped at, write that board out as a fixture, and hand it to the exact
// prover. The endgame is small enough that `unsolvable` there is a real proof
// rather than a timeout, which is the whole reason this is worth doing.
//
// What it found (2026-07-31, test50, level 3 x 30, four seeds): three plateaus
// PROVEN dead and one seed solving the board outright in 23 moves. A run that
// plateaus has not run out of search, it has run out of THAT policy — which is
// the measurement the arm's restart loop is built on. See
// src/pages/match-three-solver/a-star/bench/HARD-BOARDS.md.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runNrpa } from "../pages/match-three-solver/nrpa";
import {
  applyMove,
  blockCount,
  type MatchThreeBoard,
  type Move,
} from "../pages/match-three-solver/rules";
import { parseFlags, runCli } from "./solverCli";
import type { MatchThreeTest } from "./types";

const projectRoot = resolve(import.meta.dir, "../..");
const outDir = resolve(projectRoot, "test-results/mt-harvest");
const fixtureDir = resolve(projectRoot, "test/resources/match-three-solver");
const defaultExe = resolve(
  projectRoot,
  "src/pages/match-three-solver/a-star",
  process.platform === "win32"
    ? "cmake-build-release-visual-studio/match_three.exe"
    : "build/match_three",
);

/** How long the endgame prover gets. It needs milliseconds; this is slack. */
const PROVE_MS = 120_000;

function parseArgs(argv: string[]) {
  const opts = {
    fixture: "matchThreeTest50",
    seeds: [0, 1, 2, 3],
    /** 0 leaves nrpa's own restart ladder on. */
    level: 0,
    iterations: 0,
    perSeedMs: 60_000,
    exe: defaultExe,
  };
  parseFlags(argv, {
    "--fixture": next => (opts.fixture = next()),
    "--seeds": next => (opts.seeds = next().split(",").map(Number)),
    "--level": next => (opts.level = Number(next())),
    "--iterations": next => (opts.iterations = Number(next())),
    "--ms": next => (opts.perSeedMs = Number(next())),
    "--exe": next => (opts.exe = resolve(next())),
  });
  return opts;
}

function toBoard(fixture: MatchThreeTest): MatchThreeBoard {
  const { gridWidth, gridHeight } = fixture;
  const cells = new Uint8Array(gridWidth * gridHeight);
  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      cells[y * gridWidth + x] = fixture.cells[x]![y]!;
    }
  }
  return { width: gridWidth, height: gridHeight, cells };
}

/** Back to the download format, so a plateau board IS a usable fixture. */
function toFixture(board: MatchThreeBoard): MatchThreeTest {
  const cells: number[][] = [];
  for (let x = 0; x < board.width; x++) {
    const column: number[] = [];
    for (let y = 0; y < board.height; y++) {
      column.push(board.cells[y * board.width + x]!);
    }
    cells.push(column);
  }
  return { gridWidth: board.width, gridHeight: board.height, cells };
}

function replay(start: MatchThreeBoard, moves: Move[]): MatchThreeBoard {
  let board = start;
  for (const move of moves) {
    const outcome = applyMove(board, move);
    if (!outcome) throw new Error("the plateau line does not replay");
    board = outcome.board;
  }
  return board;
}

interface Verdict {
  solved: boolean;
  unsolvable: boolean;
  turns: number;
}

async function proveEndgame(
  exe: string,
  path: string,
): Promise<Verdict | null> {
  const { json } = await runCli(
    exe,
    ["--fixture", path, "--engine", "exhaustive",
     "--budget-ms", String(PROVE_MS), "--quiet"],
    PROVE_MS + 30_000,
  );
  return json as Verdict | null;
}

function describe(verdict: Verdict | null): string {
  if (!verdict) return "the prover did not report";
  if (verdict.unsolvable) return "DEAD (proven unsolvable)";
  if (verdict.solved) return `WINNABLE in ${verdict.turns} more moves`;
  return "undecided (the budget ran out first)";
}

const opts = parseArgs(Bun.argv.slice(2));
const source = (await Bun.file(
  `${fixtureDir}/${opts.fixture}.json`,
).json()) as MatchThreeTest;
const start = toBoard(source);
const total = blockCount(start);

mkdirSync(outDir, { recursive: true });
const rung = opts.level > 0 ? `level ${opts.level} x ${opts.iterations}` : "the ladder";
console.log(`${opts.fixture}: ${total} blocks, ${rung}, ${opts.perSeedMs}ms per seed`);

let dead = 0;
let solved = 0;
const summary: Record<string, unknown>[] = [];

for (const seed of opts.seeds) {
  const began = performance.now();
  const outcome = runNrpa(
    start,
    { seed, level: opts.level, iterations: opts.iterations },
    performance.now() + opts.perSeedMs,
    () => {},
  );
  const nrpaMs = Math.round(performance.now() - began);

  if (outcome.left === 0) {
    solved++;
    console.log(`seed ${seed}: SOLVED in ${outcome.moves.length} moves, ${nrpaMs}ms`);
    writeFileSync(
      resolve(outDir, `${opts.fixture}-solution-seed${seed}.json`),
      JSON.stringify({ ...source, turns: outcome.moves }, null, 2),
    );
    summary.push({ seed, solved: true, moves: outcome.moves.length, nrpaMs });
    continue;
  }

  const plateau = replay(start, outcome.partial);
  const path = resolve(outDir, `${opts.fixture}-plateau-seed${seed}.json`);
  writeFileSync(path, JSON.stringify(toFixture(plateau), null, 2));
  const verdict = await proveEndgame(opts.exe, path);
  if (verdict?.unsolvable) dead++;
  console.log(
    `seed ${seed}: ${outcome.left} left after ${outcome.partial.length} moves,` +
      ` ${outcome.playouts} playouts, ${nrpaMs}ms -> endgame ${describe(verdict)}`,
  );
  summary.push({
    seed,
    left: outcome.left,
    depth: outcome.partial.length,
    playouts: outcome.playouts,
    nrpaMs,
    endgame: describe(verdict),
  });
}

writeFileSync(
  resolve(outDir, `${opts.fixture}-summary.json`),
  JSON.stringify(summary, null, 2),
);
console.log(
  `\n${solved} solved outright, ${dead} plateau endgames PROVEN DEAD` +
    ` of ${opts.seeds.length - solved}`,
);
console.log(`boards and summary under ${outDir}`);
