// Benchmark runner for the shifting-mosaic native bench CLI.
//
//   bun run src/util/benchShiftingMosaic.ts --out baseline.json
//       [--exe <path>] [--engine unit|drag] [--weight 3] [--budget-ms 60000]
//       [--max-nodes 20000000] [--filter <substring>]
//   bun run src/util/benchShiftingMosaic.ts --diff before.json after.json
//
// Run mode executes the CLI once per fixture (sequentially, for stable
// timings) and stores one JSON file. Diff mode prints a markdown comparison
// table and flags regressions (lost fixtures, >2x wall time).

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags } from "./solverCli";

const projectRoot = resolve(import.meta.dir, "../..");
const defaultExe = resolve(
  projectRoot,
  "src/pages/shifting-mosaic-solver/a-star/build-native/Release",
  process.platform === "win32" ? "shifting_mosaic_a_star.exe" : "shifting_mosaic_a_star",
);
const fixturesDir = resolve(
  projectRoot,
  "test/resources/shifting-mosaic-solver",
);

interface BenchResult {
  fixture: string;
  solved: boolean;
  valid?: boolean;
  turns?: number;
  steps?: number;
  dirRuns?: number;
  nodesExpanded?: number;
  statesStored?: number;
  passes?: number;
  constructMs?: number;
  searchMs?: number;
  wallMs: number;
  timedOut?: boolean;
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
    engine: "unit",
    weight: 3,
    budgetMs: 60_000,
    maxNodes: 20_000_000,
    settled: false,
    out: "",
    filter: "",
    diff: [] as string[],
  };
  parseFlags(argv, {
    "--exe": next => (opts.exe = resolve(next())),
    "--engine": next => (opts.engine = next()),
    "--weight": next => (opts.weight = Number(next())),
    "--budget-ms": next => (opts.budgetMs = Number(next())),
    "--max-nodes": next => (opts.maxNodes = Number(next())),
    "--settled": () => (opts.settled = true),
    "--out": next => (opts.out = resolve(next())),
    "--filter": next => (opts.filter = next()),
    "--diff": next => (opts.diff = [resolve(next()), resolve(next())]),
  });
  return opts;
}

function fixtureFiles(filter: string): string[] {
  return readdirSync(fixturesDir)
    .filter(f => /^shiftingMosaicTest\d*\.json$/.test(f))
    .filter(f => !filter || f.includes(filter))
    .sort((a, b) => {
      const num = (s: string) => Number(/^shiftingMosaicTest(\d*)\.json$/.exec(s)?.[1] || 0);
      return num(a) - num(b);
    });
}

async function runOne(
  opts: ReturnType<typeof parseArgs>,
  file: string,
): Promise<BenchResult> {
  const args = [
    opts.exe,
    "--fixture", resolve(fixturesDir, file),
    "--engine", opts.engine,
    "--weight", String(opts.weight),
    "--budget-ms", String(opts.budgetMs),
    "--max-nodes", String(opts.maxNodes),
    ...(opts.settled ? ["--settled"] : []),
    "--json",
  ];
  // The guided pass can be followed by fallback passes plus post-processing;
  // 2.5x the per-pass budget plus slack covers the cascade.
  const timeoutMs = opts.budgetMs * 2.5 + 60_000;
  const started = Date.now();
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  // stderr has to be drained too: the solver logs there, and a child that
  // fills an unread pipe buffer blocks mid-write and gets recorded as a
  // timeout instead of a result.
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  const elapsed = Date.now() - started;

  const lastJsonLine = stdout
    .split("\n")
    .map(l => l.trim())
    .findLast(l => l.startsWith("{"));
  if (!lastJsonLine) {
    return {
      fixture: file,
      solved: false,
      wallMs: elapsed,
      timedOut: elapsed >= timeoutMs,
      error: `no JSON output (exit ${exitCode})`,
    };
  }
  try {
    return JSON.parse(lastJsonLine) as BenchResult;
  } catch (err) {
    // A child killed mid-write leaves a truncated line. Record the one bad
    // fixture rather than throwing out of a multi-hour sweep.
    return {
      fixture: file,
      solved: false,
      wallMs: elapsed,
      timedOut: elapsed >= timeoutMs,
      error: `unparseable JSON output (exit ${exitCode}): ${String(err)}`,
    };
  }
}

async function runMode(opts: ReturnType<typeof parseArgs>) {
  if (!opts.out) throw new Error("--out <file> is required in run mode");
  const files = fixtureFiles(opts.filter);
  console.log(`Running ${files.length} fixtures (engine=${opts.engine}, weight=${opts.weight}, budget=${opts.budgetMs}ms)`);
  const results: BenchResult[] = [];
  for (const file of files) {
    const r = await runOne(opts, file);
    results.push(r);
    const label = r.solved ? `${r.turns} turns / ${r.steps} steps` : r.error ?? "unsolved";
    console.log(`  ${file}: ${r.solved ? "solved" : "FAILED"} (${label}, ${r.wallMs} ms, ${r.nodesExpanded ?? "?"} nodes)`);
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
  const solved = results.filter(r => r.solved).length;
  const totalMs = results.reduce((s, r) => s + r.wallMs, 0);
  console.log(`\n${solved}/${results.length} solved, total ${(totalMs / 1000).toFixed(1)}s → ${opts.out}`);
}

const fmt = (v: number | undefined) => (v === undefined ? "?" : String(v));

/** One before→after row of the diff table. */
function rowFor(b: BenchResult, a: BenchResult): string {
  const solvedCell = `${b.solved ? "✓" : "✗"}→${a.solved ? "✓" : "✗"}`;
  return (
    `| ${b.fixture.replace("shiftingMosaic", "")} | ${solvedCell} ` +
    `| ${b.wallMs}→${a.wallMs} | ${fmt(b.nodesExpanded)}→${fmt(a.nodesExpanded)} ` +
    `| ${fmt(b.turns)}→${fmt(a.turns)} | ${fmt(b.steps)}→${fmt(a.steps)} |`
  );
}

/**
 * Why this fixture counts as a regression, or null. Losing a solution is one
 * whatever the clock says; a slowdown only counts past 2x, and the 250 ms floor
 * keeps a fixture that runs in single-digit ms from tripping it on noise.
 */
function regressionFor(b: BenchResult, a: BenchResult): string | null {
  if (b.solved && !a.solved) return `${b.fixture}: solved → UNSOLVED`;
  if (b.solved && a.solved && a.wallMs > 2 * Math.max(b.wallMs, 250))
    return `${b.fixture}: wall time ${b.wallMs} → ${a.wallMs} ms (>2x)`;
  return null;
}

async function diffMode(beforePath: string, afterPath: string) {
  const before = (await Bun.file(beforePath).json()) as BenchFile;
  const after = (await Bun.file(afterPath).json()) as BenchFile;
  const byFixture = new Map(after.results.map(r => [r.fixture, r]));

  const lines: string[] = [];
  lines.push(
    `| fixture | solved | wallMs | nodes | turns | steps |`,
    `|---|---|---|---|---|---|`,
  );
  const regressions: string[] = [];
  for (const b of before.results) {
    const a = byFixture.get(b.fixture);
    if (!a) continue;
    lines.push(rowFor(b, a));
    const regression = regressionFor(b, a);
    if (regression) regressions.push(regression);
  }
  for (const a of after.results)
    if (!before.results.some(b => b.fixture === a.fixture) && a.solved)
      regressions.push(`${a.fixture}: newly covered (not in before file)`);

  console.log(lines.join("\n"));
  const regressionList = regressions.map(r => `- ${r}`).join("\n");
  console.log(
    regressions.length
      ? `\nRegressions/notes:\n${regressionList}`
      : "\nNo regressions.",
  );
}

const opts = parseArgs(process.argv.slice(2));
if (opts.diff.length === 2) {
  await diffMode(opts.diff[0]!, opts.diff[1]!);
} else {
  await runMode(opts);
}
