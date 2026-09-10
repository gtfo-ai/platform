/**
 * The launcher's `WorkspaceProvider` implementations (TD-021, technical/05).
 *
 * `DockerWorkspaceProvider` is the real one and `FakeWorkspaceProvider` is what the unit tier and
 * WP-15's pipeline e2e run against; one shared contract suite runs against both
 * (`test/contract/support/workspace/provider-suite.ts`). The pure parts — the hardening flags, the
 * egress allow-list, the retention policy, the tar filter and the object names — are separate
 * modules so they can be asserted without a daemon, and asserted again against what the daemon
 * recorded.
 */
export * from './broker.js';
export * from './egress.js';
export * from './engine.js';
export * from './fake.js';
export * from './fixtures.js';
export * from './hardening.js';
export * from './names.js';
export * from './provider.js';
export * from './retention.js';
export * from './tar.js';
export * from './testing.js';
