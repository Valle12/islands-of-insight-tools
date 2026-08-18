/**
 * The config format's VERSION tag, and how a file written by an older build is
 * read by a newer one.
 *
 * A download carries `"version": N` as its FIRST key. A file without one is
 * version 1 — the format as it stood before the tag existed — so every config
 * ever saved goes on loading with no special case at any call site, and no
 * migration is needed to reach the version the tag was introduced in.
 *
 * When the format changes, three things move together:
 *
 * 1. a migration from the old shape to the new one is **appended** to the
 *    page's list, which is what raises `configVersion` by one;
 * 2. the committed fixtures are rewritten in the same change, so the native
 *    tools — which read only this repo's own files — never meet an old one;
 * 3. the page tells anyone who loads an older file to download it again.
 *
 * **The list is append-only, and addressed by position.** Entry 0 turns a
 * version 1 file into a version 2 one, entry 1 turns 2 into 3, and a version 1
 * file on a version 4 build runs all three in order. Reordering or removing an
 * entry re-reads every file ever saved, for exactly the reason the rule and
 * clue catalogs may only be appended to.
 *
 * Deriving the current version from the list's LENGTH rather than declaring it
 * separately is deliberate: a bump with no migration would leave old files
 * unreadable, and a migration with no bump would never run. A change that needs
 * neither is an OPTIONAL key — which is how `shapes`, `direction` and `seat`
 * all arrived, with no version bump between them.
 */

/**
 * What a file with no `version` key is. It is also the lowest a tag may name:
 * there is no version 0, so a file claiming one is malformed rather than
 * ancient.
 */
export const FIRST_CONFIG_VERSION = 1;

/**
 * One step up the chain: the whole config as the previous version stored it,
 * in, and as the next version stores it, out.
 *
 * A migration must RETURN a new object rather than edit the one it was given —
 * the caller's parsed file is not this function's to change — and must not
 * assume the input is valid beyond the shape its own version guarantees, since
 * validation runs after the whole chain rather than between its steps.
 */
export type ConfigMigration = (
  data: Record<string, unknown>,
) => Record<string, unknown>;

export type MigrationResult =
  /** `from` is the version the file was written in, `data` the current shape. */
  | { ok: true; data: unknown; from: number }
  | { ok: false; error: string };

/** The version a build with these migrations reads and writes. */
export function configVersion(migrations: readonly ConfigMigration[]): number {
  return FIRST_CONFIG_VERSION + migrations.length;
}

/**
 * Brings a parsed config up to the current version, or explains why it cannot
 * be read at all.
 *
 * Runs BEFORE any validation, since a migration is exactly what makes an old
 * file's shape make sense to the current validator. Anything that is not an
 * object passes straight through as the first version, so the page's own "this
 * must be an object" message is what the user sees rather than one from here.
 */
export function migrateConfig(
  data: unknown,
  migrations: readonly ConfigMigration[],
): MigrationResult {
  const current = configVersion(migrations);
  if (typeof data !== "object" || data === null) {
    return { ok: true, data, from: FIRST_CONFIG_VERSION };
  }

  const raw = data as Record<string, unknown>;
  const tag = raw.version;
  if (tag !== undefined && !isVersion(tag)) {
    return { ok: false, error: "version must be a positive integer." };
  }
  const from = tag === undefined ? FIRST_CONFIG_VERSION : (tag as number);

  // A file from a LATER build. There is no migration backwards — this build
  // has never heard of whatever that version added — so it is refused by name
  // rather than read as though the unknown parts were not there.
  if (from > current) {
    return {
      ok: false,
      error:
        `This board is saved in format version ${from}, and this build reads ` +
        `up to version ${current}. Update the page and load it again.`,
    };
  }

  // The copy is made only when there is a chain to run, so the common path —
  // a current file, which is every file until the format first changes — pays
  // nothing for it.
  if (from === current) return { ok: true, data: raw, from };

  let migrated: Record<string, unknown> = { ...raw };
  for (let version = from; version < current; version++) {
    migrated = migrations[version - FIRST_CONFIG_VERSION]!(migrated);
  }
  return { ok: true, data: { ...migrated, version: current }, from };
}

function isVersion(tag: unknown): boolean {
  return Number.isInteger(tag) && (tag as number) >= FIRST_CONFIG_VERSION;
}
