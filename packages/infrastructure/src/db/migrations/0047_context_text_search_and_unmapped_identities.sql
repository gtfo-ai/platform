-- 0047 — the context pack records what its text step did (WP-44, PROGRESS backlog 172, Q58 (a)),
-- and a refused inbound delivery records which account it was refused for (backlog 198).
--
-- WP-57 gave the pack a record the run row can hold (0041) and WP-58 gave the text step a floor
-- that can drop every keyword a query has (0042). Since then a run whose pack has no text-matched
-- tier-1 document stood for five different facts — no index, no keywords, every keyword dropped by
-- the floor, keywords that matched nothing, and the last with no statistics to drop anything by —
-- and `run_context_pack` could say none of them: the answer lived in a `debug` log line. BD-003's
-- audit of what an agent was shown could not explain its own emptiness.
--
-- **One `jsonb` column on the run, beside the pack's header**, because it is one value per run,
-- written by the statement that creates the run (`RunRepository.insert`) and read back only whole —
-- by `GET /api/runs/:run_id/context-pack`, which publishes it as `ContextPackRecord.text_search`
-- (`packages/contracts/src/records.ts`, whose docblock has the table of outcomes). Columns per field
-- would be a second spelling of that schema to drift.
--
-- **Nullable, no default, never backfilled**: a run written before this migration recorded no text
-- step, and "not recorded" is a different fact from any of the five outcomes (standing rule 18).
-- The pack's header is what says a pack was recorded at all, so an outcome with no header is a row
-- nothing could have written and the check refuses it.
--
-- The terms it holds are words of the task text that have passed the run's redactor
-- (`redactTextSearchTerms`): a term the redactor would change is left out and counted, never stored.
alter table runs add column context_text_search jsonb;

alter table runs
  add constraint runs_context_text_search_needs_a_pack
  check (context_text_search is null or context_budget_tokens is not null);

-- ## `inbox.unmapped_identities` — which account a refused delivery was refused for (PROGRESS
-- backlog 198)
--
-- A chat click from an account nobody mapped is recorded as `unmapped_identity` in `inbox.error`,
-- a redacted sentence, and nowhere structurally — so the Provider identities screen (WP-43) asked
-- an operator for an external id they had no way to find short of SQL. The ingress now stores the
-- refused accounts as a list of `{provider, external_id}` beside the error, redacted (an id the
-- binding's redactor would change is left out), and the identities screen offers them as
-- candidates to map — proposing, never writing.
--
-- **Nullable, no default**: a row written before this migration recorded no list, and "not
-- recorded" is not "no account was refused" (standing rule 18). The same migration as the text
-- step's record because both are WP-44's and a row owns one migration number.
alter table inbox add column unmapped_identities jsonb;

-- The two reads over it (`listRefusedDeliveries` per integration, `listIdentityCandidates` across
-- them) are bounded to the newest rows and would otherwise scan `inbox`, which nothing ever purges.
-- Partial, because a delivery that produced its events has no error and names no account, and that
-- is almost every row.
create index inbox_refused_idx on inbox (integration_id, received_at desc) where error is not null;
create index inbox_unmapped_idx on inbox (received_at desc) where unmapped_identities is not null;
