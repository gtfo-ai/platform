/**
 * **Who writes `integrations.config`** — the census the exclusivity sentence on
 * `assertNoCredentialInConfig` points at (WP-68, PROGRESS backlog 130).
 *
 * Two write-time refusals run on the create path and nowhere else: `assertHostIsDeclared` (the
 * egress allow-list, which the executor asks again at call time) and `assertNoCredentialInConfig`
 * (a credential pasted into the column, which **nothing** asks again — a call-time twin was
 * considered and not built, because the write already answers the question and a re-read of every
 * stored config is the dearer closure). Their whole coverage is therefore one claim: *every writer
 * of the column goes through `createIntegration`*. An exclusivity claim is a statement about every
 * other file, so it cannot be kept by the file that makes it (standing rule 63) — it is kept here,
 * in the shape `packages/application/src/pipeline/task-save-sites.test.ts` established: a new
 * writer is a decision somebody makes in this file rather than a line somebody adds elsewhere.
 * The endpoint that would add one is specified and unbuilt (`PATCH /api/integrations/:id`,
 * technical/08), and the client census cannot see it, because no screen calls a PATCH.
 *
 * ## What it reads, and what counts as a writer
 *
 * Every production source git knows about — tracked or untracked, never ignored, through
 * `scripts/census-files.mjs` — outside the test tiers (a fixture that inserts a row with a
 * `config` is setting up a test, not shipping a writer). A **statement** is counted, not a route:
 *
 *  - a Drizzle `.insert(integrations)` or `.update(integrations)` chain, read to the end of its
 *    statement, that names a `config` key (`config:`, or the shorthand — the calibration below
 *    found the first version blind to `set({ config, … })`) — **or** whose `.values(`/`.set(`
 *    argument is not an object literal, or spreads into one, because a dynamically assembled object
 *    cannot be shown *not* to carry the column, and the census counts what it cannot rule out (the
 *    fail-closed direction);
 *  - a raw SQL `insert into integrations` or `update integrations` whose statement names `config`.
 *
 * ## What it cannot see, stated the way the pool census states its own
 *
 *  - **an aliased table** — `integrations` imported under another name, or reached through a
 *    variable (`const table = integrations`);
 *  - **SQL assembled at run time** — a table name interpolated into a `sql` template, a statement
 *    built by concatenation, or a query text that does not spell the table next to its verb;
 *  - **a write from outside the TypeScript sources** — a shell script, a `psql` session, a
 *    migration's data fix (`packages/infrastructure/src/db/migrations/*.sql` is not read), or a
 *    dependency writing the table on the platform's behalf;
 *  - **the test tiers**, excluded on purpose, so a production writer hidden in a `*.test.ts`
 *    would pass.
 *
 * A floor against the accident — somebody writing `PATCH /api/integrations/:id` from technical/08
 * without reading `onboarding-queries.ts` — not a proof.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../../scripts/census-files.mjs';
import { repositoryRoot, withoutComments } from '../routes/web-sources.js';

/** The declared writers of `integrations.config`, with how many statements each holds. One. */
const CONFIG_WRITERS: ReadonlyMap<string, number> = new Map([
  ['apps/server/src/queries/onboarding-queries.ts', 1],
]);

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

const DRIZZLE_STATEMENT = /\.(insert|update)\(\s*integrations\s*\)/g;
const RAW_STATEMENT = /\b(insert\s+into|update)\s+integrations\b/gi;

/** One statement against the table, and whether the census counts it as a `config` writer. */
interface Statement {
  readonly file: string;
  readonly verb: string;
  readonly writesConfig: boolean;
}

/** From `at` to the end of the statement: the first `;` for Drizzle, the closing backtick for SQL. */
const statementFrom = (body: string, at: number, end: string): string => {
  const stop = body.indexOf(end, at);
  return body.slice(at, stop === -1 ? body.length : stop);
};

const statementsIn = (file: string, source: string): Statement[] => {
  const body = withoutComments(source);
  const found: Statement[] = [];
  for (const match of body.matchAll(DRIZZLE_STATEMENT)) {
    const statement = statementFrom(body, match.index, ';');
    const argument = /\.(?:values|set)\(\s*(\S)/.exec(statement)?.[1];
    found.push({
      file,
      verb: match[1] ?? '',
      // `config:`, the shorthand `config,`/`config }`, or anything the census cannot rule out: an
      // argument that is not an object literal, or a spread inside one.
      writesConfig:
        /\bconfig\s*[:,}]/.test(statement) ||
        (argument !== undefined && argument !== '{') ||
        statement.includes('...'),
    });
  }
  for (const match of body.matchAll(RAW_STATEMENT)) {
    const statement = statementFrom(body, match.index, '`');
    found.push({
      file,
      verb: (match[1] ?? '').toLowerCase().replace(/\s+/g, ' '),
      writesConfig: /\bconfig\b/.test(statement),
    });
  }
  return found;
};

const census = (root: string): Statement[] =>
  censusFiles(root, { include: (path) => SOURCE_FILE.test(path) && !isTestTier(path) }).flatMap(
    ({ path, contents }) => statementsIn(path, contents),
  );

const writersOf = (statements: readonly Statement[]): Map<string, number> => {
  const writers = new Map<string, number>();
  for (const statement of statements.filter((each) => each.writesConfig)) {
    writers.set(statement.file, (writers.get(statement.file) ?? 0) + 1);
  }
  return writers;
};

describe('the writers of integrations.config (backlog 130)', () => {
  it('is exactly the declared list, in both directions', () => {
    const statements = census(repositoryRoot);

    // The positive anchor (standing rule 10): the sweep sees the table's statements at all — the
    // create, and `writeIntegrationHealth`, which names `health` alone (standing rule 79) and is
    // therefore a statement against the table that this census must *not* count.
    expect(
      statements.map(({ file, verb, writesConfig }) => `${file} ${verb} ${writesConfig}`),
    ).toEqual(
      expect.arrayContaining([
        'apps/server/src/queries/onboarding-queries.ts insert true',
        'apps/server/src/queries/onboarding-queries.ts update false',
      ]),
    );
    expect([...writersOf(statements)].sort()).toEqual([...CONFIG_WRITERS].sort());
  });

  it('names a planted second writer whether it is tracked or untracked, and skips an ignored one', () => {
    // The calibration (standing rules 42/43): a census nobody has watched fail is a census nobody
    // has watched. Each plant is the control for another — the health-only update is a statement
    // against the table that writes no config, and the ignored file is not a source file.
    const root = mkdtempSync(join(tmpdir(), 'config-writers-'));
    try {
      const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      };
      git('init', '-q');
      const plant = (path: string, source: string): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), source);
      };
      plant('.gitignore', '/apps/ignored.ts\n');
      const patch = [
        'export const patch = (db, id, config) =>',
        '  db.update(integrations).set({ config, updatedAt: new Date() }).where(eq(id));',
        '',
      ].join('\n');
      plant('apps/server/src/routes/patch.ts', patch);
      plant('apps/server/src/routes/untracked-patch.ts', patch);
      plant('apps/ignored.ts', patch);
      plant(
        'apps/dynamic.ts',
        'export const f = (db, changes) => db.update(integrations).set(changes);\n',
      );
      plant(
        'apps/spread.ts',
        'export const g = (db, changes) => db.update(integrations).set({ ...changes });\n',
      );
      plant(
        'apps/raw.ts',
        'export const q = `update integrations set config = $1 where id = $2`;\n',
      );
      // Backlog 269: a `//` inside a string on the line of the call — the line-by-line stripper
      // this file carried until WP-96 cut the line there and never saw the writer.
      plant(
        'apps/after-url.ts',
        "export const u = (db, config) => { const at = 'https://x'; db.update(integrations).set({ config }); };\n",
      );
      plant(
        'apps/health.ts',
        "export const h = (db) => db.update(integrations).set({ health: { status: 'ok' } });\n",
      );
      git('add', '.gitignore', 'apps/server/src/routes/patch.ts');

      expect([...writersOf(census(root)).keys()].sort()).toEqual([
        'apps/after-url.ts',
        'apps/dynamic.ts',
        'apps/raw.ts',
        'apps/server/src/routes/patch.ts',
        'apps/server/src/routes/untracked-patch.ts',
        'apps/spread.ts',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
