import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import {
  expectEveryArmAgrees,
  RESOURCE_DIR,
  SWEEP_TIMEOUT_MS,
} from "./wasmHarness";
import type { LogicGridTest } from "../../src/util/types";

/**
 * The captured corpus through the real module — the agreement half of the two
 * sweeps (`wasmHarness.ts` spells out what it asserts; "the corpus solves" is
 * the C++ `fixtures_test`'s claim).
 *
 * A `.slow.test.ts` since the corpus outgrew the fast lane: the sweep first
 * measured 579 ms for 36 boards, then 40.7 s for 164, and the galaxy-era batch
 * took it past 90 s for 436 — the boards captured since the first measurement
 * are the ones that actually branch, and several spend the whole 2 s per-arm
 * budget. The hand-built boundary boards stayed behind in `wasm.test.ts`, so
 * the fast lane keeps the deep-search stack pin and every
 * format-key-crosses-the-boundary case.
 *
 * `describe.skipIf`, never `describe.if`: skipped must REPORT as skipped. And
 * CI runs this as its own shard — a suite gated here and absent from the shard
 * list would run nowhere at all, which is the silent-green trap the env-gate
 * rules exist for.
 */

const captured = readdirSync(RESOURCE_DIR).filter(name =>
  name.endsWith(".json"),
);

// Outside the gate, so an emptied corpus fails even when the sweep is skipped
// — the `describe.if(fixtures.length > 0)` trap in miniature.
test("the captured corpus is non-empty", () => {
  expect(captured.length).toBeGreaterThan(0);
});

describe.skipIf(Bun.env.IOI_SKIP_SLOW === "1")("logic-grid wasm corpus", () => {
  test.each(
    captured.map((name): [string, () => Promise<LogicGridTest>] => [
      name,
      () => Bun.file(`${RESOURCE_DIR}/${name}`).json() as Promise<LogicGridTest>,
    ]),
  )(
    "every arm agrees about %s",
    async (_name, load) => expectEveryArmAgrees(load),
    SWEEP_TIMEOUT_MS,
  );
});
