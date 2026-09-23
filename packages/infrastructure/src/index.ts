/**
 * Adapters: Postgres, jobs, broadcast, Claude SDK runner, workspaces, search.
 *
 * WP-03 added the PostgreSQL persistence layer; WP-04 added the event store, the dispatch queue and
 * the `Broadcast` adapter on `LISTEN`/`NOTIFY`; WP-05 added the jobs runtime on pg-boss; WP-12 added
 * the Claude Agent SDK runner, its two fakes and TD-012's pattern redactor. WP-14 added the
 * launcher's `WorkspaceProvider` adapters — the Docker one, the fake the unit tier runs against,
 * and the pure policy modules they share (`workspace/`). WP-15 added the pipeline's `PipelineStore`
 * on the tables of technical/03. WP-15b added the PostgreSQL
 * `IntegrationAuditLog` and `IdempotencyStore` (`integrations/`), which is what lets a composition
 * root start the pipeline without a caller supplying an audit sink. WP-16 added the knowledge base's adapters (`knowledge/`): the
 * `kb_*` index and the `code_files`/`code_maps` caches on PostgreSQL, the filesystem vault reader,
 * and the universal-ctags symbol extractor. WP-19 added the cost ledger's `CostStore` and the
 * price-table maintenance job (`cost/`). WP-32 added the notification outbox's `NotificationStore`
 * (`notify/`), which is what lets quiet hours defer a message rather than drop it. WP-29 added the
 * human-time projection's `HumanTimeStore` (`human-time/`), the first and only writer of a table
 * that has had a schema since migration 0007. WP-34 added shadow mode's `ShadowStore`
 * (`shadow/`) — the batch tables of migration 0029, and the first writer of `shadow_reports`, which
 * has had a schema since migration 0008. WP-36 added the maintenance scheduler's three reads
 * (`maintenance/`), which write nothing and need no table: a scheduled chore's own task row is the
 * record that its period has been served. Later work packages add the rest.
 */
export * as ask from './ask/index.js';
export * as bootstrap from './bootstrap/index.js';
export * as broadcast from './broadcast/index.js';
export * as cost from './cost/index.js';
export * as db from './db/index.js';
export * as dependencies from './dependencies/index.js';
export * as eventing from './events/index.js';
export * as humanTime from './human-time/index.js';
export * as integrations from './integrations/index.js';
export * as jobs from './jobs/index.js';
export * as knowledge from './knowledge/index.js';
export * as launcher from './launcher/index.js';
export * as maintenance from './maintenance/index.js';
export * as notify from './notify/index.js';
export * as pipeline from './pipeline/index.js';
export * as recovery from './recovery/index.js';
export * as redaction from './redaction/index.js';
export * as runlet from './runlet/index.js';
export * as runner from './runner/index.js';
export * as secrets from './secrets/index.js';
export * as shadow from './shadow/index.js';
export * as stats from './stats/index.js';
export * as workspace from './workspace/index.js';

export const packageId = '@platform/infrastructure' as const;
