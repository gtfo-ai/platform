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
 *
 * **A `patterns` row serves no prompt text** (migration 0073, WP-121, TD-012's M7 amendment (1),
 * PROGRESS backlog 359). Every reader of a stored reading — this store, the pipeline's settings port
 * and `GET …/config` (`apps/server/src/config-layers.ts`) — goes through {@link snapshotOfRow}, and
 * that is where a row the exact-value pass never ran over loses its prompts: the planner gets none
 * and the reading says why (`promptsWithheld`). A row whose mark is missing or unknown is read the
 * same way (standing rule 20): the column is `not null`, so only a caller's hand-built row lacks it.
 */
import {
  isProjectPromptPath,
  MAX_PROJECT_PROMPT_FILES,
  PATTERN_READING_WITHHELD_REASON,
  type PatternReadingStore,
  type ProjectPromptReading,
  type PromptsWithheld,
  type RepositoryConfigSnapshot,
  type RepositoryConfigStore,
  type RepositoryFileEntry,
} from '@platform/application';
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
  /** Migration 0063 (WP-92). Absent from a caller's row is the same as `null`: not read. */
  readonly prompts?: unknown;
  /**
   * Migration 0073 (WP-121): `patterns` or `exact`. Absent, or any other value, is read as
   * `patterns` — no prompt text served (rule 20).
   */
  readonly prompts_redaction?: unknown;
  /** Migration 0073: why the reading holds no prompt texts, or `null`. */
  readonly prompts_withheld?: unknown;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One stored prompt entry as the reader's own shape, or `null` when it is not one. */
const promptEntryOf = (raw: unknown): RepositoryFileEntry | null => {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'file' && typeof raw.text === 'string' && typeof raw.blobSha === 'string') {
    return { kind: 'file', text: raw.text, blobSha: raw.blobSha };
  }
  if (raw.kind === 'oversized' && typeof raw.bytes === 'number') {
    return { kind: 'oversized', bytes: raw.bytes };
  }
  if (raw.kind === 'not_a_file' && typeof raw.mode === 'string') {
    return { kind: 'not_a_file', mode: raw.mode };
  }
  return null;
};

/**
 * `prompts` read back through the port's shape (WP-92). A column that is not the shape this release
 * writes — an unknown entry kind, a path the reader would not list, more entries than it lists — is
 * read as **not read** (`undefined`), so a named prompt file is rendered `unread` rather than handed
 * to a stage from a row nobody can vouch for.
 */
export const promptReadingOfColumn = (raw: unknown): ProjectPromptReading | undefined => {
  if (!isRecord(raw) || !isRecord(raw.files) || typeof raw.truncated !== 'boolean') {
    return undefined;
  }
  const entries = Object.entries(raw.files);
  if (entries.length > MAX_PROJECT_PROMPT_FILES) return undefined;
  const files: Record<string, RepositoryFileEntry> = {};
  for (const [path, value] of entries) {
    const entry = promptEntryOf(value);
    if (entry === null || !isProjectPromptPath(path)) return undefined;
    files[path] = entry;
  }
  return { files, truncated: raw.truncated };
};

/**
 * `prompts_withheld` read back through the port's shape (WP-121), or `undefined` for `null`. A
 * column that is not the shape this release writes is read as the bare sentence below rather than
 * dropped: something was withheld, and a reader must not be told nothing was.
 */
export const promptsWithheldOfColumn = (raw: unknown): PromptsWithheld | undefined => {
  if (raw === null || raw === undefined) return undefined;
  if (isRecord(raw) && typeof raw.reason === 'string' && Array.isArray(raw.integrations)) {
    const integrations = raw.integrations.flatMap((entry) =>
      isRecord(entry) && typeof entry.integration === 'string' && typeof entry.reason === 'string'
        ? [{ integration: entry.integration, reason: entry.reason }]
        : [],
    );
    if (integrations.length === raw.integrations.length && raw.reason.length > 0) {
      return { reason: raw.reason, integrations };
    }
  }
  return {
    reason:
      'the stored reading withheld its prompt texts and its record of why is not the shape this release writes; re-read it (POST /api/projects/:project_id/config/refresh)',
    integrations: [],
  };
};

/** A stored row, as the port's snapshot. Exported so the refusal direction is driven directly. */
export const snapshotOfRow = (row: Row): RepositoryConfigSnapshot => {
  const state = snapshotStateOfRow(row);
  const withheld = promptsWithheldOfColumn(row.prompts_withheld);
  // WP-121 (backlog 359): a reading the exact-value pass never ran over serves no prompt text, and
  // says why — the recorded failure of a re-read when there was one, the standing sentence if not.
  if (row.prompts_redaction !== 'exact') {
    return {
      ...state,
      promptsWithheld: withheld ?? { reason: PATTERN_READING_WITHHELD_REASON, integrations: [] },
    };
  }
  if (withheld !== undefined) {
    // The constraint keeps `prompts` null beside a withheld record; read as withheld either way.
    return { ...state, promptsWithheld: withheld };
  }
  const prompts = promptReadingOfColumn(row.prompts ?? null);
  return prompts === undefined ? state : { ...state, prompts };
};

const snapshotStateOfRow = (row: Row): RepositoryConfigSnapshot => {
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
  record: async (
    projectId: Id,
    snapshot: RepositoryConfigSnapshot,
    condition?: { readonly overPatternsOnly: true },
  ): Promise<boolean> => {
    const { rowCount } = await sql.query(
      `insert into project_repository_config
         (project_id, status, commit_sha, config, not_applied, detail, read_at, prompts,
         prompts_redaction, prompts_withheld)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, 'exact', $9::jsonb)
       on conflict (project_id) do update set
         status = excluded.status,
         commit_sha = excluded.commit_sha,
         config = excluded.config,
         not_applied = excluded.not_applied,
         detail = excluded.detail,
         read_at = excluded.read_at,
         prompts = excluded.prompts,
         prompts_redaction = excluded.prompts_redaction,
         prompts_withheld = excluded.prompts_withheld
       ${
         // WP-121 review round 1: the upgrade re-read replaces only a row still `patterns`; an
         // `exact` row was recorded by a reader after it read, and is the newer truth.
         condition?.overPatternsOnly === true
           ? "where project_repository_config.prompts_redaction = 'patterns'"
           : ''
}`,
      [
        projectId,
        snapshot.status,
        snapshot.commitSha,
        snapshot.status === 'valid' ? JSON.stringify(snapshot.values) : null,
        JSON.stringify(snapshot.status === 'valid' ? snapshot.notApplied : []),
        snapshot.status === 'invalid' ? snapshot.detail : null,
        snapshot.readAt,
        // A withheld reading stores no prompt text (the table's constraint holds the pair).
        snapshot.prompts === undefined || snapshot.promptsWithheld !== undefined
          ? null
          : JSON.stringify(snapshot.prompts),
        snapshot.promptsWithheld === undefined ? null : JSON.stringify(snapshot.promptsWithheld),
      ],
    );
    // An insert or an update both count 1; a conflict the `where` refused counts 0.
    return (rowCount ?? 0) > 0;
  },
  read: async (projectId: Id): Promise<RepositoryConfigSnapshot | null> => {
    const { rows } = await sql.query<Row>(
      `select status, commit_sha, config, not_applied, detail, read_at, prompts,
              prompts_redaction, prompts_withheld
         from project_repository_config where project_id = $1`,
      [projectId],
    );
    const row = rows[0];
    return row === undefined ? null : snapshotOfRow(row);
  },
});

/**
 * `PatternReadingStore` on the same table (WP-121, TD-012's M7 amendment (1)): the `patterns` rows
 * the re-read pass works through, and the write that records why one could not be read again.
 */
export const createPostgresPatternReadingStore = (sql: SqlExecutor): PatternReadingStore => ({
  patternReadings: async (limit: number, excluding: readonly Id[]): Promise<readonly Id[]> => {
    const { rows } = await sql.query<{ project_id: string }>(
      `select project_id from project_repository_config
        where prompts_redaction = 'patterns' and not (project_id = any($2::uuid[]))
        order by read_at, project_id
        limit $1`,
      [limit, [...excluding]],
    );
    return rows.map((row) => row.project_id as Id);
  },
  withholdPatternReading: async (projectId: Id, withheld: PromptsWithheld): Promise<void> => {
    // Conditional on the mark: a reading that became `exact` meanwhile (an index run, a refresh)
    // is the newer truth and is left alone.
    await sql.query(
      `update project_repository_config
          set prompts = null, prompts_withheld = $2::jsonb
        where project_id = $1 and prompts_redaction = 'patterns'`,
      [projectId, JSON.stringify(withheld)],
    );
  },
});
