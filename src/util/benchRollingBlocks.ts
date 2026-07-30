// Fixture benchmark for the rolling-blocks solver.
//
//   bun run src/util/benchRollingBlocks.ts [--engine cascade] [--weight 2]
//       [--budget-ms 60000] [--max-nodes 0] [--filter <substr>]
//       [--out bench.json] [--exe <path>]
//   bun run src/util/benchRollingBlocks.ts --diff before.json after.json
//
// Run mode sweeps every rollingBlocksTest*.json fixture SEQUENTIALLY (for
// stable timings) through the native CLI and writes a {meta, results}
// baseline. Diff mode joins two baselines by fixture and prints a regression
// table (solved → UNSOLVED, >2x wall time, newly covered fixtures).

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags, runCli } from "./solverCli";

const projectRoot = resolve(import.meta.dir, "../..");
const fixtureDir = resolve(projectRoot, "test/resources/rolling-blocks-solver");
const defaultExe = resolve(
  projectRoot,
  "src/pages/rolling-blocks-solver/a-star",
  process.platform === "win32"
    ? "cmake-build-release-visual-studio/a_star.exe"
    : "build/a_star",
);

interface BenchResult {
  fixture: string;
  solved: boolean;
  valid?: boolean;
  turns?: number;
  stage?: string;
  nodesExpanded?: number;
  statesStored?: number;
  stoppedOnMemory?: boolean;
  searchMs?: number;
  wallMs: number;
  error?: string;
}

interface BenchFile {
  meta: {
    createdAt: string;
    exe: string;
    engine: string;
    weight: number;
    budgetMs: number;
    maxNodes: number;
  };
  results: BenchResult[];
}

function parseArgs(argv: string[]) {
  const opts = {
    exe: defaultExe,
    engine: "cascade",
    weight: 2,
    budgetMs: 60_000,
    maxNodes: 0,
    filter: "",
    out: resolve(projectRoot, "bench-rolling-blocks.json"),
    diff: [] as string[],
  };
  parseFlags(argv, {
    "--exe": next => (opts.exe = resolve(next())),
    "--engine": next => (opts.engine = next()),
    "--weight": next => (opts.weight = Number(next())),
    "--budget-ms": next => (opts.budgetMs = Number(next())),
    "--max-nodes": next => (opts.maxNodes = Number(next())),
    "--filter": next => (opts.filter = next()),
    "--out": next => (opts.out = resolve(next())),
    "--diff": next => (opts.diff = [resolve(next()), resolve(next())]),
  });
  return opts;
}

function listFixtures(filter: string): string[] {
  return readdirSync(fixtureDir)
    .filter(f => /^rollingBlocksTest\d*\.json$/.test(f))
    .filter(f => !filter || f.includes(filter))
    .sort((a, b) => {
      const na = Number(a.replace(/\D/g, "") || 0);
      const nb = Number(b.replace(/\D/g, "") || 0);
      return na - nb;
    });
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
  const solvedCell = `${b.solved ? "✓" : "✗"}→${a.solved ? "✓" : "✗"}`;
  console.log(
    `| ${b.fixture} | ${solvedCell} | ${b.wallMs}→${a.wallMs} | ${b.nodesExpanded ?? "?"}→${a.nodesExpanded ?? "?"} | ${b.turns ?? "?"}→${a.turns ?? "?"} |`,
  );
  if (b.solved && !a.solved) {
    regressions.push(`${b.fixture}: solved → UNSOLVED`);
  } else if (b.solved && a.solved && a.wallMs > 2 * Math.max(b.wallMs, 250)) {
    regressions.push(`${b.fixture}: >2x wall time (${b.wallMs} → ${a.wallMs}ms)`);
  }
}

async function diffMode(beforePath: string, afterPath: string) {
  const before: BenchFile = await Bun.file(beforePath).json();
  const after: BenchFile = await Bun.file(afterPath).json();
  const byFixture = new Map(after.results.map(r => [r.fixture, r]));
  const regressions: string[] = [];

  console.log("| fixture | solved | wallMs | nodes | turns |");
  console.log("|---|---|---|---|---|");
  for (const b of before.results) {
    const a = byFixture.get(b.fixture);
    byFixture.delete(b.fixture);
    diffRow(b, a, regressions);
  }
  for (const [fixture, a] of byFixture) {
    if (a.solved) console.log(`| ${fixture} | newly covered (not in before file) | | | |`);
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
  console.log(
    `bench: ${fixtures.length} fixtures, engine=${opts.engine} weight=${opts.weight} budget=${opts.budgetMs}ms`,
  );
  const results: BenchResult[] = [];
  for (const fixture of fixtures) {
    const started = Date.now();
    const res = await runCli(
      opts.exe,
      [
        "--fixture", resolve(fixtureDir, fixture),
        "--engine", opts.engine,
        "--weight", String(opts.weight),
        "--budget-ms", String(opts.budgetMs),
        "--max-nodes", String(opts.maxNodes),
        "--json",
      ],
      opts.budgetMs * 3 + 60_000,
    );
    const j = res.json ?? {};
    const r: BenchResult = {
      fixture,
      solved: j.solved === true,
      valid: j.valid,
      turns: j.turns,
      stage: j.stage,
      nodesExpanded: j.nodesExpanded,
      statesStored: j.statesStored,
      stoppedOnMemory: j.stoppedOnMemory,
      searchMs: j.searchMs,
      wallMs: j.wallMs ?? Date.now() - started,
      error: res.json ? undefined : `no JSON (exit ${res.exitCode})`,
    };
    results.push(r);
    const outcome = r.solved
      ? `solved via ${r.stage} — ${r.turns} turns in ${r.wallMs}ms`
      : `*** ${r.error ?? "UNSOLVED"} ***`;
    console.log(`  ${fixture}: ${outcome}`);
  }
  const out: BenchFile = {
    meta: {
      createdAt: new Date().toISOString(),
      exe: opts.exe,
      engine: opts.engine,
      weight: opts.weight,
      budgetMs: opts.budgetMs,
      maxNodes: opts.maxNodes,
    },
    results,
  };
  await Bun.write(opts.out, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${opts.out}`);
}
