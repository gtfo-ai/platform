import type { Id } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../ports/logger.js';
import {
  FIXTURE_INVALID_PATH,
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_REPO_PATHS,
  FIXTURE_VAULT,
} from '../testing/fixture-vault.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  indexedFixtureVault,
  memoryKnowledgeStore,
  memoryVaultSource,
  vaultSnapshotOf,
} from '../testing/memory-knowledge.js';
import {
  boundedRefusalReason,
  createKnowledgeIndexer,
  isIndexedVaultPath,
  KB_PARSER_VERSION,
  vaultRelativePath,
} from './indexer.js';
import { MAX_REFUSAL_REASON_CHARS } from './ports.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;

const indexerOver = (
  vault: ReturnType<typeof memoryVaultSource>,
  store = memoryKnowledgeStore(),
) => {
  const eventing = new MemoryEventing();
  return {
    store,
    eventing,
    indexer: createKnowledgeIndexer({
      vault,
      store,
      unitOfWork: eventing,
      eventStore: eventing.store,
      clock: fixedClock('2026-09-11T09:00:00.000Z'),
      ids: sequentialIds(500),
      logger: silentLogger,
    }),
  };
};

const request = {
  projectId: PROJECT,
  projectKey: FIXTURE_PROJECT_KEY,
  knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
};

describe('isIndexedVaultPath — the set technical/07 names', () => {
  it.each([
    ['.agentic/knowledge/lessons/L-1.md', true],
    ['.agentic/knowledge/index.md', true],
    ['.agentic/rules/commit-style.md', true],
    ['CLAUDE.md', true],
    ['AGENTS.md', true],
    ['README.md', false],
    ['docs/design.md', false],
    ['.agentic/config.yml', false],
    ['.agentic/knowledge/diagram.png', false],
    ['src/api/session.ts', false],
  ])('%s → %s', (path, expected) => {
    expect(isIndexedVaultPath(path, FIXTURE_KNOWLEDGE_DIR)).toBe(expected);
  });
});

describe('vaultRelativePath', () => {
  it.each([
    ['.agentic/knowledge/lessons/L-1.md', 'lessons/L-1.md'],
    ['.agentic/rules/commit-style.md', 'rules/commit-style.md'],
    ['CLAUDE.md', 'CLAUDE.md'],
  ])('%s → %s', (path, expected) => {
    expect(vaultRelativePath(path, FIXTURE_KNOWLEDGE_DIR)).toBe(expected);
  });
});

describe('KnowledgeIndexer — the three statuses are three different facts', () => {
  it('indexes the fixture vault and refuses only the document it should', async () => {
    const { report, store, projectId } = await indexedFixtureVault();
    expect(report.status).toBe('indexed');
    expect(report.parserVersion).toBe(KB_PARSER_VERSION);
    expect(report.commitSha).toBe('f1c7ea4');
    expect(report.invalid.map((entry) => entry.path)).toEqual([FIXTURE_INVALID_PATH]);
    expect(report.invalid[0]?.line).toBe(4);
    expect(report.documents).toBe(FIXTURE_VAULT.length - 1);
    expect(report.chunks).toBeGreaterThan(report.documents);
    expect(report.tokens).toBeGreaterThan(0);
    expect(report.truncated).toEqual([]);
    // The refused document is absent from the index, not present with no frontmatter.
    expect(store.snapshot(projectId).map((document) => document.path)).not.toContain(
      FIXTURE_INVALID_PATH,
    );
  });

  /**
   * **The refusal is stored, not only reported** (WP-57, PROGRESS backlog 37): `IndexReport.invalid`
   * lives for one job, and the nightly pass reads the store. Replaced per index run — a document
   * fixed at the next commit leaves no refusal behind — and untouched by a run that changed nothing.
   */
  it('stores what the parser refused beside the documents, and replaces it at the next commit', async () => {
    const broken = `${FIXTURE_KNOWLEDGE_DIR}/lessons/broken.md`;
    const store = memoryKnowledgeStore();
    const at = (commitSha: string, source: string) =>
      indexerOver(
        memoryVaultSource({
          status: 'ok',
          snapshot: vaultSnapshotOf([{ path: broken, source, contentHash: commitSha }], {
            commitSha,
            knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
            repoPaths: [],
          }),
        }),
        store,
      );
    const tab = '---\ntitle: x\n\tkind: lesson\n---\n# Broken\n';
    const first = await at('c0000001', tab).indexer.index(request);
    expect(first.invalid).toHaveLength(1);
    expect(store.refusals(PROJECT)).toEqual([
      { path: broken, reason: first.invalid[0]?.reason, line: first.invalid[0]?.line },
    ]);
    expect(store.refusals(PROJECT)[0]?.line).toBe(3);

    // The same commit again: `unchanged`, and the stored refusal is left exactly as it was.
    const again = await at('c0000001', tab).indexer.index(request);
    expect(again.status).toBe('unchanged');
    expect(store.refusals(PROJECT)).toHaveLength(1);

    // Fixed at the next commit: the refusal is gone, and the page is indexed.
    await at('c0000002', '# Fixed\n\nbody\n').indexer.index(request);
    expect(store.refusals(PROJECT)).toEqual([]);
    expect(store.snapshot(PROJECT).map((document) => document.path)).toEqual([broken]);
  });

  it('rebuilds an index whose commit is unknown, which is how 0041 hands an upgraded project its refusals', async () => {
    // Migration 0041 nulls `kb_index_state.commit_sha` and keeps `fts_built_at`: an index built
    // before refusals were stored must be re-read once, or its refusals read as "none" until the
    // default branch moves (WP-57 review round 1, rule 18).
    const store = memoryKnowledgeStore();
    const vault = memoryVaultSource({
      status: 'ok',
      snapshot: vaultSnapshotOf(FIXTURE_VAULT, {
        commitSha: 'f1c7ea4',
        knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
        repoPaths: FIXTURE_REPO_PATHS,
      }),
    });
    await indexerOver(vault, store).indexer.index(request);
    const upgraded = {
      ...store,
      write: store.write,
      readIndexState: async (projectId: Id) => {
        const state = await store.readIndexState(projectId);
        return state === null ? null : { ...state, commitSha: null };
      },
    };
    const report = await indexerOver(vault, upgraded as typeof store).indexer.index(request);
    expect(report.status).toBe('indexed');
    expect(store.refusals(PROJECT).map((refusal) => refusal.path)).toEqual([FIXTURE_INVALID_PATH]);
  });

  it('bounds a stored diagnosis and declares the cut', () => {
    expect(boundedRefusalReason('short')).toBe('short');
    expect(boundedRefusalReason('')).toBe('refused by the parser');
    const long = 'é'.repeat(MAX_REFUSAL_REASON_CHARS + 5);
    const bounded = boundedRefusalReason(long);
    expect(Array.from(bounded)).toHaveLength(MAX_REFUSAL_REASON_CHARS);
    expect(bounded.endsWith('…')).toBe(true);
    // Exactly at the bound is not cut.
    const exact = 'a'.repeat(MAX_REFUSAL_REASON_CHARS);
    expect(boundedRefusalReason(exact)).toBe(exact);
    // A surrogate pair is never split: the cut is by character, as the database counts.
    const emoji = '😀'.repeat(MAX_REFUSAL_REASON_CHARS + 1);
    expect(Array.from(boundedRefusalReason(emoji))).toHaveLength(MAX_REFUSAL_REASON_CHARS);
  });

  it('emits knowledge.index.rebuilt with the counts it reported', async () => {
    const { eventing, report, projectId } = await indexedFixtureVault();
    const stream = await eventing.store.readStream('project', projectId);
    expect(stream).toHaveLength(1);
    const event = stream[0]?.event;
    expect(event?.type).toBe('knowledge.index.rebuilt');
    expect(event?.payload).toEqual({
      project_id: projectId,
      commit_sha: 'f1c7ea4',
      documents: report.documents,
      chunks: report.chunks,
      tokens: report.tokens,
    });
  });

  it('reports `unchanged` on a second run and writes nothing', async () => {
    const vault = memoryVaultSource({
      status: 'ok',
      snapshot: vaultSnapshotOf(FIXTURE_VAULT, {
        commitSha: 'f1c7ea4',
        knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
        repoPaths: FIXTURE_REPO_PATHS,
      }),
    });
    const { indexer, eventing } = indexerOver(vault);
    await indexer.index(request);
    const second = await indexer.index(request);
    expect(second.status).toBe('unchanged');
    expect(second.chunks).toBe(0);
    expect(await eventing.store.readStream('project', PROJECT)).toHaveLength(1);
  });

  it('re-indexes an unchanged vault when forced, for a parser-version bump', async () => {
    const vault = memoryVaultSource({
      status: 'ok',
      snapshot: vaultSnapshotOf(FIXTURE_VAULT, {
        commitSha: 'f1c7ea4',
        knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
        repoPaths: FIXTURE_REPO_PATHS,
      }),
    });
    const { indexer } = indexerOver(vault);
    await indexer.index(request);
    const forced = await indexer.index({ ...request, force: true });
    expect(forced.status).toBe('indexed');
    expect(forced.chunks).toBeGreaterThan(0);
  });

  it('reports `vault_unavailable` and leaves the existing index in place', async () => {
    // The defect this names: a failed read that empties the index makes every later context pack
    // silently empty, with nothing anywhere saying why (rule 18).
    const store = memoryKnowledgeStore();
    const good = indexerOver(
      memoryVaultSource({
        status: 'ok',
        snapshot: vaultSnapshotOf(FIXTURE_VAULT, {
          commitSha: 'f1c7ea4',
          knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
          repoPaths: FIXTURE_REPO_PATHS,
        }),
      }),
      store,
    );
    await good.indexer.index(request);
    const before = store.snapshot(PROJECT).length;
    expect(before).toBeGreaterThan(0);

    const broken = indexerOver(
      memoryVaultSource({ status: 'unavailable', reason: 'no checkout at /var/lib/app/x' }),
      store,
    );
    const report = await broken.indexer.index(request);
    expect(report.status).toBe('vault_unavailable');
    expect(report.reason).toBe('no checkout at /var/lib/app/x');
    expect(report.documents).toBe(0);
    expect(store.snapshot(PROJECT)).toHaveLength(before);
  });

  it('indexes an empty vault to zero documents — which is not the same as a failed read', async () => {
    const { indexer, store } = indexerOver(
      memoryVaultSource({
        status: 'ok',
        snapshot: vaultSnapshotOf([], { commitSha: 'e0000000', repoPaths: [] }),
      }),
    );
    const report = await indexer.index(request);
    expect(report.status).toBe('indexed');
    expect(report.documents).toBe(0);
    expect(report.reason).toBeNull();
    expect(store.snapshot(PROJECT)).toEqual([]);
    // And the index *state* exists, so retrieval answers `ok` with nothing rather than
    // `not_indexed`.
    expect(await store.readIndexState(PROJECT)).not.toBeNull();
  });

  it('removes a document the vault no longer has, and says which', async () => {
    const store = memoryKnowledgeStore();
    const full = indexerOver(
      memoryVaultSource({
        status: 'ok',
        snapshot: vaultSnapshotOf(FIXTURE_VAULT, {
          commitSha: 'f1c7ea4',
          knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
          repoPaths: FIXTURE_REPO_PATHS,
        }),
      }),
      store,
    );
    await full.indexer.index(request);
    const dropped = FIXTURE_VAULT[FIXTURE_VAULT.length - 1] as (typeof FIXTURE_VAULT)[number];

    const smaller = indexerOver(
      memoryVaultSource({
        status: 'ok',
        snapshot: vaultSnapshotOf(
          FIXTURE_VAULT.filter((document) => document.path !== dropped.path),
          {
            commitSha: 'f1c7eb5',
            knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
            repoPaths: FIXTURE_REPO_PATHS,
          },
        ),
      }),
      store,
    );
    const report = await smaller.indexer.index(request);
    expect(report.removed).toEqual([dropped.path]);
    expect(store.snapshot(PROJECT).map((document) => document.path)).not.toContain(dropped.path);
  });

  it('marks a document truncated rather than shortening it quietly', async () => {
    const enormous = `# Doc\n\n${Array.from({ length: 600 }, (_u, index) => `## H${String(index)}\n\nbody`).join('\n\n')}`;
    const { indexer } = indexerOver(
      memoryVaultSource({
        status: 'ok',
        snapshot: vaultSnapshotOf(
          [
            {
              path: `${FIXTURE_KNOWLEDGE_DIR}/technical/huge.md`,
              source: enormous,
              contentHash: 'huge-1',
            },
          ],
          { commitSha: '40e00001', knowledgeDir: FIXTURE_KNOWLEDGE_DIR, repoPaths: [] },
        ),
      }),
    );
    const report = await indexer.index(request);
    expect(report.truncated).toEqual([`${FIXTURE_KNOWLEDGE_DIR}/technical/huge.md`]);
  });
});
