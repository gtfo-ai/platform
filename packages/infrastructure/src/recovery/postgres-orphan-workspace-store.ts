/**
 * The one read behind the orphaned-workspace pass — PROGRESS backlog **286** (WP-103).
 *
 * `packages/application/src/recovery/orphan-workspaces.ts` carries the decision: which listed run
 * ids are orphans, the two graces, and why the pass lives in the runner. What is here is the row
 * read, and one thing about it is load-bearing: an id with **no** row is simply absent from the
 * answer — the pass reads that absence as *unknown*, which is one of its two reap conditions, so a
 * query that silently dropped a row for any other reason would turn a live run into an orphan. The
 * statement therefore filters on nothing but the ids.
 *
 * The ids arrive as uuids — the pass drops anything else before it asks — so `$1::uuid[]` cannot
 * fail on a label somebody else wrote.
 */
import type {
  OrphanWorkspaceRunState,
  OrphanWorkspaceRunStore,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, RunStatus } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';

interface RunStateRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly ended_at: Date | string | null;
}

export const createPostgresOrphanWorkspaceRunStore = (): OrphanWorkspaceRunStore => ({
  runStates: async (tx: Transaction, runIds): Promise<readonly OrphanWorkspaceRunState[]> => {
    if (runIds.length === 0) {
      return [];
    }
    const { rows } = await postgresTransaction(tx).client.query<RunStateRow>(
      'select id, status, ended_at from runs where id = any($1::uuid[])',
      [runIds],
    );
    return rows.map((row) => ({
      runId: row.id as Id,
      status: row.status as RunStatus,
      endedAt: row.ended_at === null ? null : (new Date(row.ended_at).toISOString() as IsoDateTime),
    }));
  },
});
