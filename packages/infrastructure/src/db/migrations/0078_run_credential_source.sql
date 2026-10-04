-- 0078 — which credential a run had (WP-137, TD-028 decision 13 item 2).
--
-- A run's git credential is **minted** through `IntegrationActionExecutor` (a `mint_credential`
-- audit row names it) or — since the founder's answer to Q98 (b) — handed from an integration's
-- declared **static** run token, which makes no provider call and therefore writes no audit row. So
-- *which credential a run had* must be answerable from the run itself: `credential_source` is
-- `minted`, `static` or `none` (no credential: a run with no checkout is never asked, a read-only run
-- with nothing to give fetches anonymously, a refused one is refused), and `credential_integration_id`
-- the git integration it came from (or whose static credential was refused).
--
-- **One writer**, `recordCredentialSource` (`apps/server/src/workspaces.ts`), a narrow write of these
-- two columns from the runner's provision, before the create; `null` is *"never asked"* — every run
-- before this migration, every run with no checkout, and every run a process without a launcher
-- created. No foreign key on the integration: an integration is retired, never deleted, and the
-- column is evidence rather than a join.
alter table runs add column credential_source text
  check (credential_source in ('minted', 'static', 'none'));
alter table runs add column credential_integration_id uuid;
