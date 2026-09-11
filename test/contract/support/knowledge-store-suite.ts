/**
 * The `KnowledgeStore` contract, run against the in-memory store and against PostgreSQL.
 *
 * WP-16's whole unit tier — the indexer's tests, the context pack's acceptance figure, `kb_search`
 * — runs on the in-memory store. Every claim it makes therefore rests on the two being
 * interchangeable, and this suite is what makes that true.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * The stores rank differently on purpose (the in-memory one counts matched query terms; PostgreSQL
 * uses `ts_rank_cd`), and the divergence register in `memory-knowledge.ts` says so. So this suite
 * asserts only what **both** guarantee:
 *
 *  - a chunk containing the query's terms comes back, and one containing none does not;
 *  - ranks are in `[0, 1]` and `limit` is honoured;
 *  - `not_indexed` is decided by whether an index run happened, not by the row count;
 *  - a replace removes what it did not carry;
 *  - `loadTier0` returns **exactly** what `isTier0Path` selects, near-misses included.
 *
 * That last one is the reason the suite exists rather than two separate test files. `isTier0Path`
 * is a TypeScript predicate and `PostgresKnowledgeStore.loadTier0` is a `where` clause: two
 * spellings of one rule, which is standing rule 41's shape. Running the predicate over the corpus
 * and demanding the store agree converts "they should match" into a check — and the near-misses are
 * the part that discriminates, because a store that returned *every* document would pass a suite
 * that only asserted the four real tier-0 paths were present.
 *
 * Ordering-sensitive ranking assertions live in
 * `test/integration/knowledge/postgres-knowledge-store.integration.test.ts`, against the real
 * `ts_rank_cd`.
 */
import {
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_VAULT,
  type IndexWrite,
  isTier0Path,
  type KnowledgeStore,
  type Transaction,
  vaultRelativePath,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { extractQueryTerms, parseKbDocument } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';

/** What a caller does before it reaches the port: the query's keywords, not its text. */
const termsOf = (text: string): readonly string[] => extractQueryTerms(text);

export interface KnowledgeStoreHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: KnowledgeStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    cleanup(): Promise<void>;
  }>;
}

/** The fixture vault, parsed — the one document the parser refuses is absent, as in production. */
const parsedFixture = (
  documents: readonly (typeof FIXTURE_VAULT)[number][] = FIXTURE_VAULT,
): IndexWrite['documents'] =>
  documents.flatMap((document) => {
    const parse = parseKbDocument({
      path: document.path,
      vaultRelativePath: vaultRelativePath(document.path, FIXTURE_KNOWLEDGE_DIR),
      source: document.source,
      projectKey: FIXTURE_PROJECT_KEY,
    });
    return parse.status === 'ok'
      ? [{ document: parse.document, blobSha: document.contentHash }]
      : [];
  });

export const runKnowledgeStoreContract = (harness: KnowledgeStoreHarness): void => {
  describe(`KnowledgeStore contract — ${harness.name}`, () => {
    let store: KnowledgeStore;
    let tx: Transaction;
    let projectId: Id;
    let cleanup: () => Promise<void>;

    const write = async (
      documents: IndexWrite['documents'] = parsedFixture(),
      overrides: Partial<IndexWrite> = {},
    ): Promise<void> => {
      await store.write(tx, {
        projectId,
        commitSha: 'abc1234',
        documents,
        removedPaths: [],
        ...overrides,
      });
    };

    beforeEach(async () => {
      const created = await harness.create();
      store = created.store;
      tx = created.tx;
      projectId = created.projectId;
      cleanup = created.cleanup;
      return async () => {
        await cleanup();
      };
    });

    it('answers `not_indexed` before any index run, and `ok` after one', async () => {
      const before = await store.search({ projectId, terms: termsOf('session'), limit: 5 });
      expect(before.status).toBe('not_indexed');
      expect(await store.readIndexState(projectId)).toBeNull();

      await write();
      const after = await store.search({ projectId, terms: termsOf('session'), limit: 5 });
      expect(after.status).toBe('ok');
      const state = await store.readIndexState(projectId);
      expect(state?.commitSha).toBe('abc1234');
      expect(state?.ftsBuiltAt).not.toBeNull();
    });

    it('answers `ok` with no hits for an indexed vault that has nothing to say', async () => {
      await write();
      const result = await store.search({
        projectId,
        terms: termsOf('quantumchromodynamicslattice'),
        limit: 5,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.hits).toEqual([]);
    });

    it('returns the chunk that carries the query terms, with a rank in [0, 1]', async () => {
      await write();
      const result = await store.search({
        projectId,
        terms: termsOf('seeded fixture user'),
        limit: 10,
      });
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.map((hit) => hit.path)).toContain(
        `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
      );
      for (const hit of result.hits) {
        expect(hit.rank).toBeGreaterThan(0);
        expect(hit.rank).toBeLessThanOrEqual(1);
        expect(hit.text).not.toBe('');
      }
    });

    it('honours the limit', async () => {
      await write();
      const result = await store.search({
        projectId,
        terms: termsOf('the session service'),
        limit: 2,
      });
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.hits.length).toBeLessThanOrEqual(2);
    });

    it('survives a query the model could write without raising', async () => {
      // A stray operator in a ticket title must not turn every later delivery into a failing job
      // (rule 20); `websearch_to_tsquery` is total, and the in-memory store must be too. The
      // operators never reach either store — `extractQueryTerms` drops them — so this asserts the
      // whole path a caller actually takes rather than the port in isolation.
      await write();
      for (const query of [
        "' or 1=1 --",
        'session & | ! ( ) :*',
        '   ',
        '!'.repeat(200),
        'session:*',
        '"phrase query" <-> session',
      ]) {
        const result = await store.search({ projectId, terms: termsOf(query), limit: 5 });
        expect(result.status).toBe('ok');
      }
    });

    it('finds nothing — not everything — for a query with no keywords', async () => {
      // `extractQueryTerms('the')` is empty, and a store that read an empty term list as "no
      // filter" would return the whole vault for the most degenerate query there is.
      await write();
      const result = await store.search({ projectId, terms: termsOf('the'), limit: 50 });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.hits).toEqual([]);
    });

    it('matches a document carrying any one keyword, not only one carrying all of them', async () => {
      // The defect this closes: `websearch_to_tsquery` ANDs bare words, so a ticket-shaped query
      // matched zero documents in production while the in-memory double returned fifteen.
      await write();
      const result = await store.search({
        projectId,
        terms: termsOf('the session service fails its tests with a foreign key violation'),
        limit: 50,
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') throw new Error('expected ok');
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.map((hit) => hit.path)).toContain(
        `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
      );
    });

    it('loads documents by path and their chunks in order', async () => {
      await write();
      const [document] = await store.loadDocuments(projectId, [
        `${FIXTURE_KNOWLEDGE_DIR}/lessons/L-2026-01-04-session-fixtures.md`,
      ]);
      expect(document).toBeDefined();
      expect(document?.layer).toBe('lessons');
      expect(document?.frontmatter.type).toBe('pitfall');
      expect(document?.frontmatter.paths).toEqual([
        'src/api/session.ts',
        'src/api/session.test.ts',
      ]);
      expect(document?.tokens).toBeGreaterThan(0);

      const chunks = await store.loadChunks(document?.id as Id);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_chunk, index) => index));
      expect(chunks[0]?.text.startsWith(`${FIXTURE_PROJECT_KEY} / `)).toBe(true);
    });

    it('loads nothing for an unknown path rather than raising', async () => {
      await write();
      expect(await store.loadDocuments(projectId, ['nope.md'])).toEqual([]);
      expect(await store.loadDocuments(projectId, [])).toEqual([]);
    });

    it('returns exactly the path-scoped documents', async () => {
      await write();
      const scoped = await store.loadPathScoped(projectId);
      const expected = parsedFixture()
        .filter((entry) => (entry.document.frontmatter.paths ?? []).length > 0)
        .map((entry) => entry.document.path)
        .sort();
      expect(scoped.map((document) => document.path).sort()).toEqual(expected);
      expect(expected.length).toBeGreaterThan(0);
    });

    it('returns exactly what isTier0Path selects — near-misses included', async () => {
      const nearMisses = [
        // A loose page at the vault root: NOT tier 0, or a project that keeps notes beside the
        // index would inject every one of them into every run.
        { path: `${FIXTURE_KNOWLEDGE_DIR}/scratch-note.md`, source: '# a loose page\n' },
        // A directory named `rules` *inside* the vault is not `.agentic/rules`.
        { path: `${FIXTURE_KNOWLEDGE_DIR}/rules/local.md`, source: '# not the rules layer\n' },
        // A path that merely starts with the same characters.
        { path: '.agentic/rules-draft/x.md', source: '# not a rule\n' },
        { path: 'AGENTS.md', source: '# agents\n' },
      ].map((document) => ({ ...document, contentHash: `near-${document.path}` }));

      await write(parsedFixture([...FIXTURE_VAULT, ...nearMisses]));

      const expected = [...FIXTURE_VAULT, ...nearMisses]
        .map((document) => document.path)
        .filter((path) => isTier0Path(path, FIXTURE_KNOWLEDGE_DIR))
        .sort();
      const actual = (await store.loadTier0(projectId, FIXTURE_KNOWLEDGE_DIR))
        .map((document) => document.path)
        .sort();

      expect(actual).toEqual(expected);
      expect(actual).toEqual([
        '.agentic/knowledge/index.md',
        '.agentic/rules/commit-style.md',
        '.agentic/rules/no-direct-sql.md',
        'AGENTS.md',
        'CLAUDE.md',
      ]);
      expect(actual).not.toContain(`${FIXTURE_KNOWLEDGE_DIR}/scratch-note.md`);
      expect(actual).not.toContain('.agentic/rules-draft/x.md');
    });

    it('reports the content hash of every indexed document', async () => {
      await write();
      const blobs = await store.readIndexedBlobs(projectId);
      expect(blobs.size).toBe(parsedFixture().length);
      expect(blobs.get('CLAUDE.md')).toBe(
        FIXTURE_VAULT.find((document) => document.path === 'CLAUDE.md')?.contentHash,
      );
    });

    it('replaces: a second write removes the documents it did not carry', async () => {
      await write();
      const kept = parsedFixture(FIXTURE_VAULT.slice(0, 3));
      await write(kept, { commitSha: 'def5678' });
      const blobs = await store.readIndexedBlobs(projectId);
      expect([...blobs.keys()].sort()).toEqual(kept.map((entry) => entry.document.path).sort());
      expect((await store.readIndexState(projectId))?.commitSha).toBe('def5678');
    });

    it('updates a document in place when its content changes', async () => {
      await write();
      const [before] = await store.loadDocuments(projectId, ['CLAUDE.md']);
      const edited = FIXTURE_VAULT.map((document) =>
        document.path === 'CLAUDE.md'
          ? { ...document, source: '# Demo service\n\nrewritten\n', contentHash: 'claude-v2' }
          : document,
      );
      await write(parsedFixture(edited));
      const [after] = await store.loadDocuments(projectId, ['CLAUDE.md']);
      expect(after?.contentHash).toBe('claude-v2');
      expect(after?.tokens).not.toBe(before?.tokens);
      const chunks = await store.loadChunks(after?.id as Id);
      expect(chunks.map((chunk) => chunk.text).join('\n')).toContain('rewritten');
    });

    it('keeps projects apart', async () => {
      await write();
      const other = '00000000-0000-4000-8000-0000000000ff' as Id;
      expect(await store.readIndexState(other)).toBeNull();
      expect(
        (await store.search({ projectId: other, terms: termsOf('session'), limit: 5 })).status,
      ).toBe('not_indexed');
    });
  });
};
