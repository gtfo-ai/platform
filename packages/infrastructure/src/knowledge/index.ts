/**
 * The knowledge-base adapters (WP-16): the PostgreSQL index and code-map caches, the filesystem
 * vault reader, and the universal-ctags symbol extractor.
 */
export * from './ctags.js';
export * from './filesystem-vault.js';
export * from './postgres-code-map-store.js';
export * from './postgres-knowledge-store.js';
