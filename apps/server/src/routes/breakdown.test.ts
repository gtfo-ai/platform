/**
 * The epic split's two routes, driven end to end through Fastify against plain functions (WP-40).
 *
 * **Why this file exists at all**: `routes/client-census.test.ts` compares the *client's* paths
 * against the router, and a route no screen calls is invisible to it by construction — the position
 * `kb/health`, `take-over` and `hand-back` are already in. So the two are named **positively** here,
 * with the auth, the key policy, the replay and the refusals each asserted from both sides.
 *
 * What this tier cannot see, stated rather than implied: whether accepting ever files a ticket. The
 * command port is a recorder, so *"N `createTicket` calls and none twice"* is the e2e's assertion
 * and *"the route called the command once, wrote one `human_actions` row, and wrote none for a
 * refusal or a replay"* is this file's.
 */
import { BreakdownRefusedError } from '@platform/application';
import type { JsonObject, TicketBreakdownItem, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { type BreakdownQueries, registerBreakdownRoutes } from './breakdown.js';

const TASK = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000e9';
const ITEM_A = '00000000-0000-4000-8000-0000000000f1';
const ITEM_B = '00000000-0000-4000-8000-0000000000f2';

interface Decided {
  taskId: string;
  itemIds: readonly string[];
  decision: 'accept' | 'reject';
  userId: string;
  reason: string | null;
}

interface World {
  readonly app: FastifyInstance;
  readonly decided: Decided[];
  readonly actions: {
    userId: string;
    action: string;
    params: JsonObject;
    taskId?: string | null;
  }[];
  role: UserRole;
  signedIn: boolean;
  /** What the command answers next; `refuse` is the 409 a decided-or-missing row produces. */
  outcome: 'ok' | 'refuse';
  queue: TicketBreakdownItem[];
}

const item = (overrides: Partial<TicketBreakdownItem> = {}): TicketBreakdownItem =>
  ({
    id: ITEM_A,
    task_id: TASK,
    position: 0,
    title: 'Render the approval message',
    description: 'Build the Block Kit payload.',
    acceptance_criteria: [],
    size: 'S',
    rationale: 'It can be reverted on its own.',
    status: 'queued',
    decided_by_user_id: null,
    decided_at: null,
    reason: null,
    ticket_key: null,
    ticket_url: null,
    created_at: '2026-06-01T09:00:00.000Z',
    ...overrides,
  }) as TicketBreakdownItem;

const build = async (overrides: Partial<BreakdownQueries> = {}): Promise<World> => {
  const decided: Decided[] = [];
  const actions: World['actions'] = [];
  const attempts = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  const world = {
    decided,
    actions,
    role: 'admin',
    signedIn: true,
    outcome: 'ok',
    queue: [item(), item({ id: ITEM_B, position: 1, title: 'Handle the callback' })],
  } as unknown as World;

  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.signedIn) {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        role: world.role,
        sessionId: 'session-1',
      };
    }
  });

  await registerBreakdownRoutes(app, {
    queries: {
      taskProjectId: async (taskId) => (taskId === TASK ? PROJECT : null),
      projectRole: async () => null,
      previousAttempt: async (query) =>
        attempts.get(`${query.userId}|${query.action}|${query.key}`) ?? null,
      recordAction: async (input) => {
        actions.push({ ...input });
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(`${input.userId}|${input.action}|${key}`, {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
      listBreakdown: async () => world.queue,
      ...overrides,
    },
    breakdown: {
      decide: async (input) => {
        if (world.outcome === 'refuse') {
          // The **real** class the application command raises, so the route's translation is what
          // is under test: a double that threw a pre-mapped `HttpError` would be kinder than the
          // command and the 409 would prove nothing (standing rule 1).
          throw new BreakdownRefusedError('none of the named children is still waiting');
        }
        decided.push({ ...input, itemIds: [...input.itemIds] });
        return {
          accepted: input.decision === 'accept' ? input.itemIds.length : 0,
          rejected: input.decision === 'reject' ? input.itemIds.length : 0,
          remaining: 2 - input.itemIds.length,
        };
      },
    },
  });
  await app.ready();
  (world as { app: FastifyInstance }).app = app;
  return world;
};

/** A build whose process holds no pipeline store — the read-only shape. */
const buildReadOnly = async (): Promise<FastifyInstance> => {
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    request.actor = {
      userId: USER,
      email: 'operator@example.test',
      name: 'Operator',
      role: 'admin',
      sessionId: 'session-1',
    };
  });
  await registerBreakdownRoutes(app, {
    queries: {
      taskProjectId: async () => PROJECT,
      projectRole: async () => null,
      previousAttempt: async () => null,
      recordAction: async () => {},
      listBreakdown: async () => [],
    },
    breakdown: null,
  });
  await app.ready();
  return app;
};

const ROUTES = [
  { method: 'GET' as const, path: `/api/tasks/${TASK}/breakdown` },
  { method: 'POST' as const, path: `/api/tasks/${TASK}/breakdown/decide` },
];

const ACCEPT = { decision: 'accept' as const, item_ids: [ITEM_A] };

let world: World;

beforeEach(async () => {
  world = await build();
  return async () => {
    await world.app.close();
  };
});

describe('the breakdown surface exists, and the census cannot see it', () => {
  it.each(ROUTES)('serves $method $path', async ({ method, path }) => {
    const response = await world.app.inject({
      method,
      url: path,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
            payload: ACCEPT,
          }
        : {}),
    });
    expect(`${method} ${path} -> ${response.statusCode}`).toBe(`${method} ${path} -> 200`);
  });

  it.each(ROUTES)('refuses an anonymous caller on $method $path', async ({ method, path }) => {
    world.signedIn = false;
    // With **no body at all** on the write, because its guard is a `preValidation` hook: one that
    // slipped back to `preHandler` would answer 400 describing the route's shape instead of 401.
    const response = await world.app.inject({ method, url: path });
    const body = response.json() as { error?: { code?: string } };
    expect(`${response.statusCode} ${body.error?.code ?? ''}`).toBe('401 unauthenticated');
  });
});

describe('the decision', () => {
  it('accepts the named children and records one human action', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-1' },
      payload: { decision: 'accept', item_ids: [ITEM_A, ITEM_B], reason: 'both, please' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      task_id: TASK,
      performed: true,
      accepted: 2,
      rejected: 0,
      remaining: 0,
    });
    expect(world.decided).toEqual([
      {
        taskId: TASK,
        itemIds: [ITEM_A, ITEM_B],
        decision: 'accept',
        userId: USER,
        reason: 'both, please',
      },
    ]);
    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]?.action).toBe('task.breakdown.decide');
    expect(world.actions[0]?.taskId).toBe(TASK);
    // The **shape** of the request and the counts the command produced, never the words: the reason
    // is free text and this route has no redactor.
    expect(world.actions[0]?.params).toMatchObject({
      decision: 'accept',
      items: 2,
      reason_chars: 12,
      accepted: 2,
      idempotency_key: 'k-1',
    });
    expect(JSON.stringify(world.actions[0]?.params)).not.toContain('both, please');
  });

  it('requires an Idempotency-Key, because a repeat would file a second set of tickets', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json' },
      payload: ACCEPT,
    });
    expect(response.statusCode).toBe(400);
    expect(world.decided).toEqual([]);
  });

  it('performs nothing twice under the same key, on the countable effect', async () => {
    const send = () =>
      world.app.inject({
        method: 'POST',
        url: `/api/tasks/${TASK}/breakdown/decide`,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k-replay' },
        payload: ACCEPT,
      });
    const first = await send();
    const second = await send();
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ performed: false, accepted: 1 });
    // One call to the command and one audit row, whatever the caller did (standing rule 79).
    expect(world.decided).toHaveLength(1);
    expect(world.actions).toHaveLength(1);
  });

  it('refuses a different body under a used key', async () => {
    await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-2' },
      payload: ACCEPT,
    });
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-2' },
      payload: { decision: 'reject', item_ids: [ITEM_A] },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error?: { code?: string } }).error?.code).toBe(
      'idempotency_key_reused',
    );
    expect(world.decided).toHaveLength(1);
  });

  it('answers 409 when the command refuses, and writes no human action', async () => {
    world.outcome = 'refuse';
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-3' },
      payload: ACCEPT,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error?: { code?: string } }).error?.code).toBe(
      'breakdown_refused',
    );
    // *"A refused command writes no `human_actions` row"* — the rule `routes/commands.ts` states.
    expect(world.actions).toEqual([]);
  });

  it('refuses a body the contract does not admit', async () => {
    for (const payload of [
      { decision: 'accept', item_ids: [] },
      { decision: 'maybe', item_ids: [ITEM_A] },
      { decision: 'accept', item_ids: [ITEM_A], unexpected: true },
    ]) {
      const response = await world.app.inject({
        method: 'POST',
        url: `/api/tasks/${TASK}/breakdown/decide`,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k-bad' },
        payload,
      });
      expect(`${JSON.stringify(payload)} -> ${response.statusCode}`).toBe(
        `${JSON.stringify(payload)} -> 400`,
      );
    }
    expect(world.decided).toEqual([]);
  });

  it('answers 503 on a process that holds no pipeline store', async () => {
    const readOnly = await buildReadOnly();
    const response = await readOnly.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-4' },
      payload: ACCEPT,
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error?: { code?: string } }).error?.code).toBe(
      'commands_unavailable',
    );
    await readOnly.close();
  });
});

describe('who may do what', () => {
  it('lets a viewer read the queue and refuses them the decision', async () => {
    // Q85: accepting is `task.approve_plan`, which is **maintainer**; reading is `task.read`.
    world.role = 'viewer';
    const read = await world.app.inject({ method: 'GET', url: `/api/tasks/${TASK}/breakdown` });
    expect(read.statusCode).toBe(200);

    const write = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-5' },
      payload: ACCEPT,
    });
    expect(write.statusCode).toBe(403);
    expect(world.decided).toEqual([]);
  });

  it('refuses a member too, and admits a maintainer', async () => {
    // Both sides of the boundary (standing rule 42): `member` is the role a decision is most likely
    // to be mistakenly granted to, and it is the one `task.ask` has.
    world.role = 'member';
    const refused = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-6' },
      payload: ACCEPT,
    });
    expect(refused.statusCode).toBe(403);

    world.role = 'maintainer';
    const allowed = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/breakdown/decide`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k-7' },
      payload: ACCEPT,
    });
    expect(allowed.statusCode).toBe(200);
  });
});

describe('the queue read', () => {
  it('publishes every child, in order, with what was filed for it', async () => {
    world.queue = [
      item({ status: 'accepted', ticket_key: 'ACME-1001', decided_by_user_id: USER }),
      item({ id: ITEM_B, position: 1, status: 'rejected', reason: 'covered elsewhere' }),
    ];
    const response = await world.app.inject({
      method: 'GET',
      url: `/api/tasks/${TASK}/breakdown`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: TicketBreakdownItem[] };
    expect(body.items.map((entry) => [entry.position, entry.status, entry.ticket_key])).toEqual([
      [0, 'accepted', 'ACME-1001'],
      [1, 'rejected', null],
    ]);
  });

  it('answers 404 for a task nobody has', async () => {
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/tasks/00000000-0000-4000-8000-0000000000ff/breakdown',
    });
    expect(response.statusCode).toBe(404);
  });
});
