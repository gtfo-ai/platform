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
import { JOB_QUEUES } from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { assertPgBossSchema } from '../jobs/queue-backlog.js';

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
}

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
      : { status: row.ended_status, terminalReason: row.ended_reason },
});

/**
 * Every task stranded at its stage, whatever its age. `$1` is the queue name. `attempted_at` is the
 * mark only when it belongs to this entry (at or after `entered_at`).
 */
const strandedSql = (schema: string): string => `
  select t.id as task_id, t.project_id, t.current_stage as stage, s.attempt,
         to_char(s.entered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as entered_at,
         s.entered_at as entered_instant,
         case when t.stage_recovery_attempted_at >= s.entered_at
              then t.stage_recovery_attempted_at end as attempted_at,
         er.status as ended_status, er.terminal_reason as ended_reason,
         er.ended_at as ended_instant
    from tasks t
    join task_stages s
      on s.task_id = t.id and s.stage = t.current_stage
     and s.attempt = coalesce((t.stage_attempts ->> t.current_stage)::int, 1)
    -- WP-108 review round 1: the newest run this attempt already had. Live runs are excluded
    -- below, so a row here is an **ended** run, and the pass never re-enqueues such an attempt.
    left join lateral (
      select r.status::text as status, r.terminal_reason::text as terminal_reason, r.ended_at
        from runs r
       where r.task_stage_id = s.id
       -- Run ids are random (v4) UUIDs, so the newest is the latest start (WP-108 review round 2).
       order by r.started_at desc nulls last, r.id desc
       limit 1
    ) er on true
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
          where (x.ended_status is not null
                 and coalesce(x.ended_instant, x.entered_instant) < $2)
             or (x.ended_status is null and x.attempted_at is null and x.entered_instant < $2)
             or (x.ended_status is null and x.attempted_at is not null and x.attempted_at < $3)
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
                          and x.ended_status is null)`,
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
