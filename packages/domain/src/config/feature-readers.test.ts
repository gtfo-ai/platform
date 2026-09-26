/**
 * `FEATURE_READERS`, resolved against the tree instead of read (WP-44) — the shape
 * `packages/domain/src/policies/autonomy-readers.test.ts` gave the dial's reader table, and for its
 * reason: a table that names a reader nobody wrote is a claim, and the claim is what the feature
 * cards are compared against.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { featuresConfigSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PLATFORM_DEFAULT_CONFIG } from './effective-config.js';
import { FEATURE_READERS } from './feature-readers.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

/** The defaults module declares every key, so a citation of it would prove nothing. */
const DEFAULTS_MODULE = 'packages/domain/src/config/effective-config.ts';

const gitFiles = (args: readonly string[]): string[] =>
  execFileSync('git', [...args, '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file.length > 0);

/** Tracked *and* committable-but-untracked (standing rule 85). */
const treeFiles = (): ReadonlySet<string> =>
  new Set([...gitFiles(['ls-files']), ...gitFiles(['ls-files', '--others', '--exclude-standard'])]);

/** `features.<key>` or `features?.<key>`, as a whole word — how a reader names the key. */
const mentions = (body: string, key: string): boolean =>
  new RegExp(`features\\??\\.${key}\\b`).test(body);

export const unresolvedFeatureReaders = (
  table: Readonly<Record<string, readonly string[]>>,
  tree: ReadonlySet<string>,
  read: (file: string) => string,
): readonly string[] => {
  const problems: string[] = [];
  for (const [key, files] of Object.entries(table)) {
    for (const file of files) {
      if (file === DEFAULTS_MODULE) {
        problems.push(`${key}: cites the defaults module, which declares every key`);
      } else if (!tree.has(file)) {
        problems.push(`${key}: cites ${file}, which git does not know about`);
      } else if (!mentions(read(file), key)) {
        problems.push(`${key}: ${file} does not mention features.${key}`);
      }
    }
  }
  return problems.sort();
};

const readSource = (file: string): string => readFileSync(path.join(REPO_ROOT, file), 'utf8');

describe('the feature reader table', () => {
  it('has an entry for every feature key a project may write, and for nothing else', () => {
    expect(Object.keys(FEATURE_READERS).sort()).toEqual(
      Object.keys(featuresConfigSchema.shape).sort(),
    );
    // Every key the defaults ship is among them — the defaults are a subset, not a second list.
    for (const key of Object.keys(PLATFORM_DEFAULT_CONFIG.features ?? {})) {
      expect(Object.keys(FEATURE_READERS)).toContain(key);
    }
  });

  it('cites, for every key, a file git knows about that names the key', () => {
    expect(unresolvedFeatureReaders(FEATURE_READERS, treeFiles(), readSource)).toEqual([]);
  });

  it('refuses a citation that is missing, silent, or the defaults module (the check can fail)', () => {
    const tree = new Set(['a.ts', 'b.ts', DEFAULTS_MODULE]);
    const bodies: Record<string, string> = {
      'a.ts': 'config.features?.digest?.at',
      'b.ts': 'nothing here',
      [DEFAULTS_MODULE]: 'features.digest',
    };
    expect(
      unresolvedFeatureReaders(
        { digest: ['a.ts'], ask: ['b.ts'], spike: ['c.ts'], maintenance: [DEFAULTS_MODULE] },
        tree,
        (file) => bodies[file] ?? '',
      ),
    ).toEqual([
      'ask: b.ts does not mention features.ask',
      'maintenance: cites the defaults module, which declares every key',
      'spike: cites c.ts, which git does not know about',
    ]);
  });
});
