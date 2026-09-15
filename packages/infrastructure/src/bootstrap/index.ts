/**
 * The history bootstrap's store (WP-35): `history_bootstrap_batches` and
 * `history_bootstrap_chunks` (migration 0030).
 *
 * Its own directory rather than a file under `pipeline/` for `shadow/`'s reason: a batch is not part
 * of a task's state — it is what an operator started on one day, and a chunk is one mining run of it.
 */
export * from './postgres-history-bootstrap-store.js';
