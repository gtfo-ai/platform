/**
 * Prometheus metrics (TD-023): `@prometheus-io/client` on `/metrics`.
 *
 * Only metrics with a real source are registered. TD-023 also names `agent_runs_active`,
 * `agent_tokens_total`, `agent_cost_usd_total` and `queue_job_age_seconds`; nothing produces those
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
  /** Events committed but not yet dispatched (TD-005's `event_dispatch` backlog). */
  readonly eventDispatchPending: Gauge<never>;
  /** Sets the gauges that have to be sampled rather than incremented. Called on scrape. */
  readonly collect: () => Promise<void>;
}

export interface MetricsOptions {
  /** Sampled on every scrape; absent when this process runs no dispatcher (`ROLE=api`). */
  readonly pendingDispatch?: () => Promise<number>;
  /** Node process metrics (heap, event loop lag, handles). @default true */
  readonly defaultMetrics?: boolean;
}

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

  const eventDispatchPending = new Gauge({
    name: 'event_dispatch_pending',
    help: 'Events committed to the log but not yet dispatched (TD-005).',
    // Registered only where something samples it. An unlabelled gauge exports `0` from the moment
    // it is created, so a process with no dispatcher (`ROLE=api`) would publish a permanent
    // "backlog: 0" that reads as a measurement rather than as an absence — and an alert built on
    // it would be quietly blind. A metric this process cannot measure is one it does not export.
    registers: options.pendingDispatch === undefined ? [] : [registry],
  });

  return {
    registry,
    httpRequestDuration,
    sseConnections,
    sseFramesSent,
    eventDispatchPending,
    collect: async () => {
      if (options.pendingDispatch !== undefined) {
        eventDispatchPending.set(await options.pendingDispatch());
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
