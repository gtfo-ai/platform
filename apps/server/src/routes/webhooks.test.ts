/**
 * The webhook route's two decisions that are not wiring: which status each outcome deserves, and
 * how a repeated header reaches a signature verifier (WP-15c).
 *
 * The route itself — the raw-body parser, the params schema, the unauthenticated path through the
 * auth plugin's CSRF hook — is exercised against a real instance by
 * `test/e2e/pipeline/webhook-ingress.e2e.test.ts`, which is the only place a Fastify content-type
 * parser and a real `POST` can both be present.
 */
import {
  createWebhookIngress,
  eagerInboundLoader,
  type InboundDeliveryOutcome,
  type InboundRefusal,
  type ResolvedInboundIntegration,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { flattenHeaders, registerWebhookRoutes, retryAfterSeconds, statusFor } from './webhooks.js';

const refused = (reason: InboundRefusal): InboundDeliveryOutcome => ({
  kind: 'refused',
  reason,
  detail: 'because',
});

describe('the status a delivery is answered with', () => {
  it('accepts what it performed and what it had already performed', () => {
    expect(
      statusFor({ kind: 'accepted', deliveryId: 'd', events: 1, ignored: 0, redactionCount: 0 }),
    ).toBe(202);
    expect(statusFor({ kind: 'duplicate', deliveryId: 'd' })).toBe(202);
  });

  /**
   * Standing rule 20 in its sharpest form on this route. A vendor that keeps receiving errors
   * **disables the webhook** — GitLab and Jira both do — and that would take the deliveries that
   * matter with the ones that do not. A `wiki` or `release` hook is authentic and unkeyable, so it
   * is received and performs nothing, which is what `accepted: false` on the body says.
   */
  it('receives an authentic delivery nothing can key, rather than erroring at the vendor', () => {
    expect(statusFor(refused('unkeyable'))).toBe(202);
  });

  it('refuses what an operator or an attacker must be told about', () => {
    // The only credential this endpoint has; a failure here is a forgery or a rotated secret.
    expect(statusFor(refused('unverified'))).toBe(401);
    expect(statusFor(refused('malformed_body'))).toBe(400);
    // A URL that names nothing this build can receive for — the same answer as a wrong id, so a
    // caller cannot tell an existing integration from a missing one by its status code.
    expect(statusFor(refused('provider_mismatch'))).toBe(404);
    expect(statusFor(refused('unsupported_provider'))).toBe(404);
    expect(statusFor({ kind: 'unknown_integration' })).toBe(404);
  });

  it('has an answer for every refusal the ingress can produce', () => {
    // Derived, not remembered (standing rule 7): a new refusal reason with no status fails here
    // rather than reaching a caller as `undefined`.
    expect(statusFor({ kind: 'rate_limited', retryAfterMs: 1 })).toBe(429);
    const reasons: InboundRefusal[] = [
      'unverified',
      'provider_mismatch',
      'unsupported_provider',
      'malformed_body',
      'unkeyable',
    ];
    for (const reason of reasons) {
      expect(typeof statusFor(refused(reason)), reason).toBe('number');
    }
  });
});

describe('the headers handed to a signature verifier', () => {
  it('lower-cases the names, because every scheme in TD-024 reads them that way', () => {
    expect(flattenHeaders({ 'X-Gitlab-Token': 'abc' })).toEqual({ 'x-gitlab-token': 'abc' });
  });

  it('joins a repeated header instead of handing a verifier an array', () => {
    // `[object Object]` reaching a constant-time comparison is a refusal that looks like a forgery.
    expect(flattenHeaders({ 'x-forwarded-for': ['10.0.0.1', '10.0.0.2'] })).toEqual({
      'x-forwarded-for': '10.0.0.1, 10.0.0.2',
    });
  });

  it('drops an absent header rather than passing `undefined` through as a value', () => {
    expect(
      flattenHeaders({ 'x-gitlab-token': undefined, 'content-type': 'application/json' }),
    ).toEqual({ 'content-type': 'application/json' });
  });
});

/**
 * **Q60 at the route** (WP-87 criterion 4): a real Fastify instance, the real route and its raw-body
 * parser, and the real `WebhookIngress` in front of a counting signature check — so "the signature
 * check is not reached past the limit" is asserted on the verifier the route would have called, not
 * on an outcome the test constructed.
 */
describe('the webhook route at its integration’s rate limit (Q60)', () => {
  const INTEGRATION = '00000000-0000-4000-8000-0000000000c1' as Id;

  const appWith = async (policy: { capacity: number; refillPerSecond: number }) => {
    const verified: string[] = [];
    const limited: string[] = [];
    const resolves: string[] = [];
    const resolved: ResolvedInboundIntegration = {
      ref: {
        integrationId: INTEGRATION,
        provider: 'fake-task-management',
        type: 'task_management',
        host: null,
      },
      inbound: {
        verify: (delivery) => {
          verified.push(delivery.body);
          return false;
        },
        deliveryKey: () => 'never-asked',
        normalise: async () => ({ events: [], ignored: [] }),
      },
      bindings: [],
      redactor: {
        redactText: (value) => ({ value, count: 0 }),
        redactJson: (value) => ({ value, count: 0 }),
      },
    };
    const audit: unknown[] = [];
    const ingress = createWebhookIngress({
      loader: {
        ...eagerInboundLoader(async (id) => (id === INTEGRATION ? resolved : null)),
        // Counts the expensive half: credentials read and adapters built (review round 1).
        open: async (id) =>
          id === INTEGRATION
            ? {
                integrationId: INTEGRATION,
                provider: 'fake-task-management',
                resolve: async () => {
                  resolves.push(id);
                  return resolved;
                },
              }
            : null,
      },
      inbox: {
        find: async () => null,
        record: async () => {
          throw new Error('a refused delivery writes no inbox row');
        },
      } as never,
      audit: { record: async (entry: unknown) => void audit.push(entry) } as never,
      identities: { forProvider: async () => new Map() },
      threads: { find: async () => null },
      decisions: {
        apply: async () => {
          throw new Error('no decision');
        },
      } as never,
      unitOfWork: {
        transaction: async () => {
          throw new Error('nothing is written');
        },
      } as never,
      eventStore: { nextStreamSequence: async () => 1 },
      ids: { next: () => INTEGRATION },
      clock: { now: () => '2026-09-28T09:00:00.000Z' as IsoDateTime },
      // A frozen clock: the bucket never refills inside a test.
      timer: { now: () => 0 },
      rateLimit: {
        policy: { ...policy, maxConcurrent: 1 },
        onLimited: ({ provider }) => limited.push(provider),
      },
    });
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await registerWebhookRoutes(app, { ingress });
    await app.ready();
    const post = (body: string) =>
      app.inject({
        method: 'POST',
        url: `/webhooks/fake-task-management/${INTEGRATION}`,
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
    return { app, post, verified, limited, audit, resolves };
  };

  it('answers 401 inside the bucket and 429 with Retry-After once it is spent', async () => {
    const harness = await appWith({ capacity: 2, refillPerSecond: 0.5 });
    try {
      expect((await harness.post('{"n":1}')).statusCode).toBe(401);
      expect((await harness.post('{"n":2}')).statusCode).toBe(401);

      const limited = await harness.post('{"n":3}');

      expect(limited.statusCode).toBe(429);
      // One token at half a token a second is two seconds away.
      expect(limited.headers['retry-after']).toBe('2');
      expect(limited.json()).toEqual({ accepted: false, delivery_id: null });
      expect(harness.limited).toEqual(['fake-task-management']);
    } finally {
      await harness.app.close();
    }
  });

  it('does not reach the credentials, the signature check, the audit or the inbox past the limit', async () => {
    const harness = await appWith({ capacity: 1, refillPerSecond: 1 });
    try {
      await harness.post('{"forged":1}');
      expect(harness.verified).toEqual(['{"forged":1}']);
      expect(harness.audit).toHaveLength(1);

      for (const n of [2, 3, 4]) {
        expect((await harness.post(`{"forged":${n}}`)).statusCode).toBe(429);
      }

      expect(harness.verified, 'no delivery past the limit reached the verifier').toEqual([
        '{"forged":1}',
      ]);
      expect(harness.audit, 'and none left an audit row').toHaveLength(1);
      expect(harness.resolves, 'nor read a credential or built an adapter').toHaveLength(1);
      expect(harness.limited).toHaveLength(3);
    } finally {
      await harness.app.close();
    }
  });

  it('rounds Retry-After up to whole seconds, and never below one', () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1000)).toBe(1);
    expect(retryAfterSeconds(1001)).toBe(2);
    expect(retryAfterSeconds(0)).toBe(1);
  });
});
