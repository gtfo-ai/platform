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
import { TAKE_OVER_BOUNDARY_EVENTS, TaskConcurrentModificationError } from '@platform/application';
import type {
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
  TaskReviewers,
  TaskState,
  TicketSnapshot,
  WorkpadRef,
} from '@platform/contracts';
import {
  acceptanceCriterionSchema,
  taskCoverageSchema,
  taskDependenciesSchema,
  taskReviewersSchema,
  taskStageExitStateSchema,
  taskStageStateSchema,
  workpadRefSchema,
} from '@platform/contracts';
import type { Approval, IterationCounters, IterationLimits, Question } from '@platform/domain';
import { ACTIVE_RUN_STATUSES, resolveIterationLimits } from '@platform/domain';
import * as z from 'zod';
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

/** The same, for a column the schema declares `not null`. */
const isoOf = (value: Date | string): IsoDateTime => new Date(value).toISOString() as IsoDateTime;

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
  estimate_basis: EstimateBasis | null;
  estimate_samples: number | string | null;
  ticket_snapshot: TicketSnapshot | null;
  ticket_snapshot_at: Date | null;
  review_subject: MergeRequestSnapshot | null;
  history_sample: HistorySample | null;
  risk_classes: string[] | null;
  coverage: TaskCoverage | null;
  dependencies: TaskDependencies | null;
  required_reviewers: TaskReviewers | null;
  requested_by_user_id: string | null;
  version: number;
  created_at: Date;
  sequence: string | number | null;
}

const TASK_COLUMNS = `t.id, t.project_id, t.ticket_provider, t.ticket_key, t.ticket_url, t.template,
    t.mode, t.state, t.current_stage, t.priority, t.template_snapshot, t.branch, t.mr_ref,
    t.workpad_ref, t.stage_attempts, t.iteration_limits, t.iteration_counters, t.cost_actual,
    t.estimate_usd, t.estimate_basis, t.estimate_samples,
    t.ticket_snapshot, t.ticket_snapshot_at, t.review_subject, t.history_sample,
    t.risk_classes, t.coverage,
    t.dependencies, t.required_reviewers,
    t.requested_by_user_id, t.version,
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
  estimateBasis: row.estimate_basis,
  estimateSamples: row.estimate_samples === null ? null : Number(row.estimate_samples),
  ticketSnapshot: row.ticket_snapshot,
  ticketSnapshotAt: iso(row.ticket_snapshot_at),
  reviewSubject: row.review_subject,
  historySample: row.history_sample,
  // `text[] not null default '{}'`, so the `?? []` is for a driver that hands back `null` rather
  // than for a row that can hold one (WP-37).
  riskClasses: row.risk_classes ?? [],
  coverage: row.coverage,
  dependencies: row.dependencies,
  requiredReviewers: row.required_reviewers,
  requestedByUserId: (row.requested_by_user_id ?? null) as Id | null,
  version: Number(row.version),
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
      return rows.map((row) => toStoredTask(row, templateFor(row)));
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
                            version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::jsonb,
                 $15::jsonb, $16::jsonb, $17::jsonb, $18, $19, $20, $21, $22::jsonb, $23, $24::jsonb,
                 $25::jsonb, $26)`,
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
      const result = await sql.query<{ version: number }>(
        `update tasks
            set state = $2::task_state, current_stage = $3, branch = $4, mr_ref = $5::jsonb,
                stage_attempts = $6::jsonb, iteration_counters = $7::jsonb,
                version = version + 1, updated_at = now(),
                completed_at = case when $2::text in ('done', 'cancelled') then now() else completed_at end
          where id = $1 and version = $8
        returning version`,
        [
          task.id,
          task.state,
          task.currentStage,
          stored.branch,
          stored.mr === null ? null : JSON.stringify(stored.mr),
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
      return { ...stored, version: Number(written.version) };
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
                returned_to = $7
          where task_id = $1 and stage = $2 and attempt = $3`,
        [
          entry.taskId,
          entry.stage,
          entry.attempt,
          entry.outcome,
          entry.returnReason,
          state,
          entry.returnedTo,
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
      const { rows } = await sqlOf(tx).query<{ return_reason: string }>(
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
         select r.return_reason
           from task_stages r, previous, current
          where r.task_id = $1 and r.returned_to = $2
            and r.return_reason is not null and r.exited_at is not null
            and (previous.at is null or r.exited_at > previous.at)
            and (current.at is null or r.exited_at <= current.at)
          order by r.exited_at desc, r.entered_at desc
          limit 1`,
        [taskId, stage, attempt],
      );
      return rows[0]?.return_reason ?? null;
    },
    takenOver: async (tx, taskId) => {
      // One indexed read of the task's own stream (WP-56): the newest boundary event decides, the
      // same projection `apps/server`'s read model makes over two of these types. A payload that
      // does not carry a branch and a stage answers **nothing** rather than a blank block, because
      // the branch is the whole point of the record.
      const { rows } = await sqlOf(tx).query<{
        id: string;
        type: string;
        payload: Record<string, unknown>;
        occurred_at: Date | string;
      }>(
        `select id, type, payload, occurred_at
           from events
          where stream_type = 'task' and stream_id = $1 and type = any($2::text[])
          order by stream_seq desc
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
                           system_prompt, user_prompt, redaction_count)
         values ($1, $2, $3,
                 (select id from task_stages
                   where task_id = $2 and stage = $11 and attempt = $6),
                 $4, $5, $6, $7, $8, $9, $10, $12, $13, $14, $15)`,
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
        ],
      );
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
                usd_estimated = $12, wall_ms = $13, ended_at = now()
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
        ],
      );
      if (result.rowCount !== 0) {
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
                usd_reported = $9, usd_estimated = $10, wall_ms = greatest(wall_ms, $11)
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

  return { tasks, artifacts, runs, questions, approvals, breakdown };
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
