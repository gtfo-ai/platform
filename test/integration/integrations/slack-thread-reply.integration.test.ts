/**
 * **A Slack thread reply answers its question, through the webhook door, on a real PostgreSQL 18**
 * (WP-88, PROGRESS backlog 195 and 199).
 *
 * Until WP-88 the only map from a Slack thread to its task was the adapter's own memory, and the
 * binding loader builds a fresh adapter for every delivery (Q55): a reply was always "a reply in a
 * thread this binding did not open". Here everything below `WebhookIngress.deliver` — the door
 * `POST /webhooks/:provider/:integrationId` hands the raw body to — is production code: the binding
 * loader reads `integrations`/`bindings` and decrypts `secrets` under the real envelope, the Slack
 * adapter is built by its real registration **per delivery**, the signature is Slack's, and the
 * thread is resolved from the `chat_threads` row and the question's `notifications` row the notify
 * duty writes (written here through the production `NotificationStore`, the duty's own writer). The
 * answer is decided by the real Question aggregate over the PostgreSQL pipeline store, and the
 * outcome is read back from the rows (rule 79), in both directions (rule 42): an unmapped author
 * changes nothing and is recorded, a mapped one answers — once — and leaves one `human_actions`
 * row in the route's vocabulary.
 */
import { randomUUID } from 'node:crypto';
import {
  createInboundDecisionApplier,
  createWebhookIngress,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
  notify,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import {
  accountOnlyFieldsOf,
  createInboundIntegrationLoader,
  createIntegrationRegistry,
  slackProviderRegistration,
  slackSignatureHeaders,
} from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Obviously fake (BD-002). */
const SECRET_KEY = 'integration-test-secret-key-not-a-real-one-0000';
const SLACK_SECRETS = {
  bot_token: 'xoxb-FAKE-thread-reply-bot-token-DO-NOT-USE',
  app_token: 'xapp-FAKE-thread-reply-app-token-DO-NOT-USE',
  signing_secret: 'fake-thread-reply-signing-secret-do-not-use',
} as const;
const TEAM = 'T0FAKETEAM1';
const CHANNEL = 'C0FAKECHAN1';
const THREAD_TS = '1780000000.000100';
const QUESTION_TS = '1780000001.000200';
const MAPPED = 'U0FAKEPO0001';
const STRANGER = 'U0FAKESTRA01';

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let integrationId: Id;
let projectId: Id;
let taskId: Id;
let questionId: Id;
let userId: Id;

const ingressFor = () =>
  createWebhookIngress({
    rateLimit: null,
    loader: createInboundIntegrationLoader({
      repository: secretAdapters.createPostgresBindingRepository(pool, accountOnlyFieldsOf),
      secrets: secretAdapters.createPostgresSecretStore({
        sql: pool,
        key: secretAdapters.deriveSecretKey(SECRET_KEY),
      }),
      registry: createIntegrationRegistry([slackProviderRegistration]),
      platformRedactor: redactionAdapters.patternRedactor(),
    }),
    inbox: integrationAdapters.createPostgresInboxStore({ sql: pool }),
    audit: integrationAdapters.createPostgresInboundAuditLog({ sql: pool }),
    identities: integrationAdapters.createPostgresIdentityDirectory({ sql: pool }),
    threads: integrationAdapters.createPostgresThreadDirectory({ sql: pool }),
    decisions: createInboundDecisionApplier({
      store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
      roles: integrationAdapters.createPostgresDeciderRoles(),
      actions: integrationAdapters.createPostgresHumanActionLog(),
      context: (correlationId: Id) => ({
        ids: { next: (): Id => randomUUID() as Id },
        actor: { kind: 'system', component: 'pipeline' },
        clock: { now: () => new Date().toISOString() as IsoDateTime },
        correlationId,
        causeEventId: null,
      }),
    }),
    unitOfWork: eventing.unitOfWork,
    eventStore: eventing.store,
    mergeRequests: integrationAdapters.createPostgresMergeRequestLifecycle({ sql: pool }),
    ids: { next: () => randomUUID() as Id },
    clock: { now: () => new Date().toISOString() as IsoDateTime },
    timer: { now: () => Date.now() },
  });

let replyCounter = 0;
/** Slack's `event_callback` for a message typed in `threadTs`, signed as Slack signs one. */
const reply = (author: string, text: string, threadTs = THREAD_TS) => {
  replyCounter += 1;
  const body = JSON.stringify({
    token: 'not-read-by-this-adapter',
    team_id: TEAM,
    api_app_id: 'A0FAKEAPP01',
    type: 'event_callback',
    event_id: `Ev0FAKEREPLY${String(replyCounter).padStart(4, '0')}`,
    event_time: 1_780_000_010 + replyCounter,
    event: {
      type: 'message',
      channel: CHANNEL,
      user: author,
      text,
      ts: `17800000${String(10 + replyCounter).padStart(2, '0')}.000900`,
      thread_ts: threadTs,
      channel_type: 'channel',
    },
  });
  return {
    headers: slackSignatureHeaders({
      secret: SLACK_SECRETS.signing_secret,
      timestampSeconds: Math.floor(Date.now() / 1000),
      body,
    }),
    body,
  };
};

const deliver = (delivery: { headers: Record<string, string>; body: string }) =>
  ingressFor().deliver({ provider: 'slack', integrationId, delivery, transport: 'http' });

beforeAll(async () => {
  database = await createMigratedDatabase('slack-thread-reply');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });

  const key = secretAdapters.deriveSecretKey(SECRET_KEY);
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('thread-reply') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  projectId = (
    await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
         values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [orgId],
    )
  ).rows[0]?.id as Id;
  userId = (
    await pool.query<{ id: string }>(
      "insert into users (email, name, role) values ('po@example.test', 'Fake PO', 'member') returning id",
    )
  ).rows[0]?.id as Id;
  await pool.query(
    `insert into user_identities (provider, external_id, user_id, display_name)
     values ('slack', $1, $2, 'po')`,
    [MAPPED, userId],
  );

  const secretIds: string[] = [];
  for (const [field, value] of Object.entries(SLACK_SECRETS)) {
    const secretId = randomUUID();
    await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
      secretId,
      secretAdapters.sealSecret(key, secretAdapters.secretDocument(field, value), secretId),
      key.keyId,
    ]);
    secretIds.push(secretId);
  }
  integrationId = (
    await pool.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name, config, secret_ids)
         values ($1, 'communication'::integration_type, 'slack', 'chat', $2::jsonb, $3::uuid[])
       returning id`,
      [orgId, JSON.stringify({ channel: CHANNEL, team_id: TEAM, socket_mode: false }), secretIds],
    )
  ).rows[0]?.id as Id;
  await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
    projectId,
    integrationId,
  ]);
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

/**
 * A fresh task with one open question, and what the notify duty leaves behind when it posts the
 * question through `postQuestion`: the thread's row and the question's address — written by the
 * production `NotificationStore`, in a transaction of their own, as the duty writes them.
 */
beforeEach(async () => {
  await pool.query(
    'truncate inbox, integration_actions, events, event_dispatch, event_streams, human_actions, notifications, chat_threads, questions, tasks cascade',
  );
  taskId = (
    await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode, state)
       values ($1, 'fake-jira', 'ACME-1', 'https://tickets.example.test/browse/ACME-1',
               'feature', 'normal', 'waiting_answers') returning id`,
      [projectId],
    )
  ).rows[0]?.id as Id;
  questionId = (
    await pool.query<{ id: string }>(
      `insert into questions (task_id, stage, text, blocking, status)
       values ($1, 'refinement', 'Which currency should totals use?', true, 'open') returning id`,
      [taskId],
    )
  ).rows[0]?.id as Id;

  const store = notify.createPostgresNotificationStore();
  const client = await pool.connect();
  try {
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    const id = randomUUID() as Id;
    await store.record(tx, {
      id,
      projectId,
      taskId,
      questionId,
      notificationClass: 'question',
      causeEventId: randomUUID() as Id,
      title: 'ACME-1 is waiting for an answer',
      detail: 'Which currency should totals use?',
      url: null,
      urgent: false,
      plannedDelivery: 'immediate',
      mode: 'normal',
      createdAt: new Date().toISOString() as IsoDateTime,
      redactionCount: 0,
    });
    await store.markDelivered(tx, {
      id,
      at: new Date().toISOString() as IsoDateTime,
      via: 'immediate',
      messageRef: {
        provider: 'slack',
        channel: CHANNEL,
        message_id: QUESTION_TS,
        thread_id: THREAD_TS,
        url: null,
      },
    });
    await store.recordThread(tx, {
      projectId,
      integrationId,
      taskId,
      channel: CHANNEL,
      threadId: THREAD_TS,
      at: new Date().toISOString() as IsoDateTime,
    });
    await client.query('commit');
  } finally {
    client.release();
  }
});

const questionRow = async () =>
  (
    await pool.query<{
      status: string;
      answer: string | null;
      answered_by_user_id: string | null;
      answered_via: string | null;
    }>('select status, answer, answered_by_user_id, answered_via from questions where id = $1', [
      questionId,
    ])
  ).rows[0];

const humanActions = async () =>
  (
    await pool.query<{ action: string; user_id: string; task_id: string; params: JsonObject }>(
      'select action, user_id, task_id, params from human_actions order by created_at',
    )
  ).rows;

const inboxErrors = async () =>
  (
    await pool.query<{ error: string | null }>(
      "select error from inbox where provider = 'slack' order by received_at",
    )
  ).rows.map((row) => row.error);

describe('a reply in the thread of a question’s message (WP-88)', () => {
  it('answers the question for a mapped person, once, and leaves one audit row', async () => {
    const outcome = await deliver(reply(MAPPED, 'EUR everywhere, please'));
    expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'accepted', events: 1 });

    expect(await questionRow()).toEqual({
      status: 'answered',
      answer: 'EUR everywhere, please',
      answered_by_user_id: userId,
      answered_via: 'slack',
    });
    const answered = await pool.query<{ stream_type: string; stream_id: string; actor: unknown }>(
      "select stream_type, stream_id, actor from events where type = 'task.question.answered'",
    );
    expect(answered.rows).toEqual([
      expect.objectContaining({
        stream_type: 'question',
        stream_id: questionId,
        actor: expect.objectContaining({ kind: 'user', user_id: userId }),
      }),
    ]);

    // Backlog 199: the route's action and keys, the door named, and none of the answer's words.
    const [row, ...others] = await humanActions();
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      action: 'task.question.answer',
      user_id: userId,
      task_id: taskId,
      params: {
        task_id: taskId,
        question_id: questionId,
        channel: 'slack',
        provider: 'slack',
        integration_id: integrationId,
      },
    });
    expect(typeof row?.params.delivery_id).toBe('string');
    expect(JSON.stringify(row)).not.toContain('EUR');

    // A second reply is not a second answer: the question is no longer open, so the thread has
    // none to answer and the reply is feedback — the answer and the audit stay as they were.
    const second = await deliver(reply(MAPPED, 'actually CZK'));
    expect(second).toMatchObject({ kind: 'accepted', events: 1 });
    expect((await questionRow())?.answer).toBe('EUR everywhere, please');
    expect(await humanActions()).toHaveLength(1);
    const types = await pool.query<{ type: string }>('select type from events order by position');
    expect(types.rows.map((event) => event.type)).toEqual([
      'task.question.answered',
      'feedback.received',
    ]);
  });

  it('changes nothing for an unmapped author, and records who on the delivery', async () => {
    const outcome = await deliver(reply(STRANGER, 'CZK'));
    expect(outcome).toMatchObject({ kind: 'accepted', events: 0 });
    expect((await questionRow())?.status).toBe('open');
    expect(await humanActions()).toEqual([]);
    const stored = await pool.query<{ error: string; unmapped_identities: unknown }>(
      "select error, unmapped_identities from inbox where provider = 'slack'",
    );
    expect(stored.rows[0]?.error).toContain('unmapped_identity');
    expect(stored.rows[0]?.unmapped_identities).toEqual([
      { provider: 'slack', external_id: STRANGER },
    ]);
  });

  it('answers nothing when two questions are open in the thread, and records why (review round 1)', async () => {
    // A stage opens one blocking question per artifact draft: a second question, posted into the
    // same thread by the production store, as the notify duty posts it.
    const second = (
      await pool.query<{ id: string }>(
        `insert into questions (task_id, stage, text, blocking, status)
         values ($1, 'refinement', 'Which rounding?', true, 'open') returning id`,
        [taskId],
      )
    ).rows[0]?.id as Id;
    const store = notify.createPostgresNotificationStore();
    const client = await pool.connect();
    try {
      await client.query('begin');
      const tx = { adapter: 'postgres', client } as unknown as Transaction;
      const id = randomUUID() as Id;
      await store.record(tx, {
        id,
        projectId,
        taskId,
        questionId: second,
        notificationClass: 'question',
        causeEventId: randomUUID() as Id,
        title: 'ACME-1 is waiting for an answer',
        detail: 'Which rounding?',
        url: null,
        urgent: false,
        plannedDelivery: 'immediate',
        mode: 'normal',
        createdAt: new Date().toISOString() as IsoDateTime,
        redactionCount: 0,
      });
      await store.markDelivered(tx, {
        id,
        at: new Date().toISOString() as IsoDateTime,
        via: 'immediate',
        messageRef: {
          provider: 'slack',
          channel: CHANNEL,
          message_id: '1780000002.000300',
          thread_id: THREAD_TS,
          url: null,
        },
      });
      await client.query('commit');
    } finally {
      client.release();
    }

    const outcome = await deliver(reply(MAPPED, 'EUR'));
    expect(outcome).toMatchObject({ kind: 'accepted', events: 0 });
    const statuses = await pool.query<{ status: string }>(
      'select status from questions where task_id = $1',
      [taskId],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(['open', 'open']);
    expect(await humanActions()).toEqual([]);
    expect((await inboxErrors()).at(-1)).toContain('2 open questions names none of them');
  });

  it('reaches nothing in a thread the platform never opened', async () => {
    const outcome = await deliver(reply(MAPPED, 'EUR', '1780000099.000100'));
    expect(outcome).toMatchObject({ kind: 'accepted', events: 0 });
    expect((await questionRow())?.status).toBe('open');
    expect((await inboxErrors()).at(-1)).toContain('reply in a thread this binding did not open');
  });

  it('is feedback once the question is no longer open', async () => {
    await pool.query("update questions set status = 'expired' where id = $1", [questionId]);
    const outcome = await deliver(reply(MAPPED, 'sorry, late'));
    expect(outcome).toMatchObject({ kind: 'accepted', events: 1 });
    const types = await pool.query<{ type: string }>('select type from events');
    expect(types.rows.map((event) => event.type)).toEqual(['feedback.received']);
    expect(await humanActions()).toEqual([]);
  });
});
