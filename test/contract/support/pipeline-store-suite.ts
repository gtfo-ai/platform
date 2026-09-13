/**
 * The `PipelineStore` contract, run against the in-memory store and against PostgreSQL.
 *
 * The saga's unit tier runs on the in-memory store, so every claim it makes rests on the two being
 * interchangeable. This suite is what makes that true — and the cases are chosen for the places
 * they are *not* obviously interchangeable: a save that matches no row, a version counter that has
 * to keep counting across attempts, and the signature channel convergence detection reads, which
 * exists precisely because another writer was overwriting it.
 *
 * What it deliberately does **not** assert is transaction isolation. The in-memory store accepts a
 * `Transaction` handle and ignores it, which is its one kind divergence; the e2e tier is where a
 * rollback means anything.
 */
import type { PipelineStore, StoredTask, Transaction } from '@platform/application';
import { INITIAL_TASK_VERSION } from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';

export interface PipelineStoreHarness {
  readonly name: string;
  /** A store, a transaction handle to pass it, and the ids the fixtures should use. */
  create(): Promise<{
    readonly store: PipelineStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    /** A user the store may reference: `answered_by_user_id` and `decided_by_user_id` are FKs. */
    readonly userId: Id;
    cleanup(): Promise<void>;
  }>;
}

const TICKET = (key: string) => ({
  provider: 'fake-jira',
  key,
  url: `https://jira.example.test/browse/${key}`,
});

let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

export const runPipelineStoreContract = (harness: PipelineStoreHarness): void => {
  describe(`PipelineStore contract — ${harness.name}`, () => {
    let store: PipelineStore;
    let tx: Transaction;
    let projectId: Id;
    let userId: Id;

    const task = (
      overrides: Partial<StoredTask> = {},
      key = `ACME-${counter + 1}`,
    ): StoredTask => ({
      task: {
        id: nextId(),
        projectId,
        ticket: TICKET(key),
        template: 'feature',
        mode: 'normal',
        state: 'queued',
        currentStage: null,
        stageAttempts: {},
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
      ...overrides,
    });

    beforeEach(async () => {
      const context = await harness.create();
      store = context.store;
      tx = context.tx;
      projectId = context.projectId;
      userId = context.userId;
      return async () => {
        await context.cleanup();
      };
    });

    describe('tasks', () => {
      it('round-trips everything the interpreter reads back', async () => {
        const stored = task({
          branch: 'agentic/acme-1',
          mr: {
            provider: 'fake-git',
            project_path: 'acme/api',
            iid: 7,
            url: 'https://git.example.test/acme/api/-/merge_requests/7',
            branch: 'agentic/acme-1',
            head_sha: 'b'.repeat(40),
          },
          costActualUsd: 1.25,
          priorityRank: 1,
        });
        await store.tasks.insert(tx, stored);
        const loaded = await store.tasks.load(tx, stored.task.id);

        expect(loaded?.task).toMatchObject({
          id: stored.task.id,
          template: 'feature',
          state: 'queued',
          limits: stored.task.limits,
        });
        expect(loaded?.mr?.iid).toBe(7);
        expect(loaded?.branch).toBe('agentic/acme-1');
        expect(loaded?.costActualUsd).toBeCloseTo(1.25, 6);
        expect(loaded?.priorityRank).toBe(1);
        // The template snapshot is the task's own, not the shipped one it was copied from.
        expect(loaded?.template.stages.map((stage) => stage.id)).toEqual(
          FEATURE_TEMPLATE.stages.map((stage) => stage.id),
        );
      });

      it('saves the state, the stage, the attempts and the counters', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        await store.tasks.save(tx, {
          ...stored,
          task: {
            ...stored.task,
            state: 'active',
            currentStage: 'implementation',
            stageAttempts: { refinement: 1, implementation: 2 },
            iterationCounters: { ci_fix: 1 },
          },
          costActualUsd: 3.5,
        });
        const loaded = await store.tasks.load(tx, stored.task.id);
        expect(loaded?.task.state).toBe('active');
        expect(loaded?.task.currentStage).toBe('implementation');
        expect(loaded?.task.stageAttempts).toEqual({ refinement: 1, implementation: 2 });
        expect(loaded?.task.iterationCounters).toEqual({ ci_fix: 1 });
        expect(loaded?.costActualUsd).toBeCloseTo(3.5, 6);
      });

      it('refuses to save a task it has never seen', async () => {
        // A save that writes nothing is how a state machine silently stops advancing.
        await expect(store.tasks.save(tx, task())).rejects.toThrow();
      });

      it('writes the workpad without writing anything else, so a concurrent cost survives', async () => {
        // WP-15d. The workpad is rendered by a `pipeline.outbound` job that runs beside the stage
        // executor's own transactions, so it holds a snapshot of the row that is already stale by
        // the time the provider answers. A whole-row `save` from there puts the stale cost, state
        // and stage back: measured as a bug ticket finishing with 2.40 USD of recorded spend after
        // seven runs of 0.40. `saveWorkpad` is the narrow write that cannot.
        const stored = task();
        await store.tasks.insert(tx, stored);
        const stale = await store.tasks.load(tx, stored.task.id);
        // Somebody else moves the task on, exactly as the stage executor does.
        await store.tasks.save(tx, {
          ...(stale as NonNullable<typeof stale>),
          task: { ...stored.task, state: 'active', currentStage: 'implementation' },
          costActualUsd: 4.25,
        });
        await store.tasks.saveWorkpad(tx, stored.task.id, {
          provider: 'fake-jira',
          ticket_key: stored.task.ticket.key,
          comment_id: 'comment-1',
          url: null,
        });

        const loaded = await store.tasks.load(tx, stored.task.id);
        expect(loaded?.workpad?.comment_id).toBe('comment-1');
        expect(loaded?.costActualUsd).toBeCloseTo(4.25, 6);
        expect(loaded?.task.state).toBe('active');
        expect(loaded?.task.currentStage).toBe('implementation');
      });

      /**
       * The column is `jsonb`, so it accepts anything and the disagreement surfaces only when
       * something **reads** it — which nothing did for nine work packages (WP-15h).
       *
       * `upsertWorkpad` returns a `CommentRef`, which is `workpadRefSchema.extend({ marker_id })`.
       * TypeScript passes it through this method's `WorkpadRef` parameter structurally, the adapter
       * stringified it whole, and `GET /api/tasks/:id` — the first reader — answered **500** on
       * `Unrecognized key: "marker_id"` for every task that had a workpad. Both stores now refuse at
       * the write (standing rule 20: fail closed on a mutation), which is where the stack trace
       * still names the caller.
       */
      it('refuses a workpad reference the published shape cannot describe', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        await expect(
          store.tasks.saveWorkpad(tx, stored.task.id, {
            provider: 'fake-jira',
            ticket_key: stored.task.ticket.key,
            comment_id: 'comment-1',
            url: null,
            // The `CommentRef` field that reached the column.
            marker_id: 'agentic:workpad',
          } as never),
        ).rejects.toThrow(/marker_id/);
        // …and nothing was written, so a refusal is not a half-write.
        expect((await store.tasks.load(tx, stored.task.id))?.workpad).toBeNull();
      });

      /**
       * WP-15f's write, held to the same property `saveWorkpad` is held to — and the assertion is
       * on a **derived total**, never on the column that was written (standing rule 79).
       *
       * `ticket_snapshot` is written from the `stage.execute` job, which runs beside the stage
       * executor's own transactions. A whole-row `save` from there is PROGRESS backlog 18: it put a
       * task's `cost_actual` back to 2.40 where 2.80 was owed, and the only reason anybody noticed
       * was an assertion that summed a total.
       */
      it('writes the ticket snapshot without writing anything else, so a concurrent cost survives', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const stale = await store.tasks.load(tx, stored.task.id);
        // Somebody else moves the task on, exactly as the stage executor does.
        await store.tasks.save(tx, {
          ...(stale as NonNullable<typeof stale>),
          task: { ...stored.task, state: 'active', currentStage: 'implementation' },
          costActualUsd: 4.25,
        });
        await store.tasks.saveTicketSnapshot(
          tx,
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

        const loaded = await store.tasks.load(tx, stored.task.id);
        expect(loaded?.ticketSnapshot?.title).toBe('rollback sessions after a failed migration');
        expect(loaded?.ticketSnapshotAt).toBe('2026-06-02T09:05:00.000Z');
        // The derived total, and the two columns WP-15d watched go stale with it.
        expect(loaded?.costActualUsd).toBeCloseTo(4.25, 6);
        expect(loaded?.task.state).toBe('active');
        expect(loaded?.task.currentStage).toBe('implementation');
      });

      it('round-trips a ticket snapshot written by the insert that created the task', async () => {
        // Intake's path: the snapshot is part of the row from the moment it exists, so there is no
        // window for a concurrent writer to lose it (WP-15f).
        const stored = task({
          ticketSnapshot: {
            title: 'rollback sessions after a failed migration',
            description: '',
            comments: [
              {
                id: 'c1',
                author: 'Dana',
                created_at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
                body: 'only on an interrupted migration',
                truncated: true,
              },
            ],
            truncated: true,
            comment_count: 9,
            redaction_count: 2,
            ticket_updated_at: null,
          },
          ticketSnapshotAt: '2026-06-01T09:10:00.000Z' as IsoDateTime,
        });
        await store.tasks.insert(tx, stored);
        const loaded = await store.tasks.load(tx, stored.task.id);
        expect(loaded?.ticketSnapshot).toEqual(stored.ticketSnapshot);
        expect(loaded?.ticketSnapshotAt).toBe('2026-06-01T09:10:00.000Z');
        // A task nobody read the ticket for is spelled `null`, never an empty snapshot.
        const unread = task();
        await store.tasks.insert(tx, unread);
        expect((await store.tasks.load(tx, unread.task.id))?.ticketSnapshot).toBeNull();
        expect((await store.tasks.load(tx, unread.task.id))?.ticketSnapshotAt).toBeNull();
      });

      it('refuses a ticket snapshot for a task it has never seen', async () => {
        await expect(
          store.tasks.saveTicketSnapshot(
            tx,
            nextId(),
            {
              title: 'nobody',
              description: '',
              comments: [],
              truncated: false,
              comment_count: 0,
              redaction_count: 0,
              ticket_updated_at: null,
            },
            '2026-06-02T09:05:00.000Z' as IsoDateTime,
          ),
        ).rejects.toThrow();
      });

      it('refuses a workpad for a task it has never seen', async () => {
        await expect(
          store.tasks.saveWorkpad(tx, nextId(), {
            provider: 'fake-jira',
            ticket_key: 'ACME-1',
            comment_id: 'comment-1',
            url: null,
          }),
        ).rejects.toThrow();
      });

      it('answers null for a task that does not exist, rather than throwing', async () => {
        expect(await store.tasks.load(tx, nextId())).toBeNull();
      });

      it('finds a task by its ticket and by its merge request', async () => {
        const stored = task(
          {
            mr: {
              provider: 'fake-git',
              project_path: 'acme/api',
              iid: 42,
              url: 'https://git.example.test/acme/api/-/merge_requests/42',
              branch: null,
              head_sha: null,
            },
          },
          'ACME-MR',
        );
        await store.tasks.insert(tx, stored);
        expect(
          (
            await store.tasks.findByTicket(tx, {
              projectId,
              provider: 'fake-jira',
              ticketKey: 'ACME-MR',
              mode: 'normal',
            })
          )?.task.id,
        ).toBe(stored.task.id);
        expect((await store.tasks.findByMergeRequest(tx, { projectId, iid: 42 }))?.task.id).toBe(
          stored.task.id,
        );
        expect(await store.tasks.findByMergeRequest(tx, { projectId, iid: 999 })).toBeNull();
      });

      it('counts the WIP slots by state, not by row', async () => {
        const queued = task({}, 'ACME-Q');
        const active = task({}, 'ACME-A');
        const done = task({}, 'ACME-D');
        await store.tasks.insert(tx, queued);
        await store.tasks.insert(tx, active);
        await store.tasks.insert(tx, done);
        await store.tasks.save(tx, { ...active, task: { ...active.task, state: 'active' } });
        await store.tasks.save(tx, { ...done, task: { ...done.task, state: 'done' } });

        const counts = await store.tasks.counts(tx, projectId);
        // `queued` and `done` are out of the pipeline; only `active` holds both slots.
        expect(counts).toEqual({ activeTasks: 1, tasksInPipeline: 1 });
        expect((await store.tasks.queued(tx, projectId)).map((entry) => entry.id)).toEqual([
          queued.task.id,
        ]);
      });

      it('lists the tasks sitting at a stage', async () => {
        const waiting = task({}, 'ACME-W');
        await store.tasks.insert(tx, waiting);
        await store.tasks.save(tx, {
          ...waiting,
          task: { ...waiting.task, state: 'ready_for_merge', currentStage: 'ready_for_merge' },
        });
        expect(
          (await store.tasks.listAtStage(tx, projectId, 'ready_for_merge')).map(
            (entry) => entry.task.id,
          ),
        ).toEqual([waiting.task.id]);
        expect(await store.tasks.listAtStage(tx, projectId, 'code_review')).toEqual([]);
      });
    });

    describe('stage bookkeeping', () => {
      it('keeps the signature separate from the outcome the transition writes', async () => {
        // The defect this column exists for: the transition closes the row with `returned`, and a
        // signature stored in `outcome` would be gone before the next round could compare it.
        const stored = task();
        await store.tasks.insert(tx, stored);
        for (const attempt of [1, 2, 3]) {
          await store.tasks.recordStageEntered(tx, {
            taskId: stored.task.id,
            stage: 'ci_gate',
            attempt,
            causedByEventId: null,
          });
          await store.tasks.recordStageSignature(tx, {
            taskId: stored.task.id,
            stage: 'ci_gate',
            attempt,
            signature: 'ci:failed:test:unit',
          });
          await store.tasks.recordStageExited(tx, {
            taskId: stored.task.id,
            stage: 'ci_gate',
            attempt,
            outcome: 'returned',
            returnReason: `pipeline for sha-${attempt} failed`,
          });
        }

        expect(await store.tasks.recentStageSignatures(tx, stored.task.id, 'ci_gate', 3)).toEqual([
          'ci:failed:test:unit',
          'ci:failed:test:unit',
          'ci:failed:test:unit',
        ]);
        // Oldest first, and bounded by the limit.
        expect(
          await store.tasks.recentStageSignatures(tx, stored.task.id, 'ci_gate', 2),
        ).toHaveLength(2);
        expect(await store.tasks.lastReturnReason(tx, stored.task.id, 'ci_gate')).toBe(
          'pipeline for sha-3 failed',
        );
      });

      it('has no signatures and no reason for a stage that has not run', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        expect(
          await store.tasks.recentStageSignatures(tx, stored.task.id, 'code_review', 3),
        ).toEqual([]);
        expect(await store.tasks.lastReturnReason(tx, stored.task.id, 'code_review')).toBeNull();
      });
    });

    describe('artifacts', () => {
      it('versions each type independently and never overwrites', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        for (const version of [1, 2]) {
          expect(await store.artifacts.nextVersion(tx, stored.task.id, 'RefinedSpec')).toBe(
            version,
          );
          await store.artifacts.insert(tx, {
            id: nextId(),
            taskId: stored.task.id,
            type: 'RefinedSpec',
            version,
            markdown: null,
            data: { goal: `v${version}` },
            schemaVersion: '1',
            producedByRunId: null,
            createdAt: '2026-06-01T09:00:00.000Z',
          });
        }
        expect(await store.artifacts.nextVersion(tx, stored.task.id, 'ImplementationPlan')).toBe(1);
        const latest = await store.artifacts.latest(tx, stored.task.id, 'RefinedSpec');
        expect(latest?.version).toBe(2);
        expect(latest?.data).toEqual({ goal: 'v2' });
        expect(await store.artifacts.listFor(tx, stored.task.id)).toHaveLength(2);
        expect(await store.artifacts.latest(tx, stored.task.id, 'RetroReport')).toBeNull();
      });
    });

    describe('runs', () => {
      it('records a run and its outcome, and totals them for the task', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        // The stage the run belongs to has to exist before the run does: `runs` has no `stage`
        // column and the adapter links `task_stage_id` to the `(task_id, stage, attempt)` row
        // (WP-15h). This is the order the pipeline produces — `task.stage.entered` writes the row,
        // then the `stage.execute` job inserts the run.
        await store.tasks.recordStageEntered(tx, {
          taskId: stored.task.id,
          stage: 'refinement' as Slug,
          attempt: 1,
          causedByEventId: null,
        });
        const runId = nextId();
        await store.runs.insert(tx, {
          id: runId,
          taskId: stored.task.id,
          projectId,
          stage: 'refinement',
          role: 'product_manager',
          mode: 'normal',
          attempt: 1,
          model: 'claude-opus-5',
          effort: 'medium',
          promptVersion: 'basic@1+product_manager',
          status: 'running',
          terminalReason: null,
          sessionId: null,
          numTurns: 0,
          usage: null,
          cost: null,
          wallMs: 0,
          createdAt: '2026-06-01T09:00:00.000Z',
        });
        await store.runs.finish(tx, {
          runId,
          status: 'completed',
          terminalReason: 'success',
          sessionId: 'session-1',
          numTurns: 4,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cache_read_tokens: 0,
          },
          cost: { usd: 0.25, is_estimate: false, price_list_id: null },
          wallMs: 1234,
        });

        const loaded = await store.runs.load(tx, runId);
        expect(loaded?.status).toBe('completed');
        // The stage the caller passed comes back (WP-15h). It had never been asserted, and it had
        // never been true: the SQL adapter dropped the field on insert and answered `stage: null`
        // on load, so `RunRecord.stage` — a required field of the published DTO — had no source at
        // all. The value is not stored on `runs`; it is the joined `task_stages` row.
        expect(loaded?.stage).toBe('refinement');
        expect(loaded?.sessionId).toBe('session-1');
        expect(loaded?.cost?.usd).toBeCloseTo(0.25, 6);
        expect(loaded?.cost?.is_estimate).toBe(false);

        const totals = await store.runs.totalsFor(tx, stored.task.id);
        expect(totals.runs).toBe(1);
        expect(totals.costUsd).toBeCloseTo(0.25, 6);
        expect(totals.isEstimate).toBe(false);
        expect(totals.wallMs).toBe(1234);
      });

      /**
       * The other side of the same boundary (standing rule 42), and the reason the API refuses such
       * a row by name instead of inventing a stage for it: the stage is a **link** to a
       * `task_stages` row, so a run inserted for an attempt nobody entered has none. Asserting only
       * that the stage round-trips would leave an implementation free to store the caller's string
       * and answer it back without the row ever existing.
       */
      it('keeps no stage for a run whose stage attempt was never entered', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        await store.tasks.recordStageEntered(tx, {
          taskId: stored.task.id,
          stage: 'refinement' as Slug,
          attempt: 1,
          causedByEventId: null,
        });
        const runId = nextId();
        await store.runs.insert(tx, {
          id: runId,
          taskId: stored.task.id,
          projectId,
          // Attempt 2 of a stage whose only entered attempt is 1.
          stage: 'refinement' as Slug,
          role: 'product_manager',
          mode: 'normal',
          attempt: 2,
          model: 'claude-opus-5',
          effort: 'medium',
          promptVersion: 'basic@1+product_manager',
          status: 'running',
          terminalReason: null,
          sessionId: null,
          numTurns: 0,
          usage: null,
          cost: null,
          wallMs: 0,
          createdAt: '2026-06-01T09:00:00.000Z',
        });

        const loaded = await store.runs.load(tx, runId);
        expect(loaded?.attempt).toBe(2);
        expect(loaded?.stage).toBeNull();
      });

      it('refuses to finish a run it has never seen', async () => {
        await expect(
          store.runs.finish(tx, {
            runId: nextId(),
            status: 'completed',
            terminalReason: 'success',
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
            wallMs: 0,
          }),
        ).rejects.toThrow();
      });
    });

    describe('questions', () => {
      it('keeps the stage it was asked from, and stops being open once answered', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const questionId = nextId();
        const question = {
          id: questionId,
          taskId: stored.task.id,
          projectId,
          stage: 'refinement' as const,
          runId: null,
          text: 'Which currency?',
          options: ['EUR', 'CZK'],
          blocking: true,
          status: 'open' as const,
          askedAt: '2026-06-01T09:00:00.000Z' as const,
          deadlineAt: null,
          remindersSent: 0,
          answer: null,
          answeredByUserId: null,
          answeredVia: null,
          answeredAt: null,
          sequence: 1,
        };
        await store.questions.insert(tx, question);

        expect((await store.questions.open(tx, stored.task.id)).map((entry) => entry.id)).toEqual([
          questionId,
        ]);
        const loaded = await store.questions.load(tx, questionId);
        expect(loaded?.stage).toBe('refinement');
        expect(loaded?.options).toEqual(['EUR', 'CZK']);

        await store.questions.save(tx, {
          ...question,
          status: 'answered',
          answer: 'EUR',
          answeredByUserId: userId,
          answeredVia: 'ticket',
          answeredAt: '2026-06-01T10:00:00.000Z',
        });
        expect(await store.questions.open(tx, stored.task.id)).toEqual([]);
        expect((await store.questions.load(tx, questionId))?.answer).toBe('EUR');
      });
    });

    describe('approvals', () => {
      it('keys an approval to one stage attempt, so a second plan needs a second approval', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const approvalId = nextId();
        const approval = {
          id: approvalId,
          taskId: stored.task.id,
          projectId,
          kind: 'plan' as const,
          status: 'pending' as const,
          requestedAt: '2026-06-01T09:00:00.000Z' as const,
          deadlineAt: null,
          decidedByUserId: null,
          decidedAt: null,
          reason: null,
          sequence: 1,
        };
        await store.approvals.insert(tx, { approval, stage: 'architecture', attempt: 1 });

        expect(
          (
            await store.approvals.forStageAttempt(tx, {
              taskId: stored.task.id,
              kind: 'plan',
              stage: 'architecture',
              attempt: 1,
            })
          )?.approval.id,
        ).toBe(approvalId);
        // The second attempt at the same stage is a different question.
        expect(
          await store.approvals.forStageAttempt(tx, {
            taskId: stored.task.id,
            kind: 'plan',
            stage: 'architecture',
            attempt: 2,
          }),
        ).toBeNull();

        await store.approvals.save(tx, {
          approval: {
            ...approval,
            status: 'approved',
            decidedByUserId: userId,
            decidedAt: '2026-06-01T10:00:00.000Z',
          },
          stage: 'architecture',
          attempt: 1,
        });
        expect((await store.approvals.load(tx, approvalId))?.approval.status).toBe('approved');
      });
    });
  });
};
