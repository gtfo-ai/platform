import fastifySse from '@fastify/sse';
import type { UserRole } from '@platform/contracts';
import { fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestError, toApiError } from '../errors.js';
import { createMetrics } from '../metrics.js';
import { SseHub } from './hub.js';
import { parseTopics, registerSseRoutes } from './routes.js';
import type { TopicAccessDependencies } from './topic-access.js';

const TASK = 'task:0199aa11-2b3c-7d4e-8f90-000000000001';

describe('parseTopics', () => {
  it('splits the comma-separated list technical/08 documents', () => {
    expect(parseTopics(`org, ${TASK}`)).toEqual(['org', TASK]);
  });

  it('drops duplicates, so one topic cannot be subscribed twice on one stream', () => {
    expect(parseTopics(`org,org`)).toEqual(['org']);
  });

  it('refuses a topic outside the documented set rather than ignoring it', () => {
    // Silently dropping an unknown topic would give a client a stream that is quietly missing
    // something it asked for.
    expect(() => parseTopics('org,whatever')).toThrow(BadRequestError);
    expect(() => parseTopics('task:not-a-uuid')).toThrow(BadRequestError);
  });

  it('refuses an empty list', () => {
    expect(() => parseTopics(' , ')).toThrow(BadRequestError);
  });
});

/**
 * The wiring, at the tier that runs on every change.
 *
 * Dropping both `authoriseTopics` calls used to fail only `verify:e2e` — a suite that needs Docker
 * and twenty seconds, and so the one least likely to be run while somebody is editing this file.
 * These pin it in the unit tier: no topic reaches the hub before it has been authorised, on either
 * entry point.
 */
describe('authorisation wiring', () => {
  const RUN = 'run:0199aa11-2b3c-7d4e-8f90-000000000003';
  const PROJECT_ID = '0199aa11-2b3c-7d4e-8f90-000000000001';

  const access: TopicAccessDependencies = {
    projectRole: async () => null,
    projectExists: async () => true,
    taskProjectId: async () => PROJECT_ID,
    runProjectId: async () => PROJECT_ID,
  };

  const build = async (role: UserRole) => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(fastifySse, { heartbeatInterval: 0 });
    app.addHook('onRequest', async (request) => {
      request.actor = { userId: 'u1', email: 'a@b.test', name: 'A', role, sessionId: 's1' };
    });
    app.setErrorHandler((error, request, reply) => {
      const mapped = toApiError(error, String(request.id));
      return reply.status(mapped.statusCode).send(mapped.body);
    });

    const hub = new SseHub({
      bufferSize: 4,
      maxQueuedLiveFrames: 4,
      maxTopicsPerConnection: 8,
      retryMs: 1_000,
      pingIntervalMs: 20_000,
      maxConnections: 4,
    });
    const open = vi.spyOn(hub, 'open');
    const update = vi.spyOn(hub, 'updateSubscriptions');
    await registerSseRoutes(app, {
      hub,
      metrics: createMetrics({ defaultMetrics: false }),
      access,
    });
    await app.ready();
    return { app, hub, open, update };
  };

  it('refuses a viewer the run topic before the hub is touched', async () => {
    const { app, open } = await build('viewer');
    const response = await app.inject({
      url: `/events?topics=${RUN}`,
      headers: { accept: 'text/event-stream' },
    });
    expect(response.statusCode).toBe(403);
    // The order matters as much as the answer: a stream opened and then closed would have been
    // registered on the hub, and would have received anything published in between.
    expect(open).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets a member through to the hub', async () => {
    const { app, hub, open } = await build('member');
    // A successful `/events` never completes — it is a stream — so the request is left in flight
    // and the assertion is that the hub was reached at all.
    const inflight = app
      .inject({ url: `/events?topics=${RUN}`, headers: { accept: 'text/event-stream' } })
      .then(
        () => undefined,
        () => undefined,
      );
    for (let i = 0; i < 200 && open.mock.calls.length === 0; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(open).toHaveBeenCalledTimes(1);
    // The stream holds the response open, so it is drained before the server is closed — the same
    // order `app.ts` puts in its `preClose` hook, which this bare instance does not have.
    await hub.shutdown();
    await app.close();
    await inflight;
  });

  it('refuses an unauthorised topic added through the subscriptions endpoint', async () => {
    const { app, update } = await build('viewer');
    const response = await app.inject({
      method: 'POST',
      url: '/events/subscriptions',
      payload: { connection_id: 'c1', add: [RUN] },
    });
    expect(response.statusCode).toBe(403);
    expect(update).not.toHaveBeenCalled();
    await app.close();
  });
});
