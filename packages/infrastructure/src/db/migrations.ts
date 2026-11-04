/**
 * Loads the hand-written SQL migrations that live next to this file.
 *
 * TD-011 keeps migrations as SQL files because partitions, generated `tsvector` columns, GIN
 * indexes, `REVOKE` statements and the `pgboss` schema are all outside what a schema-diff
 * generator can express. TD-019 makes them forward-only: a file that has been applied is frozen,
 * and the checksum recorded at apply time is what proves it.
 *
 * Since WP-271 (TD-032 decision 1) every file numbered 0092 or later also **declares its class** in
 * its first line, and this loader refuses one that does not — so an unclassified migration fails
 * every tier that loads the migrations, not only `migrations:check`. The grammar and the reason the
 * files before 0092 carry none are `migration-class.ts`'s docblock.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATION_HEADER_GRAMMAR,
  type MigrationHeader,
  parseMigrationHeader,
  requiresMigrationClass,
} from './migration-class.js';

export interface Migration {
  /** File name without the extension, e.g. `0003_identity`. Also the primary key of the log. */
  readonly name: string;
  readonly sql: string;
  /** SHA-256 of the file contents, hex. */
  readonly checksum: string;
  /**
   * The class the file declares (TD-032 decision 1), or `null` for a file before 0092, which
   * declares none. The migrator records `header.class` in `platform_migrations.class`.
   */
  readonly header: MigrationHeader | null;
}

/** `<four digits>_<snake_case name>.sql` — the numeric prefix is the apply order. */
export const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

export const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * Reads every migration from `directory`, in apply order.
 *
 * Throws when a file name does not match the convention or when two files share a numeric prefix:
 * an ambiguous order would make "which migrations has this database seen" unanswerable. Throws too
 * when a file's header is malformed, or a file numbered 0092 or later has none (WP-271).
 */
const readHeader = (name: string, sql: string): MigrationHeader | null => {
  let header: MigrationHeader | null;
  try {
    header = parseMigrationHeader(sql);
  } catch (error) {
    throw new Error(`migration ${name}: ${(error as Error).message}`, { cause: error });
  }
  if (header === null && requiresMigrationClass(name)) {
    throw new Error(
      `migration ${name} declares no class; every migration from 0092 on opens with ${MIGRATION_HEADER_GRAMMAR} (TD-032 decision 1)`,
    );
  }
  return header;
};

export const loadMigrations = (directory: string = migrationsDirectory): Migration[] => {
  const names = readdirSync(directory).filter((entry) => entry.endsWith('.sql'));
  const seenPrefixes = new Map<string, string>();

  const migrations = names.map((fileName) => {
    const match = MIGRATION_FILE.exec(fileName);
    if (match === null) {
      throw new Error(
        `migration file ${fileName} does not match <nnnn>_<snake_case>.sql; rename it or move it out of ${directory}`,
      );
    }
    const prefix = match[1] as string;
    const previous = seenPrefixes.get(prefix);
    if (previous !== undefined) {
      throw new Error(`migrations ${previous} and ${fileName} share the prefix ${prefix}`);
    }
    seenPrefixes.set(prefix, fileName);

    const sql = readFileSync(join(directory, fileName), 'utf8');
    const name = fileName.slice(0, -'.sql'.length);
    return { name, sql, checksum: checksumOf(sql), header: readHeader(name, sql) };
  });

  return migrations.sort((a, b) => (a.name < b.name ? -1 : 1));
};
