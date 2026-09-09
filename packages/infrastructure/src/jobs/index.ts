/**
 * Jobs, timers, cron and coalesced wake-ups (TD-004).
 *
 * Two implementations of the application ring's `Jobs` port: pg-boss for production, and an
 * in-memory fake with a virtual clock for tests that must not need a database. They are held to
 * each other by `test/contract/support/jobs-contract-suite.ts`.
 */
export * from './config.js';
export * from './in-memory-jobs.js';
export * from './maintenance.js';
export * from './pg-boss-jobs.js';
