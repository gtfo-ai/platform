/**
 * The shadow store's **mapping**, against a scripted executor (WP-34).
 *
 * The writes are asserted where a write can be: the shared contract suite, run against the
 * in-memory double in the contract tier and against a real PostgreSQL 18 in the integration tier.
 * What is here is the half a database cannot usefully exercise — the row → port conversion, which
 * reads three columns a row may not carry the shape of.
 *
 * It matters because two of them are **not** the port's shape. `budget_usd` is `numeric`, which
 * `pg` hands back as a **string** (it does not coerce, so a value wider than a double is not
 * silently rounded), and `human_mr_ref` is `jsonb`, which can hold anything an operator with
 * `psql` — or an older build — put there. A read that trusted either would publish a `NaN` budget or
 * a merge-request ref the DTO refuses, and the caller would see a 500 for a batch that is otherwise
 * fine.
 */
import type { Transaction } from '@platform/application';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { PostgresShadowStore } from './postgres-shadow-store.js';

const BATCH = '00000000-0000-4000-8000-0000000000b1';
const PROJECT = '00000000-0000-4000-8000-0000000000b2';
const TASK = '00000000-0000-4000-8000-0000000000b3';

/** A transaction whose client answers one scripted result to every query. */
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
  budget_usd: '25.500000',
  created_at: new Date('2026-09-14T10:00:00.000Z'),
  completed_at: null,
  ...overrides,
});

const MR = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'feature/acme-1',
  head_sha: 'a'.repeat(40),
};

const store = new PostgresShadowStore();

describe('PostgresShadowStore — reading a batch', () => {
  it('maps a row onto the port’s camelCase shape, and `numeric` onto a number', async () => {
    const batch = await store.batch(scripted([batchRow()]), BATCH as never);
    expect(batch).toEqual({
      id: BATCH,
      projectId: PROJECT,
      requestedBy: null,
      budgetUsd: 25.5,
      createdAt: '2026-09-14T10:00:00.000Z',
      completedAt: null,
    });
  });

  it('keeps a null budget null, because a batch with no cap is not a batch with a cap of zero', async () => {
    const batch = await store.batch(scripted([batchRow({ budget_usd: null })]), BATCH as never);
    expect(batch?.budgetUsd).toBeNull();
  });

  it('answers null for a batch nobody created', async () => {
    expect(await store.batch(scripted([]), BATCH as never)).toBeNull();
    expect(await store.batchOfTask(scripted([]), TASK as never)).toBeNull();
  });

  it('carries the completion instant when there is one', async () => {
    const batch = await store.batch(
      scripted([batchRow({ completed_at: new Date('2026-09-14T11:00:00.000Z') })]),
      BATCH as never,
    );
    expect(batch?.completedAt).toBe('2026-09-14T11:00:00.000Z');
    expect(await store.listBatches(scripted([batchRow()]), PROJECT as never, 10)).toHaveLength(1);
  });
});

describe('PostgresShadowStore — reading a ticket row', () => {
  const ticketRow = (overrides: Record<string, unknown> = {}) => ({
    ticket_key: 'ACME-1',
    task_id: TASK,
    base_sha: 'b'.repeat(40),
    human_mr_ref: MR,
    human_mr_source: 'title_scan',
    human_mr_merged_at: new Date('2026-04-01T09:00:00.000Z'),
    human_mr_candidates: 2,
    refused_reason: null,
    ...overrides,
  });

  it('maps the Q82 columns, including the two the report reads later', async () => {
    const [ticket] = await store.tickets(scripted([ticketRow()]), BATCH as never);
    expect(ticket).toEqual({
      ticketKey: 'ACME-1',
      taskId: TASK,
      baseSha: 'b'.repeat(40),
      humanMr: MR,
      humanMrSource: 'title_scan',
      // `timestamptz` arrives as a `Date` and the row's contract is the instant product/19 §16's
      // arithmetic takes, so the mapper renders it rather than handing on a `Date`.
      mergedAt: '2026-04-01T09:00:00.000Z',
      candidates: 2,
      refusedReason: null,
    });
  });

  it('keeps a ticket whose merge request the provider never dated, and one nothing matched', async () => {
    // Both columns are nullable and both nulls mean something: no merge request was matched at
    // all, or one was and the provider published no merge instant. Neither becomes a zero.
    const [ticket] = await store.tickets(
      scripted([ticketRow({ human_mr_merged_at: null, human_mr_candidates: null })]),
      BATCH as never,
    );
    expect(ticket?.mergedAt).toBeNull();
    expect(ticket?.candidates).toBeNull();
  });

  it('drops a `human_mr_ref` that is not an object, rather than handing one on', async () => {
    // `jsonb` accepts a bare string, a number and an array; none of them is a merge-request ref,
    // and the DTO would refuse it at the boundary with a 500 for the whole batch.
    for (const raw of ['not a ref', 42, [MR], null]) {
      const [ticket] = await store.tickets(
        scripted([ticketRow({ human_mr_ref: raw })]),
        BATCH as never,
      );
      expect(ticket?.humanMr, JSON.stringify(raw)).toBeNull();
    }
  });

  it('drops a `human_mr_source` this build does not know', async () => {
    const [ticket] = await store.tickets(
      scripted([ticketRow({ human_mr_source: 'telepathy' })]),
      BATCH as never,
    );
    expect(ticket?.humanMrSource).toBeNull();
    // …and keeps the one it does (standing rule 42: a mapper that dropped everything would pass
    // the case above).
    const [known] = await store.tickets(
      scripted([ticketRow({ human_mr_source: 'ticket_link' })]),
      BATCH as never,
    );
    expect(known?.humanMrSource).toBe('ticket_link');
  });

  it('reads a refusal row, whose task is null', async () => {
    const [ticket] = await store.tickets(
      scripted([ticketRow({ task_id: null, refused_reason: 'no merge base' })]),
      BATCH as never,
    );
    expect(ticket?.taskId).toBeNull();
    expect(ticket?.refusedReason).toBe('no merge base');
  });
});

describe('PostgresShadowStore — the two answers idempotency rests on', () => {
  it('answers whether the insert wrote, from the row count rather than from the absence of an error', async () => {
    expect(
      await store.insertReport(scripted([], 1), {
        taskId: TASK as never,
        humanMr: MR as never,
        comparison: {},
      }),
    ).toBe(true);
    // `on conflict do nothing` succeeds and writes nothing; `rowCount` is the only difference.
    expect(
      await store.insertReport(scripted([], 0), {
        taskId: TASK as never,
        humanMr: null,
        comparison: {},
      }),
    ).toBe(false);
  });

  it('answers whether the completion actually moved the row', async () => {
    expect(
      await store.completeIfDone(
        scripted([], 1),
        BATCH as never,
        '2026-09-14T11:00:00.000Z' as never,
      ),
    ).toBe(true);
    expect(
      await store.completeIfDone(
        scripted([], 0),
        BATCH as never,
        '2026-09-14T11:00:00.000Z' as never,
      ),
    ).toBe(false);
  });

  it('reads a checkout base and a spend, and answers zero for a project with neither', async () => {
    expect(
      await store.checkoutBaseFor(scripted([{ base_sha: 'c'.repeat(40) }]), TASK as never),
    ).toBe('c'.repeat(40));
    expect(await store.checkoutBaseFor(scripted([]), TASK as never)).toBeNull();
    expect(
      await store.shadowSpendSince(
        scripted([{ spent_usd: '12.500000', pending_usd: '5.000000' }]),
        PROJECT as never,
        '' as never,
        5,
      ),
    ).toEqual({ spentUsd: 12.5, pendingUsd: 5 });
    // No row at all is a project that has spent nothing and has nothing in flight — the one place
    // a zero is the answer rather than an invention (standing rule 16's other side).
    expect(await store.shadowSpendSince(scripted([]), PROJECT as never, '' as never, 5)).toEqual({
      spentUsd: 0,
      pendingUsd: 0,
    });
  });

  it('reads a batch’s reports, mapping the jsonb comparison through untouched', async () => {
    const reports = await store.reports(
      scripted([
        {
          task_id: TASK,
          human_mr_ref: MR,
          comparison: { ticket: 'ACME-1' },
          created_at: new Date('2026-09-14T10:30:00.000Z'),
        },
      ]),
      BATCH as never,
    );
    expect(reports).toEqual([
      {
        taskId: TASK,
        humanMr: MR,
        comparison: { ticket: 'ACME-1' },
        createdAt: '2026-09-14T10:30:00.000Z',
      },
    ]);
  });

  it('writes a batch and a ticket without reading anything back', async () => {
    // The two writes, driven so the statements are exercised: what they *did* is the contract
    // suite's and the integration tier's, and what is asserted here is that neither throws on the
    // shapes the command produces (a null budget, a null merge request, a refusal).
    const tx = scripted([]);
    await expect(
      store.createBatch(tx, {
        id: BATCH as never,
        projectId: PROJECT as never,
        requestedBy: null,
        budgetUsd: null,
      }),
    ).resolves.toBeUndefined();
    await expect(
      store.addTicket(tx, BATCH as never, {
        ticketKey: 'ACME-1',
        taskId: null,
        baseSha: null,
        humanMr: null,
        humanMrSource: null,
        mergedAt: null,
        candidates: null,
        refusedReason: 'no merge base',
      }),
    ).resolves.toBeUndefined();
  });
});
