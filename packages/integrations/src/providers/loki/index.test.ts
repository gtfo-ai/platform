/**
 * The Loki binding's configuration, its registration, its auth-header rules and the nanosecond
 * arithmetic (technical/10 unit tier).
 */
import { noSecretsRedactor } from '@platform/application';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createIntegrationRegistry } from '../../registry.js';
import { lokiConfigSchema, lokiSecretFields } from './config.js';
import { type LokiAuth, lokiAuthHeaders, parseRetryAfterMs } from './http.js';
import { lokiProviderRegistration, lokiRateLimitPolicy } from './index.js';
import {
  capBytes,
  LOKI_AGENT_TOOLING,
  millisecondsToNanoseconds,
  nanosecondsToIso,
} from './provider.js';

const NOW = Date.parse('2026-06-01T10:30:00.000Z');

/**
 * Standing rule 2: a property test must not inherit Vitest's 5 s default, or the verdict is a
 * reading of this machine. Declared locally — `contracts` and `domain` keep their copies out of
 * their `index.ts` on purpose, and a shared home needs its own package (PROGRESS.md).
 */
const PROPERTY_TEST_TIMEOUT_MS = 30_000;

const auth = (overrides: Partial<LokiAuth> = {}): LokiAuth => ({
  mode: 'bearer',
  bearerToken: 'FAKE-loki-bearer-token-DO-NOT-USE',
  username: null,
  password: null,
  tenantId: null,
  ...overrides,
});

describe('lokiConfigSchema', () => {
  it('defaults to bearer auth and to the caps the port publishes', () => {
    const config = lokiConfigSchema.parse({ base_url: 'https://loki.example.test:3100' });
    expect(config).toMatchObject({
      auth_mode: 'bearer',
      max_range_ms: 86_400_000,
      max_lines: 1000,
      max_line_bytes: 8_192,
      max_total_bytes: 1_048_576,
      max_label_bytes: 1_024,
      max_labels: 64,
      max_label_values: 1000,
      max_series: 500,
      label_lookback_ms: 21_600_000,
    });
  });

  it.each([
    ['https://loki.example.test:3100/loki/api/v1'],
    ['https://loki.example.test:3100/loki/api/v1/'],
    ['https://loki.example.test:3100/'],
  ])('refuses %s', (baseUrl) => {
    expect(() => lokiConfigSchema.parse({ base_url: baseUrl })).toThrow();
  });

  it('refuses an unknown key, because a boundary schema is strict', () => {
    expect(() =>
      lokiConfigSchema.parse({ base_url: 'https://loki.example.test:3100', tenant: 'acme' }),
    ).toThrow();
  });
});

describe('lokiAuthHeaders (standing rule 18, with a legitimate anonymous mode)', () => {
  it('sends a bearer header when the token is usable', () => {
    expect(lokiAuthHeaders(auth(), 'query_range')).toEqual({
      authorization: 'Bearer FAKE-loki-bearer-token-DO-NOT-USE',
    });
  });

  it.each([[null], [''], ['   ']])(
    'refuses a %j bearer token rather than going anonymous',
    (token) => {
      let caught: unknown;
      try {
        lokiAuthHeaders(auth({ bearerToken: token as string | null }), 'query_range');
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string })?.code).toBe('unauthorised');
    },
  );

  it('builds basic auth from a username and a password', () => {
    expect(
      lokiAuthHeaders(
        auth({ mode: 'basic', username: 'agentic', password: 'FAKE-loki-password-000' }),
        'labels',
      ).authorization,
    ).toBe(`Basic ${Buffer.from('agentic:FAKE-loki-password-000').toString('base64')}`);
  });

  it.each([
    [{ mode: 'basic' as const, username: 'agentic', password: '' }],
    [{ mode: 'basic' as const, username: '', password: 'FAKE-loki-password-000' }],
    [{ mode: 'basic' as const, username: null, password: null }],
  ])('refuses incomplete basic credentials %j', (overrides) => {
    let caught: unknown;
    try {
      lokiAuthHeaders(auth(overrides), 'labels');
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('unauthorised');
  });

  /**
   * The half that makes rule 18 applicable to a product that really can be unauthenticated: the
   * permissive outcome requires an explicit `auth_mode: none`, never a missing value.
   */
  it('sends no Authorization header when the operator chose auth_mode: none', () => {
    expect(lokiAuthHeaders(auth({ mode: 'none', bearerToken: null }), 'labels')).toEqual({});
  });

  it('adds the tenant header only when a tenant is named', () => {
    expect(lokiAuthHeaders(auth({ tenantId: 'acme' }), 'labels')['x-scope-orgid']).toBe('acme');
    expect(lokiAuthHeaders(auth({ tenantId: '  ' }), 'labels')['x-scope-orgid']).toBeUndefined();
  });
});

describe('parseRetryAfterMs', () => {
  it.each([
    ['2', 2000],
    ['0', 0],
    ['Mon, 01 Jun 2026 10:30:05 GMT', 5000],
  ])('reads %s', (value, expected) => {
    expect(parseRetryAfterMs(value, NOW)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['soon']])('answers null for %j', (value) => {
    expect(parseRetryAfterMs(value as string | null | undefined, NOW)).toBeNull();
  });
});

describe('nanosecond arithmetic', () => {
  /**
   * The `BigInt` is load-bearing, and review round 1 said the opposite.
   *
   * Round 1 mutated `BigInt` to `Number`, watched the mutation survive, and concluded the rounding
   * was harmless — then narrowed the docblock instead of the code. The reviewer measured it: at
   * 1.8e18 doubles are 256 ns apart, so `Number` moves this entry into the **next millisecond**,
   * and that millisecond is both the emitted `timestamp` and the key `queryRange` sorts on. This
   * assertion is what kills the mutation; the second one records the divergence so that a future
   * reader does not have to rediscover it.
   */
  it('dates an entry by its own millisecond, where Number moves it into the next one', () => {
    expect(nanosecondsToIso('1780309799999999872', 'query_range')).toBe('2026-06-01T10:29:59.999Z');
    expect(
      new Date(Math.trunc(Number('1780309799999999872') / 1e6)).toISOString(),
      'the Number implementation answers 10:30:00.000Z for the same entry',
    ).toBe('2026-06-01T10:30:00.000Z');
  });

  /** The size of the hole, measured rather than asserted from a docblock. */
  it('diverges from the Number implementation for 192 of a million consecutive instants', () => {
    let diverged = 0;
    const base = 1780309799000000000n;
    for (let offset = 0; offset < 1_000_000; offset += 1) {
      const value = (base + BigInt(offset)).toString();
      const exact = nanosecondsToIso(value, 'query_range');
      const rounded = new Date(Math.trunc(Number(value) / 1e6)).toISOString();
      if (exact !== rounded) {
        diverged += 1;
      }
    }
    expect(diverged).toBe(192);
  });

  it('reads a nanosecond epoch exactly, where Number would round it silently', () => {
    expect(nanosecondsToIso('1780305060123456789', 'query_range')).toBe('2026-06-01T09:11:00.123Z');
    expect(Number.isSafeInteger(Number('1780305060123456789'))).toBe(false);
    expect(String(Math.trunc(Number('1780305060123456789')))).not.toBe('1780305060123456789');
    expect(BigInt('1780305060123456789').toString()).toBe('1780305060123456789');
  });

  it('round-trips a millisecond instant', () => {
    const millis = Date.parse('2026-06-01T09:00:00.000Z');
    expect(millisecondsToNanoseconds(millis)).toBe('1780304400000000000');
    expect(nanosecondsToIso(millisecondsToNanoseconds(millis), 'query_range')).toBe(
      '2026-06-01T09:00:00.000Z',
    );
  });

  it.each([['not-a-number'], ['12.5'], ['']])('refuses %j as a timestamp', (value) => {
    let caught: unknown;
    try {
      nanosecondsToIso(value, 'query_range');
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string })?.code).toBe('invalid_response');
  });
});

describe('the registration (BD-017)', () => {
  it('registers under the logs type and survives the registry’s secret-field check', () => {
    const registry = createIntegrationRegistry([lokiProviderRegistration]);
    expect(registry.get('logs', 'loki').displayName).toBe('Grafana Loki');
    expect([...lokiSecretFields]).toEqual(['bearer_token', 'password']);
  });

  it('cannot be handed to a caller that wants another type', () => {
    const registry = createIntegrationRegistry([lokiProviderRegistration]);
    expect(() => registry.get('errors', 'loki')).toThrow(/is a "logs" provider/);
  });

  /**
   * Loki declares a CLI because its environment contract is published; the assertion is that the
   * declaration is *names only*, and that the one variable carrying a credential is marked secret.
   */
  it('declares logcli by name, marks only the token secret, and names no basic-auth pair', () => {
    expect(LOKI_AGENT_TOOLING.cli?.command).toBe('logcli');
    expect(LOKI_AGENT_TOOLING.env.variables.map((variable) => variable.name)).toEqual([
      'LOKI_ADDR',
      'LOKI_BEARER_TOKEN',
      'LOKI_ORG_ID',
    ]);
    expect(
      LOKI_AGENT_TOOLING.env.variables
        .filter((variable) => variable.secret)
        .map((variable) => variable.name),
    ).toEqual(['LOKI_BEARER_TOKEN']);
    expect(
      JSON.stringify(LOKI_AGENT_TOOLING),
      'the binding’s own account must not be injectable into a run container',
    ).not.toContain('LOKI_PASSWORD');
  });

  it('publishes the configured caps through the port', () => {
    const port = lokiProviderRegistration.create({
      integrationId: '00000000-0000-4000-8000-0000000000a7',
      config: { base_url: 'https://loki.example.test:3100', max_lines: 250 },
      secrets: { bearer_token: 'FAKE-loki-bearer-token-DO-NOT-USE' },
      // Standing rule 31: `ProviderCreateInput.redactor` is required, so this line is the whole
      // fix in miniature — round 1 could not have written it, because the field did not exist.
      redactor: noSecretsRedactor(),
    });
    expect(port.ref).toEqual({
      integrationId: '00000000-0000-4000-8000-0000000000a7',
      provider: 'loki',
      type: 'logs',
    });
    expect(port.capabilities()).toEqual({
      labels: true,
      series: true,
      maxRangeMs: 86_400_000,
      maxLines: 250,
    });
  });

  it('asks for less than a shared Loki is likely to allow, because nothing is published', () => {
    expect(lokiRateLimitPolicy.capacity).toBeLessThanOrEqual(6);
    expect(lokiRateLimitPolicy.maxConcurrent).toBeLessThanOrEqual(2);
  });
});

describe('capBytes (the shape review round 2 made one rule for both adapters)', () => {
  /**
   * The marker used to be appended **outside** `maxBytes`, which made the cap a bound on the
   * provider's text rather than on the emitted string — and, the part that mattered, made it
   * non-idempotent: a second application measured the first one's marker and reported a
   * dropped-byte count about platform text. Sentry's twin shipped that live and two of its call
   * sites disagreed about the same value by a factor of seventeen.
   *
   * Idempotence is asserted as a *consequence of the bound* rather than by recognising the marker:
   * the input is untrusted (BD-022), and a provider can forge any suffix it likes but cannot forge
   * a length.
   */
  it(
    'never emits more than maxBytes, and applying it twice changes nothing',
    () => {
      const encoder = new TextEncoder();
      fc.assert(
        fc.property(
          fc.string({ unit: 'binary', maxLength: 300 }),
          fc.integer({ min: 1, max: 200 }),
          fc.constantFrom('max_line_bytes', 'max_label_bytes'),
          (text, maxBytes, capName) => {
            const once = capBytes(text, maxBytes, capName);
            expect(
              encoder.encode(once.text).length,
              'the marker is counted inside the cap',
            ).toBeLessThanOrEqual(maxBytes);
            expect(capBytes(once.text, maxBytes, capName).text, 'twice is once').toBe(once.text);
          },
        ),
        { numRuns: 500 },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('leaves a string that fits alone and reports nothing dropped', () => {
    expect(capBytes('hello', 5, 'max_line_bytes')).toEqual({ text: 'hello', droppedBytes: 0 });
  });

  it('never splits a multi-byte character, so no tail becomes U+FFFD', () => {
    const capped = capBytes(`${'é'.repeat(200)}`, 100, 'max_label_bytes');
    expect(capped.text).not.toContain('\uFFFD');
    expect(capped.text.startsWith('é')).toBe(true);
  });

  it('emits its marker, cut, when the cap is smaller than the marker itself', () => {
    const capped = capBytes('abcdef', 3, 'max_line_bytes');
    expect(new TextEncoder().encode(capped.text).length).toBeLessThanOrEqual(3);
    expect(capBytes(capped.text, 3, 'max_line_bytes').text).toBe(capped.text);
  });
});
