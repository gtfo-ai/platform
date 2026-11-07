/**
 * `routes/me-identities.ts` through a real Fastify instance over plain functions (S-26.6): the
 * guards, the `Idempotency-Key` on the confirmation, the audit rows and every refusal's answer.
 *
 * The decisions behind the answers — what a comment proves, when a code is voided, what a
 * confirmation re-checks — are the application ring's and PostgreSQL's, and are driven there
 * (`identity/*.test.ts`, `test/integration/identity/identity-links.integration.test.ts`). This file
 * holds what the route itself decides.
 */
import type {
  LinkCodeIssue,
  LinkCodeState,
  LinkConfirmation,
  LinkThreadOutcome,
  LinkThreadTarget,
} from '@platform/application';
import { EMPTY_LINK_RECORD } from '@platform/application';
import type { Id, IsoDateTime, JsonObject, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { MyIdentityRow } from '../queries/identity-link-queries.js';
import { memoryAttemptRecords, scopeOf } from './idempotency-memory.js';
import { type IdentityLinkCommands, registerMeIdentityRoutes } from './me-identities.js';

const USER = '00000000-0000-4000-8000-0000000000a1';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const MATCH = '00000000-0000-4000-8000-0000000000c1';
const CODE_ID = '00000000-0000-4000-8000-0000000000d1';
const INTEGRATION = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-11-07T10:00:00.000Z');
const ISSUED_CODE = 'agentic-link-7K3Q9VDM2X';

interface World {
  app: FastifyInstance;
  orgRole: UserRole;
  projectRole: UserRole | null;
  signedIn: boolean;
  issue: LinkCodeIssue;
  confirm: LinkConfirmation;
  confirms: number;
  state: LinkCodeState;
  thread: LinkThreadTarget | null;
  read: LinkThreadOutcome | { kind: 'unavailable'; reason: string };
  reads: LinkThreadTarget[];
  mine: MyIdentityRow[];
  adoptions: { userId: string; provider: string; externalId: string }[];
  adopted: string[];
  adoptFails: boolean;
  actions: { userId: string; action: string; params: JsonObject }[];
}

const liveState = (overrides: Partial<NonNullable<LinkCodeState['code']>> = {}): LinkCodeState => ({
  code: {
    id: CODE_ID as Id,
    userId: USER as Id,
    codeHash: 'a'.repeat(64),
    createdAt: '2026-11-07T09:50:00.000Z' as IsoDateTime,
    expiresAt: '2026-11-07T10:20:00.000Z' as IsoDateTime,
    consumedAt: null,
    consumedMatchId: null,
    voidedAt: null,
    voidReason: null,
    ...overrides,
  },
  matches: [
    {
      id: MATCH as Id,
      codeId: CODE_ID as Id,
      integrationId: INTEGRATION as Id,
      provider: 'jira-cloud',
      externalId: '557058:dev-one',
      displayName: 'Dev One',
      commentId: '10105',
      createdAt: '2026-11-07T09:55:00.000Z' as IsoDateTime,
      confirmedAt: null,
      integrationName: 'Autix Jira',
    },
  ],
});

const build = async (): Promise<World> => {
  const performed = new Map<string, { bodyDigest: string | null; params: JsonObject }>();
  const records = memoryAttemptRecords(performed);
  const world = {
    orgRole: 'viewer',
    projectRole: 'member',
    signedIn: true,
    issue: {
      kind: 'issued',
      id: CODE_ID,
      code: ISSUED_CODE,
      expiresAt: '2026-11-07T10:30:00.000Z',
    },
    confirm: {
      kind: 'linked',
      matchId: MATCH,
      provider: 'jira-cloud',
      externalId: '557058:dev-one',
      displayName: 'Dev One',
      replayed: false,
    },
    confirms: 0,
    state: liveState(),
    thread: {
      kind: 'ticket',
      ticket: {
        provider: 'jira-cloud',
        key: 'AUT-1',
        url: 'https://acme.example.test/browse/AUT-1',
      },
    },
    read: { kind: 'read', comments: 3, claims: 1, recorded: { ...EMPTY_LINK_RECORD, matched: 1 } },
    reads: [],
    mine: [],
    adoptions: [],
    adopted: ['00000000-0000-4000-8000-0000000000f1'],
    adoptFails: false,
    actions: [],
  } as unknown as World;

  const commands: IdentityLinkCommands = {
    issue: async () => world.issue,
    confirm: async () => {
      world.confirms += 1;
      return world.confirm;
    },
    state: async () => world.state,
    adoptOwners: async (input, onAdopted) => {
      world.adoptions.push({ ...input });
      // The hook reports each task as its adoption commits; a failure comes after the first.
      for (const taskId of world.adopted) {
        onAdopted(taskId);
        if (world.adoptFails) {
          throw new Error('the task stream is contended');
        }
      }
      return world.adopted;
    },
    readThread: async (_projectId, target) => {
      world.reads.push(target);
      return world.read;
    },
  };

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
        email: 'dev@example.test',
        name: 'Dev',
        role: world.orgRole,
        sessionId: 'session-1',
      };
    }
  });
  await registerMeIdentityRoutes(app, {
    commands,
    now: () => NOW,
    queries: {
      ...records,
      projectRole: async () => world.projectRole,
      listMine: async () => world.mine,
      unlinkMine: async (input) => {
        const before = world.mine.length;
        world.mine = world.mine.filter(
          (row) => row.provider !== input.provider || row.external_id !== input.externalId,
        );
        return world.mine.length < before;
      },
      threadOf: async () => world.thread,
      recordAction: async (input) => {
        world.actions.push({ userId: input.userId, action: input.action, params: input.params });
        const key = input.params.idempotency_key;
        if (typeof key === 'string') {
          const query = { userId: input.userId, action: input.action, key };
          records.inFlight.delete(scopeOf(query));
          const digest = input.params.body_digest;
          performed.set(scopeOf(query), {
            bodyDigest: typeof digest === 'string' ? digest : null,
            params: input.params,
          });
        }
      },
    },
  });
  await app.ready();
  world.app = app;
  return world;
};

let world: World;

beforeEach(async () => {
  world = await build();
});

afterEach(async () => {
  await world.app.close();
});

describe('POST /api/me/identity-links', () => {
  it('answers the code once, not cached, and audits the issue without the code', async () => {
    const response = await world.app.inject({ method: 'POST', url: '/api/me/identity-links' });
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      id: CODE_ID,
      code: ISSUED_CODE,
      expires_at: '2026-11-07T10:30:00.000Z',
    });
    expect(world.actions).toEqual([
      {
        userId: USER,
        action: 'identity.link_code.issue',
        params: { code_id: CODE_ID, expires_at: '2026-11-07T10:30:00.000Z' },
      },
    ]);
    expect(JSON.stringify(world.actions)).not.toContain(ISSUED_CODE);
  });

  it('refuses a sixth code in the hour with 429 and Retry-After, and audits nothing', async () => {
    world.issue = { kind: 'rate_limited', retryAfterMs: 61_500 };
    const response = await world.app.inject({ method: 'POST', url: '/api/me/identity-links' });
    expect(response.statusCode).toBe(429);
    expect(response.json().error.code).toBe('link_code_rate_limited');
    expect(response.headers['retry-after']).toBe('62');
    expect(world.actions).toEqual([]);
  });

  it('is any signed-in user’s, and nobody else’s', async () => {
    world.signedIn = false;
    const response = await world.app.inject({ method: 'POST', url: '/api/me/identity-links' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/me/identity-links', () => {
  it('publishes the state and the matches, never the code', async () => {
    const response = await world.app.inject({ method: 'GET', url: '/api/me/identity-links' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.code).toEqual({
      id: CODE_ID,
      created_at: '2026-11-07T09:50:00.000Z',
      expires_at: '2026-11-07T10:20:00.000Z',
      status: 'live',
      void_reason: null,
    });
    expect(body.matches).toEqual([
      {
        id: MATCH,
        provider: 'jira-cloud',
        external_id: '557058:dev-one',
        display_name: 'Dev One',
        integration_id: INTEGRATION,
        integration_name: 'Autix Jira',
        matched_at: '2026-11-07T09:55:00.000Z',
        confirmed_at: null,
      },
    ]);
    expect(response.body).not.toContain('a'.repeat(64));
  });

  it.each([
    ['expired', { expiresAt: '2026-11-07T10:00:00.000Z' as IsoDateTime }, null],
    [
      'voided',
      { voidedAt: '2026-11-07T09:58:00.000Z' as IsoDateTime, voidReason: 'second_author' as const },
      'second_author',
    ],
    [
      'consumed',
      { consumedAt: '2026-11-07T09:59:00.000Z' as IsoDateTime, consumedMatchId: MATCH as Id },
      null,
    ],
  ] as const)('reads a %s code as such', async (status, overrides, reason) => {
    world.state = liveState(overrides);
    const body = (await world.app.inject({ method: 'GET', url: '/api/me/identity-links' })).json();
    expect(body.code.status).toBe(status);
    expect(body.code.void_reason).toBe(reason);
  });
});

describe('POST /api/me/identity-links/read — I wrote it on … (d)', () => {
  const read = (payload: object = { project_id: PROJECT, ticket_key: 'AUT-1' }) =>
    world.app.inject({ method: 'POST', url: '/api/me/identity-links/read', payload });

  it('reads a task’s ticket for a project member and answers the counts and the state', async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ comments: 3, carried_code: 1, matched: 1 });
    expect(world.reads).toHaveLength(1);
  });

  it('refuses a person below member in the project with 403, before any read', async () => {
    world.projectRole = 'viewer';
    const response = await read();
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('identity_link_read_not_permitted');
    expect(world.reads).toHaveLength(0);
  });

  it('refuses a person with no membership at all, unless their organisation role is member', async () => {
    world.projectRole = null;
    expect((await read()).statusCode).toBe(403);
    world.orgRole = 'member';
    expect((await read()).statusCode).toBe(200);
  });

  it('answers 404 for a ticket no task of the project holds, and reads nothing', async () => {
    world.thread = null;
    const response = await read({ project_id: PROJECT, merge_request_iid: 7 });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('link_thread_not_found');
    expect(world.reads).toHaveLength(0);
  });

  it('names a project with no binding and a provider that could not be read', async () => {
    world.read = { kind: 'no_binding' };
    expect((await read()).json().error.code).toBe('link_thread_no_binding');
    world.read = { kind: 'unavailable', reason: 'the thread could not be read (rate_limited): x' };
    const unavailable = await read();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().error.code).toBe('link_thread_unavailable');
  });
});

describe('POST /api/me/identity-links/matches/:match_id/confirm — (a)', () => {
  const confirm = (key: string | null = 'confirm-1') =>
    world.app.inject({
      method: 'POST',
      url: `/api/me/identity-links/matches/${MATCH}/confirm`,
      headers: key === null ? {} : { 'idempotency-key': key },
    });

  it('needs an Idempotency-Key, and confirms nothing without one', async () => {
    const response = await confirm(null);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('idempotency_key_required');
    expect(world.confirms).toBe(0);
  });

  it('links, with one identity.link audit row, and a retry under the key performs nothing', async () => {
    const first = await confirm();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      provider: 'jira-cloud',
      external_id: '557058:dev-one',
      display_name: 'Dev One',
      user_id: USER,
      performed: true,
      adopted_task_ids: ['00000000-0000-4000-8000-0000000000f1'],
    });
    // Acceptance 5: the link adopts the owner on live tasks naming the account, once, after it.
    expect(world.adoptions).toEqual([
      { userId: USER, provider: 'jira-cloud', externalId: '557058:dev-one' },
    ]);
    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]).toMatchObject({
      action: 'identity.link',
      params: {
        provider: 'jira-cloud',
        external_id: '557058:dev-one',
        via: 'link_code',
        match_id: MATCH,
      },
    });
    // The display name is provider text: only its length is audited.
    expect(JSON.stringify(world.actions)).not.toContain('Dev One');

    const retry = await confirm();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      external_id: '557058:dev-one',
      performed: false,
      adopted_task_ids: [],
    });
    expect(world.confirms).toBe(1);
    expect(world.adoptions).toHaveLength(1);
    expect(world.actions).toHaveLength(1);
  });

  it.each([
    ['match_not_found', undefined, 404, 'link_match_not_found'],
    ['code_expired', undefined, 409, 'link_code_expired'],
    ['code_used', undefined, 409, 'link_code_used'],
    ['code_voided', 'second_author', 409, 'link_code_voided'],
    ['identity_linked_elsewhere', undefined, 409, 'identity_linked_elsewhere'],
    ['identity_is_machine', undefined, 409, 'identity_is_machine'],
    ['identity_is_binding_account', undefined, 409, 'identity_is_binding_account'],
  ] as const)(
    'answers %s as %s, audits nothing and frees the key',
    async (reason, voidReason, status, code) => {
      world.confirm = {
        kind: 'refused',
        reason,
        ...(voidReason === undefined ? {} : { voidReason }),
      } as LinkConfirmation;
      const refused = await confirm();
      expect(refused.statusCode).toBe(status);
      expect(refused.json().error.code).toBe(code);
      expect(world.actions).toEqual([]);
      // A refusal releases the claim: the same key performs once the refusal is gone.
      world.confirm = {
        kind: 'linked',
        matchId: MATCH as Id,
        provider: 'jira-cloud',
        externalId: '557058:dev-one',
        displayName: null,
        replayed: false,
      };
      expect((await confirm()).json().performed).toBe(true);
    },
  );

  it('keeps the link when adoption fails partway, and answers the tasks adopted before it', async () => {
    world.adopted = [
      '00000000-0000-4000-8000-0000000000f1',
      '00000000-0000-4000-8000-0000000000f2',
    ];
    world.adoptFails = true;
    const response = await confirm('confirm-adopt-fails');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      performed: true,
      adopted_task_ids: ['00000000-0000-4000-8000-0000000000f1'],
    });
    expect(world.actions.map((action) => action.action)).toEqual(['identity.link']);
  });

  it('adopts nothing for a refused confirmation', async () => {
    world.confirm = { kind: 'refused', reason: 'code_expired' };
    expect((await confirm('confirm-refused')).statusCode).toBe(409);
    expect(world.adoptions).toEqual([]);
  });

  it('says which void it was: a second author is “someone else used this code”', async () => {
    world.confirm = { kind: 'refused', reason: 'code_voided', voidReason: 'second_author' };
    const body = (await confirm()).json();
    expect(body.error.details).toEqual([{ path: 'void_reason', message: 'second_author' }]);
    expect(body.error.message).toContain('someone else used this link code');
  });
});

describe('your linked accounts', () => {
  it('lists them, and unlinks one of yours with an identity.unlink audit row', async () => {
    world.mine = [
      {
        provider: 'gitlab',
        external_id: '4242',
        display_name: 'Dana',
        created_at: new Date('2026-11-01T08:00:00.000Z'),
      },
    ];
    const listed = await world.app.inject({ method: 'GET', url: '/api/me/identities' });
    expect(listed.json()).toEqual({
      items: [
        {
          provider: 'gitlab',
          external_id: '4242',
          display_name: 'Dana',
          created_at: '2026-11-01T08:00:00.000Z',
        },
      ],
    });
    const removed = await world.app.inject({
      method: 'DELETE',
      url: '/api/me/identities/gitlab/4242',
    });
    expect(removed.statusCode).toBe(200);
    expect(world.actions).toEqual([
      {
        userId: USER,
        action: 'identity.unlink',
        params: { provider: 'gitlab', external_id: '4242', user_id: USER, by: 'self' },
      },
    ]);
  });

  it('answers 404 for an account that is not yours, and audits nothing', async () => {
    const removed = await world.app.inject({
      method: 'DELETE',
      url: '/api/me/identities/gitlab/9999',
    });
    expect(removed.statusCode).toBe(404);
    expect(removed.json().error.code).toBe('identity_not_found');
    expect(world.actions).toEqual([]);
  });
});
