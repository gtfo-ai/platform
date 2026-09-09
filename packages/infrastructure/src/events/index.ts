/**
 * The PostgreSQL side of TD-005: event store, dispatch queue, handler-execution log, and the
 * composition helper that wires them to the dispatcher and the outbox worker.
 */
import {
  CONNECTIONS_PER_DISPATCH,
  EventBus,
  type Logger,
  OutboxWorker,
} from '@platform/application';
import type pg from 'pg';
import { PostgresBroadcast } from '../broadcast/postgres-broadcast.js';
import { DISPATCH_CONFIG_DEFAULTS, type DispatchConfig } from './config.js';
import { PostgresEventStore } from './postgres-event-store.js';
import { PostgresUnitOfWork } from './postgres-unit-of-work.js';

export * from './config.js';
export * from './postgres-event-store.js';
export * from './postgres-unit-of-work.js';
export { type EventRow, eventColumns, type SqlExecutor } from './sql.js';

export interface EventingOptions {
  readonly pool: pg.Pool;
  /** Connection string for the broadcast's dedicated listening connection. */
  readonly connectionString: string;
  readonly config?: Partial<DispatchConfig>;
  readonly logger?: Logger;
}

export interface Eventing {
  readonly unitOfWork: PostgresUnitOfWork;
  readonly store: PostgresEventStore;
  readonly broadcast: PostgresBroadcast;
  readonly bus: EventBus;
  readonly worker: OutboxWorker;
  /** Drains the worker and the bus, then releases the broadcast connection. */
  readonly stop: () => Promise<void>;
}

/**
 * Thrown when the pool cannot hold the connections the configured concurrency needs.
 *
 * This is a start-up error on purpose. A dispatch holds two connections at once, so an undersized
 * pool does not run slowly — every dispatch waits on a connection its own transaction is holding,
 * and with `pg`'s default (no `connectionTimeoutMillis`) that wait never ends. Refusing the
 * configuration is the difference between a message an operator can act on and a process that
 * looks alive and does nothing.
 *
 * The check is `poolMax >= required`: exactly the floor is *sufficient*, because that is what can
 * actually be guaranteed about the dispatcher's own paths. It is still only a floor for **this**
 * component — the same pool serves `Broadcast.publish`, the HTTP layer and everything later work
 * packages add — so a real deployment sizes above it. Those are two different statements and the
 * message below keeps them apart.
 */
export class InsufficientPoolError extends Error {
  readonly poolMax: number;
  /** The minimum the dispatcher alone needs; a real deployment adds to it. */
  readonly required: number;

  constructor(poolMax: number, required: number, concurrency: number) {
    super(
      `APP_DB_POOL_MAX is ${poolMax}, but APP_DISPATCH_MAX_CONCURRENCY=${concurrency} needs at least ${required} connections for dispatch alone: each dispatch holds ${CONNECTIONS_PER_DISPATCH} at once (its own transaction plus the handler's) and the sweep needs one to read with. Set APP_DB_POOL_MAX to at least ${required}, or lower APP_DISPATCH_MAX_CONCURRENCY. ${required} is the floor for the dispatcher alone; the same pool also serves queries and notifications, so size above it in a real deployment.`,
    );
    this.name = 'InsufficientPoolError';
    this.poolMax = poolMax;
    this.required = required;
  }
}

/**
 * Builds the whole dispatch stack against one pool. The composition root (WP-06) registers its
 * handlers on `bus` and calls `worker.start()`.
 *
 * @throws {InsufficientPoolError} when `pool` is smaller than the configured concurrency needs.
 */
export const createEventing = (options: EventingOptions): Eventing => {
  const config = { ...DISPATCH_CONFIG_DEFAULTS, ...options.config };
  const unitOfWork = new PostgresUnitOfWork({
    pool: options.pool,
    broadcastChannel: config.broadcastChannel,
  });
  const bus = new EventBus({
    unitOfWork,
    maxConcurrentDispatches: config.maxConcurrency,
    retryDelayMs: config.retryDelayMs,
    maxRetryDelayMs: config.maxRetryDelayMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const poolMax = options.pool.options.max;
  if (poolMax < bus.requiredConnections) {
    throw new InsufficientPoolError(poolMax, bus.requiredConnections, config.maxConcurrency);
  }

  const store = new PostgresEventStore(options.pool);
  const broadcast = new PostgresBroadcast({
    connectionString: options.connectionString,
    publisher: options.pool,
    channel: config.broadcastChannel,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const worker = new OutboxWorker({
    bus,
    store,
    broadcast,
    batchSize: config.batchSize,
    pollIntervalMs: config.pollIntervalMs,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  return {
    unitOfWork,
    store,
    broadcast,
    bus,
    worker,
    stop: async () => {
      await worker.stop({ timeoutMs: config.drainTimeoutMs });
      await broadcast.close();
    },
  };
};
