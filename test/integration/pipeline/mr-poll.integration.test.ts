/**
 * The merge-request poller against a real PostgreSQL 18 — WP-110, PROGRESS backlog 297.
 *
 * The unit tier drives the poll against doubles. What only a database can answer is here:
 *
 *  - **which bindings poll** — `listPolling` reads `poll_enabled` out of `bindings.config` over
 *    `integrations.config` for **git** bindings only, and `mr_poll_cursor` (migration 0068) moves
 *    forward only, apart from the ticket poller's `poll_cursor`;
 *  - **the lifecycle read the dedup stands on** — `createPostgresMergeRequestLifecycle` answers
 *    what the stream reader answers, and the planner can serve it from `events_mr_lifecycle_idx`;
 *  - **criterion 2** — a poll records `mr.opened` on the real `inbox(provider, delivery_id)` key, a
 *    second poll appends **nothing**, and a webhook delivery of the same event, through the real
 *    ingress, is deduplicated by the log rather than by a key no listing can carry — in both orders.
 *
 * Everything below the poller is production code: the pipeline's binding loader reads
 * `bindings`/`integrations` and decrypts `secrets` under a real envelope, the fake git provider is
 * reached **through its registration** (so the binding's config decides its `pollPlan()`), the
 * executor audits the read, and the inbox, the event log and the lifecycle read are the PostgreSQL
 * adapters. A review started by a poll and a task finished by a polled merge are the e2e tier's
 * (`test/e2e/pipeline/mr-poll.e2e.test.ts`).
 */
import { randomUUID } from 'node:crypto';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createStreamMergeRequestLifecycle,
  createVirtualTimer,
  createWebhookIngress,
  exactSecretRedactor,
  type Jobs,
  type MergeRequestPollerOptions,
  pollMergeRequestBinding,
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
  createFakeGitProvider,
  createInboundIntegrationLoader,
  createIntegrationRegistry,
  createPipelineIntegrationsLoader,
  FAKE_GIT_PROVIDER_ID,
  fakeGitRegistration,
} from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Obviously fake. The binding's credential, which the fake's registration checks it was given. */
const TOKEN = 'FAKE-mr-poll-binding-token-not-a-real-one';
const SECRET_KEY = 'integration-test-secret-key-not-a-real-one-0000';
const PROJECT_PATH = 'acme/api';

/** The polled account's id — the fake's `ref` is fixed when it is built, so the row carries it. */
const POLLED_INTEGRATION = '00000000-0000-4000-8000-0000000000a1' as Id;

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let orgId: string;
let projectId: Id;
let integrationId: Id;

const git = createFakeGitProvider({
  integrationId: POLLED_INTEGRATION,
  projects: [{ path: PROJECT_PATH, defaultBranch: 'main' }],
  // The fake's clock starts at the wall clock, so a first poll's window (the last interval) holds
  // the merge requests opened below.
  clockStart: new Date().toISOString(),
});

const registry = () =>
  createIntegrationRegistry([fakeGitRegistration({ port: git, token: TOKEN })]);
const store = () => pipelineAdapters.createPostgresMergeRequestPollStore({ sql: pool });
const lifecycle = () => integrationAdapters.createPostgresMergeRequestLifecycle({ sql: pool });
const now = () => new Date().toISOString() as IsoDateTime;

const noJobs: Jobs = {
  defineQueue: async () => {},
  enqueue: async () => {
    throw new Error('pollMergeRequestBinding enqueues nothing; the handler re-arms');
  },
  scheduleCron: async () => {},
  unscheduleCron: async () => {},
  listCronSchedules: async () => [],
  work: async () => {
    throw new Error('not a worker');
  },
};

const pollerOptions = (): MergeRequestPollerOptions => ({
  jobs: noJobs,
  store: store(),
  integrations: createPipelineIntegrationsLoader({
    repository: secretAdapters.createPostgresBindingRepository(pool, accountOnlyFieldsOf),
    secrets: secretAdapters.createPostgresSecretStore({
      sql: pool,
      key: secretAdapters.deriveSecretKey(SECRET_KEY),
    }),
    registry: registry(),
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor: exactSecretRedactor([]),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now },
    }),
    platformRedactor: redactionAdapters.patternRedactor(),
    gitProjectPath: async () => PROJECT_PATH,
  }),
  recorder: {
    inbox: integrationAdapters.createPostgresInboxStore({ sql: pool }),
    unitOfWork: eventing.unitOfWork,
    eventStore: eventing.store,
    mergeRequests: lifecycle(),
    ids: { next: () => randomUUID() as Id },
    clock: { now },
  },
  clock: { now },
  sweepIntervalMs: 60_000,
});

/** The webhook door of the same account, composed as `apps/server` composes it. */
const ingress = () =>
  createWebhookIngress({
    rateLimit: null,
    loader: createInboundIntegrationLoader({
      repository: secretAdapters.createPostgresBindingRepository(pool, accountOnlyFieldsOf),
      secrets: secretAdapters.createPostgresSecretStore({
        sql: pool,
        key: secretAdapters.deriveSecretKey(SECRET_KEY),
      }),
      registry: registry(),
      platformRedactor: redactionAdapters.patternRedactor(),
    }),
    inbox: integrationAdapters.createPostgresInboxStore({ sql: pool }),
    audit: integrationAdapters.createPostgresInboundAuditLog({ sql: pool }),
    identities: integrationAdapters.createPostgresIdentityDirectory({ sql: pool }),
    threads: integrationAdapters.createPostgresThreadDirectory({ sql: pool }),
    decisions: {
      apply: async () => {
        throw new Error('a merge-request delivery produced a human decision');
      },
    },
    unitOfWork: eventing.unitOfWork,
    eventStore: eventing.store,
    mergeRequests: lifecycle(),
    ids: { next: () => randomUUID() as Id },
    clock: { now },
    timer: { now: () => Date.now() },
  });

const bind = async (options: {
  readonly id?: Id;
  readonly type?: string;
  readonly integrationConfig?: JsonObject;
  readonly bindingConfig?: JsonObject;
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
      options.type ?? 'git',
      FAKE_GIT_PROVIDER_ID,
      `git ${randomUUID().slice(0, 8)}`,
      JSON.stringify(options.integrationConfig ?? { project: PROJECT_PATH }),
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
  database = await createMigratedDatabase('mr-poll');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('mr-poll') returning id",
  );
  orgId = org.rows[0]?.id as string;
  ({ projectId, integrationId } = await bind({
    id: POLLED_INTEGRATION,
    bindingConfig: { poll_enabled: true, poll_interval_seconds: 3600 },
  }));
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query(
    'truncate inbox, integration_actions, events, event_dispatch, event_streams cascade',
  );
  await pool.query('update bindings set mr_poll_cursor = null');
});

/**
 * The events about one merge request. The fake is shared by the file and a poll lists every merge
 * request updated in its window, so each case reads its own merge request's events only.
 */
const eventTypes = async (iid: number) =>
  (
    await pool.query<{ type: string }>(
      `select type from events where (payload -> 'mr') ->> 'iid' = $1 order by position`,
      [String(iid)],
    )
  ).rows.map((row) => row.type);

const inboxIds = async (iid: number) =>
  (
    await pool.query<{ delivery_id: string }>(
      `select delivery_id from inbox
        where delivery_id like $1 or payload::text like $2
        order by received_at`,
      [`%!${iid}@%`, `%"iid": ${iid},%`],
    )
  ).rows.map((row) => row.delivery_id);

const openMergeRequest = (branch: string) =>
  git.openMergeRequest({
    project: PROJECT_PATH,
    branch,
    target: 'main',
    title: `A human's ${branch}`,
    description: '',
    draft: false,
    labels: [],
    reviewers: [],
    remove_source_branch: true,
  });

describe('which git bindings poll, and where each one’s window starts', () => {
  it('lists a git binding whose merged config switches polling on, and no task-management one', async () => {
    const byAccount = await bind({
      integrationConfig: { project: PROJECT_PATH, poll_enabled: true },
    });
    const overridden = await bind({
      integrationConfig: { project: PROJECT_PATH, poll_enabled: true },
      bindingConfig: { poll_enabled: false },
    });
    const tickets = await bind({ type: 'task_management', bindingConfig: { poll_enabled: true } });

    const listed = (await store().listPolling(100)).map((binding) => binding.projectId);

    expect(listed).toContain(projectId);
    expect(listed).toContain(byAccount.projectId);
    expect(listed).not.toContain(overridden.projectId);
    expect(listed).not.toContain(tickets.projectId);
  });

  it('moves mr_poll_cursor forward only, and never the ticket poller’s cursor', async () => {
    const binding = { projectId, integrationId };
    expect(await store().cursorOf(binding)).toBeNull();
    await store().advanceCursor(binding, '2026-06-01T10:05:00.000Z' as IsoDateTime);
    await store().advanceCursor(binding, '2026-06-01T10:00:00.000Z' as IsoDateTime);
    expect(await store().cursorOf(binding)).toBe('2026-06-01T10:05:00.000Z');
    const { rows } = await pool.query<{ poll_cursor: Date | null }>(
      'select poll_cursor from bindings where project_id = $1',
      [projectId],
    );
    expect(rows[0]?.poll_cursor).toBeNull();
  });
});

describe('the lifecycle read (migration 0068)', () => {
  it('answers what the stream reader answers, newest first, per merge request', async () => {
    const mr = await openMergeRequest('feature/lifecycle');
    await ingress().deliver({
      provider: FAKE_GIT_PROVIDER_ID,
      integrationId,
      transport: 'http',
      delivery: git.emitMergeRequestEvent({
        event: 'mr.opened',
        project: PROJECT_PATH,
        iid: mr.ref.iid,
      }),
    });
    await ingress().deliver({
      provider: FAKE_GIT_PROVIDER_ID,
      integrationId,
      transport: 'http',
      delivery: git.emitMergeRequestEvent({
        event: 'mr.closed',
        project: PROJECT_PATH,
        iid: mr.ref.iid,
      }),
    });
    const key = { projectId, projectPath: PROJECT_PATH, iid: mr.ref.iid };
    const stream = createStreamMergeRequestLifecycle(eventing.store);

    expect(await lifecycle().latest(key)).toBe('mr.closed');
    expect(await stream.latest(key)).toBe('mr.closed');
    expect(await lifecycle().latest({ ...key, iid: 9999 })).toBeNull();
    expect(await lifecycle().latest({ ...key, projectPath: 'acme/other' })).toBeNull();
  });

  it('can be served from events_mr_lifecycle_idx — the partial index’s predicate is implied', async () => {
    // A sequential scan of a near-empty table is what the planner picks on its own, so the question
    // asked is whether the index is usable at all: with sequential scans priced out, the plan names
    // it only if the query's `type in (...)` implies the index's predicate.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `explain ${integrationAdapters.MERGE_REQUEST_LIFECYCLE_SQL}`,
        [projectId, '7', PROJECT_PATH],
      );
      // An index on a partitioned table is one index per partition, each named after its partition
      // and attached to the parent's — so the plan is checked for one of those.
      const attached = await client.query<{ relname: string }>(
        `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'events_mr_lifecycle_idx'::regclass`,
      );
      const plan = rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(attached.rows.length).toBeGreaterThan(0);
      expect(
        attached.rows.some((row) => plan.includes(row.relname)),
        `the plan uses no partition of events_mr_lifecycle_idx:\n${plan}`,
      ).toBe(true);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('a poll over the fake git provider (WP-110 criterion 2)', () => {
  it('records mr.opened, appends nothing on a second poll, and deduplicates the webhook of the same open', async () => {
    const binding = { projectId, integrationId };
    const mr = await openMergeRequest('feature/opened');

    const first = await pollMergeRequestBinding(pollerOptions(), binding);

    expect(first).toMatchObject({ kind: 'polled' });
    expect(await eventTypes(mr.ref.iid)).toEqual(['mr.opened', 'mr.updated']);
    expect(await inboxIds(mr.ref.iid)).toEqual([
      expect.stringMatching(
        new RegExp(`^${FAKE_GIT_PROVIDER_ID}:poll:${projectId}:${PROJECT_PATH}!${mr.ref.iid}@`),
      ),
    ]);
    expect(await store().cursorOf(binding)).not.toBeNull();

    const second = await pollMergeRequestBinding(pollerOptions(), binding);

    expect(second).toMatchObject({ kind: 'polled', recorded: 0 });
    expect(await eventTypes(mr.ref.iid)).toEqual(['mr.opened', 'mr.updated']);

    // The provider's webhook of the same open arrives afterwards: a delivery id of its own, so a
    // row of its own — and no second `mr.opened`, because the log already holds it.
    const outcome = await ingress().deliver({
      provider: FAKE_GIT_PROVIDER_ID,
      integrationId,
      transport: 'http',
      delivery: git.emitMergeRequestEvent({
        event: 'mr.opened',
        project: PROJECT_PATH,
        iid: mr.ref.iid,
      }),
    });

    expect(outcome).toMatchObject({ kind: 'accepted', events: 0 });
    expect(await inboxIds(mr.ref.iid)).toHaveLength(2);
    expect(await eventTypes(mr.ref.iid)).toEqual(['mr.opened', 'mr.updated']);
  });

  it('deduplicates the other order too: a merge the webhook reported is not appended by a poll', async () => {
    const binding = { projectId, integrationId };
    const mr = await openMergeRequest('feature/merged');
    await pollMergeRequestBinding(pollerOptions(), binding);

    await ingress().deliver({
      provider: FAKE_GIT_PROVIDER_ID,
      integrationId,
      transport: 'http',
      delivery: git.emitMergeRequestEvent({
        event: 'mr.merged',
        project: PROJECT_PATH,
        iid: mr.ref.iid,
      }),
    });
    expect(await eventTypes(mr.ref.iid)).toContain('mr.merged');
    const polled = await pollMergeRequestBinding(pollerOptions(), binding);

    expect(polled).toMatchObject({ kind: 'polled' });
    expect(polled.kind === 'polled' && polled.listed).toBeGreaterThan(0);
    expect((await eventTypes(mr.ref.iid)).filter((type) => type === 'mr.merged')).toHaveLength(1);
  });
});

describe('a poll-only binding’s rows (WP-123, migration 0074)', () => {
  it('keeps the default branch’s last-seen head on the binding, apart from both cursors', async () => {
    const binding = { projectId, integrationId };
    const other = await bind({ bindingConfig: { poll_enabled: true } });
    await pool.query('update bindings set mr_poll_default_head = null');

    expect(await store().defaultHeadOf(binding)).toEqual({ branch: 'main', head: null });
    await store().recordDefaultHead(binding, '1'.repeat(40), 'main');
    await store().recordDefaultHead(binding, '2'.repeat(40), 'main');

    expect(await store().defaultHeadOf(binding)).toEqual({ branch: 'main', head: '2'.repeat(40) });
    expect(await store().defaultHeadOf(other)).toEqual({ branch: 'main', head: null });
    // WP-142: a head of a branch that is not the stored default branch is not written.
    await store().recordDefaultHead(binding, '4'.repeat(40), 'develop');
    expect(await store().defaultHeadOf(binding)).toEqual({ branch: 'main', head: '2'.repeat(40) });
    const row = await pool.query<{ poll_cursor: Date | null; mr_poll_cursor: Date | null }>(
      'select poll_cursor, mr_poll_cursor from bindings where project_id = $1',
      [projectId],
    );
    expect(row.rows[0]).toEqual({ poll_cursor: null, mr_poll_cursor: null });
    // A binding that no longer exists reads null and writes nothing.
    const gone = { projectId: randomUUID() as Id, integrationId };
    await store().recordDefaultHead(gone, '3'.repeat(40), 'main');
    expect(await store().defaultHeadOf(gone)).toBeNull();
  });

  it('lists the project’s tasks waiting at Ready with a merge request, by their current entry, oldest first', async () => {
    const { projectId: project, integrationId: integration } = await bind({});
    const mrRef = (iid: number) => ({
      provider: FAKE_GIT_PROVIDER_ID,
      project_path: PROJECT_PATH,
      iid,
      url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
    });
    const task = async (
      key: string,
      state: string,
      mr: JsonObject | null,
      entries: readonly string[],
    ): Promise<string> => {
      const inserted = await pool.query<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode,
                            state, current_stage, stage_attempts, mr_ref)
           values ($1, 'fake-task-management', $2, 'https://tickets.example.test/x', 'feature',
                   'normal', $3, 'ready_for_merge', $4::jsonb, $5::jsonb)
           returning id`,
        [project, key, state, JSON.stringify({ ready_for_merge: entries.length }), mr],
      );
      const id = inserted.rows[0]?.id as string;
      for (const [index, at] of entries.entries()) {
        await pool.query(
          `insert into task_stages (task_id, stage, attempt, state, entered_at, exited_at)
             values ($1, 'ready_for_merge', $2, $3, $4::timestamptz, $5)`,
          [
            id,
            index + 1,
            index + 1 === entries.length ? 'running' : 'returned',
            at,
            index + 1 === entries.length ? null : at,
          ],
        );
      }
      return id;
    };
    // Entered Ready twice: the **second** entry is the one its notes are read from.
    const twice = await task('ACME-1', 'ready_for_merge', mrRef(1), [
      '2026-06-01T08:00:00.000Z',
      '2026-06-01T10:00:00.123456Z',
    ]);
    const first = await task('ACME-2', 'ready_for_merge', mrRef(2), ['2026-06-01T09:00:00.000Z']);
    await task('ACME-3', 'active', mrRef(3), ['2026-06-01T07:00:00.000Z']);
    await task('ACME-4', 'ready_for_merge', null, ['2026-06-01T07:00:00.000Z']);

    const binding = { projectId: project, integrationId: integration };
    const ready = await store().readyMergeRequests(binding, 10);

    expect(ready.map((entry) => [entry.taskId, entry.mr.iid, entry.enteredAt])).toEqual([
      [first, 2, '2026-06-01T09:00:00.000000Z'],
      // The database's own microseconds, never a `Date`'s milliseconds.
      [twice, 1, '2026-06-01T10:00:00.123456Z'],
    ]);
    expect(await store().readyMergeRequests(binding, 1)).toHaveLength(1);
    // Another project's waiting task is not this binding's.
    expect(await store().readyMergeRequests({ projectId, integrationId }, 10)).toEqual([]);
  });
});
