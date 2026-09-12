/**
 * The composition root (technical/01: "`apps/server` — Fastify composition root").
 *
 * Everything the process owns is constructed here, in dependency order, and torn down in the
 * reverse one. Nothing below `apps/` reaches for a singleton, which is what lets the e2e tier run
 * two whole instances in one process.
 *
 * ## Start-up order, and why
 * 1. **Configuration**, validated whole (`config.ts`). A process that starts has a valid config.
 * 2. **Logger and metrics** — before anything that can fail, so the failure is logged structurally.
 * 3. **Pool.** Every connection starts as the least-privilege role (WP-03).
 * 4. **Eventing** (`createEventing`), which refuses a pool too small for the dispatcher.
 * 5. **Jobs**, on the same pool via `asJobsDatabase`, with pino as pg-boss's `onError` — pg-boss
 *    reports background failures on an `error` channel, and the default (`process.emitWarning`)
 *    puts them somewhere no log aggregator looks.
 * 6. **Partition maintenance** (`registerPartitionMaintenance`). WP-03 built the daily cron and
 *    WP-05 the registration; until this call existed, nothing ran it, and a long-lived instance
 *    would eventually insert into a month with no partition. Its worker joins the shutdown.
 * 7. **Outbox worker**, then **auth**, **SSE hub**, **HTTP**.
 *
 * ## Shutdown order (TD-002)
 * `readyz` 503 → Fastify `preClose` drains the SSE streams with a `shutdown` frame → Fastify closes
 * the server → the outbox worker and dispatcher drain → the partition-maintenance worker stops →
 * pg-boss stops → the pool closes. That is the reverse of start-up, which is the point: draining
 * the streams after closing the sockets drains nothing, stopping pg-boss before the dispatcher has
 * finished would strand an in-flight handler, and closing the pool before the workers stop turns a
 * clean drain into a burst of connection errors. `stopCallbacks` is built with `unshift`, so the
 * reversal is structural rather than a list somebody has to keep in the right order by hand.
 *
 * What `stop()` does **not** promise is that every socket is gone when it resolves: pg-pool fires
 * its end callback as soon as its client list is empty, without waiting for the `client.end()`
 * calls it just made. So a connection of this instance can still be attached for a few
 * milliseconds afterwards, and receive a FATAL. That is why the pool carries an `'error'` listener
 * (`packages/infrastructure/src/db/pool-errors.ts`); it cost a CI job before it did.
 *
 * ## A note for whoever registers the first event handler here
 * A handler that captures the bus and calls the **public** `dispatch()` self-deadlocks at
 * `APP_DISPATCH_MAX_CONCURRENCY=1`: the outer dispatch holds the only slot, and the inner one waits
 * for it. Only *chained* events — the ones a handler returns or appends through its transaction
 * scope — inherit the dispatcher's slot. Emit, never dispatch.
 */
import type { Jobs, Logger, WebhookIngress } from '@platform/application';
import { sweepReadiness } from '@platform/application';
import {
  db as dbAdapters,
  eventing as eventingAdapters,
  jobs as jobsAdapters,
} from '@platform/infrastructure';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from './app.js';
import { createAuth } from './auth/better-auth.js';
import { bootstrapAdministrator } from './auth/bootstrap.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { asLoggerPort, createLogger, type PinoLogger } from './logging.js';
import { createMetrics, type Metrics } from './metrics.js';
import {
  composeIntegrationStack,
  composePipeline,
  composeWebhookIngress,
  type PipelineComposition,
} from './pipeline.js';
import { createReadinessCheck } from './readiness.js';
import { roleCapabilities, roleIsIdle } from './role.js';
import { SseHub } from './sse/hub.js';

export interface ServerRuntime {
  readonly config: ServerConfig;
  readonly app: FastifyInstance;
  /**
   * The job runtime this process started, or `null` for a role that starts none (`ROLE=api`).
   *
   * A **labelled seam**, and the only caller is the e2e tier (WP-15d): a job is at-least-once and
   * pg-boss re-delivers one whose lease expired, and there is no other way to ask a running
   * instance "what happens when the same wake-up arrives twice?" — which is the question that makes
   * the idempotency store `composePipeline` builds load-bearing rather than merely supplied
   * (standing rule 35). Exposed rather than reached for through pg-boss's own tables, so the test
   * enqueues through the same adapter the pipeline does.
   */
  readonly jobs: Jobs | null;
  readonly logger: PinoLogger;
  readonly metrics: Metrics;
  readonly hub: SseHub;
  readonly pool: pg.Pool;
  /** The address the HTTP server is listening on, once `listen()` has run. */
  listen(): Promise<string>;
  stop(): Promise<void>;
}

export interface StartRuntimeOptions {
  readonly config?: ServerConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Test seam: pino writes here instead of stdout. */
  readonly logDestination?: Parameters<typeof createLogger>[0]['destination'];
  /**
   * Overrides for the pipeline composition, or `null` to start no pipeline at all.
   *
   * **Absent is the production path and it composes the pipeline** (WP-15b). WP-15a had to take the
   * audit sink as an argument because nothing implemented `IntegrationAuditLog`; migration `0013`
   * and `@platform/infrastructure`'s adapters closed that, so `startRuntime()` — the call
   * `main.ts:18` and `scripts/dev.mjs` make, with no options at all — now builds a real one. What
   * a caller may still replace is listed on {@link PipelineComposition}: the agent runner (Q52) and
   * the provider registry.
   *
   * **`null` is a seam, and it is labelled as one.** No production path passes it: `pipeline.ts`
   * can compose from a pool alone. It exists because `sweepReadiness` — the gate that stops a
   * partial consumer from completing another process's dispatch, and the predicate behind
   * `/readyz`'s `dispatch` check — has no other way to be driven end-to-end once `apps/server`
   * always registers the full handler set, and the failure it guards (a build whose registry drifts
   * from `EVENT_CONSUMPTION`) is real. `test/e2e/pipeline/uncomposed.e2e.test.ts` is its only user.
   */
  readonly pipeline?: PipelineComposition | null;
}

/** Build metadata; a container image sets these, a checkout has none. */
const buildInfo = (env: Readonly<Record<string, string | undefined>>) => ({
  version: env.APP_VERSION?.trim() || '0.0.0-dev',
  commit: env.APP_COMMIT?.trim() || null,
  builtAt: env.APP_BUILT_AT?.trim() || null,
});

export const startRuntime = async (options: StartRuntimeOptions = {}): Promise<ServerRuntime> => {
  const env = options.env ?? process.env;
  const config = options.config ?? loadServerConfig(env);
  const capabilities = roleCapabilities(config.role);

  const logger = createLogger({
    level: config.logLevel,
    format: config.logFormat,
    role: config.role,
    ...(options.logDestination === undefined ? {} : { destination: options.logDestination }),
  });
  const loggerPort: Logger = asLoggerPort(logger);

  logger.info(
    {
      role: config.role,
      capabilities: { api: capabilities.api, worker: capabilities.worker },
      unimplemented: capabilities.unimplemented,
      port: config.port,
      base_url: config.baseUrl,
    },
    'starting',
  );
  if (capabilities.unimplemented.length > 0) {
    logger.warn(
      { role: config.role, unimplemented: capabilities.unimplemented },
      'this ROLE names workloads no work package has built yet; the process will not run them',
    );
  }
  if (roleIsIdle(config.role)) {
    logger.warn(
      { role: config.role },
      'this ROLE serves only the ops endpoints in this build: no API and no workers',
    );
  }

  const database = dbAdapters.createDatabasePool(config.database, loggerPort);

  let shuttingDown = false;
  const stopCallbacks: { name: string; stop: () => Promise<void> }[] = [];

  try {
    const eventing = eventingAdapters.createEventing({
      pool: database.pool,
      connectionString: config.database.url,
      config: config.dispatch,
      logger: loggerPort,
    });

    const metrics = createMetrics({
      ...(capabilities.worker
        ? { pendingDispatch: async () => eventing.store.countPendingDispatch() }
        : {}),
    });

    /**
     * One executor, one audit sink, one provider registry — **for the whole process**, because both
     * directions need them (WP-15c).
     *
     * The pipeline builds provider adapters to *call* and the webhook ingress builds them to
     * *read*, and both go through the same registration. Two stacks would mean two idempotency
     * stores and two rate-limit budgets for one account, which is the duplication
     * `shipped-registry.ts` already records for Jira's inner executor — so it is built once, here,
     * and shared. It is `null` only for a role that serves neither the API nor the workers.
     */
    const stack =
      capabilities.api || capabilities.worker
        ? composeIntegrationStack({
            pool: database.pool,
            eventing,
            ...(options.pipeline?.registry === undefined
              ? {}
              : { registry: options.pipeline.registry }),
            logger: loggerPort,
          })
        : null;

    let jobsStarted = false;
    let jobs: Jobs | null = null;
    if (capabilities.worker) {
      const jobsRuntime = jobsAdapters.createPgBossJobs({
        database: jobsAdapters.asJobsDatabase(database.pool),
        schema: config.jobs.schema,
        pollingIntervalSeconds: config.jobs.pollingIntervalSeconds,
        cronMonitorIntervalSeconds: config.jobs.cronMonitorIntervalSeconds,
        // pg-boss reports background failures here; the default writes a process warning, which no
        // log aggregator collects.
        onError: (error: unknown) => {
          logger.error({ err: error, component: 'pg-boss' }, 'job runtime error');
        },
      });
      // `boss.start()` needs the `pgboss` schema the migrate service installed: the adapter runs
      // with `migrate: false, createSchema: false` so a runtime can never race the migrator.
      await jobsRuntime.start();
      jobsStarted = true;
      jobs = jobsRuntime.jobs;
      stopCallbacks.unshift({
        name: 'jobs',
        stop: async () => {
          jobsStarted = false;
          await jobsRuntime.stop();
        },
      });

      // WP-03 built the daily partition cron and WP-05 the registration; this call is what makes
      // it run. Without it a long-lived instance eventually inserts into a month with no partition.
      const maintenance = await jobsAdapters.registerPartitionMaintenance(jobsRuntime.jobs, {
        db: database.pool,
        partitionMonthsAhead: config.database.partitionMonthsAhead,
        timezone: config.timezone,
        onResult: (result) => {
          logger.info(
            { created: result.created, dropped: result.dropped },
            'partition maintenance ran',
          );
        },
      });
      stopCallbacks.unshift({
        name: 'partition-maintenance',
        stop: async () => maintenance.stop(),
      });

      // Before `worker.start()`, and that ordering is the point: the first sweep dispatches to
      // whatever is registered on the bus, so a pipeline registered afterwards would miss the
      // events the sweep had already marked handled.
      if (options.pipeline === null) {
        // The labelled seam on `StartRuntimeOptions.pipeline`. Nothing in production reaches here.
        logger.warn(
          { seam: 'pipeline: null' },
          'this process was started with the pipeline disabled: no ticket will advance, and the outbox sweep below will refuse to start because the bus is an incomplete consumer',
        );
      } else {
        const pipeline = await composePipeline({
          composition: options.pipeline ?? {},
          pool: database.pool,
          eventing,
          jobs: jobsRuntime.jobs,
          secretKey: config.secretKey,
          stageConcurrency: 1,
          intakeReconcileIntervalMs: config.intakeReconcileIntervalMs,
          // Non-null on this branch by construction: `capabilities.worker` is what got us here and
          // it is one of the two conditions the stack is built under.
          stack: stack as NonNullable<typeof stack>,
          agent: {
            providerMode: config.providerMode,
            modelApiKey: config.modelApiKey,
            claudeBinary: config.claudeBinary,
          },
          logger: loggerPort,
        });
        stopCallbacks.unshift({ name: 'pipeline', stop: pipeline.stop });
        /**
         * **Which piece is missing, by name** (WP-15g, Q59(b)).
         *
         * `composePipeline` answers with a list rather than a boolean, so this warning names the
         * thing an operator has to supply instead of restating that something is absent. A process
         * with no launcher configuration is a legitimate deployment — it runs the gates, the status
         * mapping, the workpad and every outbound provider call — so it warns rather than refusing to
         * start, and an agent stage that reaches it fails in its own job and escalates the task.
         */
        if (pipeline.agentMissing.length > 0) {
          logger.warn(
            { missing: pipeline.agentMissing },
            'the pipeline is composed without an agent runner: everything except an agent stage runs and is audited, and a stage that needs an agent fails its run and escalates its task',
          );
        }
      }

      /**
       * **A process that sweeps must be a complete consumer** (TD-005's WP-15a amendment).
       *
       * `EventBus.dispatch` treats "no handler matched" as a completed dispatch: it calls
       * `dispatchQueue.complete(position)`, which **deletes** the `event_dispatch` row, and writes
       * the `$dispatch` marker that makes a later re-dispatch a deliberate no-op. That is correct at
       * the dispatch site and unchanged — leaving the event queued would make `hasEarlierPending`
       * block every later event of the same stream. What is not correct is this process *sweeping*
       * when it cannot handle what it takes: the queue holds one row per event for the **whole
       * deployment**, so completing a dispatch discharges every handler in it, and a partial
       * consumer destroys another process's work item exactly as an empty one does.
       *
       * Round 2 asked that question with `registry.size === 0`, which is standing rule 56: the false
       * branch of a whole-registry predicate does not enumerate what a per-type question needs. The
       * arbiter is now `sweepReadiness`, over the types `EVENT_CONSUMPTION` declares consumed — and
       * it is the **same** call `/readyz` makes below, because two readings of one condition drift
       * (rule 41).
       *
       * The cost of not sweeping is stated rather than hidden: the queue grows,
       * `event_dispatch_pending` is the gauge that shows it, and `/readyz` is `down`.
       */
      const sweep = sweepReadiness(eventing.bus.registry);
      if (!sweep.ready) {
        logger.warn(
          { missing_handlers: sweep.missing },
          'this process cannot handle every event the platform declares consumed, so the outbox sweep is not started: sweeping would complete those events for the whole deployment',
        );
      } else {
        await eventing.worker.start();
      }
      stopCallbacks.unshift({ name: 'eventing', stop: eventing.stop });
    }

    const auth = createAuth({ pool: database.pool, config });
    const hub = new SseHub({
      bufferSize: config.sseBufferSize,
      maxQueuedFrames: config.sseMaxQueuedFrames,
      maxTopicsPerConnection: config.sseMaxTopics,
      maxBufferedTopics: config.sseMaxBufferedTopics,
      retryMs: config.sseRetryMs,
      pingIntervalMs: config.ssePingIntervalMs,
      maxConnections: config.sseMaxConnections,
      shutdownDrainMs: config.sseShutdownDrainMs,
      logger: loggerPort,
      onFrameSent: (kind) => {
        metrics.sseFramesSent.inc({ frame: kind });
      },
    });

    if (capabilities.api) {
      await bootstrapAdministrator({
        pool: database.pool,
        database: database.db,
        config,
        logger: loggerPort,
      });
    }

    /**
     * The door production starts a ticket through (WP-15c).
     *
     * Composed whenever this role serves the API — including under the `pipeline: null` seam, which
     * is a statement about the *handlers* this process registers and not about whether it may
     * receive a delivery. A role that serves no API has no ingress and therefore no route, which is
     * what makes "this URL 404s" mean "wrong URL" rather than "right URL, wrong container".
     */
    const webhooks: WebhookIngress | null =
      capabilities.api && stack !== null
        ? composeWebhookIngress({
            pool: database.pool,
            eventing,
            secretKey: config.secretKey,
            stack,
            logger: loggerPort,
          })
        : null;
    if (capabilities.api && webhooks === null) {
      logger.warn(
        { missing: 'integration stack' },
        'this process serves the API and composes no webhook ingress: no provider delivery can reach it',
      );
    }

    const app = await buildApp({
      config,
      logger,
      metrics,
      database: database.db,
      auth,
      hub,
      webhooks,
      version: buildInfo(env),
      readiness: createReadinessCheck({
        database: database.db,
        jobsStarted: capabilities.worker ? () => jobsStarted : null,
        // The same predicate the sweep gate uses, deliberately (rule 41): a process that refused to
        // start the sweep must not report ready to do the work it refused. `null` for `ROLE=api`,
        // which legitimately runs no dispatcher at all.
        dispatchReady: capabilities.worker
          ? () => sweepReadiness(eventing.bus.registry).ready
          : null,
      }),
      isShuttingDown: () => shuttingDown,
    });

    return {
      config,
      app,
      jobs,
      logger,
      metrics,
      hub,
      pool: database.pool,
      listen: async () => app.listen({ port: config.port, host: config.host }),
      stop: async () => {
        if (shuttingDown) {
          return;
        }
        // Set first: `/readyz` answers 503 from here on, so a load balancer stops sending traffic
        // before the first connection is closed.
        shuttingDown = true;
        logger.info({}, 'shutting down');

        // Fastify's `preClose` drains the SSE streams; `close()` then finishes in-flight requests.
        await app.close();
        for (const callback of stopCallbacks) {
          try {
            await callback.stop();
          } catch (error) {
            logger.error({ err: error, component: callback.name }, 'shutdown step failed');
          }
        }
        await database.close();
        logger.info({}, 'stopped');
      },
    };
  } catch (error) {
    // A failure part-way through start-up must not leave a pool, a pg-boss or a worker behind:
    // the process is about to exit, but a test harness starting a second runtime is not.
    for (const callback of stopCallbacks) {
      await callback.stop().catch(() => {});
    }
    await database.close().catch(() => {});
    throw error;
  }
};
