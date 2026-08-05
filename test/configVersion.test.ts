import { describe, expect, test } from "bun:test";
import {
  configVersion,
  FIRST_CONFIG_VERSION,
  migrateConfig,
  type ConfigMigration,
} from "../src/util/configVersion";

/**
 * The version machinery on its own, driven by migration lists this file makes
 * up.
 *
 * That is the point of testing it here rather than only through a page: no
 * page's format has changed yet, so every list that ships is empty and the
 * chain that runs on a real load is the empty one. A fake chain is the only
 * way to prove the steps run, run in order, and run only the ones a given file
 * still needs — before there is a real migration whose own correctness would
 * be tangled up with the plumbing's.
 */

/** Appends its own name, so a chain records the order it ran in. */
const step = (name: string): ConfigMigration => {
  return data => ({
    ...data,
    trail: [...((data.trail as string[]) ?? []), name],
  });
};

describe("configVersion", () => {
  test("an empty list is the first version", () => {
    expect(configVersion([])).toBe(FIRST_CONFIG_VERSION);
    expect(FIRST_CONFIG_VERSION).toBe(1);
  });

  /** Derived rather than declared, so a migration cannot be added without the
   * version moving — or the version moved without a migration to justify it. */
  test("each migration raises the version by one", () => {
    expect(configVersion([step("a")])).toBe(2);
    expect(configVersion([step("a"), step("b"), step("c")])).toBe(4);
  });
});

describe("migrateConfig", () => {
  describe("reading the tag", () => {
    /** The whole point of the default: every file saved before the tag
     * existed is a first-version file and has to keep loading untouched. */
    test("a file with no version is the first version", () => {
      const result = migrateConfig({ cells: [] }, []);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.from).toBe(1);
      expect(result.data).toEqual({ cells: [] });
    });

    test("an explicit current version is left alone", () => {
      const result = migrateConfig({ version: 1, cells: [] }, []);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.from).toBe(1);
      expect(result.data).toEqual({ version: 1, cells: [] });
    });

    /** Not an object at all: it passes straight through so the page's own
     * "this must be an object" message is the one that reaches the player. */
    test.each([null, 7, "board", [1, 2]])("%p passes through", value => {
      const result = migrateConfig(value, []);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.data).toEqual(value);
      expect(result.from).toBe(1);
    });

    test.each([0, -1, 1.5, "1", null, true])(
      "rejects a version of %p",
      value => {
        const result = migrateConfig({ version: value }, []);
        expect(result.ok).toBeFalse();
        if (result.ok) return;
        expect(result.error).toBe("version must be a positive integer.");
      },
    );

    /**
     * A file from a LATER build. There is nothing to migrate backwards — this
     * build has never heard of whatever that version added — so it says so
     * rather than reading the parts it recognises and dropping the rest.
     */
    test("refuses a file from a newer build", () => {
      const result = migrateConfig({ version: 3 }, [step("a")]);
      expect(result.ok).toBeFalse();
      if (result.ok) return;
      expect(result.error).toBe(
        "This board is saved in format version 3, and this build reads up to " +
          "version 2. Update the page and load it again.",
      );
    });
  });

  describe("running the chain", () => {
    const chain = [step("1to2"), step("2to3"), step("3to4")];

    test("the oldest file runs every step, in order", () => {
      const result = migrateConfig({ cells: [] }, chain);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.from).toBe(1);
      expect(result.data).toEqual({
        cells: [],
        trail: ["1to2", "2to3", "3to4"],
        version: 4,
      });
    });

    /** Indexed by the version it upgrades FROM, so a partly-current file
     * joins the chain part way along rather than starting again. */
    test("a newer file runs only the steps it still needs", () => {
      const result = migrateConfig({ version: 3, cells: [] }, chain);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.from).toBe(3);
      expect(result.data).toEqual({
        cells: [],
        trail: ["3to4"],
        version: 4,
      });
    });

    test("a current file runs nothing", () => {
      const result = migrateConfig({ version: 4, cells: [] }, chain);
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.from).toBe(4);
      expect(result.data).toEqual({ version: 4, cells: [] });
    });

    /** The parsed file belongs to the caller. A migration that edited it in
     * place would leave whoever handed it over holding a different board. */
    test("the file it was given is not changed", () => {
      const original = { version: 1, cells: [] };
      migrateConfig(original, chain);
      expect(original).toEqual({ version: 1, cells: [] });
    });
  });
});
