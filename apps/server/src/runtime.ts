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
 * ## A note for whoever registers the first event handler here
 * A handler that captures the bus and calls the **public** `dispatch()` self-deadlocks at
 * `APP_DISPATCH_MAX_CONCURRENCY=1`: the outer dispatch holds the only slot, and the inner one waits
 * for it. Only *chained* events — the ones a handler returns or appends through its transaction
 * scope — inherit the dispatcher's slot. Emit, never dispatch.
 */
import type { Logger } from '@platform/application';
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
import { createReadinessCheck } from './readiness.js';
import { roleCapabilities, roleIsIdle } from './role.js';
import { SseHub } from './sse/hub.js';

export interface ServerRuntime {
  readonly config: ServerConfig;
  readonly app: FastifyInstance;
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

  const database = dbAdapters.createDatabasePool(config.database);

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

    let jobsStarted = false;
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

      await eventing.worker.start();
      stopCallbacks.unshift({ name: 'eventing', stop: eventing.stop });
    }

    const auth = createAuth({ pool: database.pool, config });
    const hub = new SseHub({
      bufferSize: config.sseBufferSize,
      maxQueuedLiveFrames: config.sseMaxQueuedLiveFrames,
      maxTopicsPerConnection: config.sseMaxTopics,
      retryMs: config.sseRetryMs,
      pingIntervalMs: config.ssePingIntervalMs,
      maxConnections: config.sseMaxConnections,
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

    const app = await buildApp({
      config,
      logger,
      metrics,
      database: database.db,
      auth,
      hub,
      version: buildInfo(env),
      readiness: createReadinessCheck({
        database: database.db,
        jobsStarted: capabilities.worker ? () => jobsStarted : null,
      }),
      isShuttingDown: () => shuttingDown,
    });

    return {
      config,
      app,
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
