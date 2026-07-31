import { describe, expect, test } from "bun:test";
import { solveMatchThree } from "../../src/pages/match-three-solver/engine";
import { toBoard } from "../../src/pages/match-three-solver/rules";
import type { MatchThreeTest } from "../../src/util/types";
import { clearsBoard, FIXTURE_DIR, FIXTURES } from "./boards";

// ---------------------------------------------------------------------------
// The expensive half of the captured-board corpus: actually solving all 52 of
// them and replaying the answer. ~44s, nearly all of it matchThreeTest44.json
// (12x12, 71 blocks, 14 moves, ~13s) — hence the .slow name and the opt-out.
// The cheap legality sweep over the same corpus stays in engine.test.ts.
// ---------------------------------------------------------------------------

describe.skipIf(Bun.env.IOI_SKIP_SLOW === "1")("Captured boards are solvable", () => {
  /**
   * The captured boards the search cannot yet finish. They are legal game
   * states like every other fixture, and nothing suggests they are anything
   * but clearable — the engine simply runs out of budget before it can prove
   * a length. Named here rather than dropped from the sweep so that the day
   * one of them becomes solvable, this test is what says so.
   */
  const BEYOND_BUDGET = new Set([
    "matchThreeTest47.json",
    "matchThreeTest50.json",
    "matchThreeTest51.json",
  ]);

  /** Enough to notice one of them turning easy, without paying the full budget. */
  const PROBE_MS = 2_000;

  /** The slowest board that does finish needs ~13s; leave room on a busy CI. */
  const SWEEP_TIMEOUT_MS = 60_000;

  test.each(FIXTURES.filter(name => !BEYOND_BUDGET.has(name)))(
    "%s is clearable",
    async name => {
      const config = (await Bun.file(
        `${FIXTURE_DIR}/${name}`,
      ).json()) as MatchThreeTest;
      const start = toBoard(config);

      const result = solveMatchThree(start);
      expect(result.status).toBe("solved");
      if (result.status !== "solved") return;
      expect(result.moves.length).toBeGreaterThan(0);
      // The move list is only an answer if it survives being played.
      expect(clearsBoard(start, result.moves)).toBeTrue();
    },
    SWEEP_TIMEOUT_MS,
  );

  test.each([...BEYOND_BUDGET])("%s still outruns the budget", async name => {
    expect(FIXTURES).toContain(name);
    const config = (await Bun.file(
      `${FIXTURE_DIR}/${name}`,
    ).json()) as MatchThreeTest;
    const result = solveMatchThree(toBoard(config), { budgetMs: PROBE_MS });
    // Never "unsolvable": that would be a proof, and no proof was reached.
    expect(result.status).toBe("budget");
    // Explicit, because PROBE_MS is 2s of bun's 5s default and the budget
    // check is not instantaneous — a loaded runner would report a timeout
    // failure instead of the assertion this test is actually making.
  }, SWEEP_TIMEOUT_MS);
});
