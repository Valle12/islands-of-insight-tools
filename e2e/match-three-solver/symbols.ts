import type { Page } from "@playwright/test";

export interface PageSymbol {
  readonly id: string;
  readonly label: string;
}

/**
 * The symbols the page offers, read off its own chip row rather than imported.
 * `src/pages/match-three-solver/symbols.ts` imports PNGs, which Playwright's
 * loader cannot resolve — and reading them here means appending a symbol never
 * needs an edit in this suite.
 */
export async function pageSymbols(page: Page): Promise<PageSymbol[]> {
  // `[data-symbol-index]` excludes the blockade, which leads the same row but
  // paints a structural value rather than a symbol.
  return page
    .locator("#symbol-row .symbol-chip[data-symbol-index]")
    .evaluateAll(chips =>
      chips.map(chip => ({
        id: (chip as HTMLElement).dataset.symbol ?? "",
        // The chip shows the tile alone, so its name is the accessible one.
        label: chip.getAttribute("aria-label") ?? "",
      })),
    );
}

/** The highest cell value a config may carry: empty, blocked, then a symbol each. */
export async function maxCellValue(page: Page): Promise<number> {
  return (await pageSymbols(page)).length + 1;
}
