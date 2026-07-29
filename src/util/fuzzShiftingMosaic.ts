// Randomized fuzz harness for the shifting-mosaic solver.
//
//   bun run src/util/fuzzShiftingMosaic.ts [--count 50] [--shuffle 100000]
//       [--budget-ms 30000] [--seed-base 1000] [--out results.json]
//       [--exe <path>] [--work-dir <dir>] [--retry] [--engine <name>]
//
// --engine parallel is the SHIPPED browser path (solveArmsParallel: 8 arms
// racing on real threads). --engine cascade is the sequential chain and is
// a different measurement — each board takes 8 threads under `parallel`, so
// shard accordingly.
//
// --retry: after the sweep, re-attempt every failure with an escalation
// ladder (long-budget cascade → elite-jam marathon → wide guided beam) —
// the sweep stays fast per board while the hard tail still gets the
// budgets the jam class needs (see bench/HARD-BOARDS.md).
//
// Each case: the CLI's --generate mode builds a random board (4x4..60x60,
// 1-20 polyomino blocks) whose goal block STARTS on its goal anchor, then
// scrambles it with a long random walk — solvable by construction. The
// production cascade (assembly → hier → drag → unit) then has to solve it;
// the CLI replay-validates every solution. Any unsolved or invalid case is
// a genuine finding and is reported with its seed for exact reproduction.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags, runCli } from "./solverCli";

const projectRoot = resolve(import.meta.dir, "../..");
const defaultExe = resolve(
  projectRoot,
  "src/pages/shifting-mosaic-solver/a-star/build-native/Release",
  process.platform === "win32" ? "shifting_mosaic_a_star.exe" : "shifting_mosaic_a_star",
);

interface CaseResult {
  seed: number;
  fixture: string;
  width?: number;
  height?: number;
  blocks?: number;
  cells?: number;
  density?: number;
  shuffleAccepted?: number;
  goalDisplaced?: boolean;
  solved: boolean;
  valid?: boolean;
  alreadySolved?: boolean;
  stage?: string;
  turns?: number;
  steps?: number;
  wallMs: number;
  // Per-arm outcome from the parallel/sequential engines: which arms solved,
  // which won, and how long each took. Aggregated to decide the sequential
  // phase's arm ORDER, which is otherwise guesswork.
  arms?: { arm: number; name: string; solved: boolean; won: boolean; declined: boolean; wallMs: number }[];
  error?: string;
}

function parseArgs(argv: string[]) {
  const opts = {
    exe: defaultExe,
    count: 50,
    shuffle: 100_000,
    budgetMs: 30_000,
    seedBase: 1000,
    out: "",
    workDir: "",
    retry: false,
    engine: "cascade",
    extra: [] as string[],
  };
  // Repeatable --extra is a passthrough for solver flags the harness does
  // not model, e.g. --extra --jam-aspect --extra 66 --extra --max-heap-bytes.
  parseFlags(argv, {
    "--exe": next => (opts.exe = resolve(next())),
    "--count": next => (opts.count = Number(next())),
    "--shuffle": next => (opts.shuffle = Number(next())),
    "--budget-ms": next => (opts.budgetMs = Number(next())),
    "--seed-base": next => (opts.seedBase = Number(next())),
    "--out": next => (opts.out = resolve(next())),
    "--work-dir": next => (opts.workDir = resolve(next())),
    "--engine": next => (opts.engine = next()),
    "--extra": next => opts.extra.push(next()),
    "--retry": () => (opts.retry = true),
  });
  if (!opts.workDir)
    opts.workDir = resolve(projectRoot, "test-results", "sm-fuzz");
  if (!opts.out) opts.out = resolve(opts.workDir, "fuzz-results.json");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
mkdirSync(opts.workDir, { recursive: true });
console.log(
  `fuzz: ${opts.count} boards, ${opts.shuffle} shuffle moves, ${opts.budgetMs}ms per cascade stage`,
);

const results: CaseResult[] = [];
const stageWins = new Map<string, number>();
let failures = 0;

for (let i = 0; i < opts.count; i++) {
  const seed = opts.seedBase + i;
  const fixture = resolve(opts.workDir, `fuzz-${seed}.json`);
  const started = Date.now();

  const gen = await runCli(
    opts.exe,
    ["--generate", fixture, "--seed", String(seed), "--shuffle", String(opts.shuffle), "--json"],
    120_000,
  );
  if (!gen.json) {
    results.push({ seed, fixture, solved: false, wallMs: Date.now() - started, error: `generate failed (exit ${gen.exitCode})` });
    failures++;
    console.log(`  seed ${seed}: GENERATE FAILED`);
    continue;
  }

  // Cascade worst case: 8 sequential stages + optimizer slack.
  const solve = await runCli(
    opts.exe,
    ["--fixture", fixture, "--engine", opts.engine, "--budget-ms", String(opts.budgetMs), "--max-nodes", "0", ...opts.extra, "--json"],
    opts.budgetMs * 9 + 120_000,
  );
  const s = solve.json ?? {};
  const alreadySolved = s.solved === true && (s.turns ?? 0) === 0;
  const r: CaseResult = {
    seed,
    fixture,
    width: gen.json.width,
    height: gen.json.height,
    blocks: gen.json.blocks,
    cells: gen.json.cells,
    density: gen.json.density,
    shuffleAccepted: gen.json.shuffleAccepted,
    goalDisplaced: gen.json.goalDisplaced,
    solved: s.solved === true,
    valid: s.valid,
    alreadySolved,
    stage: s.stage,
    turns: s.turns,
    steps: s.steps,
    wallMs: s.wallMs ?? Date.now() - started,
    arms: s.arms,
    error: solve.json ? undefined : `solver produced no JSON (exit ${solve.exitCode})`,
  };
  results.push(r);
  const ok = r.solved && r.valid !== false;
  if (!ok) failures++;
  if (ok && !alreadySolved)
    stageWins.set(r.stage ?? "?", (stageWins.get(r.stage ?? "?") ?? 0) + 1);
  console.log(
    `  seed ${seed}: ${r.width}x${r.height} ${r.blocks}b ${(100 * (r.density ?? 0)).toFixed(0)}% | ` +
      (ok
        ? alreadySolved
          ? "trivial (goal drifted home)"
          : `solved via ${r.stage} — ${r.turns} turns / ${r.steps} steps in ${r.wallMs}ms`
        : `*** ${r.error ?? (r.valid === false ? "INVALID SOLUTION" : "UNSOLVED")} *** repro: --generate --seed ${seed}`),
  );
}

await Bun.write(opts.out, JSON.stringify({ opts, results }, null, 2));

// Retry phase: the sweep keeps per-board time bounded; the recorded failures
// now get the budgets the jam class actually needs (HARD-BOARDS.md).
if (opts.retry && failures > 0) {
  const isOk = (r: CaseResult) => r.solved && r.valid !== false;
  const open = results.filter(r => !isOk(r));
  console.log(`\n=== retry phase: ${open.length} failures, escalation ladder ===`);
  const ladder = [
    {
      name: "cascade-900s",
      args: (f: string) => ["--fixture", f, "--engine", "cascade", "--budget-ms", "900000", "--max-nodes", "0", "--json"],
      timeoutMs: 900_000 * 9 + 300_000,
    },
    {
      name: "elite-jam-3h",
      args: (f: string) => ["--fixture", f, "--engine", "jam", "--bands", "--budget-ms", "10800000", "--max-nodes", "0", "--json"],
      timeoutMs: 10_800_000 + 600_000,
    },
    {
      name: "beam-wide-1h",
      args: (f: string) => ["--fixture", f, "--engine", "beam", "--bands", "--beam", "500000", "--jam-penalty", "8", "--budget-ms", "3600000", "--max-nodes", "0", "--json"],
      timeoutMs: 3_600_000 + 600_000,
    },
  ];
  for (const r of open) {
    for (const step of ladder) {
      console.log(`  retry seed ${r.seed} via ${step.name}...`);
      const res = await runCli(opts.exe, step.args(r.fixture), step.timeoutMs);
      const j = res.json;
      if (j?.solved === true && j?.valid !== false) {
        r.solved = true;
        r.valid = j.valid;
        r.stage = `retry:${step.name}:${j.stage}`;
        r.turns = j.turns;
        r.steps = j.steps;
        r.wallMs = j.wallMs;
        r.error = undefined;
        console.log(
          `  seed ${r.seed}: SOLVED on retry via ${step.name} — ${j.turns} turns / ${j.steps} steps in ${j.wallMs}ms`,
        );
        break;
      }
    }
    if (!isOk(r)) console.log(`  seed ${r.seed}: STILL UNSOLVED after the full ladder`);
  }
  failures = results.filter(r => !isOk(r)).length;
  await Bun.write(opts.out, JSON.stringify({ opts, results }, null, 2));
}

const solvedCount = results.filter(r => r.solved && r.valid !== false).length;
const trivial = results.filter(r => r.alreadySolved).length;
const times = results.filter(r => r.solved && !r.alreadySolved).map(r => r.wallMs).sort((a, b) => a - b);
const pct = (p: number) => times.length ? times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] : 0;
console.log(`\n${solvedCount}/${results.length} solved (${trivial} trivial)`);
console.log(`stage wins: ${[...stageWins.entries()].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
if (times.length)
  console.log(`solve time ms: p50=${pct(50)} p90=${pct(90)} max=${times[times.length - 1]}`);
if (failures > 0) {
  console.log(`\n${failures} FAILURES — see repro seeds above; fixtures kept in ${opts.workDir}`);
  process.exit(1);
}
console.log(`\nall generated instances solved — results at ${opts.out}`);
