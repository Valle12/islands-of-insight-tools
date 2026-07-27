import type { Tile } from "../../util/types";

// Connected goal regions and the block-shape compatibility test the A*
// assignment step uses. Split out of aStar.ts for size; these read only the
// static board, never search state, so they are free functions rather than
// methods.

export interface GoalCluster {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  depth: number;
}


export function precomputeGoalClusters(
cells: Tile[][],
gridWidth: number,
gridHeight: number,
): GoalCluster[] {
  const visited = new Set<string>();
  const clusters: GoalCluster[] = [];

  for (let x = 0; x < gridWidth; x++) {
    for (let y = 0; y < gridHeight; y++) {
      if (cells[x]![y] !== "goal") continue;
      const key = `${x},${y}`;
      if (visited.has(key)) continue;

      const component: { x: number; y: number }[] = [];
      const queue: { x: number; y: number }[] = [{ x, y }];
      visited.add(key);

      while (queue.length > 0) {
        const cur = queue.shift()!;
        component.push(cur);
        for (const [dx, dy] of [
          [0, 1],
          [0, -1],
          [1, 0],
          [-1, 0],
        ] as [number, number][]) {
          const nx = cur.x + dx,
            ny = cur.y + dy;
          if (
            nx < 0 ||
            nx >= gridWidth ||
            ny < 0 ||
            ny >= gridHeight
          )
            continue;
          if (cells[nx]![ny] !== "goal") continue;
          const nk = `${nx},${ny}`;
          if (visited.has(nk)) continue;
          visited.add(nk);
          queue.push({ x: nx, y: ny });
        }
      }

      const minX = Math.min(...component.map(c => c.x));
      const maxX = Math.max(...component.map(c => c.x));
      const minY = Math.min(...component.map(c => c.y));
      const maxY = Math.max(...component.map(c => c.y));
      clusters.push({
        minX,
        maxX,
        minY,
        maxY,
        width: maxX - minX + 1,
        depth: maxY - minY + 1,
      });
    }
  }

  return clusters;
}

// -------------------------------------------------------------------------
// Block ↔ goal assignment

export function blockPossibleFootprints(block: {
  width: number;
  depth: number;
  height: number;
}): { width: number; depth: number }[] {
  const seen = new Set<string>();
  const result: { width: number; depth: number }[] = [];
  for (const [w, d] of [
    [block.width, block.depth],
    [block.height, block.depth],
    [block.width, block.height],
    [block.depth, block.width],
    [block.depth, block.height],
    [block.height, block.width],
  ] as [number, number][]) {
    const k = `${w}x${d}`;
    if (!seen.has(k)) {
      seen.add(k);
      result.push({ width: w, depth: d });
    }
  }
  return result;
}

export function blockCompatibleWithCluster(
  block: { width: number; depth: number; height: number },
  cluster: GoalCluster,
): boolean {
  return blockPossibleFootprints(block).some(
    fp => fp.width === cluster.width && fp.depth === cluster.depth,
  );
}
