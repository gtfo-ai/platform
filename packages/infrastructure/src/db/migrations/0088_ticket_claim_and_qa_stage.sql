-- 0088 — the ticket claim and the frozen QA stage (WP-177; BD-031 rulings 3 and 5, TD-029
-- decisions 5 and 9, technical/03's 2026-10-08 amendment).
--
-- `ticket_claim` — the platform's claim on the task's ticket: `{account_id, claimed_at,
-- status: confirmed|shadow, in_progress_written, stale, released_at, release_cause}`
-- (`storedTicketClaimSchema` in `@platform/contracts`). Written **only** by
-- `TaskRepository.saveTicketClaim`: the claim before an agent run is admitted (between the
-- `stage.execute` job's transactions), a person's *Rework* (marks it stale), the `ticket_release`
-- duty and, from WP-178, the human-return window's return (stale). Never by the whole-row `save`,
-- so no stale snapshot can put an older claim back — the partition `tasks-column-ownership.test.ts`
-- holds. Nullable with no default: `null` is "the task never claimed" — a binding with no
-- `lifecycle` block, a task with no provider ticket, and every row this migration finds.
alter table tasks add column ticket_claim jsonb;

alter table tasks add constraint tasks_ticket_claim_is_object
  check (ticket_claim is null or jsonb_typeof(ticket_claim) = 'object');

-- `qa_stage` — whether the task's pipeline has the human `qa` stage (TD-029 decision 9), frozen at
-- creation from the binding's `lifecycle.qa` and passed by every `compilePipeline` call over the
-- task beside `pipeline_dial`, so a mapping changed mid-task does not reshape a task in flight.
-- Written by the insert and by nothing else; intake is the one creating site that reads a ticket
-- binding, and every other site inserts `false`. `false` for every row this migration finds, which
-- compiles exactly the pipeline those tasks were compiled with before (the stage is declared
-- `enabled: false` in the shared merge tail, WP-174).
alter table tasks add column qa_stage boolean not null default false;

comment on column tasks.ticket_claim is
  'The ticket claim (WP-177, TD-029 decision 5): written only by TaskRepository.saveTicketClaim; null is "never claimed".';
comment on column tasks.qa_stage is
  'Whether the task''s pipeline has the human qa stage (WP-177, TD-029 decision 9): frozen at creation, written by the insert only.';
