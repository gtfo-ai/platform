/**
 * Loads the hand-written SQL migrations that live next to this file.
 *
 * TD-011 keeps migrations as SQL files because partitions, generated `tsvector` columns, GIN
 * indexes, `REVOKE` statements and the `pgboss` schema are all outside what a schema-diff
 * generator can express. TD-019 makes them forward-only: a file that has been applied is frozen,
 * and the checksum recorded at apply time is what proves it.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Migration {
  /** File name without the extension, e.g. `0003_identity`. Also the primary key of the log. */
  readonly name: string;
  readonly sql: string;
  /** SHA-256 of the file contents, hex. */
  readonly checksum: string;
}

/** `<four digits>_<snake_case name>.sql` — the numeric prefix is the apply order. */
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

export const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * Reads every migration from `directory`, in apply order.
 *
 * Throws when a file name does not match the convention or when two files share a numeric prefix:
 * an ambiguous order would make "which migrations has this database seen" unanswerable.
 */
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
    return { name: fileName.slice(0, -'.sql'.length), sql, checksum: checksumOf(sql) };
  });

  return migrations.sort((a, b) => (a.name < b.name ? -1 : 1));
};
