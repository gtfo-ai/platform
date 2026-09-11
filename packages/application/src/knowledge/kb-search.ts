/**
 * The `kb_search` platform tool — tier 2 of product/05's table, technical/07 step 5:
 *
 * > `kb_search` MCP tool exposes the same query for tier 2 (returns `path#heading` + snippet +
 * > score; never whole documents unless asked by path).
 *
 * It is one of the nine in-process MCP tools (`PlatformToolPort.kbSearch`), so **both ends are
 * untrusted**: the query is written by the model, and the excerpt is written by whoever can push to
 * the project's repository. Three consequences, each of which is a line of code here:
 *
 *  1. **The query is data.** It reaches `websearch_to_tsquery` through a parameter, never through
 *     string concatenation, and `limit` is bounded by the schema (`kbSearchInputSchema` caps it at
 *     50) and again here, because a model that asks for a million rows must get an answer rather
 *     than a timeout.
 *  2. **The answer's keys are the platform's and its values are the project's.** A document cannot
 *     add a key, cannot set `status`, and cannot make the tool claim something the platform did not
 *     say — the shape is built here from typed fields (technical/07's note on a provider forging
 *     the platform's own voice).
 *  3. **Snippets, not documents.** An excerpt is capped at {@link MAX_EXCERPT_CHARS}; a model that
 *     wants a whole page reads it by path with its ordinary file tools, inside the workspace, where
 *     the path guard applies.
 *
 * And the state that matters most: a project whose index has never been built gets
 * `status: "not_indexed"`, not an empty hit list. An agent told "no results" concludes the
 * knowledge base has nothing to say about the subject; an agent told "not indexed" can say so to a
 * human. They are different answers and the difference is free here and impossible downstream.
 */
import type { Id, JsonValue } from '@platform/contracts';
import type { Logger } from '../ports/logger.js';
import type { KbSearchInput } from '../ports/runner.js';
import type { KnowledgeStore } from './ports.js';

/** product/05's "returns `path#heading` + 2–3 lines". */
export const MAX_EXCERPT_CHARS = 400;

/** The tool's own ceiling, below `kbSearchInputSchema`'s max of 50. */
export const DEFAULT_SEARCH_LIMIT = 8;
export const MAX_SEARCH_LIMIT = 25;

export interface KbSearchToolDependencies {
  readonly store: KnowledgeStore;
  readonly logger: Logger;
}

export interface KbSearchHitPayload {
  /** `path#heading` when the chunk sits under a heading, otherwise the bare path. */
  readonly ref: string;
  readonly path: string;
  readonly heading_path: string;
  readonly excerpt: string;
  readonly score: number;
}

export type KbSearchToolPayload =
  | { readonly status: 'ok'; readonly hits: readonly KbSearchHitPayload[] }
  | { readonly status: 'not_indexed'; readonly hits: readonly [] };

/**
 * A chunk's text begins with the `project / path / H1 > H2` prefix the indexer wrote onto it
 * (technical/07). The excerpt is the body after that prefix: repeating the heading inside the
 * snippet wastes a third of a 2–3 line answer on something the `ref` field already says.
 */
const excerptOf = (text: string): string => {
  const at = text.indexOf('\n\n');
  const body = at === -1 ? text : text.slice(at + 2);
  const trimmed = body.trim();
  return trimmed.length <= MAX_EXCERPT_CHARS ? trimmed : `${trimmed.slice(0, MAX_EXCERPT_CHARS)}…`;
};

export const createKbSearchTool =
  (dependencies: KbSearchToolDependencies) =>
  async (projectId: Id, input: KbSearchInput): Promise<JsonValue> => {
    const limit = Math.min(input.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const result = await dependencies.store.search({
      projectId,
      query: input.query,
      limit,
    });
    if (result.status === 'not_indexed') {
      dependencies.logger.warn(
        { project_id: projectId },
        'kb_search on a project with no knowledge index',
      );
      return { status: 'not_indexed', hits: [] } satisfies KbSearchToolPayload as JsonValue;
    }
    const payload: KbSearchToolPayload = {
      status: 'ok',
      hits: result.hits.map((hit) => ({
        ref: hit.headingPath === '' ? hit.path : `${hit.path}#${hit.headingPath}`,
        path: hit.path,
        heading_path: hit.headingPath,
        excerpt: excerptOf(hit.text),
        score: hit.rank,
      })),
    };
    return payload as unknown as JsonValue;
  };
