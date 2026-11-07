/**
 * `GET /api/projects/:id/owner-candidates` through the real route module (S-26.1's follow-up): the
 * guard is the owner command's `task.owner.assign` over the caller's **effective** role — 401 with
 * no session, 403 for a member whether the role is the organisation's or a membership's, 200 for a
 * maintainer by membership or by organisation role — and the answer is the projection's, in its
 * order, with nothing added. Which people the projection returns (a disabled user and a non-member
 * left out, the same set the command accepts) is the integration tier's,
 * `test/integration/server/owner-candidates.integration.test.ts`.
 */
import type { Id, UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '../auth/rbac.js';
import { toApiError } from '../errors.js';
import type { OwnerCandidate } from '../queries/owner-candidate-queries.js';
import { registerOwnerCandidateRoutes } from './owner-candidates.js';

const PROJECT = '00000000-0000-4000-8000-0000000026a1';
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000026a2';
const CALLER = '00000000-0000-4000-8000-0000000026b1';

const CANDIDATES: readonly OwnerCandidate[] = [
  { user_id: '00000000-0000-4000-8000-0000000026c2' as Id, name: 'Ada' },
  { user_id: '00000000-0000-4000-8000-0000000026c1' as Id, name: 'Bo' },
  { user_id: '00000000-0000-4000-8000-0000000026c3' as Id, name: 'Bo' },
];

let app: FastifyInstance | undefined;
let candidateReads: string[] = [];

const serve = async (input: {
  readonly actor: Pick<Actor, 'role'> | null;
  readonly membership: UserRole | null;
}): Promise<FastifyInstance> => {
  candidateReads = [];
  const server = fastify();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  server.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  server.addHook('onRequest', async (request) => {
    if (input.actor !== null) {
      request.actor = {
        userId: CALLER,
        email: 'caller@example.test',
        name: 'Caller',
        role: input.actor.role,
        sessionId: 'session-1',
      };
    }
  });
  await registerOwnerCandidateRoutes(server, {
    queries: {
      projectRole: async (projectId, userId) =>
        projectId === PROJECT && userId === CALLER ? input.membership : null,
      candidates: async (projectId) => {
        candidateReads.push(projectId);
        return projectId === PROJECT ? CANDIDATES : null;
      },
    },
  });
  app = server;
  return server;
};

const get = async (server: FastifyInstance, projectId = PROJECT) =>
  server.inject({ method: 'GET', url: `/api/projects/${projectId}/owner-candidates` });

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /api/projects/:id/owner-candidates', () => {
  it('answers 401 to an anonymous caller and reads nothing', async () => {
    const response = await get(await serve({ actor: null, membership: null }));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthenticated');
    expect(candidateReads).toEqual([]);
  });

  it('answers 403 to a member — by organisation role or by membership — and reads nothing', async () => {
    for (const [orgRole, membership] of [
      ['member', null],
      ['viewer', 'member'],
      ['member', 'member'],
      ['viewer', null],
    ] as const) {
      const server = await serve({ actor: { role: orgRole }, membership });
      const response = await get(server);
      expect(response.statusCode, `${orgRole}/${membership}`).toBe(403);
      expect(response.json().error.code, `${orgRole}/${membership}`).toBe('forbidden');
      expect(candidateReads).toEqual([]);
      await server.close();
    }
  });

  it('answers a maintainer — by membership or organisation role — with the projection, in its order', async () => {
    for (const [orgRole, membership] of [
      ['member', 'maintainer'],
      ['viewer', 'admin'],
      ['maintainer', null],
      ['admin', null],
    ] as const) {
      const server = await serve({ actor: { role: orgRole }, membership });
      const response = await get(server);
      expect(response.statusCode, `${orgRole}/${membership}`).toBe(200);
      expect(response.json()).toEqual({
        items: CANDIDATES.map(({ user_id, name }) => ({ user_id, name })),
      });
      expect(candidateReads).toEqual([PROJECT]);
      await server.close();
    }
  });

  it('answers 404 for a project that does not exist, and 400 for an id that is not a uuid', async () => {
    const server = await serve({ actor: { role: 'admin' }, membership: null });
    const missing = await get(server, OTHER_PROJECT);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');
    expect((await get(server, 'not-a-uuid')).statusCode).toBe(400);
  });
});
