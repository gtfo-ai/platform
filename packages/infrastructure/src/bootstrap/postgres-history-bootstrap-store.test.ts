/**
 * The history bootstrap store's **mapping**, against a scripted executor (WP-35).
 *
 * The writes are asserted where a write can be: the integration tier, against a real PostgreSQL 18.
 * What is here is the half a database cannot usefully exercise — the row → port conversion, which
 * reads columns a row may not carry the shape of.
 *
 * It matters for the same reason the shadow store's does: `cap_usd` and `estimated_usd` are
 * `numeric`, which `pg` hands back as **strings** (it does not coerce, so a value wider than a
 * double is not silently rounded), and a read that trusted them would publish a `NaN` cap on the
 * batch screen and compare a `NaN` against a spend at admission — which is `false` for every
 * comparison, so the cap would silently stop stopping anything (standing rule 16's shape).
 *
 * The three `rowCount` answers are the other half: `markChunkRecorded`, `completeIfDone` and their
 * `where` predicates are what make the recorder idempotent, and the boolean they return is the only
 * thing the recorder's whole transaction is keyed on.
 *
 * The **error translation** is here too (WP-35 review round 2), for the reason
 * `postgres-event-store.test.ts` keeps the sequence guard's: a driver code is a thing a scripted
 * client can raise exactly, and the branch that matters is the one that does **not** translate —
 * an unrelated `23505` must stay the fault it is rather than being reported as a live batch.
 */
import type { Transaction } from '@platform/application';
import { LiveHistoryBootstrapError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { PostgresHistoryBootstrapStore } from './postgres-history-bootstrap-store.js';

const BATCH = '00000000-0000-4000-8000-0000000000d1';
const PROJECT = '00000000-0000-4000-8000-0000000000d2';
const TASK = '00000000-0000-4000-8000-0000000000d3';
const CHUNK = '00000000-0000-4000-8000-0000000000d4';

/** A transaction whose client answers one scripted result to every query. */
/** A transaction whose client raises `error` on every query. */
const failing = (error: unknown): Transaction =>
  ({
    adapter: 'postgres',
    client: {
      query: async () => {
        throw error;
      },
    } as unknown as SqlExecutor,
  }) as unknown as Transaction;

const scripted = (rows: readonly Record<string, unknown>[], rowCount?: number): Transaction =>
  ({
    adapter: 'postgres',
    client: {
      query: async () => ({ rows, rowCount: rowCount ?? rows.length }),
    } as unknown as SqlExecutor,
  }) as unknown as Transaction;

const batchRow = (overrides: Record<string, unknown> = {}) => ({
  id: BATCH,
  project_id: PROJECT,
  requested_by: null,
  merge_requests: 200,
  batch_size: 20,
  days: 183,
  cap_usd: '20.000000',
  estimated_usd: '20.000000',
  status: 'mining',
  detail: null,
  created_at: new Date('2026-09-14T10:00:00.000Z'),
  completed_at: null,
  ...overrides,
});

const chunkRow = (overrides: Record<string, unknown> = {}) => ({
  id: CHUNK,
  batch_id: BATCH,
  chunk_index: 0,
  task_id: TASK,
  merge_requests: 20,
  tickets: 5,
  commits: 20,
  redaction_count: 2,
  truncated: true,
  recorded_at: null,
  proposals: 0,
  refused_proposals: 0,
  ...overrides,
});

const store = new PostgresHistoryBootstrapStore();

describe('PostgresHistoryBootstrapStore — reading a batch', () => {
  it('maps a row onto the port’s camelCase shape, and `numeric` onto a number', async () => {
    const batch = await store.batch(scripted([batchRow()]), BATCH as never);
    expect(batch).toEqual({
      id: BATCH,
      projectId: PROJECT,
      requestedBy: null,
      mergeRequests: 200,
      batchSize: 20,
      days: 183,
      capUsd: 20,
      estimatedUsd: 20,
      status: 'mining',
      detail: null,
      createdAt: '2026-09-14T10:00:00.000Z',
      completedAt: null,
    });
  });

  it('answers null for a batch that does not exist, rather than a half-built row', async () => {
    expect(await store.batch(scripted([]), BATCH as never)).toBeNull();
    expect(await store.liveBatch(scripted([]), PROJECT as never)).toBeNull();
    expect(await store.chunkOfTask(scripted([]), TASK as never)).toBeNull();
    expect(await store.capForTask(scripted([]), TASK as never)).toBeNull();
  });

  it('renders `timestamptz` as an instant the port can hand on', async () => {
    const batch = await store.batch(
      scripted([
        batchRow({ status: 'completed', completed_at: new Date('2026-09-14T11:30:00.000Z') }),
      ]),
      BATCH as never,
    );
    expect(batch?.completedAt).toBe('2026-09-14T11:30:00.000Z');
  });

  it('maps a chunk, including the counts a batch screen reads', async () => {
    const chunk = await store.chunkOfTask(
      scripted([chunkRow({ recorded_at: new Date('2026-09-14T12:00:00.000Z'), proposals: 3 })]),
      TASK as never,
    );
    expect(chunk).toEqual({
      id: CHUNK,
      batchId: BATCH,
      chunkIndex: 0,
      taskId: TASK,
      mergeRequests: 20,
      tickets: 5,
      commits: 20,
      redactionCount: 2,
      truncated: true,
      recordedAt: '2026-09-14T12:00:00.000Z',
      proposals: 3,
      refusedProposals: 0,
    });
  });
});

describe('PostgresHistoryBootstrapStore — the three writes whose answer is the idempotency', () => {
  it('says whether `markChunkRecorded` was the write that claimed the chunk', async () => {
    // `recorded_at is null` is in the `where`, so `rowCount` is the answer and not a read the
    // caller did first — which two concurrent deliveries would both pass.
    expect(
      await store.markChunkRecorded(scripted([], 1), CHUNK as never, {
        at: '2026-09-14T12:00:00.000Z' as never,
        proposals: 2,
        refusedProposals: 1,
      }),
    ).toBe(true);
    expect(
      await store.markChunkRecorded(scripted([], 0), CHUNK as never, {
        at: '2026-09-14T12:00:00.000Z' as never,
        proposals: 2,
        refusedProposals: 1,
      }),
    ).toBe(false);
  });

  it('says whether `completeIfDone` was the write that finished the batch', async () => {
    expect(
      await store.completeIfDone(
        scripted([], 1),
        BATCH as never,
        '2026-09-14T12:00:00.000Z' as never,
      ),
    ).toBe(true);
    expect(
      await store.completeIfDone(
        scripted([], 0),
        BATCH as never,
        '2026-09-14T12:00:00.000Z' as never,
      ),
    ).toBe(false);
  });

  it('treats a missing rowCount as "nothing was written", never as success', async () => {
    const noCount = {
      adapter: 'postgres',
      client: { query: async () => ({ rows: [] }) } as unknown as SqlExecutor,
    } as unknown as Transaction;
    expect(
      await store.markChunkRecorded(noCount, CHUNK as never, {
        at: '2026-09-14T12:00:00.000Z' as never,
        proposals: 0,
        refusedProposals: 0,
      }),
    ).toBe(false);
  });
});

describe('PostgresHistoryBootstrapStore — the spend the cap is compared against', () => {
  it('reads the ledger’s sum as a number, and zero for a batch that has spent nothing', async () => {
    expect(await store.spendOfBatch(scripted([{ usd: '4.800000' }]), BATCH as never)).toBe(4.8);
    // `coalesce(sum(...), 0)` — a batch with no entries has spent nothing, which is the one place
    // a zero is the right answer rather than an invented one.
    expect(await store.spendOfBatch(scripted([{ usd: '0' }]), BATCH as never)).toBe(0);
    expect(await store.spendOfBatch(scripted([]), BATCH as never)).toBe(0);
  });

  it('answers the cap and the spend together, so admission compares two numbers from one read', async () => {
    expect(
      await store.capForTask(
        scripted([{ cap_usd: '20.000000', spent_usd: '18.400000' }]),
        TASK as never,
      ),
    ).toEqual({ capUsd: 20, spentUsd: 18.4 });
  });
});

describe('PostgresHistoryBootstrapStore — the index’s refusal, translated', () => {
  const batch = {
    id: BATCH as never,
    projectId: PROJECT as never,
    requestedBy: null,
    mergeRequests: 200,
    batchSize: 20,
    days: 183,
    capUsd: 20,
    estimatedUsd: 20,
  };
  const create = (error: unknown) => store.createBatch(failing(error), batch);

  it('turns the one-live-batch violation into the port’s own error', async () => {
    // What the command branches on to answer `already_running` instead of a 500. `pg` puts the
    // index name on `constraint`; the message is accepted too, for a driver that lost the field.
    await expect(
      create({ code: '23505', constraint: 'history_bootstrap_batches_one_live' }),
    ).rejects.toBeInstanceOf(LiveHistoryBootstrapError);
    await expect(
      create({
        code: '23505',
        message:
          'duplicate key value violates unique constraint "history_bootstrap_batches_one_live"',
      }),
    ).rejects.toBeInstanceOf(LiveHistoryBootstrapError);
  });

  it('rethrows every other failure, including another unique violation', async () => {
    // The direction that keeps the translation honest (standing rule 42): a duplicated batch id is
    // a fault, and reporting it as "you already have one running" would hide a defect behind a
    // refusal an operator is told to ignore.
    const duplicateId = { code: '23505', constraint: 'history_bootstrap_batches_pkey' };
    await expect(create(duplicateId)).rejects.toMatchObject(duplicateId);
    await expect(
      create({ code: '42P01', message: 'relation does not exist' }),
    ).rejects.toMatchObject({ code: '42P01' });
    // A thrown non-object — nothing to read a code off, so nothing to translate.
    await expect(create('the pool is closed')).rejects.toBe('the pool is closed');
  });
});
