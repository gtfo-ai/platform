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
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
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
          rebase_rechecks: 10,
          dependency_policy: 2,
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
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
      reviewSubject: null,
      historySample: null,
      qaStage: false,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      reviewThreads: null,
      readyHeadSha: null,
      ciHeadSha: null,
      ciExcusedPaths: [],
      requestedByUserId: null,
      pipelineDial: null,
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
        task: { ...(fresh as StoredTask).task, currentStage: 'code_review' },
      });
      // The spend is its own narrow write since WP-31 (`addSpend` is an increment, because the ask
      // executor adds to the same column from another process). The rest of this case is unchanged:
      // what is being asserted is that the **version** refuses a stale whole-row save.
      await store.tasks.addSpend(winner.tx, stored.task.id, 2.8);
      await winner.commit();

      await expect(store.tasks.save(loser.tx, stale as StoredTask)).rejects.toMatchObject({
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
      // A spend **and** a version bump, so the loser below is genuinely refused: `addSpend` alone
      // moves no version, which is the property that lets it run beside the executor at all.
      await store.tasks.save(winner.tx, { ...fresh, branch: 'agentic/winner' });
      await store.tasks.addSpend(winner.tx, stored.task.id, 2.8);
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
      await store.tasks.save(executor.tx, stale);
      await store.tasks.addSpend(executor.tx, stored.task.id, 0.4);
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
          task: {
            ...snapshot.task,
            stageAttempts: { ...snapshot.task.stageAttempts, [`s${stage}`]: 1 },
          },
        });
        await store.tasks.addSpend(executor.tx, stored.task.id, COST_PER_STAGE);
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

    /**
     * Two writers ending one run — WP-15i's other race, and the reason `RunRepository.finish` is
     * conditional.
     *
     * The stage executor ends the run it started; `POST /api/runs/:run_id/cancel` ends it from an
     * HTTP request in whichever process is serving the API. Without the predicate the second write
     * silently replaces the first, and the one that loses is whichever committed earlier — which
     * for a human pressing cancel means their decision is overwritten by the outcome of the run
     * they cancelled.
     *
     * There is no version column here and none is needed: a terminal status is terminal, so "is it
     * still live" and "did I move it" are the same question. Against PostgreSQL the losing `update`
     * re-evaluates its `where` clause against the committed row and matches nothing.
     */
    it('lets exactly one of two transactions end a live run', async () => {
      const stored = await givenCommittedTask();
      const runId = nextId();
      const opening = await begin();
      await store.tasks.recordStageEntered(opening.tx, {
        taskId: stored.task.id,
        stage: 'refinement' as Slug,
        attempt: 1,
        causedByEventId: null,
      });
      await store.runs.insert(opening.tx, {
        id: runId,
        taskId: stored.task.id,
        projectId,
        stage: 'refinement' as Slug,
        role: 'product_manager',
        mode: 'normal',
        attempt: 1,
        model: 'claude-opus-5',
        effort: 'medium',
        promptVersion: 'race@1',
        systemPrompt: null,
        userPrompt: null,
        redactionCount: 0,
        contextPack: null,
        settings: null,
        reserveUsd: null,
        promptsWithheld: null,
        providerMode: 'api',
        status: 'running',
        terminalReason: null,
        sessionId: null,
        numTurns: 0,
        usage: null,
        cost: null,
        wallMs: 0,
        createdAt: '2026-06-01T09:00:00.000Z',
        startedAt: '2026-06-01T09:00:01.000Z',
      });
      await opening.commit();

      const outcome = (status: 'cancelled' | 'completed') => ({
        runId,
        status,
        terminalReason: status === 'cancelled' ? ('cancelled' as const) : ('success' as const),
        sessionId: null,
        numTurns: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        cost: { usd: 0, is_estimate: true, price_list_id: null },
        wallMs: 5,
      });

      // The human cancels and commits…
      const human = await begin();
      expect(await store.runs.finish(human.tx, outcome('cancelled'))).toBe(true);
      await human.commit();

      // …and the executor, whose run has just returned, finds the row already terminal.
      const executor = await begin();
      expect(await store.runs.finish(executor.tx, outcome('completed'))).toBe(false);
      await executor.commit();

      const after = await begin();
      const loaded = await store.runs.load(after.tx, runId);
      await after.rollback();
      expect(loaded?.status).toBe('cancelled');
      expect(loaded?.terminalReason).toBe('cancelled');
    });

    /**
     * WP-91: `counts` serialises admission per project, so two admissions in one instant cannot
     * both pass `max_parallel_tasks: 1`. The first admitter counts and inserts its active task;
     * the second counts while the first is still open. Against PostgreSQL the second count waits
     * on the first transaction and then sees its task; without the lock it answered `0` — the task
     * was uncommitted — and both admitted. The in-memory store has no isolation, so the write is
     * visible at once and the same assertion holds by ordering.
     */
    it('counts an admission another transaction made in the same instant, once it commits', async () => {
      // Relative to what the project already holds: the harness's project outlives one case.
      const first = await begin();
      const before = await store.tasks.counts(first.tx, projectId);
      await store.tasks.insert(first.tx, taskFixture());
      const second = await begin();
      const pending = store.tasks.counts(second.tx, projectId);
      // Give the second count every chance to answer **before** the first commits. With the lock
      // it cannot — it is waiting on the first transaction — so the wait changes nothing about a
      // pass; without it the count answers the uncommitted state here and the assertion below
      // fails by name (measured: removing the lock passed this case 3 of 3 before the wait was
      // added, because the count's second statement was only sent after the commit).
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 250))]);
      await first.commit();
      const counted = await pending;
      await second.rollback();
      expect(counted.activeTasks).toBe(before.activeTasks + 1);
      expect(counted.tasksInPipeline).toBe(before.tasksInPipeline + 1);
    });

    /**
     * WP-184's duty lease (migration 0091): two performers of one task's duty group, each claiming
     * in a transaction of its own and committing it — the shape `withTaskDutyLease` uses.
     */
    describe('the task duty lease (WP-184)', () => {
      const AT = '2026-06-01T09:00:00.000Z' as IsoDateTime;
      const plus = (ms: number) => new Date(Date.parse(AT) + ms).toISOString() as IsoDateTime;
      const claim = async (
        taskId: Id,
        holder: string,
        now: IsoDateTime,
        expiresAt: IsoDateTime,
      ) => {
        const scope = await begin();
        const held = await store.dutyLeases.claim(scope.tx, {
          taskId,
          lease: 'review_conversation',
          holder,
          now,
          expiresAt,
        });
        await scope.commit();
        return held;
      };
      const release = async (taskId: Id, holder: string) => {
        const scope = await begin();
        await store.dutyLeases.release(scope.tx, { taskId, lease: 'review_conversation', holder });
        await scope.commit();
      };

      it('lets one holder in, refuses a second while the lease is live, and renews the first', async () => {
        const { task } = await givenCommittedTask();
        expect(await claim(task.id, 'duty:a', AT, plus(120_000))).toBe(true);
        expect(await claim(task.id, 'duty:b', plus(1_000), plus(121_000))).toBe(false);
        // The holder's own renewal pushes the expiry out, so the second is still refused after
        // the first lease would have lapsed.
        expect(await claim(task.id, 'duty:a', plus(60_000), plus(180_000))).toBe(true);
        expect(await claim(task.id, 'duty:b', plus(150_000), plus(270_000))).toBe(false);
      });

      it('hands the lease on at a release, and only its holder’s release counts', async () => {
        const { task } = await givenCommittedTask();
        expect(await claim(task.id, 'duty:a', AT, plus(120_000))).toBe(true);
        await release(task.id, 'duty:b');
        expect(await claim(task.id, 'duty:b', plus(1_000), plus(121_000))).toBe(false);
        await release(task.id, 'duty:a');
        expect(await claim(task.id, 'duty:b', plus(2_000), plus(122_000))).toBe(true);
      });

      it('takes over a lease whose holder stopped renewing once it expires', async () => {
        const { task } = await givenCommittedTask();
        expect(await claim(task.id, 'duty:dead', AT, plus(120_000))).toBe(true);
        expect(await claim(task.id, 'duty:b', plus(119_000), plus(239_000))).toBe(false);
        expect(await claim(task.id, 'duty:b', plus(120_000), plus(240_000))).toBe(true);
        // The dead holder's late renewal is refused: the lease is the new holder's now.
        expect(await claim(task.id, 'duty:dead', plus(121_000), plus(241_000))).toBe(false);
      });

      it('renews only its holder’s live row, and never brings a released one back (review round 1)', async () => {
        const { task } = await givenCommittedTask();
        const renew = async (holder: string, now: IsoDateTime, expiresAt: IsoDateTime) => {
          const scope = await begin();
          const renewed = await store.dutyLeases.renew(scope.tx, {
            taskId: task.id,
            lease: 'review_conversation',
            holder,
            now,
            expiresAt,
          });
          await scope.commit();
          return renewed;
        };
        expect(await claim(task.id, 'duty:a', AT, plus(120_000))).toBe(true);
        expect(await renew('duty:b', plus(1_000), plus(121_000))).toBe(false);
        expect(await renew('duty:a', plus(60_000), plus(180_000))).toBe(true);
        expect(await claim(task.id, 'duty:b', plus(150_000), plus(270_000))).toBe(false);
        await release(task.id, 'duty:a');
        // The renewal that lands after the release finds nothing to extend and inserts nothing.
        expect(await renew('duty:a', plus(61_000), plus(181_000))).toBe(false);
        expect(await claim(task.id, 'duty:b', plus(62_000), plus(182_000))).toBe(true);
      });

      it('keeps one lease per task', async () => {
        const first = await givenCommittedTask();
        const second = await givenCommittedTask();
        expect(await claim(first.task.id, 'duty:a', AT, plus(120_000))).toBe(true);
        expect(await claim(second.task.id, 'duty:b', AT, plus(120_000))).toBe(true);
      });
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
