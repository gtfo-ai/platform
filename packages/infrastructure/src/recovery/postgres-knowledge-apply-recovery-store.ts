/**
 * The knowledge-apply recovery's read, its mark and its ending, over PostgreSQL (WP-124, PROGRESS
 * backlog 366; the rules are `packages/application/src/recovery/knowledge-apply.ts`').
 *
 * **One predicate, three statements**, `postgres-stranded-stage-store.ts`'s shape: {@link strandedSql}
 * is the whole of *"an approved proposal no commit carries, with no apply job owed to its project"*,
 * and the list, the conditional mark and the conditional ending each select from it, so the three
 * cannot disagree about what stranded means. "Awaiting apply" is the proposal store's own
 * {@link AWAITING_APPLY} clause — one spelling of `isAwaitingApply` in SQL (standing rule 41), held
 * to the TypeScript predicate by the contract suite. A **deferred** proposal (`apply_deferred_reason`,
 * WP-125) is outside it: it waits on a merge request a person has not merged, which no apply can move.
 *
 * **The job half reads pg-boss's own table** (`<schema>.job`), as the stranded-stage store does: a
 * `knowledge.apply` job keyed `project:<id>` that is `created`, `retry` or `active` is an apply still
 * owed, including one waiting out its retry delay. The schema name is interpolated and therefore held
 * to a bare identifier by `assertPgBossSchema`.
 */
import type {
  KnowledgeApplyRecoveryStore,
  StrandedApply,
  StrandedApplyQuery,
  Transaction,
} from '@platform/application';
import { JOB_QUEUES } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { assertPgBossSchema } from '../jobs/queue-backlog.js';
import { AWAITING_APPLY } from '../knowledge/postgres-proposal-store.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface Row extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly attempted_at: Date | string | null;
}

/** Every stranded proposal, whatever its age. `$1` is the queue name. */
const strandedSql = (schema: string): string => `
  select p.id, p.project_id, p.apply_recovery_attempted_at as attempted_at,
         coalesce(p.decided_at, p.created_at) as decided_instant
    from kb_proposals p
   -- Unqualified on purpose: the clause is the proposal store's own, and p is the only table
   -- its columns can resolve to here.
   where ${AWAITING_APPLY}
     -- WP-125 (backlog 369): a proposal deferred behind an open knowledge merge request is waiting
     -- on a person's merge, not stranded; it is never marked or ended here. The index run that reads
     -- the merge, or the nightly hygiene sweep, asks for its apply.
     and p.apply_deferred_reason is null
     and not exists (select 1 from ${schema}.job j
                      where j.name = $1 and j.singleton_key = 'project:' || p.project_id::text
                        and j.state in ('created', 'retry', 'active'))`;

export interface PostgresKnowledgeApplyRecoveryStoreOptions {
  /** pg-boss's schema (`pgboss`). */
  readonly jobsSchema: string;
}

export const createPostgresKnowledgeApplyRecoveryStore = (
  options: PostgresKnowledgeApplyRecoveryStoreOptions,
): KnowledgeApplyRecoveryStore => {
  const stranded = strandedSql(assertPgBossSchema(options.jobsSchema));
  return {
    strandedApplies: async (tx, query: StrandedApplyQuery) => {
      const { rows } = await sqlOf(tx).query<Row>(
        `select * from (${stranded}) x
          where (x.attempted_at is null and x.decided_instant < $2)
             or (x.attempted_at is not null and x.attempted_at < $3)
          order by x.decided_instant, x.id
          limit $4`,
        [JOB_QUEUES.knowledgeApply, query.olderThan, query.endingBefore, query.limit],
      );
      return rows.map(
        (row): StrandedApply => ({
          proposalId: row.id as Id,
          projectId: row.project_id as Id,
          recoveryAttemptedAt:
            row.attempted_at === null
              ? null
              : (new Date(row.attempted_at).toISOString() as IsoDateTime),
        }),
      );
    },

    markApplyAttempt: async (tx, input) => {
      // Conditional on the predicate (standing rule 9): an apply the live path enqueued since the
      // pass's read, or a commit that landed, makes this write nothing for that proposal.
      const { rows } = await sqlOf(tx).query<{ id: string }>(
        `update kb_proposals set apply_recovery_attempted_at = $3
          where id = any($2::uuid[])
            and id in (select x.id from (${stranded}) x where x.attempted_at is null)
          returning id`,
        [JOB_QUEUES.knowledgeApply, [...input.proposalIds], input.at],
      );
      return rows.map((row) => row.id as Id);
    },

    endApply: async (tx, input) => {
      const { rows } = await sqlOf(tx).query<{ id: string }>(
        `update kb_proposals set status = 'apply_failed', apply_failure_reason = $3
          where id = any($2::uuid[])
            and id in (select x.id from (${stranded}) x where x.attempted_at is not null)
          returning id`,
        [JOB_QUEUES.knowledgeApply, [...input.proposalIds], input.reason],
      );
      return rows.map((row) => row.id as Id);
    },
  };
};
