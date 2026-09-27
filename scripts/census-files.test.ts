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
