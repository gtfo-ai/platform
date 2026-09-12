-- 0015 — the ticket's own words on the task (WP-15f).
--
-- `tasks` has held `ticket_provider`/`ticket_key`/`ticket_url` since `0004_pipeline.sql:6-8` and
-- nothing else about the ticket, so the first agent stage was handed an identifier: the prompt's
-- task block was three lines and the retrieval query at `refinement` was the ticket key alone
-- (`extractQueryTerms('ACME-1')` -> `["acme"]`). PROGRESS backlog 23 has the evidence and Q61 is
-- the product decision these two columns implement.

-- **The ticket's text, bounded and redacted at the write.**
--
-- `jsonb` beside `template_snapshot` (`0004`:20) rather than three text columns, and for the same
-- reason that one is jsonb: it is a *snapshot* of somebody else's document, read once, never
-- queried field by field, and the shape will grow (`epic`, `siblings`, `attachments_text` are all
-- on `readTicket` already). `@platform/contracts`' `ticketSnapshotSchema` is the shape.
--
-- Three properties are decided rather than incidental:
--
--  * **Untrusted external text** (BD-022), like `inbox.payload` and `kb_chunks`. It is stored
--    redacted through the binding's own redactor with `redaction_count` inside the document, which
--    is the `inbox` precedent from migration 0014 rather than a new rule.
--  * **Bounded at the write**, because the store is the consumer (Q54): title 512 characters,
--    description 20 000, and the newest 20 comments at 1 000 each plus 128 for the provider's own
--    comment id and 128 for the author's display name — 45 632 characters, so at most 182 528 bytes
--    of UTF-8 before JSON escaping. One unbounded `readTicket` was measured at 53 284 565 bytes, so
--    the bound is a 292x reduction. `boundTicketSnapshot`
--    (`packages/application/src/pipeline/ticket-snapshot.ts`) owns the numbers and the derivation,
--    and a test produces the 45 632 rather than quoting it.
--  * **No default, and null means "not read".** A failed fetch and a ticket with an empty
--    description must not be spelled the same way (standing rule 18), so the absent case is the
--    column being null and the empty case is a stored document whose `description` is `''`.
--
-- It dies with the task: `tasks.id` is already `on delete cascade` from `projects`, and every row
-- that references a task is too, so deleting a project deletes the text with it (Q61 (c)).
alter table tasks add column ticket_snapshot jsonb;

-- **When it was read**, as a column rather than a field inside the document.
--
-- A separate column because it is the one part of the snapshot a *query* asks about — "which tasks
-- are running on a snapshot older than X" is an operator's question and a future refresh policy's
-- predicate — and because the answer must survive a document whose shape changes. It is never
-- written without `ticket_snapshot` and never null while `ticket_snapshot` is not: the pair is
-- written by one statement (`TaskRepository.saveTicketSnapshot`, or the insert that creates the
-- task), which is what the check below makes true of every row rather than of the code that
-- happens to write them today.
alter table tasks add column ticket_snapshot_at timestamptz;

alter table tasks
  add constraint tasks_ticket_snapshot_at_paired
  check ((ticket_snapshot is null) = (ticket_snapshot_at is null));
