// Generate-and-solve campaign for the match-three solver, and the standing
// cross-engine parity check.
//
//   bun run src/util/fuzzMatchThree.ts [--count 200] [--seed-base 1000]
//       [--budget-ms 10000] [--kind random|cluster|both] [--exe <path>]
//       [--max-cells 64] [--keep-all]
//
// Unlike the rolling-blocks generator this one cannot build boards that are
// solvable by construction: a match-three clear destroys the blocks it
// consumed, so there is no solution to play backwards. What it checks instead
// are the properties that hold whatever the board turns out to be:
//
//   1. Any witness either engine produces replays LEGALLY under the TypeScript
//      rules — the page renders solutions by replaying them through
//      rules.applyMove, so a witness that fails here would be unplayable.
//   2. When both engines prove a length, the lengths are EQUAL. A difference
//      is a rules divergence, not a search difference.
//   3. Neither engine calls a board unsolvable that the other solved.
//   4. `proven` is never claimed without `ruledOut` reaching one below the
//      reported length.
//
// Failures are archived under test-results/mt-fuzz with the board, so any of
// them is reproducible from the seed alone.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { solveMatchThree } from "../pages/match-three-solver/engine";
import {
  applyMove,
  blockCount,
  boardProblem,
  toBoard,
  type MatchThreeBoard,
  type Move,
} from "../pages/match-three-solver/rules";
import { parseFlags, runCli } from "./solverCli";
import type { MatchThreeTest } from "./types";

const projectRoot = resolve(import.meta.dir, "../..");
const outDir = resolve(projectRoot, "test-results/mt-fuzz");
const defaultExe = resolve(
  projectRoot,
  "src/pages/match-three-solver/a-star",
  process.platform === "win32"
    ? "cmake-build-release-visual-studio/match_three.exe"
    : "build/match_three",
);

interface NativeReport {
  turns: number;
  proven: boolean;
  unsolvable: boolean;
  ruledOut: number;
  valid: boolean;
  moves: { a: { x: number; y: number }; b: { x: number; y: number } }[];
  wallMs: number;
}

function parseArgs(argv: string[]) {
  const opts = {
    count: 200,
    seedBase: 1000,
    budgetMs: 10_000,
    kind: "both",
    exe: defaultExe,
    /**
     * Boards at or below this many cells are also compared against the
     * TypeScript engine at the same budget. Bigger ones only get the native
     * run plus the replay check: a divergence needs both engines to finish,
     * and on a large board neither reliably does.
     */
    maxCells: 64,
    keepAll: false,
  };
  parseFlags(argv, {
    "--count": next => (opts.count = Number(next())),
    "--seed-base": next => (opts.seedBase = Number(next())),
    "--budget-ms": next => (opts.budgetMs = Number(next())),
    "--kind": next => (opts.kind = next()),
    "--exe": next => (opts.exe = resolve(next())),
    "--max-cells": next => (opts.maxCells = Number(next())),
    "--keep-all": () => (opts.keepAll = true),
  });
  return opts;
}

/** The page's own replay: every move legal in turn, board empty at the end. */
function replay(start: MatchThreeBoard, moves: Move[]) {
  let current = start;
  let played = 0;
  for (const move of moves) {
    const outcome = applyMove(current, move);
    if (!outcome) return { legal: false, cleared: false, played };
    current = outcome.board;
    played++;
  }
  return { legal: true, cleared: blockCount(current) === 0, played };
}

async function generate(
  exe: string,
  path: string,
  seed: number,
  kind: string,
): Promise<MatchThreeTest | null> {
  const res = await runCli(
    exe,
    ["--generate", path, "--seed", String(seed), "--kind", kind],
    60_000,
  );
  if (res.exitCode !== 0) return null;
  return (await Bun.file(path).json()) as MatchThreeTest;
}

async function solveNative(
  exe: string,
  path: string,
  budgetMs: number,
): Promise<NativeReport | null> {
  const res = await runCli(
    exe,
    ["--fixture", path, "--budget-ms", String(budgetMs), "--quiet", "--json"],
    budgetMs * 3 + 60_000,
  );
  return res.json as NativeReport | null;
}

/** Everything wrong with one board's pair of answers. */
function divergences(
  board: MatchThreeBoard,
  native: NativeReport,
  compare: boolean,
): string[] {
  const problems: string[] = [];

  if (native.moves.length > 0) {
    const verdict = replay(board, native.moves);
    if (!verdict.legal) {
      problems.push(
        `native witness illegal under the TS rules after ${verdict.played} moves`,
      );
    } else if (!verdict.cleared) {
      problems.push("native witness leaves blocks on the board");
    }
  }
  if (native.proven && native.moves.length > 0 &&
      native.ruledOut !== native.moves.length - 1) {
    problems.push(
      `native claims proven at ${native.moves.length} with ruledOut ${native.ruledOut}`,
    );
  }
  if (!compare) return problems;

  const ts = solveMatchThree(board, { budgetMs: 10_000 });
  if (ts.status === "solved") {
    const verdict = replay(board, ts.moves);
    if (!verdict.cleared) problems.push("TS witness does not clear the board");
    if (ts.proven && native.proven && ts.moves.length !== native.moves.length) {
      problems.push(
        `proven lengths differ: TS ${ts.moves.length} vs native ${native.moves.length}`,
      );
    }
    if (native.unsolvable) {
      problems.push("native says unsolvable, TS found a solution");
    }
  }
  if (ts.status === "unsolvable" && native.moves.length > 0) {
    problems.push("TS says unsolvable, native found a solution");
  }
  return problems;
}

const opts = parseArgs(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });

const kinds = opts.kind === "both" ? ["random", "cluster"] : [opts.kind];
let checked = 0;
let compared = 0;
let solvedCount = 0;
let provenCount = 0;
const failures: string[] = [];

console.log(
  `fuzz: ${opts.count} boards from seed ${opts.seedBase}, ` +
    `kinds=${kinds.join("+")}, budget=${opts.budgetMs}ms`,
);

for (let i = 0; i < opts.count; i++) {
  const seed = opts.seedBase + i;
  const kind = kinds[i % kinds.length]!;
  const path = resolve(outDir, `board-${seed}-${kind}.json`);

  const config = await generate(opts.exe, path, seed, kind);
  if (!config) {
    failures.push(`seed ${seed} ${kind}: generation failed`);
    continue;
  }
  const board = toBoard(config);
  const problem = boardProblem(board);
  if (problem !== null) {
    failures.push(`seed ${seed} ${kind}: generated an illegal board — ${problem}`);
    continue;
  }

  const native = await solveNative(opts.exe, path, opts.budgetMs);
  if (!native) {
    failures.push(`seed ${seed} ${kind}: no JSON report from the CLI`);
    continue;
  }
  checked++;
  if (native.moves.length > 0) solvedCount++;
  if (native.proven) provenCount++;

  const compare = board.cells.length <= opts.maxCells;
  if (compare) compared++;
  const problems = divergences(board, native, compare);
  for (const found of problems) failures.push(`seed ${seed} ${kind}: ${found}`);

  if (problems.length === 0 && !opts.keepAll) {
    await Bun.file(path).delete();
  }
  if ((i + 1) % 25 === 0) {
    console.log(
      `  ${i + 1}/${opts.count} — ${solvedCount} solved, ` +
        `${provenCount} proven, ${failures.length} problems`,
    );
  }
}

console.log(
  `\nchecked ${checked} boards (${compared} cross-engine), ` +
    `${solvedCount} solved, ${provenCount} proven`,
);
if (failures.length === 0) {
  console.log("No divergences.");
} else {
  console.log(`DIVERGENCES:\n  ${failures.join("\n  ")}`);
  writeFileSync(
    resolve(outDir, "failures.txt"),
    `${failures.join("\n")}\n`,
    "utf8",
  );
  process.exitCode = 1;
}
