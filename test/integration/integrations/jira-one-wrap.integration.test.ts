/**
 * **One Jira port call, one executor entry** — WP-212 (PROGRESS backlog 550, the audit half).
 *
 * The pipeline wraps every ticket call in `IntegrationActionExecutor` (`pipeline/integrations.ts`)
 * and, until WP-212, the Jira adapter wrapped its own members in the same executor instance under
 * the same `integrations.id`. Backlog 550's slot half (`df01f9b1`) made the inner call re-entrant,
 * so it spent no second token; what stayed was the audit — two `integration_actions` rows for one
 * read, three for a transition (`transition_ticket`, `resolve_transition`, `transition`). Measured
 * on this file before the adapter changed: the read case counted **2** rows, the transition case
 * **3**, and the token case **one** token per port call (the brief's "two tokens" predates
 * `df01f9b1`).
 *
 * Everything here is the production composition except the network: a real `integrations` row,
 * the real `PostgresIntegrationAuditLog` and `PostgresIdempotencyStore`, the production rate-limit
 * resolver (`pipelineRateLimitPolicy`), the shipped registry (`createPipelineProviderRegistry`) and
 * the pipeline's own `ticketReads`/`ticketWrites`. The transport is the fixture replay double
 * (`test/contract/support/integrations/jira-cloud-replay.ts`), stubbed as the global `fetch` the
 * shipped registration uses; the clock is a virtual timer, so a token wait is a recorded sleep.
 *
 * **Canary:** give the adapter back an executor call of its own around a member (the pre-WP-212
 * shape, the registry handing it this executor) and the cases fail counting 2, 3 and 13 rows.
 */
import { randomUUID } from 'node:crypto';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createVirtualTimer,
  noSecretsRedactor,
  type PipelineIntegrations,
  ticketReads,
  ticketWrites,
  type VirtualTimer,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
} from '@platform/infrastructure';
import {
  createPipelineProviderRegistry,
  JIRA_CLOUD_RATE_LIMIT_POLICY,
  pipelineRateLimitPolicy,
} from '@platform/integrations';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createJiraReplay,
  JIRA_REPLAY_EMAIL,
  JIRA_REPLAY_NOW,
  JIRA_REPLAY_SITE,
  JIRA_REPLAY_TOKEN,
  type JiraReplay,
} from '../../contract/support/integrations/jira-cloud-replay.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const TICKET = { provider: 'jira-cloud', key: 'ACME-1', url: `${JIRA_REPLAY_SITE}/browse/ACME-1` };
const READ_CONTEXT = { projectId: null, taskId: null } as const;

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('jira_one_wrap');
  pool = createTestPool(database.connectionString, { max: 4 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('jira one wrap') returning id",
  );
  orgId = org.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query(
    'truncate integration_actions, integration_idempotency, events, event_dispatch, event_streams cascade',
  );
  await pool.query('delete from integrations');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Composed {
  readonly integrations: PipelineIntegrations;
  readonly integrationId: Id;
  readonly replay: JiraReplay;
  readonly timer: VirtualTimer;
}

/** `apps/server/src/pipeline.ts`'s integration stack, with the replay double as the network. */
const compose = async (): Promise<Composed> => {
  const { rows } = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config)
       values ($1, 'task_management'::integration_type, 'jira-cloud', 'acme jira', $2::jsonb)
     returning id`,
    [orgId, JSON.stringify({ site_url: JIRA_REPLAY_SITE })],
  );
  const integrationId = rows[0]?.id as Id;
  const replay = createJiraReplay();
  vi.stubGlobal('fetch', replay.fetch);
  const timer = createVirtualTimer({ autoAdvance: true });
  const clock = fixedClock(JIRA_REPLAY_NOW as `${string}T${string}`, 0);
  const executor = createIntegrationActionExecutor({
    auditLog: integrationAdapters.createPostgresIntegrationAuditLog({
      unitOfWork: eventing.unitOfWork,
      eventStore: eventing.store,
      ids: { next: () => randomUUID() as Id },
    }),
    idempotencyStore: integrationAdapters.createPostgresIdempotencyStore({ sql: pool }),
    egress: allowAnyIntegrationHost(),
    redactor: noSecretsRedactor(),
    timer,
    clock,
    rateLimits: pipelineRateLimitPolicy,
  });
  const port = createPipelineProviderRegistry({ clock, timer })
    .get('task_management', 'jira-cloud')
    .create({
      integrationId,
      config: { site_url: JIRA_REPLAY_SITE, user_email: JIRA_REPLAY_EMAIL, project_keys: ['ACME'] },
      secrets: { api_token: JIRA_REPLAY_TOKEN },
      redactor: noSecretsRedactor(),
    });
  return {
    integrations: {
      executor,
      git: null,
      // The loader's shape: the pipeline's ref **is** the adapter's (`bindings/loader.ts`).
      taskManagement: { port, ref: port.ref, redactor: noSecretsRedactor() },
      communication: null,
    },
    integrationId,
    replay,
    timer,
  };
};

const auditRows = async (): Promise<readonly { action: string; status: string }[]> => {
  const { rows } = await pool.query<{ action: string; status: string }>(
    'select action, status from integration_actions order by created_at, action, status',
  );
  return rows;
};

describe('one Jira port call through the production executor (WP-212, backlog 550)', () => {
  it('writes one audit row for a ticket read, which is three provider requests', async () => {
    const { integrations, replay } = await compose();

    const ticket = await ticketReads(integrations).ticket(TICKET, READ_CONTEXT);

    expect(ticket?.ref.key).toBe('ACME-1');
    // Rule 10: the port call really made several requests, so one row is one *port* call.
    expect(replay.requests.length).toBeGreaterThanOrEqual(3);
    expect(await auditRows()).toEqual([{ action: 'read_ticket', status: 'ok' }]);
  });

  it('writes one audit row for a transition that resolves and then moves', async () => {
    const { integrations, replay } = await compose();

    const moved = await ticketWrites(integrations).transition(TICKET, 'In Progress', {
      mode: 'normal',
      projectId: null,
      taskId: null,
      causeEventId: null,
      idempotencyKey: 'wp212:transition:one-row',
    });

    expect(moved).toEqual({ changed: true, from: 'To pick up', to: 'In Progress' });
    expect(replay.requests.map((request) => request.method)).toContain('POST');
    expect(await auditRows()).toEqual([{ action: 'transition_ticket', status: 'ok' }]);
  });

  it('spends one rate-limit token per port call: the Jira burst serves exactly that many calls', async () => {
    const { integrations, timer } = await compose();
    const burst = JIRA_CLOUD_RATE_LIMIT_POLICY.capacity;

    // One write and `capacity - 1` reads fill the bucket only if each spends one token.
    await ticketWrites(integrations).transition(TICKET, 'In Progress', {
      mode: 'normal',
      projectId: null,
      taskId: null,
      causeEventId: null,
      idempotencyKey: 'wp212:transition:token',
    });
    for (let call = 1; call < burst; call += 1) {
      await ticketReads(integrations).selfIdentity(READ_CONTEXT);
    }
    expect(timer.sleeps, 'no call waited for a token inside the burst').toEqual([]);

    // Rule 10: the counter is live — the next call is the one that waits for a refill.
    await ticketReads(integrations).selfIdentity(READ_CONTEXT);
    expect(timer.sleeps).toHaveLength(1);
    expect(await auditRows()).toHaveLength(burst + 1);
  });

  it('performs a retried port call under the same idempotency key once (criterion 3)', async () => {
    const { integrations, replay } = await compose();
    const context = {
      mode: 'normal',
      projectId: null,
      taskId: null,
      causeEventId: null,
      idempotencyKey: 'wp212:transition:retried',
    } as const;

    const first = await ticketWrites(integrations).transition(TICKET, 'In Progress', context);
    replay.resetRequests();
    const again = await ticketWrites(integrations).transition(TICKET, 'In Progress', context);

    expect(again).toEqual(first);
    expect(replay.requests, 'the retry reached nothing').toEqual([]);
    expect(await auditRows()).toEqual([
      { action: 'transition_ticket', status: 'ok' },
      { action: 'transition_ticket', status: 'replayed' },
    ]);
  });
});
