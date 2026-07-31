import { describe, expect, test } from "bun:test";
import { solveMatchThree } from "../../src/pages/match-three-solver/engine";
import { toBoard } from "../../src/pages/match-three-solver/rules";
import type { MatchThreeTest } from "../../src/util/types";
import { clearsBoard, FIXTURE_DIR, FIXTURES } from "./boards";

// ---------------------------------------------------------------------------
// The expensive half of the captured-board corpus: actually solving the
// boards, pinning their proven-minimal lengths, and replaying every answer.
// The cheap legality sweep over the same corpus stays in engine.test.ts.
// ---------------------------------------------------------------------------

describe.skipIf(Bun.env.IOI_SKIP_SLOW === "1")("Captured boards are solvable", () => {
  /**
   * The captured boards no engine can PROVE. Membership says nothing about
   * whether an answer exists: matchThreeTest47's is 20 moves, the dive finds it
   * at longer budgets, and a 46-minute run in July confirmed it is optimal —
   * what cannot be done is exhausting the nineteen shorter lengths, which at
   * the measured x2.5 per level is orders of magnitude away
   * (a-star/bench/HARD-BOARDS.md). A fixture leaves this set the day the sweep
   * proves it at SWEEP_BUDGET_MS, and this test is what says so.
   */
  const BEYOND_BUDGET = new Set([
    "matchThreeTest47.json",
    "matchThreeTest50.json",
    "matchThreeTest51.json",
  ]);

  /** Enough to notice one of them turning easy, without paying the full budget. */
  const PROBE_MS = 2_000;

  /**
   * Explicit, never the default: the page's own budget is five minutes, and
   * five minutes per failing fixture is not something CI may ever wait on.
   */
  const SWEEP_BUDGET_MS = 30_000;

  /** The slowest board that does finish needs seconds; leave room on a busy CI. */
  const SWEEP_TIMEOUT_MS = 60_000;

  /**
   * Proven-minimal lengths, from bench/baseline-ts-30s.json. Pinned so an
   * engine change that silently flips a proof goes red here; a fixture
   * dropped in later has no entry and simply skips the pin.
   */
  const PROVEN_LENGTHS: Record<string, number> = {
    "matchThreeTest.json": 1,
    "matchThreeTest1.json": 2,
    "matchThreeTest2.json": 2,
    "matchThreeTest3.json": 2,
    "matchThreeTest4.json": 1,
    "matchThreeTest5.json": 2,
    "matchThreeTest6.json": 2,
    "matchThreeTest7.json": 1,
    "matchThreeTest8.json": 7,
    "matchThreeTest9.json": 5,
    "matchThreeTest10.json": 6,
    "matchThreeTest11.json": 7,
    "matchThreeTest12.json": 6,
    "matchThreeTest13.json": 10,
    "matchThreeTest14.json": 7,
    "matchThreeTest15.json": 3,
    "matchThreeTest16.json": 2,
    "matchThreeTest17.json": 4,
    "matchThreeTest18.json": 6,
    "matchThreeTest19.json": 4,
    "matchThreeTest20.json": 7,
    "matchThreeTest21.json": 3,
    "matchThreeTest22.json": 1,
    "matchThreeTest23.json": 2,
    "matchThreeTest24.json": 3,
    "matchThreeTest25.json": 4,
    "matchThreeTest26.json": 4,
    "matchThreeTest27.json": 6,
    "matchThreeTest28.json": 5,
    "matchThreeTest29.json": 2,
    "matchThreeTest30.json": 3,
    "matchThreeTest31.json": 6,
    "matchThreeTest32.json": 5,
    "matchThreeTest33.json": 4,
    "matchThreeTest34.json": 3,
    "matchThreeTest35.json": 8,
    "matchThreeTest36.json": 4,
    "matchThreeTest37.json": 5,
    "matchThreeTest38.json": 4,
    "matchThreeTest39.json": 6,
    "matchThreeTest40.json": 3,
    "matchThreeTest41.json": 10,
    "matchThreeTest42.json": 6,
    "matchThreeTest43.json": 8,
    "matchThreeTest44.json": 14,
    "matchThreeTest45.json": 7,
    "matchThreeTest46.json": 7,
    "matchThreeTest48.json": 7,
    "matchThreeTest49.json": 10,
  };

  test.each(FIXTURES.filter(name => !BEYOND_BUDGET.has(name)))(
    "%s is clearable",
    async name => {
      const config = (await Bun.file(
        `${FIXTURE_DIR}/${name}`,
      ).json()) as MatchThreeTest;
      const start = toBoard(config);

      const result = solveMatchThree(start, { budgetMs: SWEEP_BUDGET_MS });
      expect(result.status).toBe("solved");
      if (result.status !== "solved") return;
      expect(result.proven).toBeTrue();
      expect(result.moves.length).toBeGreaterThan(0);
      const pinned = PROVEN_LENGTHS[name];
      if (pinned !== undefined) expect(result.moves).toHaveLength(pinned);
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
    const start = toBoard(config);

    const result = solveMatchThree(start, { budgetMs: PROBE_MS });
    // Never "unsolvable": that would be a proof, and no proof was reached.
    expect(result.status).not.toBe("unsolvable");
    if (result.status === "solved") {
      // The fast arms may well find SOMETHING at 2s — but a PROVEN minimum
      // here is the signal to move the fixture into the sweep above.
      expect(result.proven).toBeFalse();
      expect(clearsBoard(start, result.moves)).toBeTrue();
    }
  }, SWEEP_TIMEOUT_MS);
});
