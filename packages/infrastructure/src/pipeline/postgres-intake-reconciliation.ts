/**
 * The one query behind PROGRESS backlog entry **20**: matched tickets the platform owes a task for
 * (WP-15c).
 *
 * It reads the **event log** rather than a projection, because a `ticket.matched` whose intake
 * enqueue was lost exists nowhere else — that is the whole shape of the loss. `events` is
 * partitioned by `occurred_at`, so the pass is bounded on both sides: no older than
 * `lookbackDays` (partitions older than that are not scanned at all) and no younger than the
 * caller's grace period.
 *
 * Three predicates, each of which is load-bearing:
 *
 *  1. **no task row** for `(project_id, ticket.provider, ticket.key, mode = 'normal')` — the same
 *     tuple `tasks_project_id_ticket_key_mode` is unique on and `saga.ts`'s `findByTicket` reads;
 *  2. **not already re-emitted** by this component, which is what bounds the recovery to one
 *     attempt per ticket and stops an event log growing behind a permanently failing intake;
 *  3. **one row per ticket**, because a ticket legitimately matches more than once (a poll that
 *     overlapped a webhook) and two rows would enqueue two doomed intakes.
 */
import type { IntakeReconciliationStore, UnstartedMatch } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import type { SqlExecutor } from '../events/sql.js';

/**
 * How far back a pass looks.
 *
 * A window rather than "all of history" for two reasons: `events` is partitioned by month, so an
 * unbounded scan touches every partition ever created; and a matched ticket nobody noticed for a
 * fortnight is a thing to fix by hand, not to start an agent on without telling anyone.
 */
export const DEFAULT_INTAKE_RECONCILE_LOOKBACK_DAYS = 7;

interface MatchRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly payload: Record<string, unknown>;
}

export interface PostgresIntakeReconciliationOptions {
  readonly sql: SqlExecutor;
  readonly lookbackDays?: number;
}

export const createPostgresIntakeReconciliationStore = (
  options: PostgresIntakeReconciliationOptions,
): IntakeReconciliationStore => {
  const lookbackDays = options.lookbackDays ?? DEFAULT_INTAKE_RECONCILE_LOOKBACK_DAYS;

  return {
    findUnstartedMatches: async (input: {
      readonly olderThan: IsoDateTime;
      readonly limit: number;
      readonly reconcilerComponent: string;
    }): Promise<readonly UnstartedMatch[]> => {
      const { rows } = await options.sql.query<MatchRow>(
        `select distinct on (e.payload ->> 'project_id',
                             e.payload -> 'ticket' ->> 'provider',
                             e.payload -> 'ticket' ->> 'key')
                e.id          as id,
                e.payload ->> 'project_id' as project_id,
                e.payload     as payload
           from events e
          where e.type = 'ticket.matched'
            and e.occurred_at < $1::timestamptz
            and e.occurred_at > now() - ($2 || ' days')::interval
            and not exists (
              select 1
                from tasks t
               where t.project_id = (e.payload ->> 'project_id')::uuid
                 and t.ticket_provider = e.payload -> 'ticket' ->> 'provider'
                 and t.ticket_key = e.payload -> 'ticket' ->> 'key'
                 and t.mode = 'normal'
            )
            and not exists (
              select 1
                from events r
               where r.type = 'ticket.matched'
                 and r.occurred_at > now() - ($2 || ' days')::interval
                 and r.actor ->> 'kind' = 'system'
                 and r.actor ->> 'component' = $3
                 and r.payload ->> 'project_id' = e.payload ->> 'project_id'
                 and r.payload -> 'ticket' ->> 'key' = e.payload -> 'ticket' ->> 'key'
                 and r.payload -> 'ticket' ->> 'provider' = e.payload -> 'ticket' ->> 'provider'
            )
          order by e.payload ->> 'project_id',
                   e.payload -> 'ticket' ->> 'provider',
                   e.payload -> 'ticket' ->> 'key',
                   e.position desc
          limit $4`,
        [input.olderThan, String(lookbackDays), input.reconcilerComponent, input.limit],
      );

      return rows.map((row) => ({
        eventId: row.id as Id,
        projectId: row.project_id as Id,
        payload: row.payload,
      }));
    },
  };
};
