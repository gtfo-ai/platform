/**
 * Optional error reporting (TD-023's 2026-11-05 amendment, WP-295): the DSN rule, the event's
 * allow-list and redaction, and the swappable reporter. The SDK client is built in `apps/server`,
 * the one package `@sentry/node` is a dependency of.
 */
export * from './reporter.js';
