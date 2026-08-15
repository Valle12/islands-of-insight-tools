import {
  readGridSize,
  type ConfigResult,
  type GridSize,
} from "../../util/configValidation";
import type { Position, ShiftingMosaicTest } from "../../util/types";

/**
 * Hard ceiling on either grid side. The C++ solver packs one grid row into a
 * single `uint64_t` (BitGrid), so 64 columns is a real algorithmic limit —
 * `rows[r] << a.x` is undefined behaviour beyond it and DragSolver's search
 * entry points bail out with an empty plan, which the UI cannot distinguish
 * from "no solution". The wasm boundary additionally narrows the dimensions to
 * `uint8_t` and every coordinate to `int8_t`, so anything past this would be
 * silently truncated into a *different* board.
 */
export const MAX_GRID_SIDE = 64;

/**
 * Hard ceiling on block count: `Turn.blockId` and `goalIndex` are `uint8_t` in
 * the solver, and several of its loops use a `uint8_t` induction variable
 * compared against `shapes_.size()` — which wraps and never terminates at 256.
 */
export const MAX_BLOCKS = 255;

export type ConfigParseResult = ConfigResult<ShiftingMosaicTest>;

function isIntPosition(value: unknown): value is Position {
  if (typeof value !== "object" || value === null) return false;
  const position = value as Record<string, unknown>;
  return (
    Number.isInteger(position.x) && Number.isInteger(position.y)
  );
}

function isPositionArray(value: unknown): value is Position[] {
  return Array.isArray(value) && value.every(isIntPosition);
}

/**
 * Returns the first problem with where the blocks sit, or null.
 *
 * Split out of `validateConfig` rather than inlined: two nested walks over
 * every square of every block are most of that function's branching, and none
 * of it needs anything but the shapes, their anchors and the grid size.
 */
function placementError(
  shapes: Position[][],
  initialAnchors: Position[],
  goalIndex: number,
  goalAnchor: Position,
  size: GridSize,
): string | null {
  const { gridWidth, gridHeight } = size;
  const offBoard = (anchor: Position, cell: Position) => {
    const x = anchor.x + cell.x;
    const y = anchor.y + cell.y;
    return x < 0 || x >= gridWidth || y < 0 || y >= gridHeight;
  };

  // Every block must sit fully inside the grid, and no two blocks may share
  // a cell — the board cannot represent overlapping blocks.
  const occupied = new Set<number>();
  for (let i = 0; i < shapes.length; i++) {
    const anchor = initialAnchors[i]!;
    for (const cell of shapes[i]!) {
      if (offBoard(anchor, cell)) {
        return `Block ${i + 1} extends outside the grid.`;
      }
      const key = anchor.x + cell.x + (anchor.y + cell.y) * gridWidth;
      if (occupied.has(key)) return `Block ${i + 1} overlaps another block.`;
      occupied.add(key);
    }
  }

  // The goal zone must also fit inside the grid.
  for (const cell of shapes[goalIndex]!) {
    if (offBoard(goalAnchor, cell)) {
      return "The goal zone extends outside the grid.";
    }
  }
  return null;
}

/**
 * Validates an unknown parsed JSON value against the shifting-mosaic config
 * (download) format. Returns the typed config on success, or a human-readable
 * error explaining the first problem found.
 */
export function validateConfig(data: unknown): ConfigParseResult {
  // The object check and both dimension bounds come from the shared module,
  // whose messages are part of the download format's contract — this page used
  // to restate all three verbatim, which is exactly how the four pages drift
  // into answering the same malformed upload two different ways.
  const size = readGridSize(data, MAX_GRID_SIDE);
  if (!size.ok) return size;
  const { gridWidth, gridHeight } = size.config;
  const raw = data as Record<string, unknown>;

  if (
    !Array.isArray(raw.shapes) ||
    raw.shapes.length === 0 ||
    !raw.shapes.every(isPositionArray)
  ) {
    return {
      ok: false,
      error: "shapes must be a non-empty array of cell arrays.",
    };
  }
  if (raw.shapes.length > MAX_BLOCKS) {
    return {
      ok: false,
      error: `A config may define at most ${MAX_BLOCKS} blocks.`,
    };
  }
  const shapes = raw.shapes as Position[][];
  if (shapes.some(shape => shape.length === 0)) {
    return { ok: false, error: "Every shape must have at least one cell." };
  }

  if (
    !isPositionArray(raw.initialAnchors) ||
    raw.initialAnchors.length !== shapes.length
  ) {
    return {
      ok: false,
      error: "initialAnchors must provide one anchor per shape.",
    };
  }
  const initialAnchors = raw.initialAnchors;

  if (
    !Number.isInteger(raw.goalIndex) ||
    (raw.goalIndex as number) < 0 ||
    (raw.goalIndex as number) >= shapes.length
  ) {
    return { ok: false, error: "goalIndex is out of range." };
  }
  const goalIndex = raw.goalIndex as number;

  if (!isIntPosition(raw.goalAnchor)) {
    return { ok: false, error: "goalAnchor must be an integer position." };
  }
  const goalAnchor = raw.goalAnchor;

  const placement = placementError(
    shapes,
    initialAnchors,
    goalIndex,
    goalAnchor,
    size.config,
  );
  if (placement !== null) return { ok: false, error: placement };

  return {
    ok: true,
    config: {
      gridWidth,
      gridHeight,
      shapes,
      initialAnchors,
      goalIndex,
      goalAnchor,
    },
  };
}
