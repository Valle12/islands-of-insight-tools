import { expect, test } from "@playwright/test";
import { gotoIsolated } from "../coi";

// An unsolvable board must end with "no solution", never `RuntimeError:
// Aborted()`. Under wasm a heap that cannot grow ABORTS the whole module
// rather than failing one arm, so an unbounded arm destroys the entire solve —
// which is exactly what a real browser run hit when the sequential phase was
// handed maxHeapBytes = 0 (unlimited).
//
// OPT-IN: takes ~4 minutes, because the only way to prove the guard works is
// to let the memory-hungry arms actually grow the heap. Nothing cheaper
// reaches the condition. Run with:  SM_SLOW_E2E=1 bunx playwright test
//
// Budgets are compressed (40s race, 200s phase 2) so it is minutes rather than
// the production 300s + 1200s.
test("unsolvable board reports no-solution instead of aborting", async ({
  page,
}) => {
  test.skip(!process.env.SM_SLOW_E2E, "slow (~4min): set SM_SLOW_E2E=1");
  test.setTimeout(420_000);
  await gotoIsolated(page);

  const result = await page.evaluate(async () => {
    const puzzle = {
      goalAnchor: { x: 6, y: 2 },
      goalIndex: 0,
      gridHeight: 11,
      gridWidth: 12,
      initialAnchors: [
        { x: 2, y: 2 }, { x: 9, y: 9 }, { x: 2, y: 0 }, { x: 3, y: 5 },
        { x: 6, y: 3 }, { x: 6, y: 4 }, { x: 8, y: 0 }, { x: 4, y: 0 },
        { x: 1, y: 7 }, { x: 0, y: 6 }, { x: 0, y: 0 }, { x: 10, y: 7 },
        { x: 7, y: 5 }, { x: 6, y: 7 },
      ],
      shapes: [
        [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 2 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 1 }],
        [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 0 }],
        [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }],
        [{ x: 3, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 3 }, { x: 2, y: 1 }, { x: 1, y: 3 }, { x: 3, y: 1 }, { x: 0, y: 3 }, { x: 3, y: 3 }, { x: 2, y: 0 }, { x: 1, y: 2 }, { x: 4, y: 1 }],
        [{ x: 2, y: 1 }, { x: 1, y: 1 }, { x: 3, y: 1 }, { x: 1, y: 0 }, { x: 4, y: 1 }, { x: 4, y: 0 }, { x: 0, y: 0 }, { x: 4, y: 2 }],
        [{ x: 0, y: 0 }],
        [{ x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 0 }, { x: 3, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 3 }, { x: 0, y: 2 }, { x: 3, y: 3 }],
        [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
        [{ x: 1, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 1 }, { x: 1, y: 0 }],
        [{ x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0 }],
        [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 0, y: 2 }, { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 0 }],
        [{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 2 }],
        [{ x: 0, y: 0 }],
        [{ x: 0, y: 3 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 1, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }, { x: 2, y: 1 }, { x: 1, y: 0 }],
      ],
    };
    return await new Promise<{
      outcome: string;
      phases: string[];
      turns: number;
      error: string | null;
      elapsedMs: number;
    }>(resolve => {
      const phases: string[] = [];
      const t0 = Date.now();
      const worker = new Worker("../sm-wasm/astar.worker.js", { type: "module" });
      const finish = (outcome: string, turns: number, error: string | null) => {
        worker.terminate();
        resolve({ outcome, phases, turns, error, elapsedMs: Date.now() - t0 });
      };
      worker.onmessage = e => {
        const d = e.data as {
          type: string; phase?: string; arm?: string;
          path?: unknown[]; error?: string;
        };
        if (d.type === "phase")
          phases.push(d.arm ? `${d.phase}:${d.arm}` : String(d.phase));
        else if (d.type === "done") finish("done", d.path?.length ?? 0, null);
        else if (d.type === "error") finish("error", 0, String(d.error));
      };
      worker.onerror = ev => finish("error", 0, ev.message || "worker error");
      worker.postMessage({
        puzzle,
        config: {
          engine: "cascade",
          maxMs: 40_000,
          seqTotalMs: 200_000,
          maxNodes: 0,
          postProcess: true,
        },
        variant: "threads-mem64",
      });
    });
  });

  console.log("RESULT:", JSON.stringify(result, null, 2));
  // The board is unsolvable within budget, so an empty plan is the CORRECT
  // answer. What must not happen is an abort.
  expect(result.error).toBeNull();
  expect(result.outcome).toBe("done");
  expect(result.turns).toBe(0);
  // And phase 2 must have been entered and named its arms.
  expect(result.phases.some(p => p.startsWith("sequential"))).toBe(true);
});
