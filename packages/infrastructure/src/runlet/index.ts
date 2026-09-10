/**
 * `agentic-runlet` (TD-025): the run shim, its codec, and the runner-side `SpawnedProcess`.
 *
 * Both ends of one Unix socket live here so the frame protocol has exactly one implementation of
 * each half. The shim's *entrypoint* is `apps/runlet`, which is a composition root and nothing
 * else — WP-22 bundles that entry into the `platform-runtime` image, so the container carries the
 * shim rather than the platform.
 */
export * from './config.js';
export * from './connection.js';
export * from './credential-helper.js';
export * from './framing.js';
export * from './logger.js';
export * from './shim.js';
export * from './spawn-adapter.js';
export * from './testing.js';
export * from './token.js';
