/**
 * PostgreSQL persistence (technical/03, TD-006, TD-011, TD-019).
 *
 * `schema` is re-exported as a namespace rather than flattened, so `db.schema.tasks` reads as a
 * table and nothing collides with the runtime helpers.
 */
export * from './client.js';
export * from './config.js';
export * from './migrations.js';
export * from './migrator.js';
export * from './partitions.js';
export * as schema from './schema/index.js';
