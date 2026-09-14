import type { JsonObject, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { BadRequestError, toApiError } from '../errors.js';
import {
  type IdentityMappingRecord,
  parseAuditCursor,
  registerOrgRoutes,
  toWireIdentityMapping,
} from './org.js';

describe('parseAuditCursor', () => {
  it('accepts the timestamp this endpoint hands out as next_cursor', () => {
    expect(parseAuditCursor('2026-09-09T10:15:30.000Z').toISOString()).toBe(
      '2026-09-09T10:15:30.000Z',
    );
  });

  it('refuses anything it cannot read, rather than passing new Date(NaN) to the driver', () => {
    // `paginationQuerySchema` types the cursor as an opaque non-empty string, which is right for
    // the API as a whole and wrong to hand straight to a query.
    for (const cursor of ['not-a-date', '', '2026-13-45', 'null', "'; drop table users; --"]) {
      expect(() => parseAuditCursor(cursor), cursor).toThrow(BadRequestError);
    }
  });
});

describe('toWireIdentityMapping (WP-31, PROGRESS backlog 79)', () => {
  const row = {
    provider: 'jira-cloud',
    external_id: 'acct-ada',
    user_id: '00000000-0000-4000-8000-0000000000a1',
    display_name: 'Ada',
    created_at: new Date('2026-09-09T10:15:30.000Z'),
  };

  it('renders the instant as ISO 8601 whichever shape the driver answered', () => {
    // `pg` answers a `timestamptz` as a `Date`; a `sql` template can answer a string. Both reach
    // this function and the two endpoints must not disagree about the field.
    expect(toWireIdentityMapping(row).created_at).toBe('2026-09-09T10:15:30.000Z');
    expect(
      toWireIdentityMapping({ ...row, created_at: '2026-09-09T10:15:30.000Z' }).created_at,
    ).toBe('2026-09-09T10:15:30.000Z');
  });

  it('publishes the mapping and never the email the table also carries', () => {
    // The column exists; nothing reads it, and the one thing that would is a match the platform
    // performed itself — the route this endpoint exists to replace (BD-022, Q10).
    const wire = toWireIdentityMapping({ ...row, display_name: null });
    expect(Object.keys(wire).sort()).toEqual([
      'created_at',
      'display_name',
      'external_id',
      'provider',
      'user_id',
    ]);
    expect(wire.display_name).toBeNull();
  });
});

/**
 * The identity pair, driven through a real Fastify instance (WP-31 round 2).
 *
 * **Why by hand.** `routes/client-census.test.ts` compares the *client's* `/api/*` paths against
 * the router, and no screen calls either of these — so the census is blind to them by construction,
 * exactly as it is to `GET /api/projects/:id/kb/health`. It names them positively there (served,
 * 401, absent from the client's list) and this file asserts what the census cannot see: the
 * wrong-role refusal, the upsert, the `unknown_user` 409, and the `human_actions` row the write
 * owes — which it did not write at all until this round.
 *
 * The four organisation **reads** on the same file are not driven here: they take `database`
 * directly and are asserted on the integration tier, which is the pattern `routes/onboarding.ts`
 * already states for a database-backed route.
 */
describe('the identity routes (WP-31 round 2)', () => {
  const USER = '00000000-0000-4000-8000-0000000000a1';
  const ADMIN = '00000000-0000-4000-8000-0000000000e9';

  interface IdentityWorld {
    readonly app: FastifyInstance;
    readonly upserts: {
      provider: string;
      externalId: string;
      userId: string;
      displayName: string | null;
    }[];
    readonly actions: {
      userId: string;
      action: string;
      params: JsonObject;
      taskId?: string | null;
    }[];
    role: UserRole;
    signedIn: boolean;
    /** The users this instance knows about; anything else is the 409. */
    known: Set<string>;
    mappings: IdentityMappingRecord[];
  }

  const build = async (): Promise<IdentityWorld> => {
    const upserts: IdentityWorld['upserts'] = [];
    const actions: IdentityWorld['actions'] = [];
    const world = {
      upserts,
      actions,
      role: 'admin',
      signedIn: true,
      known: new Set([USER]),
      mappings: [],
    } as unknown as IdentityWorld;

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
          userId: ADMIN,
          email: 'operator@example.test',
          name: 'Operator',
          role: world.role,
          sessionId: 'session-1',
        };
      }
    });

    await registerOrgRoutes(app, {
      // Unused by this pair: the guard is organisation-scoped, so nothing reaches a query here. A
      // route that touched the database would fail with a TypeError rather than pass quietly.
      database: {} as never,
      identities: {
        findUser: async (userId) => (world.known.has(userId) ? { id: userId } : null),
        upsertMapping: async (input) => {
          upserts.push({ ...input });
          const row: IdentityMappingRecord = {
            provider: input.provider,
            external_id: input.externalId,
            user_id: input.userId,
            display_name: input.displayName,
            created_at: new Date('2026-09-09T10:15:30.000Z'),
          };
          world.mappings = [
            ...world.mappings.filter(
              (entry) =>
                entry.provider !== input.provider || entry.external_id !== input.externalId,
            ),
            row,
          ];
          return row;
        },
        listMappings: async () => world.mappings,
        recordAction: async (input) => {
          actions.push({ ...input });
        },
      },
    });
    await app.ready();
    (world as { app: FastifyInstance }).app = app;
    return world;
  };

  const mapping = (overrides: Record<string, unknown> = {}) => ({
    provider: 'jira-cloud',
    external_id: 'acct-ada',
    user_id: USER,
    ...overrides,
  });

  let world: IdentityWorld;

  beforeEach(async () => {
    world = await build();
    return async () => {
      await world.app.close();
    };
  });

  it('serves both halves of the pair', async () => {
    // Positively, and not merely "not 404": a registered-but-unimplemented route would answer 501.
    expect(
      (
        await world.app.inject({
          method: 'POST',
          url: '/api/org/identities',
          payload: mapping(),
        })
      ).statusCode,
    ).toBe(200);
    expect((await world.app.inject({ method: 'GET', url: '/api/org/identities' })).statusCode).toBe(
      200,
    );
  });

  it('refuses an anonymous caller on both, and before validating the body', async () => {
    // The write's guard is a `preValidation` hook for the reason WP-21 measured: Fastify validates
    // the body first, so a `preHandler` answers an unauthenticated caller `400` describing the
    // route's own shape. Asked with **no body at all**, a guard that slipped back fails here.
    world.signedIn = false;
    for (const [method, payload] of [
      ['POST', undefined],
      ['GET', undefined],
    ] as const) {
      const response = await world.app.inject({
        method,
        url: '/api/org/identities',
        ...(payload === undefined ? {} : { payload }),
      });
      expect(`${method} -> ${response.statusCode} ${response.json().error.code}`).toBe(
        `${method} -> 401 unauthenticated`,
      );
    }
    expect(world.upserts).toHaveLength(0);
    expect(world.actions).toHaveLength(0);
  });

  it.each(['viewer', 'member', 'maintainer'] as const)(
    'refuses a %s on both: the mapping decides who may act as whom',
    async (role) => {
      world.role = role;
      const write = await world.app.inject({
        method: 'POST',
        url: '/api/org/identities',
        payload: mapping(),
      });
      expect(write.statusCode).toBe(403);
      expect(write.json().error.code).toBe('forbidden');
      const read = await world.app.inject({ method: 'GET', url: '/api/org/identities' });
      expect(read.statusCode).toBe(403);
      // Nothing was written and nothing was audited for a refusal (`routes/commands.ts`'s rule).
      expect(world.upserts).toHaveLength(0);
      expect(world.actions).toHaveLength(0);
    },
  );

  it('upserts the mapping and publishes the row it wrote', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: '/api/org/identities',
      payload: mapping({ display_name: 'Ada' }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      provider: 'jira-cloud',
      external_id: 'acct-ada',
      user_id: USER,
      display_name: 'Ada',
      created_at: '2026-09-09T10:15:30.000Z',
    });
    expect(world.upserts).toEqual([
      { provider: 'jira-cloud', externalId: 'acct-ada', userId: USER, displayName: 'Ada' },
    ]);
    // …and the list shows it, which is the half an operator checks their own work with.
    const listed = await world.app.inject({ method: 'GET', url: '/api/org/identities' });
    expect(listed.json().items).toHaveLength(1);
  });

  it('records exactly one human action, naming the mapping and no task', async () => {
    // technical/08 § "Rate limits and safety": *"all human actions recorded in `human_actions`"*.
    // This route wrote none until WP-31 round 2 — on the one write whose subject is who may act as
    // whom — so this is the assertion that would have caught it.
    await world.app.inject({
      method: 'POST',
      url: '/api/org/identities',
      payload: mapping({ display_name: 'Ada' }),
    });
    expect(world.actions).toHaveLength(1);
    expect(world.actions[0]?.userId).toBe(ADMIN);
    expect(world.actions[0]?.action).toBe('org.identity.map');
    expect(world.actions[0]?.taskId).toBeNull();
    expect(world.actions[0]?.params).toEqual({
      provider: 'jira-cloud',
      external_id: 'acct-ada',
      user_id: USER,
      display_name_chars: 3,
    });
  });

  it('records the display name’s length and never the words', async () => {
    // Free text on its way to an audit row, and this route has no redactor — the same rule
    // `routes/asks.ts` applies to a question. Planted, so the assertion has something to fail on.
    await world.app.inject({
      method: 'POST',
      url: '/api/org/identities',
      payload: mapping({ display_name: 'Ada glpat-FAKEFAKEFAKEFAKEFAKE' }),
    });
    expect(JSON.stringify(world.actions[0]?.params)).not.toContain('glpat-');
    expect(world.actions[0]?.params.display_name_chars).toBe(
      'Ada glpat-FAKEFAKEFAKEFAKEFAKE'.length,
    );
  });

  it('answers 409 unknown_user for a user id nothing matches, and audits nothing', async () => {
    const response = await world.app.inject({
      method: 'POST',
      url: '/api/org/identities',
      payload: mapping({ user_id: '00000000-0000-4000-8000-0000000000ff' }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('unknown_user');
    expect(world.upserts).toHaveLength(0);
    expect(world.actions).toHaveLength(0);
  });

  it('re-maps an account to another person rather than refusing the second request', async () => {
    // The reason this route takes **no** `Idempotency-Key`: a second body under the same identity
    // is the operation an operator performs when somebody leaves, and a key would answer it `409
    // idempotency_key_reused`. Two accepted requests, two audit rows, one row in the map.
    world.known.add('00000000-0000-4000-8000-0000000000a2');
    const first = await world.app.inject({
      method: 'POST',
      url: '/api/org/identities',
      payload: mapping(),
    });
    const second = await world.app.inject({
      method: 'POST',
      url: '/api/org/identities',
      payload: mapping({ user_id: '00000000-0000-4000-8000-0000000000a2' }),
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().user_id).toBe('00000000-0000-4000-8000-0000000000a2');
    expect(world.actions).toHaveLength(2);
    const listed = await world.app.inject({ method: 'GET', url: '/api/org/identities' });
    expect(listed.json().items).toHaveLength(1);
  });

  it('refuses a body the strict contract does not accept, and writes nothing', async () => {
    for (const payload of [
      { provider: '', external_id: 'acct-ada', user_id: USER },
      { provider: 'jira-cloud', external_id: '', user_id: USER },
      { provider: 'jira-cloud', external_id: 'acct-ada', user_id: 'not-a-uuid' },
      { provider: 'jira-cloud', external_id: 'acct-ada', user_id: USER, email: 'ada@example.test' },
    ]) {
      const response = await world.app.inject({
        method: 'POST',
        url: '/api/org/identities',
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    // `email` is the fourth: the column exists and this endpoint deliberately does not take it,
    // because a match the platform performed itself is the route it exists to replace (Q10).
    expect(world.upserts).toHaveLength(0);
    expect(world.actions).toHaveLength(0);
  });
});
