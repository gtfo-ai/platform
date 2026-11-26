/**
 * The stranded-stage recovery's read, its mark and its re-check, over PostgreSQL (WP-108, PROGRESS
 * backlog 320; the rules are `packages/application/src/recovery/stranded-stage.ts`').
 *
 * **One predicate, three statements.** {@link strandedSql} is the whole of *"a task at an agent or
 * gate stage with no job and no run"*, and the list, the conditional mark and the ending's re-check
 * each select from it, so the three cannot disagree about what stranded means.
 *
 * **The job half reads pg-boss's own table** (`<schema>.job`), as `jobs/queue-backlog.ts` does for
 * the queue gauge: a `stage.execute` job keyed `task:<id>` that is `created`, `retry` or `active` is
 * a wake-up still owed to the task, and nothing else in the database knows it. A failed job (every
 * retry spent) and a completed one are not, which is how this row also finds a stage whose job
 * pg-boss gave up on (backlog 325). The schema name is interpolated and therefore held to a bare
 * identifier by `assertPgBossSchema`.
 *
 * **The stage kind is pre-filtered here and decided by the caller.** `template_snapshot`'s stage list
 * names each stage's kind, so a task parked at a `human` stage (the spike's breakdown decision is
 * entered `active`) never takes a slot of the pass's limit; a row with no snapshot (written before
 * WP-15) is admitted and the application, which compiles the pipeline as `stage.execute` does, has
 * the last word.
 *
 * The mark is `stage_recovery_attempted_at`, this file's column alone (migration 0067; the `tasks`
 * column census pins it). It is compared with the open `task_stages` row's `entered_at`, so a mark
 * an earlier entry left is read as no mark.
 */
import type {
  StrandedStage,
  StrandedStageQuery,
  StrandedStageRecoveryStore,
  Transaction,
} from '@platform/application';
import { JOB_QUEUES, MAX_LOST_RUN_REPLANS, MAX_USAGE_LIMITED_REPLANS } from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { assertPgBossSchema } from '../jobs/queue-backlog.js';
import { EXPIRY_SIGNATURES } from './postgres-expired-job-store.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface Row extends Record<string, unknown> {
  readonly task_id: string;
  readonly project_id: string;
  readonly stage: string;
  readonly attempt: number;
  /** Microsecond text, never a `Date`: the entry's identity is compared back in SQL. */
  readonly entered_at: string;
  readonly attempted_at: Date | string | null;
  readonly ended_status: string | null;
  readonly ended_reason: string | null;
  /** The ended run owes its entry a re-plan (WP-285, WP-286, BD-034's BACKLOG 1657). */
  readonly replan_owed: boolean | null;
  /** The ended run's model and effort, which the live re-plan carries (BACKLOG 1657). */
  readonly ended_model: string | null;
  readonly ended_effort: string | null;
  readonly failed_at: Date | string | null;
  readonly failed_tries: number | null;
  readonly failed_name: string | null;
  readonly failed_code: string | null;
  readonly failed_cause_name: string | null;
  readonly failed_cause_code: string | null;
  /** The supervisor's `output.value.message`, only when short enough to be a signature. */
  readonly failed_value_message: string | null;
  /** The serialised error's `message`, only when short enough to be a signature. */
  readonly failed_message: string | null;
  /** How many of the entry's stage jobs pg-boss failed (BACKLOG 1659). */
  readonly failed_jobs: number | null;
}

/**
 * Did pg-boss **expire** this failed job rather than see its handler throw (WP-166 (b), PROGRESS
 * backlog 529)? The two output shapes WP-156 measured, matched exactly with
 * {@link EXPIRY_SIGNATURES} — the supervisor's fixed message, and the worker timer's `Error` with its
 * one sentence. A handler that threw an `Error` with any other message is a thrown last try. The
 * messages are compared here and dropped: they never leave the store, so no message text reaches a
 * brief (BD-022).
 */
export const isExpiredJobOutput = (row: {
  readonly failed_name: string | null;
  readonly failed_value_message: string | null;
  readonly failed_message: string | null;
}): boolean =>
  (row.failed_value_message !== null &&
    (EXPIRY_SIGNATURES.supervisor as readonly string[]).includes(row.failed_value_message)) ||
  (row.failed_name === 'Error' &&
    row.failed_message !== null &&
    new RegExp(EXPIRY_SIGNATURES.workerTimer).test(row.failed_message));

const toStranded = (row: Row): StrandedStage => ({
  taskId: row.task_id as Id,
  projectId: row.project_id as Id,
  stage: row.stage as Slug,
  attempt: Number(row.attempt),
  enteredAt: row.entered_at as IsoDateTime,
  recoveryAttemptedAt:
    row.attempted_at === null ? null : (new Date(row.attempted_at).toISOString() as IsoDateTime),
  endedRun:
    row.ended_status === null
      ? null
      : {
          status: row.ended_status,
          terminalReason: row.ended_reason,
          replanOwed: row.replan_owed === true,
          ...(row.ended_model === null ? {} : { model: row.ended_model }),
          ...(row.ended_effort === null ? {} : { effort: row.ended_effort }),
        },
  failedJob:
    row.failed_at === null
      ? null
      : {
          failedAt: new Date(row.failed_at).toISOString() as IsoDateTime,
          tries: Number(row.failed_tries ?? 1),
          errorName: row.failed_name,
          errorCode: row.failed_code,
          causeName: row.failed_cause_name,
          causeCode: row.failed_cause_code,
          expired: isExpiredJobOutput(row),
          jobs: Math.max(1, Number(row.failed_jobs ?? 1)),
        },
});

/** Longest class or code read back; the application admits only an identifier of 64 characters. */
const FAILED_IDENTIFIER_CHARS = 80;

/**
 * Longest message read back for {@link isExpiredJobOutput}: longer than either signature, and a
 * longer message is read as `null` rather than cut, because a cut message could end where a
 * signature's `$` does.
 */
const EXPIRY_MESSAGE_CHARS = 64;

/**
 * Every task stranded at its stage, whatever its age. `$1` is the queue name. `attempted_at` is the
 * mark only when it belongs to this entry (at or after `entered_at`).
 */
const strandedSql = (schema: string): string => `
  select t.id as task_id, t.project_id, t.current_stage as stage, s.attempt,
         to_char(s.entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as entered_at,
         s.entered_at as entered_instant,
         -- The mark counts for this entry only — and, since BD-034 (BACKLOG 1657), only when it is
         -- not older than the entry's newest ended run: one entry may owe several re-plans, each
         -- its own run's, and a mark the pass wrote for an earlier one says nothing about this one.
         -- BACKLOG 1659: likewise a failed stage.execute job newer than the mark is a new failure,
         -- which the pass decides on again (bounded by the entry's count of failed jobs).
         case when t.stage_recovery_attempted_at >= greatest(s.entered_at, er.ended_at, fj.completed_on)
              then t.stage_recovery_attempted_at end as attempted_at,
         er.status as ended_status, er.terminal_reason as ended_reason,
         er.ended_at as ended_instant, er.model as ended_model, er.effort as ended_effort,
         -- WP-285/WP-286, BD-034 (BACKLOG 1657): the entry's newest run ended in a way that owes the
         -- entry a re-plan, which its settling process enqueues after its commit; being the entry's
         -- newest run, it has no successor. Each of these endings leaves the task active at this
         -- stage with the row open **only** while its bound is not spent — the ending past the bound
         -- escalates in the same transaction, moving the task out of the states this query admits —
         -- so the ending alone names the debt; the two endings counted on the row also check it.
         coalesce((er.terminal_reason = 'lease_expired'
                   and s.lost_runs between 1 and ${MAX_LOST_RUN_REPLANS})
                  or (er.terminal_reason = 'rate_limited'
                      and s.usage_limited_runs between 1 and ${MAX_USAGE_LIMITED_REPLANS})
                  -- A shutdown hand-back (WP-144), up to MAX_SHUTDOWN_HAND_BACKS.
                  or (er.status = 'failed' and er.terminal_reason = 'shutdown')
                  -- A transport failure to start (Q59(a)): its start failure is recorded.
                  or (er.status = 'failed' and er.terminal_reason = 'error_during_execution'
                      and er.exit_detail is not null)
                  -- A run that ended before the model took a turn (BD-034's turnless re-plan):
                  -- its CLI was spawned (a run that never started reads 0 turns too, owing nothing).
                  or (er.status = 'failed' and er.terminal_reason = 'error_during_execution'
                      and er.exit_detail is null and er.num_turns = 0
                      and er.started_at is not null), false)
           as replan_owed,
         fj.completed_on as failed_at, fj.tries as failed_tries,
         fj.failed_name, fj.failed_code, fj.failed_cause_name, fj.failed_cause_code,
         fj.failed_value_message, fj.failed_message, fc.failed_jobs
    from tasks t
    join task_stages s
      on s.task_id = t.id and s.stage = t.current_stage
     and s.attempt = coalesce((t.stage_attempts ->> t.current_stage)::int, 1)
    -- WP-108 review round 1: the newest run this attempt already had. Live runs are excluded
    -- below, so a row here is an **ended** run, and the pass never re-enqueues such an attempt.
    left join lateral (
      select r.status::text as status, r.terminal_reason::text as terminal_reason, r.ended_at,
             r.num_turns, r.exit_detail, r.started_at, r.model, r.effort::text as effort
        from runs r
       where r.task_stage_id = s.id
       -- Run ids are random (v4) UUIDs, so the newest is the latest creation (WP-108 review round 2).
       -- WP-275b: created_at, never started_at — null for a run that ended before its CLI
       -- spawn marker, which nulls last put behind every older run that had started.
       order by r.created_at desc, r.id desc
       limit 1
    ) er on true
    -- Backlog 490: the newest job of **this entry** that pg-boss failed (every retry spent), read
    -- for the ending's brief — the stage did start. Only the serialised error's name and code and
    -- its cause's (pg-boss stores the thrown error through serialize-error as output), never the
    -- message for the brief; \`data\` is compared, never selected. WP-166 (backlog 529): the two
    -- short messages an expiry writes are read too, only to be matched against EXPIRY_SIGNATURES.
    left join lateral (
      select j.completed_on, j.retry_count + 1 as tries,
             left(j.output ->> 'name', ${FAILED_IDENTIFIER_CHARS}) as failed_name,
             left(j.output ->> 'code', ${FAILED_IDENTIFIER_CHARS}) as failed_code,
             left(j.output -> 'cause' ->> 'name', ${FAILED_IDENTIFIER_CHARS}) as failed_cause_name,
             left(j.output -> 'cause' ->> 'code', ${FAILED_IDENTIFIER_CHARS}) as failed_cause_code,
             case when char_length(j.output -> 'value' ->> 'message') <= ${EXPIRY_MESSAGE_CHARS}
                  then j.output -> 'value' ->> 'message' end as failed_value_message,
             case when char_length(j.output ->> 'message') <= ${EXPIRY_MESSAGE_CHARS}
                  then j.output ->> 'message' end as failed_message
        from ${schema}.job j
       where j.name = $1 and j.singleton_key = 'task:' || t.id::text and j.state = 'failed'
         and j.data ->> 'stage' = t.current_stage and j.data ->> 'attempt' = s.attempt::text
         and j.completed_on >= greatest(s.entered_at, er.ended_at)
       order by j.completed_on desc
       limit 1
    ) fj on true
    -- BACKLOG 1659: how many of this entry's stage.execute jobs pg-boss failed — the pass's bound on
    -- re-enqueuing a stage whose job keeps failing for a reason another try may fix. Like the newest
    -- failed job above, only those after the entry's newest ended run: an owed re-plan whose
    -- re-enqueued job keeps failing is bounded by them too (review of BD-034's follow-ups).
    left join lateral (
      select count(*)::int as failed_jobs
        from ${schema}.job j
       where j.name = $1 and j.singleton_key = 'task:' || t.id::text and j.state = 'failed'
         and j.data ->> 'stage' = t.current_stage and j.data ->> 'attempt' = s.attempt::text
         and j.completed_on >= greatest(s.entered_at, er.ended_at)
    ) fc on true
   where t.state in ('active', 'merged', 'retro')
     and s.state = 'running' and s.exited_at is null
     and (t.template_snapshot is null
          or exists (select 1
                       from jsonb_array_elements(coalesce(t.template_snapshot -> 'stages', '[]'::jsonb)) st
                      where st ->> 'id' = t.current_stage and st ->> 'kind' in ('agent', 'gate')))
     and not exists (select 1 from runs r
                      where r.task_id = t.id and r.status in ('created', 'starting', 'running'))
     and not exists (select 1 from ${schema}.job j
                      where j.name = $1 and j.singleton_key = 'task:' || t.id::text
                        and j.state in ('created', 'retry', 'active'))`;

/**
 * The one entry `row` names, still stranded. `$2`–`$5` are the entry's identity; the instant is the
 * database's own microsecond rendering, because a `Date` keeps milliseconds and `entered_at` is
 * written by `clock_timestamp()` — the truncation that once made a task page's keyset skip a row.
 */
const sameEntry = `x.task_id = $2 and x.stage = $3 and x.attempt = $4 and x.entered_instant = $5::timestamptz`;

export interface PostgresStrandedStageStoreOptions {
  /** pg-boss's schema (`APP_JOBS_SCHEMA`'s value, `pgboss`). */
  readonly jobsSchema: string;
}

export const createPostgresStrandedStageStore = (
  options: PostgresStrandedStageStoreOptions,
): StrandedStageRecoveryStore => {
  const stranded = strandedSql(assertPgBossSchema(options.jobsSchema));
  const entryOf = (row: StrandedStage) => [
    JOB_QUEUES.stageExecute,
    row.taskId,
    row.stage,
    row.attempt,
    row.enteredAt,
  ];
  return {
    strandedStages: async (tx, query: StrandedStageQuery) => {
      const { rows } = await sqlOf(tx).query<Row>(
        `select * from (${stranded}) x
          where (x.ended_status is not null and not x.replan_owed
                 and coalesce(x.ended_instant, x.entered_instant) < $2)
             or ((x.ended_status is null or x.replan_owed) and x.attempted_at is null
                 and coalesce(x.ended_instant, x.entered_instant) < $2)
             or ((x.ended_status is null or x.replan_owed) and x.attempted_at is not null
                 and x.attempted_at < $3)
          order by x.entered_instant, x.task_id
          limit $4`,
        [JOB_QUEUES.stageExecute, query.olderThan, query.endingBefore, query.limit],
      );
      return rows.map(toStranded);
    },

    markStageAttempt: async (tx, input) => {
      // Conditional on the entry still being stranded and not yet marked for this entry: a job the
      // live path enqueued since the pass's read makes this write nothing, and the pass enqueues
      // nothing either (standing rule 9's arbiter).
      const result = await sqlOf(tx).query(
        `update tasks set stage_recovery_attempted_at = $6
          where id in (select x.task_id from (${stranded}) x
                        where ${sameEntry} and x.attempted_at is null
                          and (x.ended_status is null or x.replan_owed))`,
        [...entryOf(input.row), input.at],
      );
      return (result.rowCount ?? 0) > 0;
    },

    isStillStranded: async (tx, row) => {
      const { rows } = await sqlOf(tx).query(
        `select 1 from (${stranded}) x where ${sameEntry}`,
        entryOf(row),
      );
      return rows.length > 0;
    },
  };
};
