/**
 * The account prober behind `POST /api/integrations/:id/test` (WP-21).
 *
 * The three answers it has to keep apart are the ones `inbound-loader.test.ts` keeps apart one
 * question over: an integration **nobody has** (`null`, a 404 that writes nothing), an adapter that
 * **cannot be built** (a thrown `BindingLoadError` — a deployment defect that must not look like a
 * wrong id), and a probe that **came back with a verdict**, including a failing one. The third is
 * the case a wizard step depends on: `ok: false` is a successful test reporting a failed
 * connection, and collapsing it into an error would leave an operator unable to tell "your token is
 * wrong" from "the platform is broken".
 *
 * The fourth thing asserted here is the redaction of the probe's `detail`, which is provider text
 * on its way to an HTTP response and to `integrations.health`. Every `testConnection` already owes
 * it (`healthProbeSchema.detail` says so); this module applies it **again**, and the registration
 * below composes no redactor of its own so that deleting the second application is visible —
 * the same seam `loader.test.ts` uses for the same reason (standing rule 35: a required
 * collaborator proves it is supplied, only a planted secret proves it is used).
 *
 * And the fifth, which is the one a review earned: the call goes through a **real**
 * `IntegrationActionExecutor`, not a stub, so the audit row (BD-003) and the rate limit are
 * asserted rather than assumed. A probe is the product's only HTTP-triggered outbound call; without
 * the executor it writes no row and takes no budget, and nothing else in any tier would notice.
 */
import type {
  BindingRepository,
  IntegrationAccount,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  SecretResolutionError,
  type VirtualTimer,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { AnyProviderRegistration } from '../registry.js';
import { createIntegrationRegistry } from '../registry.js';
import { BindingLoadError } from './loader.js';
import { createIntegrationProber } from './prober.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000000d1' as Id;
const SECRET = '00000000-0000-4000-8000-0000000000d2' as Id;

/** Obviously fake (BD-002), planted so the redaction assertion has something to look for. */
const PLANTED_TOKEN = 'FAKE-probe-token-not-a-real-secret-0001';

const accountOf = (overrides: Partial<IntegrationAccount> = {}): IntegrationAccount => ({
  integrationId: INTEGRATION,
  type: 'errors',
  provider: 'probe',
  name: 'acme errors',
  config: { organisation: 'acme' },
  secretIds: [SECRET],
  bindings: [],
  ...overrides,
});

const repositoryOf = (account: IntegrationAccount | null): BindingRepository => ({
  forProject: async () => [],
  forIntegration: async () => account,
});

const secretsOf = (
  resolved: Readonly<Record<string, string>> | Error = { api_token: PLANTED_TOKEN },
): SecretStore => ({
  resolve: async () => {
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved;
  },
});

/** A registration whose probe is scripted, and which composes **no redactor of its own**. */
const probeRegistration = (options: {
  readonly probe?: () => Promise<{ ok: boolean; checked_at: string; detail?: string | null }>;
  readonly throwOnCreate?: boolean;
  readonly withoutTestConnection?: boolean;
}): AnyProviderRegistration => ({
  id: 'probe',
  type: 'errors',
  displayName: 'Probe',
  configSchema: z.strictObject({
    organisation: z.string().min(1),
    api_token: z.string().min(1),
  }),
  secretFields: ['api_token'],
  setupGuidePath: 'none',
  agentTooling: null,
  create: () => {
    if (options.throwOnCreate === true) {
      throw new Error('the adapter refused to be built');
    }
    const port = {
      ref: { integrationId: INTEGRATION, provider: 'probe', type: 'errors' },
      capabilities: () => ({}),
    };
    return (
      options.withoutTestConnection === true
        ? port
        : {
            ...port,
            testConnection:
              options.probe ??
              (async () => ({ ok: true, checked_at: '2026-09-13T04:00:00.000Z', detail: 'fine' })),
          }
    ) as never;
  },
});

let auditLog: MemoryIntegrationAuditLog;
let timer: VirtualTimer;

/** The real executor, with a token bucket small enough for a burst assertion to be cheap. */
const executorFor = (rateLimits = { capacity: 2, refillPerSecond: 1, maxConcurrent: 2 }) =>
  createIntegrationActionExecutor({
    auditLog,
    // The audit row's own redactor is the platform's step 2; the account's step 1 is applied by
    // the prober. Nothing here has a credential of its own to redact, said out loud (TD-012).
    redactor: noSecretsRedactor(),
    timer,
    clock: fixedClock('2026-09-13T04:00:00.000Z', 1000),
    rateLimits,
  });

const proberFor = (
  account: IntegrationAccount | null,
  options: Parameters<typeof probeRegistration>[0] = {},
  secrets: SecretStore = secretsOf(),
  redactor: SecretRedactor = exactSecretRedactor([{ name: 'probe_token', value: PLANTED_TOKEN }]),
  executor = executorFor(),
) =>
  createIntegrationProber({
    repository: repositoryOf(account),
    secrets,
    registry: createIntegrationRegistry([probeRegistration(options)]),
    executor,
    platformRedactor: redactor,
  });

beforeEach(() => {
  auditLog = createMemoryAuditLog();
  timer = createVirtualTimer({ autoAdvance: true });
});

describe('createIntegrationProber', () => {
  it('answers null for an integration nobody has', async () => {
    expect(await proberFor(null).test(INTEGRATION)).toBeNull();
  });

  it('returns the provider’s own verdict', async () => {
    const result = await proberFor(accountOf()).test(INTEGRATION);
    expect(result).toEqual({
      ok: true,
      checkedAt: '2026-09-13T04:00:00.000Z',
      detail: 'fine',
    });
  });

  it('reports a failed connection as a successful test', async () => {
    // The other side of the case above (rule 42), and the one the wizard depends on.
    const result = await proberFor(accountOf(), {
      probe: async () => ({
        ok: false,
        checked_at: '2026-09-13T04:00:00.000Z',
        detail: 'the provider answered 401',
      }),
    }).test(INTEGRATION);
    expect(result?.ok).toBe(false);
    expect(result?.detail).toBe('the provider answered 401');
  });

  it('reads a probe with no detail as an empty one rather than as null', async () => {
    const result = await proberFor(accountOf(), {
      probe: async () => ({ ok: true, checked_at: '2026-09-13T04:00:00.000Z' }),
    }).test(INTEGRATION);
    expect(result?.detail).toBe('');
  });

  it('redacts the detail, because a rejected-credential message quotes the credential', async () => {
    const result = await proberFor(accountOf(), {
      probe: async () => ({
        ok: false,
        checked_at: '2026-09-13T04:00:00.000Z',
        detail: `401 for token ${PLANTED_TOKEN}`,
      }),
    }).test(INTEGRATION);
    expect(result?.detail).not.toContain(PLANTED_TOKEN);
    expect(result?.detail).toContain('[REDACTED');
    // …and the rest of the message survived, which a redactor that blanked everything would also
    // satisfy (standing rule 42).
    expect(result?.detail).toContain('401 for token');
  });

  it('throws for a provider this build does not register', async () => {
    await expect(
      proberFor(accountOf({ provider: 'not-registered' })).test(INTEGRATION),
    ).rejects.toBeInstanceOf(BindingLoadError);
  });

  it('throws when the credential cannot be read', async () => {
    await expect(
      proberFor(accountOf(), {}, secretsOf(new SecretResolutionError('nope', []))).test(
        INTEGRATION,
      ),
    ).rejects.toBeInstanceOf(BindingLoadError);
  });

  it('throws when the merged configuration fails the provider’s schema, naming paths only', async () => {
    const failing = proberFor(accountOf({ config: {} }));
    await expect(failing.test(INTEGRATION)).rejects.toThrow(/fails its schema at: organisation/);
    // The message reaches a log and an operator; the credential the merge just put in it does not.
    await expect(failing.test(INTEGRATION)).rejects.not.toThrow(new RegExp(PLANTED_TOKEN));
  });

  it('throws when the adapter refuses to be built', async () => {
    await expect(proberFor(accountOf(), { throwOnCreate: true }).test(INTEGRATION)).rejects.toThrow(
      /could not be instantiated/,
    );
  });

  it('throws when the built port has no probe at all', async () => {
    // Unreachable while every registration builds an `IntegrationPort`, and asserted anyway because
    // what a new provider gets wrong is the object rather than the type (standing rule 22).
    await expect(
      proberFor(accountOf(), { withoutTestConnection: true }).test(INTEGRATION),
    ).rejects.toThrow(/no testConnection/);
  });

  it('writes an audit row for the call, because it is an outbound provider call', async () => {
    // CLAUDE.md's non-negotiable: every outbound provider call goes through
    // `IntegrationActionExecutor`. Without it this call is unaudited and unlimited — and it is the
    // product's only HTTP-triggered outbound call, so nothing else would notice.
    await proberFor(accountOf()).test(INTEGRATION);
    expect(auditLog.entries).toHaveLength(1);
    const entry = auditLog.entries[0];
    expect(entry?.action).toBe('test_connection');
    expect(entry?.status).toBe('ok');
    expect(entry?.integrationId).toBe(INTEGRATION);
    expect(entry?.mutating).toBe(false);
    // An integration belongs to the organisation and a probe to no task — the case
    // `ReadActionRequest.mode` is optional for.
    expect(entry?.projectId ?? null).toBeNull();
    expect(entry?.taskId ?? null).toBeNull();
    // The verdict is the evidence; the provider's prose is not copied into the row.
    expect(entry?.result).toEqual({ ok: true });
    expect(JSON.stringify(entry)).not.toContain(PLANTED_TOKEN);
  });

  it('audits a failed connection as a successful call, not as a failure', async () => {
    // The other side (rule 42): `ok: false` is a call that happened. An executor status of
    // `failed` would mean the *call* threw, which is a different operator problem.
    await proberFor(accountOf(), {
      probe: async () => ({ ok: false, checked_at: '2026-09-13T04:00:00.000Z', detail: '401' }),
    }).test(INTEGRATION);
    expect(auditLog.entries[0]?.status).toBe('ok');
    expect(auditLog.entries[0]?.result).toEqual({ ok: false });
  });

  it('takes the integration’s rate limit, so a burst waits instead of being forwarded', async () => {
    /**
     * The limiter **delays**; it does not refuse (`RateLimiter.acquire` "resolves when a
     * concurrency slot *and* a token are available"), so the observable effect is the wait it asked
     * the timer for — the same assertion `action-executor.contract.test.ts` makes about backoff,
     * and the reason nothing here touches a wall clock (standing rule 2).
     *
     * `capacity: 2, refillPerSecond: 1`: two probes go straight out and the third has to wait about
     * a second for a token. Both directions (rule 42) — a prober that bypassed the executor would
     * ask for no wait at all, and a limiter that always waited would fail the first assertion.
     */
    const prober = proberFor(
      accountOf(),
      {},
      secretsOf(),
      undefined,
      executorFor({ capacity: 2, refillPerSecond: 1, maxConcurrent: 2 }),
    );
    expect((await prober.test(INTEGRATION))?.ok).toBe(true);
    expect((await prober.test(INTEGRATION))?.ok).toBe(true);
    expect(timer.sleeps).toEqual([]);

    expect((await prober.test(INTEGRATION))?.ok).toBe(true);
    expect(timer.sleeps.length).toBeGreaterThan(0);
    expect(Math.max(...timer.sleeps)).toBeGreaterThan(500);
    // Every call still happened and every one is audited: a limit that dropped calls silently
    // would be worse than no limit.
    expect(auditLog.entries).toHaveLength(3);
  });
});
