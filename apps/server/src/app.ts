/**
 * The Fastify application (TD-002).
 *
 * `buildApp` returns a configured, not-yet-listening instance, which is what makes the whole HTTP
 * surface testable with `app.inject()` and what lets `runtime.ts` decide when to listen. It takes
 * every collaborator as an argument — pool, auth, hub, metrics, logger — because a composition
 * root that reaches for a module-level singleton cannot be instantiated twice, and the e2e tier
 * does exactly that.
 *
 * ### The plugin order is not arbitrary
 * 1. zod validator/serializer compilers, before any route is declared.
 * 2. `@fastify/swagger`, before the routes it documents — it collects them as they register.
 * 3. `@fastify/under-pressure`, so `/healthz` can ask it.
 * 4. `@fastify/sse`, before `/events` declares `sse: true`.
 * 5. the auth plugin, whose `onRequest` hooks must run before any route's `preHandler`.
 * 6. routes.
 *
 * ### Compression is deliberately absent
 * TD-002 notes that `@fastify/compress` "must exclude `text/event-stream`" — a compressed SSE
 * stream buffers until the compressor flushes, which turns a live stream into a stalled one. The
 * simplest way to honour that is not to register the plugin at all until something needs it; when
 * WP-20 does, the exclusion is the first thing to configure.
 */
import fastifySse from '@fastify/sse';
import fastifySwagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import type { WebhookIngress } from '@platform/application';
import { type FastifyBaseLogger, type FastifyInstance, fastify, LogController } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Auth } from './auth/better-auth.js';
import { authPlugin } from './auth/plugin.js';
import type { ServerConfig } from './config.js';
import { toApiError } from './errors.js';
import { type PinoLogger, withLogContext } from './logging.js';
import type { Metrics } from './metrics.js';
import { routeLabel } from './metrics.js';
import type { Database } from './queries/identity-queries.js';
import {
  findProjectRole,
  findRunProjectId,
  findTaskProjectId,
  projectExists,
} from './queries/identity-queries.js';
import { roleCapabilities } from './role.js';
import { type ReadinessReport, registerOpsRoutes } from './routes/ops.js';
import { registerOrgRoutes } from './routes/org.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import type { SseHub } from './sse/hub.js';
import { registerSseRoutes } from './sse/routes.js';

export interface BuildAppOptions {
  readonly config: ServerConfig;
  readonly logger: PinoLogger;
  readonly metrics: Metrics;
  readonly database: Database;
  readonly auth: Auth;
  readonly hub: SseHub;
  readonly version: {
    readonly version: string;
    readonly commit: string | null;
    readonly builtAt: string | null;
  };
  readonly readiness: () => Promise<ReadinessReport>;
  readonly isShuttingDown: () => boolean;
  /**
   * The webhook ingress, or `null` for a process that composes none (WP-15c).
   *
   * `null` is **not** a seam a production path takes: `startRuntime` builds one whenever the role
   * serves the API. It exists because `buildApp` is also driven directly by `app.test.ts`, which
   * has no database behind it — and a route that answered 404 because nobody composed an ingress
   * would be indistinguishable, to an operator pasting a URL into GitLab, from a wrong URL. So the
   * route is **absent** when the ingress is, and `runtime.ts` logs which.
   */
  readonly webhooks: WebhookIngress | null;
}

/** Event-loop delay above which the process reports itself degraded rather than healthy. */
const MAX_EVENT_LOOP_DELAY_MS = 1_000;
const MAX_EVENT_LOOP_UTILIZATION = 0.98;

export const buildApp = async (options: BuildAppOptions): Promise<FastifyInstance> => {
  const { config } = options;
  const capabilities = roleCapabilities(config.role);

  const app = fastify({
    // Widened to Fastify's own logger interface on purpose: typing the instance with pino's
    // concrete `Logger` would make every `FastifyInstance` in this package a different type from
    // the default one every plugin and route module is written against.
    loggerInstance: options.logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    bodyLimit: config.bodyLimitBytes,
    // Fastify's own request id, reused as the correlation id in every log line (TD-023).
    genReqId: () => crypto.randomUUID(),
    requestIdHeader: 'x-request-id',
    // Fastify's own per-request logging is off: this application emits one structured line per
    // response from its own `onResponse` hook, with the route pattern, the effective role and the
    // duration in it. Two lines per request saying different halves of the same thing is what a
    // log aggregator charges for.
    logController: new LogController({
      disableRequestLogging: true,
      // One name for the correlation id everywhere: Fastify's child logger, the AsyncLocalStorage
      // mixin of TD-023 and the `X-Request-Id` header all say `request_id`.
      requestIdLogLabel: 'request_id',
    }),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Agentic platform API',
        description:
          'REST + SSE on one origin (technical/08). Generated from the zod route schemas; the SPA client is generated from this document.',
        version: options.version.version,
      },
      servers: [{ url: config.baseUrl }],
      tags: [
        { name: 'ops', description: 'Health, metrics and build metadata' },
        { name: 'org', description: 'Organisation-scoped reads' },
        { name: 'projects', description: 'Project-scoped reads' },
        { name: 'tasks', description: 'Task-scoped reads' },
        { name: 'runs', description: 'Runs, their transcripts and their inputs' },
        { name: 'events', description: 'Real-time stream (TD-014)' },
        { name: 'webhooks', description: 'Inbound provider deliveries (technical/06)' },
      ],
    },
    transform: jsonSchemaTransform,
  });

  await app.register(underPressure, {
    maxEventLoopDelay: MAX_EVENT_LOOP_DELAY_MS,
    maxEventLoopUtilization: MAX_EVENT_LOOP_UTILIZATION,
    // No status route and no automatic 503: `/healthz` asks `isUnderPressure()` itself, so a
    // momentarily busy process reports `degraded` instead of failing every request in flight —
    // including the SSE streams, which are long-lived and must not be dropped by a spike.
    exposeStatusRoute: false,
    retryAfter: 5,
    pressureHandler: undefined,
  });

  /**
   * One log line and one histogram observation per request, with the request id in scope for
   * everything the handler logs (TD-023's `AsyncLocalStorage` mixin).
   */
  app.addHook('onRequest', async (request) => {
    request.startedAt = process.hrtime.bigint();
  });
  app.addHook('preHandler', (request, _reply, done) => {
    withLogContext(
      {
        request_id: request.id,
        ...(request.actor === undefined ? {} : { user_id: request.actor.userId }),
      },
      done,
    );
  });
  app.addHook('onResponse', async (request, reply) => {
    const route = routeLabel(request.routeOptions.url);
    const seconds =
      request.startedAt === undefined
        ? 0
        : Number(process.hrtime.bigint() - request.startedAt) / 1e9;
    options.metrics.httpRequestDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      seconds,
    );
    request.log.info(
      {
        method: request.method,
        route,
        status_code: reply.statusCode,
        duration_ms: Math.round(seconds * 1000),
        ...(request.actor === undefined ? {} : { user_id: request.actor.userId }),
        ...(request.effectiveRole === undefined ? {} : { effective_role: request.effectiveRole }),
      },
      'request completed',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toApiError(error, String(request.id));
    if (mapped.unexpected) {
      request.log.error(
        { err: error, route: routeLabel(request.routeOptions.url) },
        'request failed',
      );
    } else {
      request.log.info(
        { status_code: mapped.statusCode, code: mapped.body.error.code },
        'request refused',
      );
    }
    return reply.status(mapped.statusCode).send(mapped.body);
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'no such endpoint' } }),
  );

  // Every role serves the ops endpoints — see role.ts.
  await registerOpsRoutes(app, {
    config,
    metrics: options.metrics,
    version: options.version,
    readiness: options.readiness,
    isShuttingDown: options.isShuttingDown,
    isUnderPressure: () => app.isUnderPressure(),
  });

  if (capabilities.api) {
    await app.register(fastifySse, { heartbeatInterval: 0 });
    await app.register(authPlugin, {
      auth: options.auth,
      database: options.database,
      baseUrl: config.baseUrl,
      trustProxy: config.trustProxy,
    });
    await registerOrgRoutes(app, { database: options.database });
    if (options.webhooks !== null) {
      await registerWebhookRoutes(app, { ingress: options.webhooks });
    }
    await registerProjectRoutes(app, { database: options.database });
    await registerTaskRoutes(app, { database: options.database });
    await registerRunRoutes(app, { database: options.database });
    await registerSseRoutes(app, {
      hub: options.hub,
      metrics: options.metrics,
      access: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectExists: async (projectId) => projectExists(options.database, projectId),
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        runProjectId: async (runId) => findRunProjectId(options.database, runId),
      },
    });

    app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  }

  /**
   * TD-002's shutdown order: `preClose` ends the SSE streams with a `shutdown` event and waits for
   * them to drain, and only then does Fastify stop the server and close connections. Doing it in
   * `onClose` would be too late — the sockets would already be gone.
   */
  app.addHook('preClose', async () => {
    const drained = await options.hub.shutdown();
    app.log.info({ streams: drained }, 'drained the event streams');
  });

  await app.ready();
  return app;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the first `onRequest` hook; used to observe the duration histogram. */
    startedAt?: bigint;
  }
}
