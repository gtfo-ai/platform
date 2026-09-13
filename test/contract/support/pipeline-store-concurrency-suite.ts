/**
 * The `PipelineStore` contract for **two writers at once** — PROGRESS backlog 18, WP-15e.
 *
 * The ordinary store suite (`pipeline-store-suite.ts`) runs every case inside one transaction that
 * is rolled back afterwards, which is exactly the right shape for a round trip and cannot express
 * the defect this suite exists for: a lost update needs two transactions and a *committed* row
 * between them. So this is a second suite with a second harness — one that hands out transactions
 * the caller opens, commits and rolls back itself — run against the in-memory store from the
 * contract tier and against PostgreSQL 18 from the integration tier.
 *
 * ## Deliberate interleaving, never load
 *
 * Every case here writes the interleaving out by hand, in WP-15d's shape: a job writing a task row
 * beside a stage executor's transaction. Nothing is concurrent in wall-clock terms and nothing is
 * timed — the *ordering* is the test, and a race reproduced by spinning up load is a race that
 * reappears as a flake on somebody else's machine (standing rule 66, and rule 2 on wall-clock
 * assertions).
 *
 * ## What the in-memory store can and cannot show
 *
 * It has no isolation (its own divergence 4), so what it reproduces is the **ordering**, not the
 * locking: `begin`/`commit` are no-ops there and every write is visible immediately. That is
 * enough for the property under test — `save` refuses a snapshot whose `version` has moved — and
 * it is why the same suite is pointed at PostgreSQL, where the same sequence goes through two real
 * connections, two real transactions and a predicate the database evaluates.
 */
import type { PipelineStore, StoredTask, Transaction } from '@platform/application';
import { INITIAL_TASK_VERSION } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';

/** A transaction the case drives: the harness opened it, the case ends it. */
export interface DrivenTransaction {
  readonly tx: Transaction;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PipelineStoreConcurrencyHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: PipelineStore;
    readonly projectId: Id;
    /** A fresh transaction, isolated from every other one this harness hands out. */
    begin(): Promise<DrivenTransaction>;
    cleanup(): Promise<void>;
  }>;
}

let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-9000-${counter.toString(16).padStart(12, '0')}` as Id;
};

/** What the stage executor adds to `cost_actual` per stage in the e2e that found this defect. */
const COST_PER_STAGE = 0.4;
const AGENT_STAGES = 7;

export const runPipelineStoreConcurrencyContract = (
  harness: PipelineStoreConcurrencyHarness,
): void => {
  describe(`PipelineStore concurrency — ${harness.name}`, () => {
    let store: PipelineStore;
    let projectId: Id;
    let begin: () => Promise<DrivenTransaction>;

    const taskFixture = (): StoredTask => ({
      task: {
        id: nextId(),
        projectId,
        ticket: {
          provider: 'fake-jira',
          key: `RACE-${counter}`,
          url: `https://jira.example.test/browse/RACE-${counter}`,
        },
        template: 'feature',
        mode: 'normal',
        state: 'active',
        currentStage: 'refinement',
        stageAttempts: { refinement: 1 },
        iterationCounters: {},
        limits: {
          code_review: 3,
          business_review: 2,
          ci_fix: 3,
          human_rounds: 3,
          refinement_questions: 2,
          architecture_revisions: 2,
          rebase: 2,
        },
        sequence: 1,
      },
      template: FEATURE_TEMPLATE,
      priorityRank: 2,
      createdAt: '2026-06-01T09:00:00.000Z',
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      version: INITIAL_TASK_VERSION,
    });

    /** Inserts a task and commits it, so two later transactions can both see it. */
    const givenCommittedTask = async (): Promise<StoredTask> => {
      const stored = taskFixture();
      const scope = await begin();
      await store.tasks.insert(scope.tx, stored);
      await scope.commit();
      return stored;
    };

    const read = async (taskId: Id): Promise<StoredTask> => {
      const scope = await begin();
      try {
        const loaded = await store.tasks.load(scope.tx, taskId);
        if (loaded === null) {
          throw new Error(`task ${taskId} disappeared`);
        }
        return loaded;
      } finally {
        await scope.rollback();
      }
    };

    beforeEach(async () => {
      const context = await harness.create();
      store = context.store;
      projectId = context.projectId;
      begin = context.begin;
      return async () => {
        await context.cleanup();
      };
    });

    it('refuses a save whose snapshot another transaction has already moved', async () => {
      const stored = await givenCommittedTask();

      // The loser reads first and writes last — the stage executor's transaction 2, whose load and
      // save have several statements between them.
      const loser = await begin();
      const stale = await store.tasks.load(loser.tx, stored.task.id);

      // The winner: a whole transaction, start to finish, inside that window.
      const winner = await begin();
      const fresh = await store.tasks.load(winner.tx, stored.task.id);
      await store.tasks.save(winner.tx, {
        ...(fresh as StoredTask),
        costActualUsd: 2.8,
        task: { ...(fresh as StoredTask).task, currentStage: 'code_review' },
      });
      await winner.commit();

      await expect(
        store.tasks.save(loser.tx, { ...(stale as StoredTask), costActualUsd: 0.4 }),
      ).rejects.toMatchObject({
        name: 'TaskConcurrentModificationError',
        concurrencyConflict: true,
        taskId: stored.task.id,
        expectedVersion: INITIAL_TASK_VERSION,
      });
      await loser.rollback();

      // Per column, because the two symptoms WP-15d measured were different columns.
      const after = await read(stored.task.id);
      expect(after.costActualUsd).toBeCloseTo(2.8, 6);
      expect(after.task.currentStage).toBe('code_review');
    });

    it('lets the refused writer through once it re-reads, without losing what it lost to', async () => {
      const stored = await givenCommittedTask();
      const loser = await begin();
      const stale = (await store.tasks.load(loser.tx, stored.task.id)) as StoredTask;

      const winner = await begin();
      const fresh = (await store.tasks.load(winner.tx, stored.task.id)) as StoredTask;
      await store.tasks.save(winner.tx, { ...fresh, costActualUsd: 2.8 });
      await winner.commit();

      await expect(
        store.tasks.save(loser.tx, {
          ...stale,
          task: { ...stale.task, currentStage: 'code_review' },
        }),
      ).rejects.toThrow(/modified concurrently/);
      await loser.rollback();

      // The retry: a **new** transaction that reads again, which is the only way the stage move
      // and the cost can both survive. Re-applying `stale` is the lost update itself.
      const retry = await begin();
      const reread = (await store.tasks.load(retry.tx, stored.task.id)) as StoredTask;
      await store.tasks.save(retry.tx, {
        ...reread,
        task: { ...reread.task, currentStage: 'code_review' },
      });
      await retry.commit();

      const after = await read(stored.task.id);
      expect(after.costActualUsd).toBeCloseTo(2.8, 6);
      expect(after.task.currentStage).toBe('code_review');
    });

    /**
     * The direction the narrow write did **not** close, and it was live until WP-15e.
     *
     * WP-15d stopped the workpad job from clobbering the executor by giving it `saveWorkpad`. The
     * executor's own `save` still named `workpad_ref`, so the *other* direction was untouched: a
     * workpad written while transaction 2 was open was put straight back to `null` by the save at
     * the end of it, and the task lost the comment the whole of BD-023 hangs on.
     */
    it('does not put back a workpad another writer filled in while it was deciding', async () => {
      const stored = await givenCommittedTask();

      const executor = await begin();
      const stale = (await store.tasks.load(executor.tx, stored.task.id)) as StoredTask;
      expect(stale.workpad).toBeNull();

      const job = await begin();
      await store.tasks.saveWorkpad(job.tx, stored.task.id, {
        provider: 'fake-jira',
        ticket_key: stored.task.ticket.key,
        comment_id: 'comment-1',
        url: null,
      });
      await job.commit();

      // No conflict: the workpad is not a column `save` owns, so the narrow write does not move
      // the version and this write is not refused.
      await store.tasks.save(executor.tx, { ...stale, costActualUsd: 0.4 });
      await executor.commit();

      const after = await read(stored.task.id);
      expect(after.workpad?.comment_id).toBe('comment-1');
      expect(after.costActualUsd).toBeCloseTo(0.4, 6);
    });

    it('does not put back a ticket snapshot another writer filled in while it was deciding', async () => {
      const stored = await givenCommittedTask();

      const executor = await begin();
      const stale = (await store.tasks.load(executor.tx, stored.task.id)) as StoredTask;

      const job = await begin();
      await store.tasks.saveTicketSnapshot(
        job.tx,
        stored.task.id,
        {
          title: 'rollback sessions after a failed migration',
          description: 'the session table keeps the half-written rows',
          comments: [],
          truncated: false,
          comment_count: 0,
          redaction_count: 0,
          ticket_updated_at: '2026-06-02T09:00:00.000Z',
        },
        '2026-06-02T09:05:00.000Z' as IsoDateTime,
      );
      await job.commit();

      await store.tasks.save(executor.tx, {
        ...stale,
        task: { ...stale.task, currentStage: 'architecture' },
      });
      await executor.commit();

      const after = await read(stored.task.id);
      expect(after.ticketSnapshot?.title).toBe('rollback sessions after a failed migration');
      expect(after.ticketSnapshotAt).toBe('2026-06-02T09:05:00.000Z');
      expect(after.task.currentStage).toBe('architecture');
    });

    /**
     * Standing rule 79: assert the **derived total**, never the field.
     *
     * This is the measurement backlog 18 was filed on, reproduced deliberately: seven agent stages
     * at 0.40 USD each, with the workpad job committing inside every one of the executor's write
     * windows. Before WP-15e the answer was 2.40 — one stage's spend silently gone — and the only
     * reason anybody found out was an assertion that happened to sum.
     */
    it(`keeps every stage's spend when a job writes the row inside each write window`, async () => {
      const stored = await givenCommittedTask();

      for (let stage = 1; stage <= AGENT_STAGES; stage += 1) {
        const executor = await begin();
        const snapshot = (await store.tasks.load(executor.tx, stored.task.id)) as StoredTask;

        const job = await begin();
        await store.tasks.saveWorkpad(job.tx, stored.task.id, {
          provider: 'fake-jira',
          ticket_key: stored.task.ticket.key,
          comment_id: `comment-${stage}`,
          url: null,
        });
        await job.commit();

        await store.tasks.save(executor.tx, {
          ...snapshot,
          costActualUsd: snapshot.costActualUsd + COST_PER_STAGE,
          task: {
            ...snapshot.task,
            stageAttempts: { ...snapshot.task.stageAttempts, [`s${stage}`]: 1 },
          },
        });
        await executor.commit();
      }

      const after = await read(stored.task.id);
      expect(after.costActualUsd).toBeCloseTo(COST_PER_STAGE * AGENT_STAGES, 6);
      expect(after.workpad?.comment_id).toBe(`comment-${AGENT_STAGES}`);
      expect(Object.keys(after.task.stageAttempts)).toHaveLength(AGENT_STAGES + 1);
    });

    it('hands back the version it wrote, so a second save in the same transaction is not a conflict', async () => {
      const stored = await givenCommittedTask();
      const scope = await begin();
      const loaded = (await store.tasks.load(scope.tx, stored.task.id)) as StoredTask;

      // The shape `stageCompletedHandler` has: record the merge request, then move the stage.
      const first = await store.tasks.save(scope.tx, { ...loaded, branch: 'agentic/race-1' });
      expect(first.version).toBe(loaded.version + 1);
      const second = await store.tasks.save(scope.tx, {
        ...first,
        task: { ...first.task, currentStage: 'code_review' },
      });
      expect(second.version).toBe(loaded.version + 2);
      await scope.commit();

      const after = await read(stored.task.id);
      expect(after.branch).toBe('agentic/race-1');
      expect(after.task.currentStage).toBe('code_review');
      expect(after.version).toBe(INITIAL_TASK_VERSION + 2);
    });

    it('still refuses a save for a task that does not exist, and not as a conflict', async () => {
      // Rule 42's other side. Both failures are "the update matched no row", and collapsing them
      // into one would make a caller retry for ever against a task that was deleted — so the
      // absent row must **not** carry the marker the retry loops branch on.
      const scope = await begin();
      const absent = taskFixture();
      const error = await store.tasks.save(scope.tx, absent).then(
        () => null,
        (thrown: unknown) => thrown,
      );
      await scope.rollback();
      expect(error).toBeInstanceOf(Error);
      expect((error as { concurrencyConflict?: unknown }).concurrencyConflict).toBeUndefined();
      expect((error as Error).message).toMatch(/does not exist/);
    });
  });
};
