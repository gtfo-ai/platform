/**
 * **The audit of a pick** (WP-293, TD-031's 2026-11-05 claim-scope amendment, decision 3): one
 * `human_actions` row `worker.take_offer` `{worker_id, run_id, via: 'worker_ui'}` in the claim's own
 * transaction, under the **worker's user** — read from the `workers` row in the same statement, so
 * the row names the person whose machine took the run and never a caller-supplied id. A worker row
 * that is gone writes nothing (the claim's own statement already refused such a worker).
 */
import type { Transaction, WorkerTakeAudit } from '@platform/application';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';

export const createPostgresWorkerTakeAudit = (): WorkerTakeAudit => ({
  record: async (tx: Transaction, entry) => {
    await postgresTransaction(tx).client.query(
      `insert into human_actions (task_id, user_id, action, params)
       select $1, w.user_id, 'worker.take_offer', $3::jsonb
         from workers w
        where w.id = $2`,
      [
        entry.taskId,
        entry.workerId,
        JSON.stringify({ worker_id: entry.workerId, run_id: entry.runId, via: 'worker_ui' }),
      ],
    );
  },
});
