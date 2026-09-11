/**
 * In-memory doubles for WP-16's ports: the knowledge store, the vault, the code-map store and the
 * symbol extractor.
 *
 * ## Divergence register (standing rule 1: a fake may be stricter than the real adapter, never
 * kinder — and every deliberate difference is written down where the fake is defined)
 *
 * | # | Divergence | Direction | Why it is safe |
 * |---|---|---|---|
 * | 1 | **Ranking.** This store ranks a chunk by the fraction of the query's terms it contains; PostgreSQL uses `ts_rank_cd` over a `simple` tsvector. Both land in `[0, 1]`; the **orderings differ**. | *Different*, not kinder | No test may assert a rank value or a full ordering from this fake and claim it holds of Postgres. The shared contract suite asserts only what both guarantee: a chunk containing a query term is returned, one containing none is not, ranks are in `[0, 1]`, and `limit` is honoured. The ordering-sensitive assertions live in `postgres-knowledge-store.integration.test.ts`, and `context-pack.integration.test.ts` pins the **pack composition** against the real store because the acceptance figure is otherwise a property of this file. |
 * | 1b | **Matching semantics — closed at round 2.** This store matched a chunk carrying *any* query term while `PostgresKnowledgeStore` passed the raw task text to `websearch_to_tsquery`, which joins bare words with **AND**. Measured over the fixture vault: a ticket-shaped query returned **15** documents here and **0** there, so every retrieval test was exercising a path production did not have. | was **kinder** | Closed at the port, not in the fake: `KbSearchRequest` now carries extracted terms and the adapter joins them with `OR`, so both stores match the same set and only the ranking differs. |
 * | 2 | **Tokenisation.** Terms are split on non-word characters and lowercased. Postgres's `simple` configuration splits on its own rules and does not stem either. | *Different* | Same mitigation as 1. TD-008 chose `simple` precisely so neither side stems. |
 * | 3 | **No tsvector size limit.** Postgres refuses a tsvector over 1 MB; this store accepts any chunk. | **Kinder** | `MAX_CHUNK_BYTES` in the domain ring is what keeps a chunk two orders of magnitude below the limit, and `document.test.ts` asserts the cap by *producing* an over-long section and counting the pieces. The bound is enforced before the store, so neither store can reach the state. |
 * | 4 | **Writes are not transactional.** `write` mutates the maps immediately; the `Transaction` handle is validated and otherwise unused. | **Kinder** | A caller that relies on rollback is not exercised here. The transactional half is `postgres-knowledge-store.integration.test.ts`, which asserts a failed index run leaves the previous documents in place. |
 * | 5 | **`not_indexed` is decided by an explicit flag** rather than by reading a `kb_index_state` row. | *Equivalent* | `markIndexed` is what the indexer's write does in both, and the contract suite drives it through the indexer rather than setting the flag directly. |
 *
 * The fake extractor is separate and simpler: it returns exactly what it was constructed with, and
 * `fakeSymbolExtractor({ available: false })` is how a test reaches the `unavailable` branch that
 * the real `ctags` adapter takes on this machine.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { type CodeFileSymbols, fixedClock, type KbChunk, sequentialIds } from '@platform/domain';
import {
  createKnowledgeIndexer,
  type IndexReport,
  vaultRelativePath,
} from '../knowledge/indexer.js';
import type {
  CodeMapStore,
  IndexWrite,
  KbChunkHit,
  KbIndexState,
  KbSearchRequest,
  KbSearchResult,
  KnowledgeStore,
  StoredKbDocument,
  SymbolExtractionRequest,
  SymbolExtractionResult,
  SymbolExtractor,
  SymbolExtractorProbe,
  VaultReadRequest,
  VaultReadResult,
  VaultSnapshot,
  VaultSource,
} from '../knowledge/ports.js';
import { isTier0Path } from '../knowledge/ports.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import {
  FIXTURE_KNOWLEDGE_DIR,
  FIXTURE_PROJECT_KEY,
  FIXTURE_REPO_PATHS,
  FIXTURE_VAULT,
} from './fixture-vault.js';
import { MEMORY_ADAPTER, MemoryEventing } from './memory-eventing.js';

/** A transaction handle the memory doubles accept — the same adapter name `memory-eventing` uses. */
export const memoryTransaction: Transaction = { adapter: MEMORY_ADAPTER };

const assertOwnTransaction = (tx: Transaction): void => {
  if (tx.adapter !== MEMORY_ADAPTER) {
    throw new Error(`memory knowledge store: foreign transaction from "${tx.adapter}"`);
  }
};

/** The chunk side of the match. The query side arrives already extracted (`KbSearchRequest`). */
const chunkTerms = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1);

interface StoredRow {
  readonly document: StoredKbDocument;
  readonly chunks: readonly KbChunk[];
  readonly contentHash: string;
}

export interface MemoryKnowledgeStore extends KnowledgeStore {
  /** Rows currently indexed, for assertions that do not go through a port method. */
  snapshot(projectId: Id): readonly StoredKbDocument[];
}

export const memoryKnowledgeStore = (
  options: { readonly now?: () => IsoDateTime } = {},
): MemoryKnowledgeStore => {
  const rows = new Map<Id, Map<string, StoredRow>>();
  const state = new Map<Id, KbIndexState>();
  let nextId = 1;

  const project = (projectId: Id): Map<string, StoredRow> => {
    const existing = rows.get(projectId);
    if (existing !== undefined) return existing;
    const created = new Map<string, StoredRow>();
    rows.set(projectId, created);
    return created;
  };

  return {
    snapshot: (projectId) => [...project(projectId).values()].map((row) => row.document),

    write: async (tx: Transaction, input: IndexWrite): Promise<void> => {
      assertOwnTransaction(tx);
      const target = project(input.projectId);
      // A replace, exactly as `PostgresKnowledgeStore.write` does it: `removedPaths` *and*
      // anything the write did not carry. A fake that only honoured `removedPaths` would keep a
      // page the real store deletes, which is the kinder direction rule 1 forbids.
      const kept = new Set(input.documents.map((entry) => entry.document.path));
      for (const path of [...target.keys()]) {
        if (input.removedPaths.includes(path) || !kept.has(path)) target.delete(path);
      }
      for (const entry of input.documents) {
        const previous = target.get(entry.document.path);
        const id =
          previous?.document.id ??
          (`00000000-0000-4000-9000-${String(nextId++).padStart(12, '0')}` as Id);
        target.set(entry.document.path, {
          contentHash: entry.blobSha,
          chunks: entry.document.chunks,
          document: {
            id,
            path: entry.document.path,
            layer: entry.document.layer,
            frontmatter: entry.document.frontmatter,
            rawFrontmatter: entry.document.rawFrontmatter,
            tokens: entry.document.tokens,
            contentHash: entry.blobSha,
          },
        });
      }
      state.set(input.projectId, {
        projectId: input.projectId,
        commitSha: input.commitSha,
        ftsBuiltAt: options.now?.() ?? ('2026-01-01T00:00:00.000Z' as IsoDateTime),
      });
    },

    readIndexState: async (projectId) => state.get(projectId) ?? null,

    readIndexedBlobs: async (projectId) =>
      new Map([...project(projectId).values()].map((row) => [row.document.path, row.contentHash])),

    search: async (request: KbSearchRequest): Promise<KbSearchResult> => {
      const indexed = state.get(request.projectId);
      if (indexed === undefined || indexed.ftsBuiltAt === null) return { status: 'not_indexed' };
      const wanted = request.terms;
      if (wanted.length === 0) return { status: 'ok', hits: [] };
      const hits: KbChunkHit[] = [];
      for (const row of project(request.projectId).values()) {
        for (const chunk of row.chunks) {
          const present = new Set(chunkTerms(chunk.text));
          const matched = wanted.filter((term) => present.has(term)).length;
          if (matched === 0) continue;
          hits.push({
            documentId: row.document.id,
            path: row.document.path,
            headingPath: chunk.headingPath,
            text: chunk.text,
            rank: matched / wanted.length,
          });
        }
      }
      return {
        status: 'ok',
        hits: hits
          .sort((left, right) =>
            right.rank === left.rank ? left.path.localeCompare(right.path) : right.rank - left.rank,
          )
          .slice(0, request.limit),
      };
    },

    loadDocuments: async (projectId, paths) => {
      const target = project(projectId);
      return paths.flatMap((path) => {
        const row = target.get(path);
        return row === undefined ? [] : [row.document];
      });
    },

    loadPathScoped: async (projectId) =>
      [...project(projectId).values()]
        .filter((row) => (row.document.frontmatter.paths ?? []).length > 0)
        .map((row) => row.document),

    loadTier0: async (projectId, knowledgeDir) =>
      [...project(projectId).values()]
        .filter((row) => isTier0Path(row.document.path, knowledgeDir))
        .map((row) => row.document)
        .sort((left, right) => left.path.localeCompare(right.path)),

    loadChunks: async (documentId) => {
      for (const target of rows.values()) {
        for (const row of target.values()) {
          if (row.document.id === documentId) return row.chunks;
        }
      }
      return [];
    },
  };
};

/** A vault that answers with a fixed snapshot, or refuses. */
export const memoryVaultSource = (
  answer: VaultReadResult | ((request: VaultReadRequest) => VaultReadResult),
): VaultSource => ({
  read: async (request) => (typeof answer === 'function' ? answer(request) : answer),
});

export const vaultSnapshotOf = (
  documents: readonly {
    readonly path: string;
    readonly source: string;
    readonly contentHash: string;
  }[],
  options: {
    readonly commitSha?: string;
    readonly knowledgeDir?: string;
    readonly repoPaths?: readonly string[];
  } = {},
): VaultSnapshot => {
  const knowledgeDir = options.knowledgeDir ?? '.agentic/knowledge';
  return {
    commitSha: options.commitSha ?? 'a'.repeat(40),
    repoPaths: options.repoPaths ?? [],
    documents: documents.map((entry) => ({
      path: entry.path,
      vaultRelativePath: vaultRelativePath(entry.path, knowledgeDir),
      source: entry.source,
      contentHash: entry.contentHash,
    })),
  };
};

export const memoryCodeMapStore = (): CodeMapStore & {
  readonly maps: Map<string, string>;
} => {
  const symbols = new Map<string, CodeFileSymbols>();
  const maps = new Map<string, string>();
  const mapKey = (
    projectId: Id,
    key: { commitSha: string; focusHash: string; tokenBudget: number },
  ): string => `${projectId}|${key.commitSha}|${key.focusHash}|${key.tokenBudget}`;

  return {
    maps,
    readSymbols: async (projectId, blobShas) =>
      blobShas.flatMap((sha) => {
        const file = symbols.get(`${projectId}|${sha}`);
        return file === undefined ? [] : [file];
      }),
    writeSymbols: async (tx, projectId, entries) => {
      assertOwnTransaction(tx);
      for (const entry of entries) symbols.set(`${projectId}|${entry.blobSha}`, entry.file);
    },
    readMap: async (projectId, key) => maps.get(mapKey(projectId, key)) ?? null,
    writeMap: async (tx, projectId, key, mapText) => {
      assertOwnTransaction(tx);
      maps.set(mapKey(projectId, key), mapText);
    },
  };
};

export interface FakeSymbolExtractorOptions {
  readonly id?: string;
  readonly probe?: SymbolExtractorProbe;
  readonly files?: readonly CodeFileSymbols[];
  /** Fail the extraction even though the probe succeeded — the "it broke after we asked" branch. */
  readonly extractionFailure?: string;
}

export const fakeSymbolExtractor = (
  options: FakeSymbolExtractorOptions = {},
): SymbolExtractor & { readonly requests: SymbolExtractionRequest[] } => {
  const requests: SymbolExtractionRequest[] = [];
  return {
    requests,
    id: options.id ?? 'fake',
    probe: async () => options.probe ?? { available: true, detail: 'fake extractor' },
    extract: async (request): Promise<SymbolExtractionResult> => {
      requests.push(request);
      if (options.extractionFailure !== undefined) {
        return { status: 'unavailable', reason: options.extractionFailure };
      }
      const wanted = new Set(request.paths);
      return {
        status: 'ok',
        files: (options.files ?? []).filter((file) => wanted.has(file.path)),
      };
    },
  };
};

// ── One assembled fixture, because four tiers need the same one ──────────────

/**
 * Indexes {@link FIXTURE_VAULT} into a fresh in-memory store and hands back everything a test
 * needs to drive retrieval against it.
 *
 * It exists so the acceptance figure, the indexer's own tests, `kb_search`'s tests and the store
 * contract suite all measure the *same* corpus through the *same* parser. A second way of building
 * the fixture would be a second corpus, and standing rule 5 is about exactly that: a differential
 * result is evidence about the corpus, and whoever built it is the worst judge of what it omits.
 */
export const indexedFixtureVault = async (
  options: { readonly force?: boolean } = {},
): Promise<{
  readonly projectId: Id;
  readonly store: MemoryKnowledgeStore;
  readonly eventing: MemoryEventing;
  readonly report: IndexReport;
}> => {
  const projectId = '00000000-0000-4000-8000-00000000f1c7' as Id;
  const store = memoryKnowledgeStore();
  const eventing = new MemoryEventing();
  const indexer = createKnowledgeIndexer({
    vault: memoryVaultSource({
      status: 'ok',
      snapshot: vaultSnapshotOf(FIXTURE_VAULT, {
        commitSha: 'f1c7ea4',
        knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
        repoPaths: FIXTURE_REPO_PATHS,
      }),
    }),
    store,
    unitOfWork: eventing,
    eventStore: eventing.store,
    clock: fixedClock('2026-09-11T09:00:00.000Z'),
    ids: sequentialIds(900),
    logger: silentLogger,
  });
  const report = await indexer.index({
    projectId,
    projectKey: FIXTURE_PROJECT_KEY,
    knowledgeDir: FIXTURE_KNOWLEDGE_DIR,
    ...(options.force === undefined ? {} : { force: options.force }),
  });
  return { projectId, store, eventing, report };
};
