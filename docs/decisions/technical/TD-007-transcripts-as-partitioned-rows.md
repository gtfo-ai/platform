# TD-007 — Transcripts stored as one row per SDK message in monthly-partitioned `run_messages`; partial deltas not persisted individually

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/07, technical/03, technical/04, BD-003

## Decision
The platform's own stream consumer (not the SDK `sessionStore` mirror) writes every completed SDK message as a row `(run_id, seq)` after redaction; one coalesced `stream_block` row per content block records streaming timing; payloads > 1 MB go to `blobs`. Live tailing = range scan + `NOTIFY run_<id>` with `{seq}`. The SDK `sessionStore` is additionally used for cross-host resume (best-effort mirror).

## Rationale
Row-per-message gives cheap tail/replay, transactional consistency with run metadata, FTS on a compact `search_text`, and purge by dropping partitions; one JSONB document per run would rewrite TOAST on every append.

## Consequences
- Partitioning from day 1; storage gauge on the dashboard.
- Golden-fixture tests for the normaliser because SDK message types evolve.
