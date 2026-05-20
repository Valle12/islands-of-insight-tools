import type { Position, ShiftingMosaicTest } from "../../util/types";

export type ConfigParseResult =
  | { ok: true; config: ShiftingMosaicTest }
  | { ok: false; error: string };

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
 * Validates an unknown parsed JSON value against the shifting-mosaic config
 * (download) format. Returns the typed config on success, or a human-readable
 * error explaining the first problem found.
 */
export function validateConfig(data: unknown): ConfigParseResult {
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "Config must be a JSON object." };
  }
  const raw = data as Record<string, unknown>;

  if (!Number.isInteger(raw.gridWidth) || (raw.gridWidth as number) <= 0) {
    return { ok: false, error: "gridWidth must be a positive integer." };
  }
  if (!Number.isInteger(raw.gridHeight) || (raw.gridHeight as number) <= 0) {
    return { ok: false, error: "gridHeight must be a positive integer." };
  }
  const gridWidth = raw.gridWidth as number;
  const gridHeight = raw.gridHeight as number;

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

  // Every block must sit fully inside the grid, and no two blocks may share
  // a cell — the board cannot represent overlapping blocks.
  const occupied = new Set<string>();
  for (let i = 0; i < shapes.length; i++) {
    const anchor = initialAnchors[i]!;
    for (const cell of shapes[i]!) {
      const x = anchor.x + cell.x;
      const y = anchor.y + cell.y;
      if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) {
        return { ok: false, error: `Block ${i + 1} extends outside the grid.` };
      }
      const key = `${x},${y}`;
      if (occupied.has(key)) {
        return { ok: false, error: `Block ${i + 1} overlaps another block.` };
      }
      occupied.add(key);
    }
  }

  // The goal zone must also fit inside the grid.
  for (const cell of shapes[goalIndex]!) {
    const x = goalAnchor.x + cell.x;
    const y = goalAnchor.y + cell.y;
    if (x < 0 || x >= gridWidth || y < 0 || y >= gridHeight) {
      return { ok: false, error: "The goal zone extends outside the grid." };
    }
  }

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
