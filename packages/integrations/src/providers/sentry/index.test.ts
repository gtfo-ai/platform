/**
 * The Sentry binding's configuration, its registration and the two things `http.ts` computes
 * without a socket (technical/10 unit tier).
 */
import { noSecretsRedactor } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createIntegrationRegistry } from '../../registry.js';
import { sentryConfigSchema, sentrySecretFields } from './config.js';
import { isUsableToken, parseSentryRetryAfterMs } from './http.js';
import { sentryProviderRegistration, sentryRateLimitPolicy } from './index.js';
import { SENTRY_AGENT_TOOLING } from './provider.js';

const NOW = Date.parse('2026-06-01T10:30:00.000Z');

describe('sentryConfigSchema', () => {
  it('defaults to sentry.io and to caps that bound an untrusted event', () => {
    const config = sentryConfigSchema.parse({ organization: 'acme-example' });
    expect(config.base_url).toBe('https://sentry.io');
    expect(config).toMatchObject({
      max_issues: 25,
      max_stack_frames: 50,
      max_stack_trace_bytes: 65_536,
      max_breadcrumbs: 25,
      max_tags: 50,
    });
  });

  it.each([
    ['https://sentry.example.test/api/0', 'the /api/0 path'],
    ['https://sentry.example.test/api/0/', 'the /api/0 path with a slash'],
    ['https://sentry.example.test/', 'a trailing slash'],
  ])('refuses %s (%s)', (baseUrl) => {
    expect(() =>
      sentryConfigSchema.parse({ base_url: baseUrl, organization: 'acme-example' }),
    ).toThrow();
  });

  it('refuses an unknown key, because a boundary schema is strict', () => {
    expect(() =>
      sentryConfigSchema.parse({ organization: 'acme-example', project: 'api' }),
    ).toThrow();
  });

  it.each([['Acme'], ['-acme'], ['acme/api'], ['']])(
    'refuses %s as an organization slug',
    (org) => {
      expect(() => sentryConfigSchema.parse({ organization: org })).toThrow();
    },
  );
});

describe('isUsableToken (standing rule 18)', () => {
  it.each([[null], [undefined], [''], ['   '], ['\t\n']])('rejects %j', (value) => {
    expect(isUsableToken(value as string | null | undefined)).toBe(false);
  });

  it('accepts a token with content', () => {
    expect(isUsableToken('FAKE-sentry-auth-token-DO-NOT-USE')).toBe(true);
  });
});

describe('parseSentryRetryAfterMs', () => {
  it('reads Retry-After in seconds, as Sentry documents it', () => {
    expect(parseSentryRetryAfterMs({ 'retry-after': '2' }, NOW)).toBe(2000);
  });

  it('reads an HTTP-date Retry-After against the injected clock', () => {
    expect(parseSentryRetryAfterMs({ 'retry-after': 'Mon, 01 Jun 2026 10:30:05 GMT' }, NOW)).toBe(
      5000,
    );
  });

  /**
   * The fallback that matters: Sentry publishes `X-Sentry-Rate-Limit-Reset` on *every* response,
   * "measured in UTC seconds from epoch", so a 429 without `Retry-After` still says when to come
   * back. Reading it needs a clock, which is why the client takes one.
   */
  it('falls back to X-Sentry-Rate-Limit-Reset, which is an absolute instant', () => {
    expect(parseSentryRetryAfterMs({ 'x-sentry-rate-limit-reset': '1780309830' }, NOW)).toBe(
      30_000,
    );
  });

  it('never returns a negative delay for a reset that has already passed', () => {
    expect(parseSentryRetryAfterMs({ 'x-sentry-rate-limit-reset': '1780309700' }, NOW)).toBe(0);
  });

  it.each([[{}], [{ 'retry-after': '' }], [{ 'retry-after': 'soon' }]])(
    'answers null for %j, so the executor falls back to its own backoff',
    (headers) => {
      expect(parseSentryRetryAfterMs(headers, NOW)).toBeNull();
    },
  );
});

describe('the registration (BD-017)', () => {
  it('registers under the errors type and survives the registry’s secret-field check', () => {
    const registry = createIntegrationRegistry([sentryProviderRegistration]);
    expect(registry.get('errors', 'sentry').displayName).toBe('Sentry (sentry.io and self-hosted)');
    expect([...sentrySecretFields]).toEqual(['auth_token']);
  });

  it('cannot be handed to a caller that wants another type', () => {
    const registry = createIntegrationRegistry([sentryProviderRegistration]);
    expect(() => registry.get('logs', 'sentry')).toThrow(/is a "errors" provider/);
  });

  /**
   * The agent-tooling decision, asserted rather than left in prose: Sentry mounts nothing, so it
   * must ask the runner for nothing. The shared contract suite asserts the same rule for every
   * provider; this is the provider-side statement of it.
   */
  it('mounts nothing into a run, and therefore asks for no credential', () => {
    expect(sentryProviderRegistration.agentTooling).toBe(SENTRY_AGENT_TOOLING);
    expect(SENTRY_AGENT_TOOLING.cli).toBeNull();
    expect(SENTRY_AGENT_TOOLING.mcp).toBeNull();
    expect(SENTRY_AGENT_TOOLING.env.variables).toEqual([]);
  });

  it('asks for less than any published Sentry limit, because none is published', () => {
    expect(sentryRateLimitPolicy.capacity).toBeLessThanOrEqual(10);
    expect(sentryRateLimitPolicy.maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('builds a working port from a config and a secret', () => {
    const port = sentryProviderRegistration.create({
      integrationId: '00000000-0000-4000-8000-0000000000a6',
      config: { base_url: 'https://sentry.example.test', organization: 'acme-example' },
      secrets: { auth_token: 'FAKE-sentry-auth-token-DO-NOT-USE' },
      // Standing rule 31: required on `ProviderCreateInput`, so a provider cannot be built without
      // one and the production path is the path that passes it.
      redactor: noSecretsRedactor(),
    });
    expect(port.ref).toEqual({
      integrationId: '00000000-0000-4000-8000-0000000000a6',
      provider: 'sentry',
      type: 'errors',
    });
    expect(port.capabilities()).toEqual({
      search: true,
      comments: false,
      resolve: true,
      resolveInRelease: true,
      linkMergeRequest: false,
      mcp: false,
    });
  });
});
