/**
 * The line-coverage floor, applied to the MERGED picture of several lcov
 * reports.
 *
 * `bun test` writes `coverage/lcov.info` on every run (bunfig.toml), and CI
 * runs the suite as four `--shard`s that each see a quarter of it. Bun's own
 * `coverageThreshold` is checked per invocation, so it would fail every shard
 * and every partial local run (`test:fast` skips the slow suites); this reads
 * one report per shard, adds the hits up per line and applies the floor to
 * the sum. `bun run test` runs it after a full local run.
 *
 * Bun's lcov carries `SF:`, `DA:<line>,<hits>`, `LF:`/`LH:` and per-file
 * function TOTALS (`FNF:`/`FNH:`) — no `FN:`/`FNDA:` records — so lines are
 * the only thing that merges exactly. Line totals are recomputed from the
 * merged `DA:` lines rather than trusted; function coverage is reported as
 * the per-file maximum over the reports, a LOWER bound of the true union,
 * and never gates.
 *
 * Coverage only sees files some test imported: this is a regression guard on
 * what is tested, not proof that every file is.
 *
 * Usage: `bun src/util/coverageGate.ts <lcov.info>...` — exits 1 below the
 * floor. No dependencies beyond node:fs/node:path, so CI runs it without
 * `bun ci`.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * Percent of lines hit across the whole suite. Set one point under the first
 * green full run on bun 1.4, so a real drop fails and noise does not; raise
 * it when the suite earns it.
 */
export const COVERAGE_FLOOR_LINES = 88;

export interface FileCoverage {
  /** line number -> hits, summed over every report that names the file */
  lines: Map<number, number>;
  functionsFound: number;
  functionsHit: number;
}

/** keyed by the `SF:` path exactly as the report spells it */
export type Coverage = Map<string, FileCoverage>;

export interface Totals {
  files: number;
  linesFound: number;
  linesHit: number;
  linePercent: number;
  functionsFound: number;
  functionsHit: number;
  functionPercent: number;
}

const percent = (hit: number, found: number) =>
  found === 0 ? 100 : (hit / found) * 100;

function recordOf(line: string): [kind: string, value: string] {
  const colon = line.indexOf(":");
  return colon === -1
    ? [line, ""]
    : [line.slice(0, colon), line.slice(colon + 1)];
}

function applyRecord(file: FileCoverage, kind: string, value: string) {
  switch (kind) {
    case "DA": {
      const [line, hits] = value.split(",");
      const number = Number(line);
      file.lines.set(number, (file.lines.get(number) ?? 0) + Number(hits));
      break;
    }
    case "FNF":
      file.functionsFound = Math.max(file.functionsFound, Number(value));
      break;
    case "FNH":
      file.functionsHit = Math.max(file.functionsHit, Number(value));
      break;
    default:
      // TN, LF, LH and anything newer: recomputed or irrelevant.
      break;
  }
}

/** Merges lcov report texts into `into`, summing hits per file and line. */
export function mergeLcov(
  reports: readonly string[],
  into: Coverage = new Map(),
): Coverage {
  for (const report of reports) {
    let current: FileCoverage | undefined;
    for (const raw of report.split(/\r?\n/)) {
      const [kind, value] = recordOf(raw.trim());
      if (kind === "SF") {
        current = into.get(value) ?? {
          lines: new Map(),
          functionsFound: 0,
          functionsHit: 0,
        };
        into.set(value, current);
      } else if (kind === "end_of_record") {
        current = undefined;
      } else if (current) {
        applyRecord(current, kind, value);
      }
    }
  }
  return into;
}

export function fileLinePercent(file: FileCoverage): number {
  let hit = 0;
  for (const hits of file.lines.values()) if (hits > 0) hit++;
  return percent(hit, file.lines.size);
}

export function totalsOf(coverage: Coverage): Totals {
  const totals = {
    files: coverage.size,
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
  };
  for (const file of coverage.values()) {
    totals.linesFound += file.lines.size;
    for (const hits of file.lines.values()) if (hits > 0) totals.linesHit++;
    totals.functionsFound += file.functionsFound;
    totals.functionsHit += file.functionsHit;
  }
  return {
    ...totals,
    linePercent: percent(totals.linesHit, totals.linesFound),
    functionPercent: percent(totals.functionsHit, totals.functionsFound),
  };
}

/** The `count` files with the lowest line coverage, lowest first. */
export function worstFiles(
  coverage: Coverage,
  count = 10,
): [path: string, linePercent: number][] {
  return [...coverage.entries()]
    .filter(([, file]) => file.lines.size > 0)
    .map(([path, file]): [string, number] => [path, fileLinePercent(file)])
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, count);
}

export function passesFloor(totals: Totals, floor: number): boolean {
  return totals.linePercent >= floor;
}

const format = (value: number) => `${value.toFixed(2)} %`;

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: bun src/util/coverageGate.ts <lcov.info>...");
    process.exit(2);
  }
  const coverage = mergeLcov(paths.map(path => readFileSync(path, "utf8")));
  const totals = totalsOf(coverage);
  const cwd = process.cwd();

  console.log(
    `coverage gate: ${paths.length} report(s), ${totals.files} files`,
  );
  console.log(
    `  lines      ${format(totals.linePercent)} ` +
      `(${totals.linesHit}/${totals.linesFound}), ` +
      `floor ${COVERAGE_FLOOR_LINES} %`,
  );
  console.log(
    `  functions >= ${format(totals.functionPercent)} ` +
      `(${totals.functionsHit}/${totals.functionsFound}, a lower bound: ` +
      "bun's lcov has no per-function records)",
  );
  console.log("  lowest line coverage:");
  for (const [path, linePercent] of worstFiles(coverage)) {
    console.log(
      `    ${format(linePercent).padStart(9)}  ${relative(cwd, path)}`,
    );
  }

  if (passesFloor(totals, COVERAGE_FLOOR_LINES)) {
    console.log("coverage gate: OK");
  } else {
    console.error(
      `coverage gate: FAIL — line coverage ${format(totals.linePercent)} ` +
        `is below the ${COVERAGE_FLOOR_LINES} % floor`,
    );
    process.exitCode = 1;
  }
}
