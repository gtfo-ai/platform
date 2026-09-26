/**
 * `RepositoryConfigStore` on PostgreSQL — `project_repository_config` (migration 0050, WP-63).
 *
 * One statement each way and no transaction: the reading is derived state the next reading
 * replaces (BD-012), and it is written by a caller that has just spent seconds in `git` with no
 * connection held. The row is **replaced**, never merged, because a snapshot is one reading of one
 * commit and half of two readings would describe no commit at all.
 *
 * A stored row is read back through the port's own shape rather than cast: `config` is re-checked
 * to be an object and `not_applied` to be a list of `{key, reason}`, and a row that fails either is
 * read as `invalid` with a sentence saying so — the refusal direction (standing rule 20), because
 * the alternative is a run on a configuration nobody can name.
 */
import type { RepositoryConfigSnapshot, RepositoryConfigStore } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { ConfigValues } from '@platform/domain';
import type { SqlExecutor } from '../events/sql.js';

interface Row extends Record<string, unknown> {
  readonly status: string;
  readonly commit_sha: string;
  readonly config: unknown;
  readonly not_applied: unknown;
  readonly detail: string | null;
  readonly read_at: Date | string;
}

const isoOf = (value: Date | string): IsoDateTime =>
  (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) as IsoDateTime;

const notAppliedOf = (raw: unknown): { key: string; reason: string }[] | null => {
  if (!Array.isArray(raw)) return null;
  const items: { key: string; reason: string }[] = [];
  for (const entry of raw) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { key?: unknown }).key !== 'string' ||
      typeof (entry as { reason?: unknown }).reason !== 'string'
    ) {
      return null;
    }
    items.push({
      key: (entry as { key: string }).key,
      reason: (entry as { reason: string }).reason,
    });
  }
  return items;
};

/** A stored row, as the port's snapshot. Exported so the refusal direction is driven directly. */
export const snapshotOfRow = (row: Row): RepositoryConfigSnapshot => {
  const readAt = isoOf(row.read_at);
  const commitSha = row.commit_sha;
  if (row.status === 'absent') {
    return { status: 'absent', commitSha, readAt };
  }
  if (row.status === 'valid') {
    const notApplied = notAppliedOf(row.not_applied);
    if (
      typeof row.config === 'object' &&
      row.config !== null &&
      !Array.isArray(row.config) &&
      notApplied !== null
    ) {
      return {
        status: 'valid',
        commitSha,
        readAt,
        values: row.config as ConfigValues,
        notApplied,
      };
    }
    return {
      status: 'invalid',
      commitSha,
      readAt,
      detail:
        'the stored reading of the repository configuration is not the shape this release writes; re-read it (POST /api/projects/:project_id/config/refresh)',
    };
  }
  return {
    status: 'invalid',
    commitSha,
    readAt,
    detail: row.detail ?? `the stored reading has status ${JSON.stringify(row.status)}`,
  };
};

export const createPostgresRepositoryConfigStore = (sql: SqlExecutor): RepositoryConfigStore => ({
  record: async (projectId: Id, snapshot: RepositoryConfigSnapshot): Promise<void> => {
    await sql.query(
      `insert into project_repository_config
         (project_id, status, commit_sha, config, not_applied, detail, read_at)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
       on conflict (project_id) do update set
         status = excluded.status,
         commit_sha = excluded.commit_sha,
         config = excluded.config,
         not_applied = excluded.not_applied,
         detail = excluded.detail,
         read_at = excluded.read_at`,
      [
        projectId,
        snapshot.status,
        snapshot.commitSha,
        snapshot.status === 'valid' ? JSON.stringify(snapshot.values) : null,
        JSON.stringify(snapshot.status === 'valid' ? snapshot.notApplied : []),
        snapshot.status === 'invalid' ? snapshot.detail : null,
        snapshot.readAt,
      ],
    );
  },
  read: async (projectId: Id): Promise<RepositoryConfigSnapshot | null> => {
    const { rows } = await sql.query<Row>(
      `select status, commit_sha, config, not_applied, detail, read_at
         from project_repository_config where project_id = $1`,
      [projectId],
    );
    const row = rows[0];
    return row === undefined ? null : snapshotOfRow(row);
  },
});
