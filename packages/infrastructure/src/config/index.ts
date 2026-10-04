/**
 * The repository layer of the effective configuration (WP-63): the YAML codec for
 * `.agentic/config.yml` and the table the last reading of it is kept in. The reader of the file
 * itself is `knowledge/git-vault.ts`'s `createGitRepositoryFileSource`, beside the mirror it shares.
 */

export * from './ci-yaml-parser.js';
export * from './postgres-repository-config-store.js';
export * from './yaml-codec.js';
