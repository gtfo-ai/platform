/**
 * The knowledge base's ports — what WP-16 needs from the outside world, named here so the indexer,
 * the context-pack assembler and `kb_search` can be driven by fakes.
 *
 * Three of them, and one rule shared by all three: **"I could not" is never spelled as "there was
 * nothing"**. Every read returns a discriminated result rather than a possibly-empty list, because
 * the three states an operator has to be able to tell apart —
 *
 *   - the vault is *empty* (a new project that has not written anything yet),
 *   - the index has never been *built* (the indexer has not run, or the parser version moved),
 *   - the read *failed* (no checkout, a bad ref, an extractor that is not installed),
 *
 * — all produce zero rows if the port's return type is `Promise<Document[]>`. That collapse is
 * rule 18's shape, and it is the one that matters most here: a context pack built on "no results"
 * is a prompt with no knowledge in it and nothing anywhere saying why. WP-18 and WP-21 both build
 * on these types, so the distinction is in the type rather than in a convention.
 */
import type { Id, IsoDateTime, JsonObject, KbFrontmatter } from '@platform/contracts';
import type { CodeFileSymbols, KbChunk, KbLayer, ParsedKbDocument } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';

// ── The vault (the project's repository at its default branch) ───────────────

/** One Markdown file from the vault, with the git object id the indexer caches on. */
export interface VaultDocumentSource {
  /** Repository-relative, e.g. `.agentic/knowledge/lessons/L-2026-08-28-redis.md`. */
  readonly path: string;
  /** Relative to the vault root; `.agentic/rules/x.md` and `CLAUDE.md` keep their own path. */
  readonly vaultRelativePath: string;
  readonly source: string;
  /**
   * A digest of the bytes — `kb_documents.content_hash`, and how an unchanged file is skipped.
   *
   * Deliberately *a* digest and not *the git blob sha*: the filesystem adapter reads a checkout,
   * not an object database, and naming it `blobSha` would be a claim that nothing computes. What
   * the indexer needs is only that it changes when the content does.
   */
  readonly contentHash: string;
}

export interface VaultSnapshot {
  readonly commitSha: string;
  readonly documents: readonly VaultDocumentSource[];
  /**
   * Every tracked path in the repository at `commitSha`.
   *
   * Not optional. Validate-on-read (technical/07 step 3) drops a document whose cited paths have
   * vanished, and a snapshot that could omit this listing would produce packs in which nothing was
   * validated while every entry claimed `validated: true`.
   */
  readonly repoPaths: readonly string[];
}

export type VaultReadResult =
  | { readonly status: 'ok'; readonly snapshot: VaultSnapshot }
  /** No checkout, an unresolvable ref, a read error. Distinct from a vault with no documents. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface VaultReadRequest {
  readonly projectId: Id;
  /** `projects.knowledge_dir`, default `.agentic/knowledge` (technical/12). */
  readonly knowledgeDir: string;
  /** Pin the read to a commit; omitted means the default branch's head (BD-025). */
  readonly commitSha?: string;
}

export interface VaultSource {
  read(request: VaultReadRequest): Promise<VaultReadResult>;
}

// ── The index (`kb_documents`, `kb_chunks`, `kb_links`, `kb_index_state`) ────

/** A parsed document plus the identity the store needs to write it. */
export interface IndexableDocument {
  readonly document: ParsedKbDocument;
  readonly blobSha: string;
}

/** A document the parser refused — kept so the KB health report can name it (product/05). */
export interface InvalidDocument {
  readonly path: string;
  readonly reason: string;
  readonly line: number | null;
}

export interface IndexWrite {
  readonly projectId: Id;
  readonly commitSha: string;
  readonly documents: readonly IndexableDocument[];
  /** Paths present in the index that the snapshot no longer has. */
  readonly removedPaths: readonly string[];
}

export interface KbIndexState {
  readonly projectId: Id;
  readonly commitSha: string | null;
  readonly ftsBuiltAt: IsoDateTime | null;
}

/** A stored document as retrieval reads it back — the row, not the file. */
export interface StoredKbDocument {
  readonly id: Id;
  readonly path: string;
  readonly layer: KbLayer;
  readonly frontmatter: KbFrontmatter;
  readonly rawFrontmatter: JsonObject;
  readonly tokens: number;
  readonly contentHash: string;
}

export interface KbChunkHit {
  readonly documentId: Id;
  readonly path: string;
  readonly headingPath: string;
  readonly text: string;
  /** `ts_rank_cd` normalised into `[0, 1]` by the adapter, so the domain ring never sees SQL. */
  readonly rank: number;
}

export interface KbSearchRequest {
  readonly projectId: Id;
  /**
   * The query's **keywords**, already extracted by `extractQueryTerms` (`@platform/domain`).
   *
   * Terms and not a string, and the difference is not cosmetic. technical/07 step 2 says
   * "`websearch_to_tsquery('simple', <task keywords>)`" and round 1 passed the whole task text:
   * measured against a real PostgreSQL, `websearch_to_tsquery` joins bare words with **AND**, so a
   * ticket-shaped query matched **zero** documents in production while the in-memory double
   * returned fifteen. Handing the port a term list makes the `OR` the adapter's obvious job and
   * makes the fake's behaviour the same behaviour rather than a kinder one (standing rule 1).
   *
   * Every term is `[\p{L}\p{N}_]+` by construction, so no byte of untrusted ticket or
   * model-written text is ever concatenated into a tsquery expression — the adapter cannot be
   * handed an operator.
   *
   * An **empty** list is a legitimate value and means "this query had no usable keywords". It is
   * not the same as a query that found nothing, and a store must answer it with no hits rather
   * than with every document.
   */
  readonly terms: readonly string[];
  readonly limit: number;
}

export type KbSearchResult =
  | { readonly status: 'ok'; readonly hits: readonly KbChunkHit[] }
  /** `kb_index_state` has no row, or its `fts_built_at` is null — the index was never built. */
  | { readonly status: 'not_indexed' };

/**
 * Reads and writes the derived knowledge rows.
 *
 * Writes are transaction-bound for the same reason `PipelineStore`'s are: an index run replaces a
 * project's documents, chunks and links together or not at all, and a half-applied replacement is
 * a vault that has lost pages nobody deleted. Reads are not, because `kb_search` is called from a
 * live agent run that holds no transaction and must not open one (the dispatcher's pool floor
 * accounts for two connections per handler, not three).
 */
export interface KnowledgeStore {
  write(tx: Transaction, input: IndexWrite): Promise<void>;
  readIndexState(projectId: Id): Promise<KbIndexState | null>;
  /** Every indexed path with its blob sha — what makes an incremental run possible. */
  readIndexedBlobs(projectId: Id): Promise<ReadonlyMap<string, string>>;
  search(request: KbSearchRequest): Promise<KbSearchResult>;
  /** Full documents by path, for the tier-0 and tier-1 text a pack writes into the workspace. */
  loadDocuments(projectId: Id, paths: readonly string[]): Promise<readonly StoredKbDocument[]>;
  /**
   * Documents carrying a `paths:` frontmatter glob — the whole candidate set for technical/07's
   * step 1.
   *
   * Loaded in full rather than matched in SQL because the match is a *glob* against the task's
   * touched paths, and the matcher that decides it is `matchesRepoGlob` in the domain ring. Two
   * implementations of glob semantics — one in TypeScript for the pack, one in SQL for the query —
   * is rule 41's shape, and the SQL one would be the untested half. A vault is hundreds of
   * documents, not millions; when that stops being true the answer is a `paths`-derived index, not
   * a second matcher.
   */
  loadPathScoped(projectId: Id): Promise<readonly StoredKbDocument[]>;
  /**
   * The unconditional tier-0 documents — product/05's "Project `CLAUDE.md` (+ `AGENTS.md` if
   * present), unconditional `.agentic/rules`, `knowledge/index.md`".
   *
   * The selection rule is {@link isTier0Path}, which lives in this ring so that the two adapters
   * cannot drift from each other or from the prose: the shared contract suite runs the predicate
   * over a fixture vault and asserts the store returns exactly what it selects, near-misses
   * included (rule 44 — a scope claim has to be enforced by the same check that enforces the
   * scope).
   */
  loadTier0(projectId: Id, knowledgeDir: string): Promise<readonly StoredKbDocument[]>;
  /** Chunk text for a document, in order — how a pack reconstitutes the page it will write out. */
  loadChunks(documentId: Id): Promise<readonly KbChunk[]>;
}

// ── The code map's symbol extractor (TD-010) ────────────────────────────────

export interface SymbolExtractorProbe {
  readonly available: boolean;
  /** The tool's own version string when available; the refusal reason when not. */
  readonly detail: string;
}

export type SymbolExtractionResult =
  | { readonly status: 'ok'; readonly files: readonly CodeFileSymbols[] }
  /**
   * The extractor is not installed, or is the wrong implementation.
   *
   * This is **not** an empty file list, and nothing in this package is allowed to turn it into one:
   * a code map rendered from zero symbols looks exactly like a correct map of an empty repository,
   * and the tier-0 slot it occupies would then be silently filled with nothing for the life of the
   * deployment. See `docs/OPEN-QUESTIONS.md` Q57.
   */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface SymbolExtractionRequest {
  /** Absolute path of a checkout to scan. */
  readonly rootPath: string;
  /** Repository-relative paths to extract; the caller has already filtered to source files. */
  readonly paths: readonly string[];
}

export interface SymbolExtractor {
  /** Stable identity written into the map's provenance (`universal-ctags`, `fake`). */
  readonly id: string;
  probe(): Promise<SymbolExtractorProbe>;
  extract(request: SymbolExtractionRequest): Promise<SymbolExtractionResult>;
}

/** `code_files` and `code_maps` (technical/03): both caches, both keyed by content. */
export interface CodeMapStore {
  readSymbols(projectId: Id, blobShas: readonly string[]): Promise<readonly CodeFileSymbols[]>;
  writeSymbols(
    tx: Transaction,
    projectId: Id,
    entries: readonly { readonly blobSha: string; readonly file: CodeFileSymbols }[],
  ): Promise<void>;
  readMap(
    projectId: Id,
    key: { readonly commitSha: string; readonly focusHash: string; readonly tokenBudget: number },
  ): Promise<string | null>;
  writeMap(
    tx: Transaction,
    projectId: Id,
    key: { readonly commitSha: string; readonly focusHash: string; readonly tokenBudget: number },
    mapText: string,
  ): Promise<void>;
}

/** `.agentic/rules/**` — always-on instructions, product/05's Rules layer. */
export const RULES_PREFIX = '.agentic/rules/';

/** Repository-root documents that are tier 0 whenever they exist (product/05, technical/07). */
export const ROOT_TIER0_PATHS: readonly string[] = ['CLAUDE.md', 'AGENTS.md'];

/**
 * Whether an indexed path is unconditional tier-0 context.
 *
 * Deliberately **not** "any document at the vault root": a project that keeps loose pages beside
 * `index.md` would otherwise have every one of them injected into every run unconditionally, which
 * is the bulk-loading product/05 § "Curated, not dumped" exists to prevent. The rule names the four
 * things product/05 names and nothing else.
 */
export const isTier0Path = (path: string, knowledgeDir: string): boolean =>
  path === `${knowledgeDir}/index.md` ||
  path.startsWith(RULES_PREFIX) ||
  ROOT_TIER0_PATHS.includes(path);
