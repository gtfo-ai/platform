import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { PROCESS_SUITES } from '../vitest.config.js';
import { initScratchRepository } from './git-scratch-env.mjs';
import { gitSpawnSites } from './git-spawn-sites.js';

/**
 * **The incident, reproduced in CI** (WP-162 (d), PROGRESS backlog 499).
 *
 * A linked worktree's `pre-push` hook ran the unit tier with `GIT_DIR` in its environment, and the
 * suites that build scratch repositories wrote into the repository it named: `core.bare=true`, a
 * moved `HEAD`, a replaced index, release-shaped tags. This suite builds a throwaway repository,
 * points `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_WORK_TREE` at it in a child's environment, runs the
 * git-fixture suites in that child, and asserts that the throwaway's `config`, `HEAD`, loose and
 * packed refs and `index` are byte-identical afterwards — and that the suites passed, because a
 * fixture that read the wrong repository fails its own assertions (the census case that expects six
 * paths read 1973).
 *
 * **Which suites.** Every unit-tier test file with a `git` spawn site (`git-spawn-sites.ts`), read
 * off disk, so a new fixture suite joins without an edit here. The integration and e2e files that
 * spawn `git` need PostgreSQL and are not run by this suite; the census holds them to the helper.
 *
 * **Coverage off in the child**: two vitest runs in one checkout collide on the coverage directory,
 * and the child's `VITEST_*` and `NODE_V8_COVERAGE` are stripped for the same reason
 * (`nested-checkouts.test.ts` measured it). It runs in the `process` project, after `unit` and
 * `contract` and one file at a time, because it starts a whole vitest run of its own.
 *
 * On `f9e38239` (before WP-162) this suite failed: the throwaway's `config` gained `core.bare=true`,
 * its `HEAD` moved and its `index` was replaced (the WP-162 notes in PROGRESS have the run).
 */
const repositoryRoot = realpathSync(join(import.meta.dirname, '..'));

const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

/** The unit project's reach (`vitest.config.ts`), less the tiers it excludes. */
const isUnitTestFile = (path: string): boolean =>
  /^(?:packages\/[^/]+\/src|apps\/(?:server|launcher|runlet)\/src|scripts)\/.+\.test\.ts$/.test(
    path,
  ) &&
  !/\.(?:contract|integration|e2e)\.test\.ts$/.test(path) &&
  !PROCESS_SUITES.includes(path);

/** The unit-tier suites that spawn `git` or a script that runs it. */
const gitFixtureSuites = (): string[] => [
  ...new Set(gitSpawnSites(repositoryRoot, isUnitTestFile).map((site) => site.path)),
];

/** Every byte the incident changed: configuration, `HEAD`, the index, loose and packed refs. */
const repositoryState = (gitDir: string): Map<string, string> => {
  const state = new Map<string, string>();
  const read = (path: string): void => {
    const full = join(gitDir, path);
    let entry: ReturnType<typeof statSync>;
    try {
      entry = statSync(full);
    } catch {
      state.set(path, '<absent>');
      return;
    }
    if (entry.isDirectory()) {
      for (const name of readdirSync(full).sort()) read(join(path, name));
    } else {
      state.set(path, readFileSync(full).toString('base64'));
    }
  };
  for (const path of ['config', 'HEAD', 'index', 'packed-refs', 'refs']) read(path);
  return state;
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the git-fixture suites under an inherited GIT_DIR', () => {
  it('finds the suites the incident named (an anchor, standing rule 10)', () => {
    const suites = gitFixtureSuites();
    expect(suites).toContain('scripts/census-files.test.ts');
    expect(suites).toContain('scripts/version.test.ts');
    expect(suites).toContain('scripts/changelog.test.ts');
    expect(suites.length).toBeGreaterThanOrEqual(10);
  });

  it('leaves the repository GIT_DIR names byte-identical, and passes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-fixture-isolation-')));
    roots.push(root);
    const env = initScratchRepository(root, { initArgs: ['-b', 'main'] });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'the repository a hook names'], {
      cwd: root,
      env,
    });
    const gitDir = join(root, '.git');
    const before = repositoryState(gitDir);
    expect(before.get('config')).not.toBe('<absent>');
    expect(before.get('index')).not.toBe('<absent>');

    const suites = gitFixtureSuites();
    const childEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined && !name.startsWith('VITEST') && name !== 'NODE_V8_COVERAGE') {
        childEnv[name] = value;
      }
    }
    // What a linked worktree's hook exports (measured: `GIT_DIR`), and the two names the incident's
    // replaced index could have come through.
    Object.assign(childEnv, {
      GIT_DIR: gitDir,
      GIT_INDEX_FILE: join(gitDir, 'index'),
      GIT_WORK_TREE: root,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
    const run = spawnSync(
      process.execPath,
      [vitestCli, 'run', '--project', 'unit', '--coverage.enabled=false', ...suites],
      {
        cwd: repositoryRoot,
        env: childEnv,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 540_000,
      },
    );

    const after = repositoryState(gitDir);
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path))
      .sort();
    expect(changed, `the fixtures wrote into ${root}`).toEqual([]);
    const summary = `${run.stdout ?? ''}${run.stderr ?? ''}`
      .split('\n')
      .filter((line) => /×|FAIL|Test Files|Tests /.test(line))
      .join('\n');
    expect(`${String(run.status)} ${run.error?.message ?? ''}\n${summary}`).toMatch(/^0 /);
  }, 600_000);
});
