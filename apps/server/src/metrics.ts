/**
 * Prometheus metrics (TD-023): `@prometheus-io/client` on `/metrics`.
 *
 * Only metrics with a real source are registered. TD-023 also names `agent_runs_active`,
 * `agent_tokens_total`, `agent_cost_usd_total` and `queue_job_age_seconds` (the last is
 * `jobs_queued_oldest_age_seconds` since WP-86, per queue); nothing produces those
 * numbers until the runner (WP-12) and the cost ledger (WP-19) exist, and a gauge that is
 * permanently zero is worse than a missing one — it reads as "no runs are active" rather than "the
 * platform cannot answer". They are added by the work packages that can feed them.
 *
 * The registry is built per server rather than being the library's global one: two servers in one
 * test process would otherwise fight over metric names, and `register.clear()` between tests is
 * exactly the kind of shared mutable state a suite trips over.
 */
import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  type Registry as PromRegistry,
  Registry,
} from '@prometheus-io/client';

export interface Metrics {
  readonly registry: PromRegistry;
  /** HTTP server request duration, the histogram TD-023 names. */
  readonly httpRequestDuration: Histogram<'method' | 'route' | 'status_code'>;
  /** Streams currently open on `GET /events`. */
  readonly sseConnections: Gauge<'state'>;
  /** SSE frames written, by frame kind — the counter that shows replay actually replaying. */
  readonly sseFramesSent: Counter<'frame'>;
  /**
   * Webhook deliveries answered 429 by the per-integration bucket, by provider (WP-87, Q60) — the
   * record of a limited delivery, which writes no row by design.
   */
  readonly webhookDeliveriesRateLimited: Counter<'provider'>;
  /** Events committed but not yet dispatched (TD-005's `event_dispatch` backlog). */
  readonly eventDispatchPending: Gauge<never>;
  /** Events that spent their dispatch attempt bound and left the queue (WP-49). */
  readonly eventDispatchDeadLettered: Gauge<never>;
  /** Notifications nobody was told about past their own retry window, by plan (WP-65). */
  readonly notificationsUndelivered: Gauge<'planned'>;
  /** The instance's storage, by component, and the total of the components it names (WP-65). */
  readonly storageBytes: Gauge<'component'>;
  readonly storageTotalBytes: Gauge<'components'>;
  /** One knowledge mirror's bytes, per project (WP-65, Q63). */
  readonly knowledgeMirrorBytes: Gauge<'project_id'>;
  /** Command claims nobody completed past their in-flight window, by action (WP-73). */
  readonly commandClaimsUnknown: Gauge<'action'>;
  /** Ready, unclaimed pg-boss jobs per declared queue (WP-86, TD-028's Consequences). */
  readonly jobsQueued: Gauge<'queue'>;
  /** How long the oldest of them has been eligible, per queue that has one (WP-86). */
  readonly jobsQueuedOldestAge: Gauge<'queue'>;
  /** Sets the gauges that have to be sampled rather than incremented. Called on scrape. */
  readonly collect: () => Promise<void>;
}

export interface MetricsOptions {
  /** Sampled on every scrape; absent when this process runs no dispatcher (`ROLE=api`). */
  readonly pendingDispatch?: () => Promise<number>;
  /** The same, for the dead letters (WP-49). Absent and present together with `pendingDispatch`. */
  readonly deadLettered?: () => Promise<number>;
  /**
   * The undelivered notifications past their plan's retry window (WP-65, PROGRESS backlog 81).
   * Absent and present together with `pendingDispatch`: it is the notify band's half of the same
   * question — *what did the platform decide to do and not do* — and is registered beside it.
   */
  readonly undeliveredNotifications?: () => Promise<{
    readonly immediate: number;
    readonly digest: number;
  }>;
  /**
   * The storage gauge's two lines (WP-65, Q63, product/19 §20): the database's bytes, and the
   * knowledge mirrors' — `null` for a process with no `APP_KNOWLEDGE_MIRROR_ROOT`, which then
   * exports the database line alone and **no total**, because a total that silently left the
   * mirrors out is the one-number-and-then-out-of-disk-somewhere-else answer Q63 refuses.
   */
  readonly storage?: {
    readonly database: () => Promise<number>;
    readonly mirrors:
      | (() => Promise<{
          readonly totalBytes: number;
          readonly mirrors: readonly { readonly projectId: string; readonly bytes: number }[];
        } | null>)
      | null;
  };
  /**
   * The `command_idempotency` claims left uncompleted past `CLAIM_IN_FLIGHT_MS`, by action (WP-73,
   * PROGRESS backlog 241). Absent in a process that serves no command.
   */
  readonly staleCommandClaims?: () => Promise<
    readonly { readonly action: string; readonly claims: number }[]
  >;
  /**
   * The job queues' backlog (WP-86, PROGRESS backlog 135): per declared queue, the jobs that are
   * ready and unclaimed, and the age of the oldest (`null` when none waits). Read from pg-boss's
   * tables, so it is the **instance's** backlog and every process that samples it reads the same
   * numbers. Absent in a process that holds no job client.
   */
  readonly jobQueues?: () => Promise<
    readonly {
      readonly queue: string;
      readonly queued: number;
      readonly oldestAgeSeconds: number | null;
    }[]
  >;
  /**
   * Told when an isolated sampler throws (WP-65 review round 2): its series is then absent from the
   * scrape, and without a log line an operator could not tell a failing measurement from a gauge
   * this process never registers.
   */
  readonly onSamplerError?: (
    sampler: 'undelivered_notifications' | 'storage' | 'stale_command_claims' | 'job_queues',
    error: unknown,
  ) => void;
  /** Node process metrics (heap, event loop lag, handles). @default true */
  readonly defaultMetrics?: boolean;
}

/** The label value of the total: the components it is the sum of, so a reader need not guess. */
export const STORAGE_TOTAL_COMPONENTS = 'database+knowledge_mirrors';

/** Buckets for a web API: sub-millisecond is noise, anything over 10 s is one bucket. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export const createMetrics = (options: MetricsOptions = {}): Metrics => {
  const registry = new Registry();
  if (options.defaultMetrics !== false) {
    collectDefaultMetrics({ register: registry });
  }

  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  const sseConnections = new Gauge({
    name: 'sse_connections',
    help: 'Server-sent-event streams currently open, by state.',
    labelNames: ['state'] as const,
    registers: [registry],
  });

  const sseFramesSent = new Counter({
    name: 'sse_frames_sent_total',
    help: 'SSE frames written to clients, by frame kind (live, replay or control).',
    labelNames: ['frame'] as const,
    registers: [registry],
  });

  const webhookDeliveriesRateLimited = new Counter({
    name: 'webhook_deliveries_rate_limited_total',
    help: 'Webhook deliveries answered 429 by their integration’s rate limit, before any signature check, by provider.',
    labelNames: ['provider'] as const,
    registers: [registry],
  });

  const eventDispatchPending = new Gauge({
    name: 'event_dispatch_pending',
    help: 'Events committed to the log but not yet dispatched (TD-005).',
    // Registered only where something samples it. An unlabelled gauge exports `0` from the moment
    // it is created, so a process with no dispatcher (`ROLE=api`) would publish a permanent
    // "backlog: 0" that reads as a measurement rather than as an absence — and an alert built on
    // it would be quietly blind. A metric this process cannot measure is one it does not export.
    registers: options.pendingDispatch === undefined ? [] : [registry],
  });

  /**
   * The number that tells a poisoned event from a busy queue (WP-49, criterion 4).
   *
   * `event_dispatch_pending` cannot: a backlog of one is what a poisoned event and a momentary
   * burst both look like, and the poisoned one is the only one that never clears. This counts the
   * rows the dispatcher gave up on, and the two together are the whole queue table —
   * `countPendingDispatch` excludes exactly what this includes.
   *
   * **A sampled gauge rather than a `_total` counter**, deliberately. A counter would reset with
   * the process, so an event dead-lettered before a restart would be invisible in the one metric
   * that exists to say *something is poisoned right now*; the queue row is durable and the count of
   * it is the honest reading. It also falls back to zero when an operator requeues a row by hand,
   * which is what an operator who did that expects to see.
   *
   * Registered only where something samples it, for the reason stated on the gauge above.
   */
  const eventDispatchDeadLettered = new Gauge({
    name: 'event_dispatch_dead_lettered',
    help: 'Events that spent APP_DISPATCH_MAX_ATTEMPTS and left the dispatch queue (WP-49).',
    registers: options.deadLettered === undefined ? [] : [registry],
  });

  /**
   * **Notifications nobody was told about** (WP-65, PROGRESS backlog 81) — a metric, not a screen.
   *
   * `delivered_at` is the only column that says a human was told, and until this gauge nothing
   * read it to ask who was not. It counts undelivered rows **older than their plan's own retry
   * window** (`undeliveredNotificationBounds`), so a delivery still in flight or a digest line held
   * until the morning is not a failure here. On the shipped defaults (quiet hours off) the
   * `immediate` series is exactly the failures nothing will retry: a revoked chat token shows up
   * here instead of as an absence of messages.
   *
   * Labelled, so a process that does not sample it exports no series at all rather than a `0` that
   * reads as a measurement.
   */
  const notificationsUndelivered = new Gauge({
    name: 'notifications_undelivered',
    help: 'Chat notifications not delivered after their plan’s retry window (immediate: pipeline.outbound; digest: a day plus the digest job), by planned delivery (WP-65).',
    labelNames: ['planned'] as const,
    registers: options.undeliveredNotifications === undefined ? [] : [registry],
  });

  /**
   * **The storage gauge** (WP-65, Q63, product/19 §20): database and knowledge-mirror bytes as two
   * lines under one total, the mirrors broken down per project.
   *
   * Two lines because they grow for different reasons — the database with the platform's own
   * activity (transcripts, events), a mirror with the size of a customer's repository — and an
   * operator who sees one number and then runs out of disk somewhere else has been told the wrong
   * thing. The total is labelled with the components it sums and exported **only** when both were
   * measured on this scrape.
   */
  const storageBytes = new Gauge({
    name: 'platform_storage_bytes',
    help: 'Bytes the instance stores, by component: database (pg_database_size) and knowledge_mirrors (APP_KNOWLEDGE_MIRROR_ROOT, allocated bytes) (WP-65).',
    labelNames: ['component'] as const,
    registers: options.storage === undefined ? [] : [registry],
  });
  const storageTotalBytes = new Gauge({
    name: 'platform_storage_total_bytes',
    help: 'The sum of the platform_storage_bytes components named in the label; exported only when every one of them was measured (WP-65).',
    labelNames: ['components'] as const,
    registers: options.storage?.mirrors == null ? [] : [registry],
  });
  const knowledgeMirrorBytes = new Gauge({
    name: 'knowledge_mirror_bytes',
    help: 'One project’s bare knowledge mirror under APP_KNOWLEDGE_MIRROR_ROOT, allocated bytes (WP-65, Q63).',
    labelNames: ['project_id'] as const,
    registers: options.storage?.mirrors == null ? [] : [registry],
  });

  /**
   * **Commands whose outcome nobody can state** (WP-73, PROGRESS backlog 241). A claim older than
   * `CLAIM_IN_FLIGHT_MS` with no `completed_at` is a process that died mid-command; its key answers
   * `409 idempotency_attempt_unknown` for good and the caller alone would otherwise know. A non-zero
   * value asks a human to check the resource the action names — never to delete the row, which
   * re-opens the double-perform WP-67 closed (`docs/operator-guide.md`).
   */
  const commandClaimsUnknown = new Gauge({
    name: 'command_idempotency_claims_unknown',
    help: 'Command idempotency claims left uncompleted past CLAIM_IN_FLIGHT_MS — a process died mid-command, so whether it performed is unknown — by action (WP-73).',
    labelNames: ['action'] as const,
    registers: options.staleCommandClaims === undefined ? [] : [registry],
  });

  /**
   * **The job-queue backlog** TD-028's Consequences section promised (WP-86, PROGRESS backlog 135):
   * *"the queue depth is a metric"*. A deployment with no runner leaves `stage.execute` jobs queued,
   * and until this gauge nothing on `/metrics` could tell that queue from any other — the two
   * `event_dispatch_*` gauges count TD-005's event queue, not pg-boss's jobs.
   *
   * Ready means **eligible now and unclaimed** (`created` or `retry`, `start_after` passed): a
   * deferred timer is not backlog. Every declared queue has a `jobs_queued` series, `0` included,
   * because a count of zero is a measurement; the age series exists only for a queue with something
   * waiting, because there is no age of nothing (standing rule 16). Labelled, so a process that does
   * not sample it exports no series at all.
   */
  const jobsQueued = new Gauge({
    name: 'jobs_queued',
    help: 'pg-boss jobs ready to run and not yet claimed (state created or retry, start_after passed), per declared queue (WP-86).',
    labelNames: ['queue'] as const,
    registers: options.jobQueues === undefined ? [] : [registry],
  });
  const jobsQueuedOldestAge = new Gauge({
    name: 'jobs_queued_oldest_age_seconds',
    help: 'Seconds the oldest ready, unclaimed job of the queue has been eligible; no series for a queue with none waiting (WP-86).',
    labelNames: ['queue'] as const,
    registers: options.jobQueues === undefined ? [] : [registry],
  });

  /** The storage gauge's reading: every series rebuilt from this scrape (WP-65). */
  const sampleStorage = async (storage: NonNullable<MetricsOptions['storage']>): Promise<void> => {
    const database = await storage.database();
    storageBytes.set({ component: 'database' }, database);
    if (storage.mirrors === null) {
      return;
    }
    const mirrors = await storage.mirrors();
    // Every series is rebuilt from this scrape's reading, so an evicted mirror's line disappears
    // rather than keeping its last value, and an unreadable root exports no mirror line and no
    // total — absent, not zero (standing rule 16).
    knowledgeMirrorBytes.reset();
    storageTotalBytes.reset();
    if (mirrors === null) {
      storageBytes.remove({ component: 'knowledge_mirrors' });
      return;
    }
    storageBytes.set({ component: 'knowledge_mirrors' }, mirrors.totalBytes);
    for (const mirror of mirrors.mirrors) {
      knowledgeMirrorBytes.set({ project_id: mirror.projectId }, mirror.bytes);
    }
    storageTotalBytes.set({ components: STORAGE_TOTAL_COMPONENTS }, database + mirrors.totalBytes);
  };

  return {
    registry,
    httpRequestDuration,
    sseConnections,
    sseFramesSent,
    webhookDeliveriesRateLimited,
    eventDispatchPending,
    eventDispatchDeadLettered,
    notificationsUndelivered,
    storageBytes,
    storageTotalBytes,
    knowledgeMirrorBytes,
    commandClaimsUnknown,
    jobsQueued,
    jobsQueuedOldestAge,
    collect: async () => {
      if (options.pendingDispatch !== undefined) {
        eventDispatchPending.set(await options.pendingDispatch());
      }
      if (options.deadLettered !== undefined) {
        eventDispatchDeadLettered.set(await options.deadLettered());
      }
      /**
       * The WP-65 samplers are each **isolated** (review round 1): one that throws exports no series
       * for its gauges — absent, never a stale value or a zero (standing rule 16) — and does not
       * fail the scrape, so an unreadable mirror root cannot take `event_dispatch_pending` with it.
       */
      if (options.undeliveredNotifications !== undefined) {
        try {
          const counts = await options.undeliveredNotifications();
          notificationsUndelivered.set({ planned: 'immediate' }, counts.immediate);
          notificationsUndelivered.set({ planned: 'digest' }, counts.digest);
        } catch (error) {
          notificationsUndelivered.reset();
          options.onSamplerError?.('undelivered_notifications', error);
        }
      }
      if (options.staleCommandClaims !== undefined) {
        try {
          const claims = await options.staleCommandClaims();
          // Rebuilt from this scrape, so an action whose claims were looked at and cleared by a
          // human drops out rather than keeping its last value.
          commandClaimsUnknown.reset();
          for (const entry of claims) {
            commandClaimsUnknown.set({ action: entry.action }, entry.claims);
          }
        } catch (error) {
          commandClaimsUnknown.reset();
          options.onSamplerError?.('stale_command_claims', error);
        }
      }
      if (options.jobQueues !== undefined) {
        // Rebuilt from this scrape: a queue that stopped waiting loses its age series rather than
        // keeping its last value, and a failed read exports neither (absent, never stale).
        jobsQueued.reset();
        jobsQueuedOldestAge.reset();
        try {
          for (const entry of await options.jobQueues()) {
            jobsQueued.set({ queue: entry.queue }, entry.queued);
            if (entry.oldestAgeSeconds !== null) {
              jobsQueuedOldestAge.set({ queue: entry.queue }, entry.oldestAgeSeconds);
            }
          }
        } catch (error) {
          jobsQueued.reset();
          jobsQueuedOldestAge.reset();
          options.onSamplerError?.('job_queues', error);
        }
      }
      if (options.storage !== undefined) {
        try {
          await sampleStorage(options.storage);
        } catch (error) {
          storageBytes.reset();
          storageTotalBytes.reset();
          knowledgeMirrorBytes.reset();
          options.onSamplerError?.('storage', error);
        }
      }
    },
  };
};

/**
 * The route label for a request.
 *
 * Fastify's `routeOptions.url` is the *pattern* (`/api/projects/:project_id/config`), which is
 * what a histogram label must be: labelling with the concrete path would create one time series
 * per project id and blow up the scrape. A request that matched no route is labelled `unknown`
 * rather than with the path a scanner sent, for the same reason.
 */
export const routeLabel = (pattern: string | undefined): string => pattern ?? 'unknown';
