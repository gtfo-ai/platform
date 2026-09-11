/**
 * `KnowledgeStore` on PostgreSQL — `kb_documents`, `kb_chunks`, `kb_links` and `kb_index_state`
 * (migration 0008, technical/03 § "Knowledge and code").
 *
 * ## The index run is a replace, inside one transaction
 *
 * `write` deletes the project's documents that the snapshot no longer has, upserts the rest, and
 * replaces each document's chunks and links wholesale. Chunk ordinals are dense and stable, so
 * "replace the rows" is simpler and cheaper than diffing them, and `kb_chunks.document_id` cascades
 * — the delete is one statement. All of it is bound to the caller's transaction: a half-applied
 * index is a vault that has lost pages nobody deleted.
 *
 * ## Search
 *
 * TD-008 phase 1: `websearch_to_tsquery('simple', …)` against the **generated**
 * `kb_chunks.search` column, ranked with `ts_rank_cd`. Three details that are not obvious:
 *
 *  - **The query is the caller's keywords joined with `OR`.** Bare words in
 *    `websearch_to_tsquery` are joined with **AND**, and measured over the fixture vault a
 *    ticket-shaped query of eleven words therefore matched **0 documents** — no page contains all
 *    of them. `OR` is what makes the step retrieve at all; see `KbSearchRequest.terms`.
 *  - **Nothing untrusted is concatenated.** The terms arrive already reduced to
 *    `[\p{L}\p{N}_]+`, so `join(' OR ')` cannot be handed an operator, a quote or a `:*`. The
 *    value still travels as a bound parameter, and `websearch_to_tsquery` is *total* — it never
 *    raises on malformed input the way `to_tsquery` does, which is why TD-008 names it and why a
 *    stray `&` in a ticket title cannot turn into a failing job (rule 20).
 *  - **The rank is normalised into `[0, 1]` here**, because `contextPackRecordSchema.score` is a
 *    unit interval and `ts_rank_cd` is unbounded above. Normalisation flag `32`
 *    (`rank / (rank + 1)`) is applied by PostgreSQL itself rather than by arithmetic on this side,
 *    so the bound is the database's guarantee and not a claim made in TypeScript.
 *
 * ## `not_indexed`
 *
 * Decided by `kb_index_state`, never by a row count: a project whose indexer has never run is a
 * different fact from a project whose vault says nothing about the query, and this is the only
 * place that can tell them apart (see `KnowledgeStore` in `@platform/application`).
 */
import {
  type IndexWrite,
  type KbChunkHit,
  type KbIndexState,
  type KbSearchRequest,
  type KbSearchResult,
  type KnowledgeStore,
  ROOT_TIER0_PATHS,
  RULES_PREFIX,
  type StoredKbDocument,
  type Transaction,
} from '@platform/application';
import {
  type Id,
  type IsoDateTime,
  type JsonObject,
  kbConfidenceWeight,
  kbFrontmatterSchema,
} from '@platform/contracts';
import { KB_LAYERS, type KbChunk, type KbLayer } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface DocumentRow extends Record<string, unknown> {
  readonly id: string;
  readonly path: string;
  readonly kind: string | null;
  readonly frontmatter: JsonObject;
  readonly tokens: number;
  readonly content_hash: string | null;
}

/**
 * `kb_documents` has no `layer` column — technical/03 gives it `type`, `kind`, `status`, `scope`
 * and `paths`, and adding a column for a value the path already determines would give it two
 * writers. It is stored in `kind`'s sibling position inside `frontmatter` under a platform-owned
 * key instead, written by `write` and read back here.
 */
const LAYER_KEY = '__layer';

const layerOf = (frontmatter: JsonObject): KbLayer => {
  const stored = frontmatter[LAYER_KEY];
  const known = KB_LAYERS.find((layer) => layer === stored);
  return known ?? 'other';
};

const toStoredDocument = (row: DocumentRow): StoredKbDocument => {
  const raw = row.frontmatter;
  const { [LAYER_KEY]: _layer, ...authored } = raw;
  const parsed = kbFrontmatterSchema.safeParse(authored);
  return {
    id: row.id as Id,
    path: row.path,
    layer: layerOf(raw),
    // The row was written from a parse that succeeded, so this one does too; a row that somehow
    // did not is read as a document with no vocabulary rather than throwing inside a live run.
    frontmatter: parsed.success ? parsed.data : {},
    rawFrontmatter: authored as JsonObject,
    tokens: row.tokens,
    contentHash: row.content_hash ?? '',
  };
};

const DOCUMENT_COLUMNS = 'id, path, kind, frontmatter, tokens, content_hash';

export class PostgresKnowledgeStore implements KnowledgeStore {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async write(tx: Transaction, input: IndexWrite): Promise<void> {
    const sql = sqlOf(tx);
    const keptPaths = input.documents.map((entry) => entry.document.path);
    // Remove what the snapshot no longer has. `removedPaths` is what the indexer computed; the
    // second clause covers a document that vanished between two runs of a full rebuild.
    await sql.query(
      `delete from kb_documents
        where project_id = $1
          and (path = any($2::text[]) or not (path = any($3::text[])))`,
      [input.projectId, input.removedPaths, keptPaths],
    );

    for (const entry of input.documents) {
      const { document } = entry;
      const frontmatter = { ...document.rawFrontmatter, [LAYER_KEY]: document.layer };
      const rows = await sql.query<{ id: string }>(
        `insert into kb_documents (
            project_id, path, commit_sha, type, kind, status, confidence, scope, paths,
            "trigger", expires, last_confirmed, frontmatter, content_hash, tokens, updated_at
          ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13::jsonb, $14, $15, now())
          on conflict (project_id, path) do update set
            commit_sha = excluded.commit_sha,
            type = excluded.type,
            kind = excluded.kind,
            status = excluded.status,
            confidence = excluded.confidence,
            scope = excluded.scope,
            paths = excluded.paths,
            "trigger" = excluded."trigger",
            expires = excluded.expires,
            last_confirmed = excluded.last_confirmed,
            frontmatter = excluded.frontmatter,
            content_hash = excluded.content_hash,
            tokens = excluded.tokens,
            updated_at = now()
          returning id`,
        [
          input.projectId,
          document.path,
          input.commitSha,
          document.frontmatter.type ?? null,
          document.frontmatter.kind ?? null,
          document.frontmatter.status ?? null,
          // product/05 writes a label; technical/03's column is a `real` in [0, 1]. The label
          // survives in `frontmatter`; the column stores the weight retrieval multiplies by.
          kbConfidenceWeight(document.frontmatter.confidence),
          document.frontmatter.scope ?? null,
          document.frontmatter.paths ?? [],
          document.frontmatter.trigger ?? null,
          document.frontmatter.expires ?? null,
          document.frontmatter.last_confirmed ?? null,
          JSON.stringify(frontmatter),
          entry.blobSha,
          document.tokens,
        ],
      );
      const documentId = rows.rows[0]?.id;
      if (documentId === undefined) {
        throw new Error(`kb_documents upsert returned no id for ${document.path}`);
      }

      await sql.query('delete from kb_chunks where document_id = $1', [documentId]);
      for (const chunk of document.chunks) {
        await sql.query(
          `insert into kb_chunks (document_id, heading_path, ordinal, "text", tokens)
             values ($1, $2, $3, $4, $5)`,
          [documentId, chunk.headingPath, chunk.ordinal, chunk.text, chunk.tokens],
        );
      }

      await sql.query('delete from kb_links where from_document_id = $1', [documentId]);
      for (const link of document.links) {
        await sql.query(
          `insert into kb_links (from_document_id, to_path, kind)
             values ($1, $2, $3)
             on conflict do nothing`,
          [documentId, link.toPath, link.kind],
        );
      }
    }

    // Resolve wikilinks to documents in the same project. Done after every document is written, so
    // a link to a page indexed later in the same run resolves rather than dangling.
    await sql.query(
      `update kb_links l
         set resolved_document_id = d.id
         from kb_documents d
        where d.project_id = $1
          and l.from_document_id in (select id from kb_documents where project_id = $1)
          and (d.path = l.to_path or d.path like '%/' || l.to_path or d.path like '%/' || l.to_path || '.md')`,
      [input.projectId],
    );

    await sql.query(
      `insert into kb_index_state (project_id, commit_sha, fts_built_at)
         values ($1, $2, now())
         on conflict (project_id) do update set
           commit_sha = excluded.commit_sha,
           fts_built_at = excluded.fts_built_at`,
      [input.projectId, input.commitSha],
    );
  }

  async readIndexState(projectId: Id): Promise<KbIndexState | null> {
    const { rows } = await this.#sql.query<{
      commit_sha: string | null;
      fts_built_at: Date | null;
    }>('select commit_sha, fts_built_at from kb_index_state where project_id = $1', [projectId]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      projectId,
      commitSha: row.commit_sha,
      ftsBuiltAt:
        row.fts_built_at === null
          ? null
          : (new Date(row.fts_built_at).toISOString() as IsoDateTime),
    };
  }

  async readIndexedBlobs(projectId: Id): Promise<ReadonlyMap<string, string>> {
    const { rows } = await this.#sql.query<{ path: string; content_hash: string | null }>(
      'select path, content_hash from kb_documents where project_id = $1',
      [projectId],
    );
    return new Map(rows.map((row) => [row.path, row.content_hash ?? '']));
  }

  async search(request: KbSearchRequest): Promise<KbSearchResult> {
    const state = await this.readIndexState(request.projectId);
    if (state === null || state.ftsBuiltAt === null) return { status: 'not_indexed' };
    // An empty `terms` list produces an empty expression, and **PostgreSQL is what makes that
    // correct**: `websearch_to_tsquery('simple', '')` builds an empty tsquery and `@@` against one
    // matches no row, so a query with no usable keywords finds nothing rather than everything.
    //
    // There is deliberately no `if (terms.length === 0)` guard in front of it. Round 2 of this work
    // package wrote a comment claiming there was one — describing a line a mutation-restore cycle
    // had already removed — and carried that phantom into a ledger entry and a mutation tally.
    // Standing rule 22 lets an unreachable branch be *declared at the line*; it does not let a
    // comment invent the line. So the mechanism is named here and the **behaviour** is what is
    // pinned, by `knowledge-store-suite.ts` › "finds nothing — not everything — for a query with no
    // keywords", which runs against this store at the integration tier.
    const expression = request.terms.join(' OR ');

    const { rows } = await this.#sql.query<{
      document_id: string;
      path: string;
      heading_path: string | null;
      text: string;
      rank: number;
    }>(
      `select c.document_id, d.path, c.heading_path, c."text",
              ts_rank_cd(c.search, websearch_to_tsquery('simple', $2), 32) as rank
         from kb_chunks c
         join kb_documents d on d.id = c.document_id
        where d.project_id = $1
          and c.search @@ websearch_to_tsquery('simple', $2)
        order by rank desc, d.path asc, c.ordinal asc
        limit $3`,
      [request.projectId, expression, request.limit],
    );

    return {
      status: 'ok',
      hits: rows.map(
        (row): KbChunkHit => ({
          documentId: row.document_id as Id,
          path: row.path,
          headingPath: row.heading_path ?? '',
          text: row.text,
          rank: Number(row.rank),
        }),
      ),
    };
  }

  async loadDocuments(
    projectId: Id,
    paths: readonly string[],
  ): Promise<readonly StoredKbDocument[]> {
    if (paths.length === 0) return [];
    const { rows } = await this.#sql.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from kb_documents
        where project_id = $1 and path = any($2::text[]) order by path`,
      [projectId, [...paths]],
    );
    return rows.map(toStoredDocument);
  }

  async loadPathScoped(projectId: Id): Promise<readonly StoredKbDocument[]> {
    const { rows } = await this.#sql.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from kb_documents
        where project_id = $1 and cardinality(paths) > 0 order by path`,
      [projectId],
    );
    return rows.map(toStoredDocument);
  }

  /**
   * The SQL half of `isTier0Path`.
   *
   * Two spellings of one rule is rule 41's shape, so the predicate is not trusted to agree: the
   * shared contract suite runs `isTier0Path` over the fixture vault and asserts this query returns
   * exactly the paths it selects, near-misses included. If the predicate changes and this does not,
   * that test fails by name.
   */
  async loadTier0(projectId: Id, knowledgeDir: string): Promise<readonly StoredKbDocument[]> {
    const { rows } = await this.#sql.query<DocumentRow>(
      `select ${DOCUMENT_COLUMNS} from kb_documents
        where project_id = $1
          and (path = $2 or path like $3 || '%' or path = any($4::text[]))
        order by path`,
      [projectId, `${knowledgeDir}/index.md`, RULES_PREFIX, [...ROOT_TIER0_PATHS]],
    );
    return rows.map(toStoredDocument);
  }

  async loadChunks(documentId: Id): Promise<readonly KbChunk[]> {
    const { rows } = await this.#sql.query<{
      heading_path: string | null;
      ordinal: number;
      text: string;
      tokens: number;
    }>(
      `select heading_path, ordinal, "text", tokens from kb_chunks
        where document_id = $1 order by ordinal`,
      [documentId],
    );
    return rows.map(
      (row): KbChunk => ({
        ordinal: row.ordinal,
        headingPath: row.heading_path ?? '',
        text: row.text,
        tokens: row.tokens,
      }),
    );
  }
}
