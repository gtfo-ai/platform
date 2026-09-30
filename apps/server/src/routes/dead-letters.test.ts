/**
 * The dead-letter pair, driven through Fastify against plain functions (WP-95, PROGRESS backlog
 * 126).
 *
 * `test/integration/events/dead-letter-requeue.integration.test.ts` drives the re-queue against a
 * real PostgreSQL and a real dispatcher and asserts criterion 2 — dispatched once, the original row
 * left. What this file owns is what the route decides: the admin gate on both methods, the error's
 * redaction and bound, the cursor, which refusal maps to which status, the `Idempotency-Key`
 * policy, and that **exactly one** `human_actions` row is written per accepted re-queue and none for
 * a refused one.
 */
import type {
  DeadLetterCommands,
  DeadLetterPageRequest,
  DeadLetterRow,
} from '@platform/application';
import { DeadLetterRequeueRefusedError } from '@platform/application';
import type { Id, JsonObject, UserRole } from '@platform/contracts';
import { MAX_DEAD_LETTER_ERROR_CHARS } from '@platform/contracts';
import { redaction } from '@platform/infrastructure';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { parseDeadLetterCursor, REQUEUE_ACTION, registerDeadLetterRoutes } from './dead-letters.js';
import { memoryAttemptRecords } from './idempotency-memory.js';

const USER = '00000000-0000-4000-8000-000000000e01';
const TASK = '00000000-0000-4000-8000-000000000e02' as Id;
/** Obviously fake, and in the shape the platform's patterns catch. */
const FAKE_TOKEN = 'glpat-FAKE000000000000000';

const row = (overrides: Partial<DeadLetterRow> = {}): DeadLetterRow => ({
  position: 900,
  eventType: 'task.stage.completed',
  streamType: 'task',
  streamId: TASK,
  occurredAt: '2026-09-29T08:00:00.000Z',
  deadLetteredAt: '2026-09-29T08:20:00.000Z',
  handler: 'pipeline.saga',
  attempts: 10,
  error: `provider answered 403 for token ${FAKE_TOKEN}`,
  task: { id: TASK, ticketKey: 'ACME-7', projectKey: 'acme' },
  ...overrides,
});

interface World {
  role: UserRole;
  signedIn: boolean;
  rows: DeadLetterRow[];
  total: number;
  requeue: (position: number) => ReturnType<DeadLetterCommands['requeue']>;
}

let app: FastifyInstance;
let world: World;
let listed: DeadLetterPageRequest[];
let requeued: number[];
let actions: { action: string; params: JsonObject; taskId: string | null }[];
let attempts: Map<string, { bodyDigest: string | null; params: JsonObject }>;

const build = async (composed = true): Promise<void> => {
  listed = [];
  requeued = [];
  actions = [];
  attempts = new Map();
  world = {
    role: 'admin',
    signedIn: true,
    rows: [row()],
    total: 1,
    requeue: async () => ({ row: row(), requeuedAt: '2026-09-30T09:00:00.000Z' }),
  };
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
        email: 'operator@example.test',
        name: 'Operator',
        role: world.role,
        sessionId: 'session-1',
      };
    }
  });
  await registerDeadLetterRoutes(app, {
    commands: composed
      ? {
          list: async (request) => {
            listed.push(request);
            return { items: world.rows, total: world.total };
          },
          requeue: async (position) => {
            requeued.push(position);
            return world.requeue(position);
          },
        }
      : null,
    records: {
      ...memoryAttemptRecords(attempts),
      recordAction: async (input) => {
        actions.push({ action: input.action, params: input.params, taskId: input.taskId ?? null });
        const key = input.params.idempotency_key;
        const digest = input.params.body_digest;
        if (typeof key === 'string') {
          attempts.set(`${input.userId}|${input.action}|${key}`, {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
    },
    projectRole: async () => null,
    redactor: redaction.patternRedactor(),
  });
  await app.ready();
};

beforeEach(async () => build());

const list = (query = '') => app.inject({ method: 'GET', url: `/api/org/dead-letters${query}` });
const requeue = (position: number | string = 900, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: `/api/org/dead-letters/${position}/requeue`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: '{}',
  });
const codeOf = (raw: string): string =>
  (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? '';

describe('the admin gate', () => {
  it.each(['viewer', 'member', 'maintainer'] as const)(
    'refuses a %s on both methods and performs nothing',
    async (role) => {
      world.role = role;
      expect((await list()).statusCode).toBe(403);
      expect((await requeue()).statusCode).toBe(403);
      expect(listed).toEqual([]);
      expect(requeued).toEqual([]);
      expect(actions).toEqual([]);
    },
  );

  it('refuses an anonymous caller 401 on both methods, before validating anything', async () => {
    world.signedIn = false;
    expect((await list('?cursor=not-a-number')).statusCode).toBe(401);
    expect((await requeue('not-a-position')).statusCode).toBe(401);
  });
});

describe('GET /api/org/dead-letters', () => {
  it('publishes each row with its error redacted, and the total beside the page', async () => {
    const response = await list();
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      items: { error: string; error_truncated: boolean; task: unknown; handler: string }[];
      total: number;
      next_cursor: string | null;
    };
    expect(body.total).toBe(1);
    expect(body.next_cursor).toBeNull();
    expect(body.items[0]?.handler).toBe('pipeline.saga');
    expect(body.items[0]?.error).toContain('provider answered 403');
    expect(body.items[0]?.error).not.toContain(FAKE_TOKEN);
    expect(body.items[0]?.error_truncated).toBe(false);
    expect(body.items[0]?.task).toEqual({ id: TASK, ticket_key: 'ACME-7', project_key: 'acme' });
  });

  it('bounds the error after redacting it, and says the bound cut it', async () => {
    world.rows = [row({ error: `${FAKE_TOKEN} ${'x'.repeat(MAX_DEAD_LETTER_ERROR_CHARS * 2)}` })];
    const body = JSON.parse((await list()).body) as {
      items: { error: string; error_truncated: boolean }[];
    };
    expect(body.items[0]?.error).toHaveLength(MAX_DEAD_LETTER_ERROR_CHARS);
    expect(body.items[0]?.error).not.toContain('glpat-');
    expect(body.items[0]?.error_truncated).toBe(true);
  });

  it('asks for one more than the page and hands out the last position as the cursor', async () => {
    world.rows = [row({ position: 905 }), row({ position: 903 }), row({ position: 901 })];
    world.total = 3;
    const body = JSON.parse((await list('?limit=2')).body) as {
      items: { position: number }[];
      next_cursor: string | null;
    };
    expect(listed).toEqual([{ limit: 3 }]);
    expect(body.items.map((item) => item.position)).toEqual([905, 903]);
    expect(body.next_cursor).toBe('903');
    await list('?limit=2&cursor=903');
    expect(listed.at(-1)).toEqual({ limit: 3, beforePosition: 903 });
  });

  it('refuses a cursor it did not hand out as a client error', async () => {
    const response = await list('?cursor=abc');
    expect(response.statusCode).toBe(400);
    expect(codeOf(response.body)).toBe('invalid_cursor');
    expect(() => parseDeadLetterCursor('0')).toThrow();
    expect(parseDeadLetterCursor('903')).toBe(903);
  });

  it('answers 503 by name on a process that composed no eventing', async () => {
    await build(false);
    const response = await list();
    expect(response.statusCode).toBe(503);
    expect(codeOf(response.body)).toBe('dead_letters_unavailable');
  });
});

describe('POST /api/org/dead-letters/:position/requeue', () => {
  it('re-queues and writes exactly one human action naming the event and its task', async () => {
    const response = await requeue(900, { 'idempotency-key': 'requeue-1' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      position: 900,
      performed: true,
      requeued_at: '2026-09-30T09:00:00.000Z',
    });
    expect(requeued).toEqual([900]);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: REQUEUE_ACTION,
      taskId: TASK,
      params: {
        position: 900,
        event_type: 'task.stage.completed',
        handler: 'pipeline.saga',
        attempts: 10,
        requeued_at: '2026-09-30T09:00:00.000Z',
        idempotency_key: 'requeue-1',
      },
    });
    // The audit row names the event, never the handler's words.
    expect(JSON.stringify(actions[0]?.params)).not.toContain('provider answered');
  });

  it('writes a null task for an event that names none', async () => {
    world.requeue = async () => ({
      row: row({ task: null, streamType: 'project' }),
      requeuedAt: '2026-09-30T09:00:00.000Z',
    });
    await requeue();
    expect(actions[0]?.taskId).toBeNull();
  });

  it('answers a replay from the first attempt and performs nothing twice', async () => {
    await requeue(900, { 'idempotency-key': 'requeue-2' });
    const replay = await requeue(900, { 'idempotency-key': 'requeue-2' });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body)).toEqual({
      position: 900,
      performed: false,
      requeued_at: '2026-09-30T09:00:00.000Z',
    });
    expect(requeued).toEqual([900]);
    expect(actions).toHaveLength(1);
  });

  it('refuses another position under a used key', async () => {
    await requeue(900, { 'idempotency-key': 'requeue-3' });
    const other = await requeue(901, { 'idempotency-key': 'requeue-3' });
    expect(other.statusCode).toBe(409);
    expect(codeOf(other.body)).toBe('idempotency_key_reused');
    expect(requeued).toEqual([900]);
  });

  it.each([
    ['not_dead_lettered', 409, 'event_not_dead_lettered'],
    ['already_dispatched', 409, 'event_already_dispatched'],
    ['unknown_event', 404, 'not_found'],
  ] as const)(
    'maps a %s refusal to %i %s, writes no audit row, and frees the key',
    async (refusal, status, code) => {
      world.requeue = async (position) => {
        throw new DeadLetterRequeueRefusedError(position, refusal);
      };
      const refused = await requeue(900, { 'idempotency-key': 'requeue-4' });
      expect(refused.statusCode).toBe(status);
      expect(codeOf(refused.body)).toBe(code);
      expect(actions).toEqual([]);
      // The key was released: the same request is a first attempt again, not a replay.
      world.requeue = async () => ({ row: row(), requeuedAt: '2026-09-30T09:05:00.000Z' });
      const retried = await requeue(900, { 'idempotency-key': 'requeue-4' });
      expect(retried.statusCode).toBe(200);
      expect(actions).toHaveLength(1);
    },
  );

  it('refuses a position that is not a positive integer', async () => {
    expect((await requeue('abc')).statusCode).toBe(400);
    expect((await requeue(0)).statusCode).toBe(400);
    expect(requeued).toEqual([]);
  });
});
