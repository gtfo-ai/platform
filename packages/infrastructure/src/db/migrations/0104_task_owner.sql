-- migration-class: additive
-- 0104 — a task has an owner (S-26.1, TD-031's 2026-11-06 amendment items 1–3, BD-031's 2026-11-06
-- amendment 1).
--
-- Four nullable columns on `tasks`, none with a default, so every row the previous build writes
-- carries null in all four and reads as *nobody owns it, and no assignee has been read* — which is
-- what every task meant before this file:
--
--   owner_user_id     the platform user who owns the task; always a user whose effective project
--                     role is `member` or above when it is written (the platform's check, not a
--                     constraint: a role can change after the write, and the read model shows the
--                     owner it has). `on delete set null` (TD-032 amendment B): a deleted user leaves
--                     the task unowned rather than refusing the previous build's delete of the user.
--   owner_source      who made the last owner change: `tracker` (a sync of the ticket's assignee, or
--                     a link adopting it) or `platform` (a person's command, a pick). Null until the
--                     first change.
--   owner_changed_at  when that change was made — what *latest change wins* orders by, and what the
--                     write-back duty (S-26.3) re-checks on fire.
--   ticket_assignee   the tracker assignee the platform last read, `{provider, external_id,
--                     display_name, platform}` — the display name redacted through the binding's
--                     redactor and bounded to 128 characters (BD-022: one more stored sink of
--                     provider text), `platform` true for the binding's own account or a `machine`
--                     identity. Null is *unassigned in the tracker, or never read*. A sync acts only
--                     when a read differs from this value, so a platform assignment survives until
--                     somebody changes the tracker.
--
-- One writer for all four: `TaskRepository.saveOwner`, a compare-and-set on the previous owner and
-- the previous assignee (`tasks-column-ownership.test.ts`). The check is TD-032 amendment C's
-- shape: `not valid` over a column this file adds, null-propagating by construction, then
-- validated (no row carries a value yet). `ticket_assignee`'s shape is held by the one writer's
-- schema (`ticketAssigneeSchema`), parsed again at every read.
alter table tasks add column owner_user_id uuid references users (id) on delete set null;
alter table tasks add column owner_source text;
alter table tasks add column owner_changed_at timestamptz;
alter table tasks add column ticket_assignee jsonb;

alter table tasks add constraint tasks_owner_source_known
  check (owner_source in ('tracker', 'platform')) not valid;

alter table tasks validate constraint tasks_owner_source_known;

-- The board's *Mine* filter, and the delete of a user that `on delete set null` scans for.
create index tasks_owner_user_id_idx on tasks (owner_user_id) where owner_user_id is not null;

comment on column tasks.owner_user_id is
  'The task''s owner (S-26.1, TD-031 2026-11-06 item 1): a member-or-above user of the project when written. Null is unowned. Written only by saveOwner.';
comment on column tasks.ticket_assignee is
  'The tracker assignee last read {provider, external_id, display_name (redacted, <= 128), platform}; null is unassigned or never read. Written only by saveOwner.';
