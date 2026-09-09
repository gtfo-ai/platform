/**
 * The pg-boss `Jobs` adapter (TD-004).
 *
 * pg-boss lives in the same database as everything else (`pgboss.*`, technical/03) and is
 * installed by the `migrate` entrypoint, not here: the runtime is constructed with
 * `migrate: false` and `createSchema: false` so an application container can never quietly
 * upgrade the schema out from under a running one (TD-019 — migrations are forward-only and run
 * by one service under an advisory lock).
 *
 * The mapping this file owns, and which the contract suite pins:
 *   timer     `startAfter: Date`                      → pg-boss `startAfter`
 *   coalesce  `{key, windowSeconds, throttle}`        → `singletonKey` + `singletonSeconds`
 *   coalesce  `{key, windowSeconds, trailing}`        → the same plus `singletonNextSlot`
 *   singleton `singletonKey` + a queue policy         → `singletonKey` on a policy queue
 *   cron      `{cron, timezone}`                      → `schedule(name, cron, data, {tz, key})`
 *
 * `send()` returning `null` — the slot is taken, or the queue policy already has a job for the key
 * — is reported as `coalesced`, which is a success: the work the caller asked for is scheduled.
 */
import type {
  CronSchedule,
  CronScheduleDefinition,
  EnqueueRequest,
  EnqueueResult,
  JobData,
  JobQueueDefinition,
  Jobs,
  JobsRuntime,
  JobWorker,
  WorkRequest,
} from '@platform/application';
import {
  assertEnqueueRequest,
  assertJobKey,
  assertJobName,
  JobsValidationError,
} from '@platform/application';
import { PgBoss } from 'pg-boss';

/** Default schema pg-boss is installed into — must match `db.DEFAULT_PGBOSS_SCHEMA`. */
export const DEFAULT_JOBS_SCHEMA = 'pgboss';

/** One job as the adapter sees it. A structural subset of pg-boss's `Job`. */
export interface PgBossJobRecord {
  readonly id: string;
  readonly name: string;
  readonly data: unknown;
  readonly signal: AbortSignal;
}

/** One schedule row as the adapter sees it. A structural subset of pg-boss's `Schedule`. */
export interface PgBossScheduleRecord {
  readonly name: string;
  readonly key: string;
  readonly cron: string;
  readonly timezone: string;
  readonly data?: unknown;
}

/**
 * The slice of pg-boss this adapter uses.
 *
 * It exists so the unit tier can drive every branch of the mapping above with a stub — the real
 * library needs a PostgreSQL 18 container, which belongs to the integration tier. `wrapPgBoss`
 * below is the only place the two are joined, and the integration suite runs the whole contract
 * against it.
 */
export interface PgBossLike {
  start: () => Promise<unknown>;
  stop: (options?: { close?: boolean; graceful?: boolean }) => Promise<void>;
  createQueue: (name: string, options: Record<string, unknown>) => Promise<void>;
  send: (
    name: string,
    data: object | null,
    options: Record<string, unknown>,
  ) => Promise<string | null>;
  work: (
    name: string,
    options: Record<string, unknown>,
    handler: (jobs: readonly PgBossJobRecord[]) => Promise<void>,
  ) => Promise<string>;
  offWork: (name: string, options?: { wait?: boolean }) => Promise<void>;
  schedule: (
    name: string,
    cron: string,
    data: object | null,
    options: Record<string, unknown>,
  ) => Promise<void>;
  unschedule: (name: string, key?: string) => Promise<void>;
  getSchedules: (name?: string) => Promise<readonly PgBossScheduleRecord[]>;
  on: (event: 'error', listener: (error: unknown) => void) => unknown;
}

/** The database handle pg-boss runs its SQL through. `pg.Pool` satisfies it via `asJobsDatabase`. */
export interface JobsDatabase {
  executeSql: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/** The slice of `pg.Pool` needed to build a `JobsDatabase`. */
export interface JobsPoolLike {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Runs pg-boss on an existing pool.
 *
 * Handing pg-boss the platform's own pool is what keeps the job runtime inside the least-privilege
 * role: `createDatabasePool` starts every connection as `APP_DB_APP_ROLE`, and pg-boss inherits
 * that rather than opening a second, more privileged pool of its own. The optional `listen`
 * capability is not implemented, so pg-boss polls — which TD-004 relies on anyway and which is the
 * only mode that survives a transaction-pooling PgBouncer.
 */
export const asJobsDatabase = (pool: JobsPoolLike): JobsDatabase => ({
  executeSql: async (text, values) => pool.query(text, values ?? []),
});

export interface PgBossJobsOptions {
  /** Database pg-boss runs on. Exactly one of `database` or `connectionString` is required. */
  readonly database?: JobsDatabase;
  readonly connectionString?: string;
  /** @default 'pgboss' */
  readonly schema?: string;
  /** Default polling interval for workers that do not set one. @default 2 */
  readonly pollingIntervalSeconds?: number;
  /**
   * How often pg-boss re-reads the schedule table. Lower makes a cron schedule take effect
   * sooner; pg-boss caps it at 45 s. @default 30
   */
  readonly cronMonitorIntervalSeconds?: number;
  /** Background maintenance (expired leases, retries, queue statistics). @default true */
  readonly supervise?: boolean;
  /**
   * How often the background passes run — supervision, archiving, monitoring and the queue
   * statistics cache. pg-boss exposes four separate intervals; the platform has no reason to tune
   * them independently, and one knob is what an operator can reason about. @default 60
   */
  readonly maintenanceIntervalSeconds?: number;
  /** Cron evaluation. Turn off in a replica that must not fire schedules. @default true */
  readonly schedule?: boolean;
  /**
   * Where pg-boss's background errors go. Defaults to `process.emitWarning`, which is visible
   * without pulling a logger into this ring; `apps/server` passes pino once it exists (WP-06).
   */
  readonly onError?: (error: unknown) => void;
  /** Test seam: an already-built pg-boss (or a stub). Bypasses every other connection option. */
  readonly pgBoss?: PgBossLike;
}

/** Adapts the real `PgBoss` to `PgBossLike`. The only place the two type systems meet. */
export const wrapPgBoss = (boss: PgBoss): PgBossLike => ({
  start: () => boss.start(),
  stop: (options) => boss.stop(options),
  createQueue: (name, options) => boss.createQueue(name, options),
  send: (name, data, options) => boss.send(name, data, options),
  work: (name, options, handler) =>
    boss.work<JobData>(name, options, async (jobs) => {
      await handler(jobs);
    }),
  offWork: (name, options) => boss.offWork(name, options),
  schedule: (name, cron, data, options) => boss.schedule(name, cron, data, options),
  unschedule: (name, key) => boss.unschedule(name, key),
  getSchedules: (name) => boss.getSchedules(name),
  on: (event, listener) => boss.on(event, listener),
});

const buildPgBoss = (options: PgBossJobsOptions): PgBossLike => {
  if (options.pgBoss !== undefined) {
    return options.pgBoss;
  }
  const hasDatabase = options.database !== undefined;
  const hasUrl = options.connectionString !== undefined && options.connectionString !== '';
  if (hasDatabase === hasUrl) {
    throw new JobsValidationError(
      'the pg-boss jobs adapter needs exactly one of `database` (an existing pool) or `connectionString`',
    );
  }
  return wrapPgBoss(
    new PgBoss({
      ...(options.database === undefined
        ? { connectionString: options.connectionString as string }
        : { db: options.database }),
      schema: options.schema ?? DEFAULT_JOBS_SCHEMA,
      // The migrate service owns the schema (TD-019). A runtime that could install or upgrade it
      // would race every other replica and defeat the advisory lock the migrator holds.
      migrate: false,
      createSchema: false,
      supervise: options.supervise ?? true,
      schedule: options.schedule ?? true,
      // Off, and not configurable. The queue-statistics history is stored in a table pg-boss
      // partitions by day, and the daily rollover runs `CREATE TABLE … PARTITION OF` from the
      // running application. The application role has USAGE but not CREATE on the `pgboss` schema
      // (WP-03's grants; asserted in the integration suite), so turning this on would work all day
      // and then start failing at UTC midnight, on the background `error` channel where it is easy
      // to miss. Enabling it is a migration change — see PROGRESS.md § Discovered work.
      persistQueueStats: false,
      ...(options.maintenanceIntervalSeconds === undefined
        ? {}
        : {
            superviseIntervalSeconds: options.maintenanceIntervalSeconds,
            maintenanceIntervalSeconds: options.maintenanceIntervalSeconds,
            monitorIntervalSeconds: options.maintenanceIntervalSeconds,
            queueCacheIntervalSeconds: options.maintenanceIntervalSeconds,
          }),
      ...(options.cronMonitorIntervalSeconds === undefined
        ? {}
        : {
            cronMonitorIntervalSeconds: options.cronMonitorIntervalSeconds,
            cronWorkerIntervalSeconds: Math.max(
              1,
              Math.min(45, options.cronMonitorIntervalSeconds),
            ),
          }),
    }),
  );
};

/** Strips `undefined` values so pg-boss sees "not set" rather than an explicit undefined. */
const defined = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

export const createPgBossJobs = (options: PgBossJobsOptions = {}): JobsRuntime => {
  const boss = buildPgBoss(options);
  const onError = options.onError ?? ((error: unknown) => process.emitWarning(String(error)));
  boss.on('error', onError);
  const defaultPollingSeconds = options.pollingIntervalSeconds ?? 2;

  const enqueue = async <TData extends JobData>(
    request: EnqueueRequest<TData>,
  ): Promise<EnqueueResult> => {
    assertEnqueueRequest(request);

    const sendOptions = defined({
      startAfter: request.startAfter,
      priority: request.priority,
      retryLimit: request.retryLimit,
      expireInSeconds: request.expireInSeconds,
      deadLetter: request.deadLetterQueue,
      singletonKey: request.coalesce?.key ?? request.singletonKey,
      singletonSeconds: request.coalesce?.windowSeconds,
      // `singletonNextSlot` adds the one trailing job: on a slot collision pg-boss retries the
      // insert in the next slot (overwriting `startAfter` with its boundary) instead of dropping
      // the send. Still leading-edge — the first job of a burst runs immediately either way.
      ...(request.coalesce === undefined
        ? {}
        : {
            singletonNextSlot: (request.coalesce.mode ?? 'throttle') === 'throttle_with_trailing',
          }),
    });

    const jobId = await boss.send(request.queue, request.data ?? null, sendOptions);
    return jobId === null ? { status: 'coalesced', jobId: null } : { status: 'enqueued', jobId };
  };

  const jobs: Jobs = {
    defineQueue: async (definition: JobQueueDefinition) => {
      assertJobName(definition.name);
      if (definition.deadLetterQueue !== undefined) {
        assertJobName(definition.deadLetterQueue, 'dead letter queue name');
      }
      await boss.createQueue(
        definition.name,
        defined({
          policy: definition.policy,
          retryLimit: definition.retryLimit,
          retryDelay: definition.retryDelaySeconds,
          retryBackoff: definition.retryBackoff,
          expireInSeconds: definition.expireInSeconds,
          deleteAfterSeconds: definition.deleteAfterSeconds,
          deadLetter: definition.deadLetterQueue,
        }),
      );
    },

    enqueue,

    scheduleCron: async (definition: CronScheduleDefinition) => {
      assertJobName(definition.queue);
      const key = definition.key ?? '';
      if (key !== '') {
        assertJobKey(key, 'schedule key');
      }
      if (definition.timezone.trim() === '') {
        throw new JobsValidationError('a cron schedule must name the time zone it is read in');
      }
      await boss.schedule(definition.queue, definition.cron, definition.data ?? null, {
        tz: definition.timezone,
        key,
      });
    },

    unscheduleCron: async (queue, key = '') => {
      assertJobName(queue);
      await boss.unschedule(queue, key);
    },

    listCronSchedules: async (queue) => {
      const rows = await boss.getSchedules(queue);
      return rows
        .filter((row) => queue === undefined || row.name === queue)
        .map(
          (row): CronSchedule => ({
            queue: row.name,
            key: row.key ?? '',
            cron: row.cron,
            timezone: row.timezone,
            ...(row.data === undefined || row.data === null ? {} : { data: row.data as JobData }),
          }),
        )
        .sort((left, right) =>
          `${left.queue}/${left.key}`.localeCompare(`${right.queue}/${right.key}`),
        );
    },

    work: async <TData extends JobData>(request: WorkRequest<TData>): Promise<JobWorker> => {
      assertJobName(request.queue);
      const handler = request.handler as unknown as (job: {
        id: string;
        queue: string;
        data: TData;
        signal: AbortSignal;
      }) => Promise<void>;

      await boss.work(
        request.queue,
        defined({
          // batchSize 1 keeps the port's one-job-per-handler contract: a batch settles as a unit,
          // so one poisonous job would otherwise retry its innocent neighbours with it.
          batchSize: 1,
          pollingIntervalSeconds: request.pollingIntervalSeconds ?? defaultPollingSeconds,
          localConcurrency: request.concurrency,
        }),
        async (received) => {
          for (const job of received) {
            await handler({
              id: job.id,
              queue: job.name,
              data: (job.data ?? {}) as TData,
              signal: job.signal,
            });
          }
        },
      );

      return {
        queue: request.queue,
        stop: async () => {
          await boss.offWork(request.queue, { wait: true });
        },
      };
    },
  };

  return {
    jobs,
    start: async () => {
      await boss.start();
    },
    stop: async () => {
      await boss.stop({ close: true, graceful: true });
    },
  };
};
