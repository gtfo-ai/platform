/**
 * Adapters: Postgres, jobs, broadcast, Claude SDK runner, workspaces, search.
 *
 * WP-03 added the PostgreSQL persistence layer; WP-04 added the event store, the dispatch queue and
 * the `Broadcast` adapter on `LISTEN`/`NOTIFY`; WP-05 added the jobs runtime on pg-boss; WP-12 added
 * the Claude Agent SDK runner, its two fakes and TD-012's pattern redactor. WP-14 added the
 * launcher's `WorkspaceProvider` adapters — the Docker one, the fake the unit tier runs against,
 * and the pure policy modules they share (`workspace/`). WP-15 added the pipeline's `PipelineStore`
 * on the tables of technical/03. WP-16 added the knowledge base's adapters (`knowledge/`): the
 * `kb_*` index and the `code_files`/`code_maps` caches on PostgreSQL, the filesystem vault reader,
 * and the universal-ctags symbol extractor. Later work packages add the rest.
 */
export * as broadcast from './broadcast/index.js';
export * as db from './db/index.js';
export * as eventing from './events/index.js';
export * as jobs from './jobs/index.js';
export * as knowledge from './knowledge/index.js';
export * as pipeline from './pipeline/index.js';
export * as redaction from './redaction/index.js';
export * as runlet from './runlet/index.js';
export * as runner from './runner/index.js';
export * as secrets from './secrets/index.js';
export * as workspace from './workspace/index.js';

export const packageId = '@platform/infrastructure' as const;
