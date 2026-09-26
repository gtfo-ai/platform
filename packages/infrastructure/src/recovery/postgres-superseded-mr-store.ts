/**
 * The superseded-merge-request recovery's reads and writes — PROGRESS backlog **178** (WP-59 review
 * round 1).
 *
 * `packages/application/src/recovery/superseded-mr.ts` carries the argument: why an unsettled row
 * is a lost or failed close, why one attempt, and why the ending is loud. What is here is the SQL,
 * driven by `superseded_merge_requests_unsettled_idx` (migration 0043), which covers exactly the
 * rows the pass may act on, so a pass costs the unsettled rows rather than the table.
 *
 * Both writes carry `settled_at is null` in their predicate: a duty that settled the row between the
 * pass's read and its write wins, and the pass neither marks nor abandons a merge request that was
 * closed in the meantime.
 */
import type {
  StrandedSupersededMergeRequest,
  SupersededMergeRequestRecoveryStore,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, MergeRequestRef } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface Row extends Record<string, unknown> {
  readonly task_id: string;
  readonly project_id: string;
  readonly iid: number;
  readonly mr_ref: MergeRequestRef;
  readonly new_branch: string | null;
  readonly cause_event_id: string;
  readonly recovery_attempted_at: Date | string | null;
}

export const createPostgresSupersededMergeRequestStore =
  (): SupersededMergeRequestRecoveryStore => ({
    strandedSupersededMergeRequests: async (tx, query) => {
      const result = await sqlOf(tx).query<Row>(
        `select task_id, project_id, iid, mr_ref, new_branch, cause_event_id, recovery_attempted_at
         from superseded_merge_requests
        where settled_at is null
          and ((recovery_attempted_at is null and superseded_at < $1)
               or recovery_attempted_at < $2)
        order by superseded_at
        limit $3`,
        [query.olderThan, query.endingBefore, query.limit],
      );
      return result.rows.map(
        (row): StrandedSupersededMergeRequest => ({
          taskId: row.task_id as Id,
          projectId: row.project_id as Id,
          iid: row.iid,
          mrUrl: row.mr_ref.url,
          mrProjectPath: row.mr_ref.project_path ?? null,
          newBranch: row.new_branch,
          causeEventId: row.cause_event_id as Id,
          recoveryAttemptedAt:
            row.recovery_attempted_at === null
              ? null
              : (new Date(row.recovery_attempted_at).toISOString() as IsoDateTime),
        }),
      );
    },

    markSupersededAttempt: async (tx, input) => {
      await sqlOf(tx).query(
        `update superseded_merge_requests set recovery_attempted_at = $3
        where task_id = $1 and iid = $2 and settled_at is null`,
        [input.taskId, input.iid, input.at],
      );
    },

    endSupersededMergeRequest: async (tx, input) => {
      await sqlOf(tx).query(
        `update superseded_merge_requests
          set settled_at = $3, outcome = 'abandoned', detail = $4
        where task_id = $1 and iid = $2 and settled_at is null`,
        [input.taskId, input.iid, input.at, input.reason],
      );
    },
  });
