/**
 * **The audit of a pick** (WP-293, TD-031's 2026-11-05 claim-scope amendment, decision 3): one
 * `human_actions` row `worker.take_offer` `{worker_id, run_id, via: 'worker_ui'}` in the claim's own
 * transaction, under the **worker's user** — read from the `workers` row in the same statement, so
 * the row names the person whose machine took the run and never a caller-supplied id. A worker row
 * that is gone writes nothing (the claim's own statement already refused such a worker).
 *
 * **A pick that assigned** (S-26.4, TD-031's 2026-11-06 amendment item 7) writes a second row beside
 * it, `task.owner` `{user_id, via: 'pick', worker_id, run_id, changed: true, owner_user_id}` — the
 * owner command's action and the shape of its params, with the pick's `via` — under the same user,
 * in the same statement, so the two rows commit together or not at all.
 */
import type { Transaction, WorkerTakeAudit } from '@platform/application';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';

export const createPostgresWorkerTakeAudit = (): WorkerTakeAudit => ({
  record: async (tx: Transaction, entry) => {
    const assigned = entry.assignedOwner ?? null;
    await postgresTransaction(tx).client.query(
      `insert into human_actions (task_id, user_id, action, params)
       select $1, w.user_id, a.action, a.params
         from workers w
        cross join lateral (
          select 'worker.take_offer' as action, $3::jsonb as params, 1 as ord
          union all
          select 'task.owner', $4::jsonb, 2 where $4::jsonb is not null
        ) a
        where w.id = $2
        order by a.ord`,
      [
        entry.taskId,
        entry.workerId,
        JSON.stringify({ worker_id: entry.workerId, run_id: entry.runId, via: 'worker_ui' }),
        assigned === null
          ? null
          : JSON.stringify({
              user_id: assigned,
              via: 'pick',
              worker_id: entry.workerId,
              run_id: entry.runId,
              changed: true,
              owner_user_id: assigned,
            }),
      ],
    );
  },
});
