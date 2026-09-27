import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CensusUnreadableError, censusFiles, censusPaths, readCensus } from './census-files.mjs';

/**
 * The one answer every census gives to "which files" and "what if I cannot read one", against a
 * real repository built for it: a tracked, a staged, an untracked, an ignored, a vanished and an
 * unreadable path, each the control for another. "Reads untracked files" and "reads everything on
 * disk" are different guards, and only the first is wanted; "drops a path that is gone" and "drops
 * a path it could not read" are different guards, and only the first is wanted.
 */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const repository = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'census-files-')));
  roots.push(root);
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  };
  git('init', '-q');
  writeFileSync(join(root, '.gitignore'), '/ignored.ts\n');
  mkdirSync(join(root, 'src'));
  for (const name of ['tracked.ts', 'staged.ts', 'untracked.ts', 'ignored.ts', 'src/deep.ts']) {
    writeFileSync(join(root, name), `export const name = '${name}';\n`);
  }
  writeFileSync(join(root, 'notes.md'), '# notes\n');
  git('add', 'tracked.ts', '.gitignore', 'src/deep.ts', 'notes.md');
  git('-c', 'user.name=f', '-c', 'user.email=f@example.invalid', 'commit', '-q', '-m', 'f');
  git('add', 'staged.ts');
  return root;
};

describe('censusPaths', () => {
  it('lists tracked, staged and untracked paths, and not an ignored one', () => {
    const root = repository();
    expect(censusPaths(root)).toEqual([
      '.gitignore',
      'notes.md',
      'src/deep.ts',
      'staged.ts',
      'tracked.ts',
      'untracked.ts',
    ]);
  });

  it('narrows both halves by pathspec and filters by predicate', () => {
    const root = repository();
    writeFileSync(join(root, 'src', 'new.ts'), 'export {};\n');
    expect(censusPaths(root, { pathspecs: ['src'] })).toEqual(['src/deep.ts', 'src/new.ts']);
    expect(censusPaths(root, { include: (path) => path.endsWith('.md') })).toEqual(['notes.md']);
  });
});

describe('readCensus', () => {
  it('drops a path that vanished after the listing, and says so', () => {
    const root = repository();
    const listed = censusPaths(root);
    unlinkSync(join(root, 'untracked.ts'));
    unlinkSync(join(root, 'tracked.ts'));

    const read = readCensus(root, listed);

    expect(read.vanished).toEqual(['tracked.ts', 'untracked.ts']);
    expect(read.unreadable).toEqual([]);
    expect(read.files.map((file) => file.path)).toEqual([
      '.gitignore',
      'notes.md',
      'src/deep.ts',
      'staged.ts',
    ]);
    expect(read.files.find((file) => file.path === 'staged.ts')?.contents).toBe(
      "export const name = 'staged.ts';\n",
    );
  });

  it('reports a path that exists and cannot be read, rather than skipping it', () => {
    const root = repository();
    symlinkSync('nowhere', join(root, 'dangling.ts'));
    mkdirSync(join(root, 'looks-like-a-file.ts'));
    writeFileSync(join(root, 'looks-like-a-file.ts', 'inner.ts'), 'export {};\n');

    const read = readCensus(root, ['dangling.ts', 'looks-like-a-file.ts', 'tracked.ts']);

    expect(read.vanished).toEqual([]);
    expect(read.unreadable.map((entry) => entry.path)).toEqual([
      'dangling.ts',
      'looks-like-a-file.ts',
    ]);
    expect(read.unreadable[0]?.reason).toContain('symbolic link');
    expect(read.unreadable[1]?.reason).toContain('a directory');
    expect(read.files.map((file) => file.path)).toEqual(['tracked.ts']);
  });

  it('answers bytes when asked for no encoding', () => {
    const root = repository();
    const read = readCensus(root, ['tracked.ts'], { encoding: null });
    expect(Buffer.isBuffer(read.files[0]?.contents)).toBe(true);
  });
});

describe('censusFiles', () => {
  it('throws naming every unreadable path, and not for a vanished one', () => {
    const root = repository();
    symlinkSync('nowhere', join(root, 'dangling.ts'));

    expect(() => censusFiles(root)).toThrow(CensusUnreadableError);
    expect(() => censusFiles(root)).toThrow(/dangling\.ts: a symbolic link/);

    unlinkSync(join(root, 'dangling.ts'));
    expect(censusFiles(root, { include: (path) => path.endsWith('.ts') }).length).toBe(4);
  });
});

/**
 * **Who may import this helper — the reach `biome.json` gives it and does not narrow** (PROGRESS
 * backlog 248).
 *
 * The dependency rule's relative-path group carries `!**\/scripts/census-files.mjs` in **every**
 * ring's override, because the rings are the overrides and a test is not a ring: a biome override
 * replaces a rule's options rather than merging them, so a test-only exemption would have to repeat
 * each ring's `@platform/*` group in a second override per ring. So the linter lets any file in any
 * ring import it — a `packages/domain` source, which CLAUDE.md says does no I/O, included — and
 * this census is what narrows it: an importer must be a test file, a script, a `test/` harness, or
 * `apps/server/src/routes/web-sources.ts`, whose own importers must in turn be tests. It reads
 * tracked **and** untracked files (standing rule 85), and its planted case below is the calibration.
 */
const IMPORTS_CENSUS_HELPER = /(?:from|import\()\s*['"][^'"]*\/census-files\.mjs['"]/;
const IMPORTS_WEB_SOURCES = /(?:from|import\()\s*['"][^'"]*\/web-sources\.js['"]/;
const TEST_SOURCE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CENSUS_HELPER_SEAM = 'apps/server/src/routes/web-sources.ts';

/** Every file that reaches the helper from a ring's production sources. */
const productionImporters = (root: string): string[] =>
  censusFiles(root, {
    include: (path) => /\.(?:[cm]?[jt]sx?)$/.test(path) && !path.startsWith('node_modules/'),
  }).flatMap(({ path, contents }) => {
    if (path.startsWith('scripts/') || path.startsWith('test/') || TEST_SOURCE.test(path)) {
      return [];
    }
    if (IMPORTS_CENSUS_HELPER.test(contents) && path !== CENSUS_HELPER_SEAM) {
      return [path];
    }
    return IMPORTS_WEB_SOURCES.test(contents) ? [path] : [];
  });

describe('who may import census-files.mjs', () => {
  it('is imported from a production source nowhere in this repository', () => {
    const root = new URL('..', import.meta.url).pathname;
    expect(productionImporters(root)).toEqual([]);
  });

  it('refuses a planted production import, tracked or untracked, and admits a test', () => {
    const root = repository();
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    };
    mkdirSync(join(root, 'packages/domain/src'), { recursive: true });
    mkdirSync(join(root, 'apps/server/src/routes'), { recursive: true });
    const helper = "import { censusPaths } from '../../../scripts/census-files.mjs';\n";
    writeFileSync(join(root, 'packages/domain/src/tracked.ts'), helper);
    writeFileSync(join(root, 'packages/domain/src/untracked.ts'), helper);
    writeFileSync(join(root, 'packages/domain/src/fine.test.ts'), helper);
    writeFileSync(join(root, CENSUS_HELPER_SEAM), helper);
    writeFileSync(
      join(root, 'apps/server/src/leak.ts'),
      "import { readSource } from './routes/web-sources.js';\n",
    );
    git('add', 'packages/domain/src/tracked.ts');
    expect(productionImporters(root)).toEqual([
      'apps/server/src/leak.ts',
      'packages/domain/src/tracked.ts',
      'packages/domain/src/untracked.ts',
    ]);
  });
});
