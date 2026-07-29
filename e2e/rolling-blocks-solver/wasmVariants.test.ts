import { expect, test } from "@playwright/test";
import { gotoIsolated } from "../coi";

// A 5x1 corridor: a unit cube at (0,0), the goal at (2,0). Solvable in two
// rolls; small enough that every arm settles instantly.
const PUZZLE = {
  gridWidth: 5,
  gridHeight: 1,
  cells: [0, 0, 2, 0, 0],
  blocks: [{ id: 1, x: 0, y: 0, width: 1, depth: 1, height: 1 }],
};

type Turn = { blockId: number; direction: number };

// Exact replay for a lone unit cube: rolls translate it one cell.
function cubeSolves(turns: Turn[]): boolean {
  let x = 0;
  let y = 0;
  for (const t of turns) {
    if (t.blockId !== 1) return false;
    if (t.direction === 0) y--;
    else if (t.direction === 1) x++;
    else if (t.direction === 2) y++;
    else x--;
    if (x < 0 || x > 4 || y !== 0) return false;
  }
  return x === 2;
}

function probeCapabilities() {
  const SHARED_MEMORY64_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x07,
    0x00, 0x01,
  ]);
  const TABLE64_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x04, 0x04, 0x01, 0x70,
    0x04, 0x00,
  ]);
  const validates = (bytes: Uint8Array) => {
    try {
      return typeof WebAssembly !== "undefined" && WebAssembly.validate(bytes);
    } catch {
      return false;
    }
  };
  return {
    isolated:
      typeof crossOriginIsolated !== "undefined" && crossOriginIsolated,
    sharedMemory64:
      validates(SHARED_MEMORY64_PROBE) && validates(TABLE64_PROBE),
  };
}

// Loads one wasm variant in the page and solves with the production cascade —
// which, in a pthreads build, races every arm on real threads.
async function solveWith(args: {
  variant: string;
  puzzle: typeof PUZZLE;
}): Promise<{ turns: Turn[]; engine?: string; error?: string }> {
  const factory = (await import(/* @vite-ignore */ `/rb-wasm/${args.variant}`))
    .default;
  const mod = await factory();
  const res = mod.solve(args.puzzle, { engine: "cascade", maxMs: 30000 });
  const turns: Turn[] = [];
  for (const t of res.turns) {
    turns.push({ blockId: t.blockId, direction: t.direction });
  }
  return { turns, engine: res.stats?.engine, error: res.error };
}

test.describe("Rolling Blocks wasm variants", () => {
  test("page is cross-origin isolated so the threaded build is reachable", async ({
    page,
  }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");
    const caps = await page.evaluate(probeCapabilities);
    // Without isolation the bridge silently drops to the multi-worker
    // portfolio — a real capability regression, so assert rather than skip.
    expect(caps.isolated).toBe(true);
  });

  test("threaded wasm32 build races its arms and solves a valid plan", async ({
    page,
  }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");
    const out = await page.evaluate(solveWith, {
      variant: "astar.threads.mjs",
      puzzle: PUZZLE,
    });
    expect(out.error).toBeUndefined();
    expect(cubeSolves(out.turns)).toBe(true);
    expect(out.engine).toBeTruthy();
  });

  test("threaded MEMORY64 build instantiates and solves a valid plan", async ({
    page,
  }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");
    const caps = await page.evaluate(probeCapabilities);
    test.skip(
      !caps.sharedMemory64,
      "engine lacks shared Memory64 — bridge uses the wasm32 threads build",
    );
    const out = await page.evaluate(solveWith, {
      variant: "astar.threads.mem64.mjs",
      puzzle: PUZZLE,
    });
    expect(out.error).toBeUndefined();
    expect(cubeSolves(out.turns)).toBe(true);
  });

  test("MEMORY64 threads build declares an 8GB shared 64-bit heap", async ({
    page,
  }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");
    // The threaded builds IMPORT their memory, so the ceiling lives in the JS
    // glue — asserting on the descriptor is the only way to catch a rebuild
    // that quietly loses MAXIMUM_MEMORY=8GB. 131072 pages * 64KiB = 8GiB.
    const glue = await page.evaluate(async () => {
      const r = await fetch("/rb-wasm/astar.threads.mem64.mjs");
      return r.text();
    });
    expect(glue).toContain("maximum:131072n");
    expect(glue).toContain('address:"i64"');
    expect(glue).toContain("shared:true");
  });

  test("an unsolvable board reports no solution instead of hanging", async ({
    page,
  }) => {
    await gotoIsolated(page, "/rolling-blocks-solver");

    // Wall a must-touch cell in on all four sides: nothing can ever reach it,
    // and every arm exhausts the tiny space almost immediately.
    await page.getByRole("button", { name: "Must-Touch", exact: true }).click();
    await page.getByRole("button", { name: "Column 3, Row 3, Regular" }).click();
    await page.getByRole("button", { name: "Unplayable" }).click();
    for (const cell of [
      "Column 2, Row 3, Regular",
      "Column 4, Row 3, Regular",
      "Column 3, Row 2, Regular",
      "Column 3, Row 4, Regular",
    ]) {
      await page.getByRole("button", { name: cell }).click();
    }
    await page.getByRole("button", { name: "Block Footprint" }).click();
    await page.getByRole("button", { name: "Column 1, Row 1, Regular" }).click();

    await page.getByRole("button", { name: "Calculate Moves" }).click();
    await expect(page.locator("#solution-status")).toHaveText(
      "No solution found",
      { timeout: 60000 },
    );
  });
});
