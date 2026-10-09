/**
 * The bindings pair and the statuses read, driven through Fastify against plain functions (WP-181).
 *
 * What the routes decide is held here: the capability each asks (401 anonymous, 403 below the role),
 * the statuses read answered against the **fake** tracker through the real executor door
 * (`createTicketStatusReader` → `ticketReads(...).statuses`), its 503 when the tracker cannot be
 * read, and — criterion (2) — that the bindings write runs the real lifecycle check
 * (`checkProposedLifecycles`, with the write's real refusals in front of it) **before** it saves:
 * a slot outside the loaded set is `422 lifecycle_status_unknown` naming the slot, an unreachable
 * tracker is `503 lifecycle_statuses_unavailable`, and either leaves the stored bindings exactly as
 * they were with no audit row. The statements are `onboarding-queries.ts`'s.
 *
 * Every status name here is invented and neutral (the product owner's rule); no tracker is called.
 */
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createIntegrationEgressPolicy,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  IntegrationError,
  type PipelineIntegrationsPort,
  silentLogger,
  staticPipelineIntegrations,
  type TaskManagementPort,
} from '@platform/application';
import type {
  Id,
  IsoDateTime,
  JsonObject,
  ProjectBindingSummary,
  UserRole,
} from '@platform/contracts';
import { createFakeTaskManagement } from '@platform/integrations';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { checkProposedLifecycles, readProposedAccountIdentities } from '../lifecycle-check.js';
import {
  assertBindingItemsWritable,
  type BindingAccountRow,
} from '../queries/onboarding-queries.js';
import { createTicketStatusReader } from '../ticket-statuses.js';
import { registerProjectBindingRoutes } from './project-bindings.js';

const PROJECT = '00000000-0000-4000-8000-000000000f01';
const USER = '00000000-0000-4000-8000-000000000f03';
const JIRA = '00000000-0000-4000-8000-000000000f11' as Id;
const SITE_HOST = 'acme-example.atlassian.net';

/** The tracker's workflow — invented, neutral names. */
const WORKFLOW = [
  { name: 'Ready for the agent', rawCategory: 'new' },
  { name: 'Doing', rawCategory: 'indeterminate' },
  { name: 'Waiting for review', rawCategory: 'indeterminate' },
  { name: 'Testing', rawCategory: 'indeterminate' },
  { name: 'Sent back', rawCategory: 'indeterminate' },
  { name: 'Finished', rawCategory: 'done' },
];

const ACCOUNT: BindingAccountRow = {
  id: JIRA,
  type: 'task_management',
  provider: 'jira-cloud',
  name: 'acme jira',
  config: {
    site_url: `https://${SITE_HOST}`,
    user_email: 'bot@example.test',
    project_keys: ['ACME'],
  },
  secretIds: [],
  retiredAt: null,
};

const GITLAB = '00000000-0000-4000-8000-000000000f12' as Id;
const GIT_HOST = 'git.example.test';

/** A GitLab account with WP-137's static run credential: bound by one project only. */
const STATIC_GITLAB: BindingAccountRow = {
  id: GITLAB,
  type: 'git',
  provider: 'gitlab',
  name: 'acme gitlab',
  config: {
    base_url: `https://${GIT_HOST}`,
    project: 'acme/api',
    run_credential: 'static',
    run_token_username: 'agentic-runner',
    run_token_expires_at: '2026-12-01',
  },
  secretIds: [],
  retiredAt: null,
};

const ACCOUNTS = [ACCOUNT, STATIC_GITLAB];

interface World {
  /** `null` is an anonymous caller. */
  role: UserRole | null;
  /** The tracker answers, refuses, or the project has none. */
  tracker: 'answers' | 'unreachable' | 'none';
  /** `null` is a process with no integration stack. */
  composed: boolean;
  /** Projects other than this one that already bind the static GitLab integration. */
  otherStaticBindings: string[];
}

let app: FastifyInstance;
let world: World;
let stored: Map<string, JsonObject>;
let actions: string[];
let statusReads: number;

const executor = () =>
  createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: createMemoryAuditLog(),
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => '2026-10-09T09:00:00.000Z' as IsoDateTime },
  });

/** The fake tracker, counting its status reads; `unreachable` refuses as a dead host would. */
const tracker = (): TaskManagementPort => {
  const fake = createFakeTaskManagement({ integrationId: JIRA, statuses: WORKFLOW });
  return {
    ...fake,
    listStatuses: async () => {
      statusReads += 1;
      if (world.tracker === 'unreachable') {
        throw new IntegrationError('unavailable', 'fake-task-management', 'connection refused', {
          action: 'list_statuses',
        });
      }
      return fake.listStatuses();
    },
  } as TaskManagementPort;
};

const integrationsPort = (): PipelineIntegrationsPort => {
  const port = tracker();
  const integrations = staticPipelineIntegrations({
    executor: executor(),
    git: null,
    taskManagement:
      world.tracker === 'none' ? null : { port, ref: port.ref, redactor: exactSecretRedactor([]) },
    communication: null,
  });
  return integrations;
};

const build = async (): Promise<void> => {
  world = { role: 'admin', tracker: 'answers', composed: true, otherStaticBindings: [] };
  stored = new Map([[JIRA, { pickup_status: 'Ready for the agent' }]]);
  actions = [];
  statusReads = 0;
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.role !== null) {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        // The organisation role is `viewer`, so the project role decides (`rbac.ts`).
        role: 'viewer',
        sessionId: 'session-1',
      };
    }
  });
  const egress = createIntegrationEgressPolicy([SITE_HOST, GIT_HOST]);
  /** `assertStaticIntegrationBindable`'s two statements: the advisory lock, then the bindings read. */
  const executor = {
    execute: async () => ({
      rows: world.otherStaticBindings.map((projectId) => ({ project_id: projectId })),
    }),
  } as unknown as Parameters<typeof assertBindingItemsWritable>[0];
  // Built per request, so a test may change the world between two calls.
  const reader = () =>
    createTicketStatusReader({ integrations: integrationsPort(), logger: silentLogger });
  await registerProjectBindingRoutes(app, {
    queries: {
      projectRole: async () => world.role,
      projectExists: async (projectId) => projectId === PROJECT,
      listBindings: async (): Promise<readonly ProjectBindingSummary[]> =>
        [...stored.entries()].map(([integrationId, config]) => ({
          integration_id: integrationId as Id,
          type: 'task_management',
          provider: 'jira-cloud',
          name: 'acme jira',
          config,
        })),
      replaceBindings: async (_projectId, items) => {
        // The write's own refusals, as `replaceProjectBindings` makes them inside its transaction.
        await assertBindingItemsWritable(executor, PROJECT, items, ACCOUNTS, egress);
        stored = new Map(items.map((item) => [item.integrationId, item.config ?? {}]));
      },
      recordAction: async (input) => {
        actions.push(input.action);
      },
    },
    checkLifecycles: async (projectId, items) =>
      checkProposedLifecycles(projectId, items, {
        accounts: async (ids) => ACCOUNTS.filter((account) => ids.includes(account.id)),
        assertWritable: async (project, proposed, accounts) =>
          assertBindingItemsWritable(executor, project, proposed, accounts, egress),
        statuses: world.composed ? (id, binding) => reader().proposed(id, binding) : null,
      }),
    readAccountIdentities: async (projectId, items) =>
      readProposedAccountIdentities(projectId, items, {
        accounts: async (ids) => ACCOUNTS.filter((account) => ids.includes(account.id)),
        assertWritable: async (project, proposed, accounts) =>
          assertBindingItemsWritable(executor, project, proposed, accounts, egress),
        account: world.composed ? (id, binding) => reader().proposedAccount(id, binding) : null,
        logger: silentLogger,
      }),
    ticketStatuses: async (projectId) => reader().current(projectId),
  });
};

beforeEach(async () => {
  await build();
});

const getStatuses = () =>
  app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/ticket-statuses` });

const putBindings = (config: JsonObject) =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/${PROJECT}/bindings`,
    payload: { items: [{ integration_id: JIRA, config }] },
  });

describe('GET /api/projects/:id/ticket-statuses (WP-181 criterion (1))', () => {
  it('answers 401 to an anonymous caller', async () => {
    world.role = null;
    expect((await getStatuses()).statusCode).toBe(401);
    expect(statusReads).toBe(0);
  });

  it('answers 403 below maintainer, and reads nothing', async () => {
    world.role = 'member';
    const response = await getStatuses();
    expect(response.statusCode).toBe(403);
    expect(statusReads).toBe(0);
  });

  it('answers 200 with the fake tracker’s statuses for a maintainer', async () => {
    world.role = 'maintainer';
    const response = await getStatuses();
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { name: string }) => item.name)).toEqual(
      WORKFLOW.map((status) => status.name),
    );
    expect(response.json().items[1]).toEqual({
      id: 's-2',
      name: 'Doing',
      category: 'in_progress',
      raw_category: 'indeterminate',
    });
  });

  it('answers 503 lifecycle_statuses_unavailable when the tracker cannot be read, never an empty list', async () => {
    world.role = 'maintainer';
    world.tracker = 'unreachable';
    const response = await getStatuses();
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('lifecycle_statuses_unavailable');
    expect(response.json().error.message).toContain('connection refused');
  });

  it('answers 409 no_task_management_binding when there is no tracker, and 404 for no project', async () => {
    world.role = 'maintainer';
    world.tracker = 'none';
    const response = await getStatuses();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('no_task_management_binding');
    const missing = await app.inject({
      method: 'GET',
      url: '/api/projects/00000000-0000-4000-8000-000000000fff/ticket-statuses',
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('PUT /api/projects/:id/bindings checks the lifecycle block first (WP-181 criterion (2))', () => {
  const MAPPED = {
    pickup_status: 'Ready for the agent',
    lifecycle: {
      in_progress: 'Doing',
      in_review: 'Waiting for review',
      qa: 'testing',
      returned: ['Sent back'],
      done: 'Finished',
    },
  };

  it('saves a block every name of which the tracker lists, compared case-insensitively', async () => {
    const response = await putBindings(MAPPED);
    expect(response.statusCode).toBe(200);
    expect(stored.get(JIRA)).toEqual(MAPPED);
    expect(actions).toEqual(['project.bindings.write']);
    expect(statusReads).toBe(1);
  });

  it('answers 422 lifecycle_status_unknown naming the slot and the name, and saves nothing', async () => {
    const before = new Map(stored);
    const response = await putBindings({
      ...MAPPED,
      lifecycle: {
        ...MAPPED.lifecycle,
        in_review: 'Under review',
        returned: ['Sent back', 'Gone'],
      },
    });
    expect(response.statusCode).toBe(422);
    const error = response.json().error;
    expect(error.code).toBe('lifecycle_status_unknown');
    expect(error.message).toContain('lifecycle.in_review');
    expect(error.message).toContain('"Under review"');
    expect(error.details).toEqual([
      { path: 'lifecycle.in_review', message: expect.stringContaining('in review slot') },
      { path: 'lifecycle.returned[1]', message: expect.stringContaining('"Gone"') },
    ]);
    expect(stored).toEqual(before);
    expect(actions).toEqual([]);
  });

  it('checks pickup_status too, since it is the pick_up_from slot', async () => {
    const response = await putBindings({ ...MAPPED, pickup_status: 'Up next' });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details).toEqual([
      { path: 'pickup_status', message: expect.stringContaining('pick up from slot') },
    ]);
  });

  it('answers 503 lifecycle_statuses_unavailable when the tracker is unreachable, and leaves the stored binding unchanged', async () => {
    world.tracker = 'unreachable';
    const before = new Map(stored);
    const response = await putBindings(MAPPED);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('lifecycle_statuses_unavailable');
    expect(response.json().error.message).toContain('nothing was saved');
    expect(stored).toEqual(before);
    expect(actions).toEqual([]);
  });

  it('answers 503 on a process with no integration stack rather than saving an unchecked block', async () => {
    world.composed = false;
    const response = await putBindings(MAPPED);
    expect(response.statusCode).toBe(503);
    expect(stored.get(JIRA)).toEqual({ pickup_status: 'Ready for the agent' });
  });

  it('needs no tracker for a block that names nothing, or for no block: every slot may be empty', async () => {
    world.tracker = 'unreachable';
    for (const config of [{ lifecycle: { claim: false } }, { pickup_label: 'agentic' }]) {
      const response = await putBindings(config);
      expect(response.statusCode, JSON.stringify(config)).toBe(200);
    }
    expect(statusReads).toBe(0);
  });

  it('refuses what the write refuses before it asks the tracker anything', async () => {
    // A host outside APP_INTEGRATION_HOSTS: refused by the write's own check, never read.
    const elsewhere = await putBindings({ ...MAPPED, site_url: 'https://elsewhere.example.test' });
    expect(elsewhere.statusCode).toBe(403);
    // A slot naming `pickup_status`: the block's sibling rule, refused before the read too.
    const clash = await putBindings({
      ...MAPPED,
      lifecycle: { ...MAPPED.lifecycle, in_progress: 'ready for the agent' },
    });
    expect(clash.statusCode).toBe(400);
    expect(statusReads).toBe(0);
    expect(actions).toEqual([]);
  });

  it('refuses an integration named twice and a static integration bound elsewhere before any read (review round 1)', async () => {
    const twice = await app.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT}/bindings`,
      payload: {
        items: [
          { integration_id: JIRA, config: MAPPED },
          { integration_id: JIRA, config: MAPPED },
        ],
      },
    });
    expect(twice.statusCode).toBe(400);
    expect(twice.json().error.message).toContain('named more than once');
    world.otherStaticBindings = ['00000000-0000-4000-8000-000000000f99'];
    const shared = await app.inject({
      method: 'PUT',
      url: `/api/projects/${PROJECT}/bindings`,
      payload: { items: [{ integration_id: JIRA, config: MAPPED }, { integration_id: GITLAB }] },
    });
    expect(shared.statusCode).toBe(409);
    expect(shared.json().error.code).toBe('static_run_credential_shared');
    expect(statusReads).toBe(0);
    expect(actions).toEqual([]);
  });

  it('answers 403 below admin on the write, and reads nothing', async () => {
    world.role = 'maintainer';
    const response = await putBindings(MAPPED);
    expect(response.statusCode).toBe(403);
    expect(statusReads).toBe(0);
  });
});
