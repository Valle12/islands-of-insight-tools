import { describe, expect, test } from "bun:test";
import { solveMatchThree } from "../../src/pages/match-three-solver/engine";
import { toBoard } from "../../src/pages/match-three-solver/rules";
import { TransTable } from "../../src/pages/match-three-solver/transTable";
import type { MatchThreeTest } from "../../src/util/types";
import { board, clearsBoard, FIXTURE_DIR } from "./boards";

/** Deterministic cell noise, so eviction behavior reproduces run to run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCells(count: number, rng: () => number): Uint8Array {
  const cells = new Uint8Array(count);
  for (let i = 0; i < count; i++) cells[i] = Math.floor(rng() * 10);
  return cells;
}

/** Eight cells of one value: distinct one-word keys that all share a bucket. */
function uniformCells(value: number): Uint8Array {
  return new Uint8Array(8).fill(value);
}

describe("TransTable", () => {
  test("stores and finds an exact board, never a near miss", () => {
    const rng = mulberry32(1);
    const table = new TransTable(207, 1024 * 1024);
    const cells = randomCells(207, rng);
    table.store(cells, 3);

    expect(table.probe(cells, 3)).toBeTrue();
    // Searched out at 3 rules out any shallower attempt too.
    expect(table.probe(cells, 2)).toBeTrue();
    expect(table.probe(cells, 4)).toBeFalse();

    const other = new Uint8Array(cells);
    other[0] = other[0] === 0 ? 1 : 0;
    expect(table.probe(other, 3)).toBeFalse();
    expect(table.size).toBe(1);
  });

  test("a deeper verdict replaces a shallower one for the same board", () => {
    const table = new TransTable(8, 1024);
    const cells = uniformCells(2);
    table.store(cells, 2);
    table.store(cells, 5);
    expect(table.probe(cells, 5)).toBeTrue();
    expect(table.size).toBe(1);
  });

  test("a full bucket evicts its shallowest entry, and only for a deeper one", () => {
    // maxBytes 1 collapses the table to a single 4-way bucket, so every key
    // collides and eviction is exercised deterministically.
    const table = new TransTable(8, 1);
    const boards = [2, 3, 4, 5].map(value => uniformCells(value));
    boards.forEach((cells, i) => table.store(cells, 5 + i));
    for (const [i, cells] of boards.entries()) {
      expect(table.probe(cells, 5 + i)).toBeTrue();
    }
    expect(table.size).toBe(4);

    // A deeper newcomer replaces the remaining-5 entry and nothing else.
    const deeper = uniformCells(6);
    table.store(deeper, 9);
    expect(table.probe(deeper, 9)).toBeTrue();
    expect(table.probe(boards[0]!, 5)).toBeFalse();
    expect(table.probe(boards[1]!, 6)).toBeTrue();
    expect(table.probe(boards[2]!, 7)).toBeTrue();
    expect(table.probe(boards[3]!, 8)).toBeTrue();

    // A shallower one is dropped instead.
    const shallower = uniformCells(7);
    table.store(shallower, 1);
    expect(table.probe(shallower, 1)).toBeFalse();
    expect(table.probe(deeper, 9)).toBeTrue();
    expect(table.size).toBe(4);
  });

  test("mass inserts stay sound through growth and eviction", () => {
    const rng = mulberry32(42);
    const table = new TransTable(207, 8 * 1024 * 1024);
    const boards: Uint8Array[] = [];
    const remainings: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      const cells = randomCells(207, rng);
      boards.push(cells);
      remainings.push((i % 9) + 1);
      table.store(cells, (i % 9) + 1);
    }

    let retained = 0;
    for (let i = 0; i < boards.length; i++) {
      // Soundness: nothing may ever claim a depth it was not stored at.
      expect(table.probe(boards[i]!, remainings[i]! + 1)).toBeFalse();
      if (table.probe(boards[i]!, remainings[i]!)) retained++;
    }
    // A full bucket grows the table rather than evicting until the byte
    // budget's bucket ceiling; past it, an unlucky bucket can fill while the
    // table as a whole still has room. Measured on this seed: 19837 of
    // 20000. What matters is the soundness assertion above and that the tail
    // stays a tail.
    expect(retained).toBeGreaterThan(19_500);
    expect(table.size).toBe(retained);
  });
});

describe("solveMatchThree under a tiny evicting table", () => {
  test("a captured board keeps its exact answer", async () => {
    const config = (await Bun.file(
      `${FIXTURE_DIR}/matchThreeTest28.json`,
    ).json()) as MatchThreeTest;
    const start = toBoard(config);

    const full = solveMatchThree(start);
    // tableBytes 1 forces a single 4-way bucket: near-total eviction, and
    // the answer must not move — a lost entry only ever re-searches.
    const tiny = solveMatchThree(start, { tableBytes: 1 });

    expect(tiny).toEqual(full);
    expect(full.status).toBe("solved");
    if (full.status !== "solved") return;
    expect(full.moves).toHaveLength(5);
    expect(clearsBoard(start, full.moves)).toBeTrue();
  });

  test("an unsolvable proof survives eviction", () => {
    const start = board(["aabb", "bbaa"]);
    expect(solveMatchThree(start, { tableBytes: 1 })).toEqual({
      status: "unsolvable",
    });
  });
});
