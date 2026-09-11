/**
 * The PostgreSQL adapters of the integration ports the `IntegrationActionExecutor` stands on
 * (WP-15b, WP-15c): BD-003's append-only outbound audit, product/08's idempotency store, and the
 * three the webhook ingress stands on — `inbox`, the inbound audit row and the identity directory.
 *
 * Deliberately *not* `@platform/integrations`: that package holds provider adapters (Jira, GitLab,
 * Slack, Sentry, Loki) and their fakes, while these are platform storage and belong beside the
 * event store they commit with.
 */
export * from './postgres-audit-log.js';
export * from './postgres-idempotency-store.js';
export * from './postgres-inbox.js';
