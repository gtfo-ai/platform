import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { afterEach, describe, expect, it } from 'vitest';
import vitestConfig, { GIT_ENVIRONMENT_SETUP } from '../vitest.config.js';
import { censusFiles } from './census-files.mjs';
import { initScratchRepository } from './git-scratch-env.mjs';
import { type GitSpawnSite, gitSpawnSites, isTestSource } from './git-spawn-sites.js';

/**
 * **No test spawns `git`, or a script that runs it, without the helper's environment** (WP-162 (c),
 * PROGRESS backlog 499).
 *
 * A linked worktree's `pre-push` hook exports `GIT_DIR`, and a fixture's `git init` / `commit` /
 * `tag` that inherits it acts on the repository the worktree shares instead of on its scratch root.
 * `scripts/git-scratch-env.mjs` is the answer; this census is what keeps a new site from forgetting
 * it. It reads every test file of the unit, process, integration, e2e and contract tiers — every
 * `*.test.ts` outside `apps/web/src` (the ui tier spawns nothing) and the harness under `test/`
 * except `test/web-e2e/` — through `census-files.mjs`, tracked **and** untracked (standing rule 85),
 * with comments removed.
 *
 * **A site** is a call to a child-process function (`execFileSync`, `execFile`, `execFileAsync`,
 * `spawnSync`, `spawn`, `execSync`, `exec`, a name the file binds to `promisify(execFile)`,
 * `promisify(execFile)(…)` itself) whose first
 * argument is the literal `'git'`, or whose arguments name one of the scripts that run git
 * themselves ({@link GIT_RUNNING_SCRIPTS}) — directly or through a constant initialised with one.
 * **It is admitted** when its options carry `env:` whose value is a call of `scratchGitEnv`,
 * `initScratchRepository` or `checkoutGitEnv`, an identifier this file binds to one (`const env =
 * initScratchRepository(root)`, `const gitEnv = (root) => scratchGitEnv(root, …)`), a spread of
 * either, or the shorthand `env` when the file binds `env` so.
 *
 * **What it cannot see**, stated rather than implied:
 * - a `git` inside a shell string (`/bin/sh -c '… git …'`, `bash -c step`) — `tracked.test.ts`'s
 *   `trackedListingScript` and `release.test.ts`'s workflow steps are the live examples, and both
 *   were given the helper's environment by hand;
 * - a command name held in a variable (`spawn(command, …)`), and a script path built at runtime;
 * - an `env` identifier bound in another module, or re-bound after the helper call; an `env` name is
 *   matched across the whole file, not per scope, so a binding in one test admits a call in another;
 * - an `env` whose value only **starts** with the helper: `{ ...scratchGitEnv(root), ...process.env }`
 *   is admitted although the second spread puts every `GIT_*` name back (review nit, WP-162);
 * - a whole command line as one string (`execSync('git ls-files')`): only a literal `'git'` as the
 *   first argument is read as a git spawn (no test file uses the string form today);
 * - a production module a test calls **in-process** with a scratch root (`censusPaths(root)`): it
 *   spawns its own `git` with the worker's environment, which `test/support/git-environment.ts`
 *   scrubs for every project (held below), not this census.
 */

/**
 * Sites admitted without the helper, each with the reason — and each must still be a site, so the
 * list cannot outlive what it excuses.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'test/e2e/support/docker-workspace.ts',
    'the `git http-backend` call is program text (`GIT_SERVER_PROGRAM`) that runs inside a container of the run image, against the container’s own `/tmp/srv`, with an environment built from nothing',
  ],
]);

/** Every site under `root` that spawns git, or a git-running script, without the helper. */
const unscrubbedGitSpawns = (root: string): GitSpawnSite[] =>
  gitSpawnSites(root).filter((site) => !site.admitted);

const repositoryRoot = join(import.meta.dirname, '..');

describe('every git spawn in a test takes the helper’s environment', () => {
  it('finds no unscrubbed site in this repository but the exempt ones', () => {
    const sites = unscrubbedGitSpawns(repositoryRoot);
    expect(
      sites
        .filter((site) => !EXEMPT.has(site.path))
        .map((site) => `${site.path}:${site.line} ${site.call}`),
    ).toEqual([]);
    // Both directions: an exemption whose site is gone is a stale excuse.
    expect([...new Set(sites.map((site) => site.path))].sort()).toEqual([...EXEMPT.keys()].sort());
  });

  it('reaches the sites it exists for (an anchor, standing rule 10)', () => {
    // The census must be reading the files that build scratch repositories, or a green answer above
    // would be vacuous: these use the helper today, so they are read and admitted.
    const read = censusFiles(repositoryRoot, { include: isTestSource }).map((file) => file.path);
    for (const path of [
      'scripts/census-files.test.ts',
      'scripts/version.test.ts',
      'scripts/changelog.test.ts',
      'packages/infrastructure/src/workspace/tracked.test.ts',
      'test/integration/knowledge/git-vault-index.integration.test.ts',
      'test/e2e/onboarding/wizard.e2e.test.ts',
    ]) {
      expect(read, path).toContain(path);
    }
  });
});

describe('the census against a repository built for it', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const plant = (root: string, path: string, source: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  };

  // Assembled, so this file's own source holds no unscrubbed site for the census above to find.
  const bare = `${'execFileSync'}('git', ['init', '-q'], { cwd: root });\n`;

  it('names a planted unscrubbed spawn, tracked and untracked, and admits the helper’s shapes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-spawn-census-')));
    roots.push(root);
    const env = initScratchRepository(root);
    plant(root, 'scripts/tracked.test.ts', bare);
    plant(root, 'packages/a/src/untracked.test.ts', bare);
    plant(root, 'test/e2e/support/harness.ts', `${'spawn'}('git', ['status']);\n`);
    plant(
      root,
      'scripts/script.test.ts',
      `${'spawnSync'}(process.execPath, [join(root, 'scripts', 'check-nul.mjs')], { cwd: root });\n`,
    );
    plant(
      root,
      'scripts/constant.test.ts',
      `const GUARD = join(SCRIPTS, 'version.mjs');\n${'spawnSync'}(process.execPath, [GUARD]);\n`,
    );
    plant(
      root,
      'test/integration/alias.integration.test.ts',
      `const sh = promisify(execFile);\nawait ${'sh'}('git', ['status'], { cwd: root });\n`,
    );
    plant(
      root,
      'scripts/inherits.test.ts',
      `${'execFileSync'}('git', ['add'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });\n`,
    );
    // Admitted shapes.
    plant(
      root,
      'scripts/direct.test.ts',
      `${'execFileSync'}('git', ['add'], { cwd: root, env: scratchGitEnv(root) });\n`,
    );
    plant(
      root,
      'scripts/bound.test.ts',
      [
        'const env = initScratchRepository(root);',
        `${'execFileSync'}('git', ['add'], { cwd: root, env });`,
        'const gitEnv = (r: string): Record<string, string> =>',
        '  scratchGitEnv(r, { author });',
        `${'spawnSync'}('git', args, { cwd, env: gitEnv(cwd) });`,
        `${'spawnSync'}(process.execPath, ['check-ignored.mjs'], { env: { ...gitEnv(root), PATH } });`,
        `${'execFileSync'}('git', ['ls-files'], { cwd: REPO, env: checkoutGitEnv() });`,
        '',
      ].join('\n'),
    );
    // Not sites: a commented-out spawn, a binding named `git`, the ui tier, a fixture.
    plant(root, 'scripts/comment.test.ts', `// ${bare}`);
    plant(
      root,
      'scripts/binding.test.ts',
      "binding('git', 'gitlab');\nregistry.get('git');\nconst run = (s: string) => s;\nrun('version.mjs');\n",
    );
    plant(root, 'apps/web/src/ui.test.ts', bare);
    execFileSync('git', ['add', 'scripts/tracked.test.ts'], { cwd: root, env });

    expect(unscrubbedGitSpawns(root).map((site) => `${site.path}:${site.line}`)).toEqual([
      'packages/a/src/untracked.test.ts:1',
      'scripts/constant.test.ts:2',
      'scripts/inherits.test.ts:1',
      'scripts/script.test.ts:1',
      'scripts/tracked.test.ts:1',
      'test/e2e/support/harness.ts:1',
      'test/integration/alias.integration.test.ts:2',
    ]);
  });
});

/**
 * The in-process half: a production module a test calls with a scratch root spawns `git` with the
 * worker's environment, so the setup file that scrubs it must be in **every** project.
 */
describe('the worker’s own environment', () => {
  interface Project {
    readonly test: { readonly name: string; readonly setupFiles?: readonly string[] };
  }
  const projects = ((vitestConfig as { test?: { projects?: Project[] } }).test?.projects ??
    []) as Project[];

  it('is scrubbed by a setup file every vitest project runs', () => {
    expect(projects.length).toBeGreaterThanOrEqual(6);
    expect(
      projects
        .filter((project) => !(project.test.setupFiles ?? []).includes(GIT_ENVIRONMENT_SETUP))
        .map((project) => project.test.name),
    ).toEqual([]);
  });

  it('carries no GIT_ name in this test, whatever started the run', () => {
    expect(Object.keys(process.env).filter((name) => name.startsWith('GIT_'))).toEqual([]);
  });
});
