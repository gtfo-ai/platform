/**
 * **One writer for each statistics projection**, as a census over the repository rather than as a
 * sentence in a docblock (WP-41; the shape `human-time-writers.test.ts` established at WP-29).
 *
 * The correctness of both tables rests on every row committing with the `handler_executions` claim
 * that says the projector ran (TD-005): that is what makes a redelivery a no-op and what makes
 * `events/replay.ts` reproduce a live dispatch's rows *exactly*, which is this work package's
 * criterion 5. A second writer anywhere — a fixture helper, a repair script, a backfill in
 * TypeScript — writes rows no replay can reproduce and no claim protects, and the equality would
 * then be false without any test noticing.
 *
 * Which files it reads, and the spellings it cannot see, are the human-time census's — `git
 * ls-files` plus `--others --exclude-standard` (standing rule 85), a regex over file text, blind to
 * SQL assembled from fragments and to a table name in a variable. Migrations are exempt by
 * construction: they are `.sql`, which the source-file filter excludes, and they are run by the
 * schema owner rather than by the application role.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The adapter, and nothing else. Tests are excluded by the file filter below. */
const WRITER_SITES_ALLOWED = new Set(['packages/infrastructure/src/stats/postgres-stats-store.ts']);

const TABLES = ['stats_task_delivery', 'stats_event_daily'] as const;

const sqlWritePattern = (table: string): RegExp =>
  new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+(?:\\w+\\.)?${table}\\b`, 'i');

/** The Drizzle spelling: `.insert(statsEventDaily)` and its two siblings. */
const DRIZZLE_WRITE = /\.(insert|update|delete)\(\s*(statsTaskDelivery|statsEventDaily)\s*\)/;

const SOURCE_FILE = /\.(ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

const gitPaths = (root: string, args: readonly string[]): string[] =>
  execFileSync('git', [...args, '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((path) => SOURCE_FILE.test(path));

const censusFiles = (root: string): string[] => [
  ...gitPaths(root, ['ls-files']),
  ...gitPaths(root, ['ls-files', '--others', '--exclude-standard']),
];

/** The census itself, so the repository and a planted fixture are judged by the same function. */
const writerSites = (root: string, pattern: RegExp): string[] =>
  censusFiles(root).filter((path) => {
    const full = join(root, path);
    return existsSync(full) && pattern.test(readFileSync(full, 'utf8'));
  });

/** A test may read and assert about a table; only production code is held to the one writer. */
const production = (paths: readonly string[]): string[] =>
  paths.filter((path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('test/'));

describe('the census that keeps each statistics projection to one writer', () => {
  const root = new URL('../../../../', import.meta.url).pathname;

  it.each(TABLES)('finds the adapter and no other SQL writer of %s', (table) => {
    const found = production(writerSites(root, sqlWritePattern(table)));
    // A positive anchor: if the pattern stopped matching, the assertion below would be vacuously
    // green (standing rule 10).
    expect(found, table).not.toHaveLength(0);
    expect(found.filter((path) => !WRITER_SITES_ALLOWED.has(path)).sort()).toEqual([]);
  });

  it('finds no write through either Drizzle table', () => {
    // The read side (`apps/server/src/queries/stats-queries.ts`) names both tables and must only
    // ever `select` from them, so this census has **no** allowed site and is asserted empty. Its
    // own anchor is the planted case below, which proves the pattern bites.
    expect(production(writerSites(root, DRIZZLE_WRITE))).toEqual([]);
  });

  it('names a planted writer whether it is tracked or merely untracked, and skips an ignored one', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'stats-census-'));
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: temporary, stdio: 'ignore' });
      };
      git('init', '-q');
      writeFileSync(join(temporary, '.gitignore'), 'ignored.ts\n');
      // Assembled rather than written out: a literal of the matched form would make *this* file a
      // writer site when the cases above read it, which is how the pool census first failed
      // (standing rule 59 — a guard that reads the tree has itself inside its scope).
      const sql = TABLES.map(
        (table) => `await sql.query('insert into ${table} (project_id) values ($1)', [id]);\n`,
      ).join('');
      const drizzle = `await database.${'insert'}(${'statsEventDaily'}).values({});\n`;
      for (const name of ['tracked.ts', 'untracked.ts', 'ignored.ts']) {
        writeFileSync(join(temporary, name), sql + drizzle);
      }
      git('add', 'tracked.ts', '.gitignore');

      for (const table of TABLES) {
        expect(writerSites(temporary, sqlWritePattern(table)).sort(), table).toEqual([
          'tracked.ts',
          'untracked.ts',
        ]);
      }
      expect(writerSites(temporary, DRIZZLE_WRITE).sort()).toEqual(['tracked.ts', 'untracked.ts']);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
