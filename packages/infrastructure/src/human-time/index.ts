/**
 * The human-time projection's PostgreSQL adapter (WP-29).
 *
 * `createPostgresHumanTimeStore` is the `HumanTimeStore` the projector writes `human_time_entries`
 * through — and the only thing in this repository that writes that table.
 */
export * from './postgres-human-time-store.js';
