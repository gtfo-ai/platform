/**
 * `@platform/server` — the Fastify composition root (technical/01, TD-002).
 *
 * The process entrypoint is `main.ts`; this index publishes what a test harness, `pnpm dev` and
 * later work packages need to build or drive an instance without going through a process.
 */
export { type BuildAppOptions, buildApp } from './app.js';
export {
  type Auth,
  authOptions,
  createAuth,
  type PendingAuthSchema,
  pendingAuthSchema,
  sessionCookieName,
} from './auth/better-auth.js';
export { type BootstrapOutcome, bootstrapAdministrator } from './auth/bootstrap.js';
export { authPlugin, CSRF_HEADER, CSRF_HEADER_VALUE, csrfViolation } from './auth/plugin.js';
export { type Actor, effectiveRole, requirePermission } from './auth/rbac.js';
export {
  argon2ConfigSchema,
  loadServerConfig,
  POOL_RESERVATIONS,
  requiredPoolConnections,
  SERVER_CONFIG_DEFAULTS,
  type ServerConfig,
  serverConfigSchema,
  UndersizedPoolError,
} from './config.js';
export * from './errors.js';
export { asLoggerPort, createLogger, REDACTED_PATHS, withLogContext } from './logging.js';
export { createMetrics, type Metrics, routeLabel } from './metrics.js';
export {
  type ComposedPipeline,
  composePipeline,
  createProjectSettingsPort,
  type PipelineComposition,
  repositoryPathOf,
} from './pipeline.js';
export { createReadinessCheck, migrationStatus } from './readiness.js';
export { isRole, ROLES, type Role, roleCapabilities, roleIsIdle } from './role.js';
export { type ServerRuntime, type StartRuntimeOptions, startRuntime } from './runtime.js';
export {
  ConnectionIdInUseError,
  frameEventName,
  frameId,
  parseCursor,
  parseCursors,
  ShuttingDownError,
  SseHub,
  type SseTransport,
  TooManyConnectionsError,
  UnknownConnectionError,
} from './sse/hub.js';
export { parseTopics } from './sse/routes.js';

export const packageId = '@platform/server' as const;
