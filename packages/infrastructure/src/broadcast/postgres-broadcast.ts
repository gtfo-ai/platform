/**
 * The `Broadcast` adapter on PostgreSQL `LISTEN`/`NOTIFY` (TD-014).
 *
 * One channel carries every topic, with the topic inside the payload, because `LISTEN` names a
 * channel per connection and a topic set that changes per browser tab would mean re-issuing
 * `LISTEN` on a shared connection for every subscription. Filtering by topic in the process is
 * cheap; opening a connection per topic is not.
 *
 * `NOTIFY` is a hint, not a transport: PostgreSQL caps a payload at 8 000 bytes, delivers nothing
 * to a connection that is not listening at that moment, and drops the queue if it overflows. So
 * the contract in the port holds — a broadcast says "this topic changed", and the SSE layer
 * replays the content from `events` / `run_messages` (technical/08). What *is* guaranteed is the
 * transactional half: a notification sent inside a transaction is delivered only if it commits, and
 * identical notifications from one transaction are collapsed into a single delivery, which is
 * exactly TD-005's "once per committing transaction".
 */
import {
  assertTopic,
  type Broadcast,
  type BroadcastListener,
  type BroadcastMessage,
  BroadcastMessageTooLargeError,
  type BroadcastSubscription,
  type Logger,
  MAX_BROADCAST_BYTES,
  silentLogger,
  type TransactionalBroadcast,
} from '@platform/application';
import pg from 'pg';
import type { SqlExecutor } from '../events/sql.js';

/** Channel every topic travels on. A bare identifier, so it needs no quoting in `LISTEN`. */
export const DEFAULT_BROADCAST_CHANNEL = 'platform_broadcast';

/** Raised by `subscribe` after `close`: the transport is gone and nothing would be delivered. */
export class BroadcastClosedError extends Error {
  constructor() {
    super('this broadcast has been closed; nothing subscribed to it would be delivered');
    this.name = 'BroadcastClosedError';
  }
}

const CHANNEL_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** The slice of `pg.Client` the listener needs, named so tests can supply their own. */
export interface NotificationClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  onNotification(
    listener: (message: { channel: string; payload?: string | undefined }) => void,
  ): void;
  onError(listener: (error: Error) => void): void;
  end(): Promise<void>;
}

/** Serialises a message and refuses anything the transport cannot carry. */
export const encodeMessage = (message: BroadcastMessage): string => {
  assertTopic(message.topic);
  const encoded = JSON.stringify({ topic: message.topic, payload: message.payload });
  const bytes = new TextEncoder().encode(encoded).length;
  if (bytes > MAX_BROADCAST_BYTES) {
    throw new BroadcastMessageTooLargeError(message.topic, bytes);
  }
  return encoded;
};

/** Parses a notification payload; returns null for anything that is not one of ours. */
export const decodeMessage = (payload: string | undefined): BroadcastMessage | null => {
  if (payload === undefined || payload === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { topic, payload: body } = parsed as { topic?: unknown; payload?: unknown };
  if (typeof topic !== 'string' || typeof body !== 'object' || body === null) {
    return null;
  }
  return { topic, payload: body as BroadcastMessage['payload'] };
};

const assertChannel = (channel: string): string => {
  if (!CHANNEL_PATTERN.test(channel)) {
    throw new TypeError(`"${channel}" is not a bare lower-case identifier usable as a channel`);
  }
  return channel;
};

/**
 * Publishes inside the caller's transaction: `pg_notify` is transactional, so a message announcing
 * a state change can never outlive a rollback of that change.
 */
export const transactionalBroadcast = (
  sql: SqlExecutor,
  channel: string = DEFAULT_BROADCAST_CHANNEL,
): TransactionalBroadcast => {
  const name = assertChannel(channel);
  return {
    publish: async (message) => {
      await sql.query('select pg_notify($1, $2)', [name, encodeMessage(message)]);
    },
  };
};

export interface PostgresBroadcastOptions {
  /** Connection string for the dedicated listening connection. */
  readonly connectionString: string;
  /** Executor used for publishing outside a transaction; usually the runtime pool. */
  readonly publisher: SqlExecutor;
  readonly channel?: string;
  readonly logger?: Logger;
  /** Injected in tests; defaults to a `pg.Client` on `connectionString`. */
  readonly clientFactory?: (connectionString: string) => NotificationClient;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
}

export const DEFAULT_RECONNECT_DELAY_MS = 500;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

export class PostgresBroadcast implements Broadcast {
  readonly #channel: string;
  readonly #publisher: SqlExecutor;
  readonly #connectionString: string;
  readonly #logger: Logger;
  readonly #createClient: (connectionString: string) => NotificationClient;
  readonly #reconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #listeners = new Map<BroadcastListener, ReadonlySet<string>>();

  #client: NotificationClient | undefined;
  #connecting: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #attempts = 0;
  #closed = false;

  constructor(options: PostgresBroadcastOptions) {
    this.#channel = assertChannel(options.channel ?? DEFAULT_BROADCAST_CHANNEL);
    this.#publisher = options.publisher;
    this.#connectionString = options.connectionString;
    this.#logger = options.logger ?? silentLogger;
    this.#createClient = options.clientFactory ?? defaultClientFactory;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  }

  async publish(message: BroadcastMessage): Promise<void> {
    await this.#publisher.query('select pg_notify($1, $2)', [
      this.#channel,
      encodeMessage(message),
    ]);
  }

  async subscribe(
    topics: readonly string[],
    listener: BroadcastListener,
  ): Promise<BroadcastSubscription> {
    // Subscribing to a closed transport would silently never deliver anything. The caller asked
    // for messages it is not going to get, so say so rather than hand back a dead subscription.
    if (this.#closed) {
      throw new BroadcastClosedError();
    }
    const wanted = new Set(topics.map(assertTopic));
    this.#listeners.set(listener, wanted);
    await this.#ensureListening();
    if (!this.listening) {
      // Reconnection is already scheduled and the subscription is live, so this is not fatal —
      // the wake-up hints it carries only cost latency (the outbox worker still polls). But a
      // subscription that resolves while nothing is listening has to be visible.
      this.#logger.warn(
        { channel: this.#channel, topics: [...wanted] },
        'subscribed before the listening connection came up; retrying in the background',
      );
    }
    return {
      close: async () => {
        this.#listeners.delete(listener);
      },
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    const client = this.#client;
    this.#client = undefined;
    this.#connecting = undefined;
    if (client !== undefined) {
      await client.end().catch(() => undefined);
    }
  }

  /** True while a live connection is holding the `LISTEN`. */
  get listening(): boolean {
    return this.#client !== undefined;
  }

  async #ensureListening(): Promise<void> {
    if (this.#closed || this.#client !== undefined) {
      return;
    }
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    await this.#connecting;
  }

  async #connect(): Promise<void> {
    let client: NotificationClient;
    try {
      client = this.#createClient(this.#connectionString);
    } catch (error) {
      // A factory that throws synchronously would otherwise escape as an unhandled rejection from
      // the reconnect timer, where nobody is awaiting.
      this.#onConnectionLost(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    try {
      await client.connect();
      client.onNotification((message) => {
        this.#onNotification(message);
      });
      // A dropped listening connection is silent — no error is raised on the *publishing* side —
      // so the only safe reaction is to rebuild it and re-issue LISTEN. Messages sent while it was
      // down are gone; the port documents that broadcasts are hints and clients replay.
      client.onError((error) => {
        this.#onConnectionLost(error);
      });
      await client.query(`listen ${this.#channel}`);
      if (this.#closed) {
        // `close()` ran while this connection was coming up. Nothing holds it any more, so
        // assigning it would leak a live connection that is never ended.
        await client.end().catch(() => undefined);
        return;
      }
      this.#client = client;
      this.#attempts = 0;
      this.#logger.debug({ channel: this.#channel }, 'broadcast listening');
    } catch (error) {
      await client.end().catch(() => undefined);
      this.#onConnectionLost(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #onConnectionLost(error: Error): void {
    if (this.#closed) {
      return;
    }
    this.#client = undefined;
    this.#attempts += 1;
    const delay = Math.min(
      this.#reconnectDelayMs * 2 ** Math.min(this.#attempts - 1, 8),
      this.#maxReconnectDelayMs,
    );
    this.#logger.warn(
      { channel: this.#channel, error: error.message, attempt: this.#attempts, delay },
      'broadcast connection lost; reconnecting',
    );
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      // Nothing awaits this timer, so a rejection here would be unhandled and take the process
      // down under Node's default. `#connect` already reports its own failures.
      this.#ensureListening().catch((error: unknown) => {
        this.#logger.error(
          { channel: this.#channel, error: error instanceof Error ? error.message : String(error) },
          'broadcast reconnect failed',
        );
      });
    }, delay);
    this.#timer.unref?.();
  }

  #onNotification(notification: { channel: string; payload?: string | undefined }): void {
    if (notification.channel !== this.#channel) {
      return;
    }
    const message = decodeMessage(notification.payload);
    if (message === null) {
      this.#logger.warn({ channel: this.#channel }, 'discarded an unreadable notification');
      return;
    }
    for (const [listener, topics] of this.#listeners) {
      if (topics.has(message.topic)) {
        listener(message);
      }
    }
  }
}

/**
 * A `pg.Client` behind the narrow interface above. Wrapped rather than passed directly because
 * `pg.Client.on` is an overloaded EventEmitter method, and naming the two events we use keeps the
 * fake in the tests honest.
 */
const defaultClientFactory = (connectionString: string): NotificationClient => {
  const client = new pg.Client({ connectionString });
  return {
    connect: async () => {
      await client.connect();
    },
    query: async (text: string) => client.query(text),
    onNotification: (listener) => {
      client.on('notification', (message) => {
        listener({ channel: message.channel, payload: message.payload });
      });
    },
    onError: (listener) => {
      client.on('error', listener);
    },
    end: async () => {
      await client.end();
    },
  };
};
