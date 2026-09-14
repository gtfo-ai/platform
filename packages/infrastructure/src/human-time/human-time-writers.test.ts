/**
 * **One writer**, as a census over the repository rather than as a sentence in a docblock (WP-29's
 * acceptance criterion 1).
 *
 * `human_time_entries` had a schema from migration 0007 and **no writer at all** until this work
 * package. The day a table gets its first writer is the cheapest day to fix how many it has: the
 * projection's correctness rests on every row committing with the `handler_executions` claim that
 * says the projector ran (TD-005), and a second writer anywhere — a migration backfill in
 * TypeScript, a fixture helper, a "just this once" repair script — writes rows no replay can
 * reproduce and no claim protects. The shape is `tasks-column-ownership.test.ts`'s, one table over.
 *
 * ## Which files it reads
 *
 * `git ls-files` **and** `git ls-files --others --exclude-standard` — the tracked set plus the
 * untracked-but-not-ignored one, because a guard that reads only the tracked set is blind to the
 * file somebody is writing right now, which is exactly the file a new mistake is in (standing rule
 * 85, earned by the pool census on its first day).
 *
 * ## The spellings it catches, and the ones it cannot
 *
 * It is a regex over file text: an `insert into`, an `update` or a `delete from` followed by the
 * table's name, in any case and across one line break. What it does **not** see:
 *
 *  - **SQL assembled from fragments** — a table name in a variable, a template placeholder, or a
 *    name built by concatenation;
 *  - **a write through a query builder** — `database.insert(humanTimeEntries)`, which names the
 *    Drizzle export rather than the table. That spelling is covered by the *second* case below,
 *    which censuses the Drizzle table's write methods separately;
 *  - **a write from outside this repository** — a migration file is exempt by construction (it is
 *    SQL the schema owner runs), and a psql session is not a source file.
 *
 * It is a floor against the accident — somebody copying a nearby line — and not a proof.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The adapter, and nothing else. Tests are excluded by the file filter below. */
const WRITER_SITES_ALLOWED = new Set([
  'packages/infrastructure/src/human-time/postgres-human-time-store.ts',
]);

const TABLE = 'human_time_entries';

/** `insert into … human_time_entries`, `update human_time_entries`, `delete from …` — any case. */
const SQL_WRITE = new RegExp(
  `(insert\\s+into|update|delete\\s+from)\\s+(?:\\w+\\.)?${TABLE}\\b`,
  'i',
);

/** The Drizzle spelling: `.insert(humanTimeEntries)`, `.update(...)`, `.delete(...)`. */
const DRIZZLE_WRITE = /\.(insert|update|delete)\(\s*humanTimeEntries\s*\)/;

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
    // A path can disappear between `ls-files` and here; a census that crashed on that is a census
    // people switch off.
    return existsSync(full) && pattern.test(readFileSync(full, 'utf8'));
  });

/** A test may read and assert about the table; only production code is held to the one writer. */
const production = (paths: readonly string[]): string[] =>
  paths.filter((path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path) && !path.startsWith('test/'));

describe('the census that keeps human_time_entries to one writer', () => {
  const root = new URL('../../../../', import.meta.url).pathname;

  it('finds the projection’s adapter and no other SQL writer', () => {
    const found = production(writerSites(root, SQL_WRITE));
    // A positive anchor: if the pattern stopped matching, the assertion below would be vacuously
    // green (standing rule 10).
    expect(found).not.toHaveLength(0);
    expect(found.filter((path) => !WRITER_SITES_ALLOWED.has(path)).sort()).toEqual([]);
  });

  it('finds no write through the Drizzle table either', () => {
    // The read side (`apps/server/src/queries/pipeline-queries.ts`) names `humanTimeEntries` and
    // must only ever `select` from it, so this census has **no** allowed site and is asserted empty.
    // Its own anchor is the planted case below, which proves the pattern bites.
    expect(production(writerSites(root, DRIZZLE_WRITE))).toEqual([]);
  });

  it('names a planted writer whether it is tracked or merely untracked, and skips an ignored one', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'human-time-census-'));
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: temporary, stdio: 'ignore' });
      };
      git('init', '-q');
      writeFileSync(join(temporary, '.gitignore'), 'ignored.ts\n');
      // Assembled rather than written out: a literal of the matched form would make *this* file a
      // writer site when the cases above read it, which is how the pool census first failed (rule 59).
      const sql = `await sql.query('insert into ${TABLE} (task_id) values ($1)', [id]);\n`;
      const drizzle = `await database.${'insert'}(${'humanTimeEntries'}).values({});\n`;
      for (const name of ['tracked.ts', 'untracked.ts', 'ignored.ts']) {
        writeFileSync(join(temporary, name), sql + drizzle);
      }
      git('add', 'tracked.ts', '.gitignore');

      expect(writerSites(temporary, SQL_WRITE).sort()).toEqual(['tracked.ts', 'untracked.ts']);
      expect(writerSites(temporary, DRIZZLE_WRITE).sort()).toEqual(['tracked.ts', 'untracked.ts']);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
