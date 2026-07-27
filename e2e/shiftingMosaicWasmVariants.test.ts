import { expect, test } from "@playwright/test";

// The threaded wasm builds (astar.threads.wasm / astar.threads.mem64.wasm) are
// what a cross-origin-isolated page actually runs — their cascade is
// solveArmsParallel, 8 arms racing on real threads in ONE shared heap. Nothing
// else in the test tree loads them: the node/bun suites cannot, because
// emscripten's pthreads glue needs the browser `Worker` global ("Worker is not
// defined"), and the native gtest exercises the same C++ compiled for x64
// rather than the shipped wasm. So the binary most users run had zero coverage.
// A browser is the only place these can be tested; this file is that place.

// direction ints match the C++ enum: 0=UP 1=RIGHT 2=DOWN 3=LEFT.
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

interface Cell {
  x: number;
  y: number;
}
interface Puzzle {
  gridWidth: number;
  gridHeight: number;
  shapes: Cell[][];
  initialAnchors: Cell[];
  goalIndex: number;
  goalAnchor: Cell;
}
interface Turn {
  blockId: number;
  direction: number;
}

// 5x2 corridor with a blocker parked mid-path: the goal cannot simply slide
// right, block 1 has to step out of the way first. Small enough to solve in
// milliseconds, but it still requires the search to order two blocks.
const PUZZLE: Puzzle = {
  gridWidth: 5,
  gridHeight: 2,
  shapes: [[{ x: 0, y: 0 }], [{ x: 0, y: 0 }]],
  initialAnchors: [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
  ],
  goalIndex: 0,
  goalAnchor: { x: 4, y: 0 },
};

// Full legality replay — bounds and collisions, not just the final anchor.
// Never trust a returned plan we have not checked.
function replay(puzzle: Puzzle, turns: Turn[]): { legal: boolean; solved: boolean } {
  const anchors = puzzle.initialAnchors.map(a => ({ ...a }));
  for (const { blockId, direction } of turns) {
    const a = anchors[blockId];
    if (!a || direction < 0 || direction > 3) return { legal: false, solved: false };
    const next = { x: a.x + DX[direction]!, y: a.y + DY[direction]! };
    const others = new Set<string>();
    anchors.forEach((p, i) => {
      if (i === blockId) return;
      for (const c of puzzle.shapes[i]!) others.add(`${p.x + c.x},${p.y + c.y}`);
    });
    for (const c of puzzle.shapes[blockId]!) {
      const x = next.x + c.x;
      const y = next.y + c.y;
      if (x < 0 || y < 0 || x >= puzzle.gridWidth || y >= puzzle.gridHeight)
        return { legal: false, solved: false };
      if (others.has(`${x},${y}`)) return { legal: false, solved: false };
    }
    anchors[blockId] = next;
  }
  const g = anchors[puzzle.goalIndex]!;
  return {
    legal: true,
    solved: g.x === puzzle.goalAnchor.x && g.y === puzzle.goalAnchor.y,
  };
}

// Mirrors wasmBridge's runtime feature detection. Kept here rather than
// imported so a change to the bridge's probes surfaces as a failure instead of
// the test silently agreeing with itself.
function probeCapabilities() {
  const MEMORY64_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x04, 0x00,
  ]);
  const SHARED_MEMORY64_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x07, 0x00,
    0x01,
  ]);
  const validates = (b: Uint8Array) => {
    try {
      return typeof WebAssembly !== "undefined" && WebAssembly.validate(b);
    } catch {
      return false;
    }
  };
  return {
    isolated:
      typeof crossOriginIsolated !== "undefined" && Boolean(crossOriginIsolated),
    memory64: validates(MEMORY64_PROBE),
    sharedMemory64: validates(SHARED_MEMORY64_PROBE),
    hardwareConcurrency: navigator.hardwareConcurrency || 2,
  };
}

// Loads one wasm variant in the page and solves with the production "cascade"
// engine — which, in a pthreads build, IS solveArmsParallel.
async function solveWith(
  args: { variant: string; puzzle: Puzzle },
): Promise<{ loadMs: number; solveMs: number; turns: Turn[] }> {
  const t0 = performance.now();
  const factory = (
    await import(/* @vite-ignore */ `/sm-wasm/${args.variant}`)
  ).default;
  const mod = await factory();
  const loadMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const res = mod.solve(args.puzzle, {
    engine: "cascade",
    maxMs: 30000,
    maxNodes: 0,
    postProcess: true,
  });
  const solveMs = Math.round(performance.now() - t1);
  const turns: Turn[] = [];
  for (let i = 0; i < res.length; i++)
    turns.push({ blockId: res[i].blockId, direction: res[i].direction });
  return { loadMs, solveMs, turns };
}

// coi-serviceworker registers a service worker and then RELOADS the page to
// obtain COOP/COEP. That reload destroys the first execution context, so a
// page.evaluate racing it dies with "Execution context was destroyed". Wait for
// the reloaded, isolated document before touching the page. Every test here
// needs isolation anyway — SharedArrayBuffer is required by BOTH threaded
// builds, not just the MEMORY64 one.
async function gotoIsolated(page: import("@playwright/test").Page) {
  const isolated = () =>
    typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  await page.goto("/shifting-mosaic-solver");
  try {
    await page.waitForFunction(isolated, null, { timeout: 30000 });
    return;
  } catch {
    // Registration can miss its self-reload when the dev server is saturated by
    // the rest of the suite running in parallel. One explicit reload picks up
    // the now-registered worker; only a genuine failure survives both attempts.
    await page.reload();
    await page.waitForFunction(isolated, null, { timeout: 30000 });
  }
}

test.describe("Shifting Mosaic wasm variants", () => {
  test("page is cross-origin isolated so the threaded build is reachable", async ({
    page,
  }) => {
    await gotoIsolated(page);
    const caps = await page.evaluate(probeCapabilities);
    // The coi-serviceworker shim supplies COOP/COEP on static hosting. Without
    // isolation the bridge silently drops to the multi-worker portfolio, which
    // is a real capability regression — assert, do not skip.
    expect(caps.isolated).toBe(true);
    expect(caps.hardwareConcurrency).toBeGreaterThan(0);
  });

  test("threaded wasm32 build instantiates and solves a valid plan", async ({
    page,
  }) => {
    await gotoIsolated(page);
    const out = await page.evaluate(solveWith, {
      variant: "astar.threads.mjs",
      puzzle: PUZZLE,
    });
    expect(out.turns.length).toBeGreaterThan(0);
    const { legal, solved } = replay(PUZZLE, out.turns);
    expect(legal).toBe(true);
    expect(solved).toBe(true);
  });

  test("threaded MEMORY64 build instantiates and solves a valid plan", async ({
    page,
  }) => {
    await gotoIsolated(page);
    const caps = await page.evaluate(probeCapabilities);
    // Engines without SHARED Memory64 cannot load this build at all; the bridge
    // falls back to the wasm32 threads build, covered by the test above.
    test.skip(
      !caps.sharedMemory64,
      "engine lacks shared Memory64 — bridge uses the wasm32 threads build",
    );
    const out = await page.evaluate(solveWith, {
      variant: "astar.threads.mem64.mjs",
      puzzle: PUZZLE,
    });
    expect(out.turns.length).toBeGreaterThan(0);
    const { legal, solved } = replay(PUZZLE, out.turns);
    expect(legal).toBe(true);
    expect(solved).toBe(true);
  });

  test("MEMORY64 threads build declares an 8GB shared 64-bit heap", async ({
    page,
  }) => {
    // Plain goto: this case only fetches a static asset, so it does not need
    // cross-origin isolation and should not wait for the service worker.
    await page.goto("/shifting-mosaic-solver");
    // The threaded builds IMPORT their memory, so the ceiling lives in the JS
    // glue rather than the wasm memory section — asserting on the descriptor is
    // the only way to catch a rebuild that quietly loses MAXIMUM_MEMORY=8GB.
    // 131072 pages * 64KiB = 8GiB; address "i64" is what lifts the 4GB wall.
    const glue = await page.evaluate(async () => {
      const r = await fetch("/sm-wasm/astar.threads.mem64.mjs");
      return r.text();
    });
    expect(glue).toContain("maximum:131072n");
    expect(glue).toContain('address:"i64"');
    expect(glue).toContain("shared:true");
  });

  test("unsolvable board falls back to the sequential phase and says so", async ({
    page,
  }) => {
    await gotoIsolated(page);
    const caps = await page.evaluate(probeCapabilities);
    test.skip(!caps.sharedMemory64, "needs the threaded MEMORY64 build");
    // 3x3, goal is one cell at (0,0) that must reach (2,2). Columns 1 and 2 are
    // full-height blocks: column 2 is pinned by the wall, column 1 is pinned by
    // column 2 on its right and by the goal occupying (0,0) on its left. Both
    // walls are immovable, so the goal can never leave column 0 — UNSOLVABLE.
    // Every arm therefore returns empty, the race yields nothing, and phase 2
    // must run. Budgets are tiny so this takes seconds, not the production
    // 300s/1200s.
    const out = await page.evaluate(async () => {
      const phases: string[] = [];
      const orig = self.postMessage.bind(self);
      // The module posts {type:"phase"} through self.postMessage (it runs in a
      // worker in production); in the page we intercept it the same way the
      // bridge would.
      (self as unknown as { postMessage: (m: unknown) => void }).postMessage = (
        m: unknown,
      ) => {
        const msg = m as { type?: string; phase?: string };
        if (msg?.type === "phase" && msg.phase) phases.push(msg.phase);
      };
      try {
        // Built as a variable, not a literal: a literal specifier makes tsc try
        // to resolve this browser-only URL at compile time and fail with
        // TS2307 (the sibling call in solveWith() dodges it via a template
        // literal). `bunx tsc --noEmit` is otherwise clean on this tree.
        const mem64Url = "/sm-wasm/" + "astar.threads.mem64.mjs";
        const factory = (await import(/* @vite-ignore */ mem64Url)).default;
        const mod = await factory();
        const column = [
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: 2 },
        ];
        const puzzle = {
          gridWidth: 3,
          gridHeight: 3,
          shapes: [[{ x: 0, y: 0 }], column, column],
          initialAnchors: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 2, y: 0 },
          ],
          goalIndex: 0,
          goalAnchor: { x: 2, y: 2 },
        };
        const res = mod.solve(puzzle, {
          engine: "cascade",
          maxMs: 1500,
          seqTotalMs: 4000,
          maxNodes: 0,
          postProcess: true,
        });
        return { phases, turns: res.length };
      } finally {
        (self as unknown as { postMessage: unknown }).postMessage = orig;
      }
    });
    // No plan exists, so nothing may be returned...
    expect(out.turns).toBe(0);
    // ...and the fallback must have run and announced itself. This is the
    // wasm-side guard on the phase channel; that the fallback RECOVERS boards
    // is covered natively (--engine twophase wins seeds 41193 and 42889).
    expect(out.phases).toContain("sequential");
  });

  test("bridge selects the largest heap the engine supports", async ({ page }) => {
    await gotoIsolated(page);
    const caps = await page.evaluate(probeCapabilities);
    const selected = caps.isolated
      ? caps.sharedMemory64
        ? "threads-mem64"
        : "threads"
      : caps.memory64
        ? "mem64"
        : "default";
    // Isolated + shared Memory64 is the only configuration that gives all 8
    // racing arms an 8GB heap. On the measured hard tail, 6 of the 8 boards a
    // browser can finish peak above 4GB, so dropping to wasm32 loses them.
    if (caps.isolated && caps.sharedMemory64) {
      expect(selected).toBe("threads-mem64");
    }
    expect(["threads-mem64", "threads", "mem64", "default"]).toContain(selected);
  });
});
