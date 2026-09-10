/**
 * `@platform/integrations` — the adapter ring for the five integration types (BD-017,
 * technical/06).
 *
 * The *ports* live in `@platform/application`, because the pipeline, the UI and the knowledge base
 * depend on them and may not depend on an adapter (technical/01). This package holds what
 * implements them: the in-memory fakes that WP-07 ships, the provider registry, and — from WP-08
 * onwards — Jira, GitLab, Slack, Sentry and Loki under `providers/`.
 *
 * The fakes are not test scaffolding. technical/10 makes them first-class code: they are the unit
 * tier's ground truth for every later work package and they power the fake-Claude e2e pipeline.
 * They are *not* shadow mode: that is a guard inside `IntegrationActionExecutor` (technical/06 §
 * "Outbound: actions"), so no product path ever swaps an adapter for a fake. Each one carries a
 * **divergence register** in its own docblock, under one rule — *a fake may be stricter than the
 * real adapter, never kinder* — with every entry marked `stricter`, `kinder` or `different`,
 * because a reader who takes "stricter" on faith will not re-check.
 *
 * The reusable contract suites that hold a provider to its port live in
 * `test/contract/support/integrations/`; WP-08…WP-11 run the same suites against their adapters in
 * nock replay mode (technical/10).
 */
export * from './communication/fake.js';
export * from './errors/fake.js';
export * from './git/fake.js';
export * from './logs/fake.js';
// Providers (BD-017): a type port implementation, its registration and its setup guide.
export * from './providers/gitlab/index.js';
export * from './providers/jira-cloud/index.js';
export * from './providers/jira-cloud/registration.js';
export * from './providers/slack/index.js';
export * from './registry.js';
export * from './support/fake-support.js';
export * from './support/system-timer.js';
export * from './task-management/fake.js';

export const packageId = '@platform/integrations' as const;
