/**
 * The two predicates every reader of `human_time_entries` applies (WP-61, shared at WP-44), and a
 * third only the statistics read applies ({@link HUMAN_COMMENTED}, WP-90).
 *
 * They were written for the statistics read (`stats-queries.ts`) and the task page's `human_time`
 * applied neither (PROGRESS backlog 190), so the same task answered "how many human minutes" twice
 * with two numbers. One module, imported by both reads, so there is one answer — and a predicate
 * changed here changes both surfaces at once (standing rule 41: one spelling).
 *
 * All three are SQL fragments over the aliases **`h`** (`human_time_entries`) and **`t`** (`tasks`),
 * which every query that uses them must declare.
 */
import { PLATFORM_COMMENT_MARKER_PREFIX } from '@platform/application';
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

/**
 * A **review** window that contains at least one merge-request comment a human wrote — by the
 * window's own account, in the task's project, inside the window's span (WP-90, PROGRESS backlog
 * 191). product/16's first-pass acceptance counts *"zero human MR comments"*, and since WP-60 an
 * approval opens a window exactly as a comment does, so counting windows made a reviewer who only
 * approved read as a reviewer who commented.
 *
 * "A human wrote" is the projector's own test, applied to the stored `mr.review.comment` text: the
 * platform's marker anywhere in the body ({@link PLATFORM_COMMENT_MARKER_PREFIX}, `includes` there,
 * `strpos` here), so a comment the projector refused to fold is not one this predicate counts. The
 * stored text is the provider's note body after the binding's redactor and nothing else — no cap,
 * no strip (`gitlab/inbound.ts` copies `object_attributes.note`) — so a marker at any offset
 * survives into the row. A declared machine's window is already out ({@link MACHINE_AUTHORED}).
 *
 * **Not narrowed to the task's merge request**, for {@link APPROVAL_TOUCHED}'s reason: `mr_ref` can
 * name a later merge request than the one the comment was on. The residual runs one way: a
 * reviewer who approved this task's merge request and, inside that same window's span, commented on
 * another merge request of the project makes this task not first-pass — an under-count.
 */
export const HUMAN_COMMENTED = sql`(h.kind = 'review' and exists (
  select 1 from events e
   where e.type = 'mr.review.comment'
     and e.occurred_at >= h.started_at
     and e.occurred_at <= coalesce(h.ended_at, h.started_at)
     and e.payload ->> 'project_id' = t.project_id::text
     and (e.payload -> 'author' ->> 'provider') || ':' || (e.payload -> 'author' ->> 'external_id')
         = h.external_author
     and strpos(e.payload ->> 'text', ${PLATFORM_COMMENT_MARKER_PREFIX}) = 0
))`;
