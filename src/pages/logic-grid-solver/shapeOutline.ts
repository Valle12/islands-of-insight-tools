/**
 * A merged cell's outline, as one SVG path.
 *
 * The squares of a merged cell used to be drawn as one tile by giving each of
 * them borders and bridging the grid gap with a pseudo-element. That cannot be
 * made to look right: the edge is then several independently painted boxes, and
 * Blink snaps each one to the device pixel grid on its own, so at most zoom
 * levels the rim steps sideways by a fraction of a pixel wherever two of them
 * meet. Measured at 100%, 110%, 125%, 150%, 200%, 300% and 500%; only a few
 * ratios happen to come out clean. `contain`, `isolation`, `opacity`,
 * transforms, `z-index` and reshaping the bridge were all measured and none of
 * them help, because none of them makes it ONE painted object.
 *
 * So the shape is traced once and stroked once. One path, one rasterisation,
 * no seams at any zoom.
 *
 * The footprint is the squares, the gap between each pair of shape-mates, and
 * the little square between four of them only where all four belong to the
 * cell — so a 2x2 is solid while an L keeps a clean right angle at its inner
 * corner, which is what the polyomino means.
 */

export interface OutlineGeometry {
  /** Side of one grid square, in px. */
  readonly cell: number;
  /** Space between two squares, in px. */
  readonly gap: number;
  /** Radius on the shape's convex corners. Concave ones stay square. */
  readonly radius: number;
  /**
   * Width of the rim the path will be stroked with.
   *
   * The path is pulled half of it INSIDE the footprint, because an SVG stroke
   * straddles its path while a CSS border sits inside the box — so without this
   * a merged cell's rim would sit half a pixel further out than a plain cell's,
   * and would blur across two device pixels at 100% zoom instead of landing on
   * one.
   */
  readonly stroke: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Point = readonly [number, number];

/**
 * The area a merged cell covers: every square, the gap between each pair of
 * shape-mates, and the little square between four of them where all four are
 * in the shape.
 *
 * That last condition is what keeps an L's inner corner a clean right angle
 * rather than filling in a corner of the square that is NOT part of the cell.
 */
function footprint(
  squares: Set<number>,
  gridWidth: number,
  geometry: OutlineGeometry,
): Rect[] {
  const pitch = geometry.cell + geometry.gap;
  const rects: Rect[] = [];

  for (const square of squares) {
    const cx = square % gridWidth;
    const cy = Math.floor(square / gridWidth);
    const has = (dx: number, dy: number) => {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= gridWidth || ny < 0) return false;
      return squares.has(ny * gridWidth + nx);
    };

    const left = cx * pitch;
    const top = cy * pitch;
    const right = left + geometry.cell;
    const bottom = top + geometry.cell;
    rects.push({ x0: left, y0: top, x1: right, y1: bottom });

    if (has(1, 0))
      rects.push({ x0: right, y0: top, x1: left + pitch, y1: bottom });
    if (has(0, 1))
      rects.push({ x0: left, y0: bottom, x1: right, y1: top + pitch });
    if (has(1, 0) && has(0, 1) && has(1, 1))
      rects.push({ x0: right, y0: bottom, x1: left + pitch, y1: top + pitch });
  }
  return rects;
}

const sortedUnique = (values: number[]) =>
  [...new Set(values)].sort((a, b) => a - b);

/** Whether the compressed cell (i, j) is covered by any of the rectangles. */
function coverage(rects: Rect[], xs: number[], ys: number[]) {
  return (i: number, j: number) => {
    if (i < 0 || i + 1 >= xs.length || j < 0 || j + 1 >= ys.length) return false;
    const mx = (xs[i]! + xs[i + 1]!) / 2;
    const my = (ys[j]! + ys[j + 1]!) / 2;
    return rects.some(r => mx > r.x0 && mx < r.x1 && my > r.y0 && my < r.y1);
  };
}

const cornerKey = (i: number, j: number) => `${i},${j}`;

/**
 * Every boundary segment, as "where it goes next" from each corner it starts
 * at, walking each one with the filled area on its right.
 *
 * One outgoing segment per corner: these are 4-connected polyominoes, so the
 * boundary never pinches to a point and the walk is never ambiguous.
 */
function boundarySteps(
  inside: (i: number, j: number) => boolean,
  columns: number,
  rows: number,
): Map<string, Point> {
  const steps = new Map<string, Point>();
  const add = (from: Point, to: Point) => steps.set(cornerKey(...from), to);
  for (let j = 0; j + 1 < rows; j++) {
    for (let i = 0; i + 1 < columns; i++) {
      if (inside(i, j)) emitCellSteps(add, inside, i, j);
    }
  }
  return steps;
}

/**
 * The boundary segments contributed by one filled cell: a side is on the
 * boundary exactly where the cell across it is outside. Emitted clockwise from
 * the top-left corner, which is what keeps the filled area on each segment's
 * right.
 */
function emitCellSteps(
  add: (from: Point, to: Point) => void,
  inside: (i: number, j: number) => boolean,
  i: number,
  j: number,
) {
  if (!inside(i, j - 1)) add([i, j], [i + 1, j]);
  if (!inside(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
  if (!inside(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
  if (!inside(i - 1, j)) add([i, j + 1], [i, j]);
}

/** Follows the segments round into closed loops, in real coordinates. */
function walkLoops(
  steps: Map<string, Point>,
  xs: number[],
  ys: number[],
): Point[][] {
  const loops: Point[][] = [];
  const seen = new Set<string>();
  for (const start of steps.keys()) {
    if (seen.has(start)) continue;
    const loop: Point[] = [];
    let at = start;
    while (!seen.has(at)) {
      seen.add(at);
      const [i, j] = at.split(",").map(Number) as [number, number];
      loop.push([xs[i]!, ys[j]!]);
      const step = steps.get(at);
      if (!step) break;
      at = cornerKey(...step);
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/**
 * Walks the boundary of a union of rectangles into closed loops of corner
 * points, going round each one with the filled area on its right.
 *
 * On a grid of every x and y the rectangles use, rather than on a lattice of
 * fixed steps: the cell size changes with the viewport, so no fixed step
 * divides every coordinate.
 */
function traceLoops(rects: Rect[]): Point[][] {
  const xs = sortedUnique(rects.flatMap(r => [r.x0, r.x1]));
  const ys = sortedUnique(rects.flatMap(r => [r.y0, r.y1]));
  const steps = boundarySteps(coverage(rects, xs, ys), xs.length, ys.length);
  return walkLoops(steps, xs, ys);
}

/** Drops the middle of every straight run, so only real corners are left. */
function corners(loop: Point[]): Point[] {
  const kept: Point[] = [];
  for (let i = 0; i < loop.length; i++) {
    const before = loop[(i - 1 + loop.length) % loop.length]!;
    const here = loop[i]!;
    const after = loop[(i + 1) % loop.length]!;
    const turns =
      (here[0] - before[0]) * (after[1] - here[1]) !==
      (here[1] - before[1]) * (after[0] - here[0]);
    if (turns) kept.push(here);
  }
  return kept;
}

/** Every edge moved `amount` towards the filled area, corners re-cut to match. */
function inset(points: Point[], amount: number): Point[] {
  if (amount === 0) return points;
  return points.map((here, i) => {
    const before = points[(i - 1 + points.length) % points.length]!;
    const after = points[(i + 1) % points.length]!;
    const normal = (from: Point, to: Point): Point => {
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      // The filled area is on the right of the walk, so that is "inwards".
      return [-(to[1] - from[1]) / length, (to[0] - from[0]) / length];
    };
    const a = normal(before, here);
    const b = normal(here, after);
    return [
      here[0] + (a[0] + b[0]) * amount,
      here[1] + (a[1] + b[1]) * amount,
    ] as const;
  });
}

/**
 * One loop as path commands, rounding the corners the filled area turns AROUND
 * and leaving the ones it turns into square — which is what the squares' own
 * border radius used to do.
 */
function loopPath(loop: Point[], geometry: OutlineGeometry): string {
  const radius = Math.max(0, geometry.radius - geometry.stroke / 2);
  const points = inset(corners(loop), geometry.stroke / 2);
  if (points.length < 3) return "";
  const parts: string[] = [];

  for (let i = 0; i < points.length; i++) {
    const before = points[(i - 1 + points.length) % points.length]!;
    const here = points[i]!;
    const after = points[(i + 1) % points.length]!;

    const inLength = Math.hypot(here[0] - before[0], here[1] - before[1]);
    const outLength = Math.hypot(after[0] - here[0], after[1] - here[1]);
    const dIn = [
      (here[0] - before[0]) / inLength,
      (here[1] - before[1]) / inLength,
    ] as const;
    const dOut = [
      (after[0] - here[0]) / outLength,
      (after[1] - here[1]) / outLength,
    ] as const;

    // With the filled area on the right, a right turn is a corner it wraps
    // around — convex, and the one to round.
    const cross = dIn[0] * dOut[1] - dIn[1] * dOut[0];
    const r =
      cross > 0 ? Math.min(radius, inLength / 2, outLength / 2) : 0;

    const from = [here[0] - dIn[0] * r, here[1] - dIn[1] * r] as const;
    const to = [here[0] + dOut[0] * r, here[1] + dOut[1] * r] as const;

    parts.push(`${i === 0 ? "M" : "L"}${round(from[0])} ${round(from[1])}`);
    if (r > 0) {
      parts.push(`A${round(r)} ${round(r)} 0 0 1 ${round(to[0])} ${round(to[1])}`);
    }
  }
  parts.push("Z");
  return parts.join(" ");
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The whole outline of one merged cell — its outer edge and any hole in it —
 * as a single path. Coordinates are px from the grid's top-left corner.
 */
export function outlinePath(
  squares: readonly number[],
  gridWidth: number,
  geometry: OutlineGeometry,
): string {
  const rects = footprint(new Set(squares), gridWidth, geometry);
  return traceLoops(rects)
    .map(loop => loopPath(loop, geometry))
    .filter(Boolean)
    .join(" ");
}
