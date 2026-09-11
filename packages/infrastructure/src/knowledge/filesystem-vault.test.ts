/**
 * The filesystem vault adapter, driven against **real files in a temp directory**.
 *
 * It does filesystem I/O in the unit tier on purpose, as `path-guard.filesystem.test.ts` and
 * `hardening.test.ts` already do: the whole question is what a walk of a checkout returns, and a
 * stubbed `readdir` would be a test of the stub.
 *
 * The corpus it walks is `FIXTURE_VAULT` — the same bytes the in-memory tiers use — materialised on
 * disk. That is what keeps the in-memory fixture honest about what a real vault looks like: if the
 * adapter and the fake disagreed about a document, this is where it would show.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FIXTURE_KNOWLEDGE_DIR, FIXTURE_VAULT, isIndexedVaultPath } from '@platform/application';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesystemVaultSource } from './filesystem-vault.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1';

let root: string;

const materialise = async (
  documents: readonly { readonly path: string; readonly source: string }[],
): Promise<void> => {
  for (const document of documents) {
    const absolute = path.join(root, document.path);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, document.source, 'utf8');
  }
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vault-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (commitSha = 'abc1234') =>
  createFilesystemVaultSource({ rootPath: root, commitSha }).read({
    projectId: PROJECT,
    knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
  });

describe('createFilesystemVaultSource', () => {
  it('reads exactly the documents technical/07 names, and nothing else', async () => {
    await materialise([
      ...FIXTURE_VAULT,
      { path: 'README.md', source: '# not the vault' },
      { path: 'docs/design.md', source: '# also not' },
      { path: 'src/api/session.ts', source: 'export const x = 1;' },
      { path: `${FIXTURE_KNOWLEDGE_DIR}/diagram.png`, source: 'not markdown' },
    ]);
    const result = await read();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.snapshot.documents.map((document) => document.path).sort()).toEqual(
      FIXTURE_VAULT.map((document) => document.path).sort(),
    );
    for (const document of result.snapshot.documents) {
      expect(isIndexedVaultPath(document.path, FIXTURE_KNOWLEDGE_DIR)).toBe(true);
    }
  });

  it('returns the same bytes the in-memory fixture carries', async () => {
    await materialise(FIXTURE_VAULT);
    const result = await read();
    if (result.status !== 'ok') throw new Error('expected ok');
    const onDisk = new Map(
      result.snapshot.documents.map((document) => [document.path, document.source]),
    );
    for (const document of FIXTURE_VAULT) {
      expect(onDisk.get(document.path)).toBe(document.source);
    }
  });

  it('maps `.agentic/rules/x.md` onto the rules layer and keeps CLAUDE.md at the root', async () => {
    await materialise(FIXTURE_VAULT);
    const result = await read();
    if (result.status !== 'ok') throw new Error('expected ok');
    const relative = new Map(
      result.snapshot.documents.map((document) => [document.path, document.vaultRelativePath]),
    );
    expect(relative.get('.agentic/rules/commit-style.md')).toBe('rules/commit-style.md');
    expect(relative.get('CLAUDE.md')).toBe('CLAUDE.md');
    expect(relative.get(`${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`)).toBe(
      'lessons/L-2026-01-04-session-fixtures.md',
    );
  });

  it('reports every file in the checkout as repoPaths, for validate-on-read', async () => {
    await materialise([
      ...FIXTURE_VAULT,
      { path: 'src/api/session.ts', source: '' },
      { path: 'src/billing/tax.ts', source: '' },
    ]);
    const result = await read();
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.snapshot.repoPaths).toContain('src/api/session.ts');
    expect(result.snapshot.repoPaths).toContain('src/billing/tax.ts');
    expect(result.snapshot.repoPaths).toContain('CLAUDE.md');
  });

  it('skips .git and node_modules', async () => {
    await materialise([
      { path: 'CLAUDE.md', source: '# x' },
      { path: '.git/HEAD', source: 'ref: refs/heads/main' },
      { path: 'node_modules/pkg/index.js', source: '' },
    ]);
    const result = await read();
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.snapshot.repoPaths).toEqual(['CLAUDE.md']);
  });

  it('gives a changed document a different content hash and an unchanged one the same', async () => {
    await materialise([{ path: 'CLAUDE.md', source: '# one' }]);
    const first = await read();
    if (first.status !== 'ok') throw new Error('expected ok');
    const second = await read();
    if (second.status !== 'ok') throw new Error('expected ok');
    expect(second.snapshot.documents[0]?.contentHash).toBe(
      first.snapshot.documents[0]?.contentHash,
    );

    await materialise([{ path: 'CLAUDE.md', source: '# two' }]);
    const third = await read();
    if (third.status !== 'ok') throw new Error('expected ok');
    expect(third.snapshot.documents[0]?.contentHash).not.toBe(
      first.snapshot.documents[0]?.contentHash,
    );
  });

  it('indexes an existing checkout with no vault as an empty snapshot, not a failure', async () => {
    await materialise([{ path: 'src/main.ts', source: '' }]);
    const result = await read();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.snapshot.documents).toEqual([]);
    expect(result.snapshot.repoPaths).toEqual(['src/main.ts']);
  });

  it('reports `unavailable` — not an empty vault — when the checkout does not exist', async () => {
    const missing = createFilesystemVaultSource({
      rootPath: path.join(root, 'no-such-checkout'),
      commitSha: 'abc1234',
    });
    const result = await missing.read({
      projectId: PROJECT,
      knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toContain('cannot read the checkout');
  });

  it('reports `unavailable` when the root is a file rather than a directory', async () => {
    await materialise([{ path: 'plain.txt', source: 'x' }]);
    const notADirectory = createFilesystemVaultSource({
      rootPath: path.join(root, 'plain.txt'),
      commitSha: 'abc1234',
    });
    const result = await notADirectory.read({
      projectId: PROJECT,
      knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
    });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toContain('not a directory');
  });

  it('prefers the requested commit over the constructed one', async () => {
    await materialise([{ path: 'CLAUDE.md', source: '# x' }]);
    const source = createFilesystemVaultSource({ rootPath: root, commitSha: 'aaaaaaa' });
    const pinned = await source.read({
      projectId: PROJECT,
      knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
      commitSha: 'bbbbbbb',
    });
    if (pinned.status !== 'ok') throw new Error('expected ok');
    expect(pinned.snapshot.commitSha).toBe('bbbbbbb');
  });
});
