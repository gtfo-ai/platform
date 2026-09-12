/**
 * `KnowledgeIndexer` — technical/07 § "Source of truth and sync".
 *
 * > `git diff --name-only <last_indexed>..<head>` restricted to `knowledge_dir`, `.agentic/rules`,
 * > `CLAUDE.md`, `AGENTS.md` → parse frontmatter → split into chunks by heading → upsert
 * > `kb_documents`, `kb_chunks`, `kb_links` → update `kb_index_state`. Full rebuild on demand or
 * > when the parser version changes.
 *
 * ## Two decisions that differ from the literal reading
 *
 * **The skip is by commit, and the write is a replace.** A `git diff` range would let the indexer
 * parse only the changed files — and then the write would have to be a *merge*, which is the shape
 * that loses pages: a document whose parse started failing this run has to be removed, a document
 * that was invalid last run has to be retried, and both are invisible to a name-only diff. So the
 * indexer parses the whole vault and replaces the project's rows, and the only thing the commit sha
 * buys is the early exit. That exit is safe because `kb_index_state` is written **inside the same
 * transaction** as the documents: a run that failed halfway left no state row, so the next run does
 * the work rather than believing it is already done.
 *
 * **`force` is the parser-version bump.** Re-parsing identical bytes with a new parser is the one
 * case the commit sha cannot see, and {@link KB_PARSER_VERSION} names it.
 *
 * ## What it refuses to do
 *
 * **It never empties the index because a read failed.** `VaultSource.read` distinguishes
 * `unavailable` from a snapshot with no documents, and only the second one removes rows. A missing
 * checkout deleting a project's whole knowledge base — and every later context pack being silently
 * empty — is the exact shape rule 18 names.
 *
 * **It never indexes a document it could not parse.** An invalid document is reported, counted and
 * left out; it is not written as a document with no frontmatter, because that spelling makes
 * `paths:`-scoped injection stop happening with nothing to show for it.
 *
 * **The invalid list is still only logged, and WP-18b's health report is not built from it.** That
 * work package created `kb_health_reports` and the nightly pass that writes one, and the pass reads
 * the *index* — expired pages, dangling links, duplicated ids, oversized pages. A document the
 * parser refused is in none of those, because it is in no table: `IndexReport.invalid` lives for
 * the length of one job. Joining the two means either storing the refusals or running the pass
 * inside the index run, and neither was WP-18b's to decide.
 */
import { type Id, knowledgeIndexRebuiltEvent } from '@platform/contracts';
import { type Clock, type IdSource, parseKbDocument } from '@platform/domain';
import type { EventStore } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { IndexableDocument, InvalidDocument, KnowledgeStore, VaultSource } from './ports.js';

/**
 * Bumped whenever {@link parseKbDocument} changes what it produces from the same bytes.
 *
 * It is compared against nothing today — there is no column for it (technical/03's
 * `kb_index_state` has `commit_sha`, `fts_built_at`, `embeddings_built_at`, `embedding_model`) —
 * and a `force` rebuild is how an operator applies a parser change. Stated here, and in the
 * `IndexReport`, so that the version a row was built by is at least visible in the log. **WP-18b
 * did not wire it to a column either** — it writes to the vault, which is what that sentence used
 * to promise, and it touches `kb_index_state` not at all. Whoever adds the column owns the rebuild
 * that a version bump implies.
 */
export const KB_PARSER_VERSION = 1;

export type IndexStatus =
  /** Documents were parsed and the index was replaced. */
  | 'indexed'
  /** Every blob sha matched what the index already had; nothing was written. */
  | 'unchanged'
  /** The vault could not be read. The existing index is untouched. */
  | 'vault_unavailable';

export interface IndexReport {
  readonly status: IndexStatus;
  readonly parserVersion: number;
  readonly commitSha: string | null;
  readonly documents: number;
  readonly chunks: number;
  readonly tokens: number;
  readonly invalid: readonly InvalidDocument[];
  readonly removed: readonly string[];
  /** Paths whose content exceeded `MAX_CHUNKS_PER_DOCUMENT` and was cut (product/05 budgets). */
  readonly truncated: readonly string[];
  /** Set only for `vault_unavailable`. */
  readonly reason: string | null;
}

export interface IndexRequest {
  readonly projectId: Id;
  /** `projects.key`, prefixed onto every chunk so a hit says which project it came from. */
  readonly projectKey: string;
  readonly knowledgeDir: string;
  /** Re-parse every document even when its blob sha is unchanged (parser-version bump). */
  readonly force?: boolean;
  readonly commitSha?: string;
}

export interface KnowledgeIndexerDependencies {
  readonly vault: VaultSource;
  readonly store: KnowledgeStore;
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: EventStore;
  readonly clock: Clock;
  readonly ids: IdSource;
  readonly logger: Logger;
}

export interface KnowledgeIndexer {
  index(request: IndexRequest): Promise<IndexReport>;
}

/** `projects.knowledge_dir` plus the three paths technical/07 indexes outside it. */
export const ALWAYS_INDEXED_PATHS: readonly string[] = ['CLAUDE.md', 'AGENTS.md'];
export const RULES_DIR = '.agentic/rules';

const unavailable = (reason: string): IndexReport => ({
  status: 'vault_unavailable',
  parserVersion: KB_PARSER_VERSION,
  commitSha: null,
  documents: 0,
  chunks: 0,
  tokens: 0,
  invalid: [],
  removed: [],
  truncated: [],
  reason,
});

export const createKnowledgeIndexer = (
  dependencies: KnowledgeIndexerDependencies,
): KnowledgeIndexer => ({
  index: async (request: IndexRequest): Promise<IndexReport> => {
    const read = await dependencies.vault.read({
      projectId: request.projectId,
      knowledgeDir: request.knowledgeDir,
      ...(request.commitSha === undefined ? {} : { commitSha: request.commitSha }),
    });
    if (read.status === 'unavailable') {
      dependencies.logger.warn(
        { project_id: request.projectId, reason: read.reason },
        'knowledge vault unavailable; the existing index is left in place',
      );
      return unavailable(read.reason);
    }

    const { snapshot } = read;
    const known = await dependencies.store.readIndexedBlobs(request.projectId);
    const state = await dependencies.store.readIndexState(request.projectId);

    const seenPaths = new Set(snapshot.documents.map((document) => document.path));
    const removed = [...known.keys()].filter((path) => !seenPaths.has(path)).sort();

    const alreadyAtCommit = state?.commitSha === snapshot.commitSha && state.ftsBuiltAt !== null;
    if (alreadyAtCommit && request.force !== true) {
      return {
        status: 'unchanged',
        parserVersion: KB_PARSER_VERSION,
        commitSha: snapshot.commitSha,
        documents: known.size,
        chunks: 0,
        tokens: 0,
        invalid: [],
        removed: [],
        truncated: [],
        reason: null,
      };
    }

    const documents: IndexableDocument[] = [];
    const invalid: InvalidDocument[] = [];
    const truncated: string[] = [];

    for (const source of snapshot.documents) {
      const parse = parseKbDocument({
        path: source.path,
        vaultRelativePath: source.vaultRelativePath,
        source: source.source,
        projectKey: request.projectKey,
      });
      if (parse.status === 'invalid') {
        invalid.push({ path: source.path, reason: parse.reason, line: parse.line });
        continue;
      }
      if (parse.document.truncated) truncated.push(source.path);
      documents.push({ document: parse.document, blobSha: source.contentHash });
    }

    const chunks = documents.reduce((total, entry) => total + entry.document.chunks.length, 0);
    const tokens = documents.reduce((total, entry) => total + entry.document.tokens, 0);

    const streamSeq = await dependencies.eventStore.nextStreamSequence(
      'project',
      request.projectId,
    );
    const occurredAt = dependencies.clock.now();

    await dependencies.unitOfWork.transaction(async (scope) => {
      await dependencies.store.write(scope.tx, {
        projectId: request.projectId,
        commitSha: snapshot.commitSha,
        documents,
        removedPaths: removed,
      });
      await scope.events.append([
        knowledgeIndexRebuiltEvent.parse({
          id: dependencies.ids.next(),
          stream_type: 'project',
          stream_id: request.projectId,
          stream_seq: streamSeq,
          actor: { kind: 'system', component: 'knowledge-indexer' },
          occurred_at: occurredAt,
          type: 'knowledge.index.rebuilt',
          payload: {
            project_id: request.projectId,
            commit_sha: snapshot.commitSha,
            documents: documents.length,
            chunks,
            tokens,
          },
        }),
      ]);
    });

    if (invalid.length > 0) {
      dependencies.logger.warn(
        { project_id: request.projectId, invalid: invalid.length },
        'knowledge documents refused by the parser and left out of the index',
      );
    }

    return {
      status: 'indexed',
      parserVersion: KB_PARSER_VERSION,
      commitSha: snapshot.commitSha,
      documents: documents.length,
      chunks,
      tokens,
      invalid,
      removed,
      truncated,
      reason: null,
    };
  },
});

/** Whether a repository path belongs to the vault technical/07 indexes. */
export const isIndexedVaultPath = (path: string, knowledgeDir: string): boolean =>
  path.endsWith('.md') &&
  (path.startsWith(`${knowledgeDir}/`) ||
    path.startsWith(`${RULES_DIR}/`) ||
    ALWAYS_INDEXED_PATHS.includes(path));

/**
 * The vault-relative path a document is chunked and layered under.
 *
 * `.agentic/rules/x.md` becomes `rules/x.md` so that `kbLayerOf` reads it as product/05's Rules
 * layer — rules live outside `knowledge_dir` in the repository but are a layer of the vault.
 * Anything else outside the knowledge directory keeps its path, so `CLAUDE.md` stays a single
 * segment and lands in `root`. One function, used by the filesystem adapter and by the in-memory
 * double, because two spellings of "which layer is this" would rank the same vault differently in
 * two tiers.
 */
export const vaultRelativePath = (path: string, knowledgeDir: string): string => {
  if (path.startsWith(`${knowledgeDir}/`)) return path.slice(knowledgeDir.length + 1);
  if (path.startsWith(`${RULES_DIR}/`)) return `rules/${path.slice(RULES_DIR.length + 1)}`;
  return path;
};
