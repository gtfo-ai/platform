/**
 * `scripts/docker-checks.mjs` — the table `.github/workflows/docker-checks.yml` runs the Docker checks
 * from, and the census that keeps every daemon check in some workflow.
 *
 * The checks themselves are not run here (they need a daemon, which no `verify` tier has); what is
 * held is which run when, that no `scripts/*-check.mjs` is in no workflow, and that a path list names
 * paths that exist — a list naming a moved file stops matching without a word.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusPaths } from './census-files.mjs';
import {
  DOCKER_CHECKS,
  HARNESS_PATHS,
  matchesPath,
  parseChanged,
  planChecks,
  RUN_ELSEWHERE,
} from './docker-checks.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(repositoryRoot, path), 'utf8');
const WORKFLOW = '.github/workflows/docker-checks.yml';

const ALWAYS = DOCKER_CHECKS.filter((check) => check.when === 'always').map((check) => check.name);
const ALL = DOCKER_CHECKS.map((check) => check.name);

/** Lines that are not YAML comments, so a check named only in a comment is not "run". */
const commandLines = (workflow: string): string[] =>
  workflow.split('\n').filter((line) => !line.trimStart().startsWith('#'));

describe('which Docker checks a change runs', () => {
  it('splits the table into checks that always run and checks a path list selects', () => {
    // Not vacuous: both halves are populated, so the cases below discriminate.
    expect(ALWAYS.length).toBeGreaterThan(0);
    expect(ALL.length).toBeGreaterThan(ALWAYS.length);
    for (const check of DOCKER_CHECKS) {
      if (check.when === 'always') expect(check.paths, check.name).toEqual([]);
      else expect(check.paths.length, check.name).toBeGreaterThan(0);
    }
  });

  it('runs every check when the changed files are unknown', () => {
    expect(planChecks(null)).toEqual(ALL);
  });

  it('runs only the always-checks for a change no path list names', () => {
    expect(planChecks(['docs/user-guide.md', 'apps/web/src/app/app.tsx'])).toEqual(ALWAYS);
    expect(planChecks([])).toEqual(ALWAYS);
  });

  it('runs every check when the harness itself changed', () => {
    for (const path of HARNESS_PATHS) expect(planChecks(['README.md', path]), path).toEqual(ALL);
  });

  it('adds a path-selected check for a file under one of its directories, and for its own script', () => {
    expect(planChecks(['apps/server/src/updater/apply.ts'])).toEqual([
      ...ALWAYS,
      'worker-update-check',
    ]);
    expect(planChecks(['scripts/launcher-control-plane-check.mjs'])).toEqual([
      ...ALWAYS,
      'launcher-control-plane-check',
    ]);
    expect(planChecks(['scripts/worker-check/core-entry.mjs'])).toEqual([
      ...ALWAYS,
      'worker-compose-check',
    ]);
    // A run-plane file selects every check that names the run plane, in table order.
    expect(planChecks(['docker/runtime.Dockerfile'])).toEqual(ALL);
  });

  it('matches a directory entry as a prefix and a file entry exactly', () => {
    expect(matchesPath('docker/runtime.Dockerfile', ['docker/'])).toBe(true);
    expect(matchesPath('dockerfile-notes.md', ['docker/'])).toBe(false);
    expect(matchesPath('compose.yml', ['compose.yml'])).toBe(true);
    expect(matchesPath('compose.yml.orig', ['compose.yml'])).toBe(false);
    expect(matchesPath('docs/compose.yml', ['compose.yml'])).toBe(false);
  });

  it('reads `git diff --name-only` output', () => {
    expect(parseChanged('a.ts\n\n  b/c.ts \n')).toEqual(['a.ts', 'b/c.ts']);
    expect(parseChanged('')).toEqual([]);
  });

  it('names only paths that exist, so a moved file cannot silently stop selecting its check', () => {
    const missing = DOCKER_CHECKS.flatMap((check) =>
      [...check.paths, `scripts/${check.name}.mjs`]
        .filter((path) => !existsSync(join(repositoryRoot, path)))
        .map((path) => `${check.name}: ${path}`),
    );
    expect(missing).toEqual([]);
    for (const path of HARNESS_PATHS)
      expect(existsSync(join(repositoryRoot, path)), path).toBe(true);
  });
});

describe('the plan command', () => {
  const plan = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, ['scripts/docker-checks.mjs', 'plan', ...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ...env },
    });

  it('prints the checks for a list of changed files, and writes them to GITHUB_OUTPUT', () => {
    const directory = mkdtempSync(join(tmpdir(), 'docker-checks-'));
    try {
      const changed = join(directory, 'changed');
      writeFileSync(changed, 'apps/server/src/updater/apply.ts\n');
      const printed = plan(['--changed', changed]);
      expect(printed.status, printed.stderr).toBe(0);
      expect(printed.stdout).toBe(`checks=${JSON.stringify([...ALWAYS, 'worker-update-check'])}\n`);

      const output = join(directory, 'output');
      writeFileSync(output, '');
      const written = plan(['--all', '--github-output'], { GITHUB_OUTPUT: output });
      expect(written.status, written.stderr).toBe(0);
      expect(written.stdout).toBe('');
      expect(readFileSync(output, 'utf8')).toBe(`checks=${JSON.stringify(ALL)}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses neither or both of --all and --changed, and --github-output with no GITHUB_OUTPUT', () => {
    expect(plan([]).status).toBe(2);
    expect(plan(['--all', '--changed', 'x']).status).toBe(2);
    expect(plan(['--changed']).status).toBe(2);
    expect(plan(['--all', '--github-output']).status).toBe(1);
  });

  it('refuses to run a check it does not know', () => {
    const result = spawnSync(process.execPath, ['scripts/docker-checks.mjs', 'run', 'nope'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown check');
  });
});

describe('every Docker check is run by some workflow', () => {
  // A git walk (`censusPaths`): WP-249's 15 s floor for a whole-tree census case.
  it('finds each scripts/*-check.mjs in the table or in a workflow that runs it', () => {
    const scripts = censusPaths(repositoryRoot, { pathspecs: ['scripts/*-check.mjs'] })
      .filter((path) => existsSync(join(repositoryRoot, path)))
      .map((path) => path.replace(/^scripts\//, '').replace(/\.mjs$/, ''));
    // Not vacuous: the twelve daemon checks the table and the two older workflows share.
    expect(scripts.length).toBeGreaterThanOrEqual(12);
    const elsewhere = Object.keys(RUN_ELSEWHERE);
    expect(
      ALL.filter((name) => elsewhere.includes(name)),
      'in both places',
    ).toEqual([]);
    expect([...scripts].sort()).toEqual([...ALL, ...elsewhere].sort());
  }, 15_000);

  it('finds every check RUN_ELSEWHERE names in the workflow it names, outside a comment', () => {
    for (const [name, workflow] of Object.entries(RUN_ELSEWHERE)) {
      expect(
        commandLines(read(workflow)).some((line) => line.includes(`node scripts/${name}.mjs`)),
        `${workflow} does not run ${name}`,
      ).toBe(true);
    }
  });

  it('runs the table from docker-checks.yml: planned, built once, one job per check, nightly', () => {
    const lines = commandLines(read(WORKFLOW));
    const text = lines.join('\n');
    expect(text).toContain('node scripts/docker-checks.mjs plan --changed');
    expect(text).toContain('node scripts/docker-checks.mjs plan --all');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell and Actions expression are the text under test.
    expect(text).toContain('node scripts/docker-checks.mjs run "${CHECK}"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell and Actions expression are the text under test.
    expect(text).toContain('check: ${{ fromJSON(needs.plan.outputs.checks) }}');
    expect(text).toMatch(/\n {2}schedule:\n {4}- cron: '[^']+'/);
    // Built once, by the one job that runs build-images; every check job loads that archive.
    expect(lines.filter((line) => line.includes('node scripts/build-images.mjs'))).toHaveLength(1);
    expect(text).toContain('docker load');
  });
});
