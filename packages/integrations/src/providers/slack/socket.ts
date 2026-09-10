/**
 * Socket Mode: the inbound transport, with the socket itself injected.
 *
 * > Call the `apps.connections.open` endpoint with an app-level token (format: `xapp-***`) … The
 * > response contains `"ok": true, "url": "wss://wss.slack.com/link/?ticket=1234-5678"` … After
 * > connection, Slack sends a `hello` message confirming the link.
 *
 * > `{"envelope_id": …, "type": …, "payload": …, "accepts_response_payload": …, "retry_attempt":
 * > …, "retry_reason": …}` … `hello` … `events_api` … `interactive` … `slash_commands` …
 * > `disconnect` … Send acknowledgment immediately: `{"envelope_id": …, "payload": …}` …
 * > `link_disabled` … `warning` … `refresh_requested`
 *
 * — <https://docs.slack.dev/apis/events-api/using-socket-mode>, retrieved 2026-09-10.
 *
 * ## Every envelope takes the same door as an HTTP delivery
 *
 * A Socket Mode payload arrives over a connection that was authenticated by an app-level token,
 * so there is no Slack signature on it. This module does **not** therefore hand the ring an
 * unverified payload: it wraps each envelope into a `WebhookDelivery` signed with *this binding's
 * own* signing secret and the injected clock, so `inbound.verify` is the single place that decides
 * whether a payload may be acted on, on either transport.
 *
 * That local signature attests the **transport**, not Slack's key, and saying so is the point:
 * it removes a class of bug — a caller that forgets which transport a delivery came from and skips
 * verification — rather than adding cryptographic evidence. Its fail-closed consequence is the
 * useful one: a binding with no usable signing secret cannot start a socket at all, because every
 * envelope it produced would be refused downstream anyway (standing rule 18).
 *
 * ## What is injected, and why each one
 *
 *  - **the connection**, because a WebSocket is I/O and this package's tier has none. Production
 *    passes `globalThis.WebSocket` through `webSocketConnect`;
 *  - **the timer**, because reconnect backoff is time and a wall-clock assertion is a hardware
 *    assertion (standing rule 2);
 *  - **the clock**, because the delivery's timestamp is inside the signature;
 *  - **`openConnection`**, because `apps.connections.open` is an HTTP call and belongs with the
 *    other HTTP calls.
 *
 * ## Acking after the handler, not before
 *
 * The handler is the endpoint's "store the raw payload and enqueue normalisation" (technical/06:
 * "Response is 2xx within milliseconds; all work is asynchronous"), so it is fast, and acking
 * *after* it means a crash between receiving and storing leaves the envelope unacked for Slack to
 * redeliver. Acking first would make that same crash a silently lost decision. A handler that
 * throws is logged and **not** acked, for the same reason.
 */
import type { IntegrationTimer, Logger, WebhookDelivery } from '@platform/application';
import { silentLogger } from '@platform/application';
import type { Clock } from '@platform/domain';
import { type SocketEnvelope, socketEnvelopeSchema } from './schemas.js';
import { slackSignatureHeaders, usableSigningSecret } from './signature.js';

/** The half of a WebSocket this module uses. `globalThis.WebSocket` satisfies it via the adapter. */
export interface SocketConnection {
  send(data: string): void;
  close(): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(reason: string): void;
  onError(error: unknown): void;
}

export type SocketConnect = (url: string, handlers: SocketHandlers) => SocketConnection;

export interface SlackSocketOptions {
  /** Calls `apps.connections.open` and returns the `wss://` URL. */
  openConnection(): Promise<string>;
  readonly connect: SocketConnect;
  readonly timer: IntegrationTimer;
  readonly clock: Clock;
  /** The binding's signing secret. Without a usable one, `start` refuses. */
  readonly signingSecret: string | null;
  /** Store the raw delivery and enqueue normalisation. Throwing means "not acked". */
  onDelivery(delivery: WebhookDelivery, envelope: SocketEnvelope): Promise<void>;
  readonly logger?: Logger;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  /** Bounds the reconnect loop in a test. `null` (the default) means "until stopped". */
  readonly maxReconnects?: number | null;
}

export interface SlackSocket {
  /** Opens the connection. @throws when the binding cannot sign, or when Slack refuses. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Resolves when every envelope received so far has been handled. For tests. */
  settled(): Promise<void>;
  readonly connected: boolean;
  /** Envelope ids acked, in order — the positive evidence that a delivery was handled. */
  readonly acked: readonly string[];
}

export class SlackSocketError extends Error {
  override readonly name = 'SlackSocketError';
}

/** Envelope types that carry a payload the platform normalises. */
const DELIVERY_TYPES: ReadonlySet<string> = new Set(['events_api', 'interactive']);

export const createSlackSocket = (options: SlackSocketOptions): SlackSocket => {
  const logger = options.logger ?? silentLogger;
  const baseMs = options.reconnectBaseMs ?? 1_000;
  const maxMs = options.reconnectMaxMs ?? 30_000;
  const acked: string[] = [];

  let connection: SocketConnection | null = null;
  let stopping = false;
  let connected = false;
  let attempt = 0;
  let reconnects = 0;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (work: () => Promise<void>): void => {
    queue = queue.then(work).catch((error: unknown) => {
      logger.error({ err: error }, 'slack socket handler failed');
    });
  };

  const deliveryFor = (envelope: SocketEnvelope, secret: string): WebhookDelivery => {
    const body = JSON.stringify(envelope.payload ?? null);
    const timestampSeconds = Math.floor(Date.parse(options.clock.now()) / 1000);
    return { headers: slackSignatureHeaders({ secret, timestampSeconds, body }), body };
  };

  /**
   * Acks an envelope, and records it **only when a connection took the frame**.
   *
   * `acked` is documented as "the positive evidence that a delivery was handled" and is what the
   * tests read. The optional-chained `connection?.send(...)` used to be followed by an
   * unconditional `push`, so a socket that had already closed — the queue drains asynchronously,
   * so an envelope can outlive its connection — produced an entry for a frame Slack never
   * received: a test reading `acked` would have been certifying nothing. Slack redelivers an
   * unacked envelope, so the honest record is "not acked".
   */
  const ack = (envelopeId: string): void => {
    if (connection === null) {
      logger.warn(
        { provider: 'slack', envelopeId },
        'slack envelope handled after the socket closed; not acked, Slack will redeliver',
      );
      return;
    }
    connection.send(JSON.stringify({ envelope_id: envelopeId }));
    acked.push(envelopeId);
  };

  const handleEnvelope = async (envelope: SocketEnvelope, secret: string): Promise<void> => {
    if (envelope.type === 'hello') {
      connected = true;
      attempt = 0;
      logger.info({ provider: 'slack' }, 'slack socket connected');
      return;
    }
    if (envelope.type === 'disconnect') {
      logger.info(
        { provider: 'slack', reason: envelope.reason ?? null },
        'slack socket asked to reconnect',
      );
      reconnect('disconnect');
      return;
    }
    if (!DELIVERY_TYPES.has(envelope.type)) {
      // Standing rule 20: Slack ships new envelope types, and an unknown one is not a failure.
      logger.debug({ provider: 'slack', type: envelope.type }, 'slack socket ignored an envelope');
      return;
    }
    const envelopeId = envelope.envelope_id ?? '';
    if (envelopeId === '') {
      logger.warn({ provider: 'slack', type: envelope.type }, 'slack envelope has no envelope_id');
      return;
    }
    await options.onDelivery(deliveryFor(envelope, secret), envelope);
    ack(envelopeId);
  };

  const openSocket = async (secret: string): Promise<void> => {
    const url = await options.openConnection();
    connection = options.connect(url, {
      onOpen: () => {
        logger.debug({ provider: 'slack' }, 'slack socket opened');
      },
      onMessage: (data) => {
        const parsed = socketEnvelopeSchema.safeParse(safeJson(data));
        if (!parsed.success) {
          logger.warn(
            { provider: 'slack' },
            'slack socket received a frame that is not an envelope',
          );
          return;
        }
        enqueue(() => handleEnvelope(parsed.data, secret));
      },
      onClose: (reason) => {
        connected = false;
        reconnect(reason);
      },
      onError: (error) => {
        logger.warn({ err: error, provider: 'slack' }, 'slack socket error');
      },
    });
  };

  const reconnect = (reason: string): void => {
    if (stopping) {
      return;
    }
    if (options.maxReconnects !== null && options.maxReconnects !== undefined) {
      if (reconnects >= options.maxReconnects) {
        return;
      }
    }
    reconnects += 1;
    const secret = usableSigningSecret(options.signingSecret);
    if (secret === null) {
      return;
    }
    const delayMs = Math.min(maxMs, baseMs * 2 ** attempt);
    attempt += 1;
    enqueue(async () => {
      connection?.close();
      connection = null;
      // The backoff runs on the injected timer: a reconnect storm in a test must not cost seconds.
      await options.timer.sleep(delayMs);
      if (stopping) {
        return;
      }
      logger.info({ provider: 'slack', reason, delayMs }, 'slack socket reconnecting');
      await openSocket(secret);
    });
  };

  return {
    get connected() {
      return connected;
    },
    get acked() {
      return acked;
    },
    start: async () => {
      const secret = usableSigningSecret(options.signingSecret);
      if (secret === null) {
        // Every envelope this socket produced would be refused by `inbound.verify`; starting would
        // be a connection that quietly discards every decision a human makes in Slack.
        throw new SlackSocketError(
          'slack: socket mode needs the signing secret (SLACK_SIGNING_SECRET); every delivery would be rejected without it',
        );
      }
      stopping = false;
      await openSocket(secret);
    },
    stop: async () => {
      stopping = true;
      connected = false;
      connection?.close();
      connection = null;
      let previous: Promise<void> | null = null;
      while (previous !== queue) {
        previous = queue;
        await queue;
      }
    },
    settled: async () => {
      // Drains *chained* work too: handling an envelope can enqueue a reconnect, which appends to
      // the queue after this awaited the previous tail. Loop until the tail stops moving, or a
      // test would assert on a reconnect that had not happened yet.
      let previous: Promise<void> | null = null;
      while (previous !== queue) {
        previous = queue;
        await queue;
      }
    },
  };
};

const safeJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/**
 * The production connector, over Node's global `WebSocket` (stable since Node 22; this platform
 * requires Node 24). Kept here rather than in `provider.ts` so the adapter's own module graph has
 * no I/O in it, and so a deployment that needs a proxy replaces one function.
 */
export const webSocketConnect: SocketConnect = (url, handlers) => {
  const WebSocketImpl = (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
    .WebSocket;
  if (WebSocketImpl === undefined) {
    throw new SlackSocketError('slack: this runtime has no global WebSocket');
  }
  const socket = new WebSocketImpl(url);
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event) => handlers.onMessage(String(event.data)));
  socket.addEventListener('close', (event) => handlers.onClose(String(event.reason ?? 'closed')));
  socket.addEventListener('error', (event) => handlers.onError(event));
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  };
};

/** The structural half of the WHATWG `WebSocket` used above. */
interface WebSocketLike {
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; reason?: unknown }) => void,
  ): void;
  send(data: string): void;
  close(): void;
}
