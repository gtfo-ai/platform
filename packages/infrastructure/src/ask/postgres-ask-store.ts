/**
 * `AskStore` on PostgreSQL — `task_asks` (migration 0024), plus the two projections an ask's answer
 * is built from and checked against (WP-31).
 *
 * Transaction-bound like `PostgresPipelineStore`, and narrowed the same way: a repository never
 * opens a connection of its own, so the ask row, the run that answers it and the events that
 * announce the run commit together.
 *
 * ## The two projections are joins, not tables
 *
 * `runsForTask` reads `runs` (with the stage resolved off `task_stages`, exactly as
 * `RunRepository.load` does) and `auditForTask` reads `human_actions` on its only index,
 * `(task_id, created_at desc)`. Neither is this feature's table, and both are here for the reason
 * `AskStore`'s own docblock gives: what they return is the *ask's* reading of the record — a line
 * per row, bounded and shaped for a prompt and for a DTO — rather than the pipeline's.
 *
 * `auditForTask` is PROGRESS backlog **52**'s remaining half: `human_actions` has no `project_id`
 * column, so WP-30's `GET /api/projects/:id/audit` predicate (`params->>'project_id'`) never matches
 * a task command's row, and until this method the eleven commands of WP-15i and WP-27's three were
 * invisible to every read surface.
 */
import type {
  AskAuditLine,
  AskRunLine,
  AskStatus,
  AskStore,
  NewAsk,
  StoredAsk,
  Transaction,
} from '@platform/application';
import type {
  AskAnswerCitation,
  Id,
  IsoDateTime,
  JsonObject,
  RunStatus,
} from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

/** `numeric` comes back as a string from `pg`; the same `Number(...)` the pipeline store applies. */
const usd = (value: string | number | null): number => (value === null ? 0 : Number(value));

const iso = (value: Date | string): IsoDateTime =>
  (value instanceof Date ? value.toISOString() : value) as IsoDateTime;

export interface AskRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  project_id: string;
  source: string;
  asked_by_user_id: string;
  asked_by_identity: JsonObject | null;
  ticket_comment_id: string | null;
  question: string;
  run_id: string | null;
  status: string;
  answer: string | null;
  citations: unknown;
  dropped_citations: number;
  answer_artifact_id: string | null;
  refusal_reason: string | null;
  redaction_count: number;
  mirrored_at: Date | null;
  created_at: Date;
  answered_at: Date | null;
}

/**
 * One `task_asks` row as the application reads it.
 *
 * Exported and tested on its own because it is where three driver shapes are absorbed and a reader
 * would otherwise have to branch on them: `timestamptz` arrives as a `Date` from `pg` and as a
 * string from a `sql` template, `numeric` arrives as a string, and `citations` is `jsonb`, which is
 * to say *anything the column was ever given*. A row whose `citations` is not an array answers `[]`
 * rather than propagating a value the DTO's schema would then refuse at the route — the same
 * fail-closed direction `workpadRefSchema.parse` takes at the write.
 */
export const askRowToStored = (row: AskRow): StoredAsk => ({
  id: row.id as Id,
  taskId: row.task_id as Id,
  projectId: row.project_id as Id,
  source: row.source as StoredAsk['source'],
  askedByUserId: row.asked_by_user_id as Id,
  askedByIdentity: row.asked_by_identity,
  ticketCommentId: row.ticket_comment_id,
  question: row.question,
  runId: row.run_id as Id | null,
  status: row.status as AskStatus,
  answer: row.answer,
  // Read back as-is rather than re-parsed: the application wrote this array after
  // `askAnswerDataSchema` validated it and after `scopeCitations` filtered it, so a parse here would
  // be a second contract to keep true. The reader that publishes it re-validates (`routes/asks.ts`).
  citations: (Array.isArray(row.citations) ? row.citations : []) as readonly AskAnswerCitation[],
  droppedCitations: row.dropped_citations,
  answerArtifactId: row.answer_artifact_id as Id | null,
  refusalReason: row.refusal_reason,
  redactionCount: row.redaction_count,
  mirroredAt: row.mirrored_at === null ? null : iso(row.mirrored_at),
  createdAt: iso(row.created_at),
  answeredAt: row.answered_at === null ? null : iso(row.answered_at),
});

const COLUMNS = `id, task_id, project_id, source, asked_by_user_id, asked_by_identity,
                 ticket_comment_id, question, run_id, status, answer, citations, dropped_citations,
                 answer_artifact_id, refusal_reason, redaction_count, mirrored_at, created_at,
                 answered_at`;

export class AskRowMissingError extends Error {
  override readonly name = 'AskRowMissingError';
}

export const createPostgresAskStore = (): AskStore => ({
  /**
   * `on conflict do nothing` on the ticket-comment index, reported as `'duplicate'`.
   *
   * A redelivered webhook is the ordinary case rather than a fault — the same answer `inbox` gives —
   * so this must not throw. `on conflict do nothing` also covers a replayed `id`, which is the
   * HTTP door's `Idempotency-Key` arriving twice with the route's own id generation in between.
   */
  insert: async (tx: Transaction, ask: NewAsk): Promise<'inserted' | 'duplicate'> => {
    const result = await sqlOf(tx).query(
      `insert into task_asks
         (id, task_id, project_id, source, asked_by_user_id, asked_by_identity,
          ticket_comment_id, question, redaction_count, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       on conflict do nothing`,
      [
        ask.id,
        ask.taskId,
        ask.projectId,
        ask.source,
        ask.askedByUserId,
        ask.askedByIdentity === null ? null : JSON.stringify(ask.askedByIdentity),
        ask.ticketCommentId,
        ask.question,
        ask.redactionCount,
        ask.createdAt,
      ],
    );
    return result.rowCount === 0 ? 'duplicate' : 'inserted';
  },

  load: async (tx, askId) => {
    const { rows } = await sqlOf(tx).query<AskRow>(
      `select ${COLUMNS} from task_asks where id = $1`,
      [askId],
    );
    const row = rows[0];
    return row === undefined ? null : askRowToStored(row);
  },

  attachRun: async (tx, askId, runId) => {
    const result = await sqlOf(tx).query('update task_asks set run_id = $2 where id = $1', [
      askId,
      runId,
    ]);
    if (result.rowCount === 0) {
      throw new AskRowMissingError(`ask ${askId} does not exist`);
    }
  },

  recordAnswer: async (tx, input) => {
    const result = await sqlOf(tx).query(
      `update task_asks
          set status = 'answered', answer = $2, citations = $3::jsonb, dropped_citations = $4,
              answer_artifact_id = $5, redaction_count = redaction_count + $6, answered_at = $7,
              refusal_reason = null
        where id = $1`,
      [
        input.askId,
        input.answer,
        JSON.stringify(input.citations),
        input.droppedCitations,
        input.answerArtifactId,
        input.redactionCount,
        input.answeredAt,
      ],
    );
    if (result.rowCount === 0) {
      throw new AskRowMissingError(`ask ${input.askId} does not exist`);
    }
  },

  recordRefusal: async (tx, input) => {
    const result = await sqlOf(tx).query(
      `update task_asks
          set status = $2, refusal_reason = $3, answer = null, answered_at = null
        where id = $1`,
      [input.askId, input.status, input.reason],
    );
    if (result.rowCount === 0) {
      throw new AskRowMissingError(`ask ${input.askId} does not exist`);
    }
  },

  markMirrored: async (tx, askId, at) => {
    const result = await sqlOf(tx).query('update task_asks set mirrored_at = $2 where id = $1', [
      askId,
      at,
    ]);
    if (result.rowCount === 0) {
      throw new AskRowMissingError(`ask ${askId} does not exist`);
    }
  },

  listForTask: async (tx, taskId, limit) => {
    const { rows } = await sqlOf(tx).query<AskRow>(
      `select ${COLUMNS} from task_asks where task_id = $1 order by created_at desc limit $2`,
      [taskId, limit],
    );
    return rows.map(askRowToStored);
  },

  runsForTask: async (tx, taskId, limit): Promise<readonly AskRunLine[]> => {
    const { rows } = await sqlOf(tx).query<{
      id: string;
      stage: string | null;
      role: string;
      mode: string;
      attempt: number;
      model: string;
      status: string;
      terminal_reason: string | null;
      usd_reported: string | null;
      created_at: Date;
    }>(
      `select r.id, s.stage, r.role, r.mode, r.attempt, r.model, r.status, r.terminal_reason,
              r.usd_reported, r.created_at
         from runs r
         left join task_stages s on s.id = r.task_stage_id
        where r.task_id = $1
        order by r.created_at desc
        limit $2`,
      [taskId, limit],
    );
    return rows.map((row) => ({
      runId: row.id as Id,
      stage: row.stage as AskRunLine['stage'],
      role: row.role,
      mode: row.mode,
      attempt: row.attempt,
      model: row.model,
      status: row.status as RunStatus,
      terminalReason: row.terminal_reason,
      costUsd: usd(row.usd_reported),
      createdAt: iso(row.created_at),
    }));
  },

  auditForTask: async (tx, taskId, limit): Promise<readonly AskAuditLine[]> => {
    const { rows } = await sqlOf(tx).query<{
      id: string;
      action: string;
      user_id: string | null;
      params: JsonObject;
      created_at: Date;
    }>(
      `select id, action, user_id, params, created_at
         from human_actions
        where task_id = $1
        order by created_at desc
        limit $2`,
      [taskId, limit],
    );
    return rows.map((row) => ({
      id: row.id as Id,
      action: row.action,
      userId: row.user_id as Id | null,
      // Client-supplied JSON (it carries the caller's own `Idempotency-Key`): untrusted at every
      // reader, which is why the prompt puts it in a data block and the SPA renders it as text.
      params: row.params ?? {},
      createdAt: iso(row.created_at),
    }));
  },
});
