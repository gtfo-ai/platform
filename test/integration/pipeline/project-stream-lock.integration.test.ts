/**
 * **Two writers of one project stream wait for each other** — BACKLOG 971, against a real
 * PostgreSQL 18.
 *
 * Every project-stream writer outside the dispatcher used to read the stream's next sequence over
 * the pool, before its transaction, and retry a lost race four times (`appendOnProjectWithRetry`,
 * WP-109). The integration stream's identical loop lost four in a row under CI's load (BACKLOG 970),
 * so the helper's transaction now opens with `scope.events.lockStreamSequence('project', id)`: the
 * stream's advisory lock, then the sequence on the transaction's own connection.
 *
 * Staged rather than raced — `Promise.all` over two writers does not reliably interleave (the audit
 * log's suite measured it): between the writer's sequence and its append, on **every** attempt,
 * another writer appends to the same project through the same helper. Without the lock the other
 * writer commits each time and every attempt loses; with it the other writer **waits** — asserted
 * on `pg_locks`, never on a timer — so the writer lands on its first attempt and the other right
 * after it, at the next sequence.
 */
import { randomUUID } from 'node:crypto';
import { appendOnProjectWithRetry, type UnitOfWork } from '@platform/application';
import { type DomainEvent, domainEventSchemasByType, type Id } from '@platform/contracts';
import { eventing } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recentInstant } from '../../support/recent-instant.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const NOW = recentInstant();

let database: MigratedDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  database = await createMigratedDatabase('project-stream-lock');
  pool = createTestPool(database.connectionString, { max: 6 });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const rebuilt = (projectId: Id, streamSeq: number, component: string): DomainEvent =>
  domainEventSchemasByType['knowledge.index.rebuilt'].parse({
    id: randomUUID(),
    stream_type: 'project',
    stream_id: projectId,
    stream_seq: streamSeq,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component },
    occurred_at: NOW,
    type: 'knowledge.index.rebuilt',
    payload: { project_id: projectId, commit_sha: 'abc1234', documents: 1, chunks: 1, tokens: 1 },
  }) as DomainEvent;

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

describe('two writers of one project stream (BACKLOG 971)', () => {
  it('land one after the other: the second waits on the stream lock, the first never retries', async () => {
    const projectId = randomUUID() as Id;
    const unitOfWork: UnitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const competitors: Promise<number>[] = [];
    let attempts = 0;

    const landed = await appendOnProjectWithRetry(
      { unitOfWork },
      { projectId, writer: 'writer_under_test' },
      async (scope, streamSeq) => {
        attempts += 1;
        // The writer holds its sequence; another writer of the same project appends now.
        const competitor = appendOnProjectWithRetry(
          { unitOfWork },
          { projectId, writer: 'competitor' },
          async (other, otherSeq) => {
            await other.events.append([rebuilt(projectId, otherSeq, 'competitor')]);
            return otherSeq;
          },
        );
        competitors.push(competitor);
        const stop = { done: false };
        try {
          await Promise.race([competitor, waitingOnAdvisoryLock(stop)]);
        } finally {
          stop.done = true;
        }
        await scope.events.append([rebuilt(projectId, streamSeq, 'writer')]);
        return streamSeq;
      },
    );
    const others = await Promise.all(competitors);

    expect(attempts).toBe(1);
    expect(landed).toBe(1);
    expect(others).toEqual([2]);
    const { rows } = await pool.query<{ stream_seq: number; component: string }>(
      `select stream_seq, actor->>'component' as component from events
        where stream_type = 'project' and stream_id = $1 order by stream_seq`,
      [projectId],
    );
    expect(rows).toEqual([
      { stream_seq: 1, component: 'writer' },
      { stream_seq: 2, component: 'competitor' },
    ]);
  });
});
