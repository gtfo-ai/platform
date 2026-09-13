/**
 * The eleven command routes, driven end to end through Fastify against **plain functions**
 * (WP-15i).
 *
 * The e2e tier drives the same routes against a real instance and a task the pipeline created,
 * which is the only tier that can prove the effect. What it cannot do is drive them *often*: an
 * instance takes a database, a container and a minute, so the decisions this file owns — the key
 * policy, the replay, which capability each route asks for, which refusal maps to which status, and
 * what lands in the audit row — would be asserted once each, in the middle of a long walk.
 *
 * They are decisions rather than plumbing, so they are held here too: `registerCommandRoutes` takes
 * its seven database reads and writes as injected functions (`CommandQueries`), the application
 * commands are a stub that records what it was asked to do, and every route is asked through the
 * real router with the real guards and the real schemas. The one thing faked away is the session,
 * which `auth/plugin.test.ts` owns.
 *
 * **What this tier cannot see**, stated rather than implied: whether a command's *effect* happens.
 * The stub performs nothing, so "the task is paused" is the e2e's assertion and "the route called
 * `pauseTaskCommand` once, with this task and this user, and wrote one audit row" is this file's.
 */
import {
  CommandsUnavailableError,
  IterationLimitReachedError,
  RunNotLiveError,
  StageNotCurrentError,
  TaskConflictExhaustedError,
  UnknownAggregateError,
} from '@platform/application';
import type { JsonObject, UserRole } from '@platform/contracts';
import { IllegalTransitionError, InvariantViolationError } from '@platform/domain';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { type CommandQueries, registerCommandRoutes } from './commands.js';

const TASK = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000a2';
const QUESTION = '00000000-0000-4000-8000-0000000000a3';
const APPROVAL = '00000000-0000-4000-8000-0000000000a4';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000e9';

/** What the stubbed application commands were asked to do, in order. */
interface Call {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

interface World {
  readonly app: FastifyInstance;
  readonly calls: Call[];
  readonly actions: {
    userId: string;
    action: string;
    params: JsonObject;
    taskId?: string | null;
  }[];
  /** The attempt `previousAttempt` answers with, keyed `user|action|key` — the lookup's scope. */
  readonly attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;
  /** What the next command call throws, if anything. */
  throws: Error | null;
  role: UserRole;
  /** Who is calling. A second user is how the key's scope is asserted. */
  userId: string;
  /** `false` drops the session, so the guards see an anonymous caller. */
  signedIn: boolean;
}

const build = async (overrides: Partial<CommandQueries> = {}): Promise<World> => {
  const calls: Call[] = [];
  const actions: World['actions'] = [];
  const attempts = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  const world = {
    calls,
    actions,
    attempts,
    throws: null,
    role: 'admin',
    userId: USER,
    signedIn: true,
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

  /** Every application command, as one recorder: the routes are what is under test. */
  const record =
    (name: string) =>
    async (input: Record<string, unknown>): Promise<never> => {
      calls.push({ name, input });
      if (world.throws !== null) {
        const thrown = world.throws;
        world.throws = null;
        throw thrown;
      }
      return {
        feedbackId: '00000000-0000-4000-8000-0000000000f1',
        taskId: TASK,
        stage: 'refinement',
      } as never;
    };

  await registerCommandRoutes(app, {
    queries: {
      taskProjectId: async (taskId) => (taskId === TASK ? PROJECT : null),
      runProjectId: async (runId) => (runId === RUN ? PROJECT : null),
      projectRole: async () => null,
      taskPosition: async (taskId) =>
        taskId === TASK ? { state: 'active', currentStage: 'refinement' } : null,
      runPosition: async (runId) =>
        runId === RUN ? { status: 'completed', taskId: TASK, taskState: 'active' } : null,
      previousAttempt: async (query) =>
        attempts.get(`${query.userId}|${query.action}|${query.key}`) ?? null,
      recordAction: async (input) => {
        actions.push({ ...input });
        // What the real writer does, so a replay of the same key by the same caller finds this
        // attempt — and one by anybody else does not (`findIdempotentAttempt`'s `where`).
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(`${input.userId}|${input.action}|${key}`, {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
      ...overrides,
    },
    // The application ring, stubbed through the port `apps/server/src/commands.ts` publishes:
    // this file asserts what the route asked for, not what the command did (see the module note).
    commands: {
      pause: record('pause'),
      resume: record('resume'),
      cancel: record('cancel'),
      retryStage: record('retry-stage'),
      returnToStage: record('return-to-stage'),
      rework: record('rework'),
      submitFeedback: record('feedback'),
      answerQuestion: record('answer'),
      decideApproval: record('decide'),
      retryRun: record('run-retry'),
      cancelRun: record('run-cancel'),
    },
  });
  await app.ready();
  (world as { app: FastifyInstance }).app = app;
  return world;
};

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> & {
    readonly error?: { readonly code: string; readonly message: string };
  };
}

const post = async (world: World, path: string, body: unknown, key?: string): Promise<Reply> => {
  const response = await world.app.inject({
    method: 'POST',
    url: path,
    payload: body as object,
    headers: key === undefined ? {} : { 'idempotency-key': key },
  });
  return { status: response.statusCode, body: response.json() as Reply['body'] };
};

/** The eleven, with a body each route accepts and the capability its guard asks for. */
const COMMANDS: readonly {
  readonly name: string;
  readonly path: string;
  readonly body: unknown;
  /**
   * A **second** body the same route accepts, differing in a field that means something.
   *
   * Not `{...body, reason: 'changed my mind'}`: four of these schemas are strict objects with no
   * `reason`, so that body is a 400 and the reuse 409 it was meant to exercise never runs (the
   * first version of this file accepted `[400, 409]` and therefore asserted the refusal for seven
   * routes and nothing for four).
   */
  readonly otherBody: unknown;
  readonly key: 'required' | 'optional';
  /** The lowest role that may issue it (`PERMISSION_REQUIREMENTS`). */
  readonly role: UserRole;
}[] = [
  {
    name: 'pause',
    path: `/api/tasks/${TASK}/pause`,
    body: {},
    otherBody: { reason: 'stepping in after all' },
    key: 'optional',
    role: 'member',
  },
  {
    name: 'resume',
    path: `/api/tasks/${TASK}/resume`,
    body: {},
    otherBody: { reason: 'carry on' },
    key: 'optional',
    role: 'member',
  },
  {
    name: 'cancel',
    path: `/api/tasks/${TASK}/cancel`,
    body: {},
    otherBody: { reason: 'the ticket was withdrawn' },
    key: 'optional',
    role: 'maintainer',
  },
  {
    name: 'retry-stage',
    path: `/api/tasks/${TASK}/retry-stage`,
    body: { stage: 'refinement' },
    otherBody: { stage: 'implementation' },
    key: 'required',
    role: 'member',
  },
  {
    name: 'return-to-stage',
    path: `/api/tasks/${TASK}/return-to-stage`,
    body: { stage: 'architecture', reason: 'think again' },
    otherBody: { stage: 'refinement', reason: 'think again' },
    key: 'required',
    role: 'maintainer',
  },
  {
    name: 'rework',
    path: `/api/tasks/${TASK}/rework`,
    body: { stage: 'architecture', instructions: 'another approach' },
    otherBody: { stage: 'architecture', instructions: 'a third approach' },
    key: 'required',
    role: 'maintainer',
  },
  {
    name: 'feedback',
    path: `/api/tasks/${TASK}/feedback`,
    body: { scope: 'task', text: 'good work' },
    otherBody: { scope: 'task', text: 'poor work' },
    key: 'required',
    role: 'member',
  },
  {
    name: 'answer',
    path: `/api/tasks/${TASK}/questions/${QUESTION}/answer`,
    body: { answer: 'the second one' },
    otherBody: { answer: 'the first one' },
    key: 'required',
    role: 'member',
  },
  {
    name: 'decide',
    path: `/api/tasks/${TASK}/approvals/${APPROVAL}/decide`,
    body: { decision: 'approve' },
    otherBody: { decision: 'reject' },
    key: 'required',
    role: 'maintainer',
  },
  {
    name: 'run-retry',
    path: `/api/runs/${RUN}/retry`,
    body: { model: 'claude-haiku-4-5' },
    otherBody: { model: 'claude-opus-5' },
    key: 'required',
    role: 'member',
  },
  {
    name: 'run-cancel',
    path: `/api/runs/${RUN}/cancel`,
    body: {},
    otherBody: { reason: 'it is stuck' },
    key: 'optional',
    role: 'member',
  },
];

let world: World;

beforeEach(async () => {
  world = await build();
  return async () => {
    await world.app.close();
  };
});

describe('every command, enumerated', () => {
  it('performs each one and writes exactly one `human_actions` row for it (standing rule 68)', async () => {
    for (const command of COMMANDS) {
      const reply = await post(world, command.path, command.body, `${command.name}-key`);
      expect(reply.status, `${command.name}: ${JSON.stringify(reply.body)}`).toBe(200);
      expect(reply.body.performed).toBe(true);
    }
    expect(world.calls.map((call) => call.name)).toEqual(COMMANDS.map((command) => command.name));
    expect(world.actions).toHaveLength(COMMANDS.length);
    // Every row names the person, and the audit's action names are distinct per command.
    expect(new Set(world.actions.map((action) => action.userId))).toEqual(new Set([USER]));
    expect(new Set(world.actions.map((action) => action.action)).size).toBe(COMMANDS.length);
    // Every row names the **task**, including the two whose path names a run: `task_id` carries
    // `human_actions`' only index, so a null there is a row no reader of the table will find.
    expect(world.actions.map((action) => `${action.action}:${action.taskId ?? 'null'}`)).toEqual(
      world.actions.map((action) => `${action.action}:${TASK}`),
    );
  });

  it('refuses an anonymous caller on every one, before validating the body', async () => {
    world.signedIn = false;
    for (const command of COMMANDS) {
      // No body at all: a guard in the wrong hook would answer 400 describing the route's shape.
      const reply = await post(world, command.path, undefined);
      expect(`${command.name} ${reply.status} ${reply.body.error?.code ?? ''}`).toBe(
        `${command.name} 401 unauthenticated`,
      );
    }
    expect(world.calls).toEqual([]);
    expect(world.actions).toEqual([]);
  });

  it('refuses a caller whose role is one level too low, per command', async () => {
    const below: Record<UserRole, UserRole> = {
      viewer: 'viewer',
      member: 'viewer',
      maintainer: 'member',
      admin: 'maintainer',
    };
    for (const command of COMMANDS) {
      world.role = below[command.role];
      const reply = await post(world, command.path, command.body, `${command.name}-403`);
      expect(`${command.name} ${reply.status} ${reply.body.error?.code ?? ''}`).toBe(
        `${command.name} 403 forbidden`,
      );
    }
    // Nothing was performed and nothing was audited, which is the other half of criterion 2.
    expect(world.calls).toEqual([]);
    expect(world.actions).toEqual([]);
  });

  it('requires an `Idempotency-Key` exactly where a repeat would create a second thing', async () => {
    for (const command of COMMANDS) {
      const reply = await post(world, command.path, command.body);
      if (command.key === 'required') {
        expect(`${command.name} ${reply.status} ${reply.body.error?.code ?? ''}`).toBe(
          `${command.name} 400 idempotency_key_required`,
        );
      } else {
        expect(`${command.name} ${reply.status}`).toBe(`${command.name} 200`);
      }
    }
    // The four that need none performed; the seven that need one did not.
    expect(world.calls.map((call) => call.name)).toEqual(
      COMMANDS.filter((command) => command.key === 'optional').map((command) => command.name),
    );
  });

  it('performs nothing twice under one key, and refuses a different body under it', async () => {
    for (const command of COMMANDS) {
      const key = `${command.name}-replay`;
      const first = await post(world, command.path, command.body, key);
      expect(first.body.performed).toBe(true);
      const replay = await post(world, command.path, command.body, key);
      expect(`${command.name} ${replay.status} ${String(replay.body.performed)}`).toBe(
        `${command.name} 200 false`,
      );
      // The countable effect: one call and one audit row for two requests (standing rule 79).
      expect(world.calls.filter((call) => call.name === command.name)).toHaveLength(1);
      expect(world.actions.filter((action) => action.params.idempotency_key === key)).toHaveLength(
        1,
      );

      // A body this route **accepts** and that differs in a field that means something, so the
      // only correct answer is the reuse 409 (see `otherBody`).
      const different = await post(world, command.path, command.otherBody, key);
      expect(`${command.name} ${different.status} ${different.body.error?.code ?? ''}`).toBe(
        `${command.name} 409 idempotency_key_reused`,
      );
      expect(world.calls.filter((call) => call.name === command.name)).toHaveLength(1);
    }
  });

  it('scopes a key to the caller: the same string from another account performs its own command', async () => {
    // The lookup is `(user_id, action, key)`. Installation-wide, this second request would be
    // refused `409 idempotency_key_reused` — a refusal of a legitimate command, and an oracle for
    // the existence of a stranger's key (`queries/onboarding-queries.ts`'s `findIdempotentAttempt`).
    const other = '00000000-0000-4000-8000-0000000000ea';
    for (const command of COMMANDS) {
      const key = `shared-${command.name}`;
      world.userId = USER;
      const mine = await post(world, command.path, command.body, key);
      expect(`${command.name} ${mine.status} ${String(mine.body.performed)}`).toBe(
        `${command.name} 200 true`,
      );
      world.userId = other;
      const theirs = await post(world, command.path, command.body, key);
      expect(`${command.name} ${theirs.status} ${String(theirs.body.performed)}`).toBe(
        `${command.name} 200 true`,
      );
      // Both performed, and each audit row names its own actor.
      expect(world.calls.filter((call) => call.name === command.name)).toHaveLength(2);
      expect(
        world.actions
          .filter((action) => action.params.idempotency_key === key)
          .map((action) => action.userId),
      ).toEqual([USER, other]);
      // …and the second caller's own replay is still a replay (rule 42: the other side).
      const again = await post(world, command.path, command.body, key);
      expect(`${command.name} ${again.status} ${String(again.body.performed)}`).toBe(
        `${command.name} 200 false`,
      );
      expect(world.calls.filter((call) => call.name === command.name)).toHaveLength(2);
    }
  });
});

describe('what each refusal maps to', () => {
  const cases: readonly {
    readonly error: Error;
    readonly status: number;
    readonly code: string;
  }[] = [
    {
      error: new IllegalTransitionError('Task', 'paused', 'paused'),
      status: 409,
      code: 'illegal_transition',
    },
    {
      error: new InvariantViolationError('task.resume', 'it has entered no stage'),
      status: 409,
      code: 'invariant_violation',
    },
    {
      error: new StageNotCurrentError('implementation' as never, 'refinement' as never),
      status: 409,
      code: 'stage_not_current',
    },
    {
      error: new IterationLimitReachedError('human_rounds', 3),
      status: 409,
      code: 'iteration_limit_reached',
    },
    {
      error: new RunNotLiveError(RUN as never, 'completed', 'cancelled'),
      status: 409,
      code: 'run_not_live',
    },
    {
      error: new TaskConflictExhaustedError(TASK as never, 3, 'pausing the task'),
      status: 409,
      code: 'task_conflict',
    },
    {
      error: new UnknownAggregateError('question does not exist'),
      status: 404,
      code: 'not_found',
    },
    {
      error: new CommandsUnavailableError('this process runs no job workers'),
      status: 503,
      code: 'commands_unavailable',
    },
  ];

  for (const entry of cases) {
    it(`answers ${entry.status} ${entry.code} for ${entry.error.name}`, async () => {
      world.throws = entry.error;
      const reply = await post(world, `/api/tasks/${TASK}/pause`, {});
      expect(reply.status).toBe(entry.status);
      expect(reply.body.error?.code).toBe(entry.code);
      // A refused command writes no audit row — the other direction of criterion 2.
      expect(world.actions).toEqual([]);
    });
  }
});

describe('the routes’ own answers', () => {
  it('answers a task command with where the task now stands', async () => {
    const reply = await post(world, `/api/tasks/${TASK}/pause`, { reason: 'stepping in' });
    expect(reply.body).toEqual({
      task_id: TASK,
      state: 'active',
      current_stage: 'refinement',
      performed: true,
    });
    // The free text is **not** in the audit row: the row records the shape of the command.
    expect(JSON.stringify(world.actions)).not.toContain('stepping in');
  });

  it('answers a run command with the run and its task', async () => {
    const reply = await post(world, `/api/runs/${RUN}/cancel`, {});
    expect(reply.body).toEqual({
      run_id: RUN,
      task_id: TASK,
      status: 'completed',
      task_state: 'active',
      performed: true,
    });
  });

  it('answers a feedback replay with the id the first attempt recorded', async () => {
    const first = await post(
      world,
      `/api/tasks/${TASK}/feedback`,
      { scope: 'stage', stage: 'code_review', text: 'thin' },
      'fb-1',
    );
    expect(first.body.feedback_id).toBe('00000000-0000-4000-8000-0000000000f1');
    const replay = await post(
      world,
      `/api/tasks/${TASK}/feedback`,
      { scope: 'stage', stage: 'code_review', text: 'thin' },
      'fb-1',
    );
    expect(replay.body).toEqual({
      feedback_id: '00000000-0000-4000-8000-0000000000f1',
      task_id: TASK,
      performed: false,
    });
  });

  it('refuses a `budget_usd` override by name rather than ignoring it', async () => {
    const reply = await post(world, `/api/runs/${RUN}/retry`, { budget_usd: 50 }, 'budget-1');
    expect(reply.status).toBe(409);
    expect(reply.body.error?.code).toBe('budget_override_unsupported');
    expect(world.calls).toEqual([]);
  });

  it('passes the model and the effort through, and omits them when they are absent', async () => {
    await post(world, `/api/runs/${RUN}/retry`, { model: 'claude-haiku-4-5' }, 'm-1');
    expect(world.calls[0]?.input).toEqual({
      runId: RUN,
      userId: USER,
      model: 'claude-haiku-4-5',
    });
    await post(world, `/api/runs/${RUN}/retry`, { effort: 'low' }, 'm-2');
    expect(world.calls[1]?.input).toEqual({ runId: RUN, userId: USER, effort: 'low' });
  });

  it('passes the feedback’s optional fields only when the client sent them', async () => {
    await post(world, `/api/tasks/${TASK}/feedback`, { scope: 'task', text: 'fine' }, 'f-1');
    expect(world.calls[0]?.input).toEqual({
      taskId: TASK,
      userId: USER,
      scope: 'task',
      text: 'fine',
      channel: 'ui',
    });
    await post(
      world,
      `/api/tasks/${TASK}/feedback`,
      {
        scope: 'artifact',
        text: 'fine',
        rating: 4,
        stage: 'code_review',
        artifact_id: '00000000-0000-4000-8000-0000000000c1',
      },
      'f-2',
    );
    expect(world.calls[1]?.input).toEqual({
      taskId: TASK,
      userId: USER,
      scope: 'artifact',
      text: 'fine',
      channel: 'ui',
      rating: 4,
      stage: 'code_review',
      artifactId: '00000000-0000-4000-8000-0000000000c1',
    });
  });

  it('passes the approval’s optional reason and maps the decision to the aggregate’s word', async () => {
    await post(
      world,
      `/api/tasks/${TASK}/approvals/${APPROVAL}/decide`,
      { decision: 'reject', reason: 'the plan is too wide' },
      'd-1',
    );
    expect(world.calls[0]?.input).toEqual({
      approvalId: APPROVAL,
      userId: USER,
      decision: 'rejected',
      role: 'admin',
      reason: 'the plan is too wide',
    });
    // …and the reason is not audited, for the reason the pause case gives.
    expect(JSON.stringify(world.actions)).not.toContain('too wide');
  });

  it('answers 404 for a task or a run that does not exist, before any command runs', async () => {
    const task = await post(world, '/api/tasks/00000000-0000-4000-8000-00000000dead/pause', {});
    expect(task.status).toBe(404);
    const run = await post(world, '/api/runs/00000000-0000-4000-8000-00000000dead/cancel', {});
    expect(run.status).toBe(404);
    expect(world.calls).toEqual([]);
  });

  it('answers 400 for a path segment that is not a uuid, after refusing an anonymous caller', async () => {
    // The `preValidation` cost, and the half that matters: the guard sees an unvalidated segment,
    // so it leaves it unresolved and the validator answers a moment later.
    const reply = await post(world, '/api/tasks/not-a-uuid/pause', {});
    expect(reply.status).toBe(400);
    world.signedIn = false;
    const anonymous = await post(world, '/api/tasks/not-a-uuid/pause', {});
    expect(anonymous.status).toBe(401);
  });

  it('refuses every command with 503 on a process that composed no pipeline', async () => {
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
    await registerCommandRoutes(app, {
      queries: {
        taskProjectId: async () => PROJECT,
        runProjectId: async () => PROJECT,
        projectRole: async () => null,
        taskPosition: async () => ({ state: 'active', currentStage: 'refinement' }),
        runPosition: async () => ({ status: 'completed', taskId: TASK, taskState: 'active' }),
        previousAttempt: async () => null,
        recordAction: async () => undefined,
      },
      commands: null,
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${TASK}/pause`,
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as Reply['body']).error?.code).toBe('commands_unavailable');
    await app.close();
  });
});
