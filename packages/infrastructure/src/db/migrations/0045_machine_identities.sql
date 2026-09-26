-- 0045 — an operator may declare a provider account a **machine** (WP-61, PROGRESS backlog 88).
--
-- The human-time projector tells the platform's own merge-request comments from a person's by the
-- HTML marker every one of them carries, and by nothing else. A CI bot, a dependency updater or a
-- release bot carries no marker, so its first comment **opens** a review window (product/19 §16) and
-- every later one **extends** it: every reviewer-minutes figure over-counts by however many robots
-- comment. The platform cannot tell a robot from a person in somebody else's tracker without being
-- told, and until this migration there was nowhere to tell it.
--
-- ## Why the flag is on `user_identities` and not a list in `organizations.settings`
--
-- Both were priced on WP-61's row. The list would need no migration, but it would be the first
-- reader **and** the first writer of a `jsonb` column nothing touches, with a schema of its own, a
-- second command, and a key — `(provider, external_id)` — that already *is* this table's primary
-- key. So an account could be declared a machine in the list and mapped to a person here at the same
-- time, and every reader would have to decide which of two statements wins. On this table the
-- primary key makes the two statements **one row**: an account is a person, a machine, or nobody the
-- operator has spoken about, and re-declaring it is the upsert `POST /api/org/identities` already
-- performs. The cost, stated: this migration, two wire schemas (the command and the published row),
-- and a decision at each of the three readers of the table about what "mapped to nobody on purpose"
-- means — the inbound directory (a machine resolves to **no** user, so nothing it writes is acted
-- on), the human-time projector's lookup (a machine's activity is **refused**, not written as a
-- zero-minute row), and through the directory the ask refusal (a machine is `unverified_identity`,
-- exactly as an unmapped account is).
--
-- It is **declared by an operator and never guessed** — the argument BD-022 and Q10 use to refuse an
-- email match: nothing in the platform infers `machine` from a display name, a `[bot]` suffix or a
-- provider's `bot` flag, because a guess that is wrong here silently deletes a person's minutes.
--
-- ## The shape
--
-- `user_id` becomes nullable and `kind` is added, and the two are tied by one constraint: a person
-- has a platform user and a machine has none. `on delete cascade` stays on `user_id` and now reads
-- exactly right — deleting a user removes the accounts that were theirs and leaves the machines.
--
-- `text` with a check rather than an enum, because the vocabulary is closed at two and a third kind
-- is a decision that should cost a migration either way; the check says the same thing without an
-- `alter type` whose new label cannot be used in the transaction that adds it (0025's note).
--
-- Every existing row is a mapping an operator made to a person (WP-31's command required a
-- `user_id`), so the default `'person'` describes every row this migration finds and nothing is
-- backfilled.
alter table user_identities alter column user_id drop not null;

alter table user_identities add column kind text not null default 'person';

alter table user_identities
  add constraint user_identities_kind_known check (kind in ('person', 'machine')),
  add constraint user_identities_kind_has_user check ((kind = 'person') = (user_id is not null));

comment on column user_identities.kind is
  'person — the account is a platform user''s (user_id set); machine — an operator declared it a bot, which maps to nobody on purpose (user_id null) and whose merge-request activity is never counted as human review (WP-61, PROGRESS backlog 88).';

comment on table user_identities is
  'External identities an operator mapped to platform users or declared machines (BD-006, WP-31, WP-61). Unmapped authors are recorded, never acted on (BD-022); a machine is never acted on either.';
