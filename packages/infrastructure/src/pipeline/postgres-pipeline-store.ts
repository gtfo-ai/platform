/**
 * `PipelineStore` on PostgreSQL — the tables of technical/03 § "Pipeline".
 *
 * Every method takes the `Transaction` handle the application ring passes around and narrows it
 * with `postgresTransaction`, so a repository can never open a connection of its own: the aggregate
 * state and the events it produced commit together or not at all, and the dispatcher's pool
 * arithmetic stays true.
 *
 * ## What is stored where
 *
 * The Task aggregate maps onto `tasks` column by column, with two additions from migration 0012 —
 * `stage_attempts` and `iteration_limits`, which are aggregate state that 0004 had no home for.
 * The template snapshot goes in `template_snapshot`, frozen at task start (technical/12), so a
 * project that edits its pipeline never moves a task that is already running on it.
 *
 * ## Money
 *
 * `numeric(12,6)` comes back from `pg` as a **string**, deliberately: `numeric` has more precision
 * than a double, and the driver refuses to lose it silently. Everything read here goes through
 * `Number(...)` at one place, and the domain rounds to six decimals (`roundUsd`) so the value
 * written back is one the column can hold exactly.
 */
import type {
  ApprovalRepository,
  ArtifactRepository,
  PipelineStore,
  QuestionRepository,
  RunRepository,
  StoredApproval,
  StoredArtifact,
  StoredRun,
  StoredTask,
  TaskRepository,
  Transaction,
} from '@platform/application';
import type {
  Id,
  IsoDateTime,
  JsonValue,
  MergeRequestRef,
  PipelineTemplate,
  Slug,
  TaskState,
  WorkpadRef,
} from '@platform/contracts';
import type { Approval, IterationCounters, IterationLimits, Question } from '@platform/domain';
import { ACTIVE_RUN_STATUSES, resolveIterationLimits } from '@platform/domain';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

/** Raised when a write that had to change a row changed none. */
export class PipelineRowMissingError extends Error {
  override readonly name = 'PipelineRowMissingError';
}

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const usd = (value: string | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value);

const iso = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

interface TaskRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  ticket_provider: string;
  ticket_key: string;
  ticket_url: string;
  template: string;
  mode: 'normal' | 'shadow';
  state: TaskState;
  current_stage: string | null;
  priority: string | null;
  template_snapshot: PipelineTemplate | null;
  branch: string | null;
  mr_ref: MergeRequestRef | null;
  workpad_ref: WorkpadRef | null;
  stage_attempts: Record<string, number>;
  iteration_limits: Partial<IterationLimits>;
  iteration_counters: IterationCounters;
  cost_actual: string;
  estimate_usd: string | null;
  created_at: Date;
  sequence: string | number | null;
}

const TASK_COLUMNS = `t.id, t.project_id, t.ticket_provider, t.ticket_key, t.ticket_url, t.template,
    t.mode, t.state, t.current_stage, t.priority, t.template_snapshot, t.branch, t.mr_ref,
    t.workpad_ref, t.stage_attempts, t.iteration_limits, t.iteration_counters, t.cost_actual,
    t.estimate_usd, t.created_at,
    (select max(e.stream_seq) from events e where e.stream_type = 'task' and e.stream_id = t.id)
      as sequence`;

/**
 * The aggregate's next `stream_seq` is read from the log rather than stored on the row.
 *
 * It has one authority — the `events` table — and duplicating it in a column would give the same
 * number two writers and no arbiter (standing rule 9). `max(stream_seq) + 1`, or
 * `FIRST_STREAM_SEQ` when the stream is empty, is exactly what `nextStreamSequence` promises.
 */
const toStoredTask = (row: TaskRow, template: PipelineTemplate): StoredTask => ({
  task: {
    id: row.id,
    projectId: row.project_id,
    ticket: { provider: row.ticket_provider, key: row.ticket_key, url: row.ticket_url },
    template: row.template,
    mode: row.mode,
    state: row.state,
    currentStage: row.current_stage,
    stageAttempts: row.stage_attempts,
    iterationCounters: row.iteration_counters,
    // The frozen limits, over the shipped defaults: a row written before 0012 has `{}` here and
    // must still load with a complete set rather than with `undefined` ceilings.
    limits: { ...resolveIterationLimits(), ...row.iteration_limits },
    sequence: row.sequence === null ? 1 : Number(row.sequence) + 1,
  },
  template,
  priorityRank: priorityRank(row.priority),
  createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
  branch: row.branch,
  mr: row.mr_ref,
  workpad: row.workpad_ref,
  costActualUsd: usd(row.cost_actual),
  estimateUsd: row.estimate_usd === null ? null : usd(row.estimate_usd),
});

/**
 * Provider priority labels → the rank `orderQueue` sorts on (lower is more urgent, BD-010).
 *
 * Derived rather than stored: `tasks.priority` holds the provider's own word, and a second column
 * holding the platform's reading of it would be a projection nothing keeps in step when the
 * mapping changes.
 */
const priorityRank = (priority: string | null): number => {
  switch (priority?.trim().toLowerCase()) {
    case 'highest':
    case 'blocker':
    case 'critical':
    case 'p0':
      return 0;
    case 'high':
    case 'major':
    case 'p1':
      return 1;
    case 'low':
    case 'minor':
    case 'p3':
      return 3;
    case 'lowest':
    case 'trivial':
    case 'p4':
      return 4;
    default:
      return 2;
  }
};

export interface PostgresPipelineStoreOptions {
  /**
   * The template a task runs on when its `template_snapshot` is null — a row written before WP-15,
   * or by a fixture. Falling back to the shipped set keeps a task readable; without it, loading
   * would throw and the task would be unrecoverable.
   */
  readonly templates: Readonly<Record<string, PipelineTemplate>>;
}

export const createPostgresPipelineStore = (
  options: PostgresPipelineStoreOptions,
): PipelineStore => {
  const templateFor = (row: TaskRow): PipelineTemplate => {
    const snapshot = row.template_snapshot;
    if (snapshot !== null && typeof snapshot === 'object' && 'stages' in snapshot) {
      return snapshot;
    }
    const shipped = options.templates[row.template];
    if (shipped === undefined) {
      throw new PipelineRowMissingError(
        `task ${row.id} runs on template "${row.template}", which has no snapshot and is not one the platform ships`,
      );
    }
    return shipped;
  };

  const tasks: TaskRepository = {
    load: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<TaskRow>(
        `select ${TASK_COLUMNS} from tasks t where t.id = $1`,
        [taskId],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredTask(row, templateFor(row));
    },

    findByTicket: async (tx, query) => {
      const { rows } = await sqlOf(tx).query<TaskRow>(
        `select ${TASK_COLUMNS} from tasks t
          where t.project_id = $1 and t.ticket_provider = $2 and t.ticket_key = $3 and t.mode = $4`,
        [query.projectId, query.provider, query.ticketKey, query.mode],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredTask(row, templateFor(row));
    },

    findByMergeRequest: async (tx, query) => {
      const { rows } = await sqlOf(tx).query<TaskRow>(
        `select ${TASK_COLUMNS} from tasks t
          where t.project_id = $1 and (t.mr_ref ->> 'iid')::int = $2
          order by t.created_at desc limit 1`,
        [query.projectId, query.iid],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredTask(row, templateFor(row));
    },

    listAtStage: async (tx, projectId, stage) => {
      const { rows } = await sqlOf(tx).query<TaskRow>(
        `select ${TASK_COLUMNS} from tasks t
          where t.project_id = $1 and t.current_stage = $2 order by t.created_at`,
        [projectId, stage],
      );
      return rows.map((row) => toStoredTask(row, templateFor(row)));
    },

    insert: async (tx, stored) => {
      const { task } = stored;
      await sqlOf(tx).query(
        `insert into tasks (id, project_id, ticket_provider, ticket_key, ticket_url, template, mode,
                            state, current_stage, priority, template_snapshot, branch, mr_ref,
                            workpad_ref, stage_attempts, iteration_limits, iteration_counters,
                            cost_actual, estimate_usd)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb,
                 $15::jsonb, $16::jsonb, $17::jsonb, $18, $19)`,
        [
          task.id,
          task.projectId,
          task.ticket.provider,
          task.ticket.key,
          task.ticket.url,
          task.template,
          task.mode,
          task.state,
          task.currentStage,
          priorityLabel(stored.priorityRank),
          JSON.stringify(stored.template),
          stored.branch,
          stored.mr === null ? null : JSON.stringify(stored.mr),
          stored.workpad === null ? null : JSON.stringify(stored.workpad),
          JSON.stringify(task.stageAttempts),
          JSON.stringify(task.limits),
          JSON.stringify(task.iterationCounters),
          stored.costActualUsd,
          stored.estimateUsd,
        ],
      );
    },

    save: async (tx, stored) => {
      const { task } = stored;
      const result = await sqlOf(tx).query(
        `update tasks
            set state = $2::task_state, current_stage = $3, branch = $4, mr_ref = $5::jsonb,
                workpad_ref = $6::jsonb, stage_attempts = $7::jsonb,
                iteration_counters = $8::jsonb, cost_actual = $9, updated_at = now(),
                completed_at = case when $2::text in ('done', 'cancelled') then now() else completed_at end
          where id = $1`,
        [
          task.id,
          task.state,
          task.currentStage,
          stored.branch,
          stored.mr === null ? null : JSON.stringify(stored.mr),
          stored.workpad === null ? null : JSON.stringify(stored.workpad),
          JSON.stringify(task.stageAttempts),
          JSON.stringify(task.iterationCounters),
          stored.costActualUsd,
        ],
      );
      if (result.rowCount === 0) {
        // A save that wrote nothing is how a state machine silently stops advancing; the in-memory
        // store refuses the same way, which is what makes the two interchangeable.
        throw new PipelineRowMissingError(`task ${task.id} does not exist`);
      }
    },

    counts: async (tx, projectId) => {
      const { rows } = await sqlOf(tx).query<{ active: string; in_pipeline: string }>(
        `select count(*) filter (where state in ('active', 'returned')) as active,
                count(*) filter (where state not in ('queued', 'done', 'cancelled')) as in_pipeline
           from tasks where project_id = $1`,
        [projectId],
      );
      const row = rows[0];
      return {
        activeTasks: Number(row?.active ?? 0),
        tasksInPipeline: Number(row?.in_pipeline ?? 0),
      };
    },

    queued: async (tx, projectId) => {
      const { rows } = await sqlOf(tx).query<{
        id: string;
        priority: string | null;
        created_at: Date;
      }>(`select id, priority, created_at from tasks where project_id = $1 and state = 'queued'`, [
        projectId,
      ]);
      return rows.map((row) => ({
        id: row.id,
        priorityRank: priorityRank(row.priority),
        createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
      }));
    },

    recordStageEntered: async (tx, entry) => {
      await sqlOf(tx).query(
        `insert into task_stages (task_id, stage, attempt, state, caused_by_event_id)
         values ($1, $2, $3, 'entered', $4)
         on conflict (task_id, stage, attempt) do update
            set state = 'entered', entered_at = now(), exited_at = null,
                caused_by_event_id = excluded.caused_by_event_id`,
        [entry.taskId, entry.stage, entry.attempt, entry.causedByEventId],
      );
    },

    recordStageExited: async (tx, entry) => {
      await sqlOf(tx).query(
        `update task_stages
            set state = 'exited', exited_at = now(), outcome = $4, return_reason = $5
          where task_id = $1 and stage = $2 and attempt = $3`,
        [entry.taskId, entry.stage, entry.attempt, entry.outcome, entry.returnReason],
      );
    },

    recordStageSignature: async (tx, entry) => {
      await sqlOf(tx).query(
        `insert into task_stages (task_id, stage, attempt, state, signature)
         values ($1, $2, $3, 'entered', $4)
         on conflict (task_id, stage, attempt) do update set signature = excluded.signature`,
        [entry.taskId, entry.stage, entry.attempt, entry.signature],
      );
    },

    recentStageSignatures: async (tx, taskId, stage, limit) => {
      const { rows } = await sqlOf(tx).query<{ signature: string }>(
        `select signature from task_stages
          where task_id = $1 and stage = $2 and signature is not null
          order by attempt desc limit $3`,
        [taskId, stage, limit],
      );
      return rows.map((row) => row.signature).reverse();
    },

    lastReturnReason: async (tx, taskId, stage) => {
      const { rows } = await sqlOf(tx).query<{ return_reason: string }>(
        `select return_reason from task_stages
          where task_id = $1 and stage = $2 and return_reason is not null
          order by attempt desc limit 1`,
        [taskId, stage],
      );
      return rows[0]?.return_reason ?? null;
    },
  };

  const artifacts: ArtifactRepository = {
    nextVersion: async (tx, taskId, type) => {
      const { rows } = await sqlOf(tx).query<{ next: string }>(
        `select coalesce(max(version), 0) + 1 as next from artifacts
          where task_id = $1 and type = $2`,
        [taskId, type],
      );
      return Number(rows[0]?.next ?? 1);
    },
    insert: async (tx, artifact) => {
      await sqlOf(tx).query(
        `insert into artifacts (id, task_id, type, version, markdown, data, schema_version,
                                produced_by_run_id)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
        [
          artifact.id,
          artifact.taskId,
          artifact.type,
          artifact.version,
          artifact.markdown,
          JSON.stringify(artifact.data),
          artifact.schemaVersion,
          artifact.producedByRunId,
        ],
      );
    },
    latest: async (tx, taskId, type) => {
      const { rows } = await sqlOf(tx).query<ArtifactRow>(
        `select id, task_id, type, version, markdown, data, schema_version, produced_by_run_id,
                created_at
           from artifacts where task_id = $1 and type = $2 order by version desc limit 1`,
        [taskId, type],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredArtifact(row);
    },
    listFor: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<ArtifactRow>(
        `select id, task_id, type, version, markdown, data, schema_version, produced_by_run_id,
                created_at
           from artifacts where task_id = $1 order by created_at, version`,
        [taskId],
      );
      return rows.map(toStoredArtifact);
    },
  };

  const runs: RunRepository = {
    insert: async (tx, run) => {
      await sqlOf(tx).query(
        `insert into runs (id, task_id, project_id, role, mode, attempt, model, effort,
                           prompt_version, status, started_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
        [
          run.id,
          run.taskId,
          run.projectId,
          run.role,
          run.mode,
          run.attempt,
          run.model,
          run.effort,
          run.promptVersion,
          run.status,
        ],
      );
    },
    finish: async (tx, outcome) => {
      const result = await sqlOf(tx).query(
        `update runs
            set status = $2, terminal_reason = $3, session_id = $4, num_turns = $5,
                input_tokens = $6, output_tokens = $7, cache_write_5m_tokens = $8,
                cache_write_1h_tokens = $9, cache_read_tokens = $10, usd_reported = $11,
                wall_ms = $12, ended_at = now()
          where id = $1`,
        [
          outcome.runId,
          outcome.status,
          outcome.terminalReason,
          outcome.sessionId,
          outcome.numTurns,
          outcome.usage.input_tokens,
          outcome.usage.output_tokens,
          outcome.usage.cache_write_5m_tokens,
          outcome.usage.cache_write_1h_tokens,
          outcome.usage.cache_read_tokens,
          outcome.cost.is_estimate ? null : outcome.cost.usd,
          outcome.wallMs,
        ],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`run ${outcome.runId} does not exist`);
      }
    },
    load: async (tx, runId) => {
      const { rows } = await sqlOf(tx).query<RunRow>(
        `select id, task_id, project_id, role, mode, attempt, model, effort, prompt_version, status,
                terminal_reason, session_id, num_turns, usd_reported, usd_estimated, wall_ms,
                created_at
           from runs where id = $1`,
        [runId],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredRun(row);
    },
    totalsFor: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<{
        runs: string;
        cost: string | null;
        estimated: string;
        wall_ms: string | null;
      }>(
        `select count(*) as runs,
                coalesce(sum(coalesce(usd_reported, usd_estimated)), 0) as cost,
                count(*) filter (where usd_reported is null) as estimated,
                coalesce(sum(wall_ms), 0) as wall_ms
           from runs where task_id = $1`,
        [taskId],
      );
      const row = rows[0];
      return {
        runs: Number(row?.runs ?? 0),
        costUsd: usd(row?.cost ?? null),
        isEstimate: Number(row?.estimated ?? 0) > 0,
        wallMs: Number(row?.wall_ms ?? 0),
      };
    },
  };

  const questions: QuestionRepository = {
    insert: async (tx, question) => {
      await sqlOf(tx).query(
        `insert into questions (id, task_id, stage, run_id, text, options, blocking, status,
                                asked_at, deadline_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
        [
          question.id,
          question.taskId,
          question.stage,
          question.runId,
          question.text,
          question.options === null ? null : JSON.stringify(question.options),
          question.blocking,
          question.status,
          question.askedAt,
          question.deadlineAt,
        ],
      );
    },
    load: async (tx, questionId) => {
      const { rows } = await sqlOf(tx).query<QuestionRow>(`${QUESTION_SELECT} where q.id = $1`, [
        questionId,
      ]);
      const row = rows[0];
      return row === undefined ? null : toQuestion(row);
    },
    save: async (tx, question) => {
      const result = await sqlOf(tx).query(
        `update questions
            set status = $2::question_status, answer = $3, answered_by_user_id = $4,
                answered_via = $5,
                answered_at = $6, reminders_sent = $7,
                escalated_at = case when $2::text = 'escalated' then now() else escalated_at end
          where id = $1`,
        [
          question.id,
          question.status,
          question.answer,
          question.answeredByUserId,
          question.answeredVia,
          question.answeredAt,
          question.remindersSent,
        ],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`question ${question.id} does not exist`);
      }
    },
    open: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<QuestionRow>(
        `${QUESTION_SELECT} where q.task_id = $1 and q.status = 'open' order by q.asked_at`,
        [taskId],
      );
      return rows.map(toQuestion);
    },
  };

  const approvals: ApprovalRepository = {
    insert: async (tx, stored) => {
      await sqlOf(tx).query(
        `insert into approvals (id, task_id, kind, status, requested_at, deadline_at, stage, attempt)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          stored.approval.id,
          stored.approval.taskId,
          stored.approval.kind,
          stored.approval.status,
          stored.approval.requestedAt,
          stored.approval.deadlineAt,
          stored.stage,
          stored.attempt,
        ],
      );
    },
    load: async (tx, approvalId) => {
      const { rows } = await sqlOf(tx).query<ApprovalRow>(`${APPROVAL_SELECT} where a.id = $1`, [
        approvalId,
      ]);
      const row = rows[0];
      return row === undefined ? null : toStoredApproval(row);
    },
    save: async (tx, stored) => {
      const result = await sqlOf(tx).query(
        `update approvals
            set status = $2, decided_by_user_id = $3, decided_at = $4, reason = $5 where id = $1`,
        [
          stored.approval.id,
          stored.approval.status,
          stored.approval.decidedByUserId,
          stored.approval.decidedAt,
          stored.approval.reason,
        ],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`approval ${stored.approval.id} does not exist`);
      }
    },
    forStageAttempt: async (tx, query) => {
      const { rows } = await sqlOf(tx).query<ApprovalRow>(
        `${APPROVAL_SELECT}
          where a.task_id = $1 and a.kind = $2 and a.stage = $3 and a.attempt = $4
          order by a.requested_at desc limit 1`,
        [query.taskId, query.kind, query.stage, query.attempt],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredApproval(row);
    },
  };

  return { tasks, artifacts, runs, questions, approvals };
};

/**
 * The label a rank came from, for the round trip.
 *
 * `tasks.priority` holds the provider's own word and intake gives the platform a rank; storing the
 * rank would be a second column for the same fact. Rank 2 is "no label", which is what an unknown
 * provider word normalises to, so every rank the normaliser can produce survives the round trip.
 */
const priorityLabel = (rank: number): string | null => {
  switch (rank) {
    case 0:
      return 'Highest';
    case 1:
      return 'High';
    case 3:
      return 'Low';
    case 4:
      return 'Lowest';
    default:
      return null;
  }
};

interface ArtifactRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  type: StoredArtifact['type'];
  version: number;
  markdown: string | null;
  data: JsonValue;
  schema_version: string;
  produced_by_run_id: string | null;
  created_at: Date;
}

const toStoredArtifact = (row: ArtifactRow): StoredArtifact => ({
  id: row.id,
  taskId: row.task_id,
  type: row.type,
  version: row.version,
  markdown: row.markdown,
  data: row.data,
  schemaVersion: row.schema_version,
  producedByRunId: row.produced_by_run_id,
  createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
});

interface RunRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  project_id: string;
  role: string;
  mode: string;
  attempt: number;
  model: string;
  effort: string;
  prompt_version: string;
  status: StoredRun['status'];
  terminal_reason: StoredRun['terminalReason'];
  session_id: string | null;
  num_turns: number;
  usd_reported: string | null;
  usd_estimated: string;
  wall_ms: string | number;
  created_at: Date;
}

const toStoredRun = (row: RunRow): StoredRun => ({
  id: row.id,
  taskId: row.task_id,
  projectId: row.project_id,
  stage: null,
  role: row.role,
  mode: row.mode,
  attempt: row.attempt,
  model: row.model,
  effort: row.effort,
  promptVersion: row.prompt_version,
  status: row.status,
  terminalReason: row.terminal_reason,
  sessionId: row.session_id,
  numTurns: row.num_turns,
  usage: null,
  cost:
    row.usd_reported === null
      ? { usd: usd(row.usd_estimated), is_estimate: true, price_list_id: null }
      : { usd: usd(row.usd_reported), is_estimate: false, price_list_id: null },
  wallMs: Number(row.wall_ms),
  createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
});

const QUESTION_SELECT = `select q.id, q.task_id, q.stage, q.run_id, q.text, q.options, q.blocking,
    q.status, q.asked_at, q.deadline_at, q.reminders_sent, q.answer, q.answered_by_user_id,
    q.answered_via, q.answered_at, t.project_id
  from questions q join tasks t on t.id = q.task_id`;

interface QuestionRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  project_id: string;
  stage: string | null;
  run_id: string | null;
  text: string;
  options: string[] | null;
  blocking: boolean;
  status: Question['status'];
  asked_at: Date;
  deadline_at: Date | null;
  reminders_sent: number;
  answer: string | null;
  answered_by_user_id: string | null;
  answered_via: Question['answeredVia'];
  answered_at: Date | null;
}

const toQuestion = (row: QuestionRow): Question => ({
  id: row.id,
  taskId: row.task_id,
  projectId: row.project_id,
  stage: (row.stage ?? 'refinement') as Slug,
  runId: row.run_id,
  text: row.text,
  options: row.options,
  blocking: row.blocking,
  status: row.status,
  askedAt: new Date(row.asked_at).toISOString() as IsoDateTime,
  deadlineAt: iso(row.deadline_at),
  remindersSent: row.reminders_sent,
  answer: row.answer,
  answeredByUserId: row.answered_by_user_id,
  answeredVia: row.answered_via,
  answeredAt: iso(row.answered_at),
  sequence: 1,
});

const APPROVAL_SELECT = `select a.id, a.task_id, a.kind, a.status, a.requested_at, a.deadline_at,
    a.decided_by_user_id, a.decided_at, a.reason, a.stage, a.attempt, t.project_id
  from approvals a join tasks t on t.id = a.task_id`;

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  project_id: string;
  kind: Approval['kind'];
  status: Approval['status'];
  requested_at: Date;
  deadline_at: Date | null;
  decided_by_user_id: string | null;
  decided_at: Date | null;
  reason: string | null;
  stage: string | null;
  attempt: number | null;
}

const toStoredApproval = (row: ApprovalRow): StoredApproval => ({
  approval: {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    requestedAt: new Date(row.requested_at).toISOString() as IsoDateTime,
    deadlineAt: iso(row.deadline_at),
    decidedByUserId: row.decided_by_user_id,
    decidedAt: iso(row.decided_at),
    reason: row.reason,
    sequence: 1,
  },
  stage: row.stage,
  attempt: row.attempt,
});

/** Run statuses that hold a slot against `max_parallel_runs`, for a caller that needs the list. */
export const ACTIVE_RUN_STATUS_LIST: readonly string[] = ACTIVE_RUN_STATUSES;

export type { Id };
