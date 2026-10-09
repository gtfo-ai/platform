/**
 * The ticket poller against a real PostgreSQL 18 — WP-87, PROGRESS backlog 187.
 *
 * The unit tier drives the poll against doubles. What only a database can answer is here:
 *
 *  - **which bindings poll** — `listPolling` reads `poll_enabled` out of `bindings.config` over
 *    `integrations.config` (the overlay the loader applies), for task-management bindings only;
 *  - **the cursor moves forward only** — `advanceCursor` is a `greatest` in the statement, so a late
 *    writer cannot move it back (migration 0061);
 *  - **a polled match lands on the real `inbox(provider, delivery_id)` key**, redacted, in the same
 *    transaction as its events — and a second poll of the same ticket appends **nothing**, because
 *    the key collides in the database rather than in a Map (criterion 1's second half).
 *
 * Everything below the poller is production code: the pipeline's binding loader reads
 * `bindings`/`integrations` and decrypts `secrets` under a real envelope, the fake task manager is
 * reached **through its registration** (so the binding's own config decides its `pollPlan()`), the
 * executor audits the read, and the inbox and event log are the PostgreSQL adapters. That a poll
 * *starts a task*, and that a webhook and a poll of one ticket start it once in either order, is the
 * e2e tier's (`test/e2e/pipeline/ticket-poll.e2e.test.ts`), because it needs the whole pipeline.
 */
import { randomUUID } from 'node:crypto';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  type Jobs,
  pollTicketBinding,
  type TicketPollerOptions,
} from '@platform/application';
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import {
  accountOnlyFieldsOf,
  createFakeTaskManagement,
  createIntegrationRegistry,
  createPipelineIntegrationsLoader,
  FAKE_TASK_MANAGEMENT_PROVIDER_ID,
  fakeTaskManagementRegistration,
} from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Obviously fake. The binding's credential, which the fake's registration checks it was given. */
const TOKEN = 'FAKE-ticket-poll-binding-token-not-a-real-one';
const SECRET_KEY = 'integration-test-secret-key-not-a-real-one-0000';
/** Planted in a ticket link, so the stored row can be searched for it. */
const PLANTED = 'glpat-FAKEPLANTEDpolltoken0123456789';

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let orgId: string;
let projectId: Id;
let integrationId: Id;

/**
 * The polled account's id. A fake's `ref` is fixed when it is built and the loader hands that `ref`
 * on, so the row is seeded with the same id — the poller checks the binding still points at the
 * integration its job names, and a fake answering another id would read as a re-pointed binding.
 */
const POLLED_INTEGRATION = '00000000-0000-4000-8000-0000000000a2' as Id;

const tickets = createFakeTaskManagement({
  integrationId: POLLED_INTEGRATION,
  // The fake's clock starts at the wall clock, so a first poll's window (the last interval) holds
  // the tickets seeded below.
  clockStart: new Date().toISOString(),
});

const store = () => pipelineAdapters.createPostgresTicketPollStore({ sql: pool });

const noJobs: Jobs = {
  defineQueue: async () => {},
  enqueue: async () => {
    throw new Error('pollTicketBinding enqueues nothing; the handler re-arms');
  },
  scheduleCron: async () => {},
  unscheduleCron: async () => {},
  listCronSchedules: async () => [],
  work: async () => {
    throw new Error('not a worker');
  },
};

const pollerOptions = (): TicketPollerOptions => ({
  jobs: noJobs,
  store: store(),
  integrations: createPipelineIntegrationsLoader({
    repository: secretAdapters.createPostgresBindingRepository(pool, accountOnlyFieldsOf),
    secrets: secretAdapters.createPostgresSecretStore({
      sql: pool,
      key: secretAdapters.deriveSecretKey(SECRET_KEY),
    }),
    registry: createIntegrationRegistry([
      fakeTaskManagementRegistration({ port: tickets, token: TOKEN }),
    ]),
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor: exactSecretRedactor([]),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => new Date().toISOString() as IsoDateTime },
    }),
    platformRedactor: redactionAdapters.patternRedactor(),
    gitProjectPath: async () => 'acme/api',
  }),
  recorder: {
    inbox: integrationAdapters.createPostgresInboxStore({ sql: pool }),
    unitOfWork: eventing.unitOfWork,
    eventStore: eventing.store,
    mergeRequests: integrationAdapters.createPostgresMergeRequestLifecycle({ sql: pool }),
    ids: { next: () => randomUUID() as Id },
    clock: { now: () => new Date().toISOString() as IsoDateTime },
  },
  clock: { now: () => new Date().toISOString() as IsoDateTime },
  sweepIntervalMs: 60_000,
});

const bind = async (options: {
  readonly id?: Id;
  readonly integrationConfig?: JsonObject;
  readonly bindingConfig?: JsonObject;
  readonly type?: string;
}): Promise<{ projectId: Id; integrationId: Id }> => {
  const key = secretAdapters.deriveSecretKey(SECRET_KEY);
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'Polled', 'https://git.example.test/acme/api.git') returning id`,
    [orgId, `p${randomUUID().slice(0, 8)}`],
  );
  const secretId = randomUUID();
  await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    secretId,
    secretAdapters.sealSecret(key, secretAdapters.secretDocument('token', TOKEN), secretId),
    key.keyId,
  ]);
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (id, org_id, type, provider, name, config, secret_ids)
       values ($7, $1, $2::integration_type, $3, $4, $5::jsonb, $6::uuid[]) returning id`,
    [
      orgId,
      options.type ?? 'task_management',
      FAKE_TASK_MANAGEMENT_PROVIDER_ID,
      `tickets ${randomUUID().slice(0, 8)}`,
      JSON.stringify(options.integrationConfig ?? {}),
      [secretId],
      options.id ?? randomUUID(),
    ],
  );
  const ids = {
    projectId: project.rows[0]?.id as Id,
    integrationId: integration.rows[0]?.id as Id,
  };
  await pool.query(
    'insert into bindings (project_id, integration_id, config) values ($1, $2, $3::jsonb)',
    [ids.projectId, ids.integrationId, JSON.stringify(options.bindingConfig ?? {})],
  );
  return ids;
};

beforeAll(async () => {
  database = await createMigratedDatabase('ticket-poll');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('poll') returning id",
  );
  orgId = org.rows[0]?.id as string;
  ({ projectId, integrationId } = await bind({
    id: POLLED_INTEGRATION,
    bindingConfig: { poll_enabled: true, poll_interval_seconds: 3600 },
  }));
  tickets.seedTicket({
    key: 'ACME-1',
    title: 'Show the totals',
    labels: ['agentic'],
    links: [
      {
        kind: 'relates_to',
        key: 'ACME-2',
        url: `https://tickets.example.test/browse/ACME-2?t=${PLANTED}`,
        state: null,
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query('truncate inbox, events, event_dispatch, event_streams cascade');
  await pool.query('update bindings set poll_cursor = null');
});

const inboxRows = async () =>
  (
    await pool.query<{ delivery_id: string; payload: JsonObject; redaction_count: number }>(
      'select delivery_id, payload, redaction_count from inbox order by received_at',
    )
  ).rows;

const eventTypes = async () =>
  (await pool.query<{ type: string }>('select type from events order by position')).rows.map(
    (row) => row.type,
  );

describe('which bindings poll', () => {
  it('lists a task-management binding whose merged config switches polling on, and no other', async () => {
    const byAccount = await bind({ integrationConfig: { poll_enabled: true } });
    const overridden = await bind({
      integrationConfig: { poll_enabled: true },
      bindingConfig: { poll_enabled: false },
    });
    const off = await bind({});
    const notTickets = await bind({ type: 'git', bindingConfig: { poll_enabled: true } });

    const listed = (await store().listPolling(100)).map((binding) => binding.projectId);

    expect(listed).toContain(projectId);
    // The account's switch reaches a binding that says nothing …
    expect(listed).toContain(byAccount.projectId);
    // … and a binding's own `false` wins over it, because the binding is merged over the account.
    expect(listed).not.toContain(overridden.projectId);
    expect(listed).not.toContain(off.projectId);
    expect(listed).not.toContain(notTickets.projectId);
  });
});

describe('the cursor', () => {
  it('moves forward only, whatever order the writers land in', async () => {
    const binding = { projectId, integrationId };
    expect(await store().cursorOf(binding)).toBeNull();
    await store().advanceCursor(binding, '2026-06-01T10:05:00.000Z' as IsoDateTime);
    await store().advanceCursor(binding, '2026-06-01T10:00:00.000Z' as IsoDateTime);
    expect(await store().cursorOf(binding)).toBe('2026-06-01T10:05:00.000Z');
  });
});

describe('a poll over the fake provider', () => {
  it('records the match on the inbox key, redacted, with its events — and a second poll appends nothing', async () => {
    const binding = { projectId, integrationId };

    const first = await pollTicketBinding(pollerOptions(), binding);

    expect(first).toMatchObject({ kind: 'polled', matched: 1, recorded: 1 });
    expect(await eventTypes()).toEqual(['ticket.matched', 'ticket.updated']);
    const [row] = await inboxRows();
    expect(row?.delivery_id).toMatch(
      new RegExp(`^${FAKE_TASK_MANAGEMENT_PROVIDER_ID}:poll:${projectId}:ACME-1@`),
    );
    // TD-012 step 2 reaches the poll's row as it reaches a webhook's: the planted token is gone.
    expect(JSON.stringify(row?.payload)).not.toContain(PLANTED);
    expect(row?.redaction_count).toBeGreaterThanOrEqual(1);
    const events = await pool.query<{ payload: JsonObject }>('select payload from events');
    expect(JSON.stringify(events.rows)).not.toContain(PLANTED);
    expect(await store().cursorOf(binding)).not.toBeNull();

    const second = await pollTicketBinding(pollerOptions(), binding);

    expect(second).toMatchObject({ kind: 'polled', matched: 1, recorded: 0, duplicates: 1 });
    expect(await eventTypes()).toEqual(['ticket.matched', 'ticket.updated']);
    expect(await inboxRows()).toHaveLength(1);
  });

  it('records an edit found by a later poll as ticket.updated (criterion 2)', async () => {
    const binding = { projectId, integrationId };
    await pollTicketBinding(pollerOptions(), binding);

    // A human edits the ticket: the fake applies it and moves `updated_at`. The delivery it also
    // builds is never sent — this binding has no webhook in this case.
    tickets.emitTicketUpdated({
      ticketKey: 'ACME-1',
      description: 'Now with acceptance criteria.',
    });
    await pollTicketBinding(pollerOptions(), binding);

    expect(await eventTypes()).toEqual([
      'ticket.matched',
      'ticket.updated',
      'ticket.matched',
      'ticket.updated',
    ]);
    expect(await inboxRows()).toHaveLength(2);
  });
});

/**
 * WP-110, PROGRESS backlog 298: a **status** pick-up rule stops matching a ticket the moment the
 * platform's status mapping moves it on. The poll re-reads the binding's live tasks' tickets — the
 * `tasks` rows the store's `liveTickets` answers — and records an edit to one as
 * `ticket.updated` only. That the stamp then lands on the live task is the e2e tier's
 * (`test/e2e/pipeline/ticket-poll.e2e.test.ts`), because it needs the dispatcher.
 */
describe('a status-rule binding’s live tasks (WP-110, backlog 298)', () => {
  it('records an edit to a ticket the rule no longer matches as ticket.updated, never ticket.matched', async () => {
    const binding = { projectId, integrationId };
    await pool.query(
      `update bindings
          set config = config || '{"pickup_status": "To pick up"}'::jsonb
        where project_id = $1 and integration_id = $2`,
      [projectId, integrationId],
    );
    try {
      // The platform already moved ACME-7 on: it is Doing, so the status rule finds nothing.
      tickets.seedTicket({ key: 'ACME-7', title: 'Moved on', status: 'Doing' });
      await pool.query(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state, current_stage)
           values ($1, $2, 'ACME-7', 'https://tickets.example.test/browse/ACME-7', 'feature', 'active', 'implementation')`,
        [projectId, FAKE_TASK_MANAGEMENT_PROVIDER_ID],
      );
      // A human edits the ticket.
      tickets.emitTicketUpdated({ ticketKey: 'ACME-7', description: 'Now with criteria.' });

      const report = await pollTicketBinding(pollerOptions(), binding);

      expect(report).toMatchObject({
        kind: 'polled',
        matched: 0,
        live: { asked: 1, matched: 1, recorded: 1, failed: false },
      });
      expect(await eventTypes()).toEqual(['ticket.updated']);
      const [row] = await inboxRows();
      expect(row?.delivery_id).toMatch(
        new RegExp(`^${FAKE_TASK_MANAGEMENT_PROVIDER_ID}:poll:${projectId}:ACME-7@`),
      );

      // The next poll: nothing changed, nothing appended.
      await pollTicketBinding(pollerOptions(), binding);
      expect(await eventTypes()).toEqual(['ticket.updated']);
    } finally {
      await pool.query(`delete from tasks where project_id = $1`, [projectId]);
      await pool.query(
        `update bindings set config = config - 'pickup_status'
          where project_id = $1 and integration_id = $2`,
        [projectId, integrationId],
      );
    }
  });
});

/**
 * WP-145, PROGRESS backlog 437: the live re-read asks a task's ticket by the issue id the task
 * recorded (migration 0077), so `liveTickets` answers one row per **issue** — by its id where a task
 * has one, by its key where none does — and never asks the old key of a task that knows its id.
 */
describe('the live tasks’ tickets, by id where the task recorded one (WP-145, backlog 437)', () => {
  it('answers one row per issue: by id for tasks that carry one, by key for those that do not', async () => {
    const binding = { projectId, integrationId };
    try {
      await pool.query(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state, current_stage, mode, ticket_id)
           values ($1, $2, 'OLD-1', 'https://tickets.example.test/browse/OLD-1', 'feature', 'active', 'implementation', 'normal', '10001'),
                  ($1, $2, 'OLD-1', 'https://tickets.example.test/browse/OLD-1', 'feature', 'active', 'implementation', 'shadow', '10001'),
                  ($1, $2, 'ACME-9', 'https://tickets.example.test/browse/ACME-9', 'feature', 'active', 'implementation', 'normal', null),
                  ($1, $2, 'DONE-1', 'https://tickets.example.test/browse/DONE-1', 'feature', 'done', null, 'normal', '10003')`,
        [projectId, FAKE_TASK_MANAGEMENT_PROVIDER_ID],
      );
      const live = await store().liveTickets(binding, FAKE_TASK_MANAGEMENT_PROVIDER_ID, 10);
      expect(live.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: 'ACME-9', id: null },
        { key: 'OLD-1', id: '10001' },
      ]);
    } finally {
      await pool.query(`delete from tasks where project_id = $1`, [projectId]);
    }
  });
});
