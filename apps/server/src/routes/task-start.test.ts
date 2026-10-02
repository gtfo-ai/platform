/**
 * `POST /api/projects/:project_id/tasks` — product/04's manual Start (WP-122, criterion 1), driven
 * through Fastify with the real guard, the real key policy and the real refusal mapping, against a
 * plain-function command.
 *
 * **What this tier cannot see**, stated rather than implied: that the match becomes a task. The
 * command is a stub here; the application tier drives `startTicketManually` through the whole
 * in-memory pipeline (`packages/application/src/pipeline/manual-start.test.ts` — intake creates the
 * task, and above the WIP limit queues it as a rule match does), and the e2e tier drives the route
 * on a real instance until the task reaches refinement (`test/e2e/server/manual-start.e2e.test.ts`).
 */
import {
  MANUAL_START_ACTION,
  type ManualStartRecord,
  ManualStartRefusedError,
  StreamConflictError,
} from '@platform/application';
import type { Id, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { manualStartAuditParams, type TaskStartCommands } from '../task-start.js';
import { type MemoryAttempt, memoryAttemptRecords } from './idempotency-memory.js';
import { MANUAL_START_REFUSALS, registerTaskStartRoutes } from './task-start.js';

const PROJECT = '00000000-0000-4000-8000-000000000b01';
const USER = '00000000-0000-4000-8000-000000000b02';
const EVENT = '00000000-0000-4000-8000-000000000b03';
const TASK = '00000000-0000-4000-8000-000000000b04';

interface World {
  role: UserRole | null;
  signedIn: boolean;
  projectExists: boolean;
  throws: Error | null;
}

let app: FastifyInstance;
let world: World;
let calls: { projectId: string; ticketKey: string; userId: string; key: string }[];
let audits: Record<string, unknown>[];
let attempts: Map<string, MemoryAttempt>;

const started = (key: string): ManualStartRecord => ({
  eventId: EVENT as Id,
  ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
});

const build = async (): Promise<void> => {
  calls = [];
  audits = [];
  attempts = new Map();
  world = { role: 'member', signedIn: true, projectExists: true, throws: null };

  app = fastify();
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
        email: 'member@example.test',
        name: 'Member',
        // The organisation role is a viewer, so every capability below is the project role's.
        role: 'viewer',
        sessionId: 'session-1',
      };
    }
  });

  const commands: TaskStartCommands = {
    start: async (input) => {
      calls.push({
        projectId: input.projectId,
        ticketKey: input.ticketKey,
        userId: input.userId,
        key: input.audit.key,
      });
      if (world.throws !== null) {
        throw world.throws;
      }
      const record = started(input.ticketKey);
      // The production command writes this row in the match's transaction; the double writes it
      // where the claim records read it, so a replay meets a performed key.
      const params = manualStartAuditParams({
        projectId: input.projectId,
        started: record,
        key: input.audit.key,
        digest: input.audit.digest,
      });
      audits.push(params);
      attempts.set(`${input.userId}|${MANUAL_START_ACTION}|${input.audit.key}`, {
        bodyDigest: input.audit.digest,
        params,
      });
      return record;
    },
  };

  await registerTaskStartRoutes(app, {
    commands,
    queries: {
      projectRole: async () => world.role,
      projectExists: async () => world.projectExists,
      ...memoryAttemptRecords(attempts),
    },
  });
  await app.ready();
};

beforeEach(build);

const post = (body: unknown, headers: Record<string, string> = {}, target = app) =>
  target.inject({
    method: 'POST',
    url: `/api/projects/${PROJECT}/tasks`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });

const verdict = (response: { statusCode: number; body: string }): string =>
  `${response.statusCode} ${(JSON.parse(response.body) as { error?: { code?: string } }).error?.code ?? ''}`.trim();

describe('POST /api/projects/:project_id/tasks (WP-122)', () => {
  it('records the match and answers 202 naming it, with one audit row', async () => {
    const response = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({
      performed: true,
      event_id: EVENT,
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-7',
        url: 'https://jira.example.test/browse/ACME-7',
      },
    });
    expect(calls).toEqual([
      { projectId: PROJECT, ticketKey: 'ACME-7', userId: USER, key: 'start-1' },
    ]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      project_id: PROJECT,
      event_id: EVENT,
      idempotency_key: 'start-1',
    });
  });

  it('refuses an anonymous caller before validating the body', async () => {
    world.signedIn = false;
    const response = await post({ nonsense: true });
    expect(verdict(response)).toBe('401 unauthenticated');
    expect(calls).toHaveLength(0);
  });

  it('refuses a viewer of the project, and admits a member (task.create)', async () => {
    world.role = 'viewer';
    const refused = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
    expect(verdict(refused)).toBe('403 forbidden');
    expect(calls).toHaveLength(0);
    world.role = 'member';
    const admitted = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
    expect(admitted.statusCode).toBe(202);
  });

  it('requires an Idempotency-Key, because a repeat would record a second match', async () => {
    const response = await post({ ticket_key: 'ACME-7' });
    expect(verdict(response)).toBe('400 idempotency_key_required');
    expect(calls).toHaveLength(0);
  });

  it('refuses a key outside the ticket-key character set, and any field but the key', async () => {
    for (const body of [
      { ticket_key: '../ACME-7' },
      { ticket_key: 'ACME 7' },
      { ticket_key: 'ACME-7', template: 'bug' },
    ]) {
      const response = await post(body, { 'idempotency-key': 'start-1' });
      expect(verdict(response), JSON.stringify(body)).toBe('400 invalid_request');
    }
    expect(calls).toHaveLength(0);
  });

  it('answers a replay from the first attempt and performs nothing twice', async () => {
    await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
    const replay = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
    expect(replay.statusCode).toBe(202);
    expect(JSON.parse(replay.body)).toMatchObject({ performed: false, event_id: EVENT });
    expect(calls).toHaveLength(1);
    expect(audits).toHaveLength(1);

    const reused = await post({ ticket_key: 'ACME-8' }, { 'idempotency-key': 'start-1' });
    expect(verdict(reused)).toBe('409 idempotency_key_reused');
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['no_task_management', '409 no_task_management_binding'],
    ['not_picked_up', '409 project_does_not_pick_up_tickets'],
    ['task_exists', '409 ticket_has_task'],
    ['ticket_not_found', '404 ticket_not_found'],
    ['outside_binding_scope', '409 ticket_outside_binding_scope'],
    ['ticket_unreadable', '502 ticket_unreadable'],
  ] as const)(
    'answers the %s refusal as %s, records nothing and gives the key back',
    async (reason, expected) => {
      world.throws = new ManualStartRefusedError(
        reason,
        `refused: ${reason}`,
        reason === 'task_exists' ? (TASK as Id) : null,
      );
      const refused = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
      expect(verdict(refused)).toBe(expected);
      expect((JSON.parse(refused.body) as { error: { message: string } }).error.message).toBe(
        `refused: ${reason}`,
      );
      expect(audits).toHaveLength(0);
      // The key was released: the same request may be sent again and now performs.
      world.throws = null;
      const retried = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
      expect(retried.statusCode).toBe(202);
      expect(audits).toHaveLength(1);
    },
  );

  it('maps every refusal the command can raise', () => {
    // A reason added to the application without a status here is a 500; this holds the table whole.
    expect(Object.keys(MANUAL_START_REFUSALS).sort()).toEqual([
      'no_task_management',
      'not_picked_up',
      'outside_binding_scope',
      'task_exists',
      'ticket_not_found',
      'ticket_unreadable',
    ]);
  });

  it('answers four lost races on the project stream as the retryable contention 409', async () => {
    world.throws = new StreamConflictError('project', PROJECT, 3);
    const response = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
    expect(verdict(response)).toBe('409 project_stream_contended');
  });

  it('answers 404 for a project that does not exist, before reading anything', async () => {
    world.projectExists = false;
    const response = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' });
    expect(verdict(response)).toBe('404 not_found');
    expect(calls).toHaveLength(0);
  });

  it('answers 503 by name on a process that composed no command', async () => {
    const bare = fastify();
    bare.setValidatorCompiler(validatorCompiler);
    bare.setSerializerCompiler(serializerCompiler);
    bare.setErrorHandler(async (error, _request, reply) => {
      const mapped = toApiError(error, 'test-request');
      return reply.status(mapped.statusCode).send(mapped.body);
    });
    bare.addHook('onRequest', async (request) => {
      request.actor = {
        userId: USER,
        email: 'member@example.test',
        name: 'Member',
        role: 'member',
        sessionId: 'session-1',
      };
    });
    await registerTaskStartRoutes(bare, {
      commands: null,
      queries: {
        projectRole: async () => 'member',
        projectExists: async () => true,
        ...memoryAttemptRecords(new Map()),
      },
    });
    await bare.ready();
    const response = await post({ ticket_key: 'ACME-7' }, { 'idempotency-key': 'start-1' }, bare);
    expect(verdict(response)).toBe('503 task_start_unavailable');
    await bare.close();
  });
});
