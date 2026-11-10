-- migration-class: additive
-- 0111 — what the platform already handled of a task's conversation, and when a human stage first
-- saw its ticket move forward (S-28.2, M28 rulings R1 and R2, amending TD-029 decisions 8 and 10).
--
-- **`task_conversation_handled`** is the handled ledger: one row per conversation item the platform
-- answered, resolved, or read and did not treat as a change request. `source` is where the item
-- lives — `mr_thread` (a resolvable merge-request discussion), `mr_note` (a discussion that cannot
-- be resolved, a general note) or `ticket_comment` — and `thread_id` is the provider's discussion id
-- or the comment's own id. `last_note_id` is the newest note the platform had handled in that
-- thread (a comment's own id; `null` when the writer named none), so a person's **newer** note in the
-- same thread is new business. `kind` is why the row exists:
--   seen       the human-return window read a person's word that does not return the task (a ticket
--              comment, a general note, or a thread note a forward status move outranked) — what the
--              task page shows as *commented — not treated as a change request*;
--   answered   the Developer's reply was posted on it (`conversation_replies`);
--   resolved   the platform resolved the thread (`review_threads_resolve`).
-- `author` (a *seen* word's display name, redacted and at most 256 characters) and `written_at` are
-- for the task page's notice only. The ids are provider text bounded by shape, never cut: a value
-- outside the check is not recorded (the writer skips it), because a cut id is another item's id.
-- `run_id` names the run whose artifact caused the row, when there is one; no foreign key, since a
-- ledger row outlives nothing it could dangle from but the task.
--
-- Idempotent by the unique key `(task_id, source, thread_id, kind, last_note_id)` with `nulls not
-- distinct`: a replayed duty or a repeated firing of the window writes `on conflict do nothing`.
--
-- **`task_stages.ticket_forward_seen_at`** is the instant the window first saw the ticket's current
-- forward move (a status that differs from the entry status and is not a return status) during that
-- human-stage entry. Forward wins over return: no word written no later than it returns the task.
-- One writer, `TaskRepository.observeTicketForward` (`coalesce`, written once).
--
-- **Additive** (TD-032 §1 and amendment B): a table this file creates, with its checks, indexes and
-- registry row, its reference to `tasks` stating `on delete cascade`; and a nullable column the
-- previous build never names.
create table task_conversation_handled (
  id uuid primary key,
  task_id uuid not null references tasks (id) on delete cascade,
  source text not null,
  thread_id text not null,
  last_note_id text,
  run_id uuid,
  kind text not null,
  author text,
  written_at timestamptz,
  handled_at timestamptz not null,
  constraint task_conversation_handled_source_known check (
    source in ('mr_thread', 'mr_note', 'ticket_comment')
  ),
  constraint task_conversation_handled_kind_known check (kind in ('seen', 'answered', 'resolved')),
  constraint task_conversation_handled_thread_id_shape check (
    thread_id ~ '^[A-Za-z0-9:._/-]{1,255}$'
  ),
  constraint task_conversation_handled_last_note_id_shape check (
    last_note_id ~ '^[A-Za-z0-9:._/-]{1,255}$'
  ),
  constraint task_conversation_handled_author_bounded check (char_length(author) <= 256),
  constraint task_conversation_handled_once unique nulls not distinct (
    task_id, source, thread_id, kind, last_note_id
  )
);

-- The ledger read (newest first) and the task page's *seen* notice.
create index task_conversation_handled_task_idx on task_conversation_handled (task_id, handled_at);

-- `read_write`: rows are only inserted, but a task's deletion cascades to them.
insert into platform_table_policy (table_name, app_access)
values ('task_conversation_handled', 'read_write');

comment on table task_conversation_handled is
  'The handled ledger (S-28.2, M28 ruling R2): conversation items the platform answered, resolved, or read and did not treat as a change request (seen). source mr_thread | mr_note | ticket_comment; kind seen | answered | resolved. A newer person note than last_note_id is new business.';

alter table task_stages add column ticket_forward_seen_at timestamptz;

comment on column task_stages.ticket_forward_seen_at is
  'When the human-return window first saw the ticket move forward during this human-stage entry (M28 ruling R1: forward wins over return). Written once.';
