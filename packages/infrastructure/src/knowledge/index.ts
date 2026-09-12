/**
 * The knowledge-base adapters: the PostgreSQL index and code-map caches, the two vault readers and
 * the universal-ctags symbol extractor.
 *
 * WP-16 shipped all but one of them; WP-18a added `git-vault.ts`, the `VaultSource` over the
 * platform's own bare mirror that TD-026 rules the indexer reads (the filesystem one needs a
 * checkout, and this process has none).
 */
export * from './ctags.js';
export * from './filesystem-vault.js';
export * from './git-vault.js';
export * from './postgres-code-map-store.js';
export * from './postgres-knowledge-store.js';
