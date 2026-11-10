-- migration-class: additive
-- 0116 — a ticket or a merge request out of sync is visible, never silent (S-28.10, TD-029's
-- amendment C).
--
-- AUT-6655 left twenty failed `transition_ticket` calls: Jira stayed at *Ready for Merge* beside a
-- **Draft** merge request, and the product showed nothing — the audit row kept no error and the
-- lifecycle duty only logged a warning.
--
-- **`integration_actions.error_code` / `error_message`.** A failed row keeps what failed: the
-- `IntegrationError` code (or the error's class name — platform vocabulary, never provider text;
-- held to `^[A-Za-z0-9_.-]{1,64}$` by the executor, not by a check here: a constraint on this
-- existing, partitioned table would have to be added `not valid`, which a partitioned table refuses)
-- and the message the executor already redacted and bounded (TD-012). `null` on every other row,
-- and on every row written before this file.
--
-- **`task_provider_sync`.** One row per task and **subject** while that subject is out of sync:
--   ticket_status        a lifecycle move failed — `slot` the lifecycle slot, `target` the status the
--                        platform wanted, `observed` the status the tracker showed when it was read
--                        after the failure (`null` when it could not be read), `available` the
--                        statuses the ticket could move to then (`null` when the provider cannot
--                        list them);
--   merge_request_draft  the merge request still read back as a draft after the platform marked it
--                        ready — `target` is `ready`, `observed` is `draft`.
-- `reason` is the redacted, bounded provider reason and `reason_code` its code. `attempts` counts
-- the failures since the subject was last in sync. The row is **deleted** when a later move or
-- read-back succeeds, so a row present is the fact "out of sync now".
--
-- **Additive** (TD-032 §1): two nullable columns and a new table with its checks and registry row;
-- the previous build names none of them.
alter table integration_actions
  add column error_code text,
  add column error_message text;

create table task_provider_sync (
  task_id uuid not null references tasks (id) on delete cascade,
  subject text not null,
  slot text,
  target text not null,
  observed text,
  available jsonb,
  reason text not null,
  reason_code text,
  failed_at timestamptz not null,
  attempts integer not null default 1,
  primary key (task_id, subject),
  constraint task_provider_sync_subject_known check (
    subject in ('ticket_status', 'merge_request_draft')
  ),
  constraint task_provider_sync_target_shape check (length(target) between 1 and 255),
  constraint task_provider_sync_observed_shape check (length(observed) between 1 and 255),
  constraint task_provider_sync_slot_shape check (slot ~ '^[a-z_]{1,64}$'),
  constraint task_provider_sync_reason_shape check (length(reason) between 1 and 2000),
  constraint task_provider_sync_reason_code_shape check (reason_code ~ '^[A-Za-z0-9_.-]{1,64}$'),
  constraint task_provider_sync_available_shape check (
    available is null or jsonb_typeof(available) = 'array'
  ),
  constraint task_provider_sync_attempts_positive check (attempts >= 1)
);

-- `read_write`: a failure upserts the row, a success deletes it.
insert into platform_table_policy (table_name, app_access)
values ('task_provider_sync', 'read_write');

comment on table task_provider_sync is
  'A task''s ticket status or merge request out of sync with what the platform wanted (S-28.10, TD-029 amendment C): one row per task and subject (ticket_status, merge_request_draft) while it is, with the target, what the provider showed, the redacted reason and the attempts; deleted when a later move or read-back succeeds.';
