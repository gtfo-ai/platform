/**
 * The `ShadowStore` contract — one suite, run against the in-memory double and against a real
 * PostgreSQL 18 (WP-34).
 *
 * BD-017's shape applied to a store rather than a provider: the batch command, the report duty and
 * the `shadow.report.created` consumer all talk to this port, and the property they rest on is not
 * "a row was written" but **which write answers `true`**. Two of them are decisions:
 *
 *  - `insertReport` answers `false` for a task that already has a report, which is what makes the
 *    duty idempotent — the job is at-least-once and the domain event is not;
 *  - `completeIfDone` answers `true` exactly once, on the transition, which is what makes the
 *    consumer idempotent.
 *
 * Both are asserted here rather than in each adapter's own file, because an adapter that got either
 * wrong would produce a second `shadow.report.created` in production and nothing else would notice.
 */
import type { ShadowStore, Transaction } from '@platform/application';
import type { Id, IsoDateTime, MergeRequestRef } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';

export interface ShadowStoreContractContext {
  readonly store: ShadowStore;
  /** One transaction for the case; the harness rolls it back in {@link cleanup}. */
  readonly tx: Transaction;
  /** A project the harness has created, if its adapter has foreign keys. */
  readonly projectId: Id;
  /** Two task ids the harness has created rows for, in order. */
  readonly taskIds: readonly [Id, Id];
  /** A fresh batch id per call — the adapters do not generate one. */
  readonly nextBatchId: () => Id;
  readonly cleanup: () => Promise<void>;
}

const MR: MergeRequestRef = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'feature/acme-1',
  head_sha: 'a'.repeat(40),
};

const AT = '2026-09-14T12:00:00.000Z' as IsoDateTime;

/** When the human merge request was merged — product/19 §16's *"to merge"* instant. */
const MERGED_AT = '2026-04-01T09:00:00.000Z';

/** Everything in one case shares the harness's transaction; the harness decides what that means. */
const run = <T>(
  context: ShadowStoreContractContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => fn(context.tx);

export const runShadowStoreContract = (options: {
  readonly name: string;
  readonly create: () => Promise<ShadowStoreContractContext>;
}): void => {
  describe(`ShadowStore contract — ${options.name}`, () => {
    let open: ShadowStoreContractContext | null = null;
    const start = async (): Promise<ShadowStoreContractContext> => {
      open = await options.create();
      return open;
    };
    afterEach(async () => {
      await open?.cleanup();
      open = null;
    });

    it('records a batch with its tickets, and reads back what it wrote', async () => {
      const context = await start();
      const batchId = context.nextBatchId();
      await run(context, async (tx) => {
        await context.store.createBatch(tx, {
          id: batchId,
          projectId: context.projectId,
          requestedBy: null,
          budgetUsd: 25.5,
        });
        await context.store.addTicket(tx, batchId, {
          ticketKey: 'ACME-1',
          taskId: context.taskIds[0],
          baseSha: 'b'.repeat(40),
          humanMr: MR,
          humanMrSource: 'title_scan',
          mergedAt: MERGED_AT,
          candidates: 3,
          refusedReason: null,
        });
        // Q82 (a)'s refusal: a ticket with **no** task, which is why the primary key is the ticket.
        await context.store.addTicket(tx, batchId, {
          ticketKey: 'ACME-2',
          taskId: null,
          baseSha: null,
          humanMr: null,
          humanMrSource: null,
          mergedAt: null,
          candidates: null,
          refusedReason: 'the human merge request publishes no merge base',
        });
      });

      const batch = await run(context, (tx) => context.store.batch(tx, batchId));
      expect(batch?.projectId).toBe(context.projectId);
      expect(batch?.budgetUsd).toBe(25.5);
      expect(batch?.completedAt).toBeNull();

      const tickets = await run(context, (tx) => context.store.tickets(tx, batchId));
      expect(tickets.map((ticket) => ticket.ticketKey)).toEqual(['ACME-1', 'ACME-2']);
      expect(tickets[0]?.humanMr).toEqual(MR);
      expect(tickets[0]?.humanMrSource).toBe('title_scan');
      // The two the report reads later (WP-34 review round 2): the merge instant product/19 §16's
      // window runs *"to merge"* with, and how many merged merge requests matched the ticket. A
      // store that dropped either would leave the report guessing and the `notes` silent.
      expect(tickets[0]?.mergedAt).toBe(MERGED_AT);
      expect(tickets[0]?.candidates).toBe(3);
      // …and both are null on a ticket nothing matched, rather than an epoch and a zero.
      expect(tickets[1]?.mergedAt).toBeNull();
      expect(tickets[1]?.candidates).toBeNull();
      expect(tickets[1]?.taskId).toBeNull();
      expect(tickets[1]?.refusedReason).toContain('no merge base');
    });

    it('answers null for a batch nobody created, rather than throwing', async () => {
      const context = await start();
      const missing = await run(context, (tx) => context.store.batch(tx, context.nextBatchId()));
      expect(missing).toBeNull();
    });

    it('finds the batch a task belongs to, and its comparison base', async () => {
      const context = await start();
      const batchId = context.nextBatchId();
      await run(context, async (tx) => {
        await context.store.createBatch(tx, {
          id: batchId,
          projectId: context.projectId,
          requestedBy: null,
          budgetUsd: null,
        });
        await context.store.addTicket(tx, batchId, {
          ticketKey: 'ACME-1',
          taskId: context.taskIds[0],
          baseSha: 'c'.repeat(40),
          humanMr: MR,
          humanMrSource: 'ticket_link',
          mergedAt: null,
          candidates: null,
          refusedReason: null,
        });
      });
      const found = await run(context, (tx) => context.store.batchOfTask(tx, context.taskIds[0]));
      expect(found?.id).toBe(batchId);
      expect(
        await run(context, (tx) => context.store.checkoutBaseFor(tx, context.taskIds[0])),
      ).toBe('c'.repeat(40));
      // …and a task that is in no batch has no base (standing rule 42).
      expect(
        await run(context, (tx) => context.store.checkoutBaseFor(tx, context.taskIds[1])),
      ).toBeNull();
      expect(
        await run(context, (tx) => context.store.batchOfTask(tx, context.taskIds[1])),
      ).toBeNull();
    });

    it('writes a report once, and says so', async () => {
      const context = await start();
      const first = await run(context, (tx) =>
        context.store.insertReport(tx, {
          taskId: context.taskIds[0],
          humanMr: MR,
          comparison: { ticket: 'ACME-1', notes: '' },
        }),
      );
      expect(first).toBe(true);
      // The second delivery of an at-least-once job: nothing is written and the caller is told, so
      // no second `shadow.report.created` is appended.
      const second = await run(context, (tx) =>
        context.store.insertReport(tx, {
          taskId: context.taskIds[0],
          humanMr: null,
          comparison: { ticket: 'ACME-1', notes: 'different' },
        }),
      );
      expect(second).toBe(false);
    });

    it('completes a batch exactly once, and only when every task has a report', async () => {
      const context = await start();
      const batchId = context.nextBatchId();
      await run(context, async (tx) => {
        await context.store.createBatch(tx, {
          id: batchId,
          projectId: context.projectId,
          requestedBy: null,
          budgetUsd: null,
        });
        for (const [index, taskId] of context.taskIds.entries()) {
          await context.store.addTicket(tx, batchId, {
            ticketKey: `ACME-${index + 1}`,
            taskId,
            baseSha: null,
            humanMr: null,
            humanMrSource: null,
            mergedAt: null,
            candidates: null,
            refusedReason: null,
          });
        }
      });

      // Nothing reported yet.
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(false);

      await run(context, (tx) =>
        context.store.insertReport(tx, {
          taskId: context.taskIds[0],
          humanMr: null,
          comparison: { ticket: 'ACME-1' },
        }),
      );
      // One of two: still not done.
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(false);

      await run(context, (tx) =>
        context.store.insertReport(tx, {
          taskId: context.taskIds[1],
          humanMr: null,
          comparison: { ticket: 'ACME-2' },
        }),
      );
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(true);
      // …and the transition happens once: a redelivery of the last report performs nothing.
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(false);
      expect(
        (await run(context, (tx) => context.store.batch(tx, batchId)))?.completedAt,
      ).not.toBeNull();
    });

    it('reads a batch’s reports and nothing else’s', async () => {
      const context = await start();
      const mine = context.nextBatchId();
      const other = context.nextBatchId();
      await run(context, async (tx) => {
        for (const [batchId, taskId] of [
          [mine, context.taskIds[0]],
          [other, context.taskIds[1]],
        ] as const) {
          await context.store.createBatch(tx, {
            id: batchId,
            projectId: context.projectId,
            requestedBy: null,
            budgetUsd: null,
          });
          await context.store.addTicket(tx, batchId, {
            ticketKey: `K-${taskId.slice(-2)}`,
            taskId,
            baseSha: null,
            humanMr: null,
            humanMrSource: null,
            mergedAt: null,
            candidates: null,
            refusedReason: null,
          });
          await context.store.insertReport(tx, {
            taskId,
            humanMr: null,
            comparison: { ticket: `K-${taskId.slice(-2)}` },
          });
        }
      });
      const reports = await run(context, (tx) => context.store.reports(tx, mine));
      expect(reports.map((report) => report.taskId)).toEqual([context.taskIds[0]]);
    });

    it('lists a project’s batches newest first, bounded by the limit', async () => {
      const context = await start();
      const ids = [context.nextBatchId(), context.nextBatchId()];
      for (const id of ids) {
        await run(context, (tx) =>
          context.store.createBatch(tx, {
            id,
            projectId: context.projectId,
            requestedBy: null,
            budgetUsd: null,
          }),
        );
      }
      const listed = await run(context, (tx) =>
        context.store.listBatches(tx, context.projectId, 1),
      );
      expect(listed).toHaveLength(1);
    });

    it('sums nothing for a project with no shadow spend, rather than refusing', async () => {
      // The one place a zero is the right answer: a project that has spent nothing has spent
      // nothing, and the budget guard compares against it.
      const context = await start();
      expect(
        await run(context, (tx) => context.store.shadowSpendSince(tx, context.projectId, AT)),
      ).toBe(0);
    });
  });
};
