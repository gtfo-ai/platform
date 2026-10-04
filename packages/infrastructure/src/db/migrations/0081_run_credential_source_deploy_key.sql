-- 0081 — `runs.credential_source` gains `deploy_key` (WP-146, TD-028 decision 13b item 7).
--
-- A run of an integration that declares `run_credential: deploy_key` is given the project's SSH
-- deploy key — held by the runner, never in the run container — and, like a static run token, no
-- provider call is made, so no `mint_credential` audit row names it. *Which credential a run had*
-- stays answerable from the run: `deploy_key`, with `credential_integration_id` the integration whose
-- key it was. The one writer is unchanged (`recordCredentialSource`, `apps/server/src/workspaces.ts`).
--
-- 0078's check constraint carries PostgreSQL's default name for a column constraint
-- (`<table>_<column>_check`), which is what is dropped here; a constraint is replaced, not edited.
alter table runs drop constraint runs_credential_source_check;
alter table runs add constraint runs_credential_source_check
  check (credential_source in ('minted', 'static', 'deploy_key', 'none'));
