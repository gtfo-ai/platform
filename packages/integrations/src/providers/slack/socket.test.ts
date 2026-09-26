/**
 * Socket Mode, driven without a socket.
 *
 * The connection, the timer and the clock are all injected, so every assertion here is about the
 * protocol rather than about the network: which envelopes are acked, which are not, and that a
 * reconnect storm costs zero real milliseconds (standing rule 2).
 *
 * The load-bearing test is `hands the ring a delivery its own verifier accepts`: it is what makes
 * "Socket Mode takes the same door as HTTP" a fact rather than a docblock.
 */
import { createVirtualTimer, type WebhookDelivery } from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { verifySlackDelivery } from './signature.js';
import {
  createSlackSocket,
  type SlackSocket,
  SlackSocketError,
  type SocketConnection,
  type SocketHandlers,
} from './socket.js';

const SECRET = 'fake-slack-signing-secret-do-not-use';
const NOW = '2026-06-01T09:00:00.000Z';
const WSS = 'wss://wss.example.test/link/?ticket=1234-5678';

interface FakeSocket {
  readonly sent: string[];
  closes: number;
  handlers: SocketHandlers;
}

const harness = (
  options: {
    onDelivery?: (delivery: WebhookDelivery) => Promise<void>;
    signingSecret?: string | null;
    maxReconnects?: number | null;
  } = {},
) => {
  const timer = createVirtualTimer({ autoAdvance: true });
  const sockets: FakeSocket[] = [];
  const opens: string[] = [];
  const delivered: WebhookDelivery[] = [];

  const socket: SlackSocket = createSlackSocket({
    openConnection: async () => {
      opens.push(WSS);
      return WSS;
    },
    connect: (_url, handlers): SocketConnection => {
      const state: FakeSocket = { sent: [], closes: 0, handlers };
      sockets.push(state);
      queueMicrotask(() => handlers.onOpen());
      return {
        send: (data) => state.sent.push(data),
        close: () => {
          state.closes += 1;
        },
      };
    },
    timer,
    clock: fixedClock(NOW),
    signingSecret: options.signingSecret === undefined ? SECRET : options.signingSecret,
    onDelivery: async (delivery) => {
      delivered.push(delivery);
      await options.onDelivery?.(delivery);
    },
    reconnectBaseMs: 1000,
    reconnectMaxMs: 8000,
    maxReconnects: options.maxReconnects ?? 3,
  });

  const receive = (envelope: unknown): void => {
    const current = sockets.at(-1);
    if (current === undefined) {
      throw new Error('nothing is connected');
    }
    current.handlers.onMessage(JSON.stringify(envelope));
  };

  return { socket, sockets, opens, delivered, timer, receive };
};

const eventsApi = (envelopeId: string) => ({
  envelope_id: envelopeId,
  type: 'events_api',
  accepts_response_payload: false,
  payload: {
    type: 'event_callback',
    team_id: 'T0FAKETEAM1',
    event_id: 'Ev0FAKE0001',
    event: { type: 'message', channel: 'C0FAKECHAN1', user: 'U0FAKEDEV01', text: 'hi' },
  },
});

describe('createSlackSocket', () => {
  it('refuses to start without a usable signing secret, and starts with one', async () => {
    // Standing rule 18. A socket whose deliveries `verify` would refuse receives nothing; failing
    // at start is the difference between a visible misconfiguration and a silent one.
    const working = harness();
    await expect(
      working.socket.start(),
      'control: a configured binding starts',
    ).resolves.toBeUndefined();
    await working.socket.stop();

    for (const secret of [null, '', '   ']) {
      const broken = harness({ signingSecret: secret });
      await expect(broken.socket.start()).rejects.toBeInstanceOf(SlackSocketError);
      expect(broken.opens, 'nothing was opened').toEqual([]);
    }
  });

  it('marks itself connected on hello and hands the ring a delivery its own verifier accepts', async () => {
    const { socket, sockets, delivered, receive } = harness();
    await socket.start();
    receive({ type: 'hello', num_connections: 1 });
    await socket.settled();
    expect(socket.connected).toBe(true);

    receive(eventsApi('env-1'));
    await socket.settled();

    expect(delivered).toHaveLength(1);
    const delivery = delivered[0] as WebhookDelivery;
    expect(
      verifySlackDelivery(
        delivery,
        { signingSecret: SECRET, toleranceSeconds: 300 },
        fixedClock(NOW),
      ),
      'a socket delivery goes through the same door as an HTTP one',
    ).toBe(true);
    expect(JSON.parse(delivery.body)).toMatchObject({ type: 'event_callback' });

    expect(socket.acked).toEqual(['env-1']);
    expect(sockets[0]?.sent.map((sent) => JSON.parse(sent))).toEqual([{ envelope_id: 'env-1' }]);
    await socket.stop();
  });

  it('acks an interactive envelope too', async () => {
    const { socket, receive } = harness();
    await socket.start();
    receive({ envelope_id: 'env-2', type: 'interactive', payload: { type: 'block_actions' } });
    await socket.settled();
    expect(socket.acked).toEqual(['env-2']);
    await socket.stop();
  });

  /**
   * `acked` is documented as "the positive evidence that a delivery was handled", and a test that
   * reads it is only certifying something if the entry means a frame left the process. The queue
   * drains asynchronously, so an envelope can be handled after the socket is gone; the `push` used
   * to happen anyway, behind an optional-chained `send`. Found at WP-10 review round 1.
   */
  it('does not record an ack it could not send', async () => {
    const { socket, sockets, delivered, receive } = harness();
    await socket.start();
    receive(eventsApi('env-late'));
    // No `settled()`: `stop` drops the connection and *then* drains the queue, so the handler runs
    // with nothing to send on — which is exactly the race a running deployment has on shutdown.
    await socket.stop();

    expect(delivered, 'the delivery was handled, so this is not a test of nothing').toHaveLength(1);
    expect(sockets[0]?.sent, 'no frame was sent').toEqual([]);
    expect(socket.acked, 'so nothing may claim to have been acked').toEqual([]);
  });

  it('does not ack when the handler fails, and acks when it does not', async () => {
    const failing = harness({
      onDelivery: async () => {
        throw new Error('the inbox write failed');
      },
    });
    await failing.socket.start();
    failing.receive(eventsApi('env-3'));
    await failing.socket.settled();
    expect(failing.socket.acked, 'an unacked envelope is one Slack will redeliver').toEqual([]);
    await failing.socket.stop();

    const working = harness();
    await working.socket.start();
    working.receive(eventsApi('env-3'));
    await working.socket.settled();
    expect(working.socket.acked, 'control: a handler that succeeds acks').toEqual(['env-3']);
    await working.socket.stop();
  });

  it('ignores an envelope type it does not know instead of throwing', async () => {
    // Standing rule 20: Slack ships new envelope types, and an unknown one is not a failure.
    const { socket, receive } = harness();
    await socket.start();
    for (const envelope of [
      { envelope_id: 'env-4', type: 'slash_commands', payload: {} },
      { envelope_id: 'env-5', type: 'something_new', payload: {} },
      { type: 'events_api', payload: {} },
    ]) {
      receive(envelope);
    }
    receive('not an envelope at all');
    await socket.settled();
    expect(socket.acked).toEqual([]);
    expect(socket.connected, 'and the connection is still up').toBe(false);
    await socket.stop();
  });

  it('reconnects after a disconnect, on the injected timer', async () => {
    const { socket, opens, timer, receive } = harness();
    await socket.start();
    receive({ type: 'hello' });
    await socket.settled();
    receive({ type: 'disconnect', reason: 'refresh_requested' });
    await socket.settled();

    expect(opens, 'the connection was opened again').toHaveLength(2);
    expect(timer.sleeps, 'the backoff ran on the injected timer, not a wall clock').toEqual([1000]);
    await socket.stop();
  });

  it('doubles the backoff and caps it', async () => {
    const { socket, timer, receive } = harness({ maxReconnects: 5 });
    await socket.start();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      receive({ type: 'disconnect', reason: 'warning' });
      await socket.settled();
    }
    expect(timer.sleeps).toEqual([1000, 2000, 4000, 8000, 8000]);
    await socket.stop();
  });

  it('resets the backoff once a connection says hello', async () => {
    const { socket, timer, receive } = harness({ maxReconnects: 5 });
    await socket.start();
    receive({ type: 'disconnect', reason: 'warning' });
    await socket.settled();
    receive({ type: 'hello' });
    await socket.settled();
    receive({ type: 'disconnect', reason: 'warning' });
    await socket.settled();
    expect(timer.sleeps, 'a healthy connection starts the next backoff from the base').toEqual([
      1000, 1000,
    ]);
    await socket.stop();
  });

  it('stops reconnecting once it is stopped', async () => {
    const { socket, sockets, opens } = harness();
    await socket.start();
    await socket.stop();
    sockets[0]?.handlers.onClose('closed by the peer');
    await socket.settled();
    expect(opens, 'a stopped socket does not come back').toHaveLength(1);
  });

  /**
   * WP-43: the three lifecycle properties a held connection needs once a process *keeps* one.
   * The connector below behaves as Node's `WebSocket` does — `close()` is followed by a `close`
   * event, later — which the fakes above never did, and which is how the second one hid.
   */
  describe('as a connection a process holds (WP-43)', () => {
    const realistic = (timer = createVirtualTimer({ autoAdvance: true })) => {
      const opens: string[] = [];
      const log: string[] = [];
      const handlers: SocketHandlers[] = [];
      const socket = createSlackSocket({
        openConnection: async () => {
          opens.push(WSS);
          return WSS;
        },
        connect: (_url, received): SocketConnection => {
          handlers.push(received);
          return {
            send: () => {},
            close: async () => {
              log.push('close requested');
              await Promise.resolve();
              log.push('closed');
              // A real socket announces its own close — after the request, not inside it.
              received.onClose('closed');
            },
          };
        },
        timer,
        clock: fixedClock(NOW),
        signingSecret: SECRET,
        onDelivery: async () => {},
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30_000,
        maxReconnects: null,
      });
      return { socket, opens, log, handlers, timer };
    };

    it('does not resolve stop before the connection has finished closing (rule 85)', async () => {
      const { socket, log } = realistic();
      await socket.start();
      await socket.stop();
      expect(log).toEqual(['close requested', 'closed']);
    });

    it('treats the close event of a connection it replaced as an echo, not a second drop', async () => {
      const { socket, opens, handlers, timer } = realistic();
      await socket.start();
      handlers[0]?.onMessage(JSON.stringify({ type: 'hello' }));
      handlers[0]?.onMessage(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));
      await socket.settled();

      // One disconnect, one reconnect — before WP-43 the old socket's own close event scheduled a
      // second one, so a single `refresh_requested` opened two connections.
      expect(opens).toHaveLength(2);
      expect(timer.sleeps).toEqual([1000]);
      await socket.stop();
      expect(opens, 'and stopping opens nothing').toHaveLength(2);
    });

    it('wakes a reconnect that is sleeping out its backoff, so shutdown does not wait for it', async () => {
      // A timer that never advances on its own: the backoff would sleep for ever.
      const { socket, opens, handlers } = realistic(createVirtualTimer());
      await socket.start();
      handlers[0]?.onClose('network dropped');

      await socket.stop();

      expect(opens, 'the sleeping reconnect gave up rather than opening').toHaveLength(1);
    });

    it('keeps trying when a reconnect cannot reach Slack, instead of holding nothing until a restart', async () => {
      let failuresLeft = 1;
      const opens: string[] = [];
      const handlers: SocketHandlers[] = [];
      const timer = createVirtualTimer({ autoAdvance: true });
      const socket = createSlackSocket({
        openConnection: async () => {
          opens.push(WSS);
          if (opens.length === 2 && failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error('slack.com could not be reached');
          }
          return WSS;
        },
        connect: (_url, received): SocketConnection => {
          handlers.push(received);
          return { send: () => {}, close: () => {} };
        },
        timer,
        clock: fixedClock(NOW),
        signingSecret: SECRET,
        onDelivery: async () => {},
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30_000,
        maxReconnects: null,
      });
      await socket.start();
      handlers[0]?.onClose('network dropped');
      await socket.settled();

      // The first reconnect failed; the second, a doubled backoff later, opened a connection.
      expect(opens).toHaveLength(3);
      expect(timer.sleeps).toEqual([1000, 2000]);
      expect(handlers).toHaveLength(2);
      await socket.stop();
    });

    it('leaves no socket open when stopped while a reconnect is asking Slack for its URL', async () => {
      let release: () => void = () => {};
      const opens: string[] = [];
      const closed: boolean[] = [];
      const handlers: SocketHandlers[] = [];
      const socket = createSlackSocket({
        openConnection: async () => {
          opens.push(WSS);
          if (opens.length === 2) {
            // The reconnect's `apps.connections.open`, held open until the test releases it.
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return WSS;
        },
        connect: (_url, received): SocketConnection => {
          const index = closed.push(false) - 1;
          handlers.push(received);
          return {
            send: () => {},
            close: () => {
              closed[index] = true;
            },
          };
        },
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: fixedClock(NOW),
        signingSecret: SECRET,
        onDelivery: async () => {},
        reconnectBaseMs: 1000,
        reconnectMaxMs: 30_000,
        maxReconnects: null,
      });
      await socket.start();
      handlers[0]?.onClose('refresh_requested');
      // Let the reconnect reach its in-flight open.
      for (let round = 0; round < 20 && opens.length < 2; round += 1) {
        await Promise.resolve();
      }
      expect(opens).toHaveLength(2);

      const stopping = socket.stop();
      release();
      await stopping;

      // Every socket that was ever connected is closed — or none was connected after the stop.
      expect(closed.every((isClosed) => isClosed)).toBe(true);
    });
  });
});
