/**
 * The discovery-record recovery's read, its mark and its ending, over PostgreSQL (WP-124, PROGRESS
 * backlog 366; the rules are `packages/application/src/recovery/discovery-record.ts`').
 *
 * **One predicate, three statements**, as the stranded-stage store: {@link strandedSql} is the
 * whole of *"the project's newest discovery draft, with no evaluation recorded from it and no
 * recording job owed"*, and the list, the conditional mark and the conditional ending each select
 * from it.
 *
 *  - **newest**: no later `DiscoveryDraft` of the same project, by `(created_at, id)` — an older
 *    draft a later run superseded must never be recorded over the newer evaluation;
 *  - **no evaluation from it**: no `readiness_evaluations` row of the project, source `discovery` or
 *    `rediscovery`, evaluated at or after the artifact was stored (the recorder writes its row when
 *    the job runs, after the artifact; a `recheck` carries the previous evaluation forward);
 *  - **no job owed**: no `onboarding.discovery` job for that artifact (`data ->> 'artifact_id'`) that
 *    is `created`, `retry` or `active`, read off pg-boss's own table — the queue is `standard`, so
 *    the artifact is in the payload rather than a singleton key;
 *  - **not ended**: a row this pass already gave up on is never read again.
 *
 * The `artifact.created` event that announced the draft is read with it — on its task stream, by
 * the stream's own index — because it keys the ending's notification for a finished task.
 */
import type {
  DiscoveryRecordRecoveryStore,
  StrandedDiscoveryQuery,
  StrandedDiscoveryRecord,
  Transaction,
} from '@platform/application';
import { JOB_QUEUES } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { assertPgBossSchema } from '../jobs/queue-backlog.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface Row extends Record<string, unknown> {
  readonly artifact_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly event_id: string | null;
  readonly attempted_at: Date | string | null;
}

/** Every stranded draft, whatever its age. `$1` is the queue name. */
const strandedSql = (schema: string): string => `
  select a.id as artifact_id, t.project_id, a.task_id, a.created_at as stored_at,
         r.recovery_attempted_at as attempted_at,
         (select e.id from events e
           where e.stream_type = 'task' and e.stream_id = a.task_id
             and e.type = 'artifact.created'
             and e.payload -> 'artifact' ->> 'id' = a.id::text
           limit 1) as event_id
    from artifacts a
    join tasks t on t.id = a.task_id
    left join discovery_record_recoveries r on r.artifact_id = a.id
   where a.type = 'DiscoveryDraft'
     and r.ended_at is null
     and not exists (select 1 from artifacts newer
                       join tasks nt on nt.id = newer.task_id
                      where newer.type = 'DiscoveryDraft' and nt.project_id = t.project_id
                        and (newer.created_at, newer.id) > (a.created_at, a.id))
     and not exists (select 1 from readiness_evaluations re
                      where re.project_id = t.project_id
                        and re.source in ('discovery', 'rediscovery')
                        and re.evaluated_at >= a.created_at)
     and not exists (select 1 from ${schema}.job j
                      where j.name = $1 and j.data ->> 'artifact_id' = a.id::text
                        and j.state in ('created', 'retry', 'active'))`;

export interface PostgresDiscoveryRecordRecoveryStoreOptions {
  /** pg-boss's schema (`pgboss`). */
  readonly jobsSchema: string;
}

export const createPostgresDiscoveryRecordRecoveryStore = (
  options: PostgresDiscoveryRecordRecoveryStoreOptions,
): DiscoveryRecordRecoveryStore => {
  const stranded = strandedSql(assertPgBossSchema(options.jobsSchema));
  return {
    strandedDiscoveryRecords: async (tx, query: StrandedDiscoveryQuery) => {
      const { rows } = await sqlOf(tx).query<Row>(
        `select * from (${stranded}) x
          where (x.attempted_at is null and x.stored_at < $2)
             or (x.attempted_at is not null and x.attempted_at < $3)
          order by x.stored_at, x.artifact_id
          limit $4`,
        [JOB_QUEUES.discoveryRecord, query.olderThan, query.endingBefore, query.limit],
      );
      return rows.map(
        (row): StrandedDiscoveryRecord => ({
          artifactId: row.artifact_id as Id,
          projectId: row.project_id as Id,
          taskId: row.task_id as Id,
          artifactEventId: row.event_id as Id | null,
          recoveryAttemptedAt:
            row.attempted_at === null
              ? null
              : (new Date(row.attempted_at).toISOString() as IsoDateTime),
        }),
      );
    },

    markDiscoveryRecordAttempt: async (tx, input) => {
      // The insert is the mark, conditional on the predicate (standing rule 9): a recording that
      // landed, or a job the live path enqueued, since the pass's read makes it insert nothing.
      const result = await sqlOf(tx).query(
        `insert into discovery_record_recoveries (artifact_id, recovery_attempted_at)
         select x.artifact_id, $3 from (${stranded}) x
          where x.artifact_id = $2 and x.attempted_at is null
         on conflict (artifact_id) do nothing`,
        [JOB_QUEUES.discoveryRecord, input.artifactId, input.at],
      );
      return (result.rowCount ?? 0) > 0;
    },

    endDiscoveryRecord: async (tx, input) => {
      const result = await sqlOf(tx).query(
        `update discovery_record_recoveries set ended_at = $3, detail = $4
          where artifact_id = $2 and ended_at is null
            and artifact_id in (select x.artifact_id from (${stranded}) x
                                 where x.attempted_at is not null)`,
        [JOB_QUEUES.discoveryRecord, input.artifactId, input.at, input.reason],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
};
