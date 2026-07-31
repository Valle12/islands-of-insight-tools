// Fixture benchmark for the match-three solver.
//
//   bun run src/util/benchMatchThree.ts [--budget-ms 30000] [--filter <substr>]
//       [--out bench.json]
//   bun run src/util/benchMatchThree.ts --diff before.json after.json
//
// Run mode sweeps every matchThreeTest*.json fixture SEQUENTIALLY (for stable
// timings) through the TS engine in-process — unlike the C++ solvers there is
// no CLI to shell out to — and writes a {meta, results} baseline. Diff mode
// joins two baselines by fixture and prints a regression table. A solved move
// count that CHANGES is a regression in either direction: reported counts are
// proven minimal, so drift means one of the two runs was wrong.

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { solveMatchThree } from "../pages/match-three-solver/engine";
import {
  applyMove,
  blockCount,
  toBoard,
  type MatchThreeBoard,
  type Move,
} from "../pages/match-three-solver/rules";
import { parseFlags } from "./solverCli";
import type { MatchThreeTest } from "./types";

const projectRoot = resolve(import.meta.dir, "../..");
const fixtureDir = resolve(projectRoot, "test/resources/match-three-solver");

interface BenchResult {
  fixture: string;
  status: "solved" | "unsolvable" | "budget";
  moves?: number;
  /** Whether the move count is proven minimal (absent in legacy baselines). */
  proven?: boolean;
  groupingProven?: boolean;
  /** Whether the solution survived an independent replay. */
  valid?: boolean;
  /** When the first best-so-far streamed in, and how long it was. */
  firstBestMs?: number;
  firstBestLength?: number;
  depthReached: number;
  nodes: number;
  tableEntries: number;
  wallMs: number;
}

interface BenchFile {
  meta: {
    createdAt: string;
    engine: string;
    budgetMs: number;
  };
  results: BenchResult[];
}

function parseArgs(argv: string[]) {
  const opts = {
    budgetMs: 30_000,
    filter: "",
    out: resolve(projectRoot, "bench-match-three.json"),
    diff: [] as string[],
  };
  parseFlags(argv, {
    "--budget-ms": next => (opts.budgetMs = Number(next())),
    "--filter": next => (opts.filter = next()),
    "--out": next => (opts.out = resolve(next())),
    "--diff": next => (opts.diff = [resolve(next()), resolve(next())]),
  });
  return opts;
}

function listFixtures(filter: string): string[] {
  return readdirSync(fixtureDir)
    .filter(f => /^matchThreeTest\d*\.json$/.test(f))
    .filter(f => !filter || f.includes(filter))
    .sort((a, b) => {
      const na = Number(a.replace(/\D/g, "") || 0);
      const nb = Number(b.replace(/\D/g, "") || 0);
      return na - nb;
    });
}

// The replay oracle, inlined rather than imported from test/: the bench must
// not trust the search's own verdict, and must not depend on the test tree.
function clearsBoard(start: MatchThreeBoard, moves: Move[]): boolean {
  let current = start;
  for (const move of moves) {
    const outcome = applyMove(current, move);
    if (!outcome) return false;
    current = outcome.board;
  }
  return blockCount(current) === 0;
}

async function benchFixture(
  fixture: string,
  budgetMs: number,
): Promise<BenchResult> {
  const config = (await Bun.file(
    resolve(fixtureDir, fixture),
  ).json()) as MatchThreeTest;
  const start = toBoard(config);

  let nodes = 0;
  let tableEntries = 0;
  let depthReached = 0;
  let firstBestMs: number | undefined;
  let firstBestLength: number | undefined;
  const started = performance.now();
  const result = solveMatchThree(start, {
    budgetMs,
    onBest: moves => {
      if (firstBestMs !== undefined) return;
      firstBestMs = Math.round(performance.now() - started);
      firstBestLength = moves.length;
    },
    onStats: stats => {
      nodes = stats.nodes;
      tableEntries = stats.tableEntries;
      depthReached = stats.depthReached;
    },
  });
  const wallMs = Math.round(performance.now() - started);

  const record: BenchResult = {
    fixture,
    status: result.status,
    depthReached,
    nodes,
    tableEntries,
    wallMs,
  };
  if (firstBestMs !== undefined) {
    record.firstBestMs = firstBestMs;
    record.firstBestLength = firstBestLength;
  }
  if (result.status === "solved") {
    record.moves = result.moves.length;
    record.proven = result.proven;
    record.groupingProven = result.groupingProven;
    record.valid = clearsBoard(start, result.moves);
  }
  return record;
}

function describeResult(r: BenchResult): string {
  if (r.status === "solved") {
    const invalid = r.valid === false ? " *** REPLAY FAILED ***" : "";
    const label = r.proven === false ? " (unproven)" : "";
    return `solved — ${r.moves} moves${label} in ${r.wallMs}ms${invalid}`;
  }
  if (r.status === "budget") {
    return (
      `budget at depth ${r.depthReached} — ` +
      `${r.nodes.toLocaleString()} edges in ${r.wallMs}ms`
    );
  }
  return `unsolvable in ${r.wallMs}ms`;
}

/** Legacy baselines predate the anytime engine; everything solved was proven. */
function isProven(r: BenchResult): boolean {
  return r.status === "solved" && r.proven !== false;
}

// Every way an "after" run can be worse. A lost "unsolvable" would mean a
// completed proof went missing; a proven length may never move; an unproven
// one may (it is not a claim of minimality), so it is exempt from the pin.
function rowRegressions(b: BenchResult, a: BenchResult): string[] {
  const problems: string[] = [];
  if (b.status === "solved" && a.status !== "solved") {
    problems.push(`solved → ${a.status.toUpperCase()}`);
  }
  if (b.status === "unsolvable" && a.status !== "unsolvable") {
    problems.push(`unsolvable → ${a.status.toUpperCase()}`);
  }
  if (isProven(b) && a.status === "solved" && !isProven(a)) {
    problems.push("proven → unproven");
  }
  if (isProven(b) && isProven(a) && b.moves !== a.moves) {
    problems.push(`proven length changed (${b.moves} → ${a.moves})`);
  }
  if (a.valid === false) problems.push("solution failed replay");
  if (
    b.status === "solved" &&
    a.status === "solved" &&
    a.wallMs > 2 * Math.max(b.wallMs, 250)
  ) {
    problems.push(`>2x wall time (${b.wallMs} → ${a.wallMs}ms)`);
  }
  return problems;
}

function diffRow(
  b: BenchResult,
  a: BenchResult | undefined,
  regressions: string[],
) {
  if (!a) {
    console.log(`| ${b.fixture} | dropped from after file | | | |`);
    return;
  }
  console.log(
    `| ${b.fixture} | ${b.status}→${a.status} | ${b.moves ?? "-"}→${a.moves ?? "-"} | ${b.wallMs}→${a.wallMs} | ${b.nodes}→${a.nodes} |`,
  );
  for (const problem of rowRegressions(b, a)) {
    regressions.push(`${b.fixture}: ${problem}`);
  }
}

async function diffMode(beforePath: string, afterPath: string) {
  const before: BenchFile = await Bun.file(beforePath).json();
  const after: BenchFile = await Bun.file(afterPath).json();
  const byFixture = new Map(after.results.map(r => [r.fixture, r]));
  const regressions: string[] = [];

  console.log("| fixture | status | moves | wallMs | nodes |");
  console.log("|---|---|---|---|---|");
  for (const b of before.results) {
    const a = byFixture.get(b.fixture);
    byFixture.delete(b.fixture);
    diffRow(b, a, regressions);
  }
  for (const [fixture, a] of byFixture) {
    if (a.status === "solved") {
      console.log(`| ${fixture} | newly covered (not in before file) | | | |`);
    }
  }
  console.log(
    regressions.length
      ? `\nREGRESSIONS:\n  ${regressions.join("\n  ")}`
      : "\nNo regressions.",
  );
}

const opts = parseArgs(process.argv.slice(2));
if (opts.diff.length === 2) {
  await diffMode(opts.diff[0]!, opts.diff[1]!);
} else {
  const fixtures = listFixtures(opts.filter);
  console.log(`bench: ${fixtures.length} fixtures, budget=${opts.budgetMs}ms`);
  const results: BenchResult[] = [];
  for (const fixture of fixtures) {
    const r = await benchFixture(fixture, opts.budgetMs);
    results.push(r);
    console.log(`  ${fixture}: ${describeResult(r)}`);
  }
  const out: BenchFile = {
    meta: {
      createdAt: new Date().toISOString(),
      engine: "ts-anytime",
      budgetMs: opts.budgetMs,
    },
    results,
  };
  await Bun.write(opts.out, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${opts.out}`);
}
