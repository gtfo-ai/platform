/**
 * The PostgreSQL adapters of the integration ports the `IntegrationActionExecutor` stands on
 * (WP-15b): BD-003's append-only outbound audit and product/08's idempotency store.
 *
 * Deliberately *not* `@platform/integrations`: that package holds provider adapters (Jira, GitLab,
 * Slack, Sentry, Loki) and their fakes, while these two are platform storage and belong beside the
 * event store they commit with.
 */
export * from './postgres-audit-log.js';
export * from './postgres-idempotency-store.js';
