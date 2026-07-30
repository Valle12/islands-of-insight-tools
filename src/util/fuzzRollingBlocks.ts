// Randomized fuzz harness for the rolling-blocks solver.
//
//   bun run src/util/fuzzRollingBlocks.ts [--count 50] [--shuffle 100000]
//       [--budget-ms 30000] [--seed-base 1000] [--kind cycle]
//       [--out results.json] [--exe <path>] [--work-dir <dir>] [--retry]
//       [--engine <name>]
//
// Each case: the CLI's --generate mode builds a random board that is
// solvable by construction (goal boards: blocks start on their goal
// footprints and get scrambled away; coverage boards: a self-avoiding walk
// marks its first-touched cells as must-touch; mixed: both, in disjoint
// regions) and replay-validates the witness before writing. The production
// cascade then has to solve it, and the CLI replay-validates every solution.
// Any unsolved or invalid case is a genuine finding, reported with its seed
// for exact reproduction. `--kind cycle` (the default) rotates
// goal/coverage/mixed per seed so one sweep covers all three families.
//
// --retry: after the sweep, re-attempt every failure with an escalation
// ladder (long-budget cascade → cracker marathon → wide beam) so the sweep
// stays fast per board while the hard tail still gets real budgets.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFlags, runCli } from "./solverCli";

const projectRoot = resolve(import.meta.dir, "../..");
const defaultExe = resolve(
  projectRoot,
  "src/pages/rolling-blocks-solver/a-star",
  process.platform === "win32"
    ? "cmake-build-release-visual-studio/a_star.exe"
    : "build/a_star",
);

const KINDS = ["goal", "coverage", "mixed"] as const;

interface CaseResult {
  seed: number;
  kind: string;
  fixture: string;
  width?: number;
  height?: number;
  blocks?: number;
  mustTouch?: number;
  goals?: number;
  playable?: number;
  shuffleAccepted?: number;
  witnessLen?: number;
  solved: boolean;
  valid?: boolean;
  alreadySolved?: boolean;
  stage?: string;
  turns?: number;
  wallMs: number;
  error?: string;
}

function parseArgs(argv: string[]) {
  const opts = {
    exe: defaultExe,
    count: 50,
    shuffle: 100_000,
    budgetMs: 30_000,
    seedBase: 1000,
    kind: "cycle",
    out: "",
    workDir: "",
    retry: false,
    engine: "cascade",
    extra: [] as string[],
  };
  // Repeatable --extra is a passthrough for solver flags the harness does
  // not model.
  parseFlags(argv, {
    "--exe": next => (opts.exe = resolve(next())),
    "--count": next => (opts.count = Number(next())),
    "--shuffle": next => (opts.shuffle = Number(next())),
    "--budget-ms": next => (opts.budgetMs = Number(next())),
    "--seed-base": next => (opts.seedBase = Number(next())),
    "--kind": next => (opts.kind = next()),
    "--out": next => (opts.out = resolve(next())),
    "--work-dir": next => (opts.workDir = resolve(next())),
    "--engine": next => (opts.engine = next()),
    "--extra": next => opts.extra.push(next()),
    "--retry": () => (opts.retry = true),
  });
  if (!opts.workDir)
    opts.workDir = resolve(projectRoot, "test-results", "rb-fuzz");
  if (!opts.out) opts.out = resolve(opts.workDir, "fuzz-results.json");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
mkdirSync(opts.workDir, { recursive: true });
console.log(
  `fuzz: ${opts.count} boards (${opts.kind}), ${opts.shuffle} shuffle moves, ${opts.budgetMs}ms budget`,
);

const results: CaseResult[] = [];
const stageWins = new Map<string, number>();
let failures = 0;

for (let i = 0; i < opts.count; i++) {
  const seed = opts.seedBase + i;
  const kind = opts.kind === "cycle" ? KINDS[i % KINDS.length]! : opts.kind;
  const fixture = resolve(opts.workDir, `fuzz-${seed}.json`);
  const started = Date.now();

  const gen = await runCli(
    opts.exe,
    [
      "--generate",
      fixture,
      "--seed",
      String(seed),
      "--shuffle",
      String(opts.shuffle),
      "--kind",
      kind,
      "--json",
    ],
    300_000,
  );
  if (!gen.json?.generated) {
    results.push({
      seed,
      kind,
      fixture,
      solved: false,
      wallMs: Date.now() - started,
      error: `generate failed (exit ${gen.exitCode})`,
    });
    failures++;
    console.log(`  seed ${seed}: GENERATE FAILED`);
    continue;
  }

  // The cascade chains up to 8 arms with budget shares of the total; give
  // slack for the optimizer on top.
  const solve = await runCli(
    opts.exe,
    [
      "--fixture",
      fixture,
      "--engine",
      opts.engine,
      "--budget-ms",
      String(opts.budgetMs),
      ...opts.extra,
      "--json",
    ],
    opts.budgetMs * 3 + 120_000,
  );
  const s = solve.json ?? {};
  const alreadySolved = s.solved === true && (s.turns ?? 0) === 0;
  const r: CaseResult = {
    seed,
    kind,
    fixture,
    width: gen.json.width,
    height: gen.json.height,
    blocks: gen.json.blocks,
    mustTouch: gen.json.mustTouch,
    goals: gen.json.goals,
    playable: gen.json.playable,
    shuffleAccepted: gen.json.shuffleAccepted,
    witnessLen: gen.json.witnessLen,
    solved: s.solved === true,
    valid: s.valid,
    alreadySolved,
    stage: s.stage,
    turns: s.turns,
    wallMs: s.wallMs ?? Date.now() - started,
    error: solve.json
      ? undefined
      : `solver produced no JSON (exit ${solve.exitCode})`,
  };
  results.push(r);
  const ok = r.solved && r.valid !== false;
  if (!ok) failures++;
  if (ok && !alreadySolved)
    stageWins.set(r.stage ?? "?", (stageWins.get(r.stage ?? "?") ?? 0) + 1);
  let outcome: string;
  if (!ok) {
    const cause =
      r.error ?? (r.valid === false ? "INVALID SOLUTION" : "UNSOLVED");
    outcome = `*** ${cause} *** repro: --generate --seed ${seed} --kind ${kind}`;
  } else if (alreadySolved) {
    outcome = "trivial (already solved)";
  } else {
    outcome = `solved via ${r.stage} — ${r.turns} turns (witness ${r.witnessLen}) in ${r.wallMs}ms`;
  }
  console.log(
    `  seed ${seed} (${kind}): ${r.width}x${r.height} ${r.blocks}b mt=${r.mustTouch} g=${r.goals} | ${outcome}`,
  );
}

await Bun.write(opts.out, JSON.stringify({ opts, results }, null, 2));

if (opts.retry && failures > 0) {
  const isOk = (r: CaseResult) => r.solved && r.valid !== false;
  const open = results.filter(r => !isOk(r));
  console.log(
    `\n=== retry phase: ${open.length} failures, escalation ladder ===`,
  );
  const ladder = [
    {
      name: "cascade-900s",
      args: (f: string) => [
        "--fixture", f, "--engine", "cascade", "--budget-ms", "900000",
        "--json",
      ],
      timeoutMs: 900_000 * 3 + 300_000,
    },
    {
      name: "cracker-1h",
      args: (f: string) => [
        "--fixture", f, "--engine", "cracker", "--budget-ms", "3600000",
        "--json",
      ],
      timeoutMs: 3_600_000 + 600_000,
    },
    {
      name: "beam-wide-1h",
      args: (f: string) => [
        "--fixture", f, "--engine", "beam", "--beam", "500000", "--budget-ms",
        "3600000", "--json",
      ],
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
        r.wallMs = j.wallMs ?? r.wallMs;
        r.error = undefined;
        console.log(
          `  seed ${r.seed}: SOLVED on retry via ${step.name} — ${j.turns} turns in ${j.wallMs}ms`,
        );
        break;
      }
    }
    if (!isOk(r))
      console.log(`  seed ${r.seed}: STILL UNSOLVED after the full ladder`);
  }
  failures = results.filter(r => !isOk(r)).length;
  await Bun.write(opts.out, JSON.stringify({ opts, results }, null, 2));
}

const solvedCount = results.filter(r => r.solved && r.valid !== false).length;
const trivial = results.filter(r => r.alreadySolved).length;
const times = results
  .filter(r => r.solved && !r.alreadySolved)
  .map(r => r.wallMs)
  .sort((a, b) => a - b);
const pct = (p: number) =>
  times.length
    ? (times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] ?? 0)
    : 0;
console.log(`\n${solvedCount}/${results.length} solved (${trivial} trivial)`);
const winSummary = [...stageWins.entries()]
  .map(([k, v]) => `${k}=${v}`)
  .join(", ");
console.log(`stage wins: ${winSummary || "none"}`);
if (times.length)
  console.log(
    `solve time ms: p50=${pct(50)} p90=${pct(90)} max=${times.at(-1)}`,
  );
if (failures > 0) {
  console.log(
    `\n${failures} FAILURES — see repro seeds above; fixtures kept in ${opts.workDir}`,
  );
  process.exit(1);
}
console.log(`\nall generated instances solved — results at ${opts.out}`);
