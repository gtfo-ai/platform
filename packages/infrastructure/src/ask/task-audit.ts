/**
 * **The person who started a task by hand is on its audit** (WP-134, PROGRESS backlog 416).
 *
 * A manual start (`POST /api/projects/:id/tasks`, WP-122) writes its `human_actions` row `task.start`
 * in the transaction that appends the `ticket.matched`, and no task exists then: intake creates it
 * later, in its own job and transaction. So the row's `task_id` is null, and a task audit read keyed
 * on `task_id` — *Who did what*, the task export and `get_task_context`'s `audit` — started at intake,
 * without the human act that caused the task.
 *
 * **Read, never written** (backlog 416's option (b)). Setting `task_id` from intake (option (a)) is
 * an `update` of a table `platform_table_policy` declares `append_only`, on which migration 0001's
 * grant function gives the application role `insert` and revokes `update` — the audit is the row as
 * it was written. So every audit reader also returns the one `task.start` row that names this
 * task's **originating match**:
 *
 * - the task's `task.created` event names the `ticket.matched` intake consumed as its
 *   `cause_event_id` (`saga.ts`, `contextFor(…, causeEventId)`);
 * - the row's `params.event_id` names the match the start appended (`manualStartAuditParams`);
 * - a match the intake reconciler re-emitted (`intake-reconcile.ts`) carries the lost original as
 *   **its** `cause_event_id`, so the original is accepted one step back too.
 *
 * `params.project_id` must also be the task's project, which is what puts the lookup on
 * `human_actions_project_idx` (migration 0071) rather than a scan, and keeps a row that names
 * another project's event — `params` is written by the platform, but it is still the audit table's
 * JSON — from attaching itself to this task. A rule-matched task finds no row: its match was
 * appended by an integration, and nobody wrote a `task.start` for it.
 *
 * One spelling for two query styles (standing rule 9): the raw adapter splices a placeholder, the
 * server's Drizzle reader splices a bound parameter, both between the same two halves.
 */
import { MANUAL_START_ACTION } from '@platform/application';

/**
 * The scalar subquery, split around the task id: `[before, after]`. The id goes between the two,
 * as a placeholder (`$1`) or a bound parameter; nothing else is spliced.
 */
export const MANUAL_START_ACTION_ID_SQL: readonly [string, string] = [
  `(select ha.id
      from tasks t
      join events created
        on created.stream_type = 'task'
       and created.stream_id = t.id
       and created.type = 'task.created'
      left join events matched
        on matched.id = created.cause_event_id
       and matched.type = 'ticket.matched'
      join human_actions ha
        on ha.action = '${MANUAL_START_ACTION}'
       and ha.task_id is null
       and (ha.params ->> 'project_id') = t.project_id::text
       and (ha.params ->> 'event_id') in (created.cause_event_id::text, matched.cause_event_id::text)
     where t.id = (`,
  `)::uuid
     order by ha.created_at
     limit 1)`,
];

/** {@link MANUAL_START_ACTION_ID_SQL} around a placeholder, for a raw `pg` query. */
export const manualStartActionIdSql = (placeholder: string): string =>
  `${MANUAL_START_ACTION_ID_SQL[0]}${placeholder}${MANUAL_START_ACTION_ID_SQL[1]}`;
