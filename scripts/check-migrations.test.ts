import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROLLBACK_FLOOR } from '../packages/infrastructure/src/db/image-labels.js';
import {
  APP_DOCKERFILE,
  checkMigrations,
  MIGRATIONS_PATH,
  MigrationsBaseError,
  resolveMigrationsBase,
  rollbackFloorOf,
  runMigrationsCheck,
} from './check-migrations.js';
import { CommitRangeError, gitRunner, resolveCommitRange } from './commit-range.mjs';
import { checkoutGitEnv, initScratchRepository, scratchGitEnv } from './git-scratch-env.mjs';

/**
 * `migrations:check` (WP-271, TD-032 decision 1): every rule against a scratch repository whose
 * first commit is the push's base, and the base resolution it shares with `verify:commits`.
 */
const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const APPLIED = '0091_applied.sql';
const APPLIED_SQL = '-- 0091 — applied history, no header\ncreate table applied (x int);\n';
const EXPAND = '0092_expand.sql';
const EXPAND_SQL = '-- migration-class: additive\nalter table applied add column y int;\n';

interface Scratch {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly base: string;
  readonly write: (path: string, text: string) => void;
  readonly git: (...args: string[]) => string;
}

/** A repository whose one commit holds two applied migrations, a Dockerfile and a contracts file. */
const scratch = (dockerfile = 'FROM scratch\n'): Scratch => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wp271-migrations-')));
  scratches.push(root);
  const env = initScratchRepository(root, { initArgs: ['-b', 'main'] });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(`${MIGRATIONS_PATH}/${APPLIED}`, APPLIED_SQL);
  write(`${MIGRATIONS_PATH}/${EXPAND}`, EXPAND_SQL);
  write(APP_DOCKERFILE, dockerfile);
  write(
    'packages/contracts/src/run.ts',
    "export const RUN_STATUSES = ['running', 'rate_limited'] as const;\n",
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, env, base: git('rev-parse', 'HEAD'), write, git };
};

const findings = (repo: Scratch) =>
  checkMigrations(repo.root, repo.base, gitRunner(repo.root, repo.env)).findings.map(
    (finding) =>
      `${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} ${finding.message}`,
  );

const addMigration = (repo: Scratch, name: string, sql: string) =>
  repo.write(`${MIGRATIONS_PATH}/${name}`, sql);

describe('checkMigrations — the rules', () => {
  it('passes an unchanged tree, and a new additive file', () => {
    const repo = scratch();
    expect(findings(repo)).toEqual([]);
    addMigration(
      repo,
      '0093_offers.sql',
      '-- migration-class: additive\ncreate table offers (id uuid);\n',
    );
    const result = checkMigrations(repo.root, repo.base, gitRunner(repo.root, repo.env));
    expect(result).toEqual({ findings: [], added: ['0093_offers.sql'], applied: 2 });
  });

  it('refuses an applied file that was edited or deleted (rule 1)', () => {
    const repo = scratch();
    addMigration(repo, APPLIED, `${APPLIED_SQL}-- one more line\n`);
    rmSync(join(repo.root, MIGRATIONS_PATH, EXPAND));
    expect(findings(repo)).toEqual([
      `${APPLIED} is applied at the base and edited here; its checksum is recorded by every database that applied it — add a new file instead (TD-011)`,
      `${EXPAND} is applied at the base and deleted here; migrations are forward-only (TD-011)`,
    ]);
  });

  it('exempts a file that exists at the base from the header, and requires one of a new file (rule 2)', () => {
    const repo = scratch();
    addMigration(repo, '0093_bare.sql', 'create table bare (x int);\n');
    addMigration(repo, '0094_typo.sql', '-- migration-class: additiv\nselect 1;\n');
    addMigration(repo, 'notes.sql', '-- migration-class: additive\n');
    addMigration(repo, 'README.md', 'not a migration');
    expect(findings(repo)).toEqual([
      '0093_bare.sql:1 declares no class: a new migration opens with `-- migration-class: additive` or `-- migration-class: contract; expands: <nnnn>_<name>` (TD-032 decision 1)',
      expect.stringMatching(
        /^0094_typo\.sql:1 the first line "-- migration-class: additiv" is not a valid header/,
      ),
      'notes.sql does not match <nnnn>_<snake_case>.sql',
    ]);
  });

  it('checks a file that is not even staged (standing rule 85)', () => {
    const repo = scratch();
    addMigration(repo, '0093_drop.sql', '-- migration-class: additive\ndrop table applied;\n');
    expect(repo.git('status', '--porcelain')).toContain('0093_drop.sql');
    expect(findings(repo)).toEqual([
      expect.stringMatching(
        /^0093_drop\.sql:2 `drop table applied`: drop …: not on TD-032's additive allow-list/,
      ),
    ]);
  });

  it('admits add value only for a value in packages/contracts at the base (rule 3)', () => {
    const repo = scratch();
    // In the tree but not at the base: it does not count.
    repo.write('packages/contracts/src/later.ts', "export const LATER = 'paused';\n");
    addMigration(
      repo,
      '0093_enum.sql',
      "-- migration-class: additive\nalter type run_status add value 'rate_limited';\nalter type run_status add value 'paused';\n",
    );
    expect(findings(repo)).toEqual([
      expect.stringMatching(
        /^0093_enum\.sql:3 `alter type run_status add value 'paused'`: enum value 'paused'/,
      ),
    ]);
  });

  it('compares a replaced function with the signature an earlier file declared (rule 3)', () => {
    const repo = scratch();
    addMigration(
      repo,
      '0093_f.sql',
      '-- migration-class: additive\ncreate function f(a int) returns int as $$ select 1 $$ language sql;\n',
    );
    addMigration(
      repo,
      '0094_f.sql',
      '-- migration-class: additive\ncreate or replace function f(a text) returns int as $$ select 1 $$ language sql;\n',
    );
    expect(findings(repo)).toEqual([
      expect.stringMatching(
        /^0094_f\.sql:2 .*function f was declared by an earlier migration with a different signature/,
      ),
    ]);
  });

  it('admits a contract whose expand is additive at the base, and nothing else (rule 4)', () => {
    const repo = scratch();
    addMigration(
      repo,
      '0093_ok.sql',
      '-- migration-class: contract; expands: 0092_expand\nalter table applied drop column x;\n',
    );
    addMigration(
      repo,
      '0094_same_release.sql',
      '-- migration-class: additive\nalter table applied add column z int;\n',
    );
    addMigration(
      repo,
      '0095_early.sql',
      '-- migration-class: contract; expands: 0094_same_release\nselect 1;\n',
    );
    addMigration(
      repo,
      '0096_missing.sql',
      '-- migration-class: contract; expands: 0080_gone\nselect 1;\n',
    );
    addMigration(
      repo,
      '0097_unclassified.sql',
      '-- migration-class: contract; expands: 0091_applied\nselect 1;\n',
    );
    expect(findings(repo)).toEqual([
      '0095_early.sql:1 expands 0094_same_release, which is new in this change too; the expand must be released by an earlier push (TD-032 decision 1)',
      '0096_missing.sql:1 expands 0080_gone, which does not exist at the base',
      '0097_unclassified.sql:1 expands 0091_applied, which is not declared additive at the base (no class)',
    ]);
  });

  it('refuses raises-rollback-floor unless the label moved up in the same change (rule 5)', () => {
    const header = '-- migration-class: additive; raises-rollback-floor\ncreate table t (x int);\n';
    const absent = scratch();
    addMigration(absent, '0093_floor.sql', header);
    expect(findings(absent)).toEqual([
      "0093_floor.sql:1 says raises-rollback-floor, but docker/app.Dockerfile's org.platform.rollback-floor label is absent here and 0 at the base; raise it in the same change (TD-032 decision 2)",
    ]);
    const labelled = scratch('FROM scratch\nLABEL org.platform.rollback-floor="2"\n');
    addMigration(labelled, '0093_floor.sql', header);
    expect(findings(labelled)).toEqual([
      expect.stringContaining('label is 2 here and 2 at the base'),
    ]);
    labelled.write(APP_DOCKERFILE, 'FROM scratch\nLABEL org.platform.rollback-floor=3\n');
    expect(findings(labelled)).toEqual([]);
  });

  /**
   * Rule 6 (WP-272, PROGRESS backlog 689), both directions on one base: a branch that adds 0094
   * after `main` released 0095 is refused with both names and the next free number; the same file
   * numbered after the base passes.
   */
  it('refuses a new file that sorts before a file at the base, naming both and the next free number (rule 6)', () => {
    const repo = scratch();
    addMigration(
      repo,
      '0095_released.sql',
      '-- migration-class: additive\ncreate table released (x int);\n',
    );
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'main released 0095');
    const base = repo.git('rev-parse', 'HEAD');
    const against = () =>
      checkMigrations(repo.root, base, gitRunner(repo.root, repo.env)).findings.map(
        (finding) => `${finding.file} ${finding.message}`,
      );
    const late = '-- migration-class: additive\ncreate table late (x int);\n';

    addMigration(repo, '0094_late.sql', late);
    addMigration(repo, '0093_later_still.sql', late.replaceAll('late', 'later_still'));
    expect(against()).toEqual([
      '0093_later_still.sql is new here and sorts before 0095_released.sql, which exists at the base: a fresh database would apply it before 0095_released.sql and an upgraded one after — renumber it to 0096 (the next free number)',
      '0094_late.sql is new here and sorts before 0095_released.sql, which exists at the base: a fresh database would apply it before 0095_released.sql and an upgraded one after — renumber it to 0097 (the next free number)',
    ]);

    rmSync(join(repo.root, MIGRATIONS_PATH, '0093_later_still.sql'));
    rmSync(join(repo.root, MIGRATIONS_PATH, '0094_late.sql'));
    addMigration(repo, '0096_late.sql', late);
    expect(against()).toEqual([]);
  });

  it('reads the floor this repository’s app image declares as the code answers it', () => {
    const dockerfile = readFileSync(join(import.meta.dirname, '..', APP_DOCKERFILE), 'utf8');
    expect(rollbackFloorOf(dockerfile)).toBe(ROLLBACK_FLOOR);
  });

  it('reads the floor label in both of its spellings', () => {
    expect(rollbackFloorOf('LABEL org.platform.rollback-floor=1 \\\n  x=y')).toBe(1);
    expect(rollbackFloorOf('LABEL a=b \\\n      org.platform.rollback-floor = "12"')).toBe(12);
    expect(rollbackFloorOf('LABEL org.platform.rollback-floorx=1')).toBeNull();
    expect(rollbackFloorOf(null)).toBeNull();
  });
});

describe('the base — as verify:commits resolves its range', () => {
  const noEvent = { PATH: process.env.PATH };

  it('takes --from, and COMMIT_RANGE_FROM, as the base', () => {
    const repo = scratch();
    repo.write('x', '1');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'next');
    const git = gitRunner(repo.root, repo.env);
    expect(resolveMigrationsBase(git, { from: repo.base, env: noEvent }).base).toBe(repo.base);
    expect(
      resolveMigrationsBase(git, { env: { ...noEvent, COMMIT_RANGE_FROM: repo.base } }).base,
    ).toBe(repo.base);
  });

  it('takes a push payload’s before, and a pull request’s base', () => {
    const repo = scratch();
    repo.write('x', '1');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'next');
    const head = repo.git('rev-parse', 'HEAD');
    const payload = join(repo.root, '..', `${repo.root.split('/').pop()}-event.json`);
    scratches.push(payload);
    const git = gitRunner(repo.root, repo.env);
    writeFileSync(payload, JSON.stringify({ before: repo.base, after: head }));
    expect(
      resolveMigrationsBase(git, {
        env: { ...noEvent, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: payload },
      }),
    ).toEqual({ base: repo.base, label: `push ${repo.base.slice(0, 9)}..${head.slice(0, 9)}` });
    writeFileSync(
      payload,
      JSON.stringify({
        number: 7,
        pull_request: { base: { sha: repo.base }, head: { sha: head } },
      }),
    );
    expect(
      resolveMigrationsBase(git, {
        env: { ...noEvent, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: payload },
      }).base,
    ).toBe(repo.base);
    writeFileSync(payload, JSON.stringify({ deleted: true, before: head, after: '0'.repeat(40) }));
    expect(
      resolveMigrationsBase(git, {
        env: { ...noEvent, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: payload },
      }).base,
    ).toBeNull();
    writeFileSync(payload, JSON.stringify({ created: true, before: '0'.repeat(40), after: head }));
    expect(() =>
      resolveMigrationsBase(git, {
        env: { ...noEvent, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: payload },
      }),
    ).toThrow(
      /first push of this ref.*there is no base commit to compare the migrations with; pass --from <rev>/,
    );
  });

  it('takes the upstream, and falls back to the merge base with origin/main when there is none', () => {
    const repo = scratch();
    const git = gitRunner(repo.root, repo.env);
    expect(() => resolveMigrationsBase(git, { env: noEvent })).toThrow(
      /this branch has no upstream.*There is no refs\/remotes\/origin\/main to fall back to either/,
    );
    // A remote whose tracking ref exists but was never fetched: enough for `--set-upstream-to`.
    repo.git('remote', 'add', 'origin', repo.root);
    repo.git('update-ref', 'refs/remotes/origin/main', repo.base);
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write('x', '1');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'feature');
    expect(resolveMigrationsBase(git, { env: noEvent })).toEqual({
      base: repo.base,
      label: `no upstream; the merge base with refs/remotes/origin/main, ${repo.base.slice(0, 9)}`,
    });
    repo.git('branch', '-q', '--set-upstream-to', 'origin/main');
    // The upstream's name is the base, as it is `verify:commits`' range start.
    expect(resolveMigrationsBase(git, { env: noEvent })).toEqual({
      base: 'origin/main',
      label: 'origin/main..HEAD',
    });
  });

  it('refuses a shallow clone by name', () => {
    const repo = scratch();
    repo.write('x', '1');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'next');
    const clone = realpathSync(mkdtempSync(join(tmpdir(), 'wp271-shallow-')));
    scratches.push(clone);
    rmSync(clone, { recursive: true });
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo.root}`, clone], {
      env: scratchGitEnv(repo.root),
    });
    expect(() =>
      resolveMigrationsBase(gitRunner(clone, repo.env), { from: 'HEAD', env: noEvent }),
    ).toThrow(
      new MigrationsBaseError(
        'this checkout is shallow, so the migrations at the push’s base are unknowable — use `fetch-depth: 0`.',
      ),
    );
  });

  it('keeps the commit gates’ refusals: --to alone, and an event with no range', () => {
    const repo = scratch();
    const git = gitRunner(repo.root, repo.env);
    expect(() => resolveCommitRange(git, { to: 'HEAD', env: noEvent })).toThrow(CommitRangeError);
    expect(() =>
      resolveCommitRange(git, {
        env: { ...noEvent, GITHUB_EVENT_NAME: 'schedule', GITHUB_EVENT_PATH: '/dev/null' },
      }),
    ).toThrow(/cannot read the event payload|carries no commit range/);
    expect(() => resolveCommitRange(git, { from: 'no-such-rev', env: noEvent })).toThrow(
      /base commit no-such-rev is not in this checkout/,
    );
  });
});

describe('runMigrationsCheck — the command line', () => {
  const run = (root: string, argv: string[], env: Record<string, string | undefined>) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = runMigrationsCheck(argv, {
      root,
      env,
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join('') };
  };

  it('prints one PASS line, or one FAIL line with each finding on stderr', () => {
    const repo = scratch();
    const env = { ...repo.env, PATH: process.env.PATH };
    expect(run(repo.root, ['--from', repo.base], env)).toEqual({
      code: 0,
      out: `PASS: migrations:check (0 new migration(s) classified and checked, 2 applied at the base unchanged; explicit range ${repo.base}..HEAD)\n`,
      err: '',
    });
    addMigration(repo, '0093_bare.sql', 'select 1;\n');
    const failed = run(repo.root, [`--from=${repo.base}`, '--to=HEAD'], env);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe('FAIL: migrations:check\n');
    expect(failed.err).toMatch(
      /^packages\/infrastructure\/src\/db\/migrations\/0093_bare\.sql:1: declares no class/,
    );
    expect(failed.err).toContain('1 finding(s)');
  });

  it('fails on a base it cannot resolve, and exits 2 on a usage error', () => {
    const repo = scratch();
    const env = { ...repo.env, PATH: process.env.PATH };
    expect(run(repo.root, ['--from', 'nope'], env)).toMatchObject({
      code: 1,
      out: 'FAIL: migrations:check\n',
    });
    expect(run(repo.root, ['--bogus'], env)).toMatchObject({
      code: 2,
      out: 'FAIL: migrations:check\n',
    });
    expect(run(repo.root, ['--from'], env)).toMatchObject({ code: 2 });
  });

  it('runs as a program over this checkout and prints its verdict', () => {
    const root = join(import.meta.dirname, '..');
    const out = execFileSync('node', ['scripts/check-migrations.mjs', '--from', 'HEAD'], {
      cwd: root,
      env: checkoutGitEnv(),
      encoding: 'utf8',
    });
    expect(out).toMatch(
      /^PASS: migrations:check \(\d+ new migration\(s\) classified and checked, \d+ applied at the base unchanged; explicit range HEAD\.\.HEAD\)\n$/,
    );
  });
});
