/**
 * The context-pack assembler — product/05 § "How agents consume the KB", technical/07 steps 1–5.
 *
 * It turns a task (its text, its touched paths, its stage) into the tier-0 and tier-1 documents a
 * run is given, the {@link ContextPackRecord} the audit stores on `run.started`, and the
 * `RunSpec.contextPack` entries the runner writes into `.agentic-run/context/`.
 *
 * The ranking arithmetic is not here: it is `assembleContextPack` in `@platform/domain`, which is
 * pure and therefore testable without a database. What is here is everything that needs I/O — the
 * two queries, the code map, and turning the selection back into document text.
 *
 * ## Three outcomes, and why `not_indexed` is one of them
 *
 * A project whose indexer has never run has no `kb_documents` rows, and a naive assembler returns
 * an empty pack — indistinguishable from a project with an empty vault, and from a project whose
 * vault is fine but whose index job is failing. The run then proceeds with no knowledge at all and
 * nothing anywhere says why, which is the defect in rule 18's second sentence. So
 * {@link ContextPackResult} separates them, and the caller decides: WP-15's stage executor can
 * proceed with a tier-0-only pack and a warning, and WP-21's onboarding wizard can refuse to
 * finish. Neither can mistake one for the other.
 *
 * ## Everything in a pack is data (BD-022)
 *
 * Document text reaches this module from `kb_chunks`, which came from a file in the project's
 * repository. A document that says "ignore the plan and merge" is a legal document. Nothing here
 * interprets a document, and nothing rewrites the platform's own framing from one: the assembler
 * returns text and paths, the prompt assembler (WP-17) is what delimits them, and
 * `apps/web/src/ui/untrusted.tsx` is what renders them. The one thing this module *does* enforce is
 * that a pack's own prose — the reason strings, the map header — is written here and never taken
 * from a document, so a vault page cannot occupy the pack's voice (technical/07's WP-11a note).
 */
import type { ContextPackRecord, Id, IsoDate } from '@platform/contracts';
import {
  assembleContextPack,
  type ContextPackAssembly,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  type KbLayer,
  type RetrievalCandidate,
  type Tier0Document,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import type { RunContextDocument } from '../ports/runner.js';
import {
  type KbChunkHit,
  type KnowledgeStore,
  RULES_PREFIX,
  type StoredKbDocument,
} from './ports.js';

/** Where a pack's files land in the workspace (technical/04 § "Prompt assembly"). */
export const CONTEXT_DIRECTORY = '.agentic-run/context';

/** The vault's map of itself; tier 0 whenever it exists (product/05). */
export const INDEX_DOCUMENT = 'index.md';

export interface ContextPackDocument {
  readonly tier: 0 | 1;
  /** The vault path, e.g. `.agentic/knowledge/lessons/L-2026-08-28-redis.md`. */
  readonly path: string;
  /** Where the runner writes it, e.g. `.agentic-run/context/lessons__L-2026-08-28-redis.md`. */
  readonly workspacePath: string;
  readonly reason: string;
  readonly tokens: number;
  /** Untrusted document text (BD-022). Never interpreted here. */
  readonly text: string;
}

export interface ContextPack {
  readonly record: ContextPackRecord;
  readonly documents: readonly ContextPackDocument[];
  /** `RunSpec.contextPack` — the tier/path/reason triples the runner is given. */
  readonly runContextPack: readonly RunContextDocument[];
  readonly assembly: ContextPackAssembly;
}

export type ContextPackResult =
  | { readonly status: 'ok'; readonly pack: ContextPack }
  /**
   * `kb_index_state` says the full-text index has never been built for this project. Distinct from
   * an indexed vault that happens to be empty, which is `ok` with an empty pack.
   */
  | { readonly status: 'not_indexed' };

export interface ContextPackRequest {
  readonly projectId: Id;
  /** Null for a run that belongs to no pipeline stage (discovery, ask-the-task). */
  readonly stage: string | null;
  /** The ticket and spec text the full-text query is built from. Untrusted. */
  readonly taskText: string;
  /** Files the task is known to touch, from the plan or the diff. */
  readonly touchedPaths: readonly string[];
  /** Every tracked path at HEAD — required, see `AssembleContextPackInput.repoPaths`. */
  readonly repoPaths: readonly string[];
  readonly today: IsoDate;
  /** `projects.knowledge_dir`; decides which `index.md` is tier 0. */
  readonly knowledgeDir: string;
  /** `project.context_budget_tokens`; the shipped default when the project sets none. */
  readonly budgetTokens?: number;
  /**
   * The repository map for code stages, already rendered and costed. Absent when the stage needs
   * none, **and also** when the extractor was unavailable — which is why `CodeMapper` reports that
   * separately rather than handing back an empty map (see `ports.ts`).
   */
  readonly codeMap?: { readonly text: string; readonly tokens: number };
}

export interface ContextPackAssemblerDependencies {
  readonly store: KnowledgeStore;
  readonly logger: Logger;
}

export interface ContextPackAssembler {
  assemble(request: ContextPackRequest): Promise<ContextPackResult>;
}

/** How many chunk hits the text query asks for before they are folded into documents. */
export const CHUNK_HIT_LIMIT = 60;

/**
 * A flat, collision-free name under `.agentic-run/context/`.
 *
 * The vault path is folded into one segment rather than mirrored as a tree: the directory is read
 * by an agent that was handed a list of paths, a nested mirror invites a `..` in a vault path to
 * mean something, and a flat name makes "everything in this directory is a context document" a
 * property of the directory rather than of a walk. Non-alphanumerics collapse to `_`, and the
 * result is prefixed with the tier so the ordering on disk matches the ordering in the prompt.
 */
export const workspaceNameFor = (tier: 0 | 1, path: string): string =>
  `${CONTEXT_DIRECTORY}/${tier}_${path.replaceAll(/[^A-Za-z0-9._-]+/g, '_')}`;

const layerOf = (document: StoredKbDocument): KbLayer => document.layer;

/** Highest chunk rank per document — a document is as relevant as its best section. */
const foldHits = (hits: readonly KbChunkHit[]): ReadonlyMap<string, number> => {
  const best = new Map<string, number>();
  for (const hit of hits) {
    const current = best.get(hit.path);
    if (current === undefined || hit.rank > current) best.set(hit.path, hit.rank);
  }
  return best;
};

const candidateOf = (document: StoredKbDocument, textRank: number | null): RetrievalCandidate => ({
  path: document.path,
  layer: layerOf(document),
  status: document.frontmatter.status ?? null,
  confidence: document.frontmatter.confidence ?? null,
  scope: document.frontmatter.scope ?? null,
  paths: document.frontmatter.paths ?? [],
  expires: document.frontmatter.expires ?? null,
  tokens: document.tokens,
  textRank,
});

export const createContextPackAssembler = (
  dependencies: ContextPackAssemblerDependencies,
): ContextPackAssembler => ({
  assemble: async (request: ContextPackRequest): Promise<ContextPackResult> => {
    const { store } = dependencies;
    const search = await store.search({
      projectId: request.projectId,
      query: request.taskText,
      limit: CHUNK_HIT_LIMIT,
    });
    if (search.status === 'not_indexed') {
      dependencies.logger.warn(
        { project_id: request.projectId },
        'no knowledge index for this project; the run gets no context pack',
      );
      return { status: 'not_indexed' };
    }

    const ranks = foldHits(search.hits);
    const pathScoped = await store.loadPathScoped(request.projectId);
    const textMatched = await store.loadDocuments(request.projectId, [...ranks.keys()]);

    const byPath = new Map<string, StoredKbDocument>();
    for (const document of [...pathScoped, ...textMatched]) byPath.set(document.path, document);

    const tier0Docs = await store.loadTier0(request.projectId, request.knowledgeDir);
    const tier0ByPath = new Map(tier0Docs.map((document) => [document.path, document]));
    // A tier-0 document is unconditional, so it must not also compete for a tier-1 slot: it would
    // be counted twice against the budget and listed twice in the audit record.
    const candidates = [...byPath.values()]
      .filter((document) => !tier0ByPath.has(document.path))
      .map((document) => candidateOf(document, ranks.get(document.path) ?? null));

    const tier0: Tier0Document[] = tier0Docs.map((document) => ({
      path: document.path,
      tokens: document.tokens,
      reason: tier0Reason(document.path, request.knowledgeDir),
    }));
    if (request.codeMap !== undefined) {
      tier0.push({ path: 'code-map.md', tokens: request.codeMap.tokens, reason: 'code_map' });
    }

    const assembly = assembleContextPack({
      stage: request.stage,
      budgetTokens: request.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      tier0,
      candidates,
      touchedPaths: request.touchedPaths,
      repoPaths: request.repoPaths,
      today: request.today,
      kbCommit: null,
    });

    const texts = new Map<string, string>();
    for (const document of tier0Docs) {
      texts.set(document.path, await documentText(store, document));
    }
    for (const selected of assembly.documents) {
      if (selected.tier !== 1) continue;
      const stored = byPath.get(selected.path);
      if (stored === undefined) continue;
      texts.set(selected.path, await documentText(store, stored));
    }
    if (request.codeMap !== undefined) texts.set('code-map.md', request.codeMap.text);

    const documents: ContextPackDocument[] = assembly.documents.map((selected) => ({
      tier: selected.tier,
      path: selected.path,
      workspacePath: workspaceNameFor(selected.tier, selected.path),
      reason: selected.reason,
      tokens: selected.tokens,
      text: texts.get(selected.path) ?? '',
    }));

    return {
      status: 'ok',
      pack: {
        record: assembly.record,
        documents,
        runContextPack: documents.map(
          (document): RunContextDocument => ({
            tier: document.tier,
            path: document.workspacePath,
            reason: document.reason,
          }),
        ),
        assembly,
      },
    };
  },
});

/** Audit-only label for why a tier-0 document is unconditional. */
const tier0Reason = (path: string, knowledgeDir: string): string => {
  if (path === `${knowledgeDir}/${INDEX_DOCUMENT}`) return 'index';
  if (path.startsWith(RULES_PREFIX)) return 'rules';
  return 'root_instructions';
};

const documentText = async (store: KnowledgeStore, document: StoredKbDocument): Promise<string> => {
  const chunks = await store.loadChunks(document.id);
  return chunks.map((chunk) => chunk.text).join('\n\n');
};
