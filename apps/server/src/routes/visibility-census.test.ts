/**
 * **Every route the server registers has a visibility class** (BD-035, TD-022's 2026-11-26
 * visibility amendment item 8; S-30.2 acceptance 3).
 *
 * Visibility is the second question every route answers: may this person see the project it is
 * about? The amendment sorts the routes into classes, and this file holds the router to them:
 *
 * | class | amendment item | what it means |
 * |---|---|---|
 * | `guarded` | 2 | a project-scoped guard asks visibility first: a hidden project, task, run, artifact or shadow batch is 404 |
 * | `list` | 3 | a list or aggregate takes the caller's set as a parameter and filters in SQL |
 * | `construction` | 4 | visible by construction — the route reads only the caller's own rows — and a named test asserts it |
 * | `unchanged` | 5 | deliberately untouched, with the reason (admin-only, names no project, acts for no user) |
 * | `choice` | 6 | the claim-scope reads: what a person may **choose**, which names a hidden project and no task |
 * | `stream` | 7 | the event stream, filtered by `sse/topic-access.ts` and the hub |
 *
 * **Both directions, off the router.** The server's half is `app.registeredRoutes`, collected by
 * `buildApp`'s own `onRoute` hook — so a route added anywhere is in it — and the table below must
 * equal it: a registered route with no class fails, and a class for a route that is no longer
 * registered fails. A new route is unclassified until somebody decides its class.
 *
 * **The class is checked, not trusted.** `guarded` holds exactly when a hook of the route is a
 * guard `requirePermission` built with a `project` hook (it carries `VISIBILITY_GUARD`), every route
 * under the five project-shaped families must be `guarded`, and each `construction` entry names the
 * test that asserts it — read off disk here, so a renamed test fails this file.
 *
 * **What it cannot see**, stated: whether a `list` route's statement really filters (the
 * integration tier's cases do: `read-api`, `refused-deliveries`, `stats-queries`; the wiring is
 * `visible-lists.test.ts`); a route registered only by a composition this census does not make;
 * and the browser bundle `webRoot` serves (`web/fallback.ts`'s `createClientFallback`, the SPA's
 * shell and its static assets), which runs from the not-found handler, for which Fastify emits no
 * `onRoute` — it names no project and serves no data, and this census builds with no `webRoot`.
 * `HEAD` mirrors `GET` and is asserted to, rather than classified twice.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Auth } from '../auth/better-auth.js';
import { loadServerConfig } from '../config.js';
import { createLogger } from '../logging.js';
import { createMetrics } from '../metrics.js';
import type { Database } from '../queries/identity-queries.js';
import { SseHub } from '../sse/hub.js';
import { readSource, repositoryRoot } from './web-sources.js';

type VisibilityClass = 'guarded' | 'list' | 'construction' | 'unchanged' | 'choice' | 'stream';

interface Classified {
  readonly class: VisibilityClass;
  /** Why, for every class but `guarded`; for `construction`, `<file> › <test name>`. */
  readonly why?: string;
}

/** Every route this server registers, `METHOD url`, and its class. */
const VISIBILITY_CLASSES: Readonly<Record<string, Classified>> = {
  'GET /healthz': { class: 'unchanged', why: 'ops: names no project' },
  'GET /readyz': { class: 'unchanged', why: 'ops: names no project' },
  'GET /api/version': { class: 'unchanged', why: 'names no project (TD-022 amendment item 5)' },
  'GET /metrics': { class: 'unchanged', why: 'ops: names no project' },
  'GET /api/auth/*': { class: 'unchanged', why: 'sign-in; names no project' },
  'POST /api/auth/*': { class: 'unchanged', why: 'sign-in; names no project' },
  'GET /api/setup-state': { class: 'unchanged', why: 'names no project (item 5)' },
  'GET /api/org/users': { class: 'unchanged', why: 'names no project (item 5)' },
  'GET /api/org/audit': { class: 'list', why: 'filtered in SQL by the caller’s set (item 3)' },
  'GET /api/org/agents': { class: 'list', why: 'filtered in SQL by the caller’s set (item 3)' },
  'GET /api/org/models': { class: 'unchanged', why: 'names no project (item 5)' },
  'GET /api/org/inbox': { class: 'list', why: 'filtered in SQL by the caller’s set (item 3)' },
  'POST /api/org/identities': { class: 'unchanged', why: 'admin-only (item 5)' },
  'DELETE /api/org/identities/:provider/:external_id': {
    class: 'unchanged',
    why: 'admin-only (item 5)',
  },
  'GET /api/org/identities': { class: 'unchanged', why: 'admin-only (item 5)' },
  'GET /api/org/identities/candidates': { class: 'unchanged', why: 'admin-only (item 5)' },
  'POST /api/org/users/invites': { class: 'unchanged', why: 'admin-only (item 5)' },
  'GET /api/org/users/invites': { class: 'unchanged', why: 'admin-only (item 5)' },
  'POST /api/org/users/invites/:invite_id/revoke': {
    class: 'unchanged',
    why: 'admin-only (item 5)',
  },
  'POST /api/invites/inspect': {
    class: 'unchanged',
    why: 'public: the token is the credential; names no project',
  },
  'POST /api/invites/accept': {
    class: 'unchanged',
    why: 'public: the token is the credential; names no project',
  },
  'GET /api/me/task-limit': {
    class: 'construction',
    why: 'apps/server/src/routes/task-limits.test.ts › reads your limit with the counting rule’s numbers',
  },
  'PUT /api/me/task-limit': {
    class: 'unchanged',
    why: 'sets the caller’s own limit; names no project',
  },
  'GET /api/org/task-limits': { class: 'unchanged', why: 'admin-only (item 5)' },
  'PUT /api/org/users/:id/task-limit': { class: 'unchanged', why: 'admin-only (item 5)' },
  'POST /api/me/identity-links': { class: 'unchanged', why: 'names no project (item 5)' },
  'GET /api/me/identity-links': { class: 'unchanged', why: 'names no project (item 5)' },
  'POST /api/me/identity-links/read': {
    class: 'unchanged',
    why: 'reads a ticket the person names for their own link code and returns only the match (item 5)',
  },
  'POST /api/me/identity-links/matches/:match_id/confirm': {
    class: 'unchanged',
    why: 'names no project (item 5)',
  },
  'GET /api/me/identities': { class: 'unchanged', why: 'names no project (item 5)' },
  'DELETE /api/me/identities/:provider/:external_id': {
    class: 'unchanged',
    why: 'names no project (item 5)',
  },
  'GET /api/org/dead-letters': { class: 'unchanged', why: 'admin-only (item 5)' },
  'POST /api/org/dead-letters/:position/requeue': {
    class: 'unchanged',
    why: 'admin-only (item 5)',
  },
  'POST /api/worker/v1/device': { class: 'unchanged', why: 'the device flow; names no project' },
  'POST /api/worker/v1/device/token': {
    class: 'unchanged',
    why: 'the device flow; names no project',
  },
  'POST /api/workers/device/lookup': { class: 'unchanged', why: 'a device code; names no project' },
  'POST /api/workers/device/approve': {
    class: 'unchanged',
    why: 'a device code; names no project',
  },
  'GET /api/workers': {
    class: 'construction',
    why: 'apps/server/src/routes/workers.test.ts › lists own workers for a member and every worker for an administrator',
  },
  'DELETE /api/workers/:id': {
    class: 'unchanged',
    why: 'revokes the caller’s own worker (any for an admin); names no project',
  },
  'PUT /api/workers/:id/claim-policy': {
    class: 'unchanged',
    why: 'writes the caller’s own worker; project_not_eligible keeps the role rule (item 6)',
  },
  'GET /api/workers/:id/claim-scope': {
    class: 'choice',
    why: 'the one read that names a hidden project, and no task (item 6)',
  },
  'POST /api/worker/v1/handshake': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/claims': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/pause': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/heartbeat': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/release': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/spawn': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/finish': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/late-cost': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'GET /api/worker/v1/release': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/update-report': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'GET /api/worker/v1/compose.yml': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'GET /api/worker/v1/install.sh': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'GET /api/worker/v1/install.ps1': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/manual-pause': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/cancel': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'GET /api/worker/v1/claim-scope': {
    class: 'choice',
    why: 'the worker protocol twin of GET /api/workers/:id/claim-scope (item 6)',
  },
  'PUT /api/worker/v1/claim-scope': {
    class: 'unchanged',
    why: 'writes the worker’s own scope; project_not_eligible keeps the role rule (item 6)',
  },
  'GET /api/worker/v1/offers': {
    class: 'construction',
    why: 'test/integration/pipeline/claim-scope.integration.test.ts › lists exactly what a pick admits over one fixture set, oldest first, with what the scope takes',
  },
  'POST /api/worker/v1/offers/:id/claim': {
    class: 'unchanged',
    why: 'a pick the person makes ignores the scope (TD-031 decision 8), and makes them the owner (item 5)',
  },
  'POST /api/worker/v1/runs/:id/transcript': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/tools/:name': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/approvals': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/session': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'POST /api/worker/v1/runs/:id/ssh-sign': {
    class: 'unchanged',
    why: 'the worker protocol acts on the worker and the run it holds (item 5)',
  },
  'GET /api/org/failed-jobs': { class: 'unchanged', why: 'admin-only (item 5)' },
  'GET /api/integrations': { class: 'list', why: 'used_by names only visible projects (item 3)' },
  'GET /api/integrations/providers': { class: 'unchanged', why: 'names no project (item 3)' },
  'GET /api/integrations/:integration_id/setup-guide': {
    class: 'unchanged',
    why: 'names no project (item 3)',
  },
  'GET /api/integrations/:integration_id/refused-deliveries': {
    class: 'list',
    why: 'an account bound only to hidden projects answers nothing (item 3)',
  },
  'GET /api/projects': { class: 'list', why: 'only the caller’s projects (item 3)' },
  'GET /api/projects/:project_id/config': { class: 'guarded' },
  'GET /api/projects/:project_id/budgets': { class: 'guarded' },
  'GET /api/projects/:project_id/spend': { class: 'guarded' },
  'GET /api/projects/:project_id/tasks': { class: 'guarded' },
  'GET /api/projects/:project_id/readiness': { class: 'guarded' },
  'GET /api/projects/:project_id/owner-candidates': { class: 'guarded' },
  'POST /api/projects/:project_id/config/export': { class: 'guarded' },
  'POST /api/projects/:project_id/config/refresh': { class: 'guarded' },
  'GET /api/projects/:project_id/execution': { class: 'guarded' },
  'PUT /api/projects/:project_id/execution': { class: 'guarded' },
  'GET /api/projects/:project_id/repository': { class: 'guarded' },
  'PUT /api/projects/:project_id/default-branch': { class: 'guarded' },
  'GET /api/projects/:project_id/bindings': { class: 'guarded' },
  'PUT /api/projects/:project_id/bindings': { class: 'guarded' },
  'GET /api/projects/:project_id/skipped-tickets': { class: 'guarded' },
  'GET /api/projects/:project_id/ticket-statuses': { class: 'guarded' },
  'GET /api/projects/:project_id/ci/manual-jobs': { class: 'guarded' },
  'POST /api/projects': { class: 'unchanged', why: 'project.create, admin-only (item 5)' },
  'POST /api/integrations': { class: 'unchanged', why: 'integration.write, admin-only' },
  'POST /api/integrations/:integration_id/test': {
    class: 'unchanged',
    why: 'integration.write, admin-only',
  },
  'PATCH /api/integrations/:integration_id': {
    class: 'unchanged',
    why: 'integration.write, admin-only',
  },
  'POST /api/integrations/:integration_id/secrets': {
    class: 'unchanged',
    why: 'integration.write, admin-only',
  },
  'DELETE /api/integrations/:integration_id': {
    class: 'unchanged',
    why: 'integration.write, admin-only',
  },
  'PUT /api/projects/:project_id/config': { class: 'guarded' },
  'POST /api/projects/:project_id/discovery': { class: 'guarded' },
  'POST /api/projects/:project_id/interview': { class: 'guarded' },
  'POST /api/projects/:project_id/shadow-batches': { class: 'guarded' },
  'GET /api/projects/:project_id/shadow-batches': { class: 'guarded' },
  'GET /api/shadow-batches/:batch_id': { class: 'guarded' },
  'POST /api/projects/:project_id/history-bootstraps': { class: 'guarded' },
  'GET /api/projects/:project_id/history-bootstraps': { class: 'guarded' },
  'POST /api/projects/:project_id/rediscovery': { class: 'guarded' },
  'GET /api/projects/:project_id/rediscovery': { class: 'guarded' },
  'GET /api/projects/:project_id/autonomy': { class: 'guarded' },
  'PUT /api/projects/:project_id/autonomy': { class: 'guarded' },
  'PUT /api/projects/:project_id/budgets': { class: 'guarded' },
  'GET /api/org/budgets': {
    class: 'unchanged',
    why: 'the organisation’s caps; names no project (item 5)',
  },
  'PUT /api/org/budgets': {
    class: 'unchanged',
    why: 'the organisation’s caps; names no project (item 5)',
  },
  'GET /api/org': { class: 'unchanged', why: 'the organisation’s settings; names no project' },
  'PATCH /api/org': { class: 'unchanged', why: 'the organisation’s settings; names no project' },
  'GET /api/projects/:project_id/audit': { class: 'guarded' },
  'GET /api/org/stats': { class: 'list', why: 'filtered in SQL by the caller’s set (item 3)' },
  'GET /api/org/stats.csv': { class: 'list', why: 'filtered in SQL by the caller’s set (item 3)' },
  'GET /api/projects/:project_id/kb/tree': { class: 'guarded' },
  'GET /api/projects/:project_id/kb/doc': { class: 'guarded' },
  'GET /api/projects/:project_id/kb/health': { class: 'guarded' },
  'GET /api/projects/:project_id/kb/proposals': { class: 'guarded' },
  'POST /api/projects/:project_id/kb/proposals/:proposal_id/:decision': { class: 'guarded' },
  'GET /api/projects/:project_id/ticket-search': { class: 'guarded' },
  'POST /api/projects/:project_id/tasks': { class: 'guarded' },
  'GET /api/tasks/:task_id': { class: 'guarded' },
  'GET /api/tasks/:task_id/export': { class: 'guarded' },
  'GET /api/artifacts/:artifact_id': { class: 'guarded' },
  'GET /api/tasks/:task_id/pipeline': { class: 'guarded' },
  'GET /api/projects/:project_id/pipeline': { class: 'guarded' },
  'POST /api/tasks/:task_id/ask': { class: 'guarded' },
  'GET /api/tasks/:task_id/asks': { class: 'guarded' },
  'GET /api/tasks/:task_id/audit': { class: 'guarded' },
  'GET /api/tasks/:task_id/breakdown': { class: 'guarded' },
  'POST /api/tasks/:task_id/breakdown/decide': { class: 'guarded' },
  'POST /api/tasks/:task_id/pause': { class: 'guarded' },
  'POST /api/tasks/:task_id/resume': { class: 'guarded' },
  'POST /api/tasks/:task_id/budget': { class: 'guarded' },
  'POST /api/tasks/:task_id/owner': { class: 'guarded' },
  'POST /api/tasks/:task_id/ticket-sync/retry': { class: 'guarded' },
  'POST /api/tasks/:task_id/cancel': { class: 'guarded' },
  'POST /api/tasks/:task_id/retry-stage': { class: 'guarded' },
  'POST /api/tasks/:task_id/return-to-stage': { class: 'guarded' },
  'POST /api/tasks/:task_id/rework': { class: 'guarded' },
  'POST /api/tasks/:task_id/feedback': { class: 'guarded' },
  'POST /api/tasks/:task_id/questions/:question_id/answer': { class: 'guarded' },
  'POST /api/tasks/:task_id/approvals/:approval_id/decide': { class: 'guarded' },
  'POST /api/tasks/:task_id/take-over': { class: 'guarded' },
  'POST /api/tasks/:task_id/hand-back': { class: 'guarded' },
  'POST /api/runs/:run_id/retry': { class: 'guarded' },
  'POST /api/runs/:run_id/cancel': { class: 'guarded' },
  'POST /api/runs/:run_id/steer': { class: 'guarded' },
  'GET /api/runs/:run_id': { class: 'guarded' },
  'GET /api/runs/:run_id/messages': { class: 'guarded' },
  'GET /api/runs/:run_id/prompt': { class: 'guarded' },
  'GET /api/runs/:run_id/commands': { class: 'guarded' },
  'GET /api/runs/:run_id/context-pack': { class: 'guarded' },
  'GET /api/runs/:run_id/settings': { class: 'guarded' },
  'GET /api/runs/:run_id/transcript.jsonl': { class: 'guarded' },
  'GET /api/runs/:run_id/export.tar': { class: 'guarded' },
  'GET /events': { class: 'stream', why: 'sse/topic-access.ts and the hub filter (item 7)' },
  'POST /events/subscriptions': {
    class: 'stream',
    why: 'sse/topic-access.ts and the hub filter (item 7)',
  },
  'GET /openapi.json': { class: 'unchanged', why: 'the API document; names no project' },
  'POST /webhooks/:provider/:integrationId': {
    class: 'unchanged',
    why: 'acts for no user (item 5)',
  },
};

/** The families whose every route is about one project (item 2). */
const PROJECT_FAMILIES = [
  '/api/projects/:project_id',
  '/api/tasks/:task_id',
  '/api/runs/:run_id',
  '/api/artifacts/:artifact_id',
  '/api/shadow-batches/:batch_id',
] as const;

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    config: loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'http://localhost:8080',
    }),
    logger: createLogger({ level: 'silent', format: 'json', role: 'all' }),
    metrics: createMetrics({ defaultMetrics: false }),
    // No request is made: the census reads the route table the router was built with.
    database: {} as Database,
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response('{}', { status: 200 }),
    } as unknown as Auth,
    hub: new SseHub({
      bufferSize: 4,
      maxQueuedFrames: 8,
      maxTopicsPerConnection: 4,
      maxBufferedTopics: 8,
      retryMs: 1_000,
      pingIntervalMs: 0,
      maxConnections: 2,
      shutdownDrainMs: 100,
    }),
    // Registered so the census sees the webhook door; nothing here delivers to it.
    webhooks: {} as never,
    knowledge: null,
    onboarding: null,
    shadow: null,
    shadowGate: null,
    organisationCredentials: null,
    projectSettings: {
      forProject: async () => {
        throw new Error('this census reads no project settings');
      },
    },
    historyBootstrap: null,
    historyBootstrapGate: null,
    rediscoveryGate: null,
    commands: null,
    asks: {
      commands: null,
      queries: { listAsks: async () => [], taskAudit: async () => [] },
    },
    breakdown: null,
    setupState: { firstSignInPending: async () => true },
    version: { version: '0.0.0-test', commit: null, builtAt: null },
    readiness: async () => ({ status: 'ok', checks: {} }),
    isShuttingDown: () => false,
  });
});

afterAll(async () => {
  await app?.close();
});

/** The router's table as `METHOD url` → guarded, `HEAD` left out (asserted separately). */
const served = (): Map<string, boolean> => {
  const routes = new Map<string, boolean>();
  for (const route of app.registeredRoutes) {
    for (const method of route.methods) {
      if (method !== 'HEAD') {
        routes.set(`${method} ${route.url}`, route.visibilityGuarded);
      }
    }
  }
  return routes;
};

describe('the visibility census (BD-035, TD-022 visibility amendment item 8)', () => {
  it('classifies every registered route, and nothing that is not registered', () => {
    const routes = served();
    expect([...routes.keys()].filter((key) => VISIBILITY_CLASSES[key] === undefined)).toEqual([]);
    expect(Object.keys(VISIBILITY_CLASSES).filter((key) => !routes.has(key))).toEqual([]);
    // Positive control: the census is reading a real router, not an empty table.
    expect(routes.size).toBeGreaterThan(100);
  });

  it('has a HEAD only beside a GET of the same path', () => {
    const gets = new Set(
      app.registeredRoutes
        .filter((route) => route.methods.includes('GET'))
        .map((route) => route.url),
    );
    const heads = app.registeredRoutes
      .filter((route) => route.methods.includes('HEAD'))
      .map((route) => route.url);
    expect(heads.length).toBeGreaterThan(0);
    expect(heads.filter((url) => !gets.has(url))).toEqual([]);
  });

  it('calls a route guarded exactly when a hook of it asks visibility first', () => {
    const routes = served();
    const mismatched = [...routes].filter(
      ([key, guarded]) => (VISIBILITY_CLASSES[key]?.class === 'guarded') !== guarded,
    );
    expect(mismatched).toEqual([]);
    expect([...routes.values()].some((guarded) => guarded)).toBe(true);
  });

  it('guards every route of the five project-shaped families', () => {
    const unguarded = [...served()].filter(
      ([key, guarded]) =>
        PROJECT_FAMILIES.some((family) => key.split(' ')[1]?.startsWith(family) === true) &&
        !guarded,
    );
    expect(unguarded).toEqual([]);
  });

  it('gives every class but guarded a reason, and every construction route a test that exists', () => {
    const construction = Object.entries(VISIBILITY_CLASSES).filter(
      ([, entry]) => entry.class === 'construction',
    );
    expect(construction.length).toBe(3);
    for (const [key, entry] of Object.entries(VISIBILITY_CLASSES)) {
      if (entry.class === 'guarded') {
        expect(entry.why, key).toBeUndefined();
        continue;
      }
      expect(entry.why?.length ?? 0, key).toBeGreaterThan(0);
    }
    for (const [key, entry] of construction) {
      const [file, test] = (entry.why ?? '').split(' › ');
      expect(file !== undefined && existsSync(join(repositoryRoot, file)), key).toBe(true);
      expect(readSource(file ?? ''), key).toContain(test ?? 'no test named');
    }
  });
});
