import { describe, expect, test } from "bun:test";
import {
  COVERAGE_FLOOR_LINES,
  fileLinePercent,
  mergeLcov,
  passesFloor,
  totalsOf,
  worstFiles,
} from "../src/util/coverageGate";

/**
 * Reports in the shape bun writes them: `SF:` with an absolute path, `DA:`
 * per line, per-file function totals only, and `LF:`/`LH:` that the merge is
 * expected to ignore.
 */
const record = (
  path: string,
  lines: [number, number][],
  extra: string[] = [],
) =>
  [
    "TN:",
    `SF:${path}`,
    ...extra,
    ...lines.map(([line, hits]) => `DA:${line},${hits}`),
    `LF:${lines.length}`,
    `LH:${lines.filter(([, hits]) => hits > 0).length}`,
    "end_of_record",
  ].join("\n");

const A = "/repo/src/a.ts";
const B = "/repo/src/b.ts";

describe("mergeLcov", () => {
  test("adds the hits of a file two shards both ran", () => {
    const shard1 = record(A, [
      [1, 1],
      [2, 0],
    ]);
    const shard2 = record(A, [
      [1, 0],
      [2, 3],
    ]);
    const merged = mergeLcov([shard1, shard2]);
    expect(merged.size).toBe(1);
    expect(merged.get(A)!.lines.get(1)).toBe(1);
    expect(merged.get(A)!.lines.get(2)).toBe(3);
    expect(fileLinePercent(merged.get(A)!)).toBe(100);
  });

  test("a line hit in one shard only counts as hit", () => {
    const merged = mergeLcov([record(A, [[7, 0]]), record(A, [[7, 2]])]);
    expect(totalsOf(merged).linesHit).toBe(1);
    expect(totalsOf(merged).linesFound).toBe(1);
  });

  test("disjoint files add up in the totals", () => {
    const merged = mergeLcov([
      record(A, [
        [1, 1],
        [2, 1],
        [3, 0],
      ]),
      record(B, [[1, 0]]),
    ]);
    const totals = totalsOf(merged);
    expect(totals.files).toBe(2);
    expect(totals.linesFound).toBe(4);
    expect(totals.linesHit).toBe(2);
    expect(totals.linePercent).toBe(50);
  });

  test("recomputes the totals from DA lines, not from LF/LH", () => {
    // A report whose LH claims nothing was hit while its DA lines say
    // otherwise: the lines are the truth.
    const lying = record(A, [[1, 5]]).replace("LH:1", "LH:0");
    expect(totalsOf(mergeLcov([lying])).linesHit).toBe(1);
  });

  test("keeps the largest function totals it saw for a file", () => {
    const merged = mergeLcov([
      record(A, [[1, 1]], ["FNF:4", "FNH:1"]),
      record(A, [[1, 1]], ["FNF:4", "FNH:3"]),
    ]);
    expect(merged.get(A)!.functionsFound).toBe(4);
    expect(merged.get(A)!.functionsHit).toBe(3);
    expect(totalsOf(merged).functionPercent).toBe(75);
  });

  test("parses a CRLF report", () => {
    const crlf = record(A, [
      [1, 1],
      [2, 0],
    ]).replaceAll("\n", "\r\n");
    expect(fileLinePercent(mergeLcov([crlf]).get(A)!)).toBe(50);
  });

  test("an empty report set is an empty, fully covered picture", () => {
    const totals = totalsOf(mergeLcov([]));
    expect(totals.files).toBe(0);
    expect(totals.linePercent).toBe(100);
  });
});

describe("the floor", () => {
  const at = (hit: number, found: number) =>
    totalsOf(
      mergeLcov([
        record(
          A,
          Array.from({ length: found }, (_, i): [number, number] => [
            i + 1,
            i < hit ? 1 : 0,
          ]),
        ),
      ]),
    );

  test("passes at exactly the floor and fails just below it", () => {
    expect(passesFloor(at(88, 100), 88)).toBeTrue();
    expect(passesFloor(at(87, 100), 88)).toBeFalse();
    expect(passesFloor(at(8799, 10_000), 88)).toBeFalse();
  });

  test("the committed floor is a percentage", () => {
    expect(COVERAGE_FLOOR_LINES).toBeGreaterThan(0);
    expect(COVERAGE_FLOOR_LINES).toBeLessThanOrEqual(100);
  });

  test("worst files come lowest first and skip files with no lines", () => {
    const merged = mergeLcov([
      record(A, [
        [1, 1],
        [2, 0],
      ]),
      record(B, [[1, 1]]),
      record("/repo/src/empty.ts", []),
    ]);
    expect(worstFiles(merged)).toEqual([
      [A, 50],
      [B, 100],
    ]);
    expect(worstFiles(merged, 1)).toEqual([[A, 50]]);
  });
});
