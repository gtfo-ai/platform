-- 0052 — the mining run's own coverage claim, stored beside the platform's count (WP-66, PROGRESS
-- backlog 102).
--
-- The historian's `HistoryFindings` artifact carries `merge_requests_read` — how many of the
-- chunk's merge requests the run says it worked through — and until this migration the claim's
-- whole lifetime was one log line in the recorder. The platform's half of the pair,
-- `history_bootstrap_chunks.merge_requests`, was already a stored column beside four other counters
-- of its kind, so a run that stopped after three of twenty produced a `recorded` chunk and a batch
-- screen identical to one that read all twenty. This is the sixth counter.
--
-- **Nullable, with no default and no backfill.** `null` is *no report* — a run that has not
-- recorded its findings, or one recorded before this column existed — and it is not *read
-- nothing*, which is `0` (standing rule 18). A backfill would have to invent the claim.
--
-- **One writer**: `markChunkRecorded`, in the same `set` as `recorded_at`, `proposals` and
-- `refused_proposals` (standing rule 79). It stays the **model's** claim — no alert, no refusal —
-- but it is stored **bounded by what the run was shown**: the artifact schema admits any
-- non-negative safe integer, so a model that claims more than it was given (anything up to
-- 2^53 - 1, most of which would overflow `integer`) is written as `min(claim, merge_requests)`
-- by the recorder, which logs the raw figure. `history_bootstrap_chunks_read_within_shown` is the database's half of that bound,
-- so a second writer that forgot it is refused rather than published.
--
-- **`history_bootstrap_chunks_counts_need_a_report` is re-declared under the same name** to take the
-- new column: a claim about what a run read is a claim about a run that reported, exactly as its
-- proposal counts are. Every existing row satisfies the wider check (the column is null on all of
-- them), so the re-validation cannot fail an upgrade.

alter table history_bootstrap_chunks add column merge_requests_read integer;

alter table history_bootstrap_chunks
  add constraint history_bootstrap_chunks_read_within_shown
  check (merge_requests_read is null
         or (merge_requests_read >= 0 and merge_requests_read <= merge_requests));

alter table history_bootstrap_chunks
  drop constraint history_bootstrap_chunks_counts_need_a_report;
alter table history_bootstrap_chunks
  add constraint history_bootstrap_chunks_counts_need_a_report
  check (recorded_at is not null
         or (proposals = 0 and refused_proposals = 0 and merge_requests_read is null));
