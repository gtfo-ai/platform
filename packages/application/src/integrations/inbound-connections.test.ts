/**
 * The held-connection lifecycle (WP-43): open at composition, closed at shutdown, retried when a
 * retry can help, and **named** whenever this process will not hold one.
 *
 * The connections are doubles that are no kinder than a socket (standing rule 1): `start` can fail
 * either way, `stop` resolves only after it has run, and a delivery handed to the ingress is the
 * same `deliver` call the HTTP route makes. The scheduler is manual, so a retry or a re-list happens
 * when the test says so and never on a wall clock (standing rule 2).
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { IntegrationError, type WebhookDelivery } from '../ports/integrations/common.js';
import type {
  BrokenHeldConnectionAccount,
  HeldConnectionAccount,
  InboundConnection,
} from '../ports/integrations/inbound-connection.js';
import type { Logger } from '../ports/logger.js';
import type { WebhookIngress } from './inbound.js';
import { type HeldConnectionScheduler, startInboundConnections } from './inbound-connections.js';

const A = '00000000-0000-4000-8000-0000000000a1' as Id;
const B = '00000000-0000-4000-8000-0000000000a2' as Id;

const manualScheduler = () => {
  const pending: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const scheduler: HeldConnectionScheduler = {
    after: (ms, run) => {
      const entry = { ms, run, cancelled: false };
      pending.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return {
    scheduler,
    live: () => pending.filter((entry) => !entry.cancelled),
    /** Fires every live timer of this delay once. */
    fire: (ms: number) => {
      for (const entry of pending.filter(
        (candidate) => !candidate.cancelled && candidate.ms === ms,
      )) {
        entry.cancelled = true;
        entry.run();
      }
    },
  };
};

const recordingLogger = () => {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const at =
    (level: string) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger;
  return { logger, lines };
};

/** A connection whose `start` answers from a script, and whose `stop` is observable. */
const connectionDouble = (starts: (() => Promise<void>)[]) => {
  const log: string[] = [];
  let onDelivery: ((delivery: WebhookDelivery) => Promise<void>) | null = null;
  const connection: InboundConnection = {
    start: async () => {
      log.push('start');
      const next = starts.shift() ?? (async () => {});
      await next();
    },
    stop: async () => {
      // A stop that has work to finish, so "resolved" is only true once it has.
      await Promise.resolve();
      log.push('stopped');
    },
  };
  return {
    connection,
    log,
    deliver: async (delivery: WebhookDelivery) => {
      if (onDelivery === null) {
        throw new Error('the connection was never opened');
      }
      await onDelivery(delivery);
    },
    bind: (handler: (delivery: WebhookDelivery) => Promise<void>) => {
      onDelivery = handler;
    },
  };
};

const account = (
  integrationId: Id,
  double: ReturnType<typeof connectionDouble>,
): HeldConnectionAccount => ({
  kind: 'selected',
  integrationId,
  provider: 'slack',
  name: `slack ${integrationId.slice(-2)}`,
  open: (onDelivery) => {
    double.bind(onDelivery);
    return double.connection;
  },
});

const ingressDouble = () => {
  const calls: Parameters<WebhookIngress['deliver']>[0][] = [];
  const ingress: WebhookIngress = {
    deliver: async (input) => {
      calls.push(input);
      return {
        kind: 'accepted',
        deliveryId: 'slack:d-1',
        events: 1,
        ignored: 0,
        redactionCount: 0,
      };
    },
  };
  return { ingress, calls };
};

const settle = async (): Promise<void> => {
  for (let round = 0; round < 10; round += 1) {
    await Promise.resolve();
  }
};

describe('a process that serves /webhooks/*', () => {
  it('opens one connection per account at composition and hands its deliveries to the ingress', async () => {
    const double = connectionDouble([]);
    const { ingress, calls } = ingressDouble();
    const clock = manualScheduler();

    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, double)] },
      ingress,
      role: 'all',
      scheduler: clock.scheduler,
    });
    await settle();

    expect(double.log).toEqual(['start']);
    expect(handle.status()).toEqual([
      { integrationId: A, provider: 'slack', name: 'slack a1', state: 'open' },
    ]);
    const delivery = { headers: { 'x-slack-signature': 'v0=fake' }, body: '{}' };
    await double.deliver(delivery);
    expect(calls).toEqual([{ provider: 'slack', integrationId: A, delivery }]);
    await handle.stop();
  });

  it('closes every connection at shutdown, and stop resolves only after each has', async () => {
    const first = connectionDouble([]);
    const second = connectionDouble([]);
    const clock = manualScheduler();
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, first), account(B, second)] },
      ingress: ingressDouble().ingress,
      role: 'api',
      scheduler: clock.scheduler,
    });
    await settle();

    await handle.stop();

    expect(first.log).toEqual(['start', 'stopped']);
    expect(second.log).toEqual(['start', 'stopped']);
    // Nothing is left scheduled: no re-list and no retry outlives the handle.
    expect(clock.live()).toEqual([]);
  });

  it('retries a start a retry can fix, on the backoff, and cancels the retry at shutdown', async () => {
    const double = connectionDouble([
      async () => {
        throw new IntegrationError('unavailable', 'slack', 'slack.com could not be reached');
      },
    ]);
    const clock = manualScheduler();
    const { logger, lines } = recordingLogger();
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, double)] },
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: clock.scheduler,
      logger,
      retryBaseMs: 100,
    });
    await settle();

    expect(handle.status()[0]?.state).toBe('retrying');
    expect(lines.find((line) => line.level === 'warn')?.fields).toMatchObject({
      integration: 'slack a1',
      retry_in_ms: 100,
    });

    clock.fire(100);
    await settle();
    expect(double.log).toEqual(['start', 'start']);
    expect(handle.status()[0]?.state).toBe('open');
    await handle.stop();
  });

  it('does not retry a refusal no retry fixes, and names the account', async () => {
    const double = connectionDouble([
      async () => {
        throw new IntegrationError('unauthorised', 'slack', 'invalid_auth');
      },
    ]);
    const clock = manualScheduler();
    const { logger, lines } = recordingLogger();
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, double)] },
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: clock.scheduler,
      logger,
      retryBaseMs: 100,
    });
    await settle();

    expect(handle.status()[0]?.state).toBe('refused');
    expect(clock.live().filter((entry) => entry.ms === 100)).toEqual([]);
    expect(lines.filter((line) => line.level === 'error')[0]?.fields).toMatchObject({
      integration_id: A,
      integration: 'slack a1',
    });
    await handle.stop();
  });

  it('names an account that cannot hold a connection as configured, and opens nothing for it', async () => {
    const { logger, lines } = recordingLogger();
    const handle = await startInboundConnections({
      directory: {
        list: async () => [
          {
            kind: 'selected',
            integrationId: A,
            provider: 'slack',
            name: 'no app token',
            open: () => {
              throw new IntegrationError('invalid_request', 'slack', 'set SLACK_APP_TOKEN');
            },
          },
        ],
      },
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: manualScheduler().scheduler,
      logger,
    });

    expect(handle.status()[0]?.state).toBe('refused');
    expect(lines.filter((line) => line.level === 'error')[0]?.fields).toMatchObject({
      integration: 'no app token',
    });
    await handle.stop();
  });

  it('names an account whose configuration cannot be read', async () => {
    const broken: BrokenHeldConnectionAccount = {
      kind: 'broken',
      integrationId: A,
      provider: 'slack',
      name: 'undecryptable',
      detail: 'its credentials cannot be read: bad envelope',
    };
    const { logger, lines } = recordingLogger();
    const handle = await startInboundConnections({
      directory: { list: async () => [broken] },
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: manualScheduler().scheduler,
      logger,
    });

    expect(lines.filter((line) => line.level === 'error')[0]?.fields).toMatchObject({
      integration: 'undecryptable',
      detail: 'its credentials cannot be read: bad envelope',
    });
    await handle.stop();
  });

  it('opens an account created after start-up at the next re-list, and closes one that went away', async () => {
    const first = connectionDouble([]);
    const later = connectionDouble([]);
    let listed: HeldConnectionAccount[] = [account(A, first)];
    const clock = manualScheduler();
    const handle = await startInboundConnections({
      directory: { list: async () => listed },
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: clock.scheduler,
      relistMs: 60_000,
    });
    await settle();

    listed = [account(B, later)];
    clock.fire(60_000);
    await settle();

    expect(first.log).toEqual(['start', 'stopped']);
    expect(later.log).toEqual(['start']);
    expect(handle.status().map((status) => status.integrationId)).toEqual([B]);
    await handle.stop();
  });

  it('waits for a start in flight before closing, so shutdown does not race the open', async () => {
    let release: () => void = () => {};
    const double = connectionDouble([
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    ]);
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, double)] },
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: manualScheduler().scheduler,
    });

    const stopping = handle.stop();
    await settle();
    expect(double.log).toEqual(['start']);
    release();
    await stopping;
    expect(double.log).toEqual(['start', 'stopped']);
  });
});

describe('a process that serves no /webhooks/*', () => {
  it('opens nothing and names every account it is not holding, once (criterion 4)', async () => {
    const double = connectionDouble([]);
    const clock = manualScheduler();
    const { logger, lines } = recordingLogger();
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, double)] },
      ingress: null,
      role: 'worker',
      scheduler: clock.scheduler,
      logger,
      relistMs: 60_000,
    });
    clock.fire(60_000);
    await settle();

    expect(double.log).toEqual([]);
    expect(handle.status()).toEqual([]);
    const named = lines.filter((line) => line.level === 'warn');
    expect(named).toHaveLength(1);
    expect(named[0]?.fields).toMatchObject({ integration: 'slack a1', role: 'worker' });
    expect(named[0]?.message).toContain('ROLE=worker serves no /webhooks/*');
    await handle.stop();
  });
});
