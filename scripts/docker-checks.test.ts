/**
 * `scripts/docker-checks.mjs` — the table `.github/workflows/docker-checks.yml` runs the Docker checks
 * from, and the census that keeps every daemon check in some workflow.
 *
 * The checks themselves are not run here (they need a daemon, which no `verify` tier has); what is
 * held is which run when, that no `scripts/*-check.mjs` is in no workflow, and that a path list names
 * paths that exist — a list naming a moved file stops matching without a word.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
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
      'worker-install-check',
    ]);
    // The served installer and the module that renders it select the install check (backlog 1021).
    for (const path of [
      'apps/server/src/workers/install/install.sh',
      'apps/server/src/workers/install/install.ps1',
      'apps/server/src/workers/install.ts',
    ]) {
      expect(planChecks([path]), path).toContain('worker-install-check');
    }
    expect(planChecks(['scripts/worker-install-check.mjs'])).toEqual([
      ...ALWAYS,
      'worker-install-check',
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

  it('reads `git diff --no-renames --name-only` output', () => {
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

/**
 * The census of what a path-selected check's scripts name. A path list is an under-approximation by
 * design (the nightly run is the backstop), but a path a check's own scripts read or import **by
 * name** is one nobody has to guess, and a list that misses one lets a pull request that changes it
 * merge green while `main` goes red at night (the review of PR #45 found six).
 *
 * From the check's `scripts/<name>.mjs`, and every `scripts/**.mjs` it reaches through the same
 * spellings (a helper it imports, mounts or starts — a directory under `scripts/` brings every
 * `.mjs` in it), it reads:
 *
 *  - `new URL('<relative>', import.meta.url)` — an import or a read relative to the script;
 *  - `from '<relative>'`, `import('<relative>')`, `import '<relative>'` — a relative import;
 *  - `from '@platform/<pkg>'` (and the other two import spellings) — `packages/<pkg>/`, the whole
 *    ring, because a package's index re-exports it; `packages/<pkg>/src/index.ts` reads the same way;
 *  - `join(REPO, '<a>', '<b>')` (also `REPO_ROOT`, `ROOT`, `repositoryRoot`, with or without
 *    `path.`) — a path under the checkout. An argument that is not a string literal is reported as
 *    unresolvable and fails the census, rather than being skipped;
 *  - `${REPO_ROOT}/<path>` (also `REPO`, `ROOT`) inside a template — a file the check mounts or runs.
 *
 * A relative path in `scripts/worker-check/` resolves from `apps/server/worker-check/`, where
 * `worker-compose-check` mounts it into the product image; a `.js` specifier names its `.ts` source;
 * `node_modules/` is `pnpm-lock.yaml`'s; the checkout's root itself (`new URL('../', …)`, the base a
 * resolver joins onto) names nothing.
 *
 * **What it cannot see**, stated so nobody reads it as more: what a named file imports in turn (a
 * single file such as `apps/server/src/agent.ts` names that file only — the nightly run covers the
 * rest); a path built from a variable (`new URL(target)`, `join(REPO, name)` is refused, but
 * `join(base, 'x')` with any other base is not read); a path that only exists inside a container
 * (`/app/apps/server/src/main.ts`); the whole checkout mounted as `${REPO_ROOT}:${REPO_ROOT}` (no path
 * after it); a bare package other than `@platform/*` (the lockfile's); and an image's contents, which
 * the run-plane list names by Dockerfile instead. Comments are not stripped, so a spelling in a
 * docblock counts — which can only ask for more paths, never fewer.
 */
const MOUNTED_AT: Record<string, string> = {
  'scripts/worker-check/': 'apps/server/worker-check/',
};
const ROOT_NAMES = '(?:REPO_ROOT|REPO|ROOT|repositoryRoot)';

const isDirectory = (path: string): boolean => {
  try {
    return statSync(join(repositoryRoot, path)).isDirectory();
  } catch {
    return false;
  }
};

/** A repository-relative path → the path a list entry would name. */
const canonical = (raw: string): string => {
  let path = posix.normalize(raw).replace(/^\.\//, '');
  // The checkout's root itself (`new URL('../', import.meta.url)`, a resolver's base) names nothing.
  if (path === '' || path === '.' || path === './') return '';
  for (const [source, target] of Object.entries(MOUNTED_AT)) {
    const bare = target.slice(0, -1);
    if (path === bare || path.startsWith(target)) path = source + path.slice(target.length);
  }
  if (path.startsWith('node_modules/') || path === 'node_modules') return 'pnpm-lock.yaml';
  if (path.endsWith('.js') && existsSync(join(repositoryRoot, `${path.slice(0, -3)}.ts`))) {
    path = `${path.slice(0, -3)}.ts`;
  }
  const index = /^packages\/([^/]+)\/src\/index\.ts$/.exec(path);
  if (index) return `packages/${index[1]}/`;
  if (!path.endsWith('/') && isDirectory(path)) path = `${path}/`;
  return path;
};

/** The directory a script's relative specifiers resolve from (its mount point, if it has one). */
const baseOf = (source: string): string => {
  const directory = `${posix.dirname(source)}/`;
  for (const [from, to] of Object.entries(MOUNTED_AT)) {
    if (directory.startsWith(from)) return to + directory.slice(from.length);
  }
  return directory;
};

/** Every path `text` (the source at `source`) names by one of the spellings above. */
const namedPaths = (source: string, text: string): { paths: string[]; unresolved: string[] } => {
  const paths: string[] = [];
  const unresolved: string[] = [];
  const add = (raw: string) => {
    const path = canonical(raw);
    if (path !== '') paths.push(path);
  };
  const relative = (specifier: string) => add(posix.join(baseOf(source), specifier));
  const specifier = (value: string) => {
    if (value.startsWith('./') || value.startsWith('../')) relative(value);
    const platform = /^@platform\/([a-z0-9-]+)/.exec(value);
    if (platform) paths.push(`packages/${platform[1]}/`);
  };
  for (const match of text.matchAll(/new URL\(\s*'([^']+)'\s*,\s*import\.meta\.url\s*\)/g)) {
    relative(match[1] as string);
  }
  for (const pattern of [
    /\bfrom\s+'([^']+)'/g,
    /\bimport\(\s*'([^']+)'\s*\)/g,
    /^\s*import\s+'([^']+)'/gm,
  ]) {
    for (const match of text.matchAll(pattern)) specifier(match[1] as string);
  }
  for (const match of text.matchAll(
    new RegExp(`\\bjoin\\(\\s*${ROOT_NAMES}\\s*,([^)]*)\\)`, 'g'),
  )) {
    const parts = (match[1] as string).split(',').map((part) => part.trim());
    const literals = parts.map((part) => /^'([^']*)'$/.exec(part)?.[1]);
    if (literals.some((literal) => literal === undefined))
      unresolved.push(`${source}: ${match[0]}`);
    else add(literals.join('/'));
  }
  for (const match of text.matchAll(new RegExp(`\\$\\{${ROOT_NAMES}\\}/([\\w./-]+)`, 'g'))) {
    add(match[1] as string);
  }
  return { paths, unresolved };
};

/** A check's script, every `scripts/**.mjs` it reaches, and every path any of them names. */
const censusOf = (name: string) => {
  const sources = new Set<string>();
  const named = new Set<string>();
  const unresolved: string[] = [];
  const queue = [`scripts/${name}.mjs`];
  while (queue.length > 0) {
    const source = queue.shift() as string;
    if (sources.has(source)) continue;
    sources.add(source);
    const found = namedPaths(source, read(source));
    unresolved.push(...found.unresolved);
    for (const path of found.paths) {
      named.add(path);
      if (!path.startsWith('scripts/')) continue;
      if (path.endsWith('/')) {
        for (const entry of readdirSync(join(repositoryRoot, path)).sort()) {
          if (entry.endsWith('.mjs')) queue.push(`${path}${entry}`);
        }
      } else if (path.endsWith('.mjs')) queue.push(path);
    }
  }
  return { sources: [...sources], named: [...named].sort(), unresolved };
};

/** Whether a change to `path` (a file, or anything under a `/`-terminated directory) selects the check. */
const selects = (path: string, name: string, paths: readonly string[]): boolean =>
  path === `scripts/${name}.mjs` ||
  (path.endsWith('/')
    ? paths.some((entry) => entry.endsWith('/') && path.startsWith(entry))
    : matchesPath(path, paths));

describe('a path-selected check lists every path its scripts name', () => {
  const PATH_CHECKS = DOCKER_CHECKS.filter((check) => check.when === 'paths');

  it('reads each spelling, resolves a mounted helper from its mount point, and refuses a variable', () => {
    const text = [
      "await import(new URL('../apps/server/src/config.ts', import.meta.url).href);",
      "readFileSync(new URL('../compose.yml', import.meta.url), 'utf8');",
      "import { x } from './compose-check-support.mjs';",
      "import { y } from '@platform/domain';",
      "const z = await import('@platform/contracts/sub');",
      "new URL('../packages/prompts/src/index.ts', import.meta.url);",
      "path.join(REPO, 'scripts', 'worker-check', 'fake-claude-stage.mjs');",
      'path.join(REPO, name);',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the template spelling is the text under test.
      '`${REPO_ROOT}/scripts/launcher-control-plane-runner.mjs:/app/x.mjs:ro`',
      "import closeWithGrace from 'close-with-grace';",
      "import process from 'node:process';",
      "import './ts-source-resolver.mjs';",
      "const base = new URL('../', import.meta.url).href;",
    ].join('\n');
    expect(namedPaths('scripts/some-check.mjs', text)).toEqual({
      paths: [
        'apps/server/src/config.ts',
        'compose.yml',
        'packages/prompts/',
        'scripts/compose-check-support.mjs',
        'packages/domain/',
        'packages/contracts/',
        'scripts/ts-source-resolver.mjs',
        'scripts/worker-check/fake-claude-stage.mjs',
        'scripts/launcher-control-plane-runner.mjs',
      ],
      unresolved: ['scripts/some-check.mjs: join(REPO, name)'],
    });
    // Mounted at apps/server/worker-check/: `../src/runtime.js` is the server's runtime source.
    expect(
      namedPaths('scripts/worker-check/core-entry.mjs', "import { s } from '../src/runtime.js';")
        .paths,
    ).toEqual(['apps/server/src/runtime.ts']);
  });

  it('finds every named path on the check’s list', () => {
    expect(PATH_CHECKS.length).toBeGreaterThan(0);
    const missing: string[] = [];
    const unresolved: string[] = [];
    const named: Record<string, string[]> = {};
    const sources: Record<string, string[]> = {};
    for (const check of PATH_CHECKS) {
      const census = censusOf(check.name);
      named[check.name] = census.named;
      sources[check.name] = census.sources;
      unresolved.push(...census.unresolved);
      for (const path of census.named) {
        if (!existsSync(join(repositoryRoot, path)))
          missing.push(`${check.name}: ${path} (absent)`);
        else if (!selects(path, check.name, check.paths)) missing.push(`${check.name}: ${path}`);
      }
    }
    expect(unresolved).toEqual([]);
    expect(missing).toEqual([]);
    // Not vacuous: the paths the review of PR #45 found missing are among what the census reads.
    expect(named['launcher-control-plane-check']).toEqual(
      expect.arrayContaining([
        'compose.yml',
        'apps/server/src/config.ts',
        'packages/application/',
        'packages/domain/',
        'packages/prompts/',
        'scripts/launcher-control-plane-runner.mjs',
      ]),
    );
    expect(named['worker-compose-check']).toEqual(
      expect.arrayContaining([
        'packages/contracts/',
        'packages/domain/',
        'packages/infrastructure/',
        'scripts/worker-check/',
        'apps/server/src/runtime.ts',
      ]),
    );
    // The mounted directory brings its helpers in as sources: the core entry is read, not only named.
    expect(sources['worker-compose-check']).toEqual(
      expect.arrayContaining([
        'scripts/worker-check/core-entry.mjs',
        'scripts/worker-check/fake-claude-stage.mjs',
      ]),
    );
    expect(sources['launcher-control-plane-check']).toEqual(
      expect.arrayContaining([
        'scripts/launcher-control-plane-runner.mjs',
        'scripts/launcher-control-plane-launcher.mjs',
        'scripts/ts-source-resolver.mjs',
      ]),
    );
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
      expect(printed.stdout).toBe(
        `checks=${JSON.stringify([...ALWAYS, 'worker-update-check', 'worker-install-check'])}\n`,
      );

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
    // Not vacuous: the thirteen daemon checks the table and the two older workflows share.
    expect(scripts.length).toBeGreaterThanOrEqual(13);
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
    // A rename is a deletion and an addition, so a file moved out of a listed path still selects.
    expect(text).toContain('git diff --no-renames --name-only');
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
