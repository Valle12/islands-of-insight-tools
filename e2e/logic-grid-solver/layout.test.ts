import { expect, test } from "@playwright/test";
import { gotoIsolated, LOGIC_GRID_URL } from "../coi";

// A big board in a narrow window. The grid's tracks are fixed at --logic-cell
// (renderGrid), the grid itself is flex: none, and #grid-shell scrolls — the
// regression here was minmax(0, 1fr) tracks shrinking under the fixed-width
// squares, which OVERLAPPED sideways while the absolutely-positioned outline
// SVG kept its natural size and left a scrollbar into blank space.
test.describe("Narrow-viewport layout", () => {
  test("a wide board keeps its cell pitch and scrolls instead of overlapping", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 900 });
    await gotoIsolated(page, LOGIC_GRID_URL);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("21");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("5");
    await expect(page.locator("#grid .grid-cell")).toHaveCount(105);

    const measured = await page.evaluate(() => {
      const grid = document.getElementById("grid")!;
      const shell = document.getElementById("grid-shell")!;
      const style = getComputedStyle(document.documentElement);
      const cell = Number.parseFloat(style.getPropertyValue("--logic-cell"));
      const seam = Number.parseFloat(
        getComputedStyle(grid).columnGap || style.getPropertyValue("--logic-seam"),
      );
      const first = grid.querySelector<HTMLElement>(
        '.grid-cell[data-x="0"][data-y="0"]',
      )!;
      const second = grid.querySelector<HTMLElement>(
        '.grid-cell[data-x="1"][data-y="0"]',
      )!;
      const svg = grid.querySelector<SVGSVGElement>(".shape-outline")!;
      return {
        cell,
        seam,
        pitch:
          second.getBoundingClientRect().left -
          first.getBoundingClientRect().left,
        gridWidth: grid.getBoundingClientRect().width,
        svgWidth: Number(svg.getAttribute("width")),
        shellScrollWidth: shell.scrollWidth,
        shellClientWidth: shell.clientWidth,
        shellPaddingLeft: Number.parseFloat(getComputedStyle(shell).paddingLeft),
        shellPaddingRight: Number.parseFloat(
          getComputedStyle(shell).paddingRight,
        ),
      };
    });

    // The board really overflows the shell — otherwise this asserts nothing.
    expect(measured.gridWidth).toBeGreaterThan(measured.shellClientWidth);
    // No overlap: neighbouring squares sit exactly one cell plus one seam
    // apart, whatever the viewport.
    expect(measured.pitch).toBeCloseTo(measured.cell + measured.seam, 1);
    // No blank tail: the scrollable extent is the grid plus the shell's own
    // padding, and the outline SVG agrees with the grid about the width.
    expect(measured.shellScrollWidth).toBeCloseTo(
      measured.gridWidth + measured.shellPaddingLeft + measured.shellPaddingRight,
      0,
    );
    expect(measured.svgWidth).toBeCloseTo(measured.gridWidth, 0);

    // The first column stays reachable: `safe center` aligns overflow to the
    // start, so scrolling all the way left really shows column 0.
    await page.evaluate(() => {
      document.getElementById("grid-shell")!.scrollLeft = 0;
    });
    const firstVisible = await page.evaluate(() => {
      const shell = document.getElementById("grid-shell")!;
      const first = document.querySelector<HTMLElement>(
        '#grid .grid-cell[data-x="0"][data-y="0"]',
      )!;
      return (
        first.getBoundingClientRect().left >=
        shell.getBoundingClientRect().left
      );
    });
    expect(firstVisible).toBe(true);
  });
});
