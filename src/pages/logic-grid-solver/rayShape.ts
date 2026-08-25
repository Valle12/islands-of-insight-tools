/**
 * A myopia clue's arrows, as ONE SVG path.
 *
 * They were four `md-icon` glyphs turned into place by CSS, and that cannot be
 * made to look right for the same reason `shapeOutline.ts` exists: four glyphs
 * are four independently rasterised objects, and Blink grid-fits each one on
 * its own, so wherever two of them meet at the middle of the tile the joint
 * steps sideways by a fraction of a pixel. Grayscale antialiasing (measured:
 * `opacity`, `will-change`, `isolation`, `-webkit-font-smoothing`) takes the
 * colored fringes off the stems and leaves the seam exactly where it was,
 * which is the same list that file already records as not helping.
 *
 * So the whole set is traced once and filled once. One path, one
 * rasterisation, no seam at any zoom — and the four tails are the same POINT
 * of that path rather than four boxes asked to line up.
 *
 * The arrow itself is Material's `line_start_arrow_notch`, its outline lifted
 * from the shipped SVG rather than redrawn, so the tile and the picker keep
 * the glyph the rest of the page's arrows come from. Being a path now, it also
 * costs the `icon_names` subset in common.css nothing.
 */

/**
 * The arrow's outline, in a frame of its own: pointing UP, 800 units from the
 * origin to the tip, and its tail crossing the origin rather than stopping on
 * it.
 *
 * Material ships it in a `0 -960 960 960` box pointing LEFT, as
 * `M520-200 80-480l440-280-137 240h497v80H383l137 240Z` — the tip at (80,-480),
 * the head's back corners at (520,-200) and (520,-760), the notch at x=383 and
 * the shaft running out to x=880. Mapped here by `(u, v) = (y + 480, x - 880)`,
 * which puts the middle of the tail on the origin and leaves every number a
 * whole one.
 *
 * Whole numbers matter: a direction is a quarter turn, which in this frame is a
 * swap and a negation, so every rotated copy is exact and no two of them can
 * round to different pixels.
 *
 * The tail runs `HALF_SHAFT` PAST the origin rather than stopping on it, and
 * that is what squares off the corner where two arrows meet at right angles.
 * Stopping on it, the up arrow's shaft ends at v = 0 while the right arrow's
 * runs from y = -40 to y = +40, so the union of the two is notched by exactly
 * that 40 — visible as a step in the elbow of an L at any real zoom. Run past,
 * the two bottom edges are flush and the corner is square; four of them fill
 * the middle square outright, so the plus has no notch either. An OPPOSITE
 * pair never had one, the two shafts already meeting edge to edge, which is
 * why up-and-down looked right while up-and-right did not.
 */
const HALF_SHAFT = 40;

const ARROW: readonly (readonly [number, number])[] = [
  [280, -360], //             the head's back corner
  [0, -800], //               the tip
  [-280, -360], //            ...and its other back corner
  [-HALF_SHAFT, -497], //     the notch
  [-HALF_SHAFT, HALF_SHAFT], // the tail, one edge — past the origin, see above
  [HALF_SHAFT, HALF_SHAFT], //  ...and the other
  [HALF_SHAFT, -497], //      the notch's twin
];

/** How far the tip reaches from the tail — see `ARROW`. */
export const RAY_REACH = 800;

/**
 * The box a PLACED set is drawn in: square, and centred on the origin, so the
 * point the tails share is the middle of the tile whatever arrows the clue
 * holds. A single arrow therefore fills half of it, which is the picture the
 * clue means — from here, that way.
 */
export const RAY_VIEW_BOX = `${-RAY_REACH} ${-RAY_REACH} ${RAY_REACH * 2} ${
  RAY_REACH * 2
}`;

/** One direction's copy of `ARROW`: `index` quarter turns clockwise, which is
 * `DIRECTIONS`' own order starting from up. */
function turned(index: number): (readonly [number, number])[] {
  return ARROW.map(([u, v]) => {
    switch (index & 3) {
      case 1:
        return [-v, u] as const; // right
      case 2:
        return [-u, -v] as const; // down
      case 3:
        return [v, -u] as const; // left
      default:
        return [u, v] as const; // up
    }
  });
}

function subpath(points: readonly (readonly [number, number])[]): string {
  const [first, ...rest] = points;
  const moveTo = `M${first![0]} ${first![1]}`;
  return `${moveTo}${rest.map(([x, y]) => `L${x} ${y}`).join("")}Z`;
}

/**
 * The `d` of every arrow the mask names, as subpaths of ONE path.
 *
 * Filled together rather than drawn one at a time: the subpaths overlap at the
 * origin, and a single fill closes over that with nothing to grid-fit against.
 * The default nonzero winding is what makes the overlap solid rather than a
 * hole, and every arrow is wound the same way, so it holds for all fifteen
 * sets.
 */
export function raysPath(mask: number): string {
  let path = "";
  for (let index = 0; index < 4; index++) {
    if ((mask & (1 << index)) !== 0) path += subpath(turned(index));
  }
  return path;
}

/**
 * The box ONE arrow needs, tight to its own outline — the picker's boxes,
 * where an arrow stands alone and should sit in the middle of its button
 * rather than in the half of the tile it would occupy on the board.
 */
export function rayIconViewBox(index: number): string {
  const points = turned(index);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return `${left} ${top} ${Math.max(...xs) - left} ${Math.max(...ys) - top}`;
}
