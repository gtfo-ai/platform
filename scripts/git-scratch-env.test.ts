import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertScratchRepository,
  checkoutGitEnv,
  initScratchRepository,
  ScratchRepositoryEscapeError,
  scratchGitEnv,
  scrubInheritedGit,
  withoutInheritedGit,
} from './git-scratch-env.mjs';

/**
 * The helper every test's `git` child takes its environment from (WP-162, backlog 499), held to
 * criterion (2): an inherited repository-locating name never survives — including one git does not
 * read today — and the `rev-parse` guard throws for a root whose git directory is elsewhere.
 */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-scratch-env-')));
  roots.push(root);
  return root;
};

/** A parent environment shaped like a linked worktree's hook, plus a name git does not read yet. */
const HOOK_PARENT = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/fixture',
  GIT_DIR: '/elsewhere/.git/worktrees/wt',
  GIT_INDEX_FILE: '/elsewhere/.git/index',
  GIT_WORK_TREE: '/elsewhere',
  GIT_COMMON_DIR: '/elsewhere/.git',
  GIT_FUTURE_NAME: 'invented',
  GIT_EXEC_PATH: '/usr/libexec/git-core',
} as const;

const INHERITED = [
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_FUTURE_NAME',
  'GIT_EXEC_PATH',
];

describe('withoutInheritedGit', () => {
  it('drops every GIT_ name, the invented one included, and keeps the rest', () => {
    const env = withoutInheritedGit(HOOK_PARENT);
    for (const name of INHERITED) expect(env, name).not.toHaveProperty(name);
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/fixture' });
  });

  it('is case-sensitive, as git is: a lower-case name is not git’s', () => {
    expect(withoutInheritedGit({ git_dir: 'x', GIT_DIR: 'y' })).toEqual({ git_dir: 'x' });
  });
});

describe('scrubInheritedGit', () => {
  it('removes the names in place and says which', () => {
    const env: Record<string, string | undefined> = { ...HOOK_PARENT };
    expect(scrubInheritedGit(env)).toEqual([...INHERITED].sort());
    expect(env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/fixture' });
  });
});

describe('scratchGitEnv', () => {
  it('carries none of the inherited names and adds back only the fixture’s own', () => {
    const root = scratch();
    const env = scratchGitEnv(root, { parent: HOOK_PARENT });
    for (const name of INHERITED) expect(env, name).not.toHaveProperty(name);
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      HOME: '/home/fixture',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CEILING_DIRECTORIES: dirname(root),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    });
  });

  it('appends configuration after core.hooksPath and names last', () => {
    const root = scratch();
    const env = scratchGitEnv(root, {
      parent: {},
      config: { 'commit.gpgsign': 'false' },
      env: { GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' },
    });
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_1).toBe('commit.gpgsign');
    expect(env.GIT_CONFIG_VALUE_1).toBe('false');
    expect(env.GIT_COMMITTER_DATE).toBe('2026-01-01T00:00:00Z');
  });

  it('keeps a real git out of a repository GIT_DIR names, and out of an enclosing one', () => {
    // The defect, against a real `git`: an outer repository, a scratch directory inside it that is
    // not a repository yet, and a parent environment that points `GIT_DIR` at the outer one.
    const outer = scratch();
    execFileSync('git', ['init', '-q'], { cwd: outer, env: scratchGitEnv(outer) });
    const inner = join(outer, 'inner');
    mkdirSync(inner);
    const configBefore = readFileSync(join(outer, '.git', 'config'), 'utf8');
    const env = scratchGitEnv(inner, { parent: { ...process.env, GIT_DIR: join(outer, '.git') } });
    // Discovery stops at the ceiling instead of finding `outer`, and the inherited GIT_DIR is gone.
    expect(() =>
      execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: inner, env, stdio: 'pipe' }),
    ).toThrow(/not a git repository/);
    expect(
      initScratchRepository(inner, { parent: { ...process.env, GIT_DIR: join(outer, '.git') } }),
    ).toBeTruthy();
    expect(readFileSync(join(outer, '.git', 'config'), 'utf8')).toBe(configBefore);
    expect(
      execFileSync('git', ['config', 'core.bare'], { cwd: inner, env, encoding: 'utf8' }).trim(),
    ).toBe('false');
  });
});

describe('assertScratchRepository', () => {
  it('passes for a repository initialised at the root', () => {
    const root = scratch();
    const env = initScratchRepository(root, { initArgs: ['-b', 'main'] });
    expect(() => assertScratchRepository(root, env)).not.toThrow();
  });

  it('throws for a root whose git directory is elsewhere', () => {
    const elsewhere = scratch();
    const root = scratch();
    // `--separate-git-dir` leaves a `.git` file at the root pointing outside it: exactly a root that
    // looks like a repository and acts on another one.
    execFileSync('git', ['init', '-q', `--separate-git-dir=${join(elsewhere, 'git')}`], {
      cwd: root,
      env: scratchGitEnv(root),
    });
    expect(() => assertScratchRepository(root)).toThrow(ScratchRepositoryEscapeError);
    expect(() => assertScratchRepository(root)).toThrow(join(elsewhere, 'git'));
  });

  it('throws for an environment that names another repository', () => {
    const other = scratch();
    initScratchRepository(other);
    const root = scratch();
    initScratchRepository(root);
    const misdirected = { ...scratchGitEnv(root), GIT_DIR: join(other, '.git') };
    expect(() => assertScratchRepository(root, misdirected)).toThrow(ScratchRepositoryEscapeError);
  });
});

describe('checkoutGitEnv', () => {
  it('is the prefix rule and nothing added', () => {
    expect(checkoutGitEnv(HOOK_PARENT)).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/fixture' });
  });
});
