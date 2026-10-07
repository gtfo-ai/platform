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
  ModelNotListedError,
  NoGateFeedbackError,
  RunNotLiveError,
  StageNotCurrentError,
  StageNotInTemplateError,
  StageNotReachedError,
  SteerWindowClosedError,
  TaskBudgetNotRaisedError,
  TaskConflictExhaustedError,
  TaskNotPausedByItsCapError,
  UnknownAggregateError,
} from '@platform/application';
import type { JsonObject, UserRole } from '@platform/contracts';
import { IllegalTransitionError, InvariantViolationError, TaskMergedError } from '@platform/domain';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { type CommandQueries, registerCommandRoutes } from './commands.js';
import { memoryAttemptRecords } from './idempotency-memory.js';

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
  /** The attempts `claimAttempt` answers with, keyed `user|action|key` — the record's scope. */
  readonly attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;
  /** What the next command call throws, if anything. */
  throws: Error | null;
  /** What the next command call returns, when a case needs something other than the default. */
  result: Record<string, unknown> | null;
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
    result: null,
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
      if (world.result !== null) {
        const result = world.result;
        world.result = null;
        return result as never;
      }
      return {
        feedbackId: '00000000-0000-4000-8000-0000000000f1',
        taskId: TASK,
        stage: 'refinement',
        // WP-27's take-over answers with what the command produced, and the route's `answer`
        // reads all three: a recorder that returned none of them would make the response's own
        // shape untestable (standing rule 82).
        branch: 'agentic/ACME-1',
        sessionId: 'session-abc',
        exported: true,
        // WP-85: the take-over's recorded run and the steer's recorded command.
        runId: RUN,
        commandId: '00000000-0000-4000-8000-0000000000c1',
        // `null`, never absent: the real `pause` and `takeOver` answer `{reason: string | null}`,
        // and a stub that omitted the field would let a route read `undefined` where production
        // reads `null` — a fake kinder than the adapter (standing rule 1). A case that wants the
        // words back sets `world.result`.
        reason: null,
        // Backlog 494: retry-stage answers the attempt it entered and the run it stopped.
        attempt: 2,
        stoppedRun: null,
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
      ...memoryAttemptRecords(attempts),
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
      // WP-131 review round 1: the raise answers the caps for the audit row; the recorder's default
      // answer carries neither, so a call that set no `world.result` gets the honest pair here.
      raiseBudget: async (input) => {
        const recorded = (await record('task-budget')(input)) as unknown;
        return recorded !== null &&
          typeof recorded === 'object' &&
          'previousCapUsd' in (recorded as object)
          ? (recorded as { capUsd: number; previousCapUsd: number })
          : { capUsd: input.capUsd, previousCapUsd: 50 };
      },
      cancel: record('cancel'),
      retryStage: record('retry-stage'),
      returnToStage: record('return-to-stage'),
      rework: record('rework'),
      submitFeedback: record('feedback'),
      answerQuestion: record('answer'),
      decideApproval: record('decide'),
      retryRun: record('run-retry'),
      cancelRun: record('run-cancel'),
      steerRun: record('run-steer'),
      takeOver: record('take-over'),
      handBack: record('hand-back'),
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
  /**
   * The status an accepted request answers — `200`, except the steer's `202`: since WP-85 it is
   * **accepted**, then applied or refused by the process holding the run (TD-028 decision 9) — and
   * a run cancel's when it recorded a stop (WP-101, TD-028 decision 11), which the recorder's
   * default `commandId` says it did. The in-place branch's `200` is its own case below.
   */
  readonly accepted?: 202;
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
    name: 'task-budget',
    path: `/api/tasks/${TASK}/budget`,
    body: { cap_usd: 80 },
    otherBody: { cap_usd: 90 },
    key: 'required',
    role: 'maintainer',
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
    accepted: 202,
  },
  {
    name: 'run-steer',
    path: `/api/runs/${RUN}/steer`,
    body: { message: 'use the invoice total' },
    otherBody: { message: 'use the line sum' },
    key: 'required',
    role: 'member',
    accepted: 202,
  },
  {
    name: 'take-over',
    path: `/api/tasks/${TASK}/take-over`,
    body: {},
    otherBody: { tarball: true },
    key: 'optional',
    role: 'member',
  },
  {
    name: 'hand-back',
    path: `/api/tasks/${TASK}/hand-back`,
    body: { stage: 'code_review', summary: 'fixed by hand' },
    otherBody: { stage: 'implementation', summary: 'fixed by hand' },
    key: 'required',
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
      expect(reply.status, `${command.name}: ${JSON.stringify(reply.body)}`).toBe(
        command.accepted ?? 200,
      );
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
        expect(`${command.name} ${reply.status}`).toBe(
          `${command.name} ${command.accepted ?? 200}`,
        );
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
        `${command.name} ${command.accepted ?? 200} false`,
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
        `${command.name} ${command.accepted ?? 200} true`,
      );
      world.userId = other;
      const theirs = await post(world, command.path, command.body, key);
      expect(`${command.name} ${theirs.status} ${String(theirs.body.performed)}`).toBe(
        `${command.name} ${command.accepted ?? 200} true`,
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
        `${command.name} ${command.accepted ?? 200} false`,
      );
      expect(world.calls.filter((call) => call.name === command.name)).toHaveLength(2);
    }
  });
});

describe('the steer window (technical/08: one message per five seconds per user)', () => {
  /**
   * The window is not this file's any more (WP-101, PROGRESS backlog 295): it is read off the
   * recorded steers under a per-user advisory lock, in the command's own transaction, so what the
   * route owns is the translation. The window itself — both processes, the lock and its canary —
   * is `test/integration/pipeline/run-commands.integration.test.ts` and the topology e2e.
   */
  it('answers the window’s refusal 429 rate_limited, and audits nothing', async () => {
    world.throws = new SteerWindowClosedError();
    const tooSoon = await post(world, `/api/runs/${RUN}/steer`, { message: 'two' }, 'steer-2');
    expect(`${tooSoon.status} ${tooSoon.body.error?.code ?? ''}`).toBe('429 rate_limited');
    expect(tooSoon.body.error?.message).toContain('one message every 5 seconds per person');
    expect(world.actions).toEqual([]);
    // The key is given back with the refusal, so a retry under it performs (WP-67).
    const retry = await post(world, `/api/runs/${RUN}/steer`, { message: 'two' }, 'steer-2');
    expect(retry.status, JSON.stringify(retry.body)).toBe(202);
    expect(retry.body.performed).toBe(true);
  });
});

/**
 * PROGRESS backlog 483 — AUT-6820, through the real router: a task parked in `needs_human` at
 * `ci_gate` is sent back to `implementation` by `return-to-stage` and by `rework`. Nothing at this
 * tier decides the state (the aggregate does, `human-commands.test.ts`), so what is held here is the
 * route's half: it reaches the command for an escalated task, answers where the task is **after**
 * it, writes one `human_actions` row per accepted command, and none for the refusal the command
 * raises for a stage the task never reached.
 */
describe('a return out of needs_human (backlog 483)', () => {
  /** A task at `needs_human`, which reads `active` at `implementation` once a command performed. */
  const escalatedWorld = async (): Promise<World> => {
    const holder: { world?: World } = {};
    const parked = await build({
      taskPosition: async () =>
        (holder.world?.calls.length ?? 0) > 0
          ? { state: 'active', currentStage: 'implementation' }
          : { state: 'needs_human', currentStage: 'ci_gate' },
    });
    holder.world = parked;
    return parked;
  };

  for (const route of [
    {
      name: 'return-to-stage',
      action: 'task.return_to_stage',
      body: { stage: 'implementation', reason: 'no merge request was opened; open one' },
    },
    {
      name: 'rework',
      action: 'task.rework',
      body: { stage: 'implementation', instructions: 'open the merge request from the tool' },
    },
  ]) {
    it(`performs ${route.name} on an escalated task and audits it once`, async () => {
      const parked = await escalatedWorld();
      parked.role = 'maintainer';
      const path = `/api/tasks/${TASK}/${route.name}`;

      const reply = await post(parked, path, route.body, `${route.name}-escalated-1`);
      expect(reply.status, JSON.stringify(reply.body)).toBe(200);
      expect(reply.body).toMatchObject({
        performed: true,
        state: 'active',
        current_stage: 'implementation',
      });
      expect(parked.calls.map((call) => call.name)).toEqual([route.name]);
      expect(parked.calls[0]?.input).toMatchObject({
        taskId: TASK,
        userId: parked.userId,
        stage: 'implementation',
      });
      expect(parked.actions).toHaveLength(1);
      expect(parked.actions[0]).toMatchObject({
        action: route.action,
        taskId: TASK,
        params: { task_id: TASK, stage: 'implementation' },
      });
    });
  }

  it('answers 409 stage_not_reached for a stage the escalated task never ran, and audits nothing', async () => {
    const parked = await escalatedWorld();
    parked.throws = new StageNotReachedError('code_review' as never, 'ci_gate' as never);
    const reply = await post(
      parked,
      `/api/tasks/${TASK}/return-to-stage`,
      { stage: 'code_review', reason: 'review it' },
      'return-unreached-1',
    );
    expect(`${reply.status} ${reply.body.error?.code ?? ''}`).toBe('409 stage_not_reached');
    expect(reply.body.error?.message).toContain('has not been through "code_review"');
    expect(parked.actions).toEqual([]);
  });

  /**
   * WP-152 ruling (b): the person's choice reaches the command and the audit row, for both routes;
   * absent stays absent, so the command's default — attach a parked gate's failure — stands.
   */
  for (const route of [
    { name: 'return-to-stage', body: { stage: 'implementation', reason: 'fix both jobs' } },
    { name: 'rework', body: { stage: 'implementation', instructions: 'start over' } },
  ]) {
    it(`carries ${route.name}’s attach_gate_feedback to the command and the audit row (WP-152)`, async () => {
      const parked = await escalatedWorld();
      parked.role = 'maintainer';
      const path = `/api/tasks/${TASK}/${route.name}`;
      const unticked = await post(
        parked,
        path,
        { ...route.body, attach_gate_feedback: false },
        `${route.name}-attach-1`,
      );
      expect(unticked.status, JSON.stringify(unticked.body)).toBe(200);
      expect(parked.calls[0]?.input).toMatchObject({ attachGateFeedback: false });
      expect(parked.actions[0]?.params).toMatchObject({ attach_gate_feedback: false });

      await post(parked, path, route.body, `${route.name}-attach-2`);
      expect(parked.calls[1]?.input).not.toHaveProperty('attachGateFeedback');
      expect(parked.actions[1]?.params).not.toHaveProperty('attach_gate_feedback');
    });
  }

  it('answers 409 no_gate_feedback for an attach with nothing behind it, and audits nothing (WP-152)', async () => {
    const parked = await escalatedWorld();
    parked.throws = new NoGateFeedbackError(
      'ready_for_merge' as never,
      'the task is ready_for_merge at "ready_for_merge", which is not a gate it was parked at',
    );
    const reply = await post(
      parked,
      `/api/tasks/${TASK}/return-to-stage`,
      { stage: 'implementation', reason: 'go back', attach_gate_feedback: true },
      'return-no-gate-1',
    );
    expect(`${reply.status} ${reply.body.error?.code ?? ''}`).toBe('409 no_gate_feedback');
    expect(reply.body.error?.message).toContain('no gate failure to attach');
    expect(parked.actions).toEqual([]);
  });

  it('answers 409 task_merged for a merged task sent before its merge, and audits nothing (WP-152)', async () => {
    const parked = await escalatedWorld();
    parked.throws = new TaskMergedError('needs_human', 'implementation');
    const reply = await post(
      parked,
      `/api/tasks/${TASK}/hand-back`,
      { stage: 'implementation', summary: 'one more change' },
      'hand-back-merged-1',
    );
    expect(`${reply.status} ${reply.body.error?.code ?? ''}`).toBe('409 task_merged');
    expect(reply.body.error?.message).toContain('a merged task never goes back to work');
    expect(parked.actions).toEqual([]);
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
      error: new StageNotInTemplateError('deployment' as never, 'feature' as never, [
        'refinement' as never,
      ]),
      status: 409,
      code: 'stage_not_in_template',
    },
    {
      // PROGRESS backlog 483: a return goes to a stage the task has run, at or before its own.
      error: new StageNotReachedError('code_review' as never, 'ci_gate' as never),
      status: 409,
      code: 'stage_not_reached',
    },
    {
      // WP-152: a merged task never goes back to work — named, though it is an illegal transition.
      error: new TaskMergedError('needs_human', 'implementation'),
      status: 409,
      code: 'task_merged',
    },
    {
      // WP-152: a ticked box with nothing behind it.
      error: new NoGateFeedbackError('refinement' as never, 'not a gate'),
      status: 409,
      code: 'no_gate_feedback',
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
    {
      error: new SteerWindowClosedError(),
      status: 429,
      code: 'rate_limited',
    },
    {
      // WP-131 review round 1: a task's cap is only ever raised.
      error: new TaskBudgetNotRaisedError(40, 50),
      status: 409,
      code: 'budget_not_raised',
    },
    {
      // WP-131 review round 2: …and only for a task its own cap paused.
      error: new TaskNotPausedByItsCapError(TASK as never, 'paused', 'project'),
      status: 409,
      code: 'not_paused_by_task_cap',
    },
    {
      // WP-159 ruling (b): a retry's model nobody chose on purpose.
      error: new ModelNotListedError('claude-opsu-5'),
      status: 409,
      code: 'model_not_listed',
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

/**
 * WP-131 review round 1 — the raise, through the real router: the answer, the audit row naming the
 * cap it replaced, the replay that performs nothing, and the refusal that writes nothing. The
 * enumerated cases above already hold its 401, its 403 at `member` and its key policy.
 */
describe('raising a task’s cap (WP-131)', () => {
  it('raises once, audits the cap it replaced, and performs nothing on a replay', async () => {
    world.role = 'maintainer';
    const first = await post(world, `/api/tasks/${TASK}/budget`, { cap_usd: 80 }, 'raise-1');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.performed).toBe(true);
    expect(world.calls.filter((call) => call.name === 'task-budget')).toEqual([
      { name: 'task-budget', input: { taskId: TASK, userId: world.userId, capUsd: 80 } },
    ]);
    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]).toMatchObject({
      action: 'task.budget.raise',
      taskId: TASK,
      params: { task_id: TASK, cap_usd: 80, before_cap_usd: 50, idempotency_key: 'raise-1' },
    });

    const replay = await post(world, `/api/tasks/${TASK}/budget`, { cap_usd: 80 }, 'raise-1');
    expect(replay.status).toBe(200);
    expect(replay.body.performed).toBe(false);
    expect(world.calls.filter((call) => call.name === 'task-budget')).toHaveLength(1);
    expect(world.actions).toHaveLength(1);
  });

  it('answers 409 budget_not_raised for a figure not above the cap, and audits nothing', async () => {
    world.role = 'maintainer';
    world.throws = new TaskBudgetNotRaisedError(50, 50);
    const reply = await post(world, `/api/tasks/${TASK}/budget`, { cap_usd: 50 }, 'raise-2');
    expect(reply.status).toBe(409);
    expect(reply.body.error?.code).toBe('budget_not_raised');
    expect(world.actions).toEqual([]);
  });

  /**
   * WP-131 review round 2 (canary (a) survived round 1): the capability is asked **in the task's
   * project**. A member of the organisation who maintains a *different* project is refused here, and
   * the same person maintaining *this* project is admitted — both sides, so a route that dropped the
   * project scope (asking the organisation role alone) fails the second half.
   */
  it('refuses a maintainer of another project, and admits a maintainer of this one', async () => {
    const OTHER = '00000000-0000-4000-8000-00000000f0f0';
    let maintains = OTHER;
    await world.app.close();
    world = await build({
      projectRole: async (projectId) => (projectId === maintains ? 'maintainer' : null),
    });
    world.role = 'member';
    const refused = await post(world, `/api/tasks/${TASK}/budget`, { cap_usd: 80 }, 'raise-o1');
    expect(refused.status).toBe(403);
    expect(world.calls).toEqual([]);
    maintains = PROJECT;
    const admitted = await post(world, `/api/tasks/${TASK}/budget`, { cap_usd: 80 }, 'raise-o2');
    expect(admitted.status, JSON.stringify(admitted.body)).toBe(200);
    expect(world.calls.map((call) => call.name)).toEqual(['task-budget']);
  });

  /**
   * WP-131 review round 2: `numeric(12,6)` — a figure past its range is a 400 rather than a database
   * overflow, and a figure with more than six decimals is refused rather than stored as the same cap
   * and audited as a raise that did not happen.
   */
  it.each([
    { cap_usd: 1_000_000, why: 'past numeric(12,6)' },
    { cap_usd: 50.0000001, why: 'more than six decimals' },
  ])('refuses $cap_usd ($why) at the contract, before the command runs', async ({ cap_usd }) => {
    world.role = 'maintainer';
    const reply = await post(world, `/api/tasks/${TASK}/budget`, { cap_usd }, `raise-${cap_usd}`);
    expect(reply.status).toBe(400);
    expect(world.calls).toEqual([]);
  });

  it('accepts the largest figure the column holds, at six decimals', async () => {
    world.role = 'maintainer';
    const reply = await post(
      world,
      `/api/tasks/${TASK}/budget`,
      { cap_usd: 999_999.999999 },
      'raise-max',
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  });

  it('refuses a cap of zero or below at the contract, before the command runs', async () => {
    world.role = 'maintainer';
    const reply = await post(world, `/api/tasks/${TASK}/budget`, { cap_usd: 0 }, 'raise-3');
    expect(reply.status).toBe(400);
    expect(world.calls).toEqual([]);
  });
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
    // The reason is **not** echoed back: a person who just typed it does not need it read out.
    expect(JSON.stringify(reply.body)).not.toContain('stepping in');
  });

  /**
   * The two commands whose free text has nowhere but the audit row (WP-27's fix round).
   *
   * `/pause`'s description has claimed since WP-15i that *"`reason` is recorded in the audit row"*
   * beside a `params: () => ({})` that recorded nothing, and `/take-over` accepted a `reason`
   * through a strict schema and dropped it on the floor. Both now carry what the **command**
   * returned — which is the redacted text, because this file has no redactor and a route that
   * wrote an unredacted sentence into an audit row would be TD-012's problem (module note).
   */
  it('records a pause’s reason in the audit row, exactly as the command redacted it', async () => {
    world.result = { reason: 'stepping in before glpat-[REDACTED:token] leaks' };
    await post(world, `/api/tasks/${TASK}/pause`, {
      reason: 'stepping in before glpat-FAKE-planted-credential leaks',
    });

    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]?.params).toMatchObject({
      task_id: TASK,
      reason: 'stepping in before glpat-[REDACTED:token] leaks',
    });
    // The **body's** copy never reaches the row: what is written is what came back, so a command
    // that stopped redacting could not be laundered past by this route.
    expect(JSON.stringify(world.actions)).not.toContain('FAKE-planted-credential');
  });

  it('writes no `reason` key at all for a pause that carried none', async () => {
    await post(world, `/api/tasks/${TASK}/pause`, {});
    expect(world.actions[0]?.params).toEqual({ task_id: TASK });
  });

  it('records a take-over’s reason beside its branch, and passes it to the command', async () => {
    world.result = {
      taskId: TASK,
      branch: 'agentic/ACME-1',
      sessionId: null,
      exported: false,
      reason: 'taking it from here',
    };
    await post(world, `/api/tasks/${TASK}/take-over`, { reason: 'taking it from here' });

    expect(world.calls[0]?.input).toMatchObject({ reason: 'taking it from here' });
    expect(world.actions[0]?.params).toMatchObject({
      task_id: TASK,
      tarball: false,
      branch: 'agentic/ACME-1',
      reason: 'taking it from here',
    });
  });

  it('answers a cancel that recorded a stop 202 with its command, and a replay the same (WP-101)', async () => {
    const reply = await post(world, `/api/runs/${RUN}/cancel`, {}, 'cancel-live');
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    expect(reply.body).toEqual({
      run_id: RUN,
      task_id: TASK,
      status: 'completed',
      task_state: 'active',
      performed: true,
      command_id: '00000000-0000-4000-8000-0000000000c1',
    });
    // The key reaches the command, which derives the stop's id from it.
    expect(world.calls[0]?.input).toMatchObject({ idempotencyKey: 'cancel-live' });
    expect(world.actions[0]?.params).toMatchObject({
      command_id: '00000000-0000-4000-8000-0000000000c1',
    });
    const replay = await post(world, `/api/runs/${RUN}/cancel`, {}, 'cancel-live');
    expect(`${replay.status} ${String(replay.body.performed)}`).toBe('202 false');
    expect(replay.body.command_id).toBe('00000000-0000-4000-8000-0000000000c1');
    expect(world.calls).toHaveLength(1);
  });

  it('answers a cancel that ended the record in place 200 with no command, and a replay the same (WP-101)', async () => {
    world.result = { taskId: TASK, commandId: null };
    const reply = await post(world, `/api/runs/${RUN}/cancel`, {}, 'cancel-in-place');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toEqual({
      run_id: RUN,
      task_id: TASK,
      status: 'completed',
      task_state: 'active',
      performed: true,
      command_id: null,
    });
    const replay = await post(world, `/api/runs/${RUN}/cancel`, {}, 'cancel-in-place');
    expect(`${replay.status} ${String(replay.body.performed)}`).toBe('200 false');
    expect(replay.body.command_id).toBeNull();
    // No key, no derived id: the command is told so rather than handed an empty string.
    await post(world, `/api/runs/${RUN}/cancel`, {});
    expect(world.calls.map((call) => call.input.idempotencyKey)).toEqual(['cancel-in-place', null]);
  });

  it('answers a retry-stage with the attempt it entered and the run it stopped, and a replay the same (backlog 494)', async () => {
    world.result = {
      attempt: 3,
      stoppedRun: { runId: RUN, commandId: '00000000-0000-4000-8000-0000000000c2' },
    };
    const path = `/api/tasks/${TASK}/retry-stage`;
    const reply = await post(world, path, { stage: 'refinement' }, 'retry-live');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toEqual({
      task_id: TASK,
      state: 'active',
      current_stage: 'refinement',
      performed: true,
      attempt: 3,
      stopped_run: { run_id: RUN, command_id: '00000000-0000-4000-8000-0000000000c2' },
    });
    // The key reaches the command, which derives the stop's id from it, as the run cancel's does.
    expect(world.calls[0]?.input).toMatchObject({ idempotencyKey: 'retry-live' });
    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]?.params).toMatchObject({
      stage: 'refinement',
      attempt: 3,
      stopped_run_id: RUN,
      stop_command_id: '00000000-0000-4000-8000-0000000000c2',
    });
    const replay = await post(world, path, { stage: 'refinement' }, 'retry-live');
    expect(`${replay.status} ${String(replay.body.performed)}`).toBe('200 false');
    expect(replay.body.attempt).toBe(3);
    expect(replay.body.stopped_run).toEqual({
      run_id: RUN,
      command_id: '00000000-0000-4000-8000-0000000000c2',
    });
    expect(world.calls).toHaveLength(1);
  });

  it('answers a retry-stage that stopped nothing, and one at Ready that entered nothing (backlog 494)', async () => {
    const path = `/api/tasks/${TASK}/retry-stage`;
    world.result = { attempt: 2, stoppedRun: null };
    const plain = await post(world, path, { stage: 'refinement' }, 'retry-plain');
    expect(plain.body).toMatchObject({ performed: true, attempt: 2, stopped_run: null });
    world.result = { attempt: null, stoppedRun: null };
    const ready = await post(world, path, { stage: 'refinement' }, 'retry-ready');
    expect(ready.body).toMatchObject({ performed: true, attempt: null, stopped_run: null });
    const replayed = await post(world, path, { stage: 'refinement' }, 'retry-ready');
    expect(replayed.body).toMatchObject({ performed: false, attempt: null, stopped_run: null });
  });

  it('gives the key back when the command refuses, and performs a retry of it', async () => {
    // WP-67 review round 1, the releasing direction: a throw from the command itself.
    world.throws = new IllegalTransitionError('Task', 'active', 'waiting_answers');
    const refused = await post(
      world,
      `/api/tasks/${TASK}/feedback`,
      { scope: 'task', text: 'thin' },
      'fb-refused',
    );
    expect(refused.status).toBe(409);
    const retried = await post(
      world,
      `/api/tasks/${TASK}/feedback`,
      { scope: 'task', text: 'thin' },
      'fb-refused',
    );
    expect(retried.status).toBe(200);
    expect(retried.body.performed).toBe(true);
    expect(world.calls.filter((call) => call.name === 'feedback')).toHaveLength(2);
  });

  it('never performs again when the audit row fails after the command performed', async () => {
    // WP-67 review round 1, the other direction: the effect committed and the audit insert did
    // not. The key stays claimed, so the retry is answered in flight rather than performed twice.
    let refuseAudit = true;
    const failing = await build({
      recordAction: async () => {
        if (refuseAudit) {
          refuseAudit = false;
          throw new Error('the audit insert was refused');
        }
      },
    });
    const first = await post(
      failing,
      `/api/tasks/${TASK}/feedback`,
      { scope: 'task', text: 'thin' },
      'fb-audit',
    );
    expect(first.status).toBe(500);
    const retried = await post(
      failing,
      `/api/tasks/${TASK}/feedback`,
      { scope: 'task', text: 'thin' },
      'fb-audit',
    );
    expect(`${retried.status} ${retried.body.error?.code}`).toBe('409 idempotency_key_in_flight');
    expect(failing.calls.filter((call) => call.name === 'feedback')).toHaveLength(1);
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

  it('answers a take-over with the branch, the resume commands and how the export went', async () => {
    // The whole reason this command has a response of its own (product/10, `endpoints.ts`'s note):
    // an operator told only that the pipeline stopped has the cost and not what it bought.
    const reply = await post(world, `/api/tasks/${TASK}/take-over`, { tarball: true });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({
      task_id: TASK,
      state: 'active',
      branch: 'agentic/ACME-1',
      session_id: 'session-abc',
      resume_commands: ['git fetch && git checkout agentic/ACME-1', 'claude --resume session-abc'],
      workspace_export: 'requested',
      performed: true,
    });
    // The audit records the shape — the branch and whether an export was asked for — and no
    // `reason` key, because this caller sent none (the case below sends one).
    expect(world.actions[0]?.params).toMatchObject({
      task_id: TASK,
      tarball: true,
      branch: 'agentic/ACME-1',
      exported: true,
      // WP-85: the run whose stop was recorded, found in the database rather than this process.
      run_id: RUN,
    });
    expect(world.actions[0]?.params).not.toHaveProperty('reason');
  });

  it('answers a take-over of a task with no live run without inventing a resume command', async () => {
    world.result = {
      taskId: TASK,
      branch: 'agentic/ACME-1',
      sessionId: null,
      exported: false,
      runId: null,
      reason: null,
    };
    const reply = await post(world, `/api/tasks/${TASK}/take-over`, {});
    expect(reply.body.session_id).toBeNull();
    expect(reply.body.resume_commands).toEqual(['git fetch && git checkout agentic/ACME-1']);
    expect(reply.body.workspace_export).toBe('no_live_run');
  });

  it('answers a replayed take-over from the branch the first attempt recorded', async () => {
    const first = await post(world, `/api/tasks/${TASK}/take-over`, {}, 'take-over-once');
    expect(first.body.performed).toBe(true);
    const replay = await post(world, `/api/tasks/${TASK}/take-over`, {}, 'take-over-once');
    expect(replay.status).toBe(200);
    expect(replay.body.performed).toBe(false);
    // The branch comes from the audit row; the session does **not**, because a run that has ended
    // cannot be resumed and answering the old id would be a guess (standing rule 18).
    expect(replay.body.branch).toBe('agentic/ACME-1');
    expect(replay.body.session_id).toBeNull();
    expect(replay.body.workspace_export).toBe('no_live_run');
  });

  it('answers a steer 202 with the recorded command, and a replay with the same one (WP-85)', async () => {
    const first = await post(world, `/api/runs/${RUN}/steer`, { message: 'hello' }, 'steer-c1');
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(first.body).toMatchObject({
      run_id: RUN,
      command_id: '00000000-0000-4000-8000-0000000000c1',
      performed: true,
    });
    // The key reaches the command: the recorded row's id is derived from it (migration 0060).
    expect(world.calls[0]?.input).toMatchObject({ idempotencyKey: 'steer-c1' });
    expect(world.actions[0]?.params).toMatchObject({
      command_id: '00000000-0000-4000-8000-0000000000c1',
    });

    const replay = await post(world, `/api/runs/${RUN}/steer`, { message: 'hello' }, 'steer-c1');
    expect(`${replay.status} ${String(replay.body.performed)}`).toBe('202 false');
    // From the audit row the first attempt wrote, never a placeholder.
    expect(replay.body.command_id).toBe('00000000-0000-4000-8000-0000000000c1');
    expect(world.calls).toHaveLength(1);
  });

  it('passes a take-over’s key to the command, and none when the caller sent none', async () => {
    await post(world, `/api/tasks/${TASK}/take-over`, {}, 'take-over-key');
    await post(world, `/api/tasks/${TASK}/take-over`, {});
    expect(world.calls.map((call) => call.input.idempotencyKey)).toEqual(['take-over-key', null]);
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
    // WP-159: the deliberate way past the model list reaches the command, by name.
    await post(
      world,
      `/api/runs/${RUN}/retry`,
      { model: 'claude-next-fake', allow_unlisted_model: true },
      'm-3',
    );
    expect(world.calls[2]?.input).toEqual({
      runId: RUN,
      userId: USER,
      model: 'claude-next-fake',
      allowUnlistedModel: true,
    });
  });

  it('answers a retry on an unlisted model 409 model_not_listed and audits nothing (WP-159)', async () => {
    world.throws = new ModelNotListedError('claude-opsu-5');
    const reply = await post(world, `/api/runs/${RUN}/retry`, { model: 'claude-opsu-5' }, 'typo');
    expect(reply.status).toBe(409);
    expect(reply.body.error?.code).toBe('model_not_listed');
    expect(reply.body.error?.message).toContain('"claude-opsu-5"');
    expect(world.actions).toEqual([]);
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
    // …and the reason is **not** audited, unlike a pause's: this one has a home of its own —
    // `approvals.reason` and the `task.approval.decided` payload — so a copy in the audit row
    // would be a second place to keep right (module note).
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
        ...memoryAttemptRecords(new Map()),
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
