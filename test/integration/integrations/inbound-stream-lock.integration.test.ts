/**
 * **Two deliveries for one project wait for each other** — BACKLOG 971, against a real
 * PostgreSQL 18.
 *
 * `recordNormalisedDelivery` writes the `inbox` row and the events it produced in one transaction.
 * It used to read the project stream's sequence over the pool, before that transaction, and retry
 * a lost race four times; since BACKLOG 971 it takes the project stream's lock first in the
 * transaction (`scope.events.lockStreamSequence`) and reads the sequence on its own connection.
 *
 * Staged rather than raced, for the reason `project-stream-lock.integration.test.ts` gives: between
 * delivery A's sequence and its append, on **every** attempt, delivery B for the same project is
 * recorded through the same function. Without the lock B commits each time and every attempt of A
 * loses, so A throws after its bound; with it B **waits** — asserted on `pg_locks`, never on a
 * timer — A lands on its first attempt, and B right after it at the next sequence.
 */
import { randomUUID } from 'node:crypto';
import {
  type InboundDecisionApplier,
  type NormalisedDeliveryRecord,
  noSecretsRedactor,
  recordNormalisedDelivery,
  type UnitOfWork,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recentInstant } from '../../support/recent-instant.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const NOW: IsoDateTime = recentInstant();

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let integrationId: Id;
let projectId: Id;

beforeAll(async () => {
  database = await createMigratedDatabase('inbound-stream-lock');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('inbound-lock') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
       values ($1, 'lock', 'Lock', 'https://git.example.test/acme/lock.git') returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as Id;
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
       values ($1, 'git'::integration_type, 'fake-git', 'git', '{}'::jsonb, '{}'::uuid[])
     returning id`,
    [orgId],
  );
  integrationId = integration.rows[0]?.id as Id;
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

/** No delivery here carries a human decision, so the applier is never asked. */
const noDecisions: InboundDecisionApplier = {
  apply: async () => {
    throw new Error('no delivery in this file carries a decision');
  },
};

/** One delivery for the project, carrying one project-stream event its actor names. */
const delivery = (name: string): NormalisedDeliveryRecord => ({
  provider: 'fake-git',
  deliveryId: `fake-git:${name}:${randomUUID()}`,
  integrationId,
  redactor: noSecretsRedactor(),
  headers: { value: {}, count: 0 },
  payload: { value: { name }, count: 0 },
  normalised: [],
  byProject: [
    {
      projectId,
      drafts: [
        {
          type: 'knowledge.index.rebuilt',
          payload: {
            project_id: projectId,
            commit_sha: 'abc1234',
            documents: 1,
            chunks: 1,
            tokens: 1,
          },
          actor: { kind: 'system', component: name },
        },
      ],
    },
  ],
});

const options = (unitOfWork: UnitOfWork) => ({
  inbox: integrationAdapters.createPostgresInboxStore({ sql: pool }),
  decisions: noDecisions,
  unitOfWork,
  ids: { next: () => randomUUID() as Id },
  clock: { now: () => NOW },
  mergeRequests: integrationAdapters.createPostgresMergeRequestLifecycle({ sql: pool }),
});

/** Resolves once some backend of this test's database waits on an advisory lock. */
const waitingOnAdvisoryLock = (stop: { done: boolean }): Promise<'waiting'> =>
  new Promise((resolve, reject) => {
    const poll = async (): Promise<void> => {
      while (!stop.done) {
        const { rows } = await pool.query(
          `select 1 from pg_locks l join pg_database d on d.oid = l.database
            where l.locktype = 'advisory' and not l.granted and d.datname = current_database()`,
        );
        if (rows.length > 0) {
          resolve('waiting');
          return;
        }
        await new Promise((wake) => setTimeout(wake, 10));
      }
    };
    poll().catch(reject);
  });

describe('two deliveries for one project (BACKLOG 971)', () => {
  it('land one after the other: the second waits on the stream lock, the first never retries', async () => {
    const competitors: Promise<unknown>[] = [];
    let attempts = 0;
    // Delivery A's transaction, with B recorded between A's sequence and A's append.
    const interposing: UnitOfWork = {
      transaction: async (fn) =>
        eventing.unitOfWork.transaction(async (scope) =>
          fn({
            ...scope,
            events: {
              lockStreamSequence: (streamType, streamId) =>
                scope.events.lockStreamSequence(streamType, streamId),
              append: async (events, appendOptions) => {
                attempts += 1;
                const competitor = recordNormalisedDelivery(
                  options(eventing.unitOfWork),
                  delivery(`competitor_${competitors.length + 1}`),
                );
                competitors.push(competitor);
                const stop = { done: false };
                try {
                  await Promise.race([competitor, waitingOnAdvisoryLock(stop)]);
                } finally {
                  stop.done = true;
                }
                return scope.events.append(events, appendOptions);
              },
            },
          }),
        ),
    };

    const outcome = await recordNormalisedDelivery(options(interposing), delivery('first'));
    const others = await Promise.all(competitors);

    expect(outcome).toMatchObject({ kind: 'recorded', events: 1 });
    expect(attempts).toBe(1);
    expect(others).toEqual([expect.objectContaining({ kind: 'recorded', events: 1 })]);
    const { rows } = await pool.query<{ stream_seq: number; component: string }>(
      `select stream_seq, actor->>'component' as component from events
        where stream_type = 'project' and stream_id = $1 order by stream_seq`,
      [projectId],
    );
    expect(rows).toEqual([
      { stream_seq: 1, component: 'first' },
      { stream_seq: 2, component: 'competitor_1' },
    ]);
  });
});
