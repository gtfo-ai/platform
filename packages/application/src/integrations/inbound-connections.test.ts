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
  HeldConnectionLiveness,
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
  fingerprint = 'fingerprint-1',
): HeldConnectionAccount => ({
  kind: 'selected',
  integrationId,
  provider: 'slack',
  name: `slack ${integrationId.slice(-2)}`,
  fingerprint,
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

/** A liveness store that records what it was told, in order (WP-72, backlog 200). */
const livenessDouble = (options: { readonly failRenew?: boolean } = {}) => {
  const calls: string[] = [];
  const store: HeldConnectionLiveness = {
    renew: async (integrationId, holder, ttlMs) => {
      calls.push(`renew ${integrationId.slice(-2)} ${holder} ${ttlMs}`);
      if (options.failRenew === true) {
        throw new Error('connection terminated');
      }
    },
    release: async (integrationId, holder) => {
      calls.push(`release ${integrationId.slice(-2)} ${holder}`);
    },
    isHeld: async () => false,
  };
  return {
    calls,
    options: { store, holder: 'api@test', renewMs: 20_000, ttlMs: 60_000 },
  };
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
      liveness: livenessDouble().options,
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
    // WP-87: a held connection's envelope is never the rate-limited door.
    expect(calls).toEqual([
      { provider: 'slack', integrationId: A, delivery, transport: 'held_connection' },
    ]);
    await handle.stop();
  });

  it('closes every connection at shutdown, and stop resolves only after each has', async () => {
    const first = connectionDouble([]);
    const second = connectionDouble([]);
    const clock = manualScheduler();
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, first), account(B, second)] },
      liveness: livenessDouble().options,
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
      liveness: livenessDouble().options,
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
      liveness: livenessDouble().options,
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
      liveness: livenessDouble().options,
      directory: {
        list: async () => [
          {
            kind: 'selected',
            integrationId: A,
            provider: 'slack',
            name: 'no app token',
            fingerprint: 'fingerprint-1',
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
      fingerprint: 'fingerprint-broken',
    };
    const { logger, lines } = recordingLogger();
    const handle = await startInboundConnections({
      directory: { list: async () => [broken] },
      liveness: livenessDouble().options,
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
      liveness: livenessDouble().options,
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

  /**
   * WP-73b, PROGRESS backlog 197: the re-list used to diff by integration id only, so an account it
   * already held — or had named broken — was never re-opened, and a rotated token needed a restart.
   */
  it('closes and re-opens an account whose fingerprint changed, and leaves an unchanged one', async () => {
    const before = connectionDouble([]);
    const after = connectionDouble([]);
    const steady = connectionDouble([]);
    let listed: HeldConnectionAccount[] = [account(A, before), account(B, steady)];
    const clock = manualScheduler();
    const handle = await startInboundConnections({
      directory: { list: async () => listed },
      liveness: livenessDouble().options,
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: clock.scheduler,
      relistMs: 60_000,
    });
    await settle();

    // A's credential was re-sealed under a new secret id; B's account is unchanged.
    listed = [account(A, after, 'fingerprint-2'), account(B, steady)];
    clock.fire(60_000);
    await settle();

    expect(before.log).toEqual(['start', 'stopped']);
    expect(after.log).toEqual(['start']);
    expect(steady.log).toEqual(['start']);
    expect(handle.status().map((status) => [status.integrationId, status.state])).toEqual([
      [B, 'open'],
      [A, 'open'],
    ]);
    await handle.stop();
  });

  it('re-opens a broken account once an operator fixed it', async () => {
    const fixed = connectionDouble([]);
    let listed: (HeldConnectionAccount | BrokenHeldConnectionAccount)[] = [
      {
        kind: 'broken',
        integrationId: A,
        provider: 'slack',
        name: 'slack a1',
        detail: 'its configuration fails its schema at: app_token',
        fingerprint: 'fingerprint-broken',
      },
    ];
    const clock = manualScheduler();
    const handle = await startInboundConnections({
      directory: { list: async () => listed },
      liveness: livenessDouble().options,
      ingress: ingressDouble().ingress,
      role: 'all',
      scheduler: clock.scheduler,
      relistMs: 60_000,
    });
    await settle();
    expect(handle.status().map((status) => status.state)).toEqual(['refused']);

    listed = [account(A, fixed, 'fingerprint-fixed')];
    clock.fire(60_000);
    await settle();

    expect(fixed.log).toEqual(['start']);
    expect(handle.status().map((status) => status.state)).toEqual(['open']);
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
      liveness: livenessDouble().options,
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
      liveness: livenessDouble().options,
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

describe('the liveness row a held connection renews (WP-72, PROGRESS backlog 200)', () => {
  it('is written before the connection reads open, renewed on the interval, and released at close', async () => {
    const double = connectionDouble([]);
    const liveness = livenessDouble();
    const clock = manualScheduler();
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, double)] },
      liveness: liveness.options,
      ingress: ingressDouble().ingress,
      role: 'api',
      scheduler: clock.scheduler,
    });
    await settle();

    expect(handle.status()[0]?.state).toBe('open');
    expect(liveness.calls).toEqual(['renew a1 api@test 60000']);

    clock.fire(20_000);
    await settle();
    expect(liveness.calls).toEqual(['renew a1 api@test 60000', 'renew a1 api@test 60000']);

    await handle.stop();
    expect(liveness.calls.at(-1)).toBe('release a1 api@test');
    // No renewal outlives the handle.
    expect(clock.live()).toEqual([]);
  });

  it('writes nothing for a connection that never opened, and nothing on a process that holds none', async () => {
    const refused = connectionDouble([
      async () => {
        throw new IntegrationError('unauthorised', 'slack', 'invalid_auth');
      },
    ]);
    const onApi = livenessDouble();
    const api = await startInboundConnections({
      directory: { list: async () => [account(A, refused)] },
      liveness: onApi.options,
      ingress: ingressDouble().ingress,
      role: 'api',
      scheduler: manualScheduler().scheduler,
    });
    await settle();
    await api.stop();
    expect(onApi.calls).toEqual([]);

    const onWorker = livenessDouble();
    const clock = manualScheduler();
    const worker = await startInboundConnections({
      directory: { list: async () => [account(B, connectionDouble([]))] },
      liveness: onWorker.options,
      ingress: null,
      role: 'worker',
      scheduler: clock.scheduler,
    });
    // A process with no door schedules no renewal at all.
    expect(clock.live().filter((entry) => entry.ms === 20_000)).toEqual([]);
    await worker.stop();
    expect(onWorker.calls).toEqual([]);
  });

  it('keeps the connection open when the row cannot be written, and says so', async () => {
    const double = connectionDouble([]);
    const { logger, lines } = recordingLogger();
    const handle = await startInboundConnections({
      directory: { list: async () => [account(A, double)] },
      liveness: livenessDouble({ failRenew: true }).options,
      ingress: ingressDouble().ingress,
      role: 'api',
      scheduler: manualScheduler().scheduler,
      logger,
    });
    await settle();

    expect(handle.status()[0]?.state).toBe('open');
    expect(lines.find((line) => line.level === 'warn')?.message).toContain(
      'approvals are posted as text until the next renewal succeeds',
    );
    await handle.stop();
  });

  it('refuses a TTL that does not outlast the renewal interval', async () => {
    const liveness = livenessDouble();
    await expect(
      startInboundConnections({
        directory: { list: async () => [] },
        liveness: { ...liveness.options, renewMs: 60_000, ttlMs: 60_000 },
        ingress: null,
        role: 'api',
        scheduler: manualScheduler().scheduler,
      }),
    ).rejects.toThrow(/must exceed its renewal interval/);
  });
});
