import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags, runCli } from "./solverCli";

/**
 * Sweeps the captured logic-grid boards through the native CLI and records what
 * each one cost, or diffs two such baselines.
 *
 * `--diff before.json after.json` joins the two by fixture and exits 1 on a
 * regression, which is what lets it gate a change to the propagators: an answer
 * that got weaker (fewer cells decided, or a proof that stopped being a proof)
 * is a regression even when the wall clock improved.
 */

const projectRoot = resolve(import.meta.dir, "../..");
const fixtureDir = resolve(projectRoot, "test/resources/logic-grid-solver");
const defaultExe = resolve(
  projectRoot,
  "src/pages/logic-grid-solver/a-star",
  process.platform === "win32"
    ? "cmake-build-release-visual-studio/logic_grid.exe"
    : "build/logic_grid",
);

interface BenchResult {
  fixture: string;
  status: string;
  decided: number;
  playable: number;
  proven: boolean;
  valid: boolean;
  arm: string;
  nodes: number;
  refutations: number;
  searchMs: number;
}

interface BenchFile {
  meta: { createdAt: string; engine: string; budgetMs: number };
  results: BenchResult[];
}

function parseArgs(argv: string[]) {
  const opts = {
    budgetMs: 60_000,
    engine: "cascade",
    filter: "",
    exe: defaultExe,
    out: resolve(projectRoot, "bench-logic-grid.json"),
    diff: [] as string[],
  };
  parseFlags(argv, {
    "--budget-ms": next => (opts.budgetMs = Number(next())),
    "--engine": next => (opts.engine = next()),
    "--filter": next => (opts.filter = next()),
    "--exe": next => {
      const value = next();
      opts.exe = value === "default" ? defaultExe : resolve(value);
    },
    "--out": next => (opts.out = resolve(next())),
    "--diff": next => (opts.diff = [resolve(next()), resolve(next())]),
  });
  return opts;
}

function listFixtures(filter: string): string[] {
  const names = readdirSync(fixtureDir).filter(name => name.endsWith(".json"));
  const matching = filter
    ? names.filter(name => new RegExp(filter).test(name))
    : names;
  return matching.sort((a, b) => a.localeCompare(b));
}

async function benchOne(
  exe: string,
  name: string,
  engine: string,
  budgetMs: number,
): Promise<BenchResult> {
  const { json } = await runCli(
    exe,
    [
      "--fixture",
      resolve(fixtureDir, name),
      "--engine",
      engine,
      "--budget-ms",
      String(budgetMs),
      "--quiet",
      "--json",
    ],
    budgetMs * 3 + 60_000,
  );
  const report = (json ?? {}) as Record<string, unknown>;
  return {
    fixture: name,
    status: String(report.status ?? "missing"),
    decided: Number(report.decided ?? 0),
    playable: Number(report.playable ?? 0),
    proven: report.proven === true,
    valid: report.valid !== false,
    arm: String(report.arm ?? ""),
    nodes: Number(report.nodes ?? 0),
    refutations: Number(report.refutations ?? 0),
    searchMs: Number(report.searchMs ?? 0),
  };
}

/** What changed for the worse between two runs of one board. */
function rowRegressions(before: BenchResult, after: BenchResult): string[] {
  const problems: string[] = [];
  if (!after.valid) problems.push("answer no longer verifies");
  if (before.status !== after.status)
    problems.push(`status ${before.status} -> ${after.status}`);
  if (before.proven && !after.proven) problems.push("proof lost");
  if (after.decided < before.decided)
    problems.push(`decided ${before.decided} -> ${after.decided}`);
  return problems;
}

async function diffMode(paths: string[]) {
  const [before, after] = (await Promise.all(
    paths.map(path => Bun.file(path).json()),
  )) as BenchFile[];
  const byName = new Map(before!.results.map(row => [row.fixture, row]));

  let regressed = false;
  console.log("| fixture | status | decided | search ms |");
  console.log("| --- | --- | --- | --- |");
  for (const row of after!.results) {
    const old = byName.get(row.fixture);
    if (!old) continue;
    const problems = rowRegressions(old, row);
    regressed ||= problems.length > 0;
    const note = problems.length > 0 ? ` **${problems.join("; ")}**` : "";
    console.log(
      `| ${row.fixture} | ${old.status} -> ${row.status} | ` +
        `${old.decided} -> ${row.decided} | ${old.searchMs} -> ${row.searchMs}${note} |`,
    );
  }
  if (regressed) process.exitCode = 1;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.diff.length === 2) {
  await diffMode(opts.diff);
} else {
  const results: BenchResult[] = [];
  for (const name of listFixtures(opts.filter)) {
    const row = await benchOne(opts.exe, name, opts.engine, opts.budgetMs);
    results.push(row);
    console.log(
      `${row.fixture}: ${row.status} ${row.decided}/${row.playable} ` +
        `(${row.arm}, ${row.searchMs} ms)`,
    );
  }
  const file: BenchFile = {
    meta: {
      createdAt: new Date().toISOString(),
      engine: opts.engine,
      budgetMs: opts.budgetMs,
    },
    results,
  };
  await Bun.write(opts.out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`\nWrote ${opts.out}`);
}
