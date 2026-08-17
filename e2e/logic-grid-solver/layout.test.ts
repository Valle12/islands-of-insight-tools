import { expect, test } from "@playwright/test";
import { gotoIsolated, LOGIC_GRID_URL } from "../coi";

// What a big board does to the page, in a window too small for it and in one
// with room to spare. The grid's tracks are fixed at --logic-cell (renderGrid)
// and the grid itself is flex: none, so the board never gives — either the
// card grows to hold it or #grid-shell scrolls it. The regression the first
// test guards is minmax(0, 1fr) tracks shrinking under the fixed-width
// squares, which OVERLAPPED sideways while the absolutely-positioned outline
// SVG kept its natural size and left a scrollbar into blank space.
test.describe("Board layout", () => {
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

    // The card grew as far as this viewport lets it — 700 less the body's
    // 14px padding a side under the mobile breakpoint — and the board is
    // STILL wider. Stated because the card is no longer pinned at 960px:
    // without it the overflow below would pass for a reason that has nothing
    // to do with the grid.
    const cardWidth = await page
      .locator("#editor-card")
      .evaluate(element => getComputedStyle(element).width);
    expect(cardWidth).toBe("672px");

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

  /**
   * The same wide board in a window with room for it. The squares are fixed at
   * `--logic-cell`, so the only thing that can make the board fit is the card
   * — and a card pinned at 960px put a scrollbar under a board the screen
   * could have shown whole.
   */
  test("a wide board widens the card instead of scrolling the shell", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await gotoIsolated(page, LOGIC_GRID_URL);

    await page.getByRole("spinbutton", { name: "Grid Width" }).fill("21");
    await page.getByRole("spinbutton", { name: "Grid Height" }).fill("5");
    await expect(page.locator("#grid .grid-cell")).toHaveCount(105);

    // 21 squares of 42px with 20 seams of 6px is 1002px of grid, plus the
    // shell's 14px padding and 1px border a side. The card's `width` is a
    // CONTENT box, so its own padding is not in the number.
    const cardWidth = await page
      .locator("#editor-card")
      .evaluate(element => getComputedStyle(element).width);
    expect(cardWidth).toBe("1032px");

    const shell = await page.locator("#grid-shell").evaluate(element => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    // Nothing left to scroll: the shell holds the whole grid.
    expect(shell.scrollWidth - shell.clientWidth).toBeLessThanOrEqual(1);

    // And the page itself did not overflow sideways to pay for it.
    const fits = await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    );
    expect(fits).toBe(true);
  });

  /** A default board leaves the card at its default width, which is what keeps
   * the committed Open Graph frames current. */
  test("a small board leaves the card at its default width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await gotoIsolated(page, LOGIC_GRID_URL);

    const cardWidth = await page
      .locator("#editor-card")
      .evaluate(element => getComputedStyle(element).width);
    expect(cardWidth).toBe("960px");
  });
});
