/**
 * A migration's **class**, declared in the file's first line (TD-032 decision 1, the TD-011
 * amendment of 2026-11-04, WP-271).
 *
 * Until WP-271 every migration was the same to the migrator: forward-only, applied once, and
 * nothing said whether the build before it could still run on the schema after it. An automatic
 * updater needs exactly that answer, so it is now a property of the file:
 *
 *     -- migration-class: additive
 *     -- migration-class: contract; expands: 0093_run_offers
 *
 * with an optional `; raises-rollback-floor` clause on either (TD-032 decision 2: the change also
 * moves the image's `org.platform.rollback-floor` label, which `migrations:check` holds).
 *
 * - **`additive`** — the previous release's code works on the schema after it and on every row the
 *   new release writes. `migrations:check` holds the file to a statement allow-list
 *   (`migration-scanner.ts`).
 * - **`contract`** — anything else; it names the `additive` migration it completes, which must have
 *   been released by an earlier push.
 *
 * **Which files carry one.** Every file numbered {@link FIRST_CLASSIFIED_MIGRATION} or later must:
 * `loadMigrations` refuses one without it, so a build cannot ship an unclassified migration even if
 * the check was skipped. Files 0001–0091 are applied history — TD-011 freezes them, and editing
 * one to add a header would change the checksum every installed database recorded — so they carry
 * none, and the migrator records their class as `null`, which TD-032 reads as `contract`.
 *
 * The header lives here rather than in `migrator.ts` (WP-271 criterion (1) names the migrator)
 * because `loadMigrations` must parse it and `migrator.ts` imports `migrations.ts`; the migrator is
 * the module that **records** it (`applyMigration`).
 */

/** The two classes TD-032 decision 1 defines. */
export const MIGRATION_CLASSES = ['additive', 'contract'] as const;
export type MigrationClass = (typeof MIGRATION_CLASSES)[number];

/** What a file's header line declares. */
export interface MigrationHeader {
  readonly class: MigrationClass;
  /** The `additive` migration a `contract` completes (`<nnnn>_<name>`); `null` for `additive`. */
  readonly expands: string | null;
  /** Whether the change raises the image's `org.platform.rollback-floor` (TD-032 decision 2). */
  readonly raisesRollbackFloor: boolean;
}

/**
 * The first migration that must declare a class: **0092**, the file that adds
 * `platform_migrations.class` (and is itself `additive`).
 */
export const FIRST_CLASSIFIED_MIGRATION = 92;

/** The grammar, as one line an error message can quote. */
export const MIGRATION_HEADER_GRAMMAR =
  '-- migration-class: additive | -- migration-class: contract; expands: <nnnn>_<name>, optionally followed by "; raises-rollback-floor"';

const HEADER_START = /^--\s*migration-class\b/;
const HEADER =
  /^--\s*migration-class:\s*(additive|contract)\s*(?:;\s*expands:\s*(\d{4}_[a-z0-9_]+)\s*)?(?:;\s*(raises-rollback-floor)\s*)?$/;

/** A header line that is present but does not say what the grammar allows. */
export class MigrationHeaderError extends Error {
  override readonly name = 'MigrationHeaderError';
}

const lines = (sql: string): string[] => sql.split('\n').map((line) => line.replace(/\r$/, ''));

/**
 * The header of a migration's text, or `null` when its first line is not one.
 *
 * Throws {@link MigrationHeaderError} for a first line that starts like a header and does not
 * parse, for an `additive` that names an `expands:`, for a `contract` that names none, and for a
 * header written anywhere but the first line (a reader that skipped it would call the file
 * unclassified, which is the wrong error to give its author).
 */
export const parseMigrationHeader = (sql: string): MigrationHeader | null => {
  const [first = '', ...rest] = lines(sql);
  const misplaced = rest.findIndex((line) => HEADER_START.test(line.trimStart()));
  if (misplaced >= 0) {
    throw new MigrationHeaderError(
      `the migration-class header is on line ${misplaced + 2}; it must be the file's first line (${MIGRATION_HEADER_GRAMMAR})`,
    );
  }
  if (!HEADER_START.test(first)) {
    return null;
  }
  const match = HEADER.exec(first);
  if (match === null) {
    throw new MigrationHeaderError(
      `the first line ${JSON.stringify(first)} is not a valid header; write ${MIGRATION_HEADER_GRAMMAR}`,
    );
  }
  const declared = match[1] as MigrationClass;
  const expands = match[2] ?? null;
  if (declared === 'additive' && expands !== null) {
    throw new MigrationHeaderError(
      `an additive migration expands nothing; "expands: ${expands}" belongs to the contract that completes it`,
    );
  }
  if (declared === 'contract' && expands === null) {
    throw new MigrationHeaderError(
      'a contract migration names the additive migration it completes: "-- migration-class: contract; expands: <nnnn>_<name>"',
    );
  }
  return { class: declared, expands, raisesRollbackFloor: match[3] !== undefined };
};

/** The numeric prefix of a migration name (`0092_x` → 92), or `null` for a name without one. */
export const migrationNumber = (name: string): number | null => {
  const match = /^(\d{4})_/.exec(name);
  return match === null ? null : Number(match[1]);
};

/** Whether a migration of this name must declare a class. */
export const requiresMigrationClass = (name: string): boolean =>
  (migrationNumber(name) ?? 0) >= FIRST_CLASSIFIED_MIGRATION;
