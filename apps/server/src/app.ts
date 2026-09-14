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
 * 3. `@fastify/compress`, before any route: it attaches its `onSend` through an `onRoute` hook, so
 *    a route registered earlier would never be compressed.
 * 4. `@fastify/under-pressure`, so `/healthz` can ask it.
 * 5. `@fastify/sse`, before `/events` declares `sse: true`.
 * 6. the auth plugin, whose `onRequest` hooks must run before any route's `preHandler`.
 * 7. routes.
 *
 * ### Compression, and the two responses that are excluded from it
 *
 * TD-002 puts `@fastify/compress` in the stack with one constraint — *"must exclude
 * `text/event-stream`"* — because a compressed SSE stream buffers until the compressor flushes,
 * which turns a live stream into a stalled one. WP-15j is what made it matter: the SPA's initial
 * graph is 551 009 raw bytes, against the 163 554 gzipped that `pnpm bundle:check` holds to
 * TD-013:8's 300 kB budget, so before this the budget was a statement about a number no instance
 * ever put on the wire.
 *
 * Three things here are measured rather than assumed (standing rule 13, on
 * `@fastify/compress@9.2.0` — MIT, Fastify-org, last published 2026-09-04):
 *
 * 1. **`/events` is never coded, and three separate things see to it.** `@fastify/sse` commits the
 *    response by writing to `reply.raw` (`sendHeaders`, `index.js:433`), so no `onSend` hook — the
 *    compressor's or anyone's — ever sees an SSE payload; the plugin's default type table excludes
 *    `text/event-stream` twice over (its regex and mime-db); and the route carries `compress:
 *    false`, which is TD-002's constraint stated in our own code and which, measured by mutation,
 *    decides nothing today. `web/compression.test.ts` therefore asserts the **outcome** over a
 *    socket — the first frame of a real `/events` response arrives, unencoded, while the response
 *    is still open — including on an instance configured to compress every content type.
 * 2. **`/api/auth/*` carries `compress: false`** (`auth/plugin.ts`). Better Auth's session
 *    responses are the only bodies on this origin that carry a bearer credential, and compressing
 *    a body that holds a secret beside anything a caller influences is BREACH's precondition. The
 *    responses are small; the exclusion costs nothing and removes the question.
 * 3. **Request decompression is off** (`globalDecompression: false`). Nothing in this product
 *    sends a compressed request body, `/webhooks/*` verifies a signature over the bytes as they
 *    arrive (WP-15c), and an inflating body limit is a zip bomb with extra steps.
 *
 * What the plugin does **not** cover is the browser application, and that is structural: it works
 * through `onRoute`, and Fastify emits no `onRoute` for the context `setNotFoundHandler` creates,
 * which is where the SPA is served from. `web/encoding.ts` is that half, with the measurement.
 */
import fastifyCompress from '@fastify/compress';
import fastifySse from '@fastify/sse';
import fastifySwagger from '@fastify/swagger';
import underPressure from '@fastify/under-pressure';
import type { WebhookIngress } from '@platform/application';
import type { IsoDateTime } from '@platform/contracts';
import { redaction as redactionAdapters } from '@platform/infrastructure';
import { type FastifyBaseLogger, type FastifyInstance, fastify, LogController } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { AskComposition } from './asks.js';
import type { Auth } from './auth/better-auth.js';
import { authPlugin } from './auth/plugin.js';
import type { TaskCommands } from './commands.js';
import type { ServerConfig } from './config.js';
import { toApiError } from './errors.js';
import type { KnowledgeCommands } from './knowledge.js';
import { type PinoLogger, withLogContext } from './logging.js';
import type { Metrics } from './metrics.js';
import { routeLabel } from './metrics.js';
import type { OnboardingCommands } from './onboarding.js';
import { listOrgBudgets, writeBudget } from './queries/cost-queries.js';
import type { Database } from './queries/identity-queries.js';
import {
  findProjectRole,
  findRunProjectId,
  findTaskProjectId,
  findUserById,
  listIdentityMappings,
  projectExists,
  upsertIdentityMapping,
} from './queries/identity-queries.js';
import {
  findIdempotentAttempt,
  recordHumanAction,
  writeProjectAutonomy,
} from './queries/onboarding-queries.js';
import { findRunPosition, findTaskPosition } from './queries/pipeline-queries.js';
import { findProjectAutonomy, listProjectAudit } from './queries/project-queries.js';
import { roleCapabilities } from './role.js';
import { registerAskRoutes } from './routes/asks.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerKbRoutes } from './routes/kb.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { type ReadinessReport, registerOpsRoutes } from './routes/ops.js';
import { registerOrgRoutes } from './routes/org.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRunRoutes } from './routes/runs.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import type { SseHub } from './sse/hub.js';
import { registerSseRoutes } from './sse/routes.js';
import { type ClientFallback, createClientFallback } from './web/fallback.js';

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
  /**
   * The Librarian's commands (WP-18b), or `null` for a process that composed no pipeline.
   *
   * Nullable like `webhooks` and for the same reason: which collaborators exist is a property of the
   * ROLE, and the routes that need one say `503` by name rather than disappearing (a missing route
   * would read as "wrong URL").
   */
  readonly knowledge: KnowledgeCommands | null;
  /**
   * The onboarding wizard's commands (WP-21), or `null` for a process that composed no pipeline.
   *
   * Nullable like `knowledge` and for the same reason: which collaborators exist is a property of
   * the ROLE, and the routes that need one answer `503` by name rather than disappearing. The
   * routes that need **no** collaborator — creating a project, writing a configuration — are
   * served either way, because they are database writes this process can always make.
   */
  readonly onboarding: OnboardingCommands | null;
  /**
   * The task and run command surface (WP-15i), or `null` for a process that composed no pipeline.
   *
   * Nullable like the two above and for the same reason. Note the finer distinction this one
   * carries **inside** the value: a process that serves the API without workers composes commands
   * with no queue, and the four that must start a stage refuse by name (`commands.ts`).
   */
  readonly commands: TaskCommands | null;
  /**
   * Ask-the-task (WP-31): the command port and the two reads, or `null` on a process that composed
   * no pipeline.
   *
   * Null on the write half only — the reads are always served, because a thread somebody asked for
   * on a worker is readable from an API-only replica.
   */
  readonly asks: AskComposition;
  /**
   * The directory holding the built SPA, or absent for a process that serves no browser
   * application (WP-15j).
   *
   * **Optional, and absent means nothing is served from disk** — deliberately, in both halves.
   * Optional, because `buildApp` is driven directly by `app.test.ts` and
   * `routes/client-census.test.ts`, whose subject is the API, and a required field would have made
   * the census fail to **compile** — the one thing this row may not do to it, its passing unchanged
   * being a criterion. Absent meaning *nothing*, because the alternative — defaulting to the
   * bundled path here — would make both of those files answer differently depending on whether
   * somebody had run `pnpm bundle:check` in the checkout. The default lives in `runtime.ts`, which is the production
   * composition, and `test/e2e/server/web-bundle.e2e.test.ts` drives a real instance through it
   * (standing rule 35: making a collaborator required proves it is supplied, not that it is used).
   */
  readonly webRoot?: string | null;
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

  /**
   * Every route URL this instance registers, in registration order (WP-15j).
   *
   * The hook is added before the first route so that it sees them all, including the ones plugins
   * register under a prefix. Two readers, and both need the *live* table rather than a copy:
   * `createClientFallback` derives the first segments the router reserves, and
   * `web/web-serving.test.ts` parameterises "this prefix never answers with the SPA shell" over the
   * same set, so a prefix added later is covered by the assertion the day it exists (standing rules
   * 7 and 68). Fastify exposes no route enumeration — `printRoutes` prints a wildcard route as a
   * bare `*`, losing the `/api/auth` it was registered under, measured — which is why this is
   * collected here rather than read back.
   */
  const routeUrls: string[] = [];
  app.addHook('onRoute', (route) => {
    routeUrls.push(route.url);
  });
  app.decorate('registeredRouteUrls', routeUrls as readonly string[]);

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

  /**
   * Response compression for every registered route (TD-002; see the module docblock).
   *
   * `encodings` is an explicit preference order rather than the plugin's default, which includes
   * `zstd` on a Node that has it: the bundle half of this origin (`web/encoding.ts`) offers `br`
   * and `gzip`, and one origin answering a third coding on half its paths is a difference nobody
   * asked for. `threshold` is left at the plugin's 1 024 bytes, and `web/encoding.ts` uses the
   * same number for the same reason.
   */
  await app.register(fastifyCompress, {
    global: true,
    globalDecompression: false,
    encodings: ['br', 'gzip', 'deflate'],
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

  /**
   * The unmatched-path handler, which is also where the SPA is served from (WP-15j).
   *
   * One handler, because Fastify allows one per encapsulation context — and the order is the point:
   * the router has already failed to match, so nothing here can shadow a route, and the JSON body
   * below is still what an unmatched `/api/…` path answers with. `clientFallback` is assigned after
   * the routes are registered (it derives the reserved prefixes from them), which is why it is a
   * mutable binding rather than an argument.
   */
  let clientFallback: ClientFallback | null = null;
  app.setNotFoundHandler(async (request, reply) => {
    if (clientFallback !== null && (await clientFallback(request, reply))) {
      return reply;
    }
    return reply.status(404).send({ error: { code: 'not_found', message: 'no such endpoint' } });
  });

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
    await registerOrgRoutes(app, {
      database: options.database,
      // The identity pair's four functions, bound to this process's database here so the route
      // module names none (`routes/org.ts`'s `IdentityQueries`). The four org **reads** beside
      // them still take `database`; that file says why the asymmetry is deliberate.
      identities: {
        findUser: async (userId) => findUserById(options.database, userId),
        upsertMapping: async (input) => upsertIdentityMapping(options.database, input),
        listMappings: async () => listIdentityMappings(options.database),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
    });
    await registerIntegrationRoutes(app, {
      database: options.database,
      baseUrl: config.baseUrl,
    });
    if (options.webhooks !== null) {
      await registerWebhookRoutes(app, { ingress: options.webhooks });
    }
    await registerProjectRoutes(app, {
      database: options.database,
      // The `invalid_stored_config` refusal quotes `projects.config` back at the caller, and that
      // column is partly the repository's own document (`describeConfigIssues`).
      redactor: redactionAdapters.patternRedactor(),
    });
    await registerOnboardingRoutes(app, {
      database: options.database,
      secretKey: config.secretKey,
      onboarding: options.onboarding,
      integrationSecretEnv: config.integrationSecretEnv,
    });
    await registerSettingsRoutes(app, {
      // The nine reads and writes the settings surface needs, bound to this process's database
      // here so that the route module names none (`routes/settings.ts`'s `SettingsQueries`).
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectAutonomy: async (projectId) => findProjectAutonomy(options.database, projectId),
        writeAutonomy: async (projectId, input) =>
          writeProjectAutonomy(options.database, projectId, input),
        projectExists: async (projectId) => projectExists(options.database, projectId),
        orgBudgets: async () =>
          listOrgBudgets(options.database, new Date().toISOString() as IsoDateTime),
        writeBudget: async (input) => writeBudget(options.database, input),
        projectAudit: async (projectId, limit) =>
          listProjectAudit(options.database, projectId, limit),
        previousAttempt: async (query) => findIdempotentAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      // TD-012 step 2, the platform's patterns — the same composition `commands.ts` gives every
      // task command, and for the same reason: an HTTP request carries no run-scoped credential.
      redactor: redactionAdapters.patternRedactor(),
    });
    await registerKbRoutes(app, {
      database: options.database,
      knowledge: options.knowledge,
    });
    await registerTaskRoutes(app, { database: options.database });
    await registerAskRoutes(app, {
      queries: {
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        previousAttempt: async (query) => findIdempotentAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
        ...options.asks.queries,
      },
      asks: options.asks.commands,
    });
    await registerCommandRoutes(app, {
      // The seven functions the command routes need, bound to this process's database here so
      // that module names none (`routes/commands.ts`'s `CommandQueries`).
      queries: {
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        runProjectId: async (runId) => findRunProjectId(options.database, runId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        taskPosition: async (taskId) => findTaskPosition(options.database, taskId),
        runPosition: async (runId) => findRunPosition(options.database, runId),
        previousAttempt: async (query) => findIdempotentAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      commands: options.commands,
    });
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

    /**
     * The browser application, last: it reads the route table above to learn which first segments
     * the router owns (WP-15j, criterion 2).
     *
     * Gated on `capabilities.api` and nothing else. A `worker`, `runner` or `indexer` container
     * serves the ops endpoints so that an orchestrator can probe it, and serving the SPA from a
     * process nobody browses to would put a second origin in front of the same API — which is the
     * arrangement technical/09's "same origin" sentence exists to prevent.
     */
    if (options.webRoot !== undefined && options.webRoot !== null) {
      clientFallback = await createClientFallback({
        root: options.webRoot,
        routeUrls,
        logger: app.log,
      });
    }
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
  interface FastifyInstance {
    /** Every route URL this instance registered, in registration order (WP-15j). */
    registeredRouteUrls: readonly string[];
  }
}
