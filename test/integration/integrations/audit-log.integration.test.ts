/**
 * BD-003's audit, against a real PostgreSQL 18 (WP-15b).
 *
 * The unit tier holds the adapter's logic against a hand-rolled transaction; the contract tier runs
 * the two shared port suites against the in-memory fakes. What only a database can answer is here:
 *
 *  - **the row and its event commit together.** A `StreamConflictError` raised by migration 0005's
 *    real trigger, after the `integration_actions` insert has already run inside the same
 *    transaction, must leave **no** row behind. Nothing else in the repository can produce that
 *    ordering, and it is the one property BD-003 rests on ("the audit and the log can never
 *    disagree").
 *  - **the retry works against the real lock.** Two `record` calls racing on one integration stream
 *    both land, with distinct sequences, because the loser re-reads and retries.
 *  - **`redaction_count` in both directions, through the real executor** — the acceptance criterion
 *    of this work package. One action whose redactor holds the credential the payload carries, one
 *    whose redactor holds nothing, and the stored payloads of both are read back. The second row's
 *    zero *is* the finding: the credential is in the row, and the count is the only thing that says
 *    so (standing rule 42 — a boundary asserted from one side is half a test).
 *  - **the migration's `drop default`.** An insert that omits `redaction_count` is refused by the
 *    database, so "nobody wrote the column" cannot be recorded as "nothing was redacted".
 */
import { randomUUID } from 'node:crypto';
import {
  createIntegrationActionExecutor,
  createVirtualTimer,
  exactSecretRedactor,
  type IntegrationActionEntry,
  noSecretsRedactor,
  type SecretRedactor,
  StreamConflictError,
} from '@platform/application';
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
} from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuditLogContractContext,
  auditEntryFor,
  type IdempotencyContractContext,
  runAuditLogContract,
  runIdempotencyStoreContract,
} from '../../contract/support/integrations/audit-contract-suites.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

/** Obviously fake, and long enough for `MIN_SECRET_LENGTH`. */
const PLANTED_CREDENTIAL = 'not-a-real-jira-token-0000000000';

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let integrationId: Id;
let otherIntegrationId: Id;
let projectId: Id;
let taskId: Id;

const insertIntegration = async (orgId: string, name: string): Promise<Id> => {
  const { rows } = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
       values ($1, 'task_management'::integration_type, 'fake-task-management', $2, '{}'::jsonb, '{}'::uuid[])
     returning id`,
    [orgId, name],
  );
  return rows[0]?.id as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('audit-log');
  pool = new pg.Pool({ connectionString: database.connectionString, max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });

  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('audit') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as Id;
  integrationId = await insertIntegration(orgId, 'primary');
  otherIntegrationId = await insertIntegration(orgId, 'secondary');
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state)
       values ($1, 'fake-task-management', 'ACME-1', 'https://tickets.example.test/ACME-1',
               'feature', 'queued')
     returning id`,
    [projectId],
  );
  taskId = task.rows[0]?.id as Id;
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

const truncate = async (): Promise<void> => {
  // `integration_actions` is append-only *for the application role*; this connection is the owner,
  // which is what lets a suite reset between cases.
  await pool.query('truncate integration_actions, events, event_dispatch, event_streams cascade');
  await pool.query('truncate integration_idempotency');
};

const auditLog = () =>
  integrationAdapters.createPostgresIntegrationAuditLog({
    unitOfWork: eventing.unitOfWork,
    eventStore: eventing.store,
    ids: { next: () => randomUUID() as Id },
  });

const rows = async () => {
  // `id` is `uuidv7()` and the adapter never supplies one, so `(created_at, id)` is insertion
  // order — several rows of one case share an `occurred_at`, and ordering by `action` would be
  // alphabetical rather than chronological.
  const { rows: read } = await pool.query<{
    integration_id: Id;
    project_id: Id | null;
    task_id: Id | null;
    action: string;
    status: string;
    payload: JsonObject;
    redaction_count: number;
    attempts: number;
    duration_ms: number | null;
  }>(
    `select integration_id, project_id, task_id, action, status, payload, redaction_count,
            attempts, duration_ms
       from integration_actions order by created_at, id`,
  );
  return read;
};

runAuditLogContract('postgres adapter', async (): Promise<AuditLogContractContext> => {
  await truncate();
  return {
    log: auditLog(),
    rows: async () =>
      (await rows()).map((row) => ({
        integrationId: row.integration_id,
        projectId: row.project_id,
        taskId: row.task_id,
        action: row.action,
        status: row.status as IntegrationActionEntry['status'],
        payload: row.payload,
        redactionCount: row.redaction_count,
        attempts: row.attempts,
        durationMs: row.duration_ms,
      })),
    eventTypes: async () => {
      const { rows: read } = await pool.query<{ type: string }>(
        'select type from events order by position',
      );
      return read.map((row) => row.type);
    },
    integrationId,
    projectId,
    taskId,
    cleanup: truncate,
  };
});

runIdempotencyStoreContract('postgres adapter', async (): Promise<IdempotencyContractContext> => {
  await truncate();
  return {
    store: integrationAdapters.createPostgresIdempotencyStore({ sql: pool }),
    integrationId,
    otherIntegrationId,
    cleanup: truncate,
  };
});

describe('the audit row and its event are one transaction', () => {
  beforeEach(truncate);

  it('leaves no row behind when the append loses the stream sequence', async () => {
    // A sequence that is *already taken*: the first record writes seq 1, and this adapter is built
    // with a read side that always answers 1. Migration 0005's trigger raises 23505, `sql.ts`
    // turns it into a StreamConflictError, and the row inserted moments earlier in the same
    // transaction has to go with it.
    await auditLog().record(auditEntryFor({ integrationId, projectId, taskId }));
    expect(await rows()).toHaveLength(1);

    const stale = integrationAdapters.createPostgresIntegrationAuditLog({
      unitOfWork: eventing.unitOfWork,
      eventStore: { nextStreamSequence: async () => 1 },
      ids: { next: () => randomUUID() as Id },
      maxSequenceAttempts: 1,
    });

    await expect(
      stale.record(auditEntryFor({ integrationId, projectId, taskId }, { action: 'rolled_back' })),
    ).rejects.toBeInstanceOf(StreamConflictError);

    // Still one row — the second insert rolled back with its failed append.
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]?.action).toBe('add_comment');
  });

  it('retries against the real guard when the sequence it read was already taken', async () => {
    // Deterministic, and it has to be: `Promise.all` over two `record` calls does **not** race —
    // measured, the retry can be deleted and two concurrent records still pass, because the second
    // reads its sequence after the first has committed. A test satisfied by both implementations
    // certifies neither (standing rule 3), so the loss is staged instead: the first `record` takes
    // sequence 1, and the read side answers 1 again exactly once. Attempt 1 hits migration 0005's
    // trigger for real, rolls back, re-reads, and lands on 2.
    await auditLog().record(
      auditEntryFor({ integrationId, projectId, taskId }, { action: 'first' }),
    );

    let reads = 0;
    const racing = integrationAdapters.createPostgresIntegrationAuditLog({
      unitOfWork: eventing.unitOfWork,
      eventStore: {
        nextStreamSequence: async (streamType, streamId) => {
          reads += 1;
          return reads === 1 ? 1 : eventing.store.nextStreamSequence(streamType, streamId);
        },
      },
      ids: { next: () => randomUUID() as Id },
    });
    await racing.record(auditEntryFor({ integrationId, projectId, taskId }, { action: 'second' }));

    expect(reads).toBe(2);
    // One row for the losing attempt, not two: the rollback took its insert with it.
    expect((await rows()).map((row) => row.action)).toEqual(['first', 'second']);
    const { rows: events } = await pool.query<{ stream_seq: string; stream_type: string }>(
      'select stream_seq, stream_type from events order by stream_seq',
    );
    expect(events.map((row) => Number(row.stream_seq))).toEqual([1, 2]);
    expect(events.every((row) => row.stream_type === 'integration')).toBe(true);
  });
});

describe('redaction_count, asserted from both sides', () => {
  beforeEach(truncate);

  /** One mutating action through the real executor, with the redactor under test. */
  const performWith = async (redactor: SecretRedactor): Promise<void> => {
    const executor = createIntegrationActionExecutor({
      auditLog: auditLog(),
      redactor,
      timer: createVirtualTimer(),
      clock: { now: () => new Date().toISOString() as IsoDateTime },
    });
    await executor.execute({
      integration: {
        integrationId,
        provider: 'fake-task-management',
        type: 'task_management',
      },
      action: 'add_comment',
      mutating: true,
      mode: 'normal',
      projectId,
      taskId,
      // The credential an adapter would have interpolated into a header or a body. All external
      // text is untrusted (BD-022) and this is the shape TD-012 exists for.
      payload: { authorization: `Bearer ${PLANTED_CREDENTIAL}`, body: 'please review' },
      shadowResult: () => ({ comment_id: '0' }),
      describeResult: (result: { comment_id: string }) => result,
      perform: async () => ({ comment_id: '17' }),
    });
  };

  it('records a non-zero count, and no credential, when the redactor holds the secret', async () => {
    await performWith(exactSecretRedactor([{ name: 'jira_api_token', value: PLANTED_CREDENTIAL }]));
    const row = (await rows())[0];
    expect(row?.redaction_count).toBeGreaterThan(0);
    expect(JSON.stringify(row?.payload)).not.toContain(PLANTED_CREDENTIAL);
    expect(JSON.stringify(row?.payload)).toContain('[REDACTED:integration:jira_api_token]');
    expect(row?.attempts).toBe(1);
  });

  it('records zero when the redactor was told nothing — and the credential is in the row', async () => {
    // The half that certifies the column. Identical payload, identical action, a redactor that
    // knows no secrets: the row is written with the credential verbatim, and `redaction_count` is
    // **0**. That zero next to a payload that plainly carries a token is the only signal an auditor
    // gets that TD-012 did not fire, which is why a test asserting only the non-zero case proves
    // nothing about the column.
    await performWith(noSecretsRedactor());
    const row = (await rows())[0];
    expect(row?.redaction_count).toBe(0);
    expect(JSON.stringify(row?.payload)).toContain(PLANTED_CREDENTIAL);
  });
});

describe('the idempotency store keeps the first result, not the last', () => {
  beforeEach(truncate);

  it('answers a raced second put with the result the first one stored', async () => {
    /**
     * The invariant `postgres-idempotency-store.ts` documents, and which nothing asserted:
     * `on conflict do nothing` rather than `do update`. Measured before this test existed —
     * flipping it to `do update set result = excluded.result` left the whole integration file and
     * the whole contract file green, while the *fake's* opposite behaviour (a second `put` throws)
     * **is** asserted in `memory-integrations.test.ts`. That is standing rule 1 inverted: the fake
     * was held to a promise the real adapter was not, so the real one could drift into being the
     * kinder of the two.
     *
     * It cannot live in the shared suite, because the two implementations legitimately differ here
     * (the fake throws, which is the stricter direction a fake is allowed) — so it is a
     * Postgres-only case, and the fake's divergence register points at it.
     *
     * Why *first* rather than last: the executor only ever writes a key it has just missed, so a
     * conflict means two callers raced through one slot. The winner's result is the one already
     * handed back, and "a replay returns the first call's result" would otherwise depend on who
     * committed last.
     */
    const store = integrationAdapters.createPostgresIdempotencyStore({ sql: pool });
    const scope = { integrationId, action: 'add_comment', key: 'marker-raced' };

    await store.put(scope, { comment_id: 'first' });
    await store.put(scope, { comment_id: 'second' });

    expect(await store.get(scope)).toEqual({ comment_id: 'first' });
    const { rows: stored } = await pool.query<{ count: string }>(
      'select count(*)::text as count from integration_idempotency',
    );
    // And one slot, not two: the conflict was on the key, so the assertion above is about which
    // write won rather than about which row was read back.
    expect(stored[0]?.count).toBe('1');
  });
});

describe('the columns migration 0013 added', () => {
  beforeEach(truncate);

  it('refuses a row that omits redaction_count, because the migration dropped the default', async () => {
    // Without the `alter column … drop default`, this insert would succeed and record a zero —
    // "nobody wrote the column" spelled exactly like "nothing was redacted" (standing rule 18).
    await expect(
      pool.query(
        `insert into integration_actions (integration_id, direction, action, status, attempts)
           values ($1, 'out', 'no_count', 'ok', 1)`,
        [integrationId],
      ),
    ).rejects.toMatchObject({ code: '23502' });
  });

  it('records an action for a task the audit cannot see, because 0013 dropped the foreign key', async () => {
    // The property the dropped constraint buys, as the shape that actually occurs: the caller is
    // still inside its own transaction, so the task it is acting for is invisible to this one. With
    // `integration_actions_task_id_fkey` in place the insert raised 23503 and the *audit* failed the
    // action — measured on the WP-15b e2e, which died on its first event. Restore the constraint and
    // this test dies by name.
    const invisibleTask = randomUUID() as Id;
    await auditLog().record(
      auditEntryFor(
        { integrationId, projectId, taskId: invisibleTask },
        { action: 'read_default_branch', mutating: false },
      ),
    );
    const row = (await rows())[0];
    expect(row?.task_id).toBe(invisibleTask);
    // And the row is honest about what it could not verify: the task id is recorded as given.
    const { rows: tasks } = await pool.query('select id from tasks where id = $1', [invisibleTask]);
    expect(tasks).toHaveLength(0);
  });

  it('refuses a negative count or attempt', async () => {
    await expect(
      pool.query(
        `insert into integration_actions
           (integration_id, direction, action, status, redaction_count, attempts)
         values ($1, 'out', 'negative', 'ok', -1, 1)`,
        [integrationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
