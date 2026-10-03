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
  BreakdownRepository,
  BugTraceRepository,
  Logger,
  PipelineStore,
  QuestionRepository,
  RunRepository,
  StoredApproval,
  StoredArtifact,
  StoredBreakdownItem,
  StoredRun,
  StoredTask,
  TaskRepository,
  Transaction,
} from '@platform/application';
import {
  silentLogger,
  TAKE_OVER_BOUNDARY_EVENTS,
  TaskConcurrentModificationError,
} from '@platform/application';
import type {
  ContextPackRecord,
  EstimateBasis,
  HistorySample,
  Id,
  IsoDateTime,
  JsonValue,
  MergeRequestRef,
  MergeRequestSnapshot,
  PipelineTemplate,
  RunCost,
  Slug,
  TaskCoverage,
  TaskDependencies,
  TaskPipelineDial,
  TaskReviewers,
  TaskReviewThreads,
  TaskState,
  TicketSnapshot,
  WorkpadRef,
} from '@platform/contracts';
import {
  acceptanceCriterionSchema,
  artifactTypeSchema,
  mergeRequestRefSchema,
  pausedBudgetScopeSchema,
  taskCoverageSchema,
  taskDependenciesSchema,
  taskPipelineDialSchema,
  taskReviewersSchema,
  taskReviewThreadsSchema,
  taskStageExitStateSchema,
  taskStageOutcomeSchema,
  taskStageStateSchema,
  workpadRefSchema,
} from '@platform/contracts';
import type { Approval, IterationCounters, IterationLimits, Question } from '@platform/domain';
import { ACTIVE_RUN_STATUSES, resolveIterationLimits } from '@platform/domain';
import * as z from 'zod';
import { unmeasuredEndedRunSql } from '../cost/pending-run-spend.js';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import {
  closePendingRunCommands,
  createPostgresRunCommandRepository,
} from './postgres-run-commands.js';
import { takeOverLastActivitySql } from './take-over-activity.js';

/** Raised when a write that had to change a row changed none. */
export class PipelineRowMissingError extends Error {
  override readonly name = 'PipelineRowMissingError';
}

/** Raised when a stored document a task cannot run without does not match its schema (WP-62). */
export class PipelineStoredStateError extends Error {
  override readonly name = 'PipelineStoredStateError';
}

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const usd = (value: string | number | null): number =>
  value === null ? 0 : typeof value === 'number' ? value : Number(value);

const iso = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

/** The same, for a column the schema declares `not null`. */
const isoOf = (value: Date | string): IsoDateTime => new Date(value).toISOString() as IsoDateTime;

interface TaskRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  ticket_provider: string;
  ticket_key: string;
  ticket_url: string;
  ticket_id: string | null;
  template: string;
  mode: 'normal' | 'shadow';
  state: TaskState;
  current_stage: string | null;
  priority: string | null;
  template_snapshot: PipelineTemplate | null;
  pipeline_dial: unknown;
  branch: string | null;
  mr_ref: MergeRequestRef | null;
  workpad_ref: WorkpadRef | null;
  stage_attempts: Record<string, number>;
  iteration_limits: Partial<IterationLimits>;
  iteration_counters: IterationCounters;
  cost_actual: string;
  estimate_usd: string | null;
  estimate_basis: EstimateBasis | null;
  estimate_samples: number | string | null;
  ticket_snapshot: TicketSnapshot | null;
  ticket_snapshot_at: Date | null;
  ticket_signal_at: Date | null;
  review_subject: MergeRequestSnapshot | null;
  history_sample: HistorySample | null;
  risk_classes: string[] | null;
  coverage: TaskCoverage | null;
  dependencies: TaskDependencies | null;
  required_reviewers: TaskReviewers | null;
  review_threads: TaskReviewThreads | null;
  requested_by_user_id: string | null;
  ready_head_sha: string | null;
  ci_head_sha: string | null;
  ci_excused_paths: string[] | null;
  settings_refreeze_pending: boolean | null;
  refreeze_routing: { issue_type: string | null; can_create_tickets: boolean } | null;
  version: number;
  created_at: Date;
  sequence: string | number | null;
}

const TASK_COLUMNS = `t.id, t.project_id, t.ticket_provider, t.ticket_key, t.ticket_url, t.ticket_id,
    t.template,
    t.mode, t.state, t.current_stage, t.priority, t.template_snapshot, t.pipeline_dial, t.branch,
    t.mr_ref,
    t.workpad_ref, t.stage_attempts, t.iteration_limits, t.iteration_counters, t.cost_actual,
    t.estimate_usd, t.estimate_basis, t.estimate_samples,
    t.ticket_snapshot, t.ticket_snapshot_at, t.ticket_signal_at, t.review_subject, t.history_sample,
    t.risk_classes, t.coverage,
    t.dependencies, t.required_reviewers, t.review_threads,
    t.requested_by_user_id, t.ready_head_sha, t.ci_head_sha, t.ci_excused_paths, t.settings_refreeze_pending, t.refreeze_routing, t.version,
    t.created_at,
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
    ticket: {
      provider: row.ticket_provider,
      key: row.ticket_key,
      url: row.ticket_url,
      // Only when recorded (WP-134): a ref with no id is the shape every pre-0077 task had.
      ...(row.ticket_id === null || row.ticket_id === undefined ? {} : { id: row.ticket_id }),
    },
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
  pipelineDial: pipelineDialOf(row),
  settingsRefreezePending: row.settings_refreeze_pending === true,
  refreezeRouting:
    row.refreeze_routing === null || row.refreeze_routing === undefined
      ? null
      : {
          issueType: row.refreeze_routing.issue_type,
          canCreateTickets: row.refreeze_routing.can_create_tickets === true,
        },
  priorityRank: priorityRank(row.priority),
  createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
  branch: row.branch,
  mr: row.mr_ref,
  workpad: row.workpad_ref,
  costActualUsd: usd(row.cost_actual),
  estimateUsd: row.estimate_usd === null ? null : usd(row.estimate_usd),
  estimateBasis: row.estimate_basis,
  estimateSamples: row.estimate_samples === null ? null : Number(row.estimate_samples),
  ticketSnapshot: row.ticket_snapshot,
  ticketSnapshotAt: iso(row.ticket_snapshot_at),
  ticketSignalAt: iso(row.ticket_signal_at),
  reviewSubject: row.review_subject,
  historySample: row.history_sample,
  // `text[] not null default '{}'`, so the `?? []` is for a driver that hands back `null` rather
  // than for a row that can hold one (WP-37).
  riskClasses: row.risk_classes ?? [],
  coverage: row.coverage,
  dependencies: row.dependencies,
  requiredReviewers: row.required_reviewers,
  reviewThreads: row.review_threads,
  requestedByUserId: (row.requested_by_user_id ?? null) as Id | null,
  readyHeadSha: row.ready_head_sha ?? null,
  ciHeadSha: row.ci_head_sha ?? null,
  // `text[] not null default '{}'` (WP-102, migration 0065); the `?? []` is the driver's, as above.
  ciExcusedPaths: row.ci_excused_paths ?? [],
  version: Number(row.version),
});

/**
 * `tasks.pipeline_dial` through its published schema (WP-62), never cast.
 *
 * It decides whether a stage runs and whether a task parks, so a document that does not match the
 * current schema must not be read as one that does. A row that fails **throws** rather than reading
 * as `null`: `null` would compile the template with no dial at all, which is the permissive
 * direction — an Assist task would then run to a merge request because its copy of the policy was
 * unreadable (standing rule 20). Only the insert writes the column, through the same schema's type,
 * so the throw is reachable only from a row written by hand.
 */
const pipelineDialOf = (row: TaskRow): TaskPipelineDial | null => {
  if (row.pipeline_dial === null || row.pipeline_dial === undefined) {
    return null;
  }
  const parsed = taskPipelineDialSchema.safeParse(row.pipeline_dial);
  if (!parsed.success) {
    throw new PipelineStoredStateError(
      `task ${row.id} has a tasks.pipeline_dial that does not match the current schema (${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}); the task's pipeline cannot be compiled`,
    );
  }
  return parsed.data;
};

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
  /**
   * Where a **list** read reports a row it skipped because its `pipeline_dial` fails its schema
   * (WP-62 review round 1). Optional; silent by default.
   */
  readonly logger?: Logger;
}

export const createPostgresPipelineStore = (
  options: PostgresPipelineStoreOptions,
): PipelineStore => {
  const logger = options.logger ?? silentLogger;
  /**
   * A list read over **other** tasks — conflict warnings, the rebase re-check — must not fail
   * because one row's stored dial is unreadable, so the refusal is scoped to that task: the row is
   * skipped and named, and only the single-task reads (`load`, `findBy…`) refuse. The skipped task
   * is not lost: the next read that loads it by id throws, which is where its own work stops.
   */
  const listed = (rows: readonly TaskRow[]): StoredTask[] =>
    rows.flatMap((row) => {
      try {
        return [toStoredTask(row, templateFor(row))];
      } catch (error) {
        if (!(error instanceof PipelineStoredStateError)) {
          throw error;
        }
        logger.error(
          { task_id: row.id, err: error },
          'a task with an unreadable tasks.pipeline_dial was left out of a list read; loading it by id refuses',
        );
        return [];
      }
    });
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
        // The key, or the provider's stable id under any key (WP-134, migration 0077): a moved
        // issue is the same ticket. Oldest first, so the answer is the task that was there first.
        `select ${TASK_COLUMNS} from tasks t
          where t.project_id = $1 and t.ticket_provider = $2 and t.mode = $4
            and (t.ticket_key = $3 or ($5::text is not null and t.ticket_id = $5::text))
          order by t.created_at
          limit 1`,
        [query.projectId, query.provider, query.ticketKey, query.mode, query.ticketId ?? null],
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
      return listed(rows);
    },

    listWithMergeRequest: async (tx, projectId, query) => {
      // `state not in (…)` rather than `= 'active'`: the port's docblock says why, and the two
      // terminal states are spelled rather than derived because `task_state` is a database enum
      // and a value added to it later must not silently join this list.
      const { rows } = await sqlOf(tx).query<TaskRow>(
        `select ${TASK_COLUMNS} from tasks t
          where t.project_id = $1
            and t.id <> $2
            and t.mr_ref is not null
            and t.state not in ('done', 'cancelled')
          order by t.created_at
          limit $3`,
        [projectId, query.excludeTaskId, Math.max(query.limit, 0)],
      );
      return listed(rows);
    },

    countCompleted: async (tx, projectId) => {
      // `count(*)` rather than a page: the caller compares it to a small threshold and never reads
      // the rows. `done` is spelled rather than derived from "not cancelled and not active", for the
      // reason `listWithMergeRequest` gives about `task_state` being a database enum.
      const { rows } = await sqlOf(tx).query<{ n: string }>(
        `select count(*)::text as n from tasks where project_id = $1 and state = 'done'`,
        [projectId],
      );
      return Number(rows[0]?.n ?? 0);
    },

    insert: async (tx, stored) => {
      const { task } = stored;
      await sqlOf(tx).query(
        `insert into tasks (id, project_id, ticket_provider, ticket_key, ticket_url, template, mode,
                            state, current_stage, priority, template_snapshot, branch, mr_ref,
                            workpad_ref, stage_attempts, iteration_limits, iteration_counters,
                            cost_actual, estimate_usd, estimate_basis, estimate_samples,
                            ticket_snapshot, ticket_snapshot_at, review_subject, history_sample,
                            version, pipeline_dial, requested_by_user_id, settings_refreeze_pending,
                            refreeze_routing, ticket_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb,
                 $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20, $21, $22::jsonb, $23, $24::jsonb,
                 $25::jsonb, $26, $27::jsonb, $28, $29, $30::jsonb, $31)`,
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
          // The estimate's three companion columns round-trip through the insert too, so a
          // `StoredTask` that carries a basis is the one that loads back (the contract suite asserts
          // it). Nothing the pipeline creates has an estimate at insert time — `saveEstimate` is the
          // only writer that ever fills them — so in production all three are null here.
          stored.estimateBasis,
          stored.estimateSamples,
          // Intake writes the ticket's text here rather than through a later update, so the row
          // exists with it and there is no window for a concurrent writer to lose (WP-15f).
          stored.ticketSnapshot === null ? null : JSON.stringify(stored.ticketSnapshot),
          stored.ticketSnapshotAt,
          // WP-24: written here and nowhere else. A review-only task is created with the merge
          // request it reviews already read, so there is no update statement to lose it (migration
          // 0020 has the argument).
          stored.reviewSubject === null ? null : JSON.stringify(stored.reviewSubject),
          // WP-35: written here and nowhere else, for `review_subject`'s reason — the collection
          // made this sample for this run, and a second writer beside the stage executor would be
          // standing rule 79's lost update (migration 0030 has the argument).
          stored.historySample === null ? null : JSON.stringify(stored.historySample),
          stored.version,
          // WP-62: written here and nowhere else — the dial the task starts under, frozen for
          // `template_snapshot`'s reason (migration 0049 has the argument).
          stored.pipelineDial === null ? null : JSON.stringify(stored.pipelineDial),
          // WP-79: the requester the creating site named — a command's actor (discovery, a shadow
          // batch, a bootstrap's chunk tasks) or the reporter intake resolved. Until WP-79 this
          // column was **not in this statement**, so WP-67's three writers wrote it only in the
          // in-memory store and every PostgreSQL row read `null` (the contract suite now asserts
          // the round trip). `saveRequester` is its only other writer.
          stored.requestedByUserId,
          // WP-106 (migration 0066): the frozen limits and dial were taken under a `configRefusal`.
          stored.settingsRefreezePending === true,
          // WP-106 round 2: intake's routing inputs, kept while the re-take is pending.
          stored.refreezeRouting === null || stored.refreezeRouting === undefined
            ? null
            : JSON.stringify({
                issue_type: stored.refreezeRouting.issueType,
                can_create_tickets: stored.refreezeRouting.canCreateTickets,
              }),
          // WP-134 (migration 0077): the provider's stable id, written once and never updated.
          task.ticket.id ?? null,
        ],
      );
    },

    /**
     * `cost_actual = cost_actual + $2` — an increment, not a write (WP-31).
     *
     * The ask executor runs beside the stage executor and both add a run's spend to the same
     * column. A read-modify-write from either would lose the other's; the database does the
     * addition, so their order does not matter and neither needs the version token.
     */
    addSpend: async (tx, taskId, usd) => {
      if (!Number.isFinite(usd) || usd < 0) {
        throw new RangeError(
          `cannot add ${String(usd)} USD to task ${taskId}: spend is finite and non-negative`,
        );
      }
      const result = await sqlOf(tx).query(
        'update tasks set cost_actual = cost_actual + $2::numeric, updated_at = now() where id = $1',
        [taskId, usd],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },
    /** One indexed read of the task's stream (WP-131 review round 2), `takenOver`'s shape. */
    pausedBudgetScope: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<{ reason: string | null; scope: string | null }>(
        `select e.payload ->> 'reason' as reason, e.payload ->> 'budget_scope' as scope
           from events e
          where e.stream_type = 'task' and e.stream_id = $1 and e.type = 'task.paused'
          order by e.stream_seq desc
          limit 1`,
        [taskId],
      );
      const row = rows[0];
      if (row === undefined || row.reason !== 'budget') {
        return null;
      }
      const scope = pausedBudgetScopeSchema.safeParse(row.scope);
      return scope.success ? scope.data : null;
    },
    budgetCap: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<{ cap: string | null }>(
        'select budget_cap_usd::text as cap from tasks where id = $1',
        [taskId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
      return row.cap === null ? null : Number(row.cap);
    },
    /**
     * Read under `for update`, compared, written — the port's docblock has the contract. The
     * comparison is made here rather than in the `where` so the refusal can name the cap in force.
     */
    raiseBudgetCap: async (tx, input) => {
      const sql = sqlOf(tx);
      const { rows } = await sql.query<{ cap: string }>(
        `select coalesce(budget_cap_usd, $2::numeric)::text as cap
           from tasks where id = $1 for update`,
        [input.taskId, input.defaultCapUsd],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new PipelineRowMissingError(`task ${input.taskId} does not exist`);
      }
      const previousCapUsd = Number(row.cap);
      if (!(input.capUsd > previousCapUsd)) {
        return { raised: false, previousCapUsd };
      }
      await sql.query('update tasks set budget_cap_usd = $2, updated_at = now() where id = $1', [
        input.taskId,
        input.capUsd,
      ]);
      return { raised: true, previousCapUsd };
    },
    saveTicketSnapshot: async (tx, taskId, snapshot, readAt) => {
      // Two columns, for the reason `saveWorkpad` is one: the backfill runs in the `stage.execute`
      // job beside the stage executor's transactions, and a whole-row write from there is a lost
      // update of everything it did not read (PROGRESS backlog 18).
      const result = await sqlOf(tx).query(
        `update tasks set ticket_snapshot = $2::jsonb, ticket_snapshot_at = $3, updated_at = now()
          where id = $1`,
        [taskId, JSON.stringify(snapshot), readAt],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /**
     * `risk_classes` — one column, one statement, written whole (WP-37).
     *
     * The fourth narrow write and the third with the same argument behind it (standing rule 79):
     * this runs in a `pipeline.outbound` job beside the stage executor's transactions, so a
     * whole-row `save` from here would put back a state, a stage and a cost it never read. The
     * array is replaced rather than merged, because the rebase gate is re-entered whenever the
     * default branch moves and a class the merge request no longer touches has to leave the row.
     */
    /**
     * `superseded_merge_requests` (migration 0043, WP-59 review round 1, PROGRESS backlog 178):
     * written in the rework's own transaction. Not an `update tasks`, so it is no writer of the task
     * row; a second supersession of one `(task, iid)` is the latest one, unsettled again.
     */
    recordSupersededMergeRequest: async (tx, record) => {
      await sqlOf(tx).query(
        `insert into superseded_merge_requests
           (task_id, iid, project_id, mr_ref, new_branch, cause_event_id, superseded_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7)
         on conflict (task_id, iid) do update
           set project_id = excluded.project_id, mr_ref = excluded.mr_ref,
               new_branch = excluded.new_branch, cause_event_id = excluded.cause_event_id,
               superseded_at = excluded.superseded_at, settled_at = null, outcome = null,
               detail = null, recovery_attempted_at = null`,
        [
          record.taskId,
          record.mr.iid,
          record.projectId,
          JSON.stringify(record.mr),
          record.newBranch,
          record.causeEventId,
          record.supersededAt,
        ],
      );
    },

    /** The duty's mark — the first ending is the one that happened (`settled_at is null`). */
    settleSupersededMergeRequest: async (tx, input) => {
      await sqlOf(tx).query(
        `update superseded_merge_requests
            set settled_at = $3, outcome = $4, detail = $5
          where task_id = $1 and iid = $2 and settled_at is null`,
        [input.taskId, input.iid, input.at, input.outcome, input.detail ?? null],
      );
    },

    /**
     * `version`, and the bookkeeping `updated_at` every writer of this row sets (the census's other
     * shared column) — no column of the aggregate (WP-59 review round 1; "`version` alone" was not
     * true of the statement). `TaskRepository.bumpVersion` carries why an
     * out-of-band appender moves the token, and why before it re-reads the stream.
     */
    bumpVersion: async (tx, taskId) => {
      const result = await sqlOf(tx).query(
        'update tasks set version = version + 1, updated_at = now() where id = $1',
        [taskId],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /**
     * `ticket_signal_at` — the ninth narrow writer (WP-60, migration 0044), and the only one that
     * writes **many** rows: every live task of one ticket. `greatest(coalesce(…, $5), $5)` so a
     * redelivered or out-of-order signal never moves it backwards; no version bump, because `save`
     * does not name the column. The port's docblock has the rest.
     */
    recordTicketSignal: async (tx, signal) => {
      const result = await sqlOf(tx).query(
        `update tasks
            set ticket_signal_at = greatest(coalesce(ticket_signal_at, $4::timestamptz), $4::timestamptz),
                updated_at = now()
          where project_id = $1 and ticket_provider = $2 and ticket_key = $3
            and state not in ('done', 'cancelled')`,
        [signal.projectId, signal.provider, signal.ticketKey, signal.at],
      );
      return result.rowCount ?? 0;
    },

    /**
     * One key of `mr_ref` — `head_sha` — forward only by the provider's instant, and the token when
     * the head moves (WP-60, PROGRESS backlog 182; ordered at review round 1).
     *
     * The row is locked and read first (`for update`), so the one statement below knows whether the
     * sha moves: when it does, `jsonb_set` rewrites the key in place and `version` is bumped (rule 79;
     * `mr_ref` was `save`'s until WP-138, and the bump stays — the port says why); when it does not, only `mr_head_at` advances. The predicate is the
     * ordering rule: `mr_head_at is null or mr_head_at < $4` — strictly later, so an equal instant
     * moves nothing (the port's docblock says why).
     */
    saveMergeRequestHead: async (tx, taskId, head) => {
      const sql = sqlOf(tx);
      const { rows } = await sql.query<{ head_sha: string | null }>(
        `select mr_ref ->> 'head_sha' as head_sha from tasks where id = $1 for update`,
        [taskId],
      );
      const current = rows[0];
      if (current === undefined) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
      const moves = current.head_sha !== head.headSha;
      const result = await sql.query(
        `update tasks
            set mr_ref = case when $5 then jsonb_set(mr_ref, '{head_sha}', to_jsonb($3::text)) else mr_ref end,
                mr_head_at = $4::timestamptz,
                version = version + case when $5 then 1 else 0 end, updated_at = now()
          where id = $1 and (mr_ref ->> 'iid')::int = $2
            and (mr_head_at is null or mr_head_at < $4::timestamptz)
            and state not in ('done', 'cancelled')`,
        [taskId, head.iid, head.headSha, head.at, moves],
      );
      return moves && (result.rowCount ?? 0) > 0;
    },

    saveRiskClasses: async (tx, taskId, classes) => {
      const result = await sqlOf(tx).query(
        'update tasks set risk_classes = $2::text[], updated_at = now() where id = $1',
        [taskId, [...classes]],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /**
     * `ready_head_sha` — the head the gates judged on the way into Ready (WP-79, migration 0056).
     * One column, one statement, `null` as readily as a head, and no version bump: `save` does not
     * name the column (the partition `tasks-column-ownership.test.ts` holds).
     */
    saveReadyHead: async (tx, taskId, headSha) => {
      const result = await sqlOf(tx).query(
        'update tasks set ready_head_sha = $2, updated_at = now() where id = $1',
        [taskId, headSha],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /**
     * `template`, `template_snapshot`, `iteration_limits`, `pipeline_dial`, `settings_refreeze_pending`
     * and `refreeze_routing` — one statement, their only `update` writer (WP-106, migration 0066). Called for
     * a task created under a `configRefusal` by the intake stage-completion handler (where the
     * template may still be routed again) and by the stage executor's admission (the backstop,
     * before its first admitted run). No version bump: `save` names none of the six.
     */
    refreezeSettings: async (tx, taskId, frozen) => {
      const result = await sqlOf(tx).query(
        `update tasks set template = $4, template_snapshot = $5::jsonb,
                iteration_limits = $2::jsonb, pipeline_dial = $3::jsonb,
                settings_refreeze_pending = false, refreeze_routing = null, updated_at = now()
          where id = $1`,
        [
          taskId,
          JSON.stringify(frozen.limits),
          frozen.pipelineDial === null ? null : JSON.stringify(frozen.pipelineDial),
          frozen.templateId,
          JSON.stringify(frozen.template),
        ],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },
    /**
     * `ci_head_sha` — the head the CI gate last passed (WP-79 review round 2, migration 0056) — and
     * `ci_excused_paths`, the paths it excused provisionally (WP-102, migration 0065). Two columns
     * one settlement decides together, so one statement; no version bump.
     */
    saveCiSettlement: async (tx, taskId, settlement) => {
      const result = await sqlOf(tx).query(
        'update tasks set ci_head_sha = $2, ci_excused_paths = $3::text[], updated_at = now() where id = $1',
        [taskId, settlement.headSha, [...settlement.excusedPaths]],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /**
     * `requested_by_user_id` — **fill, never overwrite** (WP-79, PROGRESS backlog 243).
     *
     * The predicate is the rule: a requester the insert wrote (a command's actor, or the reporter
     * intake resolved) is never replaced by a later read. A row that is already filled answers
     * `false` rather than throwing, so the distinction between "filled" and "missing" is made by a
     * second query only when nothing moved.
     */
    saveRequester: async (tx, taskId, userId) => {
      const result = await sqlOf(tx).query(
        `update tasks set requested_by_user_id = $2, updated_at = now()
          where id = $1 and requested_by_user_id is null`,
        [taskId, userId],
      );
      if ((result.rowCount ?? 0) > 0) {
        return true;
      }
      const exists = await sqlOf(tx).query('select 1 from tasks where id = $1', [taskId]);
      if (exists.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
      return false;
    },

    /**
     * `coverage` — one column, one statement, written whole (WP-39, migration 0027).
     *
     * The fifth narrow write and the fourth with the same argument behind it (standing rule 79):
     * the `coverage` duty runs in a `pipeline.outbound` job beside the stage executor's
     * transactions, so a whole-row `save` from here would put back a state, a stage and a cost it
     * never read.
     *
     * **Parsed before it is written**, for the reason `saveWorkpad` is (WP-15h): `jsonb` accepts
     * any document, so a shape the published `taskCoverageSchema` cannot describe would be stored
     * happily here and answered as a 500 by the first reader — the task page. Fail closed on a
     * mutation (standing rule 20), where the stack trace still names this caller.
     */
    /**
     * `dependencies` — one column, one statement, written whole (WP-38, migration 0028).
     *
     * Narrow for the reason `saveCoverage` is: the `dependency_gate` duty runs in a
     * `pipeline.outbound` job beside the stage executor's transactions, so a whole-row `save` from
     * there would put back the state, the stage and the cost as they were when the job started
     * (standing rule 79). **Parsed before it is written** (WP-15h): `jsonb` accepts any document and
     * the disagreement would surface at the task page, which is the reader.
     */
    saveDependencies: async (tx, taskId, dependencies) => {
      const parsed = taskDependenciesSchema.parse(dependencies);
      const result = await sqlOf(tx).query(
        'update tasks set dependencies = $2::jsonb, updated_at = now() where id = $1',
        [taskId, JSON.stringify(parsed)],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /** `required_reviewers` — the same shape, written by the `risk_route` duty (WP-38). */
    saveRequiredReviewers: async (tx, taskId, reviewers) => {
      const parsed = taskReviewersSchema.parse(reviewers);
      const result = await sqlOf(tx).query(
        'update tasks set required_reviewers = $2::jsonb, updated_at = now() where id = $1',
        [taskId, JSON.stringify(parsed)],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /**
     * `review_threads` — the same shape, written by BD-007's review window (WP-46, migration 0048).
     * Parsed before it is written, for the reason every `jsonb` column on `tasks` is.
     */
    saveReviewThreads: async (tx, taskId, threads) => {
      const parsed = taskReviewThreadsSchema.parse(threads);
      const result = await sqlOf(tx).query(
        'update tasks set review_threads = $2::jsonb, updated_at = now() where id = $1',
        [taskId, JSON.stringify(parsed)],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    saveCoverage: async (tx, taskId, coverage) => {
      const parsed = taskCoverageSchema.parse(coverage);
      const result = await sqlOf(tx).query(
        'update tasks set coverage = $2::jsonb, updated_at = now() where id = $1',
        [taskId, JSON.stringify(parsed)],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    saveWorkpad: async (tx, taskId, workpad) => {
      // One column, and since WP-15e `save` does not name it at all: the workpad is written from a
      // job that runs beside the stage executor's transactions (WP-15d), so a whole-row write from
      // here would be a lost update of whatever it did not read — and a `save` that named
      // `workpad_ref` was a lost update in the other direction, which is what WP-15e closed.
      //
      // **Parsed before it is written** (WP-15h). `workpad_ref` is `jsonb`, so the column accepts
      // any document and the disagreement only surfaces when something *reads* it: `upsertWorkpad`
      // returns a `CommentRef` (a `WorkpadRef` plus `marker_id`), TypeScript passed the wider
      // object through the port's `WorkpadRef` parameter structurally, and the first reader — the
      // API of technical/08 — answered 500 on a strict schema's `Unrecognized key`. Fail closed on
      // a mutation (standing rule 20): a value the published shape cannot describe is refused at
      // the write, where the stack trace still names the caller.
      const result = await sqlOf(tx).query(
        'update tasks set workpad_ref = $2::jsonb, updated_at = now() where id = $1',
        [taskId, JSON.stringify(workpadRefSchema.parse(workpad))],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
    },

    /**
     * The aggregate's columns, and only over the row this snapshot was read from (WP-15e).
     *
     * `where … and version = $10` with `version = version + 1` in the same statement is the whole
     * of the optimistic check: PostgreSQL's READ COMMITTED re-evaluates the predicate against the
     * row a concurrent writer left behind, so a write that raced one matches nothing rather than
     * winning. `workpad_ref` is **not** in the set list and must not be — it belongs to
     * `saveWorkpad`, and naming it here is exactly how the executor used to put back the `null` the
     * workpad job had just filled in (migration 0019's docblock has the measurement).
     *
     * **`cost_actual` left this list at WP-31**, for the same reason and with a sharper edge. The
     * ask executor adds a run's spend from a process that runs *beside* this one, and the version
     * token cannot help: `addSpend` is an increment and deliberately bumps no version, so a `save`
     * that carried `cost_actual = <a value read before the ask committed>` would match the predicate
     * and silently put the ask's spend back. The column now has exactly one writing statement —
     * `addSpend` — and the stage executor calls it in the same transaction as this save.
     * `tasks-column-ownership.test.ts` is what holds that rather than this sentence.
     */
    save: async (tx, stored) => {
      const { task } = stored;
      const sql = sqlOf(tx);
      // `mr_ref` is not in the list since WP-138: it belongs to `recordMergeRequest`,
      // `releaseMergeRequest` and `saveMergeRequestHead`, and the row's own value is read back.
      const result = await sql.query<{ version: number; mr_ref: MergeRequestRef | null }>(
        `update tasks
            set state = $2::task_state, current_stage = $3, branch = $4,
                stage_attempts = $5::jsonb, iteration_counters = $6::jsonb,
                version = version + 1, updated_at = now(),
                completed_at = case when $2::text in ('done', 'cancelled') then now() else completed_at end
          where id = $1 and version = $7
        returning version, mr_ref`,
        [
          task.id,
          task.state,
          task.currentStage,
          stored.branch,
          JSON.stringify(task.stageAttempts),
          JSON.stringify(task.iterationCounters),
          stored.version,
        ],
      );
      const written = result.rows[0];
      if (written === undefined) {
        // Two different failures share one empty result, and telling them apart is the difference
        // between "retry against a fresh read" and "stop, there is nothing to write". The extra
        // query runs only on the path that is already going to throw.
        const { rows } = await sql.query<{ version: number }>(
          'select version from tasks where id = $1',
          [task.id],
        );
        const current = rows[0];
        if (current === undefined) {
          // A save that wrote nothing is how a state machine silently stops advancing; the
          // in-memory store refuses the same way, which is what makes the two interchangeable.
          throw new PipelineRowMissingError(`task ${task.id} does not exist`);
        }
        throw new TaskConcurrentModificationError(task.id, stored.version, Number(current.version));
      }
      // The version the row now carries, read back rather than assumed: a caller that saves twice
      // in one transaction needs the value the first write consumed.
      return { ...stored, mr: written.mr_ref ?? null, version: Number(written.version) };
    },

    /**
     * `mr_ref` — the developer's merge request, compare-and-set (WP-138 ruling (e)): only while the
     * row holds none or the same iid, and only on the task's own branch (or none yet). Re-recording
     * the same iid **keeps the stored head** — the head moves forward only through
     * `saveMergeRequestHead`, by the provider's instant, and a tool answer read before a later push
     * must not put an older revision back (review round 1). No version bump: `save` does not name
     * the column.
     */
    recordMergeRequest: async (tx, taskId, mr) => {
      const sql = sqlOf(tx);
      const parsed = mergeRequestRefSchema.parse(mr);
      const result = await sql.query(
        `update tasks
            set mr_ref = case
                  when mr_ref ->> 'head_sha' is not null
                    then jsonb_set($2::jsonb, '{head_sha}', mr_ref -> 'head_sha')
                  else $2::jsonb
                end,
                updated_at = now()
          where id = $1
            and (mr_ref is null or (mr_ref ->> 'iid')::int = $3)
            and (branch is null or branch = $4)`,
        [taskId, JSON.stringify(parsed), parsed.iid, parsed.branch ?? null],
      );
      if ((result.rowCount ?? 0) > 0) {
        return { kind: 'recorded' };
      }
      const { rows } = await sql.query<{ mr_ref: MergeRequestRef | null }>(
        'select mr_ref from tasks where id = $1',
        [taskId],
      );
      const current = rows[0];
      if (current === undefined) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
      return { kind: 'refused', recorded: current.mr_ref ?? null };
    },

    /** `mr_ref = null` while it names `iid` — the rework's let-go (WP-59, narrow since WP-138). */
    releaseMergeRequest: async (tx, taskId, iid) => {
      const sql = sqlOf(tx);
      const result = await sql.query(
        `update tasks
            set mr_ref = null, updated_at = now()
          where id = $1 and (mr_ref ->> 'iid')::int = $2`,
        [taskId, iid],
      );
      if ((result.rowCount ?? 0) > 0) {
        return true;
      }
      const { rows } = await sql.query('select 1 from tasks where id = $1', [taskId]);
      if (rows.length === 0) {
        throw new PipelineRowMissingError(`task ${taskId} does not exist`);
      }
      return false;
    },

    /**
     * Serialised per project for the rest of the caller's transaction (WP-91, the port's
     * obligation): a transaction-scoped advisory lock on the project is taken **before** the
     * count, so a second admitter waits for the first to commit and then — READ COMMITTED takes a
     * fresh snapshot per statement — counts the task the first admitted. Without it two intakes in
     * one instant both counted `0` and both admitted under `max_parallel_tasks: 1` (the residual
     * standing rule 89 named). The key is namespaced (`task_admission/`) so it cannot collide
     * with another advisory lock the platform takes on a project id. Its contention is bounded and
     * measured at the port's docblock (`TaskRepository.counts`, WP-115, PROGRESS backlog 314).
     */
    counts: async (tx, projectId) => {
      await sqlOf(tx).query(
        `select pg_advisory_xact_lock(hashtextextended('task_admission/' || $1, 0))`,
        [projectId],
      );
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

    /**
     * Every `state` this store writes is **parsed** with the contracts' vocabulary first (WP-55):
     * the same schema `apps/server` parses the column with on the way out, and the same list
     * migration 0040's `task_stages_state_known` holds the database to. A caller that spelled a
     * word the vocabulary does not have is refused here, by name, rather than by the constraint.
     */
    recordStageEntered: async (tx, entry) => {
      await sqlOf(tx).query(
        `insert into task_stages (task_id, stage, attempt, state, caused_by_event_id, entered_at)
         values ($1, $2, $3, $5, $4, clock_timestamp())
         on conflict (task_id, stage, attempt) do update
            set state = excluded.state, entered_at = excluded.entered_at, exited_at = null,
                returned_to = null,
                caused_by_event_id = excluded.caused_by_event_id`,
        [
          entry.taskId,
          entry.stage,
          entry.attempt,
          entry.causedByEventId,
          taskStageStateSchema.parse('running'),
        ],
      );
    },

    recordStageExited: async (tx, entry) => {
      const state = taskStageExitStateSchema.parse(entry.state);
      if ((state === 'returned') !== (entry.returnedTo !== null)) {
        // `task_stages_returned_to_is_a_return` would refuse half of this; the other half — a
        // return with no target — is a return the reader can never find, which is the defect
        // WP-55 exists to close. Refused here for both, naming the row.
        throw new RangeError(
          `task_stages ${entry.taskId}/${entry.stage}#${String(entry.attempt)}: state "${state}" with returned_to ${JSON.stringify(entry.returnedTo)} — a return names its target and nothing else does`,
        );
      }
      await sqlOf(tx).query(
        `update task_stages
            set state = $6, exited_at = clock_timestamp(), outcome = $4, return_reason = $5,
                returned_to = $7, return_reason_original_chars = $8
          where task_id = $1 and stage = $2 and attempt = $3`,
        [
          entry.taskId,
          entry.stage,
          entry.attempt,
          // The column's one vocabulary (WP-73, backlog 213), parsed as `state` is.
          taskStageOutcomeSchema.parse(entry.outcome),
          entry.returnReason,
          state,
          entry.returnedTo,
          // WP-81: the uncut length when the writer cut the reason; the check (migration 0058)
          // refuses anything but a positive length beside a reason.
          entry.returnReasonOriginalChars ?? null,
        ],
      );
    },

    /**
     * `where state = 'running'`: an escalation closes only a row nothing closed first (WP-46,
     * backlog 160). A row that is already closed keeps what its stage decided; see the port.
     */
    closeOpenStage: async (tx, entry) => {
      await sqlOf(tx).query(
        `update task_stages
            set state = $4, exited_at = clock_timestamp(), outcome = $5, return_reason = $6,
                returned_to = null, return_reason_original_chars = null
          where task_id = $1 and stage = $2 and attempt = $3 and state = $7`,
        [
          entry.taskId,
          entry.stage,
          entry.attempt,
          taskStageExitStateSchema.parse('failed'),
          taskStageOutcomeSchema.parse(entry.outcome),
          entry.reason,
          taskStageStateSchema.parse('running'),
        ],
      );
    },

    recordStageSignature: async (tx, entry) => {
      await sqlOf(tx).query(
        `insert into task_stages (task_id, stage, attempt, state, signature, entered_at)
         values ($1, $2, $3, $5, $4, clock_timestamp())
         on conflict (task_id, stage, attempt) do update set signature = excluded.signature`,
        [
          entry.taskId,
          entry.stage,
          entry.attempt,
          entry.signature,
          taskStageStateSchema.parse('running'),
        ],
      );
    },

    stageAttemptState: async (tx, taskId, stage, attempt) => {
      const { rows } = await sqlOf(tx).query<{ open: boolean }>(
        `select (state = 'running' and exited_at is null) as open from task_stages
          where task_id = $1 and stage = $2 and attempt = $3`,
        [taskId, stage, attempt],
      );
      const row = rows[0];
      return row === undefined ? 'absent' : row.open ? 'open' : 'closed';
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

    /**
     * The port's docblock has the rule; this is its SQL. `previous` is the instant `stage`'s latest
     * **earlier** attempt stopped being current — its exit, or its entry for an attempt nobody
     * closed — and only a return that closed strictly after it can be the one that caused this
     * attempt. **An earlier attempt that is itself a return to this stage** (a human's return or
     * rework at the stage the task is at: `from === to`) counts by its **entry**, because its exit
     * *is* the return that caused this attempt and would otherwise exclude itself. `current` bounds it from above when the attempt has been entered, so the question
     * about attempt `n` has one answer however many loops came after it.
     *
     * **Why the stage writes above stamp `clock_timestamp()` rather than `now()`** (WP-55). The rule
     * orders a return against an entry, and the return that causes an attempt is closed *in the same
     * transaction* that enters it — so under `now()`, the transaction's one instant, the two are
     * equal, and so is every row a single transaction writes. The order the rule needs is the order
     * the rows were written in, which is what `clock_timestamp()` records. The residual is the
     * wall clock's: a step backwards between two transactions of the same task could misorder them.
     */
    lastReturnReason: async (tx, taskId, stage, attempt) => {
      const { rows } = await sqlOf(tx).query<{
        return_reason: string;
        return_reason_original_chars: number | null;
        cause_type: string | null;
        cause_version: number | null;
      }>(
        `with previous as (
           select max(case when returned_to = $2 then entered_at
                           else coalesce(exited_at, entered_at) end) as at
             from task_stages
            where task_id = $1 and stage = $2 and attempt < $3
         ), current as (
           select max(entered_at) as at
             from task_stages
            where task_id = $1 and stage = $2 and attempt = $3
         )
         select r.return_reason, r.return_reason_original_chars,
                c.cause_type, c.cause_version
           from task_stages r
          cross join previous
          cross join current
           -- WP-83: the artifact a run of the returning attempt produced — the verdict that
           -- caused the return, or nothing for a return no artifact caused.
           left join lateral (
             select a.type::text as cause_type, a.version as cause_version
               from artifacts a
               join runs ru on ru.id = a.produced_by_run_id
              where ru.task_stage_id = r.id and a.task_id = r.task_id
                -- Only a verdict returns a task (stageVerdict); another artifact the same
                -- attempt produced is not a cause, whatever its version.
                and a.type in ('ReviewVerdict', 'AcceptanceVerdict')
              order by a.version desc
              limit 1
           ) c on true
          where r.task_id = $1 and r.returned_to = $2
            and r.return_reason is not null and r.exited_at is not null
            and (previous.at is null or r.exited_at > previous.at)
            and (current.at is null or r.exited_at <= current.at)
          order by r.exited_at desc, r.entered_at desc
          limit 1`,
        [taskId, stage, attempt],
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        reason: row.return_reason,
        originalChars: row.return_reason_original_chars ?? null,
        ...(row.cause_type === null || row.cause_version === null
          ? {}
          : {
              cause: {
                type: artifactTypeSchema.parse(row.cause_type),
                version: row.cause_version,
              },
            }),
      };
    },
    takenOver: async (tx, taskId) => {
      // One indexed read of the task's own stream (WP-56): the newest boundary event decides, the
      // same projection `apps/server`'s read model makes over two of these types. A payload that
      // does not carry a branch and a stage answers **nothing** rather than a blank block, because
      // the branch is the whole point of the record.
      //
      // The holder's last activity (WP-44, backlog 167) is the shared expression, so the recovery
      // row's query computes the same instant this one does.
      const { rows } = await sqlOf(tx).query<{
        id: string;
        type: string;
        payload: Record<string, unknown>;
        occurred_at: Date | string;
        actor: { kind?: unknown; user_id?: unknown };
        last_activity_at: Date | string;
      }>(
        `select e.id, e.type, e.payload, e.occurred_at, e.actor,
                ${takeOverLastActivitySql('$1', 'e')} as last_activity_at
           from events e
          where e.stream_type = 'task' and e.stream_id = $1 and e.type = any($2::text[])
          order by e.stream_seq desc
          limit 1`,
        [taskId, [...TAKE_OVER_BOUNDARY_EVENTS]],
      );
      const row = rows[0];
      if (row === undefined || row.type !== 'task.taken_over') {
        return null;
      }
      const { branch, stage, session_id: sessionId } = row.payload;
      if (typeof branch !== 'string' || typeof stage !== 'string') {
        return null;
      }
      return {
        eventId: row.id as Id,
        at: isoOf(row.occurred_at),
        branch,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        stage: stage as Slug,
        holderUserId:
          row.actor.kind === 'user' && typeof row.actor.user_id === 'string'
            ? (row.actor.user_id as Id)
            : null,
        lastActivityAt: isoOf(row.last_activity_at),
      };
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
        // `redaction_count` is named explicitly and has no default (migration 0038): an insert
        // that omitted it would be refused by `artifacts_redaction_count_recorded` rather than
        // recorded as "no redactor ran", which is what a null in that column means.
        `insert into artifacts (id, task_id, type, version, markdown, data, schema_version,
                                produced_by_run_id, redaction_count)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          artifact.id,
          artifact.taskId,
          artifact.type,
          artifact.version,
          artifact.markdown,
          JSON.stringify(artifact.data),
          artifact.schemaVersion,
          artifact.producedByRunId,
          artifact.redactionCount,
        ],
      );
    },
    latest: async (tx, taskId, type) => {
      const { rows } = await sqlOf(tx).query<ArtifactRow>(
        `select id, task_id, type, version, markdown, data, schema_version, produced_by_run_id,
                redaction_count, created_at
           from artifacts where task_id = $1 and type = $2 order by version desc limit 1`,
        [taskId, type],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredArtifact(row);
    },
    listFor: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<ArtifactRow>(
        `select id, task_id, type, version, markdown, data, schema_version, produced_by_run_id,
                redaction_count, created_at
           from artifacts where task_id = $1 order by created_at, version`,
        [taskId],
      );
      return rows.map(toStoredArtifact);
    },
  };

  const runs: RunRepository = {
    /**
     * **`task_stage_id` is written here, and until WP-15h it was not** — so every run this
     * repository ever stored was unattached to the stage it ran, and `load` answered `stage: null`
     * for all of them while the caller had passed the stage in.
     *
     * The link is the schema's own answer to where a run's stage lives: technical/03 keeps the
     * stage on `task_stages` and `packages/infrastructure/src/db/schema/pipeline.ts` says in as
     * many words that `RunRecord.stage` "is not a column here … so the API projection joins rather
     * than reads it". There was nothing to join to. The subquery resolves the row by the same
     * `(task_id, stage, attempt)` key `recordStageEntered` upserts on, which is unique, so it picks
     * exactly one row or none.
     *
     * **None is a legitimate answer and it is left as null rather than refused** (rule 20's read
     * side): a run inserted for a stage nobody entered — a repository-level test, a future
     * out-of-pipeline run — still records everything else about itself, and the reader that needs
     * the stage refuses that row by name (`apps/server/src/routes/runs.ts`).
     */
    insert: async (tx, run) => {
      await sqlOf(tx).query(
        // `system_prompt`, `user_prompt` and `redaction_count` are written **here**, at creation,
        // and never re-derived (Q64, WP-52): the prompt's nonce is drawn per prompt and the pack is
        // a point-in-time read, so a re-derivation is a different document answering a different
        // question. `runs.redaction_count` is what the redactor replaced *in those two columns*.
        `insert into runs (id, task_id, project_id, task_stage_id, role, mode, attempt, model,
                           effort, prompt_version, status, started_at,
                           system_prompt, user_prompt, redaction_count,
                           context_budget_tokens, context_total_tokens, context_kb_commit,
                           context_text_search, settings_snapshot, settings_hash, reserve_usd,
                           prompts_withheld)
         values ($1, $2, $3,
                 (select id from task_stages
                   where task_id = $2 and stage = $11 and attempt = $6),
                 $4, $5, $6, $7, $8, $9, $10, $12, $13, $14, $15, $16, $17, $18, $19::jsonb,
                 coalesce($20::jsonb, '{}'::jsonb), $21, nullif($22::numeric, 0), $23::jsonb)`,
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
          run.stage,
          // The caller's clock rather than `now()`, so the column and the `run.started` event agree
          // and so the in-memory store can answer the same value (WP-15i).
          run.startedAt,
          run.systemPrompt,
          run.userPrompt,
          // 0004's `not null default 0` is still on the column, so a null here would be refused
          // rather than stored — which is why the caller's type makes the count required for a row
          // that carries a prompt (see `StoredRun.redactionCount`).
          run.redactionCount,
          // The pack's header (migration 0041). All three null is "no pack was recorded", which
          // the reader refuses by name; a pack with empty tiers still writes its budget.
          run.contextPack?.budget_tokens ?? null,
          run.contextPack?.total_tokens ?? null,
          run.contextPack?.kb_commit ?? null,
          // What the text step did (migration 0047, WP-44); null for a pack that recorded none.
          run.contextPack?.text_search == null ? null : JSON.stringify(run.contextPack.text_search),
          // WP-91 (backlog 227): the column's first writer. No snapshot keeps 0004's `'{}'` default
          // (the column is `not null`), and `settings_hash is null` is what says "none recorded".
          run.settings === null ? null : JSON.stringify(run.settings.snapshot),
          run.settings?.hash ?? null,
          // WP-131 (migration 0072): the reservation every cap holds the run at if nobody measures
          // it. `nullif(…, 0)`: a stage configured at a cap of 0 is admitted (`usdSchema` allows
          // it) and the column refuses it (`reserve_usd > 0`), so it is stored as "none recorded"
          // and held at the reservation of **whatever stage asks next** — more than its own 0 when
          // that stage's cap is above 0 (the fail-closed side of rule 20), exactly 0 when the
          // asking stage's is 0 too, and a different figure from one admission to the next.
          run.reserveUsd,
          // WP-121 (migration 0073, backlog 363): why the project's prompt files were withheld
          // from this run, or null when nothing was.
          run.promptsWithheld === null ? null : JSON.stringify(run.promptsWithheld),
        ],
      );
      if (run.contextPack !== null) {
        await insertContextPackRows(sqlOf(tx), run.id, run.contextPack);
      }
    },
    /**
     * Conditional on the run still being live — the port's own contract, and the reasoning is
     * there. The predicate is `ACTIVE_RUN_STATUSES`, passed as a parameter rather than inlined so
     * the SQL and the domain's table cannot drift apart.
     */
    finish: async (tx, outcome) => {
      const result = await sqlOf(tx).query(
        `update runs
            set status = $2, terminal_reason = $3, session_id = $4, num_turns = $5,
                input_tokens = $6, output_tokens = $7, cache_write_5m_tokens = $8,
                cache_write_1h_tokens = $9, cache_read_tokens = $10, usd_reported = $11,
                usd_estimated = $12, wall_ms = $13, ended_at = now(), figure_is_floor = $15
          where id = $1 and status = any($14::run_status[])`,
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
          reportedUsd(outcome.cost),
          estimatedUsd(outcome.cost),
          outcome.wallMs,
          [...ACTIVE_RUN_STATUSES],
          // WP-131 pre-review round (backlog 407): the cost above is a floor, not a figure.
          outcome.costIsFloor === true,
        ],
      );
      if (result.rowCount !== 0) {
        // The winner closes the run's pending commands, after the row moved (WP-85): a command
        // that held the run `for share` has committed by now and this later statement sees it.
        await closePendingRunCommands(sqlOf(tx), outcome.runId);
        return true;
      }
      // Nothing was written: either the run is already terminal (somebody else ended it) or it
      // does not exist. They are different facts and the caller branches on them differently, so
      // the losing path pays for one extra read rather than the winning path paying for a join.
      const { rows } = await sqlOf(tx).query<{ id: string }>('select id from runs where id = $1', [
        outcome.runId,
      ]);
      if (rows.length === 0) {
        throw new PipelineRowMissingError(`run ${outcome.runId} does not exist`);
      }
      return false;
    },
    /**
     * The late cost write of Q70 (b) — the port's docblock carries the reasoning.
     *
     * Three predicates, and each one is a different wrong write refused. `status <> all(active)`:
     * a live run's cost belongs to its own `finish`. `usd_reported is null and usd_estimated is
     * null`: a row that already carries a figure has one from a writer that knew it, and the last
     * write must not be the winner. `not exists (cost_entries)`: the ledger has already charged
     * this run, so charging it again from here would double it — which is what makes a repeat of
     * the caller's whole transaction a no-op rather than a second charge (the `cost_entries_run_idx`
     * lookup is the same one `UNLEDGERED_RUN_SQL` makes at admission).
     *
     * `wall_ms` and `num_turns` are `greatest(…)` rather than assignments: the process that ended
     * the row computed a wall time from `started_at` and it is not this caller's to shorten.
     */
    recordCost: async (tx, late) => {
      const result = await sqlOf(tx).query(
        `update runs
            set session_id = coalesce(session_id, $2), num_turns = greatest(num_turns, $3),
                input_tokens = $4, output_tokens = $5, cache_write_5m_tokens = $6,
                cache_write_1h_tokens = $7, cache_read_tokens = $8,
                usd_reported = $9, usd_estimated = $10, wall_ms = greatest(wall_ms, $11),
                figure_is_floor = $13
          where id = $1
            and not (status = any($12::run_status[]))
            and usd_reported is null and usd_estimated is null
            and not exists (select 1 from cost_entries c where c.run_id = runs.id)`,
        [
          late.runId,
          late.sessionId,
          late.numTurns,
          late.usage.input_tokens,
          late.usage.output_tokens,
          late.usage.cache_write_5m_tokens,
          late.usage.cache_write_1h_tokens,
          late.usage.cache_read_tokens,
          reportedUsd(late.cost),
          estimatedUsd(late.cost),
          late.wallMs,
          [...ACTIVE_RUN_STATUSES],
          late.costIsFloor === true,
        ],
      );
      if (result.rowCount !== 0) {
        return true;
      }
      const { rows } = await sqlOf(tx).query<{ id: string }>('select id from runs where id = $1', [
        late.runId,
      ]);
      if (rows.length === 0) {
        throw new PipelineRowMissingError(`run ${late.runId} does not exist`);
      }
      return false;
    },
    /**
     * Claims the lease, or renews one this process already holds — the port's docblock has the rest.
     *
     * `lease_owner is null or lease_owner = $2` is what makes the claim and the renewal one
     * statement: the row is inserted with no owner, so the first beat claims it and every later
     * beat matches its own name. A process that finds another owner writes nothing and is told so,
     * rather than stealing a lease whose holder may be alive.
     */
    renewLease: async (tx, lease) => {
      const result = await sqlOf(tx).query(
        `update runs
            set lease_owner = $2, lease_expires_at = $3::timestamptz
          where id = $1
            and status = any($4::run_status[])
            and (lease_owner is null or lease_owner = $2)`,
        [lease.runId, lease.owner, lease.expiresAt, [...ACTIVE_RUN_STATUSES]],
      );
      return result.rowCount !== 0;
    },
    load: async (tx, runId) => {
      const { rows } = await sqlOf(tx).query<RunRow>(
        `select r.id, r.task_id, r.project_id, s.stage, r.role, r.mode, r.attempt, r.model,
                r.effort, r.prompt_version, r.status, r.terminal_reason, r.session_id, r.num_turns,
                r.usd_reported, r.usd_estimated, r.wall_ms, r.created_at, r.started_at
           from runs r
           left join task_stages s on s.id = r.task_stage_id
          where r.id = $1`,
        [runId],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredRun(row);
    },
    /**
     * `estimated` counts only the runs the platform **priced** (`usd_estimated` set) — until WP-131
     * it was `usd_reported is null`, which also counted a run nobody measured and published the
     * exclusion as *"an estimate"* (PROGRESS backlog 403). The runs nobody measured are counted by
     * the same predicate the caps hold (`unmeasuredEndedRunSql`), so the total and the hold agree
     * about which runs a figure is missing for.
     */
    totalsFor: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<{
        runs: string;
        cost: string | null;
        estimated: string;
        unmeasured: string;
        wall_ms: string | null;
      }>(
        `select count(*) as runs,
                coalesce(sum(coalesce(r.usd_reported, r.usd_estimated)), 0) as cost,
                count(*) filter (where r.usd_estimated is not null and not r.figure_is_floor)
                  as estimated,
                count(*) filter (where ${unmeasuredEndedRunSql('$2')}) as unmeasured,
                coalesce(sum(r.wall_ms), 0) as wall_ms
           from runs r where r.task_id = $1`,
        [taskId, [...ACTIVE_RUN_STATUSES]],
      );
      const row = rows[0];
      return {
        runs: Number(row?.runs ?? 0),
        costUsd: usd(row?.cost ?? null),
        isEstimate: Number(row?.estimated ?? 0) > 0,
        unmeasuredRuns: Number(row?.unmeasured ?? 0),
        wallMs: Number(row?.wall_ms ?? 0),
      };
    },
    /**
     * The task cap's hold (WP-131) — the port's docblock has the reasoning. The predicate is the
     * five ledger-backed caps' own (`../cost/pending-run-spend.ts`), and a row written before
     * migration 0072 is held at the admitting reserve, as theirs is.
     */
    heldFor: async (tx, taskId, admittingReserveUsd) => {
      const { rows } = await sqlOf(tx).query<{ held_usd: string; held_runs: number }>(
        `select coalesce(sum(coalesce(r.reserve_usd, $3::numeric)), 0)::text as held_usd,
                count(*)::int as held_runs
           from runs r
          where r.task_id = $1 and ${unmeasuredEndedRunSql('$2')}`,
        [taskId, [...ACTIVE_RUN_STATUSES], admittingReserveUsd],
      );
      return {
        heldUsd: Number(rows[0]?.held_usd ?? 0),
        heldRuns: Number(rows[0]?.held_runs ?? 0),
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
                answered_at = $6,
                escalated_at = case when $2::text = 'escalated' then now() else escalated_at end
          where id = $1`,
        // `reminders_sent` is not named (WP-84): its one writer is `recordReminder` below, so an
        // answer saved over a snapshot read before a reminder cannot put the counter back to 0.
        [
          question.id,
          question.status,
          question.answer,
          question.answeredByUserId,
          question.answeredVia,
          question.answeredAt,
        ],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(`question ${question.id} does not exist`);
      }
    },
    recordReminder: async (tx, input) => {
      const result = await sqlOf(tx).query(
        `update questions set reminders_sent = reminders_sent + 1
          where id = $1 and status = 'open' and reminders_sent = $2`,
        [input.id, input.sent],
      );
      return (result.rowCount ?? 0) === 1;
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
    recordReminder: async (tx, input) => {
      const result = await sqlOf(tx).query(
        `update approvals set reminders_sent = reminders_sent + 1
          where id = $1 and status = 'pending' and reminders_sent = $2`,
        [input.id, input.sent],
      );
      return (result.rowCount ?? 0) === 1;
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
    latestOfKind: async (tx, query) => {
      // `approvals_task_id_idx` serves the predicate; the `id desc` tie-break is there because two
      // approvals written in one transaction share `requested_at` to the microsecond, and an answer
      // that depends on the planner is an answer the in-memory fake cannot be held to (rule 1).
      const { rows } = await sqlOf(tx).query<ApprovalRow>(
        `${APPROVAL_SELECT}
          where a.task_id = $1 and a.kind = $2
          order by a.requested_at desc, a.id desc limit 1`,
        [query.taskId, query.kind],
      );
      const row = rows[0];
      return row === undefined ? null : toStoredApproval(row);
    },
  };

  /**
   * The epic-split queue (WP-40, migration 0033).
   *
   * Three narrow writes and one read, and the narrowness is standing rule 79's: the rows are
   * inserted by a `task.stage.completed` handler, moved by an HTTP command and stamped with a
   * ticket key by a `pipeline.outbound` duty that runs beside both — so a whole-row save from any
   * of the three would be a lost update. Each statement names the columns its writer owns.
   */
  const breakdown: BreakdownRepository = {
    insert: async (tx, items) => {
      if (items.length === 0) {
        return;
      }
      // One statement for the batch: the children of one artifact are written together or not at
      // all, and `ticket_breakdown_items_one_per_position` is what makes a second write a failure
      // rather than a duplicate queue.
      const columns = 12;
      const values = items
        .map((_item, row) => {
          const at = (offset: number) => `$${row * columns + offset}`;
          return (
            `(${at(1)}, ${at(2)}, ${at(3)}, ${at(4)}, ${at(5)}, ${at(6)}, ${at(7)}, ` +
            `${at(8)}, ${at(9)}::jsonb, ${at(10)}, ${at(11)}, ${at(12)})`
          );
        })
        .join(', ');
      await sqlOf(tx).query(
        `insert into ticket_breakdown_items
           (id, project_id, task_id, run_id, artifact_id, position,
            title, description, acceptance_criteria, size, rationale, redaction_count)
         values ${values}`,
        items.flatMap((item) => [
          item.id,
          item.projectId,
          item.taskId,
          item.runId,
          item.artifactId,
          item.position,
          item.title,
          item.description,
          JSON.stringify(item.acceptanceCriteria),
          item.size,
          item.rationale,
          item.redactionCount,
        ]),
      );
    },
    listForTask: async (tx, taskId) => {
      const { rows } = await sqlOf(tx).query<BreakdownRow>(
        `${BREAKDOWN_SELECT} where b.task_id = $1 order by b.position`,
        [taskId],
      );
      return rows.map(toBreakdownItem);
    },
    decide: async (tx, input) => {
      if (input.itemIds.length === 0) {
        return [];
      }
      // `status = 'queued'` is **in the statement**: two maintainers deciding the same child at the
      // same instant is a race the database settles, and the loser gets an empty list for that id
      // rather than overwriting the winner's decision.
      //
      // The rows come back **out of the CTE** (`returning *`) rather than out of a select beside
      // it, and that is the difference between answering the decision and answering the state it
      // found: a data-modifying CTE is invisible to the rest of its own statement, so the first
      // version of this query returned every moved row still reading `queued`, with a null
      // `decided_at`, while the in-memory fake returned them decided (WP-40 round 2, held by
      // `pipeline-store-suite.ts` › "answers the rows a decision moved, as they are after it").
      const { rows } = await sqlOf(tx).query<BreakdownRow>(
        `with moved as (
           update ticket_breakdown_items
              set status = $3, decided_by_user_id = $4, decided_at = $5, reason = $6,
                  redaction_count = redaction_count + $7
            where task_id = $1 and id = any($2::uuid[]) and status = 'queued'
            returning *
         )
         ${breakdownSelectFrom('moved')} order by b.position`,
        [
          input.taskId,
          [...input.itemIds],
          input.status,
          input.decidedByUserId,
          input.decidedAt,
          input.reason,
          input.reasonRedactions,
        ],
      );
      return rows.map(toBreakdownItem);
    },
    recordTicket: async (tx, input) => {
      const result = await sqlOf(tx).query(
        `update ticket_breakdown_items
            set ticket_key = $2, ticket_url = $3
          where id = $1 and status = 'accepted'`,
        [input.itemId, input.ticketKey, input.ticketUrl],
      );
      if (result.rowCount === 0) {
        throw new PipelineRowMissingError(
          `breakdown item ${input.itemId} is not an accepted child of any task`,
        );
      }
    },
  };

  return {
    tasks,
    artifacts,
    runs,
    questions,
    approvals,
    breakdown,
    runCommands: createPostgresRunCommandRepository(),
    bugTraces: postgresBugTraces,
  };
};

/**
 * WP-90's read of a ticket's defect trace (PROGRESS backlog 192): the ordering is the statistics
 * read's (`apps/server/src/queries/stats-queries.ts` § `bugTraces`) — a `linked` trace first, then
 * the newest — so the handler that decides whether to re-trace and the figure it re-traces for
 * cannot disagree about which trace is the ticket's.
 *
 * **Its cost, measured** (WP-115, PROGRESS backlog 307). It is asked on **every** `ticket.updated`
 * of a bound project — bug or not, because the handler asks before it knows the ticket type and
 * `null` is a non-bug's answer — and again when the `bug_trace` job fires. Before migration 0071
 * every plan the planner had read rows unrelated to the ticket: the installation's
 * `ticket.bug.traced` rows, or a `BitmapAnd` of those and the project's whole stream (1 112–1 285
 * buffers and 0.4–3.6 ms at 10^5 project events, growing with history). It is now an index range
 * on `events_bug_trace_ticket_idx` — `(stream_id, payload->'ticket'->>'key')`, partial on this
 * event type — per monthly partition: 6–7 buffers, 0.02–0.05 ms at every size measured, a traced
 * ticket and a never-traced one alike. Nothing bounds `occurred_at`, so it still probes every
 * partition, one index descent each. `test/integration/db/payload-lookup-indexes.integration.test.ts`
 * holds the planner to the index.
 */
const postgresBugTraces: BugTraceRepository = {
  latest: async (tx, ticket) => {
    const { rows } = await sqlOf(tx).query<{ outcome: string; filed_at: string }>(
      `select e.payload ->> 'outcome' as outcome, e.payload ->> 'filed_at' as filed_at
         from events e
        where e.type = 'ticket.bug.traced'
          and e.stream_type = 'project' and e.stream_id = $1::uuid
          and e.payload -> 'ticket' ->> 'provider' = $2
          and e.payload -> 'ticket' ->> 'key' = $3
        order by (e.payload ->> 'outcome' = 'linked') desc, e.occurred_at desc, e.position desc
        limit 1`,
      [ticket.projectId, ticket.provider, ticket.key],
    );
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const outcome = row.outcome;
    if (outcome !== 'linked' && outcome !== 'no_link' && outcome !== 'unreadable') {
      // The payload was validated by its schema when it was appended; a value outside the enum is
      // a row this build did not write, and it is refused rather than read as one of the three.
      throw new PipelineStoredStateError(`ticket.bug.traced carries an unknown outcome ${outcome}`);
    }
    return { outcome, filedAt: row.filed_at as IsoDateTime };
  },
};

/** One `ticket_breakdown_items` row as `pg` hands it back. */
interface BreakdownRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  task_id: string;
  run_id: string | null;
  artifact_id: string;
  position: number;
  title: string;
  description: string;
  acceptance_criteria: unknown;
  size: string;
  rationale: string;
  status: string;
  decided_by_user_id: string | null;
  decided_at: Date | string | null;
  reason: string | null;
  ticket_key: string | null;
  ticket_url: string | null;
  redaction_count: number;
  created_at: Date | string;
}

/**
 * One projection of the queue, over the table or over a data-modifying CTE's `returning *`.
 *
 * Parameterised by the relation for one reason: `decide` has to read the rows **it just wrote**,
 * and a `select` from the table beside its own CTE reads the statement's snapshot — the rows as
 * they were. One column list, two relations, so the read and the decision cannot describe a row
 * differently.
 */
const breakdownSelectFrom = (
  relation: string,
) => `select b.id, b.project_id, b.task_id, b.run_id, b.artifact_id, b.position,
       b.title, b.description, b.acceptance_criteria, b.size, b.rationale, b.status,
       b.decided_by_user_id, b.decided_at, b.reason, b.ticket_key, b.ticket_url,
       b.redaction_count, b.created_at
  from ${relation} b`;

const BREAKDOWN_SELECT = breakdownSelectFrom('ticket_breakdown_items');

/**
 * One row as the application reads it.
 *
 * `acceptance_criteria` is **parsed**, not cast: it is `jsonb`, which is to say anything the column
 * was ever given, and a row whose criteria are not an array answers `[]` rather than propagating a
 * value the DTO's schema would then refuse at the route — the fail-closed direction `PostgresAskStore`
 * takes for `citations`.
 */
const toBreakdownItem = (row: BreakdownRow): StoredBreakdownItem => {
  const criteria = z.array(acceptanceCriterionSchema).safeParse(row.acceptance_criteria);
  return {
    id: row.id as Id,
    projectId: row.project_id as Id,
    taskId: row.task_id as Id,
    runId: row.run_id as Id | null,
    artifactId: row.artifact_id as Id,
    position: row.position,
    title: row.title,
    description: row.description,
    acceptanceCriteria: criteria.success ? criteria.data : [],
    size: row.size as StoredBreakdownItem['size'],
    rationale: row.rationale,
    status: row.status as StoredBreakdownItem['status'],
    decidedByUserId: row.decided_by_user_id as Id | null,
    decidedAt: row.decided_at === null ? null : isoOf(row.decided_at),
    reason: row.reason,
    ticketKey: row.ticket_key,
    ticketUrl: row.ticket_url,
    redactionCount: row.redaction_count,
    createdAt: isoOf(row.created_at),
  };
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
  /** Null only for a row written before migration 0038, when no redactor ran. */
  redaction_count: number | null;
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
  redactionCount: row.redaction_count,
  createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
});

interface RunRow extends Record<string, unknown> {
  id: string;
  task_id: string;
  project_id: string;
  /** From the joined `task_stages` row; null when the run is linked to none. */
  stage: string | null;
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
  /** Nullable since migration 0035 (WP-47): `null` is "no figure was reported for this run". */
  usd_estimated: string | null;
  wall_ms: string | number;
  created_at: Date;
  started_at: Date | null;
}

/** `is_estimate: false` fills `usd_reported`; `true` fills `usd_estimated`; `null` fills neither. */
/**
 * One `run_context_pack` row per entry of the record, in one statement (migration 0041, WP-57).
 *
 * `ordinal` is the entry's index within its tier, because the record is ordered and nothing else in
 * the row reproduces that order. A tier-0 row has no `reason` and no `score` — the published tier-0
 * entry has neither — and a tier-1 row always has both, which `run_context_pack_row_complete`
 * holds the database to. `validated` is written for tier 0 as `true`: a tier-0 document is
 * unconditional and nothing validated it away, which is the column's default and its meaning.
 *
 * The primary key is `(run_id, source_path)`, and the assembler never lists a path twice — a
 * tier-0 document is removed from the tier-1 candidates, and candidates are keyed by path — so a
 * duplicate here is a defect in the assembler and is refused by the database rather than merged.
 */
const insertContextPackRows = async (
  sql: SqlExecutor,
  runId: Id,
  pack: ContextPackRecord,
): Promise<void> => {
  const rows = [
    ...pack.tier0.map((entry, ordinal) => ({
      tier: 0,
      path: entry.path,
      reason: null,
      score: null,
      tokens: entry.tokens,
      validated: true,
      ordinal,
    })),
    ...pack.tier1.map((entry, ordinal) => ({
      tier: 1,
      path: entry.path,
      reason: entry.reason,
      score: entry.score,
      tokens: entry.tokens,
      validated: entry.validated,
      ordinal,
    })),
  ];
  if (rows.length === 0) {
    return;
  }
  await sql.query(
    `insert into run_context_pack
            (run_id, tier, source_path, reason, score, tokens, validated, kb_commit_sha, ordinal)
     select $1, r.tier, r.path, r.reason::context_pack_reason, r.score, r.tokens, r.validated, $2,
            r.ordinal
       from unnest($3::smallint[], $4::text[], $5::text[], $6::double precision[], $7::integer[],
                   $8::boolean[], $9::integer[])
            as r(tier, path, reason, score, tokens, validated, ordinal)`,
    [
      runId,
      pack.kb_commit ?? null,
      rows.map((row) => row.tier),
      rows.map((row) => row.path),
      rows.map((row) => row.reason),
      rows.map((row) => row.score),
      rows.map((row) => row.tokens),
      rows.map((row) => row.validated),
      rows.map((row) => row.ordinal),
    ],
  );
};

const reportedUsd = (cost: RunCost | null): number | null =>
  cost === null || cost.is_estimate ? null : cost.usd;

const estimatedUsd = (cost: RunCost | null): number | null =>
  cost === null || !cost.is_estimate ? null : cost.usd;

/** The pair read back: reported first, then the estimate, then the honest absence. */
const costOf = (row: RunRow): RunCost | null => {
  if (row.usd_reported !== null) {
    return { usd: usd(row.usd_reported), is_estimate: false, price_list_id: null };
  }
  if (row.usd_estimated !== null) {
    return { usd: usd(row.usd_estimated), is_estimate: true, price_list_id: null };
  }
  return null;
};

const toStoredRun = (row: RunRow): StoredRun => ({
  id: row.id,
  taskId: row.task_id,
  projectId: row.project_id,
  stage: row.stage as Slug | null,
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
  // Three answers, not two (WP-47, migration 0035). A reported figure is the truth (BD-011); an
  // estimate is the platform's own pricing of a `local`-mode run; **both columns null** is "nobody
  // measured this run", which `usd: 0` spelled as a free one — and which is exactly the state the
  // lease sweep leaves behind, because a missing heartbeat says nothing about what was spent.
  cost: costOf(row),
  wallMs: Number(row.wall_ms),
  createdAt: new Date(row.created_at).toISOString() as IsoDateTime,
  startedAt:
    row.started_at === null ? null : (new Date(row.started_at).toISOString() as IsoDateTime),
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
    a.decided_by_user_id, a.decided_at, a.reason, a.stage, a.attempt, a.reminders_sent, t.project_id
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
  reminders_sent: number;
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
    remindersSent: row.reminders_sent,
    sequence: 1,
  },
  stage: row.stage,
  attempt: row.attempt,
});

/** Run statuses that hold a slot against `max_parallel_runs`, for a caller that needs the list. */
export const ACTIVE_RUN_STATUS_LIST: readonly string[] = ACTIVE_RUN_STATUSES;

export type { Id };
