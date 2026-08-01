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
   * The boards the cheap arms cannot crack. Their answers come from NRPA, a
   * stochastic arm, and the TypeScript engine on its own does not reliably get
   * there — measured, it was still empty-handed on matchThreeTest50 at 180 s
   * where the native seeds do it in about a second. So this sweep only asks
   * them to be honest, and `wasm.slow.test.ts` carries the positive assertion
   * that the witnesses exist, using the seeds measured to find them.
   */
  const STOCHASTIC = new Set([
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
   * Length CEILINGS, not proven minima.
   *
   * These were exact proven lengths, and the equality was the cross-engine
   * check. The search no longer proves anything about length — it returns the
   * first solution it finds — so they are an upper bound instead: a quality net
   * that catches an arm-ordering regression which starts returning fifteen-move
   * answers where seven exist. Every value is the measured optimum, which the
   * first find still matches on all but one board (see matchThreeTest46). A
   * fixture with no entry simply skips the check.
   */
  const LENGTH_CEILINGS: Record<string, number> = {
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
    // The one board where the first find is not the optimum: 8, optimum 7.
    "matchThreeTest46.json": 8,
    "matchThreeTest48.json": 7,
    "matchThreeTest49.json": 10,
  };

  test.each(FIXTURES.filter(name => !STOCHASTIC.has(name)))(
    "%s is clearable",
    async name => {
      const config = (await Bun.file(
        `${FIXTURE_DIR}/${name}`,
      ).json()) as MatchThreeTest;
      const start = toBoard(config);

      const result = solveMatchThree(start, { budgetMs: SWEEP_BUDGET_MS });
      expect(result.status).toBe("solved");
      if (result.status !== "solved") return;
      expect(result.moves.length).toBeGreaterThan(0);
      const ceiling = LENGTH_CEILINGS[name];
      if (ceiling !== undefined) {
        expect(result.moves.length).toBeLessThanOrEqual(ceiling);
      }
      // The move list is only an answer if it survives being played.
      expect(clearsBoard(start, result.moves)).toBeTrue();
    },
    SWEEP_TIMEOUT_MS,
  );

  test.each([...STOCHASTIC])("%s answers honestly or not at all", async name => {
    expect(FIXTURES).toContain(name);
    const config = (await Bun.file(
      `${FIXTURE_DIR}/${name}`,
    ).json()) as MatchThreeTest;
    const start = toBoard(config);

    const result = solveMatchThree(start, { budgetMs: PROBE_MS });
    // Never "unsolvable": these are captured boards, and all three are known to
    // have answers, so claiming otherwise would be a proof contradicting itself.
    expect(result.status).not.toBe("unsolvable");
    // Whatever it does find has to be playable.
    if (result.status === "solved") {
      expect(clearsBoard(start, result.moves)).toBeTrue();
    }
  }, SWEEP_TIMEOUT_MS);
});
