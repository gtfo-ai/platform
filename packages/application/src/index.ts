/**
 * `@platform/application` — use cases, event handlers, sagas and ports.
 *
 * The second ring of technical/01: it may name `@platform/domain` and `@platform/contracts` and
 * nothing else (enforced by `lint/style/noRestrictedImports` in `biome.json`). Everything that
 * touches the outside world arrives as a **port** — an interface this ring defines and
 * `packages/infrastructure` implements — so the pipeline can be exercised with fakes and the
 * adapters can be swapped without a single change here.
 *
 * What WP-04 put in it: the event store and dispatch-queue ports (TD-005), the priority dispatcher
 * (`EventBus`), the outbox worker, the `Broadcast` port (TD-014) and the in-memory doubles the
 * property tests run against. WP-05 added the `Jobs` port (TD-004) and the working-day calendar.
 * WP-07 added the five integration **type ports** (BD-017, technical/06) — the interfaces the
 * pipeline, the UI and the knowledge base depend on instead of on Jira, GitLab, Slack, Sentry or
 * Loki — together with the `IntegrationActionExecutor` that every outbound call goes through, and
 * the `SecretRedactor` port (TD-012) that its audit path defines. WP-12 added the `ClaudeRunner`
 * port and its collaborators (technical/04), which consume that same redactor. WP-14 added the
 * `WorkspaceProvider` port (TD-021), which the pipeline asks for an isolated workspace per run.
 * WP-16 added the knowledge ports (`VaultSource`, `KnowledgeStore`, `SymbolExtractor`,
 * `CodeMapStore`), the indexer, the context-pack assembler, the `kb_search` tool and the code
 * mapper — technical/07, TD-008, TD-010.
 */

// Event dispatch (TD-005)
export * from './errors.js';
export * from './events/consumption.js';
export * from './events/event-bus.js';
export * from './events/handler.js';
export * from './events/open-transaction.js';
export * from './events/outbox.js';
// Outbound integration actions (technical/06, WP-07)
export * from './integrations/action-executor.js';
export * from './integrations/inbound.js';
export * from './integrations/rate-limiter.js';
export * from './integrations/redaction.js';
// The knowledge base (WP-16): indexer, context packs, `kb_search`, code map
export * from './knowledge/code-mapper.js';
export * from './knowledge/context-pack.js';
export * from './knowledge/indexer.js';
export * from './knowledge/kb-search.js';
export * from './knowledge/ports.js';
// The pipeline (WP-15): interpreter-driven sagas, the stage executor and their ports
export * from './pipeline/commands.js';
export * from './pipeline/gates.js';
export * from './pipeline/intake-reconcile.js';
export * from './pipeline/integrations.js';
export * from './pipeline/jobs.js';
export * from './pipeline/outbound.js';
export * from './pipeline/planner.js';
export * from './pipeline/runtime.js';
export * from './pipeline/saga.js';
export * from './pipeline/settings.js';
export * from './pipeline/stage-executor.js';
export * from './pipeline/stop-reasons.js';
export * from './pipeline/store.js';
export * from './pipeline/transitions.js';
export * from './pipeline/verdicts.js';
export * from './pipeline/workpad.js';
// Ports
export * from './ports/broadcast.js';
export * from './ports/dispatch-queue.js';
export * from './ports/event-store.js';
export * from './ports/handler-executions.js';
// Integration type ports (technical/06, BD-017)
export * from './ports/integrations/audit.js';
export * from './ports/integrations/bindings.js';
export * from './ports/integrations/common.js';
export * from './ports/integrations/communication.js';
export * from './ports/integrations/git-provider.js';
export * from './ports/integrations/inbox.js';
export * from './ports/integrations/observability-errors.js';
export * from './ports/integrations/observability-logs.js';
export * from './ports/integrations/task-management.js';
export * from './ports/jobs.js';
export * from './ports/logger.js';
export * from './ports/runner.js';
export * from './ports/secrets.js';
export * from './ports/transaction.js';
export * from './ports/unit-of-work.js';
export * from './ports/workspace.js';
// Scheduling (WP-05)
export * from './scheduling/working-calendar.js';
export * from './scheduling/zoned-time.js';
// Test doubles (technical/10: fakes are first-class code)
export * from './testing/fixture-vault.js';
export * from './testing/fixtures.js';
export * from './testing/memory-eventing.js';
export * from './testing/memory-integrations.js';
export * from './testing/memory-knowledge.js';
export * from './testing/memory-pipeline.js';

export const packageId = '@platform/application' as const;
