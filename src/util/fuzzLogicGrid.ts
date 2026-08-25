import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags, runCli } from "./solverCli";

/**
 * Generate a board, solve it, and check the things that have to hold.
 *
 * The generator colors the board FIRST and reads the clues off the result, so
 * every board it writes has a witness — which is what makes the checks below
 * sharp rather than merely self-consistent:
 *
 *   1. a board with a witness is never called unsolvable;
 *   2. every cell the solver reports as FORCED matches that witness, because a
 *      genuinely forced cell agrees with every solution and the witness is one.
 *      This is the only check that can catch a propagator which prunes away
 *      real solutions — nothing at runtime can, and an over-pruning solver
 *      looks entirely reasonable until you hold a solution it ruled out;
 *   3. small boards are cross-checked against brute force outright (`--brute`),
 *      which compares the whole solution set rather than one witness.
 *
 * What may NOT be asserted: that the solver's answer equals the generated
 * coloring. The same clue set usually admits others, and pinning that would
 * fail on a correct solver.
 */

const projectRoot = resolve(import.meta.dir, "../..");
const outDir = resolve(projectRoot, "test-results/lg-fuzz");
const defaultExe = resolve(
  projectRoot,
  "src/pages/logic-grid-solver/a-star",
  process.platform === "win32"
    ? "cmake-build-release-visual-studio/logic_grid.exe"
    : "build/logic_grid",
);

interface Report {
  status?: string;
  proven?: boolean;
  decided?: number;
  playable?: number;
  valid?: boolean;
  cells?: number[][];
  witnessesLegal?: boolean;
  oracleRejections?: number;
  referenceRan?: boolean;
  referenceSolutions?: number;
  referenceAgreesOnSolvability?: boolean;
  referenceForcedMatches?: boolean;
  error?: string;
}

function parseArgs(argv: string[]) {
  const opts = {
    count: 200,
    seedBase: 1,
    budgetMs: 30_000,
    /**
     * "both" alternates by seed, which is the default because the two kinds
     * check different things: a clued board exercises finding and verifying a
     * whole answer, and an underclued one is the only shape where the forced
     * cells can be checked against a known solution.
     */
    kind: "both",
    width: 0,
    height: 0,
    exe: defaultExe,
    keepAll: false,
    /**
     * Which arm to campaign. The default races the cascade, which is what the
     * page runs; naming one is how a single engine gets its own campaign —
     * `--engine profile` with `--rules 0` is the way to hammer the frontier
     * sweep, since the cascade only reaches it on boards it applies to.
     */
    engine: "",
    /** Passed to `--generate`; `0` asks for boards with no rules at all. */
    rules: -1,
    /**
     * Roughly what percentage of each board's squares to fuse into merged
     * cells. 0 — the default — leaves the generator's rng untouched, so a
     * campaign without it reproduces exactly the boards it always did.
     */
    shapes: 0,
    /**
     * Roughly how often a region that would carry no clue gets a DART instead.
     * 0 — the default — draws no random number for one, so a campaign without
     * it reproduces exactly the boards it always did.
     */
    darts: 0,
    /**
     * The same for a SYMMETRY symbol, which only lands where its region really
     * mirrors across the drawn axis — so raise it well above `--darts` to see
     * a comparable number, since most random regions mirror across nothing.
     */
    lotus: 0,
    /**
     * And for a VIEWPOINT, whose count is read off the coloring like a
     * dart's — every roll that fires places one, so `--darts`-like numbers
     * give `--darts`-like yield. 0 draws nothing, as ever.
     */
    viewpoints: 0,
    /**
     * And for a GALAXY, which only lands where its region really maps to
     * itself under a half turn about the spot — like `--lotus`, raise it well
     * above `--darts` to see a comparable number, since most random regions
     * are not point-symmetric. 0 draws nothing, as ever.
     */
    galaxies: 0,
    /**
     * And for a MYOPIA clue, whose arrows are read off the coloring like a
     * dart's count — but which is skipped where no direction sees the other
     * color at all, so its yield sits between the dart's and the lotus's.
     * 0 draws nothing, as ever.
     */
    myopia: 0,
    /**
     * And the chance a letter that just landed gets its PAIR — the same
     * letter on a second free cell of the same region, the router/profile
     * shape. NESTED in the generator's letter roll rather than appended, so
     * run it high (100 pairs every roomy letter); 0 draws nothing, as ever.
     */
    letterPairs: 0,
    /**
     * The hard-class campaign: derive large pinned dims and a sparse
     * connectivity-heavy mask from each seed (`bigSparseDraw`), and print a
     * per-class outcome table at the end — the early warning for "a whole
     * batch nothing cracks". Explicit `--width`/`--height`/`--rules` override
     * the drawn values. Pinned dims consume no generator draw and an explicit
     * mask skips the mask rolls, so the mode stales no plain campaign's seed.
     */
    bigSparse: false,
  };
  /**
   * A flag's value as a number, or a hard stop.
   *
   * `Number("abc")` is NaN and every comparison against it is false, so a
   * mistyped `--count` used to run the loop zero times and exit 0 — a CI fuzz
   * job passing without having tested anything. A mistyped `--budget-ms` made
   * every timeout fire immediately and every board report "no report".
   */
  const number = (flag: string, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      console.error(`${flag} needs a number, got: ${raw}`);
      process.exit(2);
    }
    return value;
  };
  parseFlags(argv, {
    "--count": next => (opts.count = number("--count", next())),
    "--seed-base": next => (opts.seedBase = number("--seed-base", next())),
    "--budget-ms": next => (opts.budgetMs = number("--budget-ms", next())),
    "--kind": next => (opts.kind = next()),
    "--engine": next => (opts.engine = next()),
    "--rules": next => (opts.rules = number("--rules", next())),
    "--shapes": next => (opts.shapes = number("--shapes", next())),
    "--darts": next => (opts.darts = number("--darts", next())),
    "--lotus": next => (opts.lotus = number("--lotus", next())),
    "--viewpoints": next =>
      (opts.viewpoints = number("--viewpoints", next())),
    "--galaxies": next => (opts.galaxies = number("--galaxies", next())),
    "--myopia": next => (opts.myopia = number("--myopia", next())),
    "--letter-pairs": next =>
      (opts.letterPairs = number("--letter-pairs", next())),
    "--width": next => (opts.width = number("--width", next())),
    "--height": next => (opts.height = number("--height", next())),
    "--exe": next => {
      const value = next();
      opts.exe = value === "default" ? defaultExe : resolve(value);
    },
    "--keep-all": () => (opts.keepAll = true),
    "--big-sparse": () => (opts.bigSparse = true),
  });
  return opts;
}

type Options = ReturnType<typeof parseArgs>;

function kindFor(opts: Options, seed: number): string {
  if (opts.kind !== "both") return opts.kind;
  return seed % 2 === 0 ? "underclued" : "clued";
}

/**
 * The `--big-sparse` matrix. Dims large enough that the frontier sweep and
 * the DFS both have to earn their answers, masks that keep connectivity in
 * every draw — the class the captured hard boards fall in — cycled so
 * eighteen consecutive seeds cover the whole matrix once per kind.
 */
const BIG_SPARSE_DIMS: readonly (readonly [number, number])[] = [
  [16, 16],
  [20, 14],
  [26, 18],
];
/** v1 legacy masks; `splitLegacyMask` turns bit 6 into `runs {dark,4}`. */
const BIG_SPARSE_MASKS: readonly number[] = [
  2048, // connect-dark
  16779264, // connect-dark + no-dark-T
  2049, // connect-dark + no-dark-2x2
  6144, // both connects
  2112, // connect-dark + a dark run of four
  16779328, // connect + T + the run — the captured 16x16's exact class
];

function bigSparseDraw(seed: number) {
  const [width, height] = BIG_SPARSE_DIMS[seed % BIG_SPARSE_DIMS.length]!;
  const mask =
    BIG_SPARSE_MASKS[
      Math.floor(seed / BIG_SPARSE_DIMS.length) % BIG_SPARSE_MASKS.length
    ]!;
  return { width, height, mask };
}

/** What this seed really asks the generator for, explicit flags winning. */
function drawnFor(opts: Options, seed: number) {
  const derived = opts.bigSparse ? bigSparseDraw(seed) : null;
  return {
    width: opts.width > 0 ? opts.width : (derived?.width ?? 0),
    height: opts.height > 0 ? opts.height : (derived?.height ?? 0),
    rules: opts.rules >= 0 ? opts.rules : (derived?.mask ?? -1),
  };
}

/** The summary table's row key — dims, mask and kind name a class. */
function classOf(opts: Options, seed: number): string {
  const { width, height, rules } = drawnFor(opts, seed);
  return `${width}x${height} rules=${rules} ${kindFor(opts, seed)}`;
}

async function generate(opts: Options, path: string, seed: number) {
  const { width, height, rules } = drawnFor(opts, seed);
  const args = [
    "--generate",
    path,
    "--seed",
    String(seed),
    "--kind",
    kindFor(opts, seed),
  ];
  if (width > 0) args.push("--width", String(width));
  if (height > 0) args.push("--height", String(height));
  if (rules >= 0) args.push("--rules", String(rules));
  if (opts.shapes > 0) args.push("--shapes", String(opts.shapes));
  if (opts.darts > 0) args.push("--darts", String(opts.darts));
  if (opts.lotus > 0) args.push("--lotus", String(opts.lotus));
  if (opts.viewpoints > 0) args.push("--viewpoints", String(opts.viewpoints));
  if (opts.galaxies > 0) args.push("--galaxies", String(opts.galaxies));
  if (opts.myopia > 0) args.push("--myopia", String(opts.myopia));
  if (opts.letterPairs > 0)
    args.push("--letter-pairs", String(opts.letterPairs));
  // Five minutes rather than two: a dense mask pinned at 26x18 can burn the
  // local search's full restart budget legitimately, and a ceiling only ever
  // costs something when it is the thing that fires.
  const { exitCode } = await runCli(opts.exe, args, 300_000);
  return exitCode === 0;
}

async function solve(opts: Options, path: string): Promise<Report | null> {
  const solveArgs = [
    "--fixture",
    path,
    "--budget-ms",
    String(opts.budgetMs),
    "--brute",
    "--quiet",
    "--json",
  ];
  if (opts.engine !== "") solveArgs.push("--engine", opts.engine);
  const { json } = await runCli(
    opts.exe,
    solveArgs,
    opts.budgetMs * 3 + 60_000,
  );
  return json as Report | null;
}

/** The generated board's own coloring, in the flat row-major layout. */
function witnessOf(fixture: Record<string, unknown>): number[] {
  const width = Number(fixture.gridWidth);
  const height = Number(fixture.gridHeight);
  const columns = fixture.solution as number[][];
  const flat: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) flat.push(columns[x]![y]!);
  }
  return flat;
}

function answerOf(report: Report, width: number, height: number): number[] {
  const flat: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) flat.push(report.cells?.[x]?.[y] ?? 0);
  }
  return flat;
}

function divergences(
  fixture: Record<string, unknown>,
  report: Report | null,
): string[] {
  if (!report) return ["the solver produced no report"];
  if (report.error) return [`solver error: ${report.error}`];

  const problems: string[] = [];
  if ((report.oracleRejections ?? 0) > 0)
    problems.push("propagation and the oracle disagreed");
  if (report.witnessesLegal === false)
    problems.push("a returned witness is not a legal solution");
  if (report.valid === false) problems.push("a complete answer does not verify");
  if (report.status === "unsolvable")
    problems.push("a board built from a solution was called unsolvable");
  if (report.referenceAgreesOnSolvability === false)
    problems.push("brute force and the solver disagree about solvability");
  if (report.referenceForcedMatches === false)
    problems.push("the forced set does not match brute force");

  // The witness comparison applies to FORCED cells only. A complete answer is
  // one solution out of many — the generator's coloring is another, and the
  // two disagreeing says nothing. A cell reported forced is a claim that every
  // solution agrees on it, and the generator holds one, so that one must agree.
  if (report.status !== "deduced") return problems;

  const width = Number(fixture.gridWidth);
  const height = Number(fixture.gridHeight);
  const witness = witnessOf(fixture);
  const answer = answerOf(report, width, height);
  const wrong = answer.findIndex(
    (color, index) => color !== 0 && color !== 3 && color !== witness[index],
  );
  if (wrong >= 0)
    problems.push(
      `cell ${wrong % width},${Math.floor(wrong / width)} was reported forced against a known solution`,
    );
  return problems;
}

/** How a solve came out, as the class table counts it. */
function outcomeOf(report: Report | null): string {
  if (!report) return "no-report";
  if (report.error) return "error";
  if (report.status === "deduced") return report.proven ? "proven" : "partial";
  return report.status ?? "unknown";
}

function recordOutcome(
  tally: Map<string, Map<string, number>>,
  cls: string,
  outcome: string,
) {
  const counts = tally.get(cls) ?? new Map<string, number>();
  counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  tally.set(cls, counts);
}

/**
 * The early-warning table `--big-sparse` exists for: a class whose row holds
 * no `solved` and no `proven` is a whole batch the solver cracks nothing of —
 * the shape that used to surface only when a player hit it in the game.
 */
function printClassTable(tally: Map<string, Map<string, number>>) {
  console.log("\nBy class:");
  for (const cls of [...tally.keys()].sort((a, b) => a.localeCompare(b))) {
    const counts = [...tally.get(cls)!.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([outcome, n]) => `${outcome} ${n}`)
      .join(", ");
    console.log(`  ${cls}: ${counts}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });

let failures = 0;
const notes: string[] = [];
const classTally = new Map<string, Map<string, number>>();
for (let i = 0; i < opts.count; i++) {
  const seed = opts.seedBase + i;
  const path = resolve(outDir, `logicGridFuzz${seed}.json`);
  if (!(await generate(opts, path, seed))) {
    // Some rule sets admit no coloring at all — the perfect checkerboard the
    // two 1x2 rules force, then forbidden by rule 11. Skipping is right; a
    // generator that saved the last candidate under a success line would not
    // be.
    notes.push(`seed ${seed}: no board`);
    recordOutcome(classTally, classOf(opts, seed), "no-board");
    continue;
  }

  // A campaign has to survive the bad output it exists to find: an unreadable
  // fixture or a report that will not parse is a DIVERGENCE to record, not a
  // reason to stop with the remaining seeds untried.
  let problems: string[];
  let report: Report | null = null;
  try {
    const fixture = (await Bun.file(path).json()) as Record<string, unknown>;
    report = await solve(opts, path);
    problems = divergences(fixture, report);
  } catch (error) {
    problems = [`threw: ${error instanceof Error ? error.message : error}`];
  }
  recordOutcome(classTally, classOf(opts, seed), outcomeOf(report));
  if (problems.length === 0) {
    if (!opts.keepAll) rmSync(path, { force: true });
    continue;
  }
  failures++;
  notes.push(`seed ${seed}: ${problems.join("; ")}`);
  console.error(`seed ${seed}: ${problems.join("; ")}`);
}

await Bun.write(resolve(outDir, "failures.txt"), `${notes.join("\n")}\n`);
if (opts.bigSparse) printClassTable(classTally);
console.log(
  `\n${opts.count} boards, ${failures} divergences. Kept under ${outDir}.`,
);
if (failures > 0) process.exitCode = 1;
