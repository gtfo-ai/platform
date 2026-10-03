/**
 * `projects.maintenance_last_blocker` has **one** writer — read off disk (WP-113, Q111 (c),
 * migration 0069).
 *
 * The column is what makes a pause at Observe a *transition*: the nightly pass compares its blocker
 * with the stored one and announces a change once. A second writer — a settings write that cleared
 * it, a backfill that set it — would announce a pause nobody began or swallow one somebody did, and
 * nothing in the unit tier would notice, because the scheduler reads the column through a port. So
 * the single writer is checked rather than described (standing rule 44), the shape
 * `pipeline/tasks-column-ownership.test.ts` gives `tasks`. Since WP-129 `projects` has a
 * whole-table census too (`db/projects-column-ownership.test.ts`), and this file is its **stricter
 * half** for this one column: it counts any assignment to the column anywhere in code (a `where`
 * that compares included) and any insert that names it, where the whole-table census reads `set`
 * clauses and lists insert sites by file. It stays here because migration 0069 cites it by path.
 *
 * ## What it reads
 *
 * Every `.ts` and `.sql` file git knows about, tracked or untracked (`scripts/census-files.mjs`,
 * rule 85), **except test files**, which seed and refuse rows on purpose — the integration case
 * that proves the check constraint writes an unknown value, and must. TypeScript is read through the
 * repository's one comment stripper (`scripts/source-scanner.mjs`), so a docblock naming the column
 * is not a writer; SQL drops its `--` lines. A writer is any of three spellings:
 *
 *  - an assignment `maintenance_last_blocker = …` (an `update … set`, and — fail closed — a `where`
 *    that compares with `=`, which no reader here does);
 *  - Drizzle's `maintenanceLastBlocker:` key, other than the column's own definition in the schema;
 *  - an `insert into projects (…)` whose column list names it.
 *
 * ## What it cannot see
 *
 * A statement whose column name is built at runtime (concatenation, `sql.identifier`), and a writer
 * outside this repository (an operator's `psql`). The same two holes the `tasks` census states.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CensusUnreadableError,
  censusPaths,
  readCensus,
} from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

const TEST_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The column's definition in the Drizzle schema — a declaration, not a write. */
const SCHEMA_DEFINITION = /maintenanceLastBlocker:\s*text\(/g;

const WRITES: readonly RegExp[] = [
  /maintenance_last_blocker\s*=(?!=)/g,
  /maintenanceLastBlocker\s*:/g,
  /insert\s+into\s+projects\s*\([^)]*maintenance_last_blocker/gi,
];

/** Comment-free text: the shared stripper for TypeScript, `--` lines dropped for SQL. */
const codeOf = (file: string, contents: string): string =>
  file.endsWith('.sql')
    ? contents
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
    : withoutComments(contents);

/** Every write of the column in one file's code, by spelling. */
const writesIn = (file: string, contents: string): string[] => {
  const code = codeOf(file, contents).replace(SCHEMA_DEFINITION, '');
  return WRITES.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[0]));
};

const writers = (): { readonly file: string; readonly writes: readonly string[] }[] => {
  const paths = censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.sql'] }).filter(
    (file) => !TEST_SOURCE.test(file),
  );
  const { files, unreadable } = readCensus(REPO_ROOT, paths);
  if (unreadable.length > 0) {
    throw new CensusUnreadableError(unreadable);
  }
  return files
    .map(({ path: file, contents }) => ({ file, writes: writesIn(file, contents) }))
    .filter((entry) => entry.writes.length > 0);
};

describe('`projects.maintenance_last_blocker` has one writer (WP-113)', () => {
  it('is written by the blocker store’s compare-and-set and by nothing else', () => {
    expect(writers()).toEqual([
      {
        file: 'packages/infrastructure/src/maintenance/postgres-maintenance-blocker-store.ts',
        writes: ['maintenance_last_blocker ='],
      },
    ]);
  });

  it('sees every spelling of a write, and not a comment, a read or the schema’s definition', () => {
    // Calibration (standing rule 21): each spelling planted alone is found…
    expect(
      writesIn('a.ts', "await sql.query('update projects set maintenance_last_blocker = null');"),
    ).toHaveLength(1);
    expect(
      writesIn('a.ts', 'await db.update(projects).set({ maintenanceLastBlocker: null });'),
    ).toHaveLength(1);
    expect(
      writesIn(
        'a.sql',
        "insert into projects (org_id, key, maintenance_last_blocker) values (1, 'k', null);",
      ),
    ).toHaveLength(1);
    expect(
      writesIn('a.sql', "update projects set maintenance_last_blocker = 'feature_disabled';"),
    ).toHaveLength(1);
    // …and none of what is not one.
    expect(
      writesIn('a.ts', '/** `update projects set maintenance_last_blocker = $3` */\nconst x = 1;'),
    ).toEqual([]);
    expect(writesIn('a.ts', '// maintenance_last_blocker = null\n')).toEqual([]);
    expect(writesIn('a.sql', '-- set maintenance_last_blocker = null\nselect 1;')).toEqual([]);
    expect(
      writesIn('a.ts', "'select maintenance_last_blocker as blocker from projects where id = $1'"),
    ).toEqual([]);
    expect(writesIn('a.ts', "maintenanceLastBlocker: text('maintenance_last_blocker'),")).toEqual(
      [],
    );
  });
});
