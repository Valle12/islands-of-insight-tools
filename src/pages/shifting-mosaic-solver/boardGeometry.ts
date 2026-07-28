import type { Position } from "../../util/types";

// Pure grid predicates used by Board. Split out of board.ts for size, and
// because none of them touch board state — which also lets the tests call
// them directly instead of reaching through a Board instance.

/**
 * True when every cell in `cells` is reachable from the first by 4-way
 * adjacency — the rule a freeform-dragged block must satisfy to be placed.
 */
export function isContiguous(cells: Position[]): boolean {
  if (cells.length <= 1) return true;
  const cellSet = new Set(cells.map(c => `${c.x},${c.y}`));
  const visited = new Set<string>();
  const start = cells[0]!;
  const queue: Position[] = [start];
  visited.add(`${start.x},${start.y}`);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors: Position[] = [
      { x: current.x, y: current.y - 1 },
      { x: current.x + 1, y: current.y },
      { x: current.x, y: current.y + 1 },
      { x: current.x - 1, y: current.y },
    ];
    for (const neighbor of neighbors) {
      const key = `${neighbor.x},${neighbor.y}`;
      if (cellSet.has(key) && !visited.has(key)) {
        visited.add(key);
        queue.push(neighbor);
      }
    }
  }

  return visited.size === cellSet.size;
}

/** Null-safe position equality. */
export function positionsEqual(a: Position | null, b: Position | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.x === b.x && a.y === b.y;
}

/**
 * The grid coordinates of the .grid-cell an event landed on, or null when the
 * target is not inside one (or carries malformed data attributes).
 */
export function extractCellPosition(target: EventTarget | null): Position | null {
  if (!(target instanceof HTMLElement)) return null;

  const cell = target.closest(".grid-cell") as HTMLElement;
  if (!cell) return null;

  const x = Number(cell.dataset.x);
  const y = Number(cell.dataset.y);

  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;

  return { x, y };
}
