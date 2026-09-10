import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escapeGlob, findNestedCheckouts, isSeparateCheckout } from './nested-checkouts.js';

/**
 * What `vitest.config.ts` collects, measured against **real** nested checkouts built inside this
 * repository.
 *
 * A test that asserted "no collected path contains `worktrees`" would test a name, and a test that
 * only asserted "the foreign files are absent" would pass just as happily on a fixture builder that
 * wrote nothing — which is the failure mode that matters, because every assertion about an
 * exclusion is a negative one. Three things exclude it:
 *
 *  - every nested checkout has a **plain sibling** at the same depth with the same file names,
 *    differing only in the absence of a `.git` entry, and the plain sibling must be collected *by a
 *    named project*. So the include globs demonstrably reach these paths, and the exclusion is the
 *    only thing that can be removing the others (standing rules 4 and 42);
 *  - the whole collected list is captured **before** the fixtures exist and compared afterwards
 *    per project, so the fix cannot pass by collecting less of this checkout;
 *  - both `.git` shapes are built with git rather than simulated: `git worktree add` for the linked
 *    case, where `.git` is a file holding a `gitdir:` pointer, and `git init` for the nested-clone
 *    case, where it is a directory.
 *
 * The linked worktrees belong to a **scratch repository in the OS temp directory**, not to this
 * one. That is deliberate twice over. It keeps the test away from this repository's worktree
 * administration, which is shared with every other agent checkout and with the main one. And it is
 * the case that discriminates the shipped rule from the obvious alternative: `git worktree list
 * --porcelain` does not name a worktree belonging to somebody else's repository, so an
 * implementation built on it collects these files and fails here (standing rule 43 — a negative
 * case that only the right implementation refuses).
 *
 * **Mutation.** Deleting `...nestedCheckoutExcludes(repositoryRoot)` from `excludeEverywhere` in
 * `vitest.config.ts` fails `collects nothing from a nested checkout, whichever shape its .git has`
 * and `adds exactly the plain fixtures to each project and nothing else`, by assertion rather than
 * by timeout.
 *
 * **What it cannot check.** Nothing is said about a nested checkout under a directory in
 * `SKIP_DIRECTORIES` (`node_modules`, `dist`, `build`, `coverage`); the walk does not enter those
 * and no vitest project collects from them either.
 */
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The host's git configuration is not part of these fixtures. A global `core.hooksPath`, a commit
 * template or a signing key would otherwise make the test fail for reasons unrelated to the walk.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Nested Checkout Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Nested Checkout Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const git = (cwd: string, ...args: readonly string[]): void => {
  const result = spawnSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr ?? result.error?.message ?? '';
    throw new Error(
      `fixture setup: git ${args.join(' ')} exited ${String(result.status)}: ${detail}`,
    );
  }
};

/** An inert test file. It must be *collectable*; it must never matter whether it ran. */
const TEST_SOURCE =
  "import { expect, it } from 'vitest';\nit('fixture', () => expect(1).toBe(1));\n";

const write = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, TEST_SOURCE, 'utf8');
};

/**
 * Fixture roots. Two sit under directories whose globs are *anchored* (`packages/*` and
 * `apps/web/src`), because anchored only means a checkout at `.claude/worktrees/` cannot reach
 * them — it says nothing about one placed here, and one placed here **is** collected. The third is
 * a root-level directory, which is where the `integration` and `e2e-fake-claude` globs open with a
 * bare `**`, and it starts with a dot like the real `.claude/worktrees/` does.
 *
 * The prefixes are unmistakable so a crashed run can be swept up by the next one.
 */
const FIXTURE_PREFIX = 'zz-vitest-scope-';
const ROOT_PREFIX = '.vitest-scope-';
const id = `${String(process.pid)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * A nested checkout whose directory name carries glob syntax, because `escapeGlob` has to be
 * load-bearing rather than decorative. Measured against picomatch 4.0.7, the matcher tinyglobby
 * uses: `a/init (v2)/**` does **not** match `a/init (v2)/x.ts` — an unescaped parenthesis turns the
 * segment into a group and the exclusion misses the directory entirely, so its files are collected.
 * Escaped, it matches. (Brackets fail the other way round: `a/init[1]/**` matches both `init[1]`
 * and `init1`, so unescaped they *over*-exclude a sibling. Escaping fixes both; only the
 * parenthesis kills a mutation, which is why the fixture is named this way.)
 */
const GLOB_SYNTAX_DIRECTORY = 'init (v2)';

const packagesDir = join(repositoryRoot, 'packages');
const webSourceDir = join(repositoryRoot, 'apps', 'web', 'src');

const names = {
  packagePlain: `${FIXTURE_PREFIX}plain-${id}`,
  packageNested: `${FIXTURE_PREFIX}init-${id}`,
  webPlain: `${FIXTURE_PREFIX}plain-${id}`,
  webNested: `${FIXTURE_PREFIX}linked-${id}`,
  root: `${ROOT_PREFIX}${id}`,
} as const;

const fixtures = {
  plainPackage: join(packagesDir, names.packagePlain),
  nestedPackage: join(packagesDir, names.packageNested),
  plainWeb: join(webSourceDir, names.webPlain),
  nestedWeb: join(webSourceDir, names.webNested),
  root: join(repositoryRoot, names.root),
} as const;

/**
 * The plain fixtures, and **which project must collect each**. Naming the project is what makes the
 * positive half a statement about scoping rather than about the file existing: `unit` must take the
 * `.test.ts` and not the `.contract.test.ts` beside it, `contract` the reverse, and so on.
 */
const EXPECTED_ADDITIONS: Readonly<Record<string, readonly string[]>> = {
  unit: [`packages/${names.packagePlain}/src/ordinary.test.ts`],
  contract: [`packages/${names.packagePlain}/src/ordinary.contract.test.ts`],
  ui: [`apps/web/src/${names.webPlain}/ordinary.test.tsx`],
  integration: [`${names.root}/plain/ordinary.integration.test.ts`],
  'e2e-fake-claude': [`${names.root}/plain/ordinary.e2e.test.ts`],
};

/** Every path inside a nested checkout. Each is the sibling of an entry above. */
const FOREIGN_FIXTURES: readonly string[] = [
  `packages/${names.packageNested}/src/foreign.test.ts`,
  `packages/${names.packageNested}/src/foreign.contract.test.ts`,
  `apps/web/src/${names.webNested}/foreign.test.tsx`,
  `${names.root}/linked/foreign.integration.test.ts`,
  `${names.root}/linked/foreign.e2e.test.ts`,
  `${names.root}/${GLOB_SYNTAX_DIRECTORY}/foreign.integration.test.ts`,
  `${names.root}/${GLOB_SYNTAX_DIRECTORY}/foreign.e2e.test.ts`,
];

const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

/**
 * The collected file list of every project, as the shipped `vitest.config.ts` resolves it.
 *
 * `--filesOnly` stops after resolving the globs, so no fixture file is imported or run and this
 * cannot recurse into itself. The child's environment is stripped of the parent's `VITEST_*` and
 * `NODE_V8_COVERAGE`, which would otherwise make it behave like a worker of this run and write into
 * this run's coverage directory.
 */
const listCollectedFiles = (): ReadonlyMap<string, readonly string[]> => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST') || key === 'NODE_V8_COVERAGE') delete env[key];
  }

  const result = spawnSync(process.execPath, [vitestCli, 'list', '--filesOnly'], {
    cwd: repositoryRoot,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error !== undefined || result.status !== 0) {
    const detail = result.stderr ?? result.error?.message ?? '';
    throw new Error(`vitest list exited ${String(result.status)}: ${detail}`);
  }

  const byProject = new Map<string, string[]>();
  for (const line of result.stdout.split('\n')) {
    const match = /^\[([^\]]+)\] (.+)$/.exec(line.trim());
    const project = match?.[1];
    const path = match?.[2];
    if (project === undefined || path === undefined) continue;
    byProject.set(project, [...(byProject.get(project) ?? []), path]);
  }

  if (byProject.size === 0) throw new Error(`vitest list produced no projects:\n${result.stdout}`);
  return new Map([...byProject].map(([project, files]) => [project, [...files].sort()]));
};

const sweepStaleFixtures = (): void => {
  const sweep = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        rmSync(join(directory, entry.name), { recursive: true, force: true });
      }
    }
  };
  sweep(packagesDir, FIXTURE_PREFIX);
  sweep(webSourceDir, FIXTURE_PREFIX);
  sweep(repositoryRoot, ROOT_PREFIX);
};

let scratchRepository = '';
let baseline: ReadonlyMap<string, readonly string[]> = new Map();
let collected: ReadonlyMap<string, readonly string[]> = new Map();

beforeAll(() => {
  sweepStaleFixtures();
  baseline = listCollectedFiles();

  // A repository of its own, so the linked worktrees below belong to somebody else — see above.
  scratchRepository = mkdtempSync(join(tmpdir(), 'nested-checkout-scratch-'));
  git(scratchRepository, 'init', '--quiet');
  writeFileSync(join(scratchRepository, 'README.md'), 'scratch\n', 'utf8');
  git(scratchRepository, 'add', 'README.md');
  git(scratchRepository, 'commit', '--quiet', '--no-verify', '-m', 'scratch');

  /** A linked worktree of the scratch repository: `.git` is a file holding a `gitdir:` pointer. */
  const linkedWorktree = (path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    git(scratchRepository, 'worktree', 'add', '--quiet', '--detach', path, 'HEAD');
  };
  /** A nested clone: `.git` is a directory. */
  const nestedClone = (path: string): void => {
    mkdirSync(path, { recursive: true });
    git(path, 'init', '--quiet');
  };

  nestedClone(fixtures.nestedPackage);
  write(join(fixtures.nestedPackage, 'src', 'foreign.test.ts'));
  write(join(fixtures.nestedPackage, 'src', 'foreign.contract.test.ts'));
  write(join(fixtures.plainPackage, 'src', 'ordinary.test.ts'));
  write(join(fixtures.plainPackage, 'src', 'ordinary.contract.test.ts'));

  // The web fixture takes the linked shape on purpose: `apps/web/src/no-html.test.ts` walks this
  // directory, and a `.git` *file* leaves no object store there for it to read.
  linkedWorktree(fixtures.nestedWeb);
  write(join(fixtures.nestedWeb, 'foreign.test.tsx'));
  write(join(fixtures.plainWeb, 'ordinary.test.tsx'));

  linkedWorktree(join(fixtures.root, 'linked'));
  write(join(fixtures.root, 'linked', 'foreign.integration.test.ts'));
  write(join(fixtures.root, 'linked', 'foreign.e2e.test.ts'));
  nestedClone(join(fixtures.root, GLOB_SYNTAX_DIRECTORY));
  write(join(fixtures.root, GLOB_SYNTAX_DIRECTORY, 'foreign.integration.test.ts'));
  write(join(fixtures.root, GLOB_SYNTAX_DIRECTORY, 'foreign.e2e.test.ts'));
  write(join(fixtures.root, 'plain', 'ordinary.integration.test.ts'));
  write(join(fixtures.root, 'plain', 'ordinary.e2e.test.ts'));

  collected = listCollectedFiles();
}, 180_000);

afterAll(() => {
  for (const path of Object.values(fixtures)) rmSync(path, { recursive: true, force: true });
  if (scratchRepository !== '') rmSync(scratchRepository, { recursive: true, force: true });
});

const everythingCollected = (): readonly string[] => [...collected.values()].flat();

describe('vitest project scoping', () => {
  it('resolves the same five projects with the fixtures in place', () => {
    const projects = [...collected.keys()].sort();
    expect(projects).toStrictEqual(['contract', 'e2e-fake-claude', 'integration', 'ui', 'unit']);
    expect(projects).toStrictEqual([...baseline.keys()].sort());
    expect(Object.keys(EXPECTED_ADDITIONS).sort()).toStrictEqual(projects);
  });

  it('collects the plain sibling of every nested checkout, in the project that owns it', () => {
    // The positive half. Without it, a config collecting nothing at all would satisfy every
    // negative assertion below, and so would a fixture builder that wrote no files.
    for (const [project, additions] of Object.entries(EXPECTED_ADDITIONS)) {
      for (const path of additions) {
        expect(collected.get(project) ?? [], `project ${project}`).toContain(path);
      }
    }
  });

  it('collects nothing from a nested checkout, whichever shape its .git has', () => {
    const paths = everythingCollected();
    for (const path of FOREIGN_FIXTURES) expect(paths).not.toContain(path);
  });

  it('adds exactly the plain fixtures to each project and nothing else', () => {
    for (const [project, files] of collected) {
      const expected = [
        ...(baseline.get(project) ?? []),
        ...(EXPECTED_ADDITIONS[project] ?? []),
      ].sort();
      expect([...files].sort(), `project ${project}`).toStrictEqual(expected);
    }
  });

  it('leaves every project with files of this checkout', () => {
    for (const [project, files] of collected) {
      const additions = EXPECTED_ADDITIONS[project] ?? [];
      const own = files.filter((path) => !additions.includes(path));
      expect(own.length, `project ${project}`).toBeGreaterThan(0);
    }
  });

  it('names every nested checkout under the repository root, and no plain directory', () => {
    const found = findNestedCheckouts(repositoryRoot);
    expect(found).toContain(`packages/${names.packageNested}`);
    expect(found).toContain(`apps/web/src/${names.webNested}`);
    expect(found).toContain(`${names.root}/linked`);
    expect(found).toContain(`${names.root}/${GLOB_SYNTAX_DIRECTORY}`);
    expect(found).not.toContain(`packages/${names.packagePlain}`);
    expect(found).not.toContain(`apps/web/src/${names.webPlain}`);
    expect(found).not.toContain(`${names.root}/plain`);
  });
});

describe('findNestedCheckouts', () => {
  let root = '';

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'nested-checkout-walk-'));
    // The root is a checkout too — its own `.git` is exactly what makes it the root.
    writeFileSync(join(root, '.git'), 'gitdir: /elsewhere\n', 'utf8');

    mkdirSync(join(root, 'linked', 'inside', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'linked', '.git'), 'gitdir: /elsewhere/worktrees/linked\n', 'utf8');
    writeFileSync(join(root, 'linked', 'inside', 'deeper', '.git'), 'gitdir: /deeper\n', 'utf8');

    mkdirSync(join(root, 'clone', '.git', 'objects'), { recursive: true });
    mkdirSync(join(root, 'plain', 'deeper'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
  });

  afterAll(() => {
    if (root !== '') rmSync(root, { recursive: true, force: true });
  });

  it('finds both shapes of .git and stops at each', () => {
    // `linked/inside/deeper` is a checkout inside a checkout: `linked` is reported once and never
    // descended into, so the deeper one is absent rather than listed as a second entry.
    expect(findNestedCheckouts(root)).toStrictEqual(['clone', 'linked']);
  });

  it('never reports the root itself', () => {
    expect(isSeparateCheckout(root)).toBe(true);
    expect(findNestedCheckouts(root)).not.toContain('');
  });

  it('does not walk into dependency or build output', () => {
    expect(findNestedCheckouts(root)).not.toContain('node_modules/pkg');
  });

  it('is empty for a tree with no nested checkout', () => {
    expect(findNestedCheckouts(join(root, 'plain'))).toStrictEqual([]);
  });
});

describe('escapeGlob', () => {
  it('escapes every character picomatch reads as syntax', () => {
    expect(escapeGlob(GLOB_SYNTAX_DIRECTORY)).toBe('init \\(v2\\)');
    expect(escapeGlob('init[1]')).toBe('init\\[1\\]');
    expect(escapeGlob('a*b?c{d}e!f+g@h|i^j$k')).toBe('a\\*b\\?c\\{d\\}e\\!f\\+g\\@h\\|i\\^j\\$k');
  });

  it('leaves an ordinary path alone, separators included', () => {
    expect(escapeGlob('.claude/worktrees/agent-a1b2c3')).toBe('.claude/worktrees/agent-a1b2c3');
  });
});
