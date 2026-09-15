/**
 * The statistics projections' PostgreSQL adapter (WP-41).
 *
 * `createPostgresStatsStore` is the `StatsStore` the projector writes `stats_task_delivery` and
 * `stats_event_daily` through — and the only thing in this repository that writes either.
 */
export * from './postgres-stats-store.js';
