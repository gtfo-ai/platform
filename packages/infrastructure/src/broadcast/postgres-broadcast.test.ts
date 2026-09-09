import { BroadcastMessageTooLargeError } from '@platform/application';
import { describe, expect, it, vi } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import {
  BroadcastClosedError,
  decodeMessage,
  encodeMessage,
  type NotificationClient,
  PostgresBroadcast,
  transactionalBroadcast,
} from './postgres-broadcast.js';

interface FakeClient extends NotificationClient {
  readonly statements: string[];
  emit(channel: string, payload?: string): void;
  fail(error: Error): void;
  readonly ended: boolean;
}

const fakeClient = (options: { failConnect?: boolean } = {}): FakeClient => {
  const statements: string[] = [];
  let notify: ((message: { channel: string; payload?: string }) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  let ended = false;
  return {
    statements,
    get ended() {
      return ended;
    },
    connect: async () => {
      if (options.failConnect === true) {
        throw new Error('ECONNREFUSED');
      }
    },
    query: async (text: string) => {
      statements.push(text);
    },
    onNotification: (listener) => {
      notify = listener;
    },
    onError: (listener) => {
      onError = listener;
    },
    end: async () => {
      ended = true;
    },
    emit: (channel, payload) =>
      notify?.({ channel, ...(payload === undefined ? {} : { payload }) }),
    fail: (error) => onError?.(error),
  };
};

const recordingSql = (): SqlExecutor & { calls: { text: string; values: unknown[] }[] } => {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
};

describe('message encoding', () => {
  it('round-trips a message', () => {
    const message = { topic: 'task:abc', payload: { seq: 4 } };
    expect(decodeMessage(encodeMessage(message))).toEqual(message);
  });

  it('refuses a payload the transport cannot carry', () => {
    expect(() => encodeMessage({ topic: 'org', payload: { blob: 'x'.repeat(8000) } })).toThrow(
      BroadcastMessageTooLargeError,
    );
  });

  it('refuses a topic outside the documented shape', () => {
    expect(() => encodeMessage({ topic: 'org; drop table', payload: {} })).toThrow(
      /not a broadcast topic/,
    );
  });

  it.each([
    ['', 'empty'],
    [undefined, 'absent'],
    ['not json', 'unparsable'],
    ['[]', 'not an object'],
    ['{"payload":{}}', 'no topic'],
    ['{"topic":"org"}', 'no payload'],
    ['{"topic":1,"payload":{}}', 'topic is not a string'],
  ])('decodes %j as nothing (%s)', (payload, why) => {
    expect(decodeMessage(payload), why).toBeNull();
  });
});

describe('transactionalBroadcast', () => {
  it('publishes with pg_notify on the caller transaction', async () => {
    const sql = recordingSql();
    await transactionalBroadcast(sql, 'my_channel').publish({ topic: 'org', payload: { a: 1 } });
    expect(sql.calls[0]?.text).toBe('select pg_notify($1, $2)');
    expect(sql.calls[0]?.values[0]).toBe('my_channel');
    expect(JSON.parse(String(sql.calls[0]?.values[1]))).toEqual({
      topic: 'org',
      payload: { a: 1 },
    });
  });

  it('refuses a channel name that would need quoting', () => {
    expect(() => transactionalBroadcast(recordingSql(), 'Bad Channel')).toThrow(/bare lower-case/);
  });
});

describe('PostgresBroadcast', () => {
  const build = (client: FakeClient, publisher = recordingSql()) =>
    new PostgresBroadcast({
      connectionString: 'postgres://fake/db',
      publisher,
      channel: 'test_channel',
      clientFactory: () => client,
      reconnectDelayMs: 1,
    });

  it('listens once and delivers only the topics a listener asked for', async () => {
    const client = fakeClient();
    const broadcast = build(client);
    const seen: string[] = [];
    await broadcast.subscribe(['task:abc'], (message) => seen.push(message.topic));

    expect(client.statements).toEqual(['listen test_channel']);
    client.emit('test_channel', encodeMessage({ topic: 'task:abc', payload: {} }));
    client.emit('test_channel', encodeMessage({ topic: 'org', payload: {} }));
    expect(seen).toEqual(['task:abc']);

    await broadcast.close();
    expect(client.ended).toBe(true);
  });

  it('ignores a notification on another channel and an unreadable payload', async () => {
    const client = fakeClient();
    const warnings: string[] = [];
    const broadcast = new PostgresBroadcast({
      connectionString: 'postgres://fake/db',
      publisher: recordingSql(),
      channel: 'test_channel',
      clientFactory: () => client,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (_fields, message) => warnings.push(message),
        error: () => {},
      },
    });
    const seen: string[] = [];
    await broadcast.subscribe(['org'], (message) => seen.push(message.topic));

    client.emit('other_channel', encodeMessage({ topic: 'org', payload: {} }));
    client.emit('test_channel', 'nonsense');
    expect(seen).toEqual([]);
    expect(warnings).toContain('discarded an unreadable notification');
    await broadcast.close();
  });

  it('stops delivering to a closed subscription', async () => {
    const client = fakeClient();
    const broadcast = build(client);
    const seen: string[] = [];
    const subscription = await broadcast.subscribe(['org'], (message) => seen.push(message.topic));
    await subscription.close();
    client.emit('test_channel', encodeMessage({ topic: 'org', payload: {} }));
    expect(seen).toEqual([]);
    await broadcast.close();
  });

  it('opens exactly one connection for several subscriptions', async () => {
    const client = fakeClient();
    const broadcast = build(client);
    await broadcast.subscribe(['org'], () => {});
    await broadcast.subscribe(['task:abc'], () => {});
    expect(client.statements).toEqual(['listen test_channel']);
    await broadcast.close();
  });

  it('reconnects and re-issues LISTEN after the connection is lost', async () => {
    const clients = [fakeClient(), fakeClient()];
    let index = 0;
    const broadcast = new PostgresBroadcast({
      connectionString: 'postgres://fake/db',
      publisher: recordingSql(),
      channel: 'test_channel',
      clientFactory: () => clients[index++] ?? fakeClient(),
      reconnectDelayMs: 1,
    });
    const seen: string[] = [];
    await broadcast.subscribe(['org'], (message) => seen.push(message.topic));
    expect(broadcast.listening).toBe(true);

    clients[0]?.fail(new Error('connection terminated unexpectedly'));
    expect(broadcast.listening).toBe(false);

    await vi.waitFor(() => {
      expect(clients[1]?.statements).toEqual(['listen test_channel']);
    });
    clients[1]?.emit('test_channel', encodeMessage({ topic: 'org', payload: {} }));
    expect(seen).toEqual(['org']);
    await broadcast.close();
  });

  it('retries a connection that never came up', async () => {
    const failing = fakeClient({ failConnect: true });
    const working = fakeClient();
    let first = true;
    const broadcast = new PostgresBroadcast({
      connectionString: 'postgres://fake/db',
      publisher: recordingSql(),
      channel: 'test_channel',
      clientFactory: () => {
        if (first) {
          first = false;
          return failing;
        }
        return working;
      },
      reconnectDelayMs: 1,
    });
    await broadcast.subscribe(['org'], () => {});
    expect(failing.ended).toBe(true);

    await vi.waitFor(() => {
      expect(broadcast.listening).toBe(true);
    });
    await broadcast.close();
  });

  it('warns when a subscription resolves before the connection is up', async () => {
    const failing = fakeClient({ failConnect: true });
    const warnings: string[] = [];
    const broadcast = new PostgresBroadcast({
      connectionString: 'postgres://fake/db',
      publisher: recordingSql(),
      channel: 'test_channel',
      clientFactory: () => failing,
      reconnectDelayMs: 10_000,
      logger: {
        debug: () => {},
        info: () => {},
        warn: (_fields, message) => warnings.push(message),
        error: () => {},
      },
    });
    await broadcast.subscribe(['org'], () => {});
    expect(broadcast.listening).toBe(false);
    expect(warnings).toContain(
      'subscribed before the listening connection came up; retrying in the background',
    );
    await broadcast.close();
  });

  it('refuses to subscribe after close instead of returning a dead subscription', async () => {
    const broadcast = build(fakeClient());
    await broadcast.close();
    await expect(broadcast.subscribe(['org'], () => {})).rejects.toBeInstanceOf(
      BroadcastClosedError,
    );
  });

  it('ends a connection that came up after close(), instead of leaking it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = fakeClient();
    const slowConnect: NotificationClient = { ...slow, connect: async () => gate };
    const broadcast = new PostgresBroadcast({
      connectionString: 'postgres://fake/db',
      publisher: recordingSql(),
      channel: 'test_channel',
      clientFactory: () => slowConnect,
    });

    const subscribing = broadcast.subscribe(['org'], () => {});
    await broadcast.close();
    release();
    await subscribing.catch(() => undefined);

    expect(broadcast.listening).toBe(false);
    expect(slow.ended).toBe(true);
  });

  it('does not reconnect once closed', async () => {
    const client = fakeClient();
    const broadcast = build(client);
    await broadcast.subscribe(['org'], () => {});
    await broadcast.close();
    client.fail(new Error('too late'));
    expect(broadcast.listening).toBe(false);
  });

  it('publishes outside a transaction through the pool', async () => {
    const publisher = recordingSql();
    const broadcast = build(fakeClient(), publisher);
    await broadcast.publish({ topic: 'org', payload: {} });
    expect(publisher.calls[0]?.values[0]).toBe('test_channel');
    await broadcast.close();
  });
});
