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
import type {
  Broadcast,
  DeadLetterCommands,
  ProjectSettingsPort,
  RemoteRunCalls,
  RemoteRuns,
  WebhookIngress,
  WipRaisedRecorder,
} from '@platform/application';
import { createIntegrationEgressPolicy } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
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
import type { HistoryBootstrapCommands, HistoryBootstrapGateResult } from './bootstrap.js';
import type { BreakdownComposition } from './breakdown.js';
import type { TaskCommands } from './commands.js';
import type { ServerConfig } from './config.js';
import { repositorySnapshotFrom } from './config-layers.js';
import { toApiError } from './errors.js';
import type { KnowledgeCommands } from './knowledge.js';
import { checkProposedLifecycles, readProposedAccountIdentities } from './lifecycle-check.js';
import { type PinoLogger, withLogContext } from './logging.js';
import type { ManualJobsSeenReader } from './manual-jobs-seen.js';
import type { Metrics } from './metrics.js';
import { routeLabel } from './metrics.js';
import type { OnboardingCommands } from './onboarding.js';
import type { ProjectConfigCommands } from './project-config.js';
import { listHistoryBootstraps } from './queries/bootstrap-queries.js';
import { listedModelIds, listOrgBudgets, writeBudget } from './queries/cost-queries.js';
import {
  findProjectExecution,
  remoteRunCredentialRefused,
  serverClaimantRunning,
  waitingOffers,
  writeProjectExecution,
} from './queries/execution-queries.js';
import { claimCommandAttempt, releaseCommandAttempt } from './queries/idempotency-queries.js';
import {
  findLinkThread,
  listMyIdentities,
  unlinkIdentity,
  unlinkMyIdentity,
} from './queries/identity-link-queries.js';
import type { Database } from './queries/identity-queries.js';
import {
  findConfigLayers,
  findExportableProject,
  findProjectRole,
  findRunProjectId,
  findTaskProjectId,
  findUserById,
  listIdentityCandidates,
  listIdentityMappings,
  projectExists,
  upsertIdentityMapping,
} from './queries/identity-queries.js';
import { unassignedTakersOf } from './queries/offer-waiting.js';
import {
  assertBindingItemsWritable,
  findBindingAccounts,
  findProjectById,
  findProjectRepository,
  listProjectBindings,
  recordHumanAction,
  replaceProjectBindings,
  writeProjectAutonomy,
  writeProjectDefaultBranch,
} from './queries/onboarding-queries.js';
import {
  findOrganisationSettings,
  isCommunicationAccount,
  replaceOrganisationSettings,
} from './queries/org-settings-queries.js';
import { findOwnerCandidates } from './queries/owner-candidate-queries.js';
import { databasePipelineGraphReaders } from './queries/pipeline-graph-queries.js';
import {
  findArtifactBody,
  findArtifactProjectId,
  findRunPosition,
  findTaskDetail,
  findTaskPosition,
  findTaskTicketKey,
  listRunMessages,
  listTaskEvents,
  ownerCandidateWriteBack,
  ownerWriteBackFor,
} from './queries/pipeline-queries.js';
import {
  findBindingAccountIsAPerson,
  findLastConfigExport,
  findProjectAutonomy,
  findProjectReadiness,
  findProjectTicketLifecycle,
  listProjectAudit,
} from './queries/project-queries.js';
import {
  findShadowBatch,
  findShadowBatchProjectId,
  listShadowBatches,
} from './queries/shadow-queries.js';
import { findOrganisationTimezone, readStatsSources } from './queries/stats-queries.js';
import { createPostgresWorkerStore, type WorkerStore } from './queries/worker-queries.js';
import { roleCapabilities } from './role.js';
import { registerAskRoutes } from './routes/asks.js';
import { registerBootstrapRoutes } from './routes/bootstrap.js';
import { registerBreakdownRoutes } from './routes/breakdown.js';
import { registerCommandRoutes } from './routes/commands.js';
import { registerDeadLetterRoutes } from './routes/dead-letters.js';
import { registerDownloadRoutes } from './routes/downloads.js';
import { type FailedJobsReader, registerFailedJobRoutes } from './routes/failed-jobs.js';
import { type IntegrationRoutesOptions, registerIntegrationRoutes } from './routes/integrations.js';
import { registerKbRoutes } from './routes/kb.js';
import { type IdentityLinkCommands, registerMeIdentityRoutes } from './routes/me-identities.js';
import { registerOnboardingRoutes } from './routes/onboarding.js';
import { type ReadinessReport, registerOpsRoutes } from './routes/ops.js';
import { registerOrgRoutes } from './routes/org.js';
import { registerOwnerCandidateRoutes } from './routes/owner-candidates.js';
import { registerPipelineGraphRoutes } from './routes/pipeline-graph.js';
import { registerProjectBindingRoutes } from './routes/project-bindings.js';
import { registerProjectCiJobsRoutes } from './routes/project-ci-jobs.js';
import { registerProjectConfigRoutes } from './routes/project-config.js';
import { registerProjectExecutionRoutes } from './routes/project-execution.js';
import { registerProjectReadinessRoutes } from './routes/project-readiness.js';
import { registerProjectRepositoryRoutes } from './routes/project-repository.js';
import { registerProjectRoutes } from './routes/projects.js';
import { type RediscoveryGateReader, registerRediscoveryRoutes } from './routes/rediscovery.js';
import { databaseRunQueries, registerRunRoutes } from './routes/runs.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSetupStateRoutes, type SetupStateReader } from './routes/setup-state.js';
import { registerShadowRoutes } from './routes/shadow.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerTaskStartRoutes } from './routes/task-start.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import type { WorkerRunCancelPort } from './routes/worker/owner-verbs.js';
import type { OfferDisplays } from './routes/worker/pick-verbs.js';
import {
  registerWorkerProtocolCheck,
  registerWorkerProtocolRoutes,
} from './routes/worker/protocol.js';
import { registerWorkerDeviceRoutes } from './routes/worker-device.js';
import { registerWorkerRoutes } from './routes/workers.js';
import type { ShadowCommands } from './shadow.js';
import type { SseHub } from './sse/hub.js';
import { registerSseRoutes } from './sse/routes.js';
import type { TaskStartCommands } from './task-start.js';
import type { TicketStatusReader } from './ticket-statuses.js';
import { type ClientFallback, createClientFallback } from './web/fallback.js';
import type { WorkerRelease } from './workers/release.js';

/**
 * What the read endpoint publishes when the process cannot compute an estimate.
 *
 * Zeroes with `can_start: false` beside them, and the screen renders the blocked reason rather than
 * the figures. It is **not** an estimate of zero — a process that cannot read a project's settings
 * has no answer, and the pairing is what says so (`can_start` is false in the same object).
 */
const UNAVAILABLE_ESTIMATE = {
  mergeRequests: 0,
  batchSize: 0,
  batches: 0,
  estimatedUsd: 0,
  capUsd: 0,
  stopsAtCap: false,
  days: 0,
} as const;

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
   * Shadow mode's batch command (WP-34), or `null` for a process that composed no pipeline.
   *
   * Nullable like `onboarding` and for the same reason: which collaborators exist is a property of
   * the `ROLE`, and the route answers `503` by name rather than disappearing.
   */
  readonly shadow: ShadowCommands | null;
  /**
   * The configuration export and the repository re-read (WP-63), or `null` for a process that
   * composed none. Nullable like `shadow`; the routes answer `503` by name.
   */
  readonly projectConfig?: ProjectConfigCommands | null;
  /**
   * The tracker's statuses (WP-181): `GET …/ticket-statuses` and the lifecycle check at
   * `PUT …/bindings`, or `null`/absent for a process that composed no integration stack. Optional
   * like `projectConfig`; both routes are registered either way and answer
   * `503 lifecycle_statuses_unavailable` by name — behind their guards, which the census probes. A
   * bindings write whose lifecycle block names no status needs no reader and is served either way.
   */
  readonly ticketStatuses?: TicketStatusReader | null;
  /**
   * The manual CI jobs seen in a project's recent task pipelines (S-28.7): `GET …/ci/manual-jobs`,
   * or `null`/absent for a process that composed no integration stack — the route is registered
   * either way and answers `503 manual_jobs_unavailable` by name, behind its guard.
   */
  readonly manualJobsSeen?: ManualJobsSeenReader | null;
  /**
   * The manual start from a ticket key (WP-122), or `null`/absent for a process that composed no
   * integration stack. Optional like `projectConfig`: `app.test.ts` and the census build an app
   * with no database, and the route is registered either way and answers `503` by name — behind
   * its guard, which is what the census probes.
   */
  readonly taskStart?: TaskStartCommands | null;
  /**
   * A person's own account link (S-26.6): issue, confirm, the state read and *I wrote it on …*, or
   * `null`/absent for a process that composed none. Optional like `taskStart`; the routes are
   * registered either way and answer `503 identity_links_unavailable` by name, behind their guard.
   */
  readonly identityLinks?: IdentityLinkCommands | null;
  /**
   * The dead-letter list and its re-queue (WP-95, PROGRESS backlog 126), or `null`/absent for a
   * process that composed no eventing. Optional like `projectConfig`: `app.test.ts` and the census
   * build an app with no database, and the routes are registered either way and answer `503` by
   * name — behind their admin guard, which is what the census probes.
   */
  readonly deadLetters?: DeadLetterCommands | null;
  /**
   * The failed-jobs read (WP-108, PROGRESS backlog 325), or `null`/absent for a process that reads
   * no job queue. Optional like `deadLetters`, for the same reason; the route answers `503` by name.
   */
  readonly failedJobs?: FailedJobsReader | null;
  /**
   * Workers and the device flow (WP-280). Absent: the PostgreSQL store over `database`, which is
   * what every composition uses; a test hands an in-memory one (`queries/worker-store-memory.ts`).
   */
  readonly workers?: WorkerStore;
  /** The clock the worker routes read (device-code expiry, a code's age). Absent: the wall clock. */
  readonly workersNow?: () => Date;
  /**
   * The worker protocol's commands (WP-281), the broadcast its held requests wake on, and what the
   * core advertises. Absent (or `remoteRuns: null`): the routes are still registered — the protocol
   * check, then `401` to an anonymous caller — and an authenticated call is answered
   * `503 worker_protocol_unavailable` by name, which is what the census builds.
   */
  readonly workerProtocol?: {
    readonly remoteRuns: RemoteRuns | null;
    /** The run-scoped calls besides the claim (WP-282); absent, they answer `503` by name. */
    readonly runCalls?: RemoteRunCalls | null;
    readonly broadcast: Broadcast | null;
    readonly release: () => WorkerRelease | null;
    /** Why `release()` is `null` — the `503 digests_unresolved`'s words, naming the image (WP-284). */
    readonly unresolved?: () => string | null;
    /**
     * The worker's cancel (WP-292). Absent: composed from `commands` and this process's database;
     * a test passes its own (or `null`, which answers `503` by name).
     */
    readonly runCancel?: WorkerRunCancelPort | null;
    /** `GET offers`' display names (WP-293); absent, every offer is listed without them. */
    readonly offerDisplays?: OfferDisplays | null;
    /**
     * `GET claim-scope?fields=unassigned_has_taker` (BACKLOG 1456). Absent: this process's
     * database (`unassignedTakersOf`, the asking worker excluded); a test passes its own or `null`.
     */
    readonly unassignedTakers?:
      | ((workerId: Id, projectIds: readonly Id[]) => Promise<ReadonlyMap<string, boolean>>)
      | null;
    /** The held requests' bounds; absent, TD-031 §9's 25 s and 20 s (a test shortens them). */
    readonly holds?: {
      readonly claimMs?: number;
      readonly heartbeatMs?: number;
      readonly claimPollMs?: number;
    };
  };
  /**
   * Whether a project may start a shadow batch — the same predicate the command refuses with.
   *
   * Separate from `shadow` because the **read** endpoint publishes it and a process that serves the
   * API without workers can still answer it. `null` when this process cannot read project settings,
   * which the route turns into a named `can_start: false` rather than a guess.
   */
  readonly shadowGate:
    | ((projectId: string) => Promise<{ canStart: boolean; blockedReason: string | null }>)
    | null;
  /**
   * Whether each live organisation communication account's credentials decrypt (WP-157 (a), PROGRESS
   * backlog 413): `GET /api/integrations`'s `credentials_readable`. Required, so a composition that
   * forgets it says `null` (every row *not checked*) rather than nothing.
   */
  readonly organisationCredentials: IntegrationRoutesOptions['organisationCredentials'];
  /**
   * The project settings read (WP-167): `GET /api/runs/:run_id`'s `retry_defaults` is the stage's
   * configured model and effort, resolved from it at the read. Required, like
   * `organisationCredentials`, so a composition cannot forget it.
   */
  readonly projectSettings: ProjectSettingsPort;
  /**
   * S-25.21 (BACKLOG 1369): appends `config.changed` for a raised WIP limit, so the scheduler
   * starts a queued task in the place the raise opened. Absent or `null` on a composition with no
   * event store (`app.test.ts`): the configuration writes are served and append nothing.
   */
  readonly wipRaised?: WipRaisedRecorder | null;
  /**
   * The history bootstrap's start command (WP-35), or `null` for a process with no pipeline.
   *
   * Nullable like `shadow` and for the same reason; the route answers `503` by name.
   */
  readonly historyBootstrap: HistoryBootstrapCommands | null;
  /**
   * Whether a project may start a bootstrap, and what one would cost — the read endpoint's half.
   *
   * Separate from `historyBootstrap` because the **read** publishes both, and an API process with
   * no workers can still answer them. `null` when this process cannot read project settings, which
   * the route turns into a named `can_start: false` rather than a guess.
   */
  readonly historyBootstrapGate:
    | ((projectId: string, mergeRequests: number | null) => Promise<HistoryBootstrapGateResult>)
    | null;
  /**
   * Whether a maintainer may run discovery again, and what it may cost — the read half of the
   * re-evaluate (WP-94). `null` when this process cannot read project settings; the read then
   * answers 503 by name. The command half is `onboarding.startRediscovery`.
   */
  readonly rediscoveryGate: RediscoveryGateReader | null;
  /**
   * The task and run command surface (WP-15i), or `null` for a process that composed no pipeline.
   *
   * Nullable like the two above and for the same reason. Note the finer distinction this one
   * carries **inside** the value: a process composed with no queue client serves the commands
   * with no queue, and the four that must start a stage refuse by name (`commands.ts`). Since WP-72
   * that is no shipped role — `ROLE=api` enqueues through an enqueue-only sender.
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
   * The epic split's acceptance surface (WP-40): the decision and the queue read.
   *
   * Nullable **here** and non-null in production, which is the same shape `knowledge` and
   * `onboarding` have: `runtime.ts` composes it on every process — accepting a breakdown needs no
   * queue, because the event it appends is what a worker turns into `createTicket` calls — while
   * `app.test.ts` and the census build an app with no database at all, and a stub that pretended to
   * hold a pipeline store would be the harness being kinder than the composition (standing rule 1).
   * The write then answers `503` by name.
   */
  readonly breakdown: BreakdownComposition | null;
  /**
   * Whether anybody has signed in to this instance yet — `GET /api/setup-state` (WP-291).
   *
   * Required and a reader rather than the database, so `app.test.ts` and the census, which build
   * an app with no database, say what it answers instead of reaching a `{}` that throws.
   */
  readonly setupState: SetupStateReader;
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
    // An address list is handed over as Fastify's array form; never a number (a hop count).
    trustProxy: typeof config.trustProxy === 'boolean' ? config.trustProxy : [...config.trustProxy],
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
        { name: 'auth', description: 'What the sign-in page reads before a session exists' },
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
    // WP-291: public by design — the sign-in page reads it before a session exists.
    await registerSetupStateRoutes(app, { setupState: options.setupState });
    // WP-281: the release a worker is held to; its digests are what a worker's claim compares with.
    const workerRelease = options.workerProtocol?.release ?? (() => null);
    /**
     * The core's current run and egress images, what a worker's blockers compare with (S-22.19) —
     * and, since S-26.5, the `waiting` reads (the Agents rows, the board, the task read).
     */
    const coreRunDigests = () => {
      const release = workerRelease();
      return release === null
        ? null
        : { run: release.digests.platform_runtime, egress: release.digests.platform_egress };
    };
    // S-25.16: a queued task's `queue_wait` is read with the limits the scheduler is given — the
    // same settings port's `wip`, the organisation's bound applied — never a second resolution —
    // and (S-25.21) the keys of the limits that bound lowered, from the same read.
    const wipLimits = async (projectId: string) => {
      const settings = await options.projectSettings.forProject(projectId as Id);
      return {
        limits: settings.wip,
        bounded: (settings.wipBounded ?? []).map((bound) => bound.key),
      };
    };
    // S-25.21: the two configuration writes compare the limits in force — this same settings port's
    // `wip` — before and after, and append the event that starts the queue for a raise.
    const wipRaise =
      options.wipRaised === undefined || options.wipRaised === null
        ? null
        : {
            limitsInForce: async (projectId: string) =>
              (await projectExists(options.database, projectId))
                ? (await options.projectSettings.forProject(projectId as Id)).wip
                : null,
            recorder: options.wipRaised,
          };
    await registerOrgRoutes(app, {
      coreDigests: coreRunDigests,
      database: options.database,
      // The identity pair's four functions, bound to this process's database here so the route
      // module names none (`routes/org.ts`'s `IdentityQueries`). The four org **reads** beside
      // them still take `database`; that file says why the asymmetry is deliberate.
      identities: {
        findUser: async (userId) => findUserById(options.database, userId),
        upsertMapping: async (input) => upsertIdentityMapping(options.database, input),
        listMappings: async () => listIdentityMappings(options.database),
        unlinkMapping: async (input) => unlinkIdentity(options.database, input),
        listCandidates: async () => listIdentityCandidates(options.database),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      // WP-159: open now, by this process's clock — the instant the retry's check reads too.
      models: async () => listedModelIds(options.database, new Date()),
    });
    // S-26.6: a person links their own tracker or git account, proven by the provider.
    await registerMeIdentityRoutes(app, {
      commands: options.identityLinks ?? null,
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        listMine: async (userId) => listMyIdentities(options.database, userId),
        unlinkMine: async (input) => unlinkMyIdentity(options.database, input),
        threadOf: async (projectId, target) => findLinkThread(options.database, projectId, target),
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
    });
    // WP-95, backlog 126: the operator's two instruments over the events WP-49 dead-lettered.
    await registerDeadLetterRoutes(app, {
      commands: options.deadLetters ?? null,
      records: {
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      projectRole: async (projectId, userId) =>
        findProjectRole(options.database, projectId, userId),
      // TD-012 step 2, the platform's patterns: a handler's error may quote a credential.
      redactor: redactionAdapters.patternRedactor(),
    });
    // WP-280: the device flow (unauthenticated, rate-limited) and the people's worker surface.
    const workerStore = options.workers ?? createPostgresWorkerStore(options.database);
    // WP-281: the protocol check (`426`, `no-store`) first, on every `/api/worker/v1/` verb — the
    // device flow's included (backlog 712) — then the device flow and the protocol's verbs.
    registerWorkerProtocolCheck(app, { release: workerRelease, baseUrl: config.baseUrl });
    await registerWorkerDeviceRoutes(app, {
      store: workerStore,
      baseUrl: config.baseUrl,
      trustProxy: config.trustProxy,
      trustedClientIpHeader: config.trustedClientIpHeader,
      ...(options.workersNow === undefined ? {} : { now: options.workersNow }),
    });
    await registerWorkerRoutes(app, {
      store: workerStore,
      projectRole: async (projectId, userId) =>
        findProjectRole(options.database, projectId, userId),
      coreDigests: coreRunDigests,
      ...(options.workersNow === undefined ? {} : { now: options.workersNow }),
    });
    await registerWorkerProtocolRoutes(app, {
      store: workerStore,
      baseUrl: config.baseUrl,
      // WP-292: the task page's cancel, carried by a worker from its local page. Its reads and
      // records are the command routes' own, bound to this process's database here.
      runCancel:
        options.workerProtocol?.runCancel !== undefined
          ? options.workerProtocol.runCancel
          : options.commands === null
            ? null
            : {
                cancelRun: options.commands.cancelRun,
                runProjectId: async (runId) => findRunProjectId(options.database, runId),
                runPosition: async (runId) => findRunPosition(options.database, runId),
                projectRole: async (projectId, userId) =>
                  findProjectRole(options.database, projectId, userId),
                userRole: async (userId) =>
                  (await findUserById(options.database, userId))?.role ?? null,
                claimAttempt: async (query) => claimCommandAttempt(options.database, query),
                releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
                recordAction: async (input) => recordHumanAction(options.database, input),
              },
      remoteRuns: options.workerProtocol?.remoteRuns ?? null,
      runCalls: options.workerProtocol?.runCalls ?? null,
      offerDisplays: options.workerProtocol?.offerDisplays ?? null,
      // BACKLOG 1456: the execution read's statement, with the asking worker excluded.
      unassignedTakers:
        options.workerProtocol?.unassignedTakers !== undefined
          ? options.workerProtocol.unassignedTakers
          : async (workerId, projectIds) =>
              unassignedTakersOf(options.database, projectIds, { workerId }),
      broadcast: options.workerProtocol?.broadcast ?? null,
      release: workerRelease,
      ...(options.workerProtocol?.unresolved === undefined
        ? {}
        : { unresolved: options.workerProtocol.unresolved }),
      ...(options.workerProtocol?.holds?.claimMs === undefined
        ? {}
        : { claimHoldMs: options.workerProtocol.holds.claimMs }),
      ...(options.workerProtocol?.holds?.heartbeatMs === undefined
        ? {}
        : { heartbeatHoldMs: options.workerProtocol.holds.heartbeatMs }),
      ...(options.workerProtocol?.holds?.claimPollMs === undefined
        ? {}
        : { claimPollMs: options.workerProtocol.holds.claimPollMs }),
      ...(options.workersNow === undefined ? {} : { now: options.workersNow }),
    });
    // WP-108, backlog 325: beside it, the jobs pg-boss gave up on — a read, never a re-queue.
    await registerFailedJobRoutes(app, {
      read: options.failedJobs ?? null,
      projectRole: async (projectId, userId) =>
        findProjectRole(options.database, projectId, userId),
      redactor: redactionAdapters.patternRedactor(),
    });
    await registerIntegrationRoutes(app, {
      database: options.database,
      baseUrl: config.baseUrl,
      organisationCredentials: options.organisationCredentials,
    });
    if (options.webhooks !== null) {
      await registerWebhookRoutes(app, { ingress: options.webhooks });
    }
    await registerProjectRoutes(app, {
      database: options.database,
      coreDigests: coreRunDigests,
      wipLimits,
      // The `invalid_stored_config` refusal quotes `projects.config` back at the caller — text an
      // operator typed, which can carry a pasted credential (`describeConfigIssues`).
      redactor: redactionAdapters.patternRedactor(),
    });
    // WP-181 review round 2: the readiness read, its database reads bound here and no provider in
    // reach — the binding-account note reads the account the bindings write stored (migration 0090).
    await registerProjectReadinessRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        readiness: async (projectId) => findProjectReadiness(options.database, projectId),
        ticketLifecycle: async (projectId) =>
          findProjectTicketLifecycle(options.database, projectId),
        accountIsAPerson: async (projectId) =>
          findBindingAccountIsAPerson(options.database, projectId),
      },
    });
    // S-26.1's follow-up: the Assign picker's people — the owner command's own target rule.
    await registerOwnerCandidateRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        candidates: async (projectId) => findOwnerCandidates(options.database, projectId),
        // S-26.3: each candidate's `writes_back`, over the write-back duty's own predicate.
        writeBack: async (input, userIds) =>
          ownerCandidateWriteBack(options.database, input, userIds),
      },
    });
    // WP-63: the configuration export and the repository re-read (Q94). The database reads and writes
    // are bound here so the route module names none of them (`ProjectConfigQueries`).
    await registerProjectConfigRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        exportableProject: async (projectId) => findExportableProject(options.database, projectId),
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
        readRepository: async (projectId) =>
          repositorySnapshotFrom((await findConfigLayers(options.database, projectId)) ?? {}),
        lastExport: async (projectId) => findLastConfigExport(options.database, projectId),
      },
      commands: options.projectConfig ?? null,
      redactText: (value) => redactionAdapters.patternRedactor().redactText(value).value,
    });
    // WP-278 (TD-031 decision 8): where the project's agent runs execute — an administrator's
    // setting, never a key of `.agentic/config.yml` — and whether the instance has a server claimant.
    await registerProjectExecutionRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectExists: async (projectId) =>
          (await findProjectById(options.database, projectId)) !== null,
        execution: async (projectId) => findProjectExecution(options.database, projectId),
        writeExecution: async (projectId, settings) =>
          writeProjectExecution(options.database, projectId, settings),
        serverClaimantRunning: async () => serverClaimantRunning(options.database),
        remoteRunCredentialRefused: async (projectId) =>
          remoteRunCredentialRefused(options.database, projectId),
        workersFor: async (projectId, userId) =>
          workerStore.listWorkersForProject(projectId, userId),
        waitingOffers: async (projectId) => waitingOffers(options.database, projectId),
        // S-26.5, and BACKLOG 1456's `?worker_id=`: the worker's own claim-scope answer's statement.
        othersTakeUnassigned: async (projectId, exclude) =>
          (await unassignedTakersOf(options.database, [projectId], exclude)).get(projectId) ===
          true,
        coreDigests: coreRunDigests,
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
    });
    // WP-139: the project's default branch — the provider's answer beside the stored one, and the
    // maintainer's change command. The provider read rides the configuration commands' executor.
    await registerProjectRepositoryRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectRepository: async (projectId) => findProjectRepository(options.database, projectId),
        project: async (projectId) => findProjectById(options.database, projectId),
        writeDefaultBranch: async (projectId, branch) =>
          writeProjectDefaultBranch(options.database, projectId, branch),
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      providerRepository:
        options.projectConfig === undefined || options.projectConfig === null
          ? null
          : options.projectConfig.repository,
      // WP-142: a change asks for an index of the new branch once it has committed.
      requestKnowledgeIndex:
        options.projectConfig === undefined || options.projectConfig === null
          ? null
          : async (projectId) => {
              const requested = await options.projectConfig?.requestKnowledgeIndex(projectId as Id);
              if (requested !== true) {
                throw new Error('this process holds no job client to request a knowledge index');
              }
            },
      // WP-147: and reads the new branch's configuration and readiness at once.
      readNewDefaultBranch:
        options.projectConfig === undefined || options.projectConfig === null
          ? null
          : async (projectId) => {
              const commands = options.projectConfig;
              if (commands === undefined || commands === null) {
                throw new Error('this process composed no configuration commands');
              }
              return commands.readNewDefaultBranch(projectId as Id);
            },
    });
    // WP-181: the bindings pair (moved out of the onboarding module) and the statuses read, with
    // the lifecycle check the write makes before it saves anything.
    const bindingEgress = createIntegrationEgressPolicy(config.integrationHosts);
    const ticketStatuses = options.ticketStatuses ?? null;
    await registerProjectBindingRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectExists: async (projectId) =>
          (await findProjectById(options.database, projectId)) !== null,
        listBindings: async (projectId) => listProjectBindings(options.database, projectId),
        replaceBindings: async (projectId, items) =>
          replaceProjectBindings(options.database, projectId, items, { egress: bindingEgress }),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      checkLifecycles: async (projectId, items) =>
        checkProposedLifecycles(projectId, items, {
          accounts: async (ids) => findBindingAccounts(options.database, ids),
          assertWritable: async (project, proposed, accounts) =>
            assertBindingItemsWritable(
              options.database,
              project,
              proposed,
              accounts,
              bindingEgress,
            ),
          statuses: ticketStatuses === null ? null : ticketStatuses.proposed,
        }),
      readAccountIdentities: async (projectId, items) =>
        readProposedAccountIdentities(projectId, items, {
          accounts: async (ids) => findBindingAccounts(options.database, ids),
          assertWritable: async (project, proposed, accounts) =>
            assertBindingItemsWritable(
              options.database,
              project,
              proposed,
              accounts,
              bindingEgress,
            ),
          account: ticketStatuses === null ? null : ticketStatuses.proposedAccount,
          logger: app.log,
        }),
      ticketStatuses: ticketStatuses === null ? null : ticketStatuses.current,
    });
    // S-28.7: the manual CI jobs seen in the project's recent task pipelines.
    const manualJobsSeen = options.manualJobsSeen ?? null;
    await registerProjectCiJobsRoutes(app, {
      projectRole: async (projectId, userId) =>
        findProjectRole(options.database, projectId, userId),
      projectExists: async (projectId) =>
        (await findProjectById(options.database, projectId)) !== null,
      manualJobsSeen: manualJobsSeen === null ? null : manualJobsSeen.read,
    });
    await registerOnboardingRoutes(app, {
      database: options.database,
      wipRaise,
      secretKey: config.secretKey,
      onboarding: options.onboarding,
      integrationSecretEnv: config.integrationSecretEnv,
      // `APP_INTEGRATION_HOSTS` (WP-51): the write-time half of the egress allow-list. The call-time
      // half is the executor's, and both are needed — this one gives an operator a refusal at the
      // moment they configure the binding, that one covers a row this route never saw.
      integrationHosts: config.integrationHosts,
    });
    // WP-34: shadow mode's one command and two reads (product/10:20). The eight database functions
    // are bound here so the route module names none of them (`routes/shadow.ts`'s `ShadowQueries`).
    await registerShadowRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectExists: async (projectId) =>
          (await findProjectById(options.database, projectId)) !== null,
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
        listBatches: async (projectId, gate) =>
          listShadowBatches(options.database, projectId, gate),
        findBatch: async (batchId) => findShadowBatch(options.database, batchId),
        projectOfBatch: async (batchId) => findShadowBatchProjectId(options.database, batchId),
      },
      shadow: options.shadow,
      gate: options.shadowGate,
    });
    /**
     * WP-35: the history bootstrap's one command and one read (product/06 step 3b).
     *
     * The gate and the estimate are computed by the composition root's `historyBootstrapGate` and
     * handed to the projection, so the screen, the read and the command all use one answer — a
     * projection that re-derived the estimate would be the second spelling of one rule (rule 9).
     */
    await registerBootstrapRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectExists: async (projectId) =>
          (await findProjectById(options.database, projectId)) !== null,
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
        listBootstraps: async (projectId, mergeRequests) => {
          const gate =
            options.historyBootstrapGate === null
              ? {
                  canStart: false,
                  blockedReason:
                    'this process cannot read the project’s settings, so it cannot say whether a history bootstrap may start',
                  estimate: UNAVAILABLE_ESTIMATE,
                }
              : await options.historyBootstrapGate(projectId, mergeRequests);
          return listHistoryBootstraps(options.database, projectId, {
            canStart: gate.canStart,
            blockedReason: gate.blockedReason,
            estimate: {
              merge_requests: gate.estimate.mergeRequests,
              batch_size: gate.estimate.batchSize,
              batches: gate.estimate.batches,
              estimated_usd: gate.estimate.estimatedUsd,
              cap_usd: gate.estimate.capUsd,
              stops_at_cap: gate.estimate.stopsAtCap,
              days: gate.estimate.days,
            },
          });
        },
      },
      bootstrap: options.historyBootstrap,
    });
    /**
     * WP-94: a maintainer's re-evaluate (Q107 (a)) — the command on the onboarding composition, the
     * gate on the read, one function deciding both (`readRediscoveryGate`).
     */
    await registerRediscoveryRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectExists: async (projectId) =>
          (await findProjectById(options.database, projectId)) !== null,
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      commands: options.onboarding,
      gate: options.rediscoveryGate,
    });
    await registerSettingsRoutes(app, {
      // The ten reads and writes the settings surface needs, bound to this process's database
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
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
        // WP-93: the organisation settings document's read, its one write and Q103 (c)'s check.
        organisationSettings: async () => findOrganisationSettings(options.database),
        replaceOrganisationSettings: async (next) =>
          replaceOrganisationSettings(options.database, next),
        isCommunicationAccount: async (id) => isCommunicationAccount(options.database, id),
      },
      // TD-012 step 2, the platform's patterns — the same composition `commands.ts` gives every
      // task command, and for the same reason: an HTTP request carries no run-scoped credential.
      redactor: redactionAdapters.patternRedactor(),
      wipRaise,
    });
    // WP-41: the organisation statistics and their CSV twin. It needs the database and nothing
    // else — every number is a projection, and the two the projector writes are read like the six
    // that already existed.
    await registerStatsRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        timezone: async () => findOrganisationTimezone(options.database),
        sources: async (range, statsOptions) =>
          readStatsSources(options.database, range, statsOptions),
      },
    });
    await registerKbRoutes(app, {
      database: options.database,
      knowledge: options.knowledge,
    });
    // WP-122: product/04's manual Start. The command reads a provider and appends an event, so it is
    // the composition root's; the guard's and the key's reads are bound here.
    await registerTaskStartRoutes(app, {
      queries: {
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        projectExists: async (projectId) =>
          (await findProjectById(options.database, projectId)) !== null,
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
      },
      commands: options.taskStart ?? null,
    });
    await registerTaskRoutes(app, {
      queries: {
        taskDetail: async (taskId) =>
          findTaskDetail(options.database, taskId, { coreDigests: coreRunDigests(), wipLimits }),
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        artifactBody: async (artifactId) => findArtifactBody(options.database, artifactId),
        artifactProjectId: async (artifactId) =>
          findArtifactProjectId(options.database, artifactId),
        // WP-112: the export's audit rows are the ones `GET /api/tasks/:id/audit` serves — the same
        // function, bound below for the ask routes — never a second reading of `human_actions`.
        taskAudit: async (taskId, limit) => options.asks.queries.taskAudit(taskId, limit),
        taskEvents: async (taskId, limit) => listTaskEvents(options.database, taskId, limit),
        // S-26.3: the per-caller `take_writes_back`, over the write-back duty's own predicate.
        ownerWriteBack: async (task, userIds) => ownerWriteBackFor(options.database, task, userIds),
      },
      // TD-012 step 2 over the export's event payloads, which no route had published before.
      redactor: redactionAdapters.patternRedactor(),
    });
    // S-23.15: the compiled stage graph of a task (its frozen pipeline) and of a project's templates.
    await registerPipelineGraphRoutes(app, {
      queries: {
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        ...databasePipelineGraphReaders(options.database, options.projectSettings),
      },
    });
    await registerAskRoutes(app, {
      queries: {
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
        ...options.asks.queries,
      },
      asks: options.asks.commands,
    });
    await registerBreakdownRoutes(app, {
      queries: {
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
        listBreakdown: options.breakdown?.queries.listBreakdown ?? (async () => []),
      },
      breakdown: options.breakdown?.commands ?? null,
    });
    await registerCommandRoutes(app, {
      // The nine functions the command routes need, bound to this process's database here so
      // that module names none (`routes/commands.ts`'s `CommandQueries`).
      queries: {
        taskProjectId: async (taskId) => findTaskProjectId(options.database, taskId),
        runProjectId: async (runId) => findRunProjectId(options.database, runId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        taskPosition: async (taskId) => findTaskPosition(options.database, taskId),
        runPosition: async (runId) => findRunPosition(options.database, runId),
        taskTicketKey: async (taskId) => findTaskTicketKey(options.database, taskId),
        claimAttempt: async (query) => claimCommandAttempt(options.database, query),
        releaseAttempt: async (query) => releaseCommandAttempt(options.database, query),
        recordAction: async (input) => recordHumanAction(options.database, input),
      },
      commands: options.commands,
    });
    await registerRunRoutes(app, {
      queries: databaseRunQueries(options.database, options.projectSettings),
    });
    // WP-44: the transcript file and the take-over tarball, the two things product/19 §19 hands a
    // person besides the branch. Reads of what exists — `run_messages` and the shared export
    // volume — never a copy (Q93).
    await registerDownloadRoutes(app, {
      queries: {
        runProjectId: async (runId) => findRunProjectId(options.database, runId),
        projectRole: async (projectId, userId) =>
          findProjectRole(options.database, projectId, userId),
        transcriptPage: async (runId, after, limit) =>
          listRunMessages(options.database, runId, {
            limit,
            partials: false,
            ...(after === undefined ? {} : { after }),
          }),
      },
      exportDir: options.config.workspaceExportDir,
    });
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
