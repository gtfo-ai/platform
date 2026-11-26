/**
 * **The organisation lists pass the caller's visible set to their reads** (BD-035, S-30.2
 * acceptance 2) — `GET /api/org/agents`, `/api/org/inbox`, `/api/org/audit` and
 * `/api/integrations`, through the real routes over fake reads. What each statement does with the
 * set is the integration tier's (`read-api`, `refused-deliveries`); this file holds the wiring: a
 * narrowed caller's set reaches every read, and an unnarrowed caller's is `null` (every project).
 */
import type { UserRole } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { VisibleProjectsReader } from '../auth/visibility.js';
import { everyProjectVisible, onlyProjectsVisible } from '../auth/visibility.test-fixture.js';
import { toApiError } from '../errors.js';
import { registerIntegrationRoutes } from './integrations.js';
import { registerOrgRoutes } from './org.js';

const SEEN = '00000000-0000-4000-8000-0000003003a1';
const USER = '00000000-0000-4000-8000-0000003003d1';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (visibleProjects: VisibleProjectsReader, role: UserRole = 'maintainer') => {
  const asked: Record<string, unknown[]> = { agents: [], inbox: [], audit: [], integrations: [] };
  const instance = fastify();
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  instance.addHook('onRequest', async (request) => {
    request.actor = {
      userId: USER,
      email: 'maintainer@example.test',
      name: 'Maintainer',
      role,
      sessionId: 'session-1',
    };
  });
  // No database: a route that reached one here would fail with a TypeError rather than pass.
  await registerOrgRoutes(instance, {
    database: {} as never,
    visibleProjects,
    identities: {} as never,
    models: async () => [],
    lists: {
      agents: async (visible) => {
        asked.agents?.push(visible);
        return { items: [] };
      },
      inbox: async (visible) => {
        asked.inbox?.push(visible);
        return { questions: [], approvals: [], ci_held: [], escalated: [] };
      },
      audit: async (options) => {
        asked.audit?.push(options.visible);
        return { items: [], nextCursor: null };
      },
    },
  });
  await registerIntegrationRoutes(instance, {
    database: {} as never,
    visibleProjects,
    baseUrl: 'https://agentic.example.test',
    organisationCredentials: null,
    lists: {
      rows: async () => [],
      summaries: async (_rows, _credentials, _now, visible) => {
        asked.integrations?.push(visible);
        return [];
      },
    },
  });
  await instance.ready();
  app = instance;
  return { instance, asked };
};

const ROUTES = [
  ['agents', '/api/org/agents'],
  ['inbox', '/api/org/inbox'],
  ['audit', '/api/org/audit'],
  ['integrations', '/api/integrations'],
] as const;

describe('the organisation lists take the caller’s visible set (BD-035)', () => {
  it('hands a narrowed caller’s projects to every read', async () => {
    const { instance, asked } = await build(onlyProjectsVisible(SEEN));
    for (const [name, url] of ROUTES) {
      const response = await instance.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} ${response.body}`).toBe(200);
      expect(asked[name], url).toEqual([[SEEN]]);
    }
  });

  it('hands every project (null) for a caller nothing narrows — the control', async () => {
    const { instance, asked } = await build(everyProjectVisible);
    for (const [name, url] of ROUTES) {
      const response = await instance.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} ${response.body}`).toBe(200);
      expect(asked[name], url).toEqual([null]);
    }
  });

  it('hands an empty list, never null, to a caller whose set is empty', async () => {
    const { instance, asked } = await build(onlyProjectsVisible());
    for (const [name, url] of ROUTES) {
      await instance.inject({ method: 'GET', url });
      expect(asked[name], url).toEqual([[]]);
    }
  });
});
