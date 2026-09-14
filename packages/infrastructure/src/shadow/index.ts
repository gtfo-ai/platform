/**
 * Shadow mode's store (WP-34): `shadow_batches`, `shadow_batch_tickets` and `shadow_reports`.
 *
 * Its own directory rather than a file under `pipeline/` because the batch is not part of a task's
 * state — it is a set somebody selected on one day, and the report is what the platform computed
 * about it afterwards.
 */
export * from './postgres-shadow-store.js';
