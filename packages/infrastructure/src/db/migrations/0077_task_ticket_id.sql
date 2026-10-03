-- 0077 — one task per ticket, decided by the ticket's stable id where the provider has one (WP-134,
-- PROGRESS backlog 418).
--
-- ## Measured first
--
-- The key is stored as `tasks.ticket_key` (0004_pipeline.sql), and one task per ticket was the
-- unique `(project_id, ticket_key, mode)` plus intake's `findByTicket` on the same tuple. Jira
-- answers an issue moved to another project under its new key — `GET issue/OLD-1` returns
-- `NEW-5` — and a webhook delivered after the move carries `NEW-5`. So a task created as `OLD-1`
-- did not stop a second task for the same issue under `NEW-5`, on either door.
--
-- Every Jira document the adapter already reads carries the issue's stable `id` beside its key:
-- `GET issue/{key}` (the manual start's read and intake's snapshot), `GET search/jql` (the poll)
-- and the webhook envelope's `issue` (the `id` of an `IssueBean`, which a move does not change).
-- The fixtures under `test/fixtures/http/jira-cloud/` show it on all three. The adapter now carries
-- it as `TicketRef.id`. That a move keeps it: Atlassian's knowledge base
-- (https://support.atlassian.com/jira/kb/moved-issues-no-longer-redirect-from-previous-issue-key-or-url-in-jira/,
-- retrieved 2026-10-03) redirects every former key to the current one and joins them to the issue's
-- own id (`moved_issue_key.issue_id = jiraissue.id`). Not measured on a Cloud site.
--
-- ## The column, and the index that makes it a rule
--
-- `ticket_id` is that id, written once at insert by intake and never updated — `null` for a
-- provider with no stable id (the fake, GitLab issues read as tickets) and for every task created
-- before this migration, which keep the key-only rule they were created under (no backfill: the id
-- is the provider's, and a migration cannot ask Jira). The partial unique index is the backstop for
-- two intakes of one issue under two keys that race past `findByTicket`: the second insert fails
-- and its job re-runs into the first task, the same path a race on the key takes today.
alter table tasks add column ticket_id text;

alter table tasks
  add constraint tasks_ticket_id_shape
    check (ticket_id is null or (length(ticket_id) between 1 and 64 and ticket_id ~ '^[A-Za-z0-9._:-]+$'));

create unique index tasks_project_ticket_id_mode
  on tasks (project_id, ticket_provider, ticket_id, mode)
  where ticket_id is not null;
