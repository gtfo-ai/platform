-- 0090 — `bindings.account_identity`: the account a task-management binding's credential acts as,
-- read when the binding is saved (WP-181 review round 2, Q118 answered by its recommendation (a)).
--
-- Q118 (a) keeps a person's own token allowed and names its cost in the readiness output: a note
-- when the binding's own account is a platform user mapped as a person. The orchestrator's ruling
-- (WP-181 round 2) is that `GET …/readiness` makes **no** provider call, so the account is read where
-- the platform already reads the tracker — `PUT …/bindings`, through `IntegrationActionExecutor`
-- (`selfIdentity`) — and stored here; the read joins it with `user_identities` and nothing else, so a
-- mapping added later shows at the next read without a provider call.
--
-- `{provider, external_id}` only: the stable handle the mapping is keyed by, never the display name
-- or the email (provider text the note does not need). `null` is **unknown** — a binding that is not
-- task management, a save whose `selfIdentity` failed (the read never blocks the save), and every row
-- written before this migration until it is saved again — and an unknown account earns no note.
--
-- One writer, `replaceProjectBindings` (the bindings write, which sets it on every row it inserts or
-- updates); one reader, `findBindingAccountIsAPerson`. No backfill: an existing binding names its
-- account at its next save.
alter table bindings add column account_identity jsonb;
alter table bindings add constraint bindings_account_identity_object
  check (account_identity is null or jsonb_typeof(account_identity) = 'object');
