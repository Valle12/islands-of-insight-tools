/**
 * The one number the stylesheet cannot work out for itself: how many columns
 * the board has.
 *
 * `#editor-card` sizes itself from it, so a wide board widens the card instead
 * of reaching straight for `#grid-shell`'s scrollbar — see the `width` rule in
 * `logicGridSolver.css`. The arithmetic stays in CSS rather than here on
 * purpose: it needs `--logic-cell` and `--logic-seam`, and the mobile
 * breakpoint moves the first of them, so a pixel width computed in TypeScript
 * would have to spell both tokens a second time and re-run on every resize.
 *
 * Written on the ROOT, not on `#grid`: custom properties inherit downwards and
 * `#editor-card` is the grid's ancestor, so a property set on the grid could
 * never reach it. The root is already where the other two live.
 */
export function setGridColumns(columns: number) {
  document.documentElement.style.setProperty(
    "--logic-columns",
    String(columns),
  );
}
