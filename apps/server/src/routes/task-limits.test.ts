/**
 * A person's task limit through Fastify (S-28.6, the M28 ruling B): who may read and write whose,
 * which refusal is which status, a repeat is `performed: false`, and a raise appends one
 * `config.changed` per project holding the person's queued tasks — after the write, and none for a
 * write that raised nothing. The store's own behaviour (the lock, the cap, the audit row) is
 * `test/integration/server/task-limits.integration.test.ts`.
 */
import type { WipRaisedRecorder } from '@platform/application';
import type { UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { SetTaskLimitResult } from '../queries/task-limits.js';
import { registerTaskLimitRoutes } from './task-limits.js';

const ME = '00000000-0000-4000-8000-0000000028e1';
const OTHER = '00000000-0000-4000-8000-0000000028e2';
const PROJECT = '00000000-0000-4000-8000-0000000028f1';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (role: UserRole, answer: SetTaskLimitResult) => {
  const writes: { userId: string; personal: number | null; via: string }[] = [];
  const recorded: { projectId: string; raised: unknown }[] = [];
  const recorder: WipRaisedRecorder = {
    record: async (input) => {
      recorded.push({ projectId: input.projectId, raised: input.raised });
    },
  };
  const instance = fastify();
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  instance.addHook('onRequest', async (request) => {
    request.actor = {
      userId: ME,
      email: 'me@example.test',
      name: 'Me',
      role,
      sessionId: 'session-1',
    };
  });
  await registerTaskLimitRoutes(instance, {
    queries: {
      projectRole: async () => null,
      organisationLimits: async () => ({ default: 3, maximum: 5, organisationStates: true }),
      personLoad: async () => ({ personal: null, inFlight: 3, queued: 1, holders: [] }),
      people: async () => [
        { userId: ME, name: 'Me', email: 'me@example.test', personal: 4, inFlight: 1, queued: 0 },
      ],
      setLimit: async (input) => {
        writes.push({ userId: input.userId, personal: input.personal, via: input.via });
        return answer;
      },
    },
    recorder,
  });
  app = instance;
  return { app: instance, writes, recorded };
};

const raised: SetTaskLimitResult = {
  status: 'set',
  personal: 4,
  limit: 4,
  performed: true,
  raised: { from: 3, to: 4 },
  queuedProjects: [PROJECT],
};

describe('a person’s task limit (S-28.6)', () => {
  it('reads your limit with the counting rule’s numbers', async () => {
    const { app: instance } = await build('member', raised);
    const response = await instance.inject({ method: 'GET', url: '/api/me/task-limit' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      user_id: ME,
      max_tasks_in_flight: null,
      limit: 3,
      default: 3,
      maximum: 5,
      in_flight: 3,
      queued: 1,
    });
  });

  it('sets your own, and a raise appends the event the scheduler hears for each project', async () => {
    const { app: instance, writes, recorded } = await build('member', raised);
    const response = await instance.inject({
      method: 'PUT',
      url: '/api/me/task-limit',
      payload: { max_tasks_in_flight: 4 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user_id: ME,
      max_tasks_in_flight: 4,
      limit: 4,
      performed: true,
    });
    expect(writes).toEqual([{ userId: ME, personal: 4, via: 'self' }]);
    expect(recorded).toEqual([
      {
        projectId: PROJECT,
        raised: [{ key: 'pipeline.wip.max_tasks_per_owner', from: 3, to: 4 }],
      },
    ]);
  });

  it('answers a repeat with performed false and appends nothing', async () => {
    const { app: instance, recorded } = await build('member', {
      status: 'set',
      personal: 4,
      limit: 4,
      performed: false,
      raised: null,
      queuedProjects: [],
    });
    const response = await instance.inject({
      method: 'PUT',
      url: '/api/me/task-limit',
      payload: { max_tasks_in_flight: 4 },
    });
    expect(response.json()).toMatchObject({ performed: false });
    expect(recorded).toEqual([]);
  });

  it('refuses a number above the organisation’s maximum with 422, naming it', async () => {
    const { app: instance } = await build('member', { status: 'above_maximum', maximum: 5 });
    const response = await instance.inject({
      method: 'PUT',
      url: '/api/me/task-limit',
      payload: { max_tasks_in_flight: 9 },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('task_limit_above_maximum');
    expect(response.json().error.details).toEqual([{ path: 'max_tasks_in_flight', message: '5' }]);
  });

  it('refuses a body outside 1–200 before anything is asked', async () => {
    const { app: instance, writes } = await build('member', raised);
    for (const value of [0, 201, 'three']) {
      const response = await instance.inject({
        method: 'PUT',
        url: '/api/me/task-limit',
        payload: { max_tasks_in_flight: value },
      });
      expect(response.statusCode, String(value)).toBe(400);
    }
    expect(writes).toEqual([]);
  });

  it('lets only an administrator read everyone’s and set anyone’s', async () => {
    const member = await build('member', raised);
    expect(
      (await member.app.inject({ method: 'GET', url: '/api/org/task-limits' })).statusCode,
    ).toBe(403);
    expect(
      (
        await member.app.inject({
          method: 'PUT',
          url: `/api/org/users/${OTHER}/task-limit`,
          payload: { max_tasks_in_flight: 2 },
        })
      ).statusCode,
    ).toBe(403);
    expect(member.writes).toEqual([]);
    await member.app.close();
    app = undefined;

    const admin = await build('admin', raised);
    const list = await admin.app.inject({ method: 'GET', url: '/api/org/task-limits' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({ user_id: ME, max_tasks_in_flight: 4, limit: 4 });
    const set = await admin.app.inject({
      method: 'PUT',
      url: `/api/org/users/${OTHER}/task-limit`,
      payload: { max_tasks_in_flight: 2 },
    });
    expect(set.statusCode).toBe(200);
    expect(admin.writes).toEqual([{ userId: OTHER, personal: 2, via: 'administrator' }]);
  });

  it('answers 404 for a person who does not exist', async () => {
    const { app: instance } = await build('admin', { status: 'not_found' });
    const response = await instance.inject({
      method: 'PUT',
      url: `/api/org/users/${OTHER}/task-limit`,
      payload: { max_tasks_in_flight: null },
    });
    expect(response.statusCode).toBe(404);
  });
});
