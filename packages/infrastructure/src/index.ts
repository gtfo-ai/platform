/**
 * Adapters: Postgres, jobs, broadcast, Claude SDK runner, workspaces, search.
 *
 * The PostgreSQL persistence layer (WP-03) and the jobs runtime (WP-05) exist so far; later work
 * packages add the rest.
 */
export * as db from './db/index.js';
export * as jobs from './jobs/index.js';

export const packageId = '@platform/infrastructure' as const;
