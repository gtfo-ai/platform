import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkDataModel,
  DATA_MODEL_PAGE,
  dataModelProblems,
  describedTables,
  entryTables,
  MIGRATIONS_DIRECTORY,
  MIGRATOR_SOURCE,
  migratorDdl,
  SPECIFIED_NOT_CREATED,
  tablesCreated,
  UNDOCUMENTED_TABLES,
  withoutCommentsAndLiterals,
} from './check-data-model.mjs';

/**
 * `check-data-model.mjs` (WP-97, PROGRESS backlog 124) — its parser, its comparison, and the whole
 * script against this repository and against a repository built here with git.
 *
 * Why the tree case cannot pass for the wrong reason: it asserts the table count the live-database
 * census reads (`test/integration/db/migrations.integration.test.ts`, 69 at WP-97) as a lower bound,
 * so a parser that stopped matching cannot report a clean page over an empty schema.
 */
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(SCRIPTS, '..');

const doc = (sql: string, path = 'm/0001_x.sql') => ({ path, sql });
const names = (sql: string): string[] => [...tablesCreated([doc(sql)]).tables.keys()].sort();

describe('the migrations’ table list', () => {
  it('reads every spelling of create table this corpus writes, and none it does not', () => {
    expect(
      names(`
        create table plain (id uuid);
        CREATE TABLE Shouted (id uuid);
        create table if not exists guarded (id uuid);
        create unlogged table fast (id uuid);
        create table public.qualified (id uuid);
        create table "Quoted" (id uuid);
        create temporary table scratch (id uuid);
        create temp table scratch2 (id uuid);
        create table pgboss.job (id uuid);
      `),
    ).toEqual(['fast', 'guarded', 'plain', 'qualified', 'quoted', 'shouted']);
  });

  it('ignores a create table inside a comment or a string literal — the partition maker’s shape', () => {
    expect(
      names(`
        -- create table in_a_line_comment (id uuid);
        /* create table in_a_block_comment (id uuid); */
        create function make() returns void language plpgsql as $$
        begin
          execute format('create table public.%I partition of public.%I for values', a, b);
          perform 'it''s create table in_an_escaped_literal';
        end
        $$;
        create table after_them (id uuid);
      `),
    ).toEqual(['after_them']);
  });

  it('keeps line numbers, so a comment or literal cannot shift what follows', () => {
    const sql = "a -- x\n'b\nc' /* d\ne */ f";
    const stripped = withoutCommentsAndLiterals(sql);
    expect(stripped.split('\n')).toHaveLength(sql.split('\n').length);
    expect(stripped).not.toMatch(/[xbcde]/);
    expect(stripped).toMatch(/^a .*f$/s);
  });

  it('applies renames and drops in file order, and files a static partition under its parent', () => {
    const { tables, partitions } = tablesCreated([
      doc('create table old_name (id uuid); create table gone (id uuid);', 'm/0001.sql'),
      doc(
        'alter table if exists only old_name rename to new_name; drop table if exists gone, never_existed;',
        'm/0002.sql',
      ),
      doc(
        'create table events_2026_01 partition of events for values from (a) to (b);',
        'm/0003.sql',
      ),
    ]);
    expect([...tables]).toEqual([['new_name', 'm/0002.sql']]);
    expect([...partitions]).toEqual([['events_2026_01', 'events']]);
  });

  it('reads the migrator’s own DDL out of its template literal', () => {
    expect(
      migratorDdl('const X = 1;\nconst MIGRATION_LOG_DDL = `\n  create table t (a int)\n`;'),
    ).toBe('\n  create table t (a int)\n');
    expect(migratorDdl('const SOMETHING_ELSE = `create table t ()`;')).toBeNull();
  });
});

describe('the page’s entries', () => {
  const page = [
    '- `tasks(id, project_id)` — a table.',
    '- `users(id)`; `sessions(id, user_id)`.',
    'Prose naming `task_asks` and calling `uuidv7()` is not an entry.',
    '  - `nested(id)` — an indented list item is still an entry.',
  ].join('\n');

  it('counts a backticked column list anywhere as described, and a bare mention as nothing', () => {
    expect([...describedTables(page)].sort()).toEqual([
      'nested',
      'sessions',
      'tasks',
      'users',
      'uuidv7',
    ]);
  });

  it('reads only a list item that opens with a column list as a table entry', () => {
    expect([...entryTables(page)].sort()).toEqual(['nested', 'tasks', 'users']);
  });
});

describe('the comparison', () => {
  const tables = new Map([
    ['tasks', '0001.sql'],
    ['secret_table', '0002.sql'],
  ]);

  it('names an undescribed table and the migration that created it', () => {
    expect(
      dataModelProblems({ tables, page: '- `tasks(id)`', undocumented: {}, specified: {} }),
    ).toEqual([expect.stringMatching(/^`secret_table` \(created by 0002\.sql\) has no entry/)]);
  });

  it('admits a declared exemption, and refuses one that went stale in either direction', () => {
    expect(
      dataModelProblems({
        tables,
        page: '- `tasks(id)`',
        undocumented: { secret_table: 'a reason' },
        specified: {},
      }),
    ).toEqual([]);
    expect(
      dataModelProblems({
        tables,
        page: '- `tasks(id)`\n- `secret_table(id)`',
        undocumented: { secret_table: 'a reason', dropped_table: 'a reason' },
        specified: {},
      }),
    ).toEqual([
      'UNDOCUMENTED_TABLES names `dropped_table`, which no migration creates',
      expect.stringMatching(/^UNDOCUMENTED_TABLES names `secret_table`, which .* now describes/),
    ]);
  });

  it('refuses an entry no migration creates unless it is declared, and a declaration that went stale', () => {
    const page = '- `tasks(id)`\n- `secret_table(id)`\n- `renamed_away(id)`\n- `feedback(id)`';
    expect(dataModelProblems({ tables, page, undocumented: {}, specified: {} })).toEqual([
      expect.stringMatching(/entry for `feedback`, which no migration creates/),
      expect.stringMatching(/entry for `renamed_away`, which no migration creates/),
    ]);
    expect(
      dataModelProblems({
        tables,
        page,
        undocumented: {},
        specified: { feedback: 'r', renamed_away: 'r', tasks: 'r', unlisted: 'r' },
      }),
    ).toEqual([
      'SPECIFIED_NOT_CREATED names `tasks`, which a migration now creates — remove the declaration',
      expect.stringMatching(
        /^SPECIFIED_NOT_CREATED names `unlisted`, which .* no longer has an entry/,
      ),
    ]);
  });
});

describe('this repository', () => {
  it('describes every table its migrations and its migrator create', () => {
    const result = checkDataModel(repositoryRoot);
    expect(result.problems).toEqual([]);
    expect(result.migrations).toBeGreaterThanOrEqual(63);
    // The live-database census counted 69 at WP-97; a parser that stopped matching reads fewer.
    expect(result.tables.size).toBeGreaterThanOrEqual(69);
    expect(result.tables.get('platform_migrations')).toBe(MIGRATOR_SOURCE);
    expect(result.tables.get('events')).toMatch(/0005_events\.sql$/);
    // The monthly partitions are made at run time and never reach the parse.
    expect([...result.tables.keys()].filter((name) => /_\d{4}_\d{2}$/.test(name))).toEqual([]);
    expect(Object.keys(UNDOCUMENTED_TABLES)).toEqual([]);
    expect(Object.keys(SPECIFIED_NOT_CREATED)).toEqual(['feedback']);
  });

  it('prints one PASS line and exits 0', () => {
    const run = spawnSync(process.execPath, [join(SCRIPTS, 'check-data-model.mjs')], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split('\n')).toEqual([
      expect.stringMatching(/^PASS: data-model:check \(\d+ tables from \d+ migrations/),
    ]);
  });
});

describe('the script in a repository built here', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Data Model Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Data Model Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (cwd: string, ...args: string[]): void => {
    const result = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  };
  const write = (root: string, path: string, contents: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const repository = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'data-model-check-')));
    roots.push(root);
    for (const file of ['check-data-model.mjs', 'census-files.mjs', 'is-program.mjs']) {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(join(SCRIPTS, file), join(root, 'scripts', file));
    }
    write(
      root,
      MIGRATOR_SOURCE,
      'const MIGRATION_LOG_DDL = `create table platform_migrations (name text)`;\n',
    );
    write(root, `${MIGRATIONS_DIRECTORY}/0001_first.sql`, 'create table tasks (id uuid);\n');
    write(
      root,
      DATA_MODEL_PAGE,
      '- `tasks(id)`\n- `platform_migrations(name)`\n- `feedback(id)` — specified, unbuilt.\n',
    );
    git(root, 'init', '-q', '-b', 'main', '.');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'fixture');
    return root;
  };
  const run = (root: string) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'check-data-model.mjs')], {
      cwd: root,
      env: GIT_ENV,
      encoding: 'utf8',
    });

  it('passes a page that describes every table', () => {
    const result = run(repository());
    expect(result.stdout).toMatch(/^PASS: data-model:check \(2 tables from 1 migrations/);
    expect(result.status).toBe(0);
  });

  it('fails on a new migration’s table before it is staged, naming the table and the file', () => {
    const root = repository();
    write(
      root,
      `${MIGRATIONS_DIRECTORY}/0002_second.sql`,
      '-- a new table\ncreate table if not exists task_notes (id uuid);\n',
    );
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('FAIL: data-model:check\n');
    expect(result.stderr).toContain(
      `\`task_notes\` (created by ${MIGRATIONS_DIRECTORY}/0002_second.sql) has no entry`,
    );
  });

  it('fails when the migrator’s DDL moved out of sight, rather than skipping its table', () => {
    const root = repository();
    write(root, MIGRATOR_SOURCE, 'const RENAMED = `create table platform_migrations ()`;\n');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('could not find MIGRATION_LOG_DDL');
  });

  it('fails on an empty corpus rather than passing over nothing', () => {
    const root = repository();
    rmSync(join(root, MIGRATIONS_DIRECTORY, '0001_first.sql'));
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('found no migration');
  });
});
