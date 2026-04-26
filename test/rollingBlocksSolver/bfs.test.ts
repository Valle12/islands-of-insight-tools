import { describe, expect, test } from "bun:test";
import { BFS } from "../../src/pages/rolling-blocks-solver/bfs";
import { Block } from "../../src/pages/rolling-blocks-solver/block";
import { Node } from "../../src/pages/rolling-blocks-solver/node";
import type { BFSTest } from "../../src/util/types";

describe("BFS", () => {
  // FIXME puzzle 19 (website) does currently produce no result at all
  // FIXME puzzle 30 (website) (bfsTest26.json), might be translated wrong, look at game itself
  const solvableCases = [
    ["bfsTest.json"],
    ["bfsTest1.json"],
    ["bfsTest2.json"],
    ["bfsTest3.json"],
    ["bfsTest4.json"],
    ["bfsTest5.json"],
    ["bfsTest6.json"],
    ["bfsTest7.json"],
    ["bfsTest8.json"],
    ["bfsTest9.json"],
    ["bfsTest10.json"],
    ["bfsTest11.json"],
    ["bfsTest12.json"],
    ["bfsTest13.json"],
    ["bfsTest14.json"],
    ["bfsTest15.json"],
    ["bfsTest16.json"],
    ["bfsTest17.json"],
    ["bfsTest18.json"],
    ["bfsTest19.json"],
    ["bfsTest20.json"],
    ["bfsTest21.json"],
    ["bfsTest22.json"],
    ["bfsTest23.json"],
    ["bfsTest24.json"],
    ["bfsTest25.json"],
    ["bfsTest26.json"],
    ["bfsTest27.json"],
    ["bfsTest28.json"],
    ["bfsTest29.json"],
    ["bfsTest30.json"],
    ["bfsTest31.json"],
  ];

  describe("Search", () => {
    test.each(solvableCases)("should solve %s", async filename => {
      const data: BFSTest = await Bun.file(
        `${import.meta.dir}/../resources/${filename}`,
      ).json();
      const blocks = data.blocks.map(
        block =>
          new Block(
            block.id,
            block.x,
            block.y,
            block.width,
            block.depth,
            block.height,
          ),
      );
      const bfs = new BFS(data.gridWidth, data.gridHeight, data.cells);

      const turns = bfs.search(new Node(blocks));

      expect(turns).toEqual(data.turns);
    });
  });
});
