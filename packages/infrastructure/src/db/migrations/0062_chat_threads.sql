-- 0062 — which task a chat thread belongs to (WP-88, PROGRESS backlog 195).
--
-- A threaded Slack reply carries a channel and a `thread_ts` and nothing else: no task, no
-- question. Turning it into `task.question.answered` needs a map from the thread to the task, and
-- until this migration that map was the Slack adapter's own memory (`SlackThreadDirectory`) — which
-- the binding loader builds afresh for every call so the redactor can carry the call's run-scoped
-- credentials (Q55). On the inbound path it was therefore always empty, and every reply reached
-- nothing.
--
-- **One row per thread, written by the process that opened it.** The notify duty records the row
-- after `postTaskThread` answers (or the executor replays the stored `ThreadRef`), in a
-- transaction of its own, `on conflict do nothing`; the webhook ingress reads it before it
-- normalises a delivery. The question a reply answers is not stored here: it is the newest
-- `notifications` row of class `question` whose `message_ref` names this thread and whose question
-- is still open, because that row already records the question's message (WP-88 writes it for a
-- question as WP-65 did for an approval).
--
-- **The key is the account's thread.** `(integration_id, channel, thread_id)` is unique on the
-- provider's side; the reader also filters by `project_id`, so a delivery normalised for one
-- project cannot resolve another project's thread in a channel both use.
--
-- **Provider text, bounded.** `channel` and `thread_id` are what Slack answered — redacted by the
-- binding's redactor before the write, and held to 255 characters by the check below, which is also
-- the bound the ingress applies before it reads (`MAX_THREAD_HANDLE_CHARS`).
--
-- **Retention: with the task** (cascade). Append-only: a thread is recorded once and never moves.
create table chat_threads (
  project_id uuid not null references projects (id) on delete cascade,
  integration_id uuid not null references integrations (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  channel text not null,
  thread_id text not null,
  created_at timestamptz not null default now(),
  primary key (integration_id, channel, thread_id),
  constraint chat_threads_channel_shape check (char_length(channel) between 1 and 255),
  constraint chat_threads_thread_id_shape check (char_length(thread_id) between 1 and 255)
);

create index chat_threads_task_idx on chat_threads (task_id);

-- "Which question did this thread ask?" — the reader's second half, off the question's message.
create index notifications_question_message_idx
  on notifications (task_id, created_at desc)
  where class = 'question' and message_ref is not null;

insert into platform_table_policy (table_name, app_access)
values ('chat_threads', 'append_only');

comment on table chat_threads is
  'Which task a chat thread belongs to (WP-88, backlog 195): written by the notify duty when it opens the thread, read by the webhook ingress to resolve a threaded reply.';
