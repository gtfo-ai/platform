/**
 * Adapters: Postgres, jobs, broadcast, Claude SDK runner, workspaces, search.
 *
 * Only the PostgreSQL persistence layer exists so far (WP-03); later work packages add the rest.
 */
export * as db from './db/index.js';

export const packageId = '@platform/infrastructure' as const;
