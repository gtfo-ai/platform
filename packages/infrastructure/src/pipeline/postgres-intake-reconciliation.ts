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
 * Four predicates, each of which is load-bearing:
 *
 *  1. **no task row** for `(project_id, ticket.provider, ticket.key, mode = 'normal')` — the same
 *     tuple `tasks_project_id_ticket_key_mode` is unique on and `saga.ts`'s `findByTicket` reads —
 *     nor for the ticket's stable id under another key (WP-134, migration 0077), which is how
 *     `findByTicket` answers a moved issue; without it a match intake rightly dropped as the moved
 *     issue's would read as a lost one;
 *  2. **not already re-emitted** by this component, which is what bounds the recovery to one
 *     attempt per ticket and stops an event log growing behind a permanently failing intake;
 *  3. **one row per ticket**, because a ticket legitimately matches more than once (a poll that
 *     overlapped a webhook) and two rows would enqueue two doomed intakes;
 *  4. **the ticket's latest match was not answered by a skip** (PROGRESS backlog 542). No task row
 *     has a second, legitimate reason since WP-177: intake read the ticket, found it assigned to
 *     somebody else on a binding that does not take assigned tickets, and recorded
 *     `ticket.intake.skipped` instead of inserting. That event's `cause_event_id` is the match's own
 *     event id on both doors — the webhook and the poll both append `ticket.matched` through
 *     `recordNormalisedDelivery`, and the one handler that enqueues `intake_check` (`saga.ts`'s
 *     `pipeline.intake`) carries `event.id` into the job, which `recordIntakeSkip` writes as the
 *     cause. So the skip is tied to **that** match, never to the ticket: a later match whose wake-up
 *     really was lost is still recovered. It is asked of the match predicate 3 kept — the latest —
 *     rather than of every match, because a skip answers the ticket's newest announcement with the
 *     ticket's state as of then; an older match re-emitted behind it would only read the ticket
 *     again, and a ticket unassigned in between reaches intake through the next webhook or poll.
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
        `select latest.id, latest.project_id, latest.payload
           from (
         select distinct on (e.payload ->> 'project_id',
                             e.payload -> 'ticket' ->> 'provider',
                             e.payload -> 'ticket' ->> 'key')
                e.id          as id,
                e.payload ->> 'project_id' as project_id,
                e.payload     as payload,
                e.payload -> 'ticket' ->> 'provider' as provider,
                e.payload -> 'ticket' ->> 'key' as ticket_key
           from events e
          where e.type = 'ticket.matched'
            and e.occurred_at < $1::timestamptz
            and e.occurred_at > now() - ($2 || ' days')::interval
            and not exists (
              select 1
                from tasks t
               where t.project_id = (e.payload ->> 'project_id')::uuid
                 and t.ticket_provider = e.payload -> 'ticket' ->> 'provider'
                 and (t.ticket_key = e.payload -> 'ticket' ->> 'key'
                      or t.ticket_id = e.payload -> 'ticket' ->> 'id')
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
                ) latest
          where not exists (
              select 1
                from events s
               where s.type = 'ticket.intake.skipped'
                 and s.occurred_at > now() - ($2 || ' days')::interval
                 and s.cause_event_id = latest.id
            )
          order by latest.project_id, latest.provider, latest.ticket_key
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
