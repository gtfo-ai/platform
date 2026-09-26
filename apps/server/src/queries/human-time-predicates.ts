/**
 * The two predicates every reader of `human_time_entries` applies (WP-61, shared at WP-44).
 *
 * They were written for the statistics read (`stats-queries.ts`) and the task page's `human_time`
 * applied neither (PROGRESS backlog 190), so the same task answered "how many human minutes" twice
 * with two numbers. One module, imported by both reads, so there is one answer — and a predicate
 * changed here changes both surfaces at once (standing rule 41: one spelling).
 *
 * Both are SQL fragments over the aliases **`h`** (`human_time_entries`) and **`t`** (`tasks`), which
 * every query that uses them must declare.
 */
import { sql } from 'drizzle-orm';

/**
 * `human_time_entries h` was written for an account an operator has **since** declared a machine
 * (WP-61, PROGRESS backlog 88).
 *
 * The projector refuses a declared machine's activity from the day it is declared; this is the
 * other half, for the rows it wrote **before** — the `handler_executions` claim makes a replay a
 * no-op for those events, so they would otherwise stay in every figure for the whole range. Matched
 * on the account key the projector stores (`"<provider>:<external id>"`, `externalAuthorKey`).
 */
export const MACHINE_AUTHORED = sql`exists (
  select 1 from user_identities ui
   where ui.kind = 'machine'
     and h.external_author = ui.provider || ':' || ui.external_id
)`;

/**
 * A **review** window an `mr.approved` touched — withheld from the published reviewer minutes
 * until `docs/TODO.md`'s real-GitLab check of the approval `user` is taken (PROGRESS backlog 188).
 *
 * The projector folds an approval into the approver's window (WP-60), so a window's minutes cannot
 * be split into "from comments" and "from the approval"; what can be said is whether an approval
 * by the window's account, in the window's project, landed inside its span — and every such window
 * is withheld **whole**. Deliberately not narrowed to the task's merge request: the task's
 * `mr_ref` can name a later merge request than the one the approval was on (a rework), and
 * matching on it would **publish** a window this rule exists to withhold. The residual runs the
 * safe way: a window is withheld when its reviewer approved some other merge request of the project
 * during it — an under-count, stated in the metric.
 */
export const APPROVAL_TOUCHED = sql`(h.kind = 'review' and exists (
  select 1 from events e
   where e.type = 'mr.approved'
     and e.occurred_at >= h.started_at
     and e.occurred_at <= coalesce(h.ended_at, h.started_at)
     and e.payload ->> 'project_id' = t.project_id::text
     and (e.payload -> 'approver' ->> 'provider') || ':' || (e.payload -> 'approver' ->> 'external_id')
         = h.external_author
))`;
