/**
 * The shared vocabulary: typed failures and the boundary parser (BD-022).
 *
 * The assertion that earns its place here is the negative one about error text — a provider
 * response can contain a token, so `parseProviderData` must report *where* the shape was wrong
 * without reporting *what* was there.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  agentToolingSchema,
  IntegrationError,
  IntegrationRateLimitedError,
  IntegrationResponseError,
  IntegrationUnsupportedError,
  parseProviderData,
} from './common.js';

describe('IntegrationError', () => {
  it('marks only rate limits and outages as retryable', () => {
    expect(new IntegrationError('rate_limited', 'gitlab', 'slow down').retryable).toBe(true);
    expect(new IntegrationError('unavailable', 'gitlab', '502').retryable).toBe(true);
    expect(new IntegrationError('not_found', 'gitlab', 'gone').retryable).toBe(false);
    expect(new IntegrationError('unauthorised', 'gitlab', 'bad token').retryable).toBe(false);
    expect(new IntegrationError('invalid_request', 'gitlab', 'nope').retryable).toBe(false);
  });

  it('names the provider in the message and keeps the cause', () => {
    const cause = new Error('socket hang up');
    const error = new IntegrationError('unavailable', 'jira-cloud', 'request failed', { cause });
    expect(error.message).toBe('jira-cloud: request failed');
    expect(error.cause).toBe(cause);
    expect(error.name).toBe('IntegrationError');
  });

  it('keeps Retry-After in milliseconds and rejects a nonsensical one', () => {
    const limited = new IntegrationRateLimitedError('slack', 'ratelimited', {
      retryAfterMs: 30_000,
    });
    expect(limited.retryAfterMs).toBe(30_000);
    expect(limited.code).toBe('rate_limited');
    expect(limited.retryable).toBe(true);
    expect(new IntegrationRateLimitedError('slack', 'ratelimited').retryAfterMs).toBeNull();
    expect(() => new IntegrationRateLimitedError('slack', 'x', { retryAfterMs: -1 })).toThrow(
      TypeError,
    );
  });

  it('names the capability it does not have', () => {
    const error = new IntegrationUnsupportedError('gitlab', 'group tokens');
    expect(error.code).toBe('unsupported_capability');
    expect(error.action).toBe('group tokens');
    expect(error.message).toContain('does not support group tokens');
  });
});

describe('parseProviderData', () => {
  const schema = z.strictObject({
    id: z.string(),
    fields: z.array(z.strictObject({ name: z.string() })),
  });

  it('returns the parsed value on success', () => {
    const value = parseProviderData(
      schema,
      { id: 'FAKE-1', fields: [{ name: 'summary' }] },
      { provider: 'jira-cloud', action: 'read_ticket' },
    );
    expect(value.id).toBe('FAKE-1');
  });

  it('reports the failing paths and never the value', () => {
    let caught: unknown;
    try {
      parseProviderData(
        schema,
        { id: 42, fields: [{ name: 'summary', token: 'fake-secret-value-9999' }] },
        { provider: 'jira-cloud', action: 'read_ticket' },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(IntegrationResponseError);
    const error = caught as IntegrationResponseError;
    expect(error.code).toBe('invalid_response');
    expect(error.action).toBe('read_ticket');
    expect(error.issues.join(' ')).toContain('id');
    expect(error.issues.join(' ')).toContain('fields.0');
    const everything = `${error.message} ${error.issues.join(' ')}`;
    expect(everything).not.toContain('fake-secret-value-9999');
    expect(everything).not.toContain('42');
  });
});

describe('agentToolingSchema', () => {
  it('accepts a spec that declares variable names only', () => {
    const parsed = agentToolingSchema.parse({
      cli: {
        command: 'glab',
        version: null,
        env: { variables: [{ name: 'GITLAB_TOKEN', secret: true, description: 'project token' }] },
      },
      mcp: null,
      skill: { id: 'glab-recipes', path: 'skills/gitlab' },
      env: { variables: [{ name: 'GITLAB_HOST', secret: false, description: 'base url' }] },
    });
    expect(parsed.cli?.command).toBe('glab');
  });

  it('rejects a lower-case variable name and an unknown key', () => {
    expect(() =>
      agentToolingSchema.parse({
        cli: null,
        mcp: null,
        skill: null,
        env: { variables: [{ name: 'gitlab_token', secret: true, description: 'x' }] },
      }),
    ).toThrow();

    expect(() =>
      agentToolingSchema.parse({
        cli: null,
        mcp: null,
        skill: null,
        env: {
          variables: [
            { name: 'GITLAB_TOKEN', secret: true, description: 'x', value: 'fake-token-here' },
          ],
        },
      }),
    ).toThrow();
  });
});
