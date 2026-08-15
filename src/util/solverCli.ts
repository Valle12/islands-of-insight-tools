// Shared plumbing for the solver CLI harnesses (bench + fuzz, both
// solvers): the child-process runner speaking the CLIs' last-JSON-line
// protocol, and the flag-map argument parser they all scaffold the same way.

// Runs a solver binary and parses its report — the LAST stdout line starting
// with "{" is the JSON protocol both solvers' CLIs share. stderr is drained,
// not just piped: an unread pipe buffer fills up and blocks the child
// mid-write, which then gets scored as a timeout.
export async function runCli(exe: string, args: string[], timeoutMs: number) {
  const proc = Bun.spawn([exe, ...args], { stdout: "pipe", stderr: "pipe" });
  const killer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  const lastJson = stdout
    .split("\n")
    .map(l => l.trim())
    .findLast(l => l.startsWith("{"));
  if (!lastJson) return { json: null, exitCode };
  try {
    return { json: JSON.parse(lastJson), exitCode };
  } catch {
    // Truncated line from a child killed mid-write — one bad case, not a
    // reason to abandon the run.
    return { json: null, exitCode };
  }
}

// Flag-map argument parser: each handler pulls its values through `next()`,
// so single-value flags, multi-value flags (--diff before after) and
// boolean flags (never call next) all fit the one shape.
export function parseFlags(
  argv: string[],
  flags: Record<string, (next: () => string) => void>,
) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // `Object.hasOwn`, never a bare lookup: `flags["toString"]` finds
    // `Object.prototype.toString`, which is truthy, so an argument named after
    // a prototype member slipped past the guard and was silently ignored —
    // and `flags["__proto__"]` yielded an object, throwing a TypeError instead
    // of the message.
    const handler = Object.hasOwn(flags, arg) ? flags[arg] : undefined;
    if (!handler) throw new Error(`Unknown argument: ${arg}`);
    handler(() => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${arg}`);
      return v;
    });
  }
}
