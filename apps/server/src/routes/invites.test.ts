/**
 * The invite routes (TD-022's 2026-11-26 amendment), driven through a real Fastify instance over an
 * in-memory {@link InviteCommands}: the order the accept performs its steps in, which refusal
 * releases the claim, the audit rows, and that no answer but the creation's carries the token.
 *
 * The fake's claim is the SQL's predicate written over a map — it is no evidence about the
 * conditional update's concurrency, which `test/integration/server/invite-claim.integration.test.ts`
 * measures against PostgreSQL, nor about Better Auth, which `test/e2e/server/auth.e2e.test.ts` drives.
 */
import type { JsonObject, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashInviteToken } from '../auth/invite-token.js';
import { toApiError } from '../errors.js';
import { classifyCreateUserFailure } from '../invites.js';
import type { InviteRecord } from '../queries/invite-queries.js';
import { type CreateInvitedUserOutcome, registerInviteRoutes } from './invites.js';

const ADMIN = '00000000-0000-4000-8000-0000000000e9';
const NEW_USER = '00000000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-11-26T12:00:00.000Z');
const PASSWORD = 'a-fake-invite-password-1234';

interface Row {
  id: string;
  tokenSha256: string;
  role: UserRole;
  createdBy: string | null;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: string | null;
  revokedAt: Date | null;
}

interface World {
  app: FastifyInstance;
  rows: Row[];
  actions: { userId: string; action: string; params: JsonObject }[];
  steps: string[];
  role: UserRole;
  signedIn: boolean;
  /** Runs while `createUser` is in flight — a revoke landing during an accept. */
  duringCreateUser?: () => Promise<void>;
  /** What `createUser` answers next: an outcome, or a thrown error. */
  createUser: CreateInvitedUserOutcome | Error;
}

let world: World;
let nextId = 0;

const recordOf = (row: Row): InviteRecord => ({ ...row, now: NOW });

const build = async (): Promise<World> => {
  const w = {
    rows: [],
    actions: [],
    steps: [],
    role: 'admin',
    signedIn: true,
    createUser: { kind: 'created', userId: NEW_USER, email: 'new.person@example.test' },
  } as unknown as World;
  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (w.signedIn) {
      request.actor = {
        userId: ADMIN,
        email: 'operator@example.test',
        name: 'Operator',
        role: w.role,
        sessionId: 'session-1',
      };
    }
  });
  const pending = (row: Row) =>
    row.acceptedAt === null && row.revokedAt === null && row.expiresAt > NOW;
  await registerInviteRoutes(app, {
    projectRole: async () => null,
    baseUrl: 'https://agentic.example.test/',
    newId: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`,
    invites: {
      create: async (input) => {
        const row: Row = {
          id: input.id,
          tokenSha256: input.tokenSha256,
          role: input.role,
          createdBy: input.createdBy,
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + input.validForHours * 3_600_000),
          acceptedAt: null,
          acceptedUserId: null,
          revokedAt: null,
        };
        w.rows.push(row);
        w.actions.push({
          userId: input.createdBy,
          action: 'org.user.invite',
          params: { invite_id: row.id, role: row.role, valid_for_hours: input.validForHours },
        });
        return recordOf(row);
      },
      list: async () => w.rows.map(recordOf),
      findById: async (id) => {
        const row = w.rows.find((r) => r.id === id);
        return row === undefined ? null : recordOf(row);
      },
      findByTokenHash: async (hash) => {
        w.steps.push('read');
        const row = w.rows.find((r) => r.tokenSha256 === hash);
        return row === undefined ? null : recordOf(row);
      },
      // The SQL's predicate: no account yet (a claimed link included) and not revoked.
      revoke: async ({ id, revokedBy }) => {
        const row = w.rows.find(
          (r) => r.id === id && r.acceptedUserId === null && r.revokedAt === null,
        );
        if (row === undefined) return null;
        row.revokedAt = NOW;
        w.actions.push({
          userId: revokedBy,
          action: 'org.user.invite_revoke',
          params: { invite_id: row.id, role: row.role },
        });
        return recordOf(row);
      },
      claim: async (hash) => {
        w.steps.push('claim');
        const row = w.rows.find((r) => r.tokenSha256 === hash && pending(r));
        if (row === undefined) return null;
        row.acceptedAt = NOW;
        return { id: row.id, role: row.role };
      },
      release: async (id) => {
        w.steps.push('release');
        const row = w.rows.find((r) => r.id === id && r.acceptedUserId === null);
        if (row !== undefined) row.acceptedAt = null;
      },
      createUser: async (input) => {
        w.steps.push(`createUser:${input.role}`);
        await w.duringCreateUser?.();
        if (w.createUser instanceof Error) throw w.createUser;
        return w.createUser;
      },
      completeAccept: async (input) => {
        w.steps.push('complete');
        const row = w.rows.find((r) => r.id === input.id);
        if (row !== undefined) row.acceptedUserId = input.userId;
        w.actions.push({
          userId: input.userId,
          action: 'org.user.invite_accept',
          params: input.params,
        });
      },
    },
  });
  await app.ready();
  w.app = app;
  return w;
};

const create = async (body: Record<string, unknown> = {}) => {
  const response = await world.app.inject({
    method: 'POST',
    url: '/api/org/users/invites',
    payload: body,
  });
  return response;
};

const tokenOf = (url: string): string => url.slice(url.indexOf('#') + 1);

const accept = (token: string, overrides: Record<string, unknown> = {}) =>
  world.app.inject({
    method: 'POST',
    url: '/api/invites/accept',
    payload: {
      token,
      email: 'new.person@example.test',
      name: 'New Person',
      password: PASSWORD,
      ...overrides,
    },
  });

beforeEach(async () => {
  world = await build();
});

describe('creating a link', () => {
  it('answers the link once, with member and 24 hours by default, and stores only the hash', async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    const body = response.json() as { url: string; invite: Record<string, unknown> };
    expect(body.url).toMatch(/^https:\/\/agentic\.example\.test\/invite#[A-Za-z0-9_-]{43}$/);
    expect(body.invite).toMatchObject({ role: 'member', state: 'pending' });
    expect(body.invite.expires_at).toBe('2026-11-27T12:00:00.000Z');
    const token = tokenOf(body.url);
    expect(world.rows[0]?.tokenSha256).toBe(hashInviteToken(token));
    expect(JSON.stringify(body.invite)).not.toContain(token);
    expect(world.actions).toEqual([
      {
        userId: ADMIN,
        action: 'org.user.invite',
        params: { invite_id: world.rows[0]?.id, role: 'member', valid_for_hours: 24 },
      },
    ]);
  });

  it('takes the role and hours it is given, and refuses hours outside 1–720', async () => {
    const made = await create({ role: 'admin', valid_for_hours: 720 });
    expect(made.statusCode).toBe(201);
    expect((made.json() as { invite: { role: string } }).invite.role).toBe('admin');
    for (const hours of [0, 721, 1.5]) {
      expect((await create({ valid_for_hours: hours })).statusCode, String(hours)).toBe(400);
    }
    expect((await create({ valid_for_hours: 1 })).statusCode).toBe(201);
  });

  it('refuses a non-admin with 403 and an anonymous caller with 401, writing nothing', async () => {
    world.role = 'maintainer';
    expect((await create()).statusCode).toBe(403);
    expect(
      (await world.app.inject({ method: 'GET', url: '/api/org/users/invites' })).statusCode,
    ).toBe(403);
    world.signedIn = false;
    expect(
      (await world.app.inject({ method: 'POST', url: '/api/org/users/invites' })).statusCode,
    ).toBe(401);
    expect(world.rows).toEqual([]);
    expect(world.actions).toEqual([]);
  });
});

describe('the list', () => {
  it('names each state and carries no token and no hash', async () => {
    const url = (await create()).json().url as string;
    const listed = await world.app.inject({ method: 'GET', url: '/api/org/users/invites' });
    expect(listed.statusCode).toBe(200);
    const text = listed.body;
    expect(text).not.toContain(tokenOf(url));
    expect(text).not.toContain(world.rows[0]?.tokenSha256 ?? 'unset');
    expect(text).not.toContain('token');
    expect((listed.json() as { items: { state: string }[] }).items.map((i) => i.state)).toEqual([
      'pending',
    ]);
  });
});

describe('revoking', () => {
  it('revokes a pending link once, and says so for one already revoked or used', async () => {
    await create();
    const id = world.rows[0]?.id ?? '';
    const first = await world.app.inject({
      method: 'POST',
      url: `/api/org/users/invites/${id}/revoke`,
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { state: string }).state).toBe('revoked');
    const again = await world.app.inject({
      method: 'POST',
      url: `/api/org/users/invites/${id}/revoke`,
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe('invite_revoked');
    expect(world.actions.filter((a) => a.action === 'org.user.invite_revoke')).toHaveLength(1);

    const missing = await world.app.inject({
      method: 'POST',
      url: '/api/org/users/invites/00000000-0000-4000-8000-00000000ffff/revoke',
    });
    expect((missing.json() as { error: { code: string } }).error.code).toBe('invite_not_found');
  });
});

describe('accepting', () => {
  it('claims, then creates the account with the link’s role, then records it as the new user', async () => {
    const url = (await create({ role: 'viewer' })).json().url as string;
    const response = await accept(tokenOf(url));
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      user_id: NEW_USER,
      email: 'new.person@example.test',
      role: 'viewer',
    });
    expect(world.steps).toEqual(['claim', 'createUser:viewer', 'complete']);
    expect(world.actions.at(-1)).toEqual({
      userId: NEW_USER,
      action: 'org.user.invite_accept',
      params: { invite_id: world.rows[0]?.id, role: 'viewer' },
    });
  });

  it('answers a second accept 410 invite_used without reaching createUser', async () => {
    const token = tokenOf((await create()).json().url as string);
    expect((await accept(token)).statusCode).toBe(201);
    world.steps.length = 0;
    const second = await accept(token, { email: 'other@example.test' });
    expect(second.statusCode).toBe(410);
    expect((second.json() as { error: { code: string } }).error.code).toBe('invite_used');
    expect(world.steps).toEqual(['claim', 'read']);
  });

  it('answers each ending by its own code, and an unknown token 404', async () => {
    const expired = tokenOf((await create()).json().url as string);
    const row = world.rows[0];
    if (row !== undefined) row.expiresAt = NOW;
    expect((await accept(expired)).json()).toMatchObject({ error: { code: 'invite_expired' } });

    const revoked = tokenOf((await create()).json().url as string);
    const second = world.rows[1];
    if (second !== undefined) second.revokedAt = NOW;
    expect((await accept(revoked)).json()).toMatchObject({ error: { code: 'invite_revoked' } });

    const unknown = await accept('not-a-real-token');
    expect(unknown.statusCode).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe('invite_not_found');
    expect(world.steps.some((step) => step.startsWith('createUser'))).toBe(false);
  });

  it('refuses a password outside the bounds before it claims anything', async () => {
    const token = tokenOf((await create()).json().url as string);
    for (const password of ['eleven-char', 'x'.repeat(129)]) {
      expect((await accept(token, { password })).statusCode, password).toBe(400);
    }
    expect(world.steps).toEqual([]);
    expect(world.rows[0]?.acceptedAt).toBeNull();
  });

  it('releases the claim when the email is taken, so the link stays usable', async () => {
    const token = tokenOf((await create()).json().url as string);
    world.createUser = { kind: 'email_taken' };
    const taken = await accept(token);
    expect(taken.statusCode).toBe(409);
    expect((taken.json() as { error: { code: string } }).error.code).toBe('email_taken');
    expect(world.steps).toEqual(['claim', 'createUser:member', 'release']);
    expect(world.rows[0]?.acceptedAt).toBeNull();
    expect(world.actions.some((a) => a.action === 'org.user.invite_accept')).toBe(false);

    world.createUser = { kind: 'created', userId: NEW_USER, email: 'new.person@example.test' };
    expect((await accept(token)).statusCode).toBe(201);
  });

  it('lets a revoke that lands during an accept stand: the release leaves it revoked', async () => {
    const token = tokenOf((await create()).json().url as string);
    const id = world.rows[0]?.id ?? '';
    let revokeStatus = 0;
    world.duringCreateUser = async () => {
      const revoked = await world.app.inject({
        method: 'POST',
        url: `/api/org/users/invites/${id}/revoke`,
      });
      revokeStatus = revoked.statusCode;
    };
    world.createUser = { kind: 'email_taken' };
    expect((await accept(token)).statusCode).toBe(409);
    // The claim was held when the revoke landed, and the revoke succeeded anyway.
    expect(revokeStatus).toBe(200);
    expect(world.steps).toEqual(['claim', 'createUser:member', 'release']);
    world.duringCreateUser = undefined;

    const inspected = await world.app.inject({
      method: 'POST',
      url: '/api/invites/inspect',
      payload: { token },
    });
    expect((inspected.json() as { state: string }).state).toBe('revoked');
    world.createUser = { kind: 'created', userId: NEW_USER, email: 'new.person@example.test' };
    const again = await accept(token);
    expect(again.statusCode).toBe(410);
    expect((again.json() as { error: { code: string } }).error.code).toBe('invite_revoked');
  });

  it('answers a revoke 409 invite_used once the link has made an account', async () => {
    const token = tokenOf((await create()).json().url as string);
    expect((await accept(token)).statusCode).toBe(201);
    const id = world.rows[0]?.id ?? '';
    const refused = await world.app.inject({
      method: 'POST',
      url: `/api/org/users/invites/${id}/revoke`,
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe('invite_used');
  });

  it('keeps the claim — burns the link — when createUser fails any other way', async () => {
    const token = tokenOf((await create()).json().url as string);
    world.createUser = new Error('the database went away mid-create');
    expect((await accept(token)).statusCode).toBe(500);
    expect(world.steps).toEqual(['claim', 'createUser:member']);
    expect(world.rows[0]?.acceptedAt).not.toBeNull();
    expect((await accept(token)).json()).toMatchObject({ error: { code: 'invite_used' } });
  });
});

describe('inspecting', () => {
  it('answers role, state and expiry, and never consumes the link', async () => {
    const token = tokenOf((await create({ role: 'maintainer' })).json().url as string);
    for (let read = 0; read < 2; read += 1) {
      const inspected = await world.app.inject({
        method: 'POST',
        url: '/api/invites/inspect',
        payload: { token },
      });
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json()).toEqual({
        role: 'maintainer',
        state: 'pending',
        expires_at: '2026-11-27T12:00:00.000Z',
      });
    }
    expect(world.rows[0]?.acceptedAt).toBeNull();
    expect((await accept(token)).statusCode).toBe(201);
  });

  it('is public, and answers an unknown token 404', async () => {
    world.signedIn = false;
    const response = await world.app.inject({
      method: 'POST',
      url: '/api/invites/inspect',
      payload: { token: 'nobody-made-this' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('classifyCreateUserFailure', () => {
  const apiError = (code: string) => Object.assign(new Error(code), { body: { code } });

  it('releases only for refusals raised before the user row is written', () => {
    expect(classifyCreateUserFailure(apiError('USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'))).toEqual({
      kind: 'email_taken',
    });
    expect(classifyCreateUserFailure(apiError('INVALID_EMAIL'))).toEqual({ kind: 'invalid_email' });
    expect(
      classifyCreateUserFailure({ code: '23505', constraint: 'users_email_key', detail: '' }),
    ).toEqual({ kind: 'email_taken' });
    expect(
      classifyCreateUserFailure(
        Object.assign(new Error('wrapped'), { cause: { code: '23505', detail: 'Key (email)=…' } }),
      ),
    ).toEqual({ kind: 'email_taken' });
  });

  it('rethrows everything else, a unique violation on another column included', () => {
    expect(classifyCreateUserFailure(apiError('FAILED_TO_CREATE_USER'))).toBeNull();
    expect(classifyCreateUserFailure({ code: '23505', constraint: 'accounts_pkey' })).toBeNull();
    expect(classifyCreateUserFailure(new Error('boom'))).toBeNull();
  });
});
