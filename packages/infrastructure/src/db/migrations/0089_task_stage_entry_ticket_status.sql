-- 0089 — `task_stages.entry_ticket_status` and `task_stages.ticket_seen_at_qa`: what the human-return
-- window saw of the ticket's status during one entry into a human stage (WP-178 review, TD-029
-- decision 7's amendment (a), (b), (e) and (f), PROGRESS backlog 535 (d)).
--
-- **The status form is a change, never a state** (amendment (a)). Every lifecycle slot is optional,
-- so a project that maps `in_progress` but not `approved` reaches `ready_for_merge` (or `qa`) with the
-- ticket still at a status the form counts; reading only the current status, every firing of the
-- window — an acknowledgement included — returned the task until `human_rounds` was spent (measured
-- by the WP-178 reviewer). The window now records the ticket's status at the stage's entry — by
-- amendments (e) and (f): the `to` of the latest change recorded since the entry into any slot the
-- platform writes (`in_review`, `approved`, `qa`, echoed by a webhook), else the `from` of the
-- earliest change recorded since the entry, else the first status it reads there — and the status
-- form returns the task only when the current status is a return status **and differs from it**.
--
-- **The pass reads the same record** (amendment (b)): `ticket_seen_at_qa` is set once the window has
-- seen the ticket at the `qa` slot during this entry (at a firing, or as a recorded change's `from`
-- or `to`), so a binding that only polls — which records no `from` — passes QA when the ticket then
-- leaves it.
--
-- **Per stage attempt**, on the row of the entry it describes: a re-entry (a return and a second
-- pass through the reviews) is a new row and records afresh, and nothing is reset by hand. Both
-- nullable/false for every row written before this migration and every stage that is not a human
-- stage. The text is provider text, bounded as a lifecycle status name is (255, contracts'
-- `MAX_LIFECYCLE_STATUS_NAME_CHARS`).
--
-- One writer, `TaskRepository.observeHumanStageStatus` — `coalesce` for the entry (written once) and
-- `or` for the sighting (never cleared) — called by the window's job in a transaction of its own; one
-- reader, its own answer. No backfill: a task waiting at a human stage when this runs records its
-- entry at the window's next firing.
alter table task_stages add column entry_ticket_status text;
alter table task_stages add constraint task_stages_entry_ticket_status_bounded
  check (entry_ticket_status is null or char_length(entry_ticket_status) between 1 and 255);
alter table task_stages add column ticket_seen_at_qa boolean not null default false;
