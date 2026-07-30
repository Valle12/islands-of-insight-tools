import type { RollingBlocksTest, Tile } from "../../util/types";
import { Block } from "./block";

/**
 * Hard ceiling on either grid side and on any block dimension. The C++ engine
 * packs every state as one byte per coordinate/dimension and rolls with
 * `int8_t` arithmetic (`x + dim <= 127` keeps every roll transient in range),
 * and the wasm boundary rejects anything larger with an error the UI would
 * have to surface anyway — better to make it unrepresentable here.
 */
export const MAX_GRID_SIDE = 64;
export const MAX_BLOCK_DIM = 64;

/**
 * Hard ceiling on block count: block ids are `uint8_t` in the solver and 0 is
 * reserved for "no block" in the board's cell assignments.
 */
export const MAX_BLOCKS = 255;

const TILES: ReadonlySet<string> = new Set([
  "regular",
  "mustTouch",
  "goal",
  "unplayable",
]);

export type ConfigParseResult =
  | { ok: true; config: RollingBlocksTest }
  | { ok: false; error: string };

function intInRange(value: unknown, min: number, max: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

/** Returns the first problem with the cells grid, or null when it is valid. */
function cellsError(
  cells: unknown,
  gridWidth: number,
  gridHeight: number,
): string | null {
  if (!Array.isArray(cells) || cells.length !== gridWidth) {
    return `cells must be an array of ${gridWidth} columns.`;
  }
  for (const column of cells) {
    if (!Array.isArray(column) || column.length !== gridHeight) {
      return `Every cells column must have ${gridHeight} entries.`;
    }
    if (!column.every(c => typeof c === "string" && TILES.has(c))) {
      return "Cells may only be regular, mustTouch, goal, or unplayable.";
    }
  }
  return null;
}

type BlockParseResult = { ok: true; block: Block } | { ok: false; error: string };

/**
 * Validates one raw block entry against the grid, marking the footprint in
 * `occupied` so overlapping blocks are caught across calls. Ids are
 * renumbered 1..n on load (the board's invariant), so the file's own ids only
 * need to exist for the fixture format's sake.
 */
function parseBlock(
  value: unknown,
  index: number,
  gridWidth: number,
  gridHeight: number,
  cells: Tile[][],
  occupied: Set<number>,
): BlockParseResult {
  const label = `Block ${index + 1}`;
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: `${label} must be an object.` };
  }
  const b = value as Record<string, unknown>;
  if (
    !intInRange(b.width, 1, MAX_BLOCK_DIM) ||
    !intInRange(b.depth, 1, MAX_BLOCK_DIM) ||
    !intInRange(b.height, 1, MAX_BLOCK_DIM)
  ) {
    return {
      ok: false,
      error: `${label} dimensions must be integers between 1 and ${MAX_BLOCK_DIM}.`,
    };
  }
  if (!Number.isInteger(b.x) || !Number.isInteger(b.y)) {
    return {
      ok: false,
      error: `${label} position must be integer coordinates.`,
    };
  }
  const x = b.x as number;
  const y = b.y as number;
  const width = b.width as number;
  const depth = b.depth as number;
  if (x < 0 || y < 0 || x + width > gridWidth || y + depth > gridHeight) {
    return { ok: false, error: `${label} extends outside the grid.` };
  }
  for (let cx = x; cx < x + width; cx++) {
    for (let cy = y; cy < y + depth; cy++) {
      if (cells[cx]![cy] === "unplayable") {
        return { ok: false, error: `${label} sits on an unplayable cell.` };
      }
      const key = cx + cy * gridWidth;
      if (occupied.has(key)) {
        return { ok: false, error: `${label} overlaps another block.` };
      }
      occupied.add(key);
    }
  }
  return {
    ok: true,
    block: new Block(index + 1, x, y, width, depth, b.height as number),
  };
}

/**
 * Validates an unknown parsed JSON value against the rolling-blocks config
 * (download/fixture) format. Returns the typed config on success, or a
 * human-readable error explaining the first problem found. `turns` (present
 * in some captured fixtures) is ignored — the board only loads the puzzle.
 */
export function validateConfig(data: unknown): ConfigParseResult {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "Config must be a JSON object." };
  }
  const raw = data as Record<string, unknown>;

  if (!intInRange(raw.gridWidth, 1, MAX_GRID_SIDE)) {
    return {
      ok: false,
      error: `gridWidth must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    };
  }
  if (!intInRange(raw.gridHeight, 1, MAX_GRID_SIDE)) {
    return {
      ok: false,
      error: `gridHeight must be an integer between 1 and ${MAX_GRID_SIDE}.`,
    };
  }
  const gridWidth = raw.gridWidth as number;
  const gridHeight = raw.gridHeight as number;

  const cellsProblem = cellsError(raw.cells, gridWidth, gridHeight);
  if (cellsProblem !== null) {
    return { ok: false, error: cellsProblem };
  }
  const cells = raw.cells as Tile[][];

  if (!Array.isArray(raw.blocks)) {
    return { ok: false, error: "blocks must be an array." };
  }
  if (raw.blocks.length > MAX_BLOCKS) {
    return {
      ok: false,
      error: `A config may define at most ${MAX_BLOCKS} blocks.`,
    };
  }

  const blocks: RollingBlocksTest["blocks"] = [];
  const occupied = new Set<number>();
  for (let i = 0; i < raw.blocks.length; i++) {
    const parsed = parseBlock(
      raw.blocks[i],
      i,
      gridWidth,
      gridHeight,
      cells,
      occupied,
    );
    if (!parsed.ok) {
      return parsed;
    }
    blocks.push(parsed.block);
  }

  return {
    ok: true,
    config: { gridWidth, gridHeight, cells, blocks, turns: undefined },
  };
}
