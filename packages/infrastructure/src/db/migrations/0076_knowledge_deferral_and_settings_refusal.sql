-- 0076 — knowledge proposals lost to a settings refusal, or colliding on one path (WP-125, PROGRESS
-- backlog 356 and 369).
--
-- ## `knowledge_curations.settings_refused_at`: a refusal is not a lost wake-up (backlog 356)
--
-- A curation the project's stored settings refused (`ProjectSettingsInvalidError`, WP-106) wrote no
-- row, so the recovery pass treated it as a lost wake-up: one re-offer under
-- `recovery_attempted_at`, and then `abandoned_at` — the task's proposals gone if the document was
-- not fixed inside one recovery interval. A refusal is a different fact: the job **ran** and was told
-- no. So the curation now records it here, in its own transaction, and in the same statement clears
-- `recovery_attempted_at`: the refusal does not spend the recovery's one attempt, and the pass
-- re-offers the artifact at its interval until the document parses (the ruling in WP-125's row). The
-- column is also what `GET …/config`'s `409 invalid_stored_config` counts, so the refusal an
-- operator reads names how many curations wait on the document.
alter table knowledge_curations add column settings_refused_at timestamptz;

-- The count `GET …/config` makes on every read: the rows waiting on a refused document. Tiny by
-- construction (only refused, uncurated, unabandoned rows), so the read is a scan of the index.
create index knowledge_curations_settings_refused_idx on knowledge_curations (artifact_id)
  where settings_refused_at is not null and curated_at is null and abandoned_at is null;

-- ## `kb_proposals.applied_merge_request`: which merge request carries which path (backlog 369)
--
-- Measured first (WP-125 criterion 1): the store recorded the **commit** an apply made
-- (`applied_commit_sha`) and nothing about the merge request that carries it, so "is the page this
-- proposal would `create` already on an open knowledge merge request?" had no answer in the database.
-- The merge-request reference the provider answered `openMergeRequest` with is stored here on every
-- proposal the batch carried. It is provider output (BD-022), so a reader parses it with
-- `mergeRequestRefSchema` and treats a row that does not parse as carrying no merge request.
alter table kb_proposals add column applied_merge_request jsonb;

-- ## `kb_proposals.apply_deferred_reason`: an approved proposal that waits for a merge (backlog 369)
--
-- Platform text naming the open knowledge merge request a proposal waits behind. The proposal stays
-- approved — `queued` with a decision, or `auto_applied` — and is applied as an `update` once that
-- merge request merges; it is never stacked onto the other branch. Cleared when a commit carries the
-- proposal, so a reason is only ever a claim about a proposal that has not been applied.
alter table kb_proposals add column apply_deferred_reason text;

alter table kb_proposals
  add constraint kb_proposals_deferral_is_unapplied
  check (apply_deferred_reason is null or applied_commit_sha is null);
