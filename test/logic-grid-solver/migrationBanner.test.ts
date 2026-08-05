import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LogicGridTest } from "../../src/util/types";
import { MARKUP } from "./markup";

/**
 * The banner a player sees when the file they loaded was written in an older
 * format version.
 *
 * It cannot be reached through a real load: this page's migration list is
 * empty, so no file is ever old, which is exactly the state the mechanism has
 * to be built in and exactly why it would otherwise ship untested. The
 * validator is therefore stubbed to answer the way it will once the format
 * first changes — the one thing under test here is what the PAGE does with
 * `migratedFrom`, and `configVersion.test.ts` covers how that number is
 * arrived at.
 *
 * Its own file because `mock.module` replaces the module for the whole suite,
 * and the rest of the editor's tests need the real validator.
 */

const MIGRATED_FROM = 1;
const CURRENT = 2;

const board: LogicGridTest = {
  version: CURRENT,
  gridWidth: 1,
  gridHeight: 1,
  rules: [],
  cells: [[0]],
  symbols: [],
};

/** Answers as it will when the format has changed once and an old file
 * arrives. `MAX_GRID_SIDE` is re-stated because the page reads it too. */
mock.module("../../src/pages/logic-grid-solver/config", () => ({
  MAX_GRID_SIDE: 32,
  SOLVE_BUDGET_MS: 120_000,
  CONFIG_VERSION: CURRENT,
  validateConfig: () => ({
    ok: true,
    config: board,
    migratedFrom: MIGRATED_FROM,
  }),
}));

const { LogicGridSolverEditor } = await import(
  "../../src/pages/logic-grid-solver/logicGridSolver"
);

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("An out-of-date file", () => {
  beforeEach(() => {
    document.body.innerHTML = MARKUP;
    const dialog = document.getElementById("reset-dialog")!;
    Object.assign(dialog, { show() {}, close() {} });
    new LogicGridSolverEditor();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function upload() {
    const input = document.getElementById(
      "config-file-input",
    ) as HTMLInputElement;
    const file = new File([JSON.stringify(board)], "logicGridTest.json", {
      type: "application/json",
    });
    Object.defineProperty(input, "files", { value: [file], writable: true });
    input.dispatchEvent(new Event("change"));
    await flush();
  }

  /** The board is on screen either way: an old file is read in full, and it is
   * the copy on DISK the player is being told about. */
  test("loads, and says the file should be downloaded again", async () => {
    await upload();

    const banner = document.getElementById("warning-banner")!;
    expect(banner.classList.contains("hidden")).toBeFalse();
    expect(banner.textContent).toBe(
      `This board was saved in format version ${MIGRATED_FROM} and has been ` +
        `updated to version ${CURRENT}. Download it again to save the file ` +
        `in the current format.`,
    );
    expect(document.querySelectorAll("#grid .grid-cell")).toHaveLength(1);
  });
});
