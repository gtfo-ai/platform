/**
 * Q118 (a) through the real routes (WP-181 review round 2): the bindings write reads the account the
 * task-management binding acts as and stores it; `GET …/readiness` names a person's account from
 * what was stored and **calls no provider**.
 *
 * Both route modules are registered on one Fastify instance over one in-memory world: the bindings
 * route with the real lifecycle check and the real account read (`readProposedAccountIdentities` over
 * `createTicketStatusReader` and the fake tracker, through the executor), the readiness route with
 * the real lifecycle classifier (`ticketLifecycleOfRows`). The two SQL statements behind the injected
 * reads — the column write and the `user_identities` join — are the integration tier's.
 */
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createIntegrationEgressPolicy,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  IntegrationError,
  silentLogger,
  staticPipelineIntegrations,
  type TaskManagementPort,
} from '@platform/application';
import type { Id, IsoDateTime, JsonObject, ReadinessResponse } from '@platform/contracts';
import { createFakeTaskManagement } from '@platform/integrations';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import { checkProposedLifecycles, readProposedAccountIdentities } from '../lifecycle-check.js';
import {
  assertBindingItemsWritable,
  type BindingAccountIdentity,
  type BindingAccountRow,
} from '../queries/onboarding-queries.js';
import { ticketLifecycleOfRows } from '../ticket-lifecycle.js';
import { createTicketStatusReader } from '../ticket-statuses.js';
import { registerProjectBindingRoutes } from './project-bindings.js';
import { registerProjectReadinessRoutes } from './project-readiness.js';

const PROJECT = '00000000-0000-4000-8000-000000000e81';
const USER = '00000000-0000-4000-8000-000000000e83';
const JIRA = '00000000-0000-4000-8000-000000000e91' as Id;
const SITE_HOST = 'acme-example.atlassian.net';
/** The account the fake tracker's credential acts as (its `self` seed). */
const ACCOUNT_ID = 'agentic-bot-0181';

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

const EVALUATED: ReadinessResponse = {
  level: 1,
  evaluated_at: '2026-10-09T10:00:00.000Z',
  criteria: [],
  source: 'discovery',
  next_improvements: [],
  notices: [],
};

interface IdentityRow {
  readonly provider: string;
  readonly external_id: string;
  readonly kind: 'person' | 'machine';
  readonly user_id: string | null;
}

interface World {
  /** How the tracker answers `selfIdentity`. */
  self: 'answers' | 'refuses' | 'faults';
  identities: IdentityRow[];
}

let app: FastifyInstance;
let world: World;
let stored: Map<string, { config: JsonObject; accountIdentity: BindingAccountIdentity | null }>;
let trackerCalls: string[];

/** The fake tracker, every member call counted; `selfIdentity` refuses or faults on demand. */
const tracker = (): TaskManagementPort => {
  const fake = createFakeTaskManagement({
    integrationId: JIRA,
    statuses: ['Ready for the agent', 'Doing'],
    self: { providerUserId: ACCOUNT_ID },
  });
  return new Proxy(fake, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || property === 'capabilities' || property === 'ref') {
        return value;
      }
      return (...args: unknown[]) => {
        trackerCalls.push(String(property));
        if (property === 'selfIdentity' && world.self === 'refuses') {
          throw new IntegrationError('unavailable', 'fake-task-management', 'connection refused', {
            action: 'self_identity',
          });
        }
        if (property === 'selfIdentity' && world.self === 'faults') {
          throw new TypeError('a fault no adapter declared');
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as TaskManagementPort;
};

const reader = () => {
  const port = tracker();
  return createTicketStatusReader({
    integrations: staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog: createMemoryAuditLog(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => '2026-10-09T09:00:00.000Z' as IsoDateTime },
      }),
      git: null,
      taskManagement: { port, ref: port.ref, redactor: exactSecretRedactor([]) },
      communication: null,
    }),
    logger: silentLogger,
  });
};

beforeEach(async () => {
  world = { self: 'answers', identities: [] };
  stored = new Map();
  trackerCalls = [];
  app = fastify();
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
  const egress = createIntegrationEgressPolicy([SITE_HOST]);
  const executor = {
    execute: async () => ({ rows: [] }),
  } as unknown as Parameters<typeof assertBindingItemsWritable>[0];
  const accounts = async (ids: readonly string[]) => (ids.includes(JIRA) ? [ACCOUNT] : []);
  const assertWritable = async (
    project: Id,
    proposed: Parameters<typeof assertBindingItemsWritable>[2],
    rows: readonly BindingAccountRow[],
  ) => assertBindingItemsWritable(executor, project, proposed, rows, egress);
  await registerProjectBindingRoutes(app, {
    queries: {
      projectRole: async () => 'admin',
      projectExists: async () => true,
      listBindings: async () => [],
      replaceBindings: async (_projectId, items) => {
        stored = new Map(
          items.map((item) => [
            item.integrationId,
            { config: item.config ?? {}, accountIdentity: item.accountIdentity },
          ]),
        );
      },
      recordAction: async () => {},
    },
    checkLifecycles: async (projectId, items) =>
      checkProposedLifecycles(projectId, items, {
        accounts,
        assertWritable,
        statuses: (id, binding) => reader().proposed(id, binding),
      }),
    readAccountIdentities: async (projectId, items) =>
      readProposedAccountIdentities(projectId, items, {
        accounts,
        assertWritable,
        account: (id, binding) => reader().proposedAccount(id, binding),
        logger: silentLogger,
      }),
    ticketStatuses: null,
  });
  await registerProjectReadinessRoutes(app, {
    queries: {
      projectRole: async () => 'viewer',
      readiness: async () => ({ found: true, recorded: true, response: EVALUATED }),
      ticketLifecycle: async () =>
        ticketLifecycleOfRows(
          [...stored.values()].map((binding) => ({
            provider: 'jira-cloud',
            integration_config: ACCOUNT.config,
            binding_config: binding.config,
          })),
        ),
      // The `user_identities` join, in memory: a person with a user, matched on the stored handle.
      accountIsAPerson: async () =>
        [...stored.values()].some(
          ({ accountIdentity }) =>
            accountIdentity !== null &&
            world.identities.some(
              (row) =>
                row.provider === accountIdentity.provider &&
                row.external_id === accountIdentity.external_id &&
                row.kind === 'person' &&
                row.user_id !== null,
            ),
        ),
    },
  });
});

const save = () =>
  app.inject({
    method: 'PUT',
    url: `/api/projects/${PROJECT}/bindings`,
    payload: {
      items: [{ integration_id: JIRA, config: { pickup_status: 'Ready for the agent' } }],
    },
  });

/** `GET …/readiness`, asserting it made no tracker call at all (the ruling). */
const readiness = async (): Promise<ReadinessResponse> => {
  const before = trackerCalls.length;
  const response = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT}/readiness` });
  expect(response.statusCode).toBe(200);
  expect(trackerCalls.slice(before)).toEqual([]);
  return response.json() as ReadinessResponse;
};

const accountNotes = (response: ReadinessResponse) =>
  response.notices.filter((notice) => notice.code === 'binding_account_is_a_person');

describe('the binding-account note (Q118 (a)) through the routes, stored at save', () => {
  it('stores the account at the save and names a mapped person at the read, with no provider call', async () => {
    world.identities = [
      { provider: 'fake-task-management', external_id: ACCOUNT_ID, kind: 'person', user_id: USER },
    ];
    expect((await save()).statusCode).toBe(200);
    expect(trackerCalls).toContain('selfIdentity');
    expect(stored.get(JIRA)?.accountIdentity).toEqual({
      provider: 'fake-task-management',
      external_id: ACCOUNT_ID,
    });
    const answer = await readiness();
    expect(accountNotes(answer)).toEqual([
      expect.objectContaining({ code: 'binding_account_is_a_person', severity: 'note' }),
    ]);
    expect(answer.level).toBe(EVALUATED.level);
  });

  it('names nothing for a dedicated account: unmapped, or declared a machine', async () => {
    expect((await save()).statusCode).toBe(200);
    expect(stored.get(JIRA)?.accountIdentity).toEqual({
      provider: 'fake-task-management',
      external_id: ACCOUNT_ID,
    });
    expect(accountNotes(await readiness())).toEqual([]);
    world.identities = [
      { provider: 'fake-task-management', external_id: ACCOUNT_ID, kind: 'machine', user_id: null },
    ];
    expect(accountNotes(await readiness())).toEqual([]);
  });

  it.each([
    ['refuses (an IntegrationError)', 'refuses'],
    ['faults (any other throw)', 'faults'],
  ] as const)(
    'stores unknown when selfIdentity %s, and the save still succeeds',
    async (_case, self) => {
      world.self = self;
      world.identities = [
        {
          provider: 'fake-task-management',
          external_id: ACCOUNT_ID,
          kind: 'person',
          user_id: USER,
        },
      ];
      const response = await save();
      expect(response.statusCode).toBe(200);
      expect(trackerCalls).toContain('selfIdentity');
      expect(stored.get(JIRA)?.config).toEqual({ pickup_status: 'Ready for the agent' });
      expect(stored.get(JIRA)?.accountIdentity).toBeNull();
      // Unknown names nothing, and the read still calls no provider.
      expect(accountNotes(await readiness())).toEqual([]);
    },
  );
});
