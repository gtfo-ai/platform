import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_BLOCK_BEGIN,
  MANAGED_BLOCK_END,
  managedReferencesOf,
  pinReferences,
  previousOf,
  restorePrevious,
  rewriteManagedBlock,
} from './env-file.js';

const refs = (hex: string) => ({
  platform: `ghcr.io/acme/platform@sha256:${hex.repeat(64)}`,
  platform_launcher: `ghcr.io/acme/platform-launcher@sha256:${hex.repeat(64)}`,
  platform_runtime: `ghcr.io/acme/platform-runtime@sha256:${hex.repeat(64)}`,
  platform_egress: `ghcr.io/acme/platform-egress@sha256:${hex.repeat(64)}`,
});

describe('the managed block (TD-032 decision 4)', () => {
  it('appends the block to a file that has none, keeping every other line', () => {
    const text = 'APP_CORE_URL=https://core.example.test\n# a comment\nLOG_LEVEL=debug\n';
    const rewritten = rewriteManagedBlock(text, refs('a'));
    expect(rewritten.startsWith(text)).toBe(true);
    expect(rewritten).toContain(`${MANAGED_BLOCK_BEGIN}\nPLATFORM_IMAGE=${refs('a').platform}\n`);
    expect(rewritten.endsWith(`${MANAGED_BLOCK_END}\n`)).toBe(true);
    expect(managedReferencesOf(rewritten)).toEqual(refs('a'));
  });

  it('replaces the block in place of the old one, once', () => {
    const once = rewriteManagedBlock('LOG_LEVEL=info\n', refs('a'));
    const twice = rewriteManagedBlock(once, refs('b'));
    expect(twice.split(MANAGED_BLOCK_BEGIN)).toHaveLength(2);
    expect(managedReferencesOf(twice)).toEqual(refs('b'));
    expect(twice).not.toContain(refs('a').platform);
    expect(twice.startsWith('LOG_LEVEL=info\n')).toBe(true);
  });

  it('comments out a managed key a person set outside the block, rather than leaving two answers', () => {
    const rewritten = rewriteManagedBlock(
      'PLATFORM_IMAGE=platform:dev\nexport PLATFORM_EGRESS_IMAGE=x\nPLATFORM_IMAGES=kept\n',
      refs('a'),
    );
    expect(rewritten).toContain(
      "# PLATFORM_IMAGE=platform:dev  # taken over by the updater's block",
    );
    expect(rewritten).toContain('# export PLATFORM_EGRESS_IMAGE=x');
    // A longer name is not a managed key.
    expect(rewritten).toContain('\nPLATFORM_IMAGES=kept\n');
    const assignments = rewritten.split('\n').filter((line) => line.startsWith('PLATFORM_IMAGE='));
    expect(assignments).toEqual([`PLATFORM_IMAGE=${refs('a').platform}`]);
  });

  it('reads no references from a partial block', () => {
    const partial = `${MANAGED_BLOCK_BEGIN}\nPLATFORM_IMAGE=x\n${MANAGED_BLOCK_END}\n`;
    expect(managedReferencesOf(partial)).toBeNull();
    expect(managedReferencesOf('')).toBeNull();
  });
});

describe('pinning and the rollback, on disk', () => {
  it('keeps the whole previous file, writes the block with the file’s own mode, and restores it byte for byte', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'env-file-'));
    const file = path.join(directory, '.env');
    const original = 'CLAUDE_CODE_OAUTH_TOKEN_FILE=/run/token\nPLATFORM_IMAGE=platform:dev\n';
    await writeFile(file, original, { mode: 0o640 });
    await pinReferences(file, refs('c'));
    expect(await readFile(previousOf(file), 'utf8')).toBe(original);
    // The kept copy is private whatever the original's mode.
    expect((await stat(previousOf(file))).mode & 0o777).toBe(0o600);
    expect(managedReferencesOf(await readFile(file, 'utf8'))).toEqual(refs('c'));
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await restorePrevious(file);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('creates the file for a first install that passed everything on the shell, and its rollback empties it', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'env-file-'));
    const file = path.join(directory, '.env');
    await pinReferences(file, refs('d'));
    expect(managedReferencesOf(await readFile(file, 'utf8'))).toEqual(refs('d'));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await restorePrevious(file);
    expect(await readFile(file, 'utf8')).toBe('');
  });
});
