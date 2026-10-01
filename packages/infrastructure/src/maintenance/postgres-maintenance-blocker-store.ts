/**
 * `MaintenanceBlockerStore` on PostgreSQL — `projects.maintenance_last_blocker` (migration 0069,
 * WP-113, Q111 (c)).
 *
 * **The column's one writer** is {@link PostgresMaintenanceBlockerStore.recordBlocker}, and it is a
 * compare-and-set: the `update` names the column and nothing else, and only where the stored value is
 * still the one the pass read (`is not distinct from`, so `null` compares equal to `null`). A pass
 * that lost the race to a concurrent one writes nothing and is told so. The census
 * `maintenance-blocker-writers.test.ts` holds that no other statement in the tree writes the column.
 *
 * A value the check constraint does not know cannot be written; one read back that this release does
 * not know (a later release's blocker, read by an older process) is answered as `null` — *nothing
 * recorded* — so it never hides a transition; because the stored value is not `null`, the
 * compare-and-set would then never match and the pass would announce *began* every night. It cannot
 * happen in practice: `assertSchemaIsKnown` refuses an older process before it runs.
 */

import type {
  MaintenanceBlocker,
  MaintenanceBlockerStore,
  Transaction,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

const KNOWN: ReadonlySet<string> = new Set<MaintenanceBlocker>([
  'feature_disabled',
  'paused_at_observe',
  'no_chore_types',
  'no_chore_template',
]);

export class PostgresMaintenanceBlockerStore implements MaintenanceBlockerStore {
  async lastBlocker(tx: Transaction, projectId: Id): Promise<MaintenanceBlocker | null> {
    const { rows } = await sqlOf(tx).query<{ blocker: string | null }>(
      'select maintenance_last_blocker as blocker from projects where id = $1',
      [projectId],
    );
    const blocker = rows[0]?.blocker ?? null;
    return blocker !== null && KNOWN.has(blocker) ? (blocker as MaintenanceBlocker) : null;
  }

  async recordBlocker(
    tx: Transaction,
    projectId: Id,
    expected: MaintenanceBlocker | null,
    next: MaintenanceBlocker | null,
  ): Promise<boolean> {
    const { rowCount } = await sqlOf(tx).query(
      `update projects set maintenance_last_blocker = $3
        where id = $1 and maintenance_last_blocker is not distinct from $2`,
      [projectId, expected, next],
    );
    return (rowCount ?? 0) > 0;
  }
}
