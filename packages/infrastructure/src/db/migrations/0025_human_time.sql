-- 0025 — human time accounting (WP-29, product/19 §16, product/09:29, technical/03:88).
--
-- `human_time_entries` has existed since migration 0007 and has never held a row: technical/03:88
-- describes it as *"derived from events by a projector"* and there was no projector. This migration
-- is what the projector needs and nothing else — one enum value and one column — because the table,
-- its two indexes and its foreign keys are already right.
--
-- ## The fourth kind, and why it is a new file rather than an edit to 0002
--
-- product/19 §16 defines four kinds — review, question, approval and **steer** — and
-- `human_time_kind` was created as `('review', 'question', 'approval')`. Migrations are forward-only
-- (TD-011): 0002 has been applied everywhere this platform runs, so the value is appended here.
--
-- `alter type … add value` may run inside a transaction block (PostgreSQL 12+), which is what the
-- migration runner holds every file in, but the new label may **not be used** in the same
-- transaction. Nothing below uses it: the column added underneath is `text`, and the first row whose
-- `kind` is `'steer'` is written by a handler in a later transaction. Migrations 0018 and 0024 are
-- the precedent.
--
-- It is **appended** rather than placed with `before`/`after`, because
-- `test/integration/db/enums.integration.test.ts` compares the database's labels with the zod enum
-- *in order* — and product/19 §16 lists steer fourth too, so storage and the document agree.
alter type human_time_kind add value 'steer';

-- ## The provider account, for the minutes that have no platform user
--
-- `user_id references users(id)` is the only identity this table had, and `user_identities` — the
-- one mapping from a provider account onto a platform user — got its first writer at WP-31
-- (`POST /api/org/identities`, admin) and is **empty until an operator maps an account**. So on a
-- default instance every review minute derived from a merge-request comment resolves to
-- `user_id: null`, which is the fail-closed direction and is right (BD-006, Q10: an identity the
-- platform guessed must never be acted on).
--
-- What it is *not* is a reason to merge every unmapped reviewer into one bucket. The review window
-- (product/19 §16) is per person — *"from the first human MR activity … to merge or last
-- activity"* — and the projector keys a window by the reviewer it belongs to. Without this column
-- that key would be `null` for everybody, two people commenting on one merge request would extend
-- one another's window, and the total would be a number that is nobody's. So the provider account
-- travels beside the user id: `"<provider>:<external id>"`, exactly the pair
-- `user_identities (provider, external_id)` is keyed by, which is what lets a mapping made later be
-- reconciled against the entries written before it.
--
-- It is **provider text** and therefore untrusted (BD-022), but it is an *identifier* rather than
-- free text: the projector refuses an account id longer than its bound instead of truncating it,
-- because truncation is many-to-one and would answer one reviewer's minutes with another's (the
-- argument WP-19 made for `cost_entries.model` and `idempotencyScopeFor` for an idempotency key).
-- The bound is therefore not repeated as a column type: a `varchar(n)` here would refuse a row the
-- writer has already decided to refuse, and would refuse nothing else.
alter table human_time_entries add column external_author text;

comment on column human_time_entries.external_author is
  'The provider account these minutes came from, "<provider>:<external id>", when no platform user is mapped (WP-29). Untrusted provider text (BD-022); the segment key for review minutes.';

-- Two statements of the obvious, added while the table is empty because it is the only moment they
-- are free. `minutes` is nullable (an entry whose window is still open has none) and a negative one
-- would be a clock going backwards recorded as work; `ended_at` is nullable for the same reason and
-- an ending before its beginning is not a window. Neither can be added later without a scan.
alter table human_time_entries
  add constraint human_time_entries_minutes_nonnegative
    check (minutes is null or minutes >= 0),
  add constraint human_time_entries_window_ordered
    check (ended_at is null or ended_at >= started_at);

-- `read_write`, and registered rather than defaulted.
--
-- The default for an unregistered table is already `read_write` (migration 0001's
-- `platform_grant_app_role`), so this row changes no privilege — it is here because *"the registry
-- lists every table"* is only useful as an invariant if it is true, which is the reason 0014 gave
-- for `inbox` and 0024 for `task_asks`.
--
-- Not `append_only`, and that is the one decision worth reading. A **review** entry is a window that
-- grows: the first human comment opens it, every later comment or the merge moves `ended_at` and
-- recomputes `minutes`, and the alternative — one append-only row per activity with the fold done by
-- every reader — would put product/19 §16's caps and its *"excluding gaps > 2 h"* on the read side,
-- where each reader would have to reproduce them. This is a **projection**, like `budget_windows`
-- and `cost_rollup_daily`: rebuildable from `events`, which is what `events/replay.ts` does.
insert into platform_table_policy (table_name, app_access)
values ('human_time_entries', 'read_write');
