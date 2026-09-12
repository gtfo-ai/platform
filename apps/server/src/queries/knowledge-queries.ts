/**
 * The reads behind `GET /api/projects/:id/kb/tree` and `/kb/doc` (WP-18b).
 *
 * Projections onto the published DTOs, like `pipeline-queries.ts` beside them, and with the same
 * rule about a column nothing writes: what cannot be projected is refused rather than invented.
 *
 * ## The vault these serve is the **index**, not the repository
 *
 * `kb_documents` and `kb_chunks` are derived, rebuildable rows (BD-012), written by the indexer
 * from the project's default branch. So the tree is the set of pages the platform *has indexed* at
 * `kb_index_state.commit_sha`, and a document's `content` is its chunks re-joined in order — not a
 * file read back from git. The difference is visible and worth stating: a page committed after the
 * last index run is not here, a page the parser refused is not here either, and the text is the
 * *sanitised* text the indexer stored (control characters replaced, technical/07).
 *
 * Serving the file itself would mean a vault read per request — a `git cat-file` against the bare
 * mirror (TD-026) on the API path — which is a different decision with a different cost, and one no
 * screen needs to make yet.
 *
 * ## Directories are synthesised, because the index has no rows for them
 *
 * `kbTreeResponseSchema` admits `kind: 'file' | 'directory'`, and nothing stores a directory. Every
 * prefix of every indexed path becomes one entry, with `tokens` summed over the pages beneath it
 * and `updated_at` the newest of them — which is what a tree view needs and what a reader would
 * otherwise compute from the file list themselves.
 */
import type { IsoDateTime, JsonObject, KbDocResponse, KbTreeResponse } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

const { kbChunks, kbDocuments, kbIndexState } = dbAdapters.schema;

/** The platform-owned frontmatter key the indexer writes the layer under; not the page's own. */
const LAYER_KEY = '__layer';

const withoutPlatformKeys = (frontmatter: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(frontmatter).filter(([key]) => key !== LAYER_KEY));

export const findKbTree = async (
  database: Database,
  projectId: string,
): Promise<KbTreeResponse> => {
  const [documents, state] = await Promise.all([
    database
      .select({
        path: kbDocuments.path,
        tokens: kbDocuments.tokens,
        updatedAt: kbDocuments.updatedAt,
      })
      .from(kbDocuments)
      .where(eq(kbDocuments.projectId, projectId))
      .orderBy(asc(kbDocuments.path)),
    database
      .select({ commitSha: kbIndexState.commitSha })
      .from(kbIndexState)
      .where(eq(kbIndexState.projectId, projectId))
      .limit(1),
  ]);

  const directories = new Map<string, { tokens: number; updatedAt: Date | null }>();
  for (const document of documents) {
    const segments = document.path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join('/');
      const existing = directories.get(prefix) ?? { tokens: 0, updatedAt: null };
      directories.set(prefix, {
        tokens: existing.tokens + document.tokens,
        updatedAt:
          existing.updatedAt === null || existing.updatedAt < document.updatedAt
            ? document.updatedAt
            : existing.updatedAt,
      });
    }
  }

  const entries: KbTreeResponse['entries'] = [
    ...[...directories.entries()].map(([path, summary]) => ({
      path,
      kind: 'directory' as const,
      tokens: summary.tokens,
      updated_at:
        summary.updatedAt === null ? null : (summary.updatedAt.toISOString() as IsoDateTime),
    })),
    ...documents.map((document) => ({
      path: document.path,
      kind: 'file' as const,
      tokens: document.tokens,
      updated_at: document.updatedAt.toISOString() as IsoDateTime,
    })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { commit_sha: state[0]?.commitSha ?? null, entries };
};

export const findKbDoc = async (
  database: Database,
  projectId: string,
  path: string,
): Promise<KbDocResponse | null> => {
  const documents = await database
    .select({
      id: kbDocuments.id,
      path: kbDocuments.path,
      commitSha: kbDocuments.commitSha,
      frontmatter: kbDocuments.frontmatter,
    })
    .from(kbDocuments)
    .where(and(eq(kbDocuments.projectId, projectId), eq(kbDocuments.path, path)))
    .limit(1);
  const document = documents[0];
  if (document === undefined) {
    return null;
  }
  const chunks = await database
    .select({ text: kbChunks.text })
    .from(kbChunks)
    .where(eq(kbChunks.documentId, document.id))
    .orderBy(asc(kbChunks.ordinal));

  return {
    path: document.path,
    commit_sha: document.commitSha,
    frontmatter: withoutPlatformKeys(document.frontmatter),
    // The chunker splits on headings and keeps each heading with its section, so joining with a
    // blank line reconstitutes readable Markdown. It is **not** byte-identical to the file: the
    // first chunk carries the `project / path / H1 > H2` prefix the indexer prepends for search,
    // and the text has been through the sanitiser. The route's description says so.
    content: chunks.map((chunk) => chunk.text).join('\n\n'),
  };
};
