/**
 * The notification band's PostgreSQL adapter (WP-32).
 *
 * One store, over the `notifications` table of migration 0023: the outbox that makes quiet hours
 * defer rather than drop.
 */
export * from './postgres-notification-store.js';
