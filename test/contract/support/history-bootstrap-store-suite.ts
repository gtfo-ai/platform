/**
 * The `HistoryBootstrapStore` contract — one suite, run against the in-memory double and against a
 * real PostgreSQL 18 (WP-35).
 *
 * BD-017's shape applied to a store rather than a provider: the start command, the collection and
 * the recorder all talk to this port, and the property they rest on is not "a row was written" but
 * **which write answers `true`**. Three of them are decisions:
 *
 *  - `liveBatch` answers the batch that has not finished, which is what `already_running` refuses
 *    on and what the read endpoint's gate publishes — and `createBatch` **refuses** a second live
 *    batch with `LiveHistoryBootstrapError`, which is what the start command turns into that same
 *    named refusal when two commands race past the read (WP-35 review round 2);
 *  - `markChunkRecorded` answers `false` for a chunk that already reported, which is what makes the
 *    recorder idempotent — the job is at-least-once and `kb_proposals` rows are not;
 *  - `completeIfDone` answers `true` exactly once, on the transition, so a batch is completed once
 *    however many recorders race for the last chunk.
 *
 * All three are asserted here rather than in each adapter's own file, because an adapter that got
 * any of them wrong would write a second set of knowledge proposals in production and nothing else
 * would notice.
 */
import type { HistoryBootstrapStore, Transaction } from '@platform/application';
import { LiveHistoryBootstrapError } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';

export interface HistoryBootstrapStoreContractContext {
  readonly store: HistoryBootstrapStore;
  /** One transaction for the case; the harness rolls it back in {@link cleanup}. */
  readonly tx: Transaction;
  /** A project the harness has created, if its adapter has foreign keys. */
  readonly projectId: Id;
  /** Two task ids the harness has created rows for, in order. */
  readonly taskIds: readonly [Id, Id];
  /** A fresh id per call — the adapters do not generate one. */
  readonly nextId: () => Id;
  readonly cleanup: () => Promise<void>;
}

const AT = '2026-09-14T12:00:00.000Z' as IsoDateTime;

const run = <T>(
  context: HistoryBootstrapStoreContractContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => fn(context.tx);

export const runHistoryBootstrapStoreContract = (options: {
  readonly name: string;
  readonly create: () => Promise<HistoryBootstrapStoreContractContext>;
}): void => {
  describe(`HistoryBootstrapStore contract — ${options.name}`, () => {
    let open: HistoryBootstrapStoreContractContext | null = null;
    const start = async (): Promise<HistoryBootstrapStoreContractContext> => {
      open = await options.create();
      return open;
    };
    afterEach(async () => {
      await open?.cleanup();
      open = null;
    });

    /** A batch with two chunks, the shape every case below starts from. */
    const seed = async (
      context: HistoryBootstrapStoreContractContext,
      overrides: { readonly capUsd?: number } = {},
    ): Promise<{ batchId: Id; chunkIds: [Id, Id] }> => {
      const batchId = context.nextId();
      const chunkIds: [Id, Id] = [context.nextId(), context.nextId()];
      await run(context, async (tx) => {
        await context.store.createBatch(tx, {
          id: batchId,
          projectId: context.projectId,
          requestedBy: null,
          mergeRequests: 40,
          batchSize: 20,
          days: 183,
          capUsd: overrides.capUsd ?? 20,
          estimatedUsd: 4,
        });
        for (const [index, chunkId] of chunkIds.entries()) {
          await context.store.addChunk(tx, {
            id: chunkId,
            batchId,
            chunkIndex: index,
            taskId: context.taskIds[index] as Id,
            mergeRequests: 20,
            tickets: 5,
            commits: 20,
            redactionCount: index,
            truncated: index === 0,
          });
        }
      });
      return { batchId, chunkIds };
    };

    it('records a batch with what the operator asked for, and reads it back', async () => {
      const context = await start();
      const { batchId } = await seed(context, { capUsd: 12.5 });

      const batch = await run(context, (tx) => context.store.batch(tx, batchId));
      expect(batch?.projectId).toBe(context.projectId);
      expect(batch?.mergeRequests).toBe(40);
      expect(batch?.batchSize).toBe(20);
      expect(batch?.days).toBe(183);
      // The figures are copied at creation, so a later settings edit cannot rewrite them.
      expect(batch?.capUsd).toBe(12.5);
      expect(batch?.estimatedUsd).toBe(4);
      expect(batch?.status).toBe('collecting');
      expect(batch?.detail).toBeNull();
      expect(batch?.completedAt).toBeNull();

      expect(
        await run(context, (tx) => context.store.listBatches(tx, context.projectId, 10)),
      ).toHaveLength(1);
    });

    it('refuses a second live batch for the project, by name rather than by driver code', async () => {
      // The *command* reads `liveBatch` and refuses first, so this is the path a race takes: both
      // callers read no live batch and the write decides. It is asserted here rather than in each
      // adapter because the caller branches on the error class — an adapter that let the raw
      // `23505` out would answer a 500 where the read answers a 409 (standing rule 20).
      const context = await start();
      await seed(context);
      await expect(
        run(context, (tx) =>
          context.store.createBatch(tx, {
            id: context.nextId(),
            projectId: context.projectId,
            requestedBy: null,
            mergeRequests: 40,
            batchSize: 20,
            days: 183,
            capUsd: 20,
            estimatedUsd: 4,
          }),
        ),
      ).rejects.toBeInstanceOf(LiveHistoryBootstrapError);
    });

    it('reads the chunks in index order, with the counts the collection recorded', async () => {
      const context = await start();
      const { batchId } = await seed(context);

      const chunks = await run(context, (tx) => context.store.chunks(tx, batchId));
      expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1]);
      expect(chunks[0]?.mergeRequests).toBe(20);
      expect(chunks[0]?.truncated).toBe(true);
      expect(chunks[1]?.truncated).toBe(false);
      expect(chunks[1]?.redactionCount).toBe(1);
      // Both counters are zero until a run reports, which is what makes `recordedAt` the field that
      // tells "found nothing" from "has not reported".
      expect(chunks.every((chunk) => chunk.recordedAt === null)).toBe(true);
      expect(chunks.every((chunk) => chunk.proposals === 0)).toBe(true);
    });

    it('finds the chunk a task belongs to, and answers null for a task that is not one', async () => {
      const context = await start();
      const { batchId, chunkIds } = await seed(context);
      const chunk = await run(context, (tx) =>
        context.store.chunkOfTask(tx, context.taskIds[0] as Id),
      );
      expect(chunk?.id).toBe(chunkIds[0]);
      expect(chunk?.batchId).toBe(batchId);
      expect(
        await run(context, (tx) =>
          context.store.chunkOfTask(tx, '00000000-0000-4000-8000-0000000fffff' as Id),
        ),
      ).toBeNull();
    });

    it('answers the live batch, and stops answering once it has finished', async () => {
      const context = await start();
      const { batchId } = await seed(context);
      expect((await run(context, (tx) => context.store.liveBatch(tx, context.projectId)))?.id).toBe(
        batchId,
      );

      await run(context, (tx) => context.store.markEmpty(tx, batchId, 'nothing to mine', AT));
      expect(await run(context, (tx) => context.store.liveBatch(tx, context.projectId))).toBeNull();
      const batch = await run(context, (tx) => context.store.batch(tx, batchId));
      expect(batch?.status).toBe('empty');
      expect(batch?.detail).toBe('nothing to mine');
      expect(batch?.completedAt).not.toBeNull();
    });

    it('moves a collecting batch to mining, and leaves a finished one alone', async () => {
      const context = await start();
      const { batchId } = await seed(context);
      await run(context, (tx) => context.store.markMining(tx, batchId));
      expect((await run(context, (tx) => context.store.batch(tx, batchId)))?.status).toBe('mining');

      // `status = 'collecting'` is in the `where`: a redelivery of the collection must not move a
      // batch that has already finished back to `mining`.
      await run(context, (tx) => context.store.markEmpty(tx, batchId, 'nothing', AT));
      await run(context, (tx) => context.store.markMining(tx, batchId));
      expect((await run(context, (tx) => context.store.batch(tx, batchId)))?.status).toBe('empty');
    });

    it('claims a chunk exactly once, which is what makes the recorder idempotent', async () => {
      const context = await start();
      const { chunkIds } = await seed(context);
      const outcome = { at: AT, proposals: 3, refusedProposals: 1 };

      expect(
        await run(context, (tx) => context.store.markChunkRecorded(tx, chunkIds[0], outcome)),
      ).toBe(true);
      // The second delivery writes nothing and says so, so the caller appends no second event.
      expect(
        await run(context, (tx) =>
          context.store.markChunkRecorded(tx, chunkIds[0], { ...outcome, proposals: 99 }),
        ),
      ).toBe(false);

      const chunks = await run(context, (tx) => context.store.chunks(tx, chunkIds[0] as never));
      expect(chunks).toEqual([]);
    });

    it('completes a batch exactly once, and only when every chunk has reported', async () => {
      const context = await start();
      const { batchId, chunkIds } = await seed(context);
      const outcome = { at: AT, proposals: 1, refusedProposals: 0 };

      // One of two: not done.
      await run(context, (tx) => context.store.markChunkRecorded(tx, chunkIds[0], outcome));
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(false);
      expect(
        (await run(context, (tx) => context.store.batch(tx, batchId)))?.completedAt,
      ).toBeNull();

      // Both: done, once.
      await run(context, (tx) => context.store.markChunkRecorded(tx, chunkIds[1], outcome));
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(true);
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(false);

      const batch = await run(context, (tx) => context.store.batch(tx, batchId));
      expect(batch?.status).toBe('completed');
      expect(batch?.completedAt).not.toBeNull();

      const chunks = await run(context, (tx) => context.store.chunks(tx, batchId));
      expect(chunks.map((chunk) => chunk.proposals)).toEqual([1, 1]);
      expect(chunks.every((chunk) => chunk.recordedAt !== null)).toBe(true);
    });

    it('never completes a batch that has no chunk at all', async () => {
      // A collection that found nothing is `empty`, not `completed`: the difference is what an
      // operator reads on the screen, and `exists (…)` in the predicate is what keeps it.
      const context = await start();
      const batchId = context.nextId();
      await run(context, (tx) =>
        context.store.createBatch(tx, {
          id: batchId,
          projectId: context.projectId,
          requestedBy: null,
          mergeRequests: 40,
          batchSize: 20,
          days: 183,
          capUsd: 20,
          estimatedUsd: 4,
        }),
      );
      expect(await run(context, (tx) => context.store.completeIfDone(tx, batchId, AT))).toBe(false);
    });

    it('answers the cap for a task in a batch, and nothing for one that is not', async () => {
      const context = await start();
      await seed(context, { capUsd: 7.5 });
      const cap = await run(context, (tx) =>
        context.store.capForTask(tx, context.taskIds[0] as Id),
      );
      expect(cap?.capUsd).toBe(7.5);
      // The spend is the ledger's; a batch that has spent nothing has spent nothing.
      expect(cap?.spentUsd).toBe(0);
      expect(
        await run(context, (tx) =>
          context.store.capForTask(tx, '00000000-0000-4000-8000-0000000fffff' as Id),
        ),
      ).toBeNull();
    });
  });
};
