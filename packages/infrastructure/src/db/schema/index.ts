/**
 * The Drizzle description of the schema created by `../migrations/*.sql` (TD-011).
 *
 * The SQL is authoritative — partitions, generated columns, GIN indexes and `REVOKE` statements
 * have no Drizzle equivalent, so nothing here generates DDL. What these definitions buy is typed
 * queries; `test/integration/db/schema-parity.integration.test.ts` compares every column declared
 * here against the migrated database so the two cannot drift apart unnoticed.
 */
export * from './columns.js';
export * from './cost.js';
export * from './enums.js';
export * from './events.js';
export * from './identity.js';
export * from './knowledge.js';
export * from './pipeline.js';
export * from './platform.js';
export * from './transcripts.js';
