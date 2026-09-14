/**
 * The three ask-the-task routes, driven end to end through Fastify against plain functions (WP-31).
 *
 * **Why this file exists at all** is criterion 7: `routes/client-census.test.ts` compares the
 * *client's* paths against the router, and a route the SPA does not call is invisible to it by
 * construction — which is exactly what the plan row says of `POST /api/tasks/:id/ask`. So the three
 * are named **positively** here, with the auth, the key policy, the replay and the refusals each
 * asserted from both sides.
 *
 * What this tier cannot see, stated rather than implied: whether an ask is ever *answered*. The
 * command port is a recorder, so "one `task_asks` row and one run" is the e2e's assertion and "the
 * route called the command once, wrote one `human_actions` row, and wrote none for a refusal" is
 * this file's.
 */
import type { JsonObject, TaskAsk, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { type AskQueries, registerAskRoutes } from './asks.js';

const TASK = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000e9';
const OTHER_USER = '00000000-0000-4000-8000-0000000000ea';
const ASK = '00000000-0000-4000-8000-0000000000f5';

interface World {
  readonly app: FastifyInstance;
  readonly asked: { taskId: string; projectId: string; userId: string; question: string }[];
  readonly actions: {
    userId: string;
    action: string;
    params: JsonObject;
    taskId?: string | null;
  }[];
  readonly attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;
  role: UserRole;
  userId: string;
  signedIn: boolean;
  /** What the command port answers next; `duplicate` is the one refusal it can produce. */
  result: 'recorded' | 'duplicate';
  /** `null` composes no pipeline, which is what an API-only process has. */
  commandsComposed: boolean;
  thread: TaskAsk[];
  audit: AskQueries extends { taskAudit: (...args: never[]) => Promise<infer T> } ? T : never;
}

const ask = (overrides: Partial<TaskAsk> = {}): TaskAsk => ({
  id: ASK,
  task_id: TASK,
  source: 'ui',
  asked_by_user_id: USER,
  question: 'why did you choose a column?',
  run_id: null,
  status: 'answered',
  answer: 'Because a join on every read is worse.',
  citations: [],
  dropped_citations: 0,
  answer_artifact_id: null,
  refusal_reason: null,
  mirrored_at: null,
  created_at: '2026-06-01T09:00:00.000Z',
  answered_at: '2026-06-01T09:01:00.000Z',
  ...overrides,
});

const build = async (overrides: Partial<AskQueries> = {}): Promise<World> => {
  const asked: World['asked'] = [];
  const actions: World['actions'] = [];
  const attempts = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  const world = {
    asked,
    actions,
    attempts,
    role: 'admin',
    userId: USER,
    signedIn: true,
    result: 'recorded',
    commandsComposed: true,
    thread: [ask()],
    audit: [
      {
        id: '00000000-0000-4000-8000-0000000000f6',
        action: 'task.pause',
        user_id: USER,
        params: { reason: 'waiting on the API team' },
        created_at: '2026-06-01T08:45:00.000Z',
      },
    ],
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
        userId: world.userId,
        email: 'operator@example.test',
        name: 'Operator',
        role: world.role,
        sessionId: 'session-1',
      };
    }
  });

  await registerAskRoutes(app, {
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
      listAsks: async () => world.thread,
      taskAudit: async () => world.audit,
      ...overrides,
    },
    asks: {
      ask: async (input) => {
        asked.push({ ...input });
        return world.result === 'duplicate'
          ? { status: 'duplicate' as const }
          : { status: 'recorded' as const, askId: ASK };
      },
    },
  });
  await app.ready();
  (world as { app: FastifyInstance }).app = app;
  return world;
};

/** A build whose process composed no pipeline — the `ROLE=api` shape. */
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
  await registerAskRoutes(app, {
    queries: {
      taskProjectId: async () => PROJECT,
      projectRole: async () => null,
      previousAttempt: async () => null,
      recordAction: async () => {},
      listAsks: async () => [],
      taskAudit: async () => [],
    },
    asks: null,
  });
  await app.ready();
  return app;
};

/** The three paths this row adds, named positively (criterion 7). */
const ROUTES = [
  { method: 'POST' as const, path: `/api/tasks/${TASK}/ask` },
  { method: 'GET' as const, path: `/api/tasks/${TASK}/asks` },
  { method: 'GET' as const, path: `/api/tasks/${TASK}/audit` },
];

let world: World;

beforeEach(async () => {
  world = await build();
  return async () => {
    await world.app.close();
  };
});

describe('the ask surface exists, and the census cannot see it', () => {
  it.each(ROUTES)('serves $method $path', async ({ method, path }) => {
    const response = await world.app.inject({
      method,
      url: path,
      ...(method === 'POST'
        ? { headers: { 'idempotency-key': 'k-1' }, payload: { question: 'why?' } }
        : {}),
    });
    // Positively: not 404, and not the 501 a registered-but-unimplemented route would answer.
    expect(response.statusCode).toBe(200);
  });

  it.each(ROUTES)('refuses an anonymous caller on $method $path', async ({ method, path }) => {
    world.signedIn = false;
    const response = await world.app.inject({
      method,
      url: path,
      ...(method === 'POST'
        ? { headers: { 'idempotency-key': 'k-1' }, payload: { question: 'why?' } }
        : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthenticated');
  });
});

describe('POST /api/tasks/:task_id/ask', () => {
  it('calls the command once and records one human action', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why did you choose a column?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ask_id: ASK,
      task_id: TASK,
      performed: true,
      status: 'pending',
    });
    expect(world.asked).toEqual([
      {
        taskId: TASK,
        projectId: PROJECT,
        userId: USER,
        question: 'why did you choose a column?',
      },
    ]);
    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]?.action).toBe('task.ask');
    expect(world.actions[0]?.taskId).toBe(TASK);
  });

  it('records the shape of the request and never the words', async () => {
    // The question is free text on its way to a row, and this route has no redactor: the command
    // redacts it (`routes/commands.ts`'s module note states the same rule for the other nine).
    await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why did you use glpat-FAKEFAKEFAKE here?' },
    });
    const params = world.actions[0]?.params ?? {};
    expect(JSON.stringify(params)).not.toContain('glpat-');
    expect(params.question_chars).toBe('why did you use glpat-FAKEFAKEFAKE here?'.length);
    expect(params.ask_id).toBe(ASK);
  });

  it('requires an Idempotency-Key, because a repeat would start a second paid run', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      payload: { question: 'why?' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('idempotency_key_required');
    expect(world.asked).toHaveLength(0);
  });

  it('performs nothing twice under a replayed key, on a countable effect', async () => {
    const send = () =>
      world.app.inject({
        method: 'POST',
        url: `/api/tasks/${TASK}/ask`,
        headers: { 'idempotency-key': 'k-replay' },
        payload: { question: 'why?' },
      });
    const first = await send();
    const second = await send();

    expect(first.json().performed).toBe(true);
    expect(second.json().performed).toBe(false);
    expect(second.json().ask_id).toBe(ASK);
    // The countable effects: one command call, one audit row (standing rule 79).
    expect(world.asked).toHaveLength(1);
    expect(world.actions).toHaveLength(1);
  });

  it('refuses a different question under a used key rather than serving the first answer', async () => {
    await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why a column?' },
    });
    const second = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why a table?' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('idempotency_key_reused');
    expect(world.asked).toHaveLength(1);
  });

  it('refuses a replay whose recorded attempt predates the ask id being audited', async () => {
    // A `human_actions` row written by a build before `params.ask_id` existed. Answering a
    // placeholder would tell the caller their question became an ask nobody can find; refusing says
    // what is true — the command ran and this process cannot say what it produced (WP-27's rule).
    world.attempts.set(`${USER}|task.ask|k-old`, { bodyDigest: null, params: {} });
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-old' },
      payload: { question: 'why?' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('idempotency_key_reused');
    expect(world.asked).toHaveLength(0);
  });

  it('scopes the key to the caller: another user’s key is not a replay', async () => {
    await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'shared' },
      payload: { question: 'why?' },
    });
    world.userId = OTHER_USER;
    const second = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'shared' },
      payload: { question: 'why?' },
    });
    expect(second.json().performed).toBe(true);
    expect(world.asked).toHaveLength(2);
  });

  it('refuses an unknown task with 404 and writes no audit row', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: '/api/tasks/00000000-0000-4000-8000-0000000000ff/ask',
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why?' },
    });
    expect(response.statusCode).toBe(404);
    expect(world.actions).toHaveLength(0);
  });

  it('refuses an empty question and an unknown key through the strict contract', async () => {
    const empty = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: '' },
    });
    expect(empty.statusCode).toBe(400);
    const extra = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-2' },
      payload: { question: 'why?', model: 'claude-opus-5' },
    });
    expect(extra.statusCode).toBe(400);
    expect(world.asked).toHaveLength(0);
  });

  it('refuses a question past the cap rather than truncating it', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'x'.repeat(4_001) },
    });
    expect(response.statusCode).toBe(400);
    expect(world.asked).toHaveLength(0);
  });

  it('names the deployment when this process composed no pipeline', async () => {
    const app = await buildReadOnly();
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why?' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('commands_unavailable');
    // And the reads still answer on the same process: a thread somebody asked for on a worker is
    // readable from an API-only replica.
    expect((await app.inject({ method: 'GET', url: `/api/tasks/${TASK}/asks` })).statusCode).toBe(
      200,
    );
    await app.close();
  });

  it('refuses a collision by name rather than reporting it as success', async () => {
    world.result = 'duplicate';
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why?' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ask_already_recorded');
    expect(world.actions).toHaveLength(0);
  });
});

describe('GET /api/tasks/:task_id/asks', () => {
  it('serves the thread, citations and drop count included', async () => {
    world.thread = [
      ask({
        citations: [
          { kind: 'artifact', artifact_type: 'ImplementationPlan', version: 2, detail: 'the plan' },
        ],
        dropped_citations: 2,
      }),
    ];
    const response = await world.app.inject({ method: 'GET', url: `/api/tasks/${TASK}/asks` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].dropped_citations).toBe(2);
    expect(body.items[0].citations[0].artifact_type).toBe('ImplementationPlan');
    // A citation carries **no URL**: a model that could write one would be publishing a link.
    expect(Object.keys(body.items[0].citations[0])).not.toContain('url');
  });

  it('404s an unknown task rather than answering an empty thread', async () => {
    const response = await world.app.inject({
      method: 'GET',
      url: '/api/tasks/00000000-0000-4000-8000-0000000000ff/asks',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/tasks/:task_id/audit (criterion 10, PROGRESS backlog 52)', () => {
  it('serves the task’s own human actions, which the project audit never matches', async () => {
    const response = await world.app.inject({ method: 'GET', url: `/api/tasks/${TASK}/audit` });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].action).toBe('task.pause');
    // `params` is client-supplied JSON and is published as it was written: untrusted at the reader.
    expect(response.json().items[0].params.reason).toBe('waiting on the API team');
  });

  it('is maintainer, not viewer: it is the same table the project audit gates that way', async () => {
    world.role = 'member';
    const response = await world.app.inject({ method: 'GET', url: `/api/tasks/${TASK}/audit` });
    expect(response.statusCode).toBe(403);
    // Both directions, so a guard that refused everything would fail the first half.
    world.role = 'maintainer';
    expect(
      (await world.app.inject({ method: 'GET', url: `/api/tasks/${TASK}/audit` })).statusCode,
    ).toBe(200);
  });

  it('lets a member ask and read the thread, which is where the two capabilities differ', async () => {
    world.role = 'member';
    expect(
      (
        await world.app.inject({
          method: 'POST',
          url: `/api/tasks/${TASK}/ask`,
          headers: { 'idempotency-key': 'k-1' },
          payload: { question: 'why?' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await world.app.inject({ method: 'GET', url: `/api/tasks/${TASK}/asks` })).statusCode,
    ).toBe(200);
  });

  it('refuses a viewer’s ask — it spends the project’s money (the deviation from Q72)', async () => {
    world.role = 'viewer';
    const response = await world.app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/ask`,
      headers: { 'idempotency-key': 'k-1' },
      payload: { question: 'why?' },
    });
    expect(response.statusCode).toBe(403);
    // A viewer still reads the thread: that really does read only what they can already see.
    expect(
      (await world.app.inject({ method: 'GET', url: `/api/tasks/${TASK}/asks` })).statusCode,
    ).toBe(200);
  });
});
