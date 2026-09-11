/**
 * `CodeMapStore` on PostgreSQL — `code_files` and `code_maps` (migration 0008, technical/03).
 *
 * Both tables are caches of derived data keyed by content, which is what makes them safe to write
 * outside the pipeline's transaction boundaries and safe to drop entirely:
 *
 *  - `code_files` is keyed `(project_id, blob_sha)`, so a file whose bytes have not changed is
 *    never re-scanned even when it moves. The `path` column travels with the row because the graph
 *    needs it, and a rename therefore updates the row rather than inserting a second one — the
 *    conflict target is the sha, not the path.
 *  - `code_maps` is keyed `(project_id, commit_sha, focus_hash)` with the token budget stored
 *    beside it, exactly as technical/07 specifies the cache. A map is rendered for one budget, so a
 *    read must match the budget too or it would hand back a 4 000-token map to a caller who asked
 *    for 1 000 — which is why the budget is part of the lookup even though the primary key stops at
 *    the focus hash.
 */
import type { CodeMapStore, Transaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import type { CodeFileSymbols, CodeSymbol } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface StoredSymbols {
  readonly definitions: readonly CodeSymbol[];
  readonly references: readonly string[];
}

export class PostgresCodeMapStore implements CodeMapStore {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async readSymbols(
    projectId: Id,
    blobShas: readonly string[],
  ): Promise<readonly CodeFileSymbols[]> {
    if (blobShas.length === 0) return [];
    const { rows } = await this.#sql.query<{
      path: string;
      language: string | null;
      symbols: StoredSymbols;
    }>(
      `select path, language, symbols from code_files
        where project_id = $1 and blob_sha = any($2::text[])`,
      [projectId, [...blobShas]],
    );
    return rows.map(
      (row): CodeFileSymbols => ({
        path: row.path,
        language: row.language,
        definitions: row.symbols.definitions ?? [],
        references: row.symbols.references ?? [],
      }),
    );
  }

  async writeSymbols(
    tx: Transaction,
    projectId: Id,
    entries: readonly { readonly blobSha: string; readonly file: CodeFileSymbols }[],
  ): Promise<void> {
    const sql = sqlOf(tx);
    for (const entry of entries) {
      await sql.query(
        `insert into code_files (project_id, blob_sha, path, language, symbols)
           values ($1, $2, $3, $4, $5::jsonb)
           on conflict (project_id, blob_sha) do update set
             path = excluded.path,
             language = excluded.language,
             symbols = excluded.symbols`,
        [
          projectId,
          entry.blobSha,
          entry.file.path,
          entry.file.language,
          JSON.stringify({
            definitions: entry.file.definitions,
            references: entry.file.references,
          } satisfies StoredSymbols),
        ],
      );
    }
  }

  async readMap(
    projectId: Id,
    key: { readonly commitSha: string; readonly focusHash: string; readonly tokenBudget: number },
  ): Promise<string | null> {
    const { rows } = await this.#sql.query<{ map_text: string }>(
      `select map_text from code_maps
        where project_id = $1 and commit_sha = $2 and focus_hash = $3 and token_budget = $4`,
      [projectId, key.commitSha, key.focusHash, key.tokenBudget],
    );
    return rows[0]?.map_text ?? null;
  }

  async writeMap(
    tx: Transaction,
    projectId: Id,
    key: { readonly commitSha: string; readonly focusHash: string; readonly tokenBudget: number },
    mapText: string,
  ): Promise<void> {
    await sqlOf(tx).query(
      `insert into code_maps (project_id, commit_sha, focus_hash, token_budget, map_text)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, commit_sha, focus_hash) do update set
           token_budget = excluded.token_budget,
           map_text = excluded.map_text,
           created_at = now()`,
      [projectId, key.commitSha, key.focusHash, key.tokenBudget, mapText],
    );
  }
}
