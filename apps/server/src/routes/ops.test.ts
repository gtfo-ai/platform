import * as nodeCrypto from 'node:crypto';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../config.js';
import type { Metrics } from '../metrics.js';
import {
  credentialsMatch,
  parseBasicAuth,
  type ReadinessReport,
  registerOpsRoutes,
} from './ops.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeCrypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe('parseBasicAuth', () => {
  it('reads a well-formed credential', () => {
    const header = `Basic ${Buffer.from('prom:secret').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ user: 'prom', pass: 'secret' });
  });

  it('is case-insensitive about the scheme', () => {
    const header = `basic ${Buffer.from('a:b').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ user: 'a', pass: 'b' });
  });

  it('keeps colons inside the password', () => {
    const header = `Basic ${Buffer.from('user:pa:ss:word').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ user: 'user', pass: 'pa:ss:word' });
  });

  it('rejects anything that is not basic auth', () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth('Bearer token')).toBeNull();
    expect(parseBasicAuth(`Basic ${Buffer.from('no-colon').toString('base64')}`)).toBeNull();
  });
});

describe('credentialsMatch', () => {
  const expected = { user: 'prom', pass: 'a-fake-password' };

  it('accepts the right credential', async () => {
    await expect(credentialsMatch({ ...expected }, expected)).resolves.toBe(true);
  });

  it('rejects a wrong password, a wrong user, and a prefix of either', async () => {
    await expect(credentialsMatch({ user: 'prom', pass: 'wrong' }, expected)).resolves.toBe(false);
    await expect(credentialsMatch({ user: 'other', pass: expected.pass }, expected)).resolves.toBe(
      false,
    );
    // Digesting first is what makes the comparison constant-width, so a prefix cannot be detected
    // by timing or by an early length mismatch.
    await expect(
      credentialsMatch({ user: 'prom', pass: 'a-fake-passwor' }, expected),
    ).resolves.toBe(false);
    await expect(
      credentialsMatch({ user: 'prom', pass: 'a-fake-password-and-more' }, expected),
    ).resolves.toBe(false);
  });

  it('rejects an empty credential', async () => {
    await expect(credentialsMatch({ user: '', pass: '' }, expected)).resolves.toBe(false);
  });

  it('compares both halves even when the username is wrong', async () => {
    // `&&` short-circuits, so a wrong username used to skip the password comparison entirely and
    // answer measurably faster than a right username with a wrong password — which tells an
    // attacker when they have guessed the username and splits one search into two smaller ones.
    // Counting the comparisons is the deterministic way to assert this; a timing assertion would
    // be an assertion about the hardware.
    const spy = vi.mocked(nodeCrypto.timingSafeEqual);
    spy.mockClear();
    await credentialsMatch({ user: 'wrong', pass: 'also-wrong' }, expected);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

/**
 * `/readyz`'s status code is decided by the route, not the report (WP-272): a `degraded` report —
 * `schema: ahead_additive`, the all-additive future TD-032 decision 2 makes servable — answers
 * 200 with the body as reported, and a `down` one 503.
 */
describe('GET /readyz', () => {
  const serve = async (report: ReadinessReport) => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await registerOpsRoutes(app, {
      // Read only by `/metrics`, which these cases never call.
      config: {} as ServerConfig,
      metrics: {} as Metrics,
      version: { version: '0.0.0-test', commit: null, builtAt: null },
      readiness: async () => report,
      isShuttingDown: () => false,
      isUnderPressure: () => false,
    });
    try {
      return await app.inject({ method: 'GET', url: '/readyz' });
    } finally {
      await app.close();
    }
  };

  it('answers 200 for a schema ahead by additive migrations only, and says so', async () => {
    const report: ReadinessReport = {
      status: 'degraded',
      checks: { database: 'ok', migrations: 'ok', schema: 'degraded' },
      details: { schema: 'ahead_additive' },
    };
    const response = await serve(report);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(report);
  });

  it('answers 503 for a down report', async () => {
    const response = await serve({
      status: 'down',
      checks: { database: 'ok', migrations: 'down' },
    });
    expect(response.statusCode).toBe(503);
  });
});
