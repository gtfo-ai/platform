import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadServerConfig,
  POOL_RESERVATIONS,
  requiredPoolConnections,
  SERVER_CONFIG_DEFAULTS,
  type ServerConfig,
  UndersizedPoolError,
} from './config.js';

/** The smallest environment that parses. Everything else in these tests is an override. */
const MINIMAL = {
  DATABASE_URL: 'postgres://app:app@db:5432/app',
  APP_SECRET_KEY: 'x'.repeat(40),
} as const;

const load = (overrides: Record<string, string | undefined> = {}): ServerConfig =>
  loadServerConfig({ ...MINIMAL, ...overrides });

describe('loadServerConfig', () => {
  it('applies the documented defaults', () => {
    const config = load();
    expect(config.role).toBe('all');
    expect(config.port).toBe(SERVER_CONFIG_DEFAULTS.port);
    expect(config.baseUrl).toBe(SERVER_CONFIG_DEFAULTS.baseUrl);
    expect(config.logFormat).toBe('json');
    expect(config.timezone).toBe('UTC');
    expect(config.ssePingIntervalMs).toBe(20_000);
    expect(config.sseRetryMs).toBe(1_000);
    // Open registration is off unless an operator asks for it.
    expect(config.allowSignUp).toBe(false);
  });

  it('refuses a missing secret rather than inventing one', () => {
    expect(() => loadServerConfig({ DATABASE_URL: MINIMAL.DATABASE_URL })).toThrow(
      /APP_SECRET_KEY.*at least 32 characters/s,
    );
  });

  it('refuses a short secret', () => {
    expect(() => load({ APP_SECRET_KEY: 'too-short' })).toThrow(/APP_SECRET_KEY/);
  });

  it('reads a secret from its _FILE variant, the Docker secrets convention', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wp06-config-'));
    const file = join(directory, 'secret');
    writeFileSync(file, `${'y'.repeat(40)}\n`);
    const config = loadServerConfig({
      DATABASE_URL: MINIMAL.DATABASE_URL,
      APP_SECRET_KEY_FILE: file,
    });
    // The trailing newline an operator's editor adds is not part of the secret.
    expect(config.secretKey).toBe('y'.repeat(40));
  });

  it('reports every offending variable in one error, not the first one', () => {
    let message = '';
    try {
      load({ ROLE: 'wizard', PORT: 'eighty', LOG_FORMAT: 'yaml' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('ROLE');
    expect(message).toContain('PORT');
    expect(message).toContain('LOG_FORMAT');
  });

  it('names the sub-loader’s variable when the database configuration is wrong', () => {
    expect(() => load({ APP_DB_POOL_MAX: 'lots' })).toThrow(/APP_DB_POOL_MAX/);
  });

  it('reads a boolean the way an operator writes one, and rejects a typo', () => {
    expect(load({ APP_ALLOW_SIGNUP: 'TRUE' }).allowSignUp).toBe(true);
    expect(load({ APP_ALLOW_SIGNUP: 'on' }).allowSignUp).toBe(true);
    expect(load({ APP_ALLOW_SIGNUP: 'no' }).allowSignUp).toBe(false);
    // A typo in a security flag must not quietly read as "off".
    expect(() => load({ APP_ALLOW_SIGNUP: 'ture' })).toThrow(/APP_ALLOW_SIGNUP/);
  });

  it('needs both halves of the metrics credential or neither', () => {
    expect(() => load({ APP_METRICS_USERNAME: 'prom' })).toThrow(/APP_METRICS_PASSWORD/);
    expect(() => load({ APP_METRICS_PASSWORD: 'fake' })).toThrow(/APP_METRICS_USERNAME/);
    expect(load({ APP_METRICS_USERNAME: 'prom', APP_METRICS_PASSWORD: 'fake' })).toMatchObject({
      metricsUsername: 'prom',
      metricsPassword: 'fake',
    });
    expect(load().metricsUsername).toBeNull();
  });

  it('needs a password for the bootstrap administrator it is asked to create', () => {
    expect(() => load({ APP_BOOTSTRAP_ADMIN_EMAIL: 'op@example.test' })).toThrow(
      /APP_BOOTSTRAP_ADMIN_PASSWORD/,
    );
    expect(
      load({
        APP_BOOTSTRAP_ADMIN_EMAIL: 'op@example.test',
        APP_BOOTSTRAP_ADMIN_PASSWORD: 'a-fake-password-1234',
      }).bootstrapAdminEmail,
    ).toBe('op@example.test');
  });

  it('refuses an SSE drain that does not fit inside the shutdown budget', () => {
    // Both bounds accept up to 600 000 on their own, so nothing stopped the step from being given
    // the whole budget its own container is bounded by — and then the dispatcher drain, pg-boss
    // and the pool behind it get nothing at all.
    expect(() =>
      load({ APP_SSE_SHUTDOWN_DRAIN_MS: '30000', APP_SHUTDOWN_TIMEOUT_MS: '30000' }),
    ).toThrow(/APP_SSE_SHUTDOWN_DRAIN_MS must be less than APP_SHUTDOWN_TIMEOUT_MS/);
    expect(() =>
      load({ APP_SSE_SHUTDOWN_DRAIN_MS: '60000', APP_SHUTDOWN_TIMEOUT_MS: '30000' }),
    ).toThrow(/APP_SSE_SHUTDOWN_DRAIN_MS must be less than APP_SHUTDOWN_TIMEOUT_MS/);
    expect(
      load({ APP_SSE_SHUTDOWN_DRAIN_MS: '29999', APP_SHUTDOWN_TIMEOUT_MS: '30000' })
        .sseShutdownDrainMs,
    ).toBe(29_999);
    // The shipped defaults have to satisfy their own rule.
    expect(SERVER_CONFIG_DEFAULTS.sseShutdownDrainMs).toBeLessThan(
      SERVER_CONFIG_DEFAULTS.shutdownTimeoutMs,
    );
  });

  it('rejects an APP_BASE_URL that is not a URL', () => {
    expect(() => load({ APP_BASE_URL: 'localhost:8080' })).toThrow(/APP_BASE_URL/);
  });
});

describe('pool sizing', () => {
  it('adds the composition root’s own floor to the dispatcher’s', () => {
    const config = load({ APP_DISPATCH_MAX_CONCURRENCY: '2', APP_DB_POOL_MAX: '20' });
    // 2 × 2 + 1 for dispatch — the dispatcher's own transaction and the handler's — plus pg-boss,
    // the pipeline's three job workers, HTTP and maintenance.
    expect(requiredPoolConnections(config)).toBe(
      5 +
        POOL_RESERVATIONS.jobs +
        POOL_RESERVATIONS.pipeline +
        POOL_RESERVATIONS.http +
        POOL_RESERVATIONS.maintenance,
    );
  });

  it('costs two connections per added dispatch, not three, because no handler calls a provider', () => {
    // The shape of the term, not its value. Until WP-15d a handler called a provider inside its
    // transaction and the audit row (BD-003) opened a second one inside *that*, so every added
    // dispatch cost three connections; the call is made from `pipeline.outbound` now, so it costs
    // two. `POOL_RESERVATIONS.auditPerDispatch` back at 1 fails this and nothing else, which is
    // what makes it the receipt rather than a comment.
    const one = load({ APP_DISPATCH_MAX_CONCURRENCY: '1', APP_DB_POOL_MAX: '30' });
    const three = load({ APP_DISPATCH_MAX_CONCURRENCY: '3', APP_DB_POOL_MAX: '30' });
    expect(requiredPoolConnections(three) - requiredPoolConnections(one)).toBe(4);
    expect(POOL_RESERVATIONS.auditPerDispatch).toBe(0);
  });

  it('asks for less when the role runs fewer workloads', () => {
    const api = load({ ROLE: 'api' });
    const worker = load({ ROLE: 'worker' });
    expect(requiredPoolConnections(api)).toBe(
      POOL_RESERVATIONS.http + POOL_RESERVATIONS.maintenance,
    );
    expect(requiredPoolConnections(worker)).toBeGreaterThan(requiredPoolConnections(api));
  });

  it('refuses a pool that only satisfies the dispatcher’s own floor', () => {
    // `createEventing` would accept 2 × 1 + 1 = 3 and then stall the first time a request and a
    // sweep both want a connection: it says in its own message that 3 is "the floor for the
    // dispatcher alone". This is the composition root refusing that arrangement at boot.
    let thrown: unknown;
    try {
      load({ APP_DISPATCH_MAX_CONCURRENCY: '1', APP_DB_POOL_MAX: '3' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UndersizedPoolError);
    // Twelve since WP-15c: the pipeline's fourth job worker is `pipeline.intake.reconcile`.
    expect((thrown as UndersizedPoolError).required).toBe(12);
    expect((thrown as Error).message).toMatch(/APP_DB_POOL_MAX/);
  });

  it('accepts the documented default pool for the default concurrency', () => {
    // .env.example ships APP_DB_POOL_MAX=14 and APP_DISPATCH_MAX_CONCURRENCY=1; if this ever fails,
    // the shipped defaults no longer start.
    expect(() => load()).not.toThrow();
  });
});

/**
 * The intake reconciliation's one knob (WP-15c, PROGRESS backlog 20).
 *
 * Standing rule 18 twice over: the **absent** case and the **off** case must not be spelled the
 * same way, and an unparseable value must not silently become the default — an operator who set a
 * number and got another one has no way to find out.
 */
describe('the intake reconciliation interval', () => {
  it('defaults to a minute when nothing is set', () => {
    expect(load().intakeReconcileIntervalMs).toBe(60_000);
  });

  it('reads a whole number of milliseconds', () => {
    expect(load({ APP_INTAKE_RECONCILE_INTERVAL_MS: '1000' }).intakeReconcileIntervalMs).toBe(
      1_000,
    );
    expect(load({ APP_INTAKE_RECONCILE_INTERVAL_MS: '300000' }).intakeReconcileIntervalMs).toBe(
      300_000,
    );
  });

  it('accepts 0 as "off", which is a different answer from "unset"', () => {
    // `composePipeline` logs which of the two it did; the parse only has to keep them distinct.
    expect(load({ APP_INTAKE_RECONCILE_INTERVAL_MS: '0' }).intakeReconcileIntervalMs).toBe(0);
  });

  it.each([
    ['a sub-second interval, which costs more than the loss it recovers', '999'],
    ['longer than an hour', '3600001'],
    ['a number with a unit', '60s'],
    ['a negative number', '-1'],
    ['prose', 'often'],
  ])('refuses %s rather than falling back to the default', (_name, value) => {
    expect(() => load({ APP_INTAKE_RECONCILE_INTERVAL_MS: value })).toThrow(
      /intakeReconcileIntervalMs/,
    );
  });
});
