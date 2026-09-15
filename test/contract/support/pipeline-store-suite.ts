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
import type {
  PipelineStore,
  StoredBreakdownItem,
  StoredTask,
  Transaction,
} from '@platform/application';
import { INITIAL_TASK_VERSION } from '@platform/application';
import type { Id, IsoDateTime, Slug, TaskDependencies, TaskReviewers } from '@platform/contracts';
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
      ticketSnapshotAt: null,
      reviewSubject: null,
      historySample: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      requestedByUserId: null,
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
        });
        const loaded = await store.tasks.load(tx, stored.task.id);
        expect(loaded?.task.state).toBe('active');
        expect(loaded?.task.currentStage).toBe('implementation');
        expect(loaded?.task.stageAttempts).toEqual({ refinement: 1, implementation: 2 });
        expect(loaded?.task.iterationCounters).toEqual({ ci_fix: 1 });
      });

      it('adds a run’s spend without touching anything else', async () => {
        // `cost_actual` left `save`'s column list at WP-31: the ask executor adds to it from a
        // process that runs beside the stage executor, so it is an **increment** the store performs
        // rather than a value a caller computed from a snapshot it read earlier. Two calls, so the
        // second is asserted to add rather than to replace — which is the whole difference.
        const stored = task();
        await store.tasks.insert(tx, stored);
        await store.tasks.addSpend(tx, stored.task.id, 0.4);
        await store.tasks.addSpend(tx, stored.task.id, 3.1);
        const loaded = await store.tasks.load(tx, stored.task.id);
        expect(loaded?.costActualUsd).toBeCloseTo(3.5, 6);
        // …and nothing else moved: the state is the one `insert` wrote.
        expect(loaded?.task.state).toBe(stored.task.state);
        expect(loaded?.task.currentStage).toBe(stored.task.currentStage);
      });

      it('refuses a spend that is not a finite, non-negative number', async () => {
        // Money only ever goes one way here; a caller that computed a negative has a defect the
        // ledger must not absorb (standing rule 20). Both stores refuse with the same sentence.
        const stored = task();
        await store.tasks.insert(tx, stored);
        await expect(store.tasks.addSpend(tx, stored.task.id, -1)).rejects.toThrow(/non-negative/);
        await expect(store.tasks.addSpend(tx, stored.task.id, Number.NaN)).rejects.toThrow(
          /non-negative/,
        );
        expect((await store.tasks.load(tx, stored.task.id))?.costActualUsd).toBe(0);
      });

      it('refuses to add spend to a task it has never seen', async () => {
        await expect(store.tasks.addSpend(tx, task().task.id, 0.4)).rejects.toThrow();
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
        });
        await store.tasks.addSpend(tx, stored.task.id, 4.25);
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
       * WP-37's write, held to the same property the other two narrow writes are — and to one
       * more, which is what makes it worth its own case rather than a line in theirs.
       *
       * `risk_classes` is computed in the `risk_route` duty at the rebase gate, beside the stage
       * executor's transactions, so the assertion is again on a **derived total** rather than on
       * the column (standing rule 79). The extra property is **replacement**: the gate is
       * re-entered on every default-branch move, so a second write with fewer classes must leave
       * fewer classes on the row. A merging implementation passes the first half of this case and
       * fails the second.
       */
      it('writes the risk classes whole, without writing anything else', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const stale = await store.tasks.load(tx, stored.task.id);
        expect(stale?.riskClasses).toEqual([]);
        await store.tasks.save(tx, {
          ...(stale as NonNullable<typeof stale>),
          task: { ...stored.task, state: 'active', currentStage: 'rebase_gate' },
        });
        await store.tasks.addSpend(tx, stored.task.id, 1.5);
        await store.tasks.saveRiskClasses(tx, stored.task.id, ['data', 'auth']);

        const first = await store.tasks.load(tx, stored.task.id);
        expect(first?.riskClasses).toEqual(['data', 'auth']);
        expect(first?.costActualUsd).toBeCloseTo(1.5, 6);
        expect(first?.task.state).toBe('active');
        expect(first?.task.currentStage).toBe('rebase_gate');

        // The default branch moved and the merge request no longer touches an `auth` path.
        await store.tasks.saveRiskClasses(tx, stored.task.id, ['data']);
        expect((await store.tasks.load(tx, stored.task.id))?.riskClasses).toEqual(['data']);

        // …and the empty list is a write like any other, not "leave it alone".
        await store.tasks.saveRiskClasses(tx, stored.task.id, []);
        expect((await store.tasks.load(tx, stored.task.id))?.riskClasses).toEqual([]);
      });

      it('refuses to write risk classes for a task that does not exist', async () => {
        await expect(store.tasks.saveRiskClasses(tx, nextId(), ['data'])).rejects.toThrow();
      });

      /**
       * WP-39's write, and the two properties that are this one's rather than the others' (rule 23:
       * a new port obligation lands in the shared suite in the same change, or it is a
       * provider-local promise).
       *
       * The first is the one every narrow write owes — a concurrent `addSpend` survives it, because
       * the `coverage` duty fires on `ci.pipeline.finished` and runs beside the stage executor
       * (standing rule 79). The second is **that the record comes back as it went in, nulls
       * included**: the column is `jsonb` and every field inside it is how a *missing* number is
       * spelled, so a store that dropped a `null` key, or that answered `0` for one, would publish
       * "the agent added no coverage" on a task nobody measured (standing rule 16). An
       * implementation that stored only the delta passes nothing here.
       */
      it('writes the coverage record whole, nulls and all, without writing anything else', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const stale = await store.tasks.load(tx, stored.task.id);
        expect(stale?.coverage).toBeNull();
        await store.tasks.save(tx, {
          ...(stale as NonNullable<typeof stale>),
          task: { ...stored.task, state: 'active', currentStage: 'ready_for_merge' },
        });
        await store.tasks.addSpend(tx, stored.task.id, 2.25);
        const measured = {
          head_sha: 'b'.repeat(40),
          head_pct: 81.5,
          base_branch: 'main',
          base_sha: 'a'.repeat(40),
          base_pct: 79,
          delta_pct: 2.5,
          measured_at: '2026-06-01T09:00:00.000Z',
        } as const;
        await store.tasks.saveCoverage(tx, stored.task.id, measured);

        const first = await store.tasks.load(tx, stored.task.id);
        expect(first?.coverage).toEqual(measured);
        expect(first?.costActualUsd).toBeCloseTo(2.25, 6);
        expect(first?.task.state).toBe('active');
        expect(first?.task.currentStage).toBe('ready_for_merge');

        // A second pipeline reported nothing at all: the record is replaced whole, so the previous
        // measurement's numbers must not survive underneath it.
        const reportedNothing = {
          head_sha: 'c'.repeat(40),
          head_pct: null,
          base_branch: null,
          base_sha: null,
          base_pct: null,
          delta_pct: null,
          measured_at: '2026-06-01T10:00:00.000Z',
        } as const;
        await store.tasks.saveCoverage(tx, stored.task.id, reportedNothing);
        expect((await store.tasks.load(tx, stored.task.id))?.coverage).toEqual(reportedNothing);
      });

      it('refuses a coverage record the published shape cannot describe', async () => {
        // Same reason as the workpad case below: `jsonb` accepts any document, so the refusal has
        // to be at the write, where the stack trace still names the caller (WP-15h).
        const stored = task();
        await store.tasks.insert(tx, stored);
        await expect(
          store.tasks.saveCoverage(tx, stored.task.id, {
            head_sha: 'b'.repeat(40),
            head_pct: 120,
            base_branch: null,
            base_sha: null,
            base_pct: null,
            delta_pct: null,
            measured_at: '2026-06-01T09:00:00.000Z',
          }),
        ).rejects.toThrow();
      });

      /**
       * WP-38's two records, held to the same property every narrow writer here is held to.
       *
       * The dependency gate's `ask` ending writes the **aggregate** in the same transaction as this
       * record (the task moves to `waiting_answers`), which is exactly the arrangement that makes a
       * whole-row write wrong: the record must survive its own transaction's aggregate write *and*
       * a concurrent spend from another writer (standing rule 79 — assert a derived total).
       */
      it('writes the dependency record whole, beside an aggregate write and a concurrent spend', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const stale = await store.tasks.load(tx, stored.task.id);
        expect(stale?.dependencies).toBeNull();
        const saved = await store.tasks.save(tx, {
          ...(stale as NonNullable<typeof stale>),
          task: { ...stored.task, state: 'waiting_answers', currentStage: 'ci_gate' },
        });
        await store.tasks.addSpend(tx, stored.task.id, 1.5);
        const found = {
          head_sha: 'b'.repeat(40),
          decision: 'ask',
          added: [
            {
              ecosystem: 'npm',
              name: 'lodash',
              from: 'manifest',
              path: 'package.json',
              policy: 'ask',
              allowlisted: false,
              metadata: {
                status: 'checked',
                license: 'MIT',
                last_published_at: '2026-04-02T11:00:00.000Z',
                deprecated: false,
                source_url: 'https://www.npmjs.com/package/lodash',
              },
            },
          ],
          unread: [{ ecosystem: 'maven', path: 'pom.xml' }],
          truncated: false,
          question_id: nextId(),
          checked_at: '2026-06-01T09:00:00.000Z',
        } satisfies TaskDependencies;
        await store.tasks.saveDependencies(tx, stored.task.id, found);

        const first = await store.tasks.load(tx, stored.task.id);
        expect(first?.dependencies).toEqual(found);
        expect(first?.costActualUsd).toBeCloseTo(1.5, 6);
        expect(first?.task.state).toBe('waiting_answers');
        expect(first?.version).toBe(saved.version);

        // The next implementation run is a new diff: the record is replaced whole, so a package the
        // change no longer adds has to leave the row.
        const clean = {
          head_sha: 'c'.repeat(40),
          decision: 'none',
          added: [],
          unread: [],
          truncated: false,
          question_id: null,
          checked_at: '2026-06-01T10:00:00.000Z',
        } satisfies TaskDependencies;
        await store.tasks.saveDependencies(tx, stored.task.id, clean);
        expect((await store.tasks.load(tx, stored.task.id))?.dependencies).toEqual(clean);
      });

      it('refuses a dependency record the published shape cannot describe', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        await expect(
          store.tasks.saveDependencies(tx, stored.task.id, {
            head_sha: 'b'.repeat(40),
            // Not one of the four decisions the panel can render.
            decision: 'maybe',
            added: [],
            unread: [],
            truncated: false,
            question_id: null,
            checked_at: '2026-06-01T09:00:00.000Z',
          } as never),
        ).rejects.toThrow();
        expect((await store.tasks.load(tx, stored.task.id))?.dependencies).toBeNull();
      });

      it('writes the routed reviewers whole, including the handles that resolved to nobody', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const routed = {
          source: 'codeowners',
          handles: ['@billing-team', '@ana'],
          assigned: ['4242'],
          unresolved: ['@billing-team'],
          truncated: false,
          routed_at: '2026-06-01T09:00:00.000Z',
        } satisfies TaskReviewers;
        await store.tasks.saveRequiredReviewers(tx, stored.task.id, routed);
        expect((await store.tasks.load(tx, stored.task.id))?.requiredReviewers).toEqual(routed);

        // The gate is re-entered on every default-branch move, so a reviewer the change no longer
        // needs leaves the row — the same replacement rule `saveRiskClasses` has.
        const none = {
          source: 'none',
          handles: [],
          assigned: [],
          unresolved: [],
          truncated: false,
          routed_at: '2026-06-01T10:00:00.000Z',
        } satisfies TaskReviewers;
        await store.tasks.saveRequiredReviewers(tx, stored.task.id, none);
        expect((await store.tasks.load(tx, stored.task.id))?.requiredReviewers).toEqual(none);
      });

      it('refuses to write either WP-38 record for a task that does not exist', async () => {
        await expect(
          store.tasks.saveDependencies(tx, nextId(), {
            head_sha: null,
            decision: 'none',
            added: [],
            unread: [],
            truncated: false,
            question_id: null,
            checked_at: '2026-06-01T09:00:00.000Z',
          }),
        ).rejects.toThrow();
        await expect(
          store.tasks.saveRequiredReviewers(tx, nextId(), {
            source: 'none',
            handles: [],
            assigned: [],
            unresolved: [],
            truncated: false,
            routed_at: '2026-06-01T09:00:00.000Z',
          }),
        ).rejects.toThrow();
      });

      it('refuses to write coverage for a task that does not exist', async () => {
        await expect(
          store.tasks.saveCoverage(tx, nextId(), {
            head_sha: 'b'.repeat(40),
            head_pct: 81.5,
            base_branch: 'main',
            base_sha: 'a'.repeat(40),
            base_pct: 79,
            delta_pct: 2.5,
            measured_at: '2026-06-01T09:00:00.000Z',
          }),
        ).rejects.toThrow();
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
        });
        await store.tasks.addSpend(tx, stored.task.id, 4.25);
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

      /**
       * WP-26's conflict warnings ask the store a question no other caller asks: *which other tasks
       * of this project are working through a merge request right now?* The three clauses are
       * asserted separately because each one is a way for the answer to be silently wrong — a task
       * with no merge request, a task that has finished, and the asking task itself.
       */
      it('lists the project’s other live tasks that have a merge request', async () => {
        const withMr = (key: string, state: StoredTask['task']['state'], iid: number): StoredTask =>
          task(
            {
              mr: {
                provider: 'fake-git',
                project_path: 'acme/api',
                iid,
                url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
                branch: `agentic/${key.toLowerCase()}`,
                head_sha: 'b'.repeat(40),
              },
              task: { ...task({}, key).task, state, currentStage: 'ready_for_merge' },
            },
            key,
          );
        const asking = withMr('ACME-M1', 'ready_for_merge', 101);
        const peer = withMr('ACME-M2', 'needs_human', 102);
        const finished = withMr('ACME-M3', 'done', 103);
        const noMergeRequest = task({}, 'ACME-M4');
        for (const row of [asking, peer, finished, noMergeRequest]) {
          await store.tasks.insert(tx, row);
        }

        const found = await store.tasks.listWithMergeRequest(tx, projectId, {
          excludeTaskId: asking.task.id,
          limit: 10,
        });
        // `needs_human` counts — its merge request is still open and still conflicts — while `done`
        // does not, and a task with no merge request cannot overlap with anything.
        expect(found.map((entry) => entry.task.ticket.key)).toEqual(['ACME-M2']);
        // The asking task is excluded by the store rather than by the caller: a task overlaps
        // itself completely, and every caller would have to remember.
        expect(found.map((entry) => entry.task.id)).not.toContain(asking.task.id);
        // And the limit is honoured, which is what bounds the provider reads the caller then makes.
        expect(
          await store.tasks.listWithMergeRequest(tx, projectId, {
            excludeTaskId: asking.task.id,
            limit: 0,
          }),
        ).toEqual([]);
      });

      /**
       * BD-006's probation — "the first 5 tasks" — asked of the store by WP-30's plan-approval gate.
       *
       * Asserted from **both** sides (standing rule 42), and each assertion kills a different wrong
       * answer: a store that counted every task whatever its state would answer 4, one that returned
       * a constant would fail the first (zero) case, and one that ignored `projectId` would answer 2
       * for a project with no rows at all. The zero case is the one the gate leans on hardest,
       * because probation is exactly a project's first tasks.
       */
      it('counts only this project’s completed tasks, and answers zero for a project with none', async () => {
        const inState = (key: string, state: StoredTask['task']['state']): StoredTask =>
          task({ task: { ...task({}, key).task, state } }, key);
        expect(await store.tasks.countCompleted(tx, projectId)).toBe(0);
        for (const row of [
          inState('ACME-P1', 'done'),
          inState('ACME-P2', 'done'),
          inState('ACME-P3', 'cancelled'),
          inState('ACME-P4', 'active'),
        ]) {
          await store.tasks.insert(tx, row);
        }
        expect(await store.tasks.countCompleted(tx, projectId)).toBe(2);
        // A project id with no rows of its own is zero, not "whatever the table holds". A fresh id
        // rather than a second seeded project: nothing is inserted under it, so no foreign key is
        // involved and both stores are asked the same question.
        expect(await store.tasks.countCompleted(tx, nextId())).toBe(0);
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
          startedAt: '2026-06-01T09:00:01.000Z',
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
        // The instant the run started, stored as the caller gave it (WP-15i). It is what a run
        // ended from another process — `POST /api/runs/:id/cancel` — computes its wall time from,
        // and a store that answered `null` would make that a zero nobody measured.
        expect(loaded?.startedAt).toBe('2026-06-01T09:00:01.000Z');
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
          startedAt: '2026-06-01T09:00:01.000Z',
        });

        const loaded = await store.runs.load(tx, runId);
        expect(loaded?.attempt).toBe(2);
        expect(loaded?.stage).toBeNull();
      });

      /**
       * The predicate `RunRepository.finish` carries, from both sides (standing rule 42).
       *
       * It is what makes `POST /api/runs/:id/cancel` safe beside a running stage: two writers can
       * end one run and the row decides which of them did, so the loser writes nothing rather than
       * overwriting the human's decision with its own outcome. A store that ignored the predicate
       * would answer `true` twice here and the second `finish` would silently replace the first.
       */
      it('finishes a live run once, and answers false for a second finisher', async () => {
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
          stage: 'refinement' as Slug,
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
          startedAt: '2026-06-01T09:00:01.000Z',
        });

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
          wallMs: 10,
        });

        expect(await store.runs.finish(tx, outcome('cancelled'))).toBe(true);
        expect(await store.runs.finish(tx, outcome('completed'))).toBe(false);
        // …and the second attempt changed nothing, which is the half a boolean alone would not say.
        const loaded = await store.runs.load(tx, runId);
        expect(loaded?.status).toBe('cancelled');
        expect(loaded?.terminalReason).toBe('cancelled');
      });

      /**
       * The late cost write and the lease, WP-47 — the two methods a run that ends **outside its
       * own process** needs.
       *
       * The seeding helper is shared because every case here is about a run in a particular state,
       * and the states are the whole subject: live, terminal-with-no-figure, terminal-with-a-figure.
       */
      const liveRun = async (): Promise<Id> => {
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
          stage: 'refinement' as Slug,
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
          startedAt: '2026-06-01T09:00:01.000Z',
        });
        return runId;
      };

      const MEASURED = {
        sessionId: 'session-1',
        numTurns: 4,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        cost: { usd: 1.25, is_estimate: false, price_list_id: null },
        wallMs: 900,
      };

      it('stores no cost at all for a run finished without one, rather than a zero', async () => {
        const runId = await liveRun();
        // What the lease sweep writes: it ends the row and has no figure, and `{ usd: 0 }` there
        // would be published as a free run (standing rule 16).
        expect(
          await store.runs.finish(tx, {
            runId,
            status: 'failed',
            terminalReason: 'lease_expired',
            sessionId: null,
            numTurns: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_write_5m_tokens: 0,
              cache_write_1h_tokens: 0,
              cache_read_tokens: 0,
            },
            cost: null,
            wallMs: 10,
          }),
        ).toBe(true);

        expect((await store.runs.load(tx, runId))?.cost).toBeNull();
      });

      it('keeps the estimate and the reported figure apart, in the two columns they belong to', async () => {
        const reported = await liveRun();
        await store.runs.finish(tx, {
          runId: reported,
          status: 'completed',
          terminalReason: 'success',
          sessionId: null,
          numTurns: 1,
          usage: MEASURED.usage,
          cost: { usd: 2, is_estimate: false, price_list_id: null },
          wallMs: 10,
        });
        const estimated = await liveRun();
        await store.runs.finish(tx, {
          runId: estimated,
          status: 'completed',
          terminalReason: 'success',
          sessionId: null,
          numTurns: 1,
          usage: MEASURED.usage,
          // BD-004 `local` mode: the platform priced this, the provider reported nothing.
          cost: { usd: 3, is_estimate: true, price_list_id: null },
          wallMs: 10,
        });

        expect((await store.runs.load(tx, reported))?.cost).toEqual({
          usd: 2,
          is_estimate: false,
          price_list_id: null,
        });
        // `usd_estimated` had no writer at all before WP-47, so this round trip is the whole of
        // what made a `local`-mode run read as free on the wire and commit nothing to any cap.
        expect((await store.runs.load(tx, estimated))?.cost).toEqual({
          usd: 3,
          is_estimate: true,
          price_list_id: null,
        });
      });

      it('records a cost against an already-terminal run, and only the cost', async () => {
        const runId = await liveRun();
        await store.runs.finish(tx, {
          runId,
          status: 'cancelled',
          terminalReason: 'cancelled',
          sessionId: null,
          numTurns: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_write_5m_tokens: 0,
            cache_write_1h_tokens: 0,
            cache_read_tokens: 0,
          },
          cost: null,
          wallMs: 10,
        });

        expect(await store.runs.recordCost(tx, { runId, ...MEASURED })).toBe(true);

        const loaded = await store.runs.load(tx, runId);
        // The **status** is untouched: the other writer's decision is the one that stands, and this
        // is a narrow write of the cost, never a whole row (standing rule 79).
        expect(loaded?.status).toBe('cancelled');
        expect(loaded?.terminalReason).toBe('cancelled');
        expect(loaded?.cost).toEqual({ usd: 1.25, is_estimate: false, price_list_id: null });
      });

      it('refuses a late cost for a live run, and for a row that already carries a figure', async () => {
        const live = await liveRun();
        // The live run's cost belongs to its own `finish`; writing it here would be the lost update
        // the conditional predicate exists to refuse.
        expect(await store.runs.recordCost(tx, { runId: live, ...MEASURED })).toBe(false);

        const ended = await liveRun();
        await store.runs.finish(tx, {
          runId: ended,
          status: 'completed',
          terminalReason: 'success',
          sessionId: null,
          numTurns: 1,
          usage: MEASURED.usage,
          cost: { usd: 9, is_estimate: false, price_list_id: null },
          wallMs: 10,
        });
        expect(await store.runs.recordCost(tx, { runId: ended, ...MEASURED })).toBe(false);
        // …and the figure that was there is still there: a refusal that half-wrote would be worse
        // than one that threw.
        expect((await store.runs.load(tx, ended))?.cost?.usd).toBe(9);
      });

      it('refuses to record a cost for a run it has never seen', async () => {
        await expect(store.runs.recordCost(tx, { runId: nextId(), ...MEASURED })).rejects.toThrow();
      });

      it('claims a lease, lets its owner renew it, and refuses a stranger and a finished run', async () => {
        const runId = await liveRun();

        expect(
          await store.runs.renewLease(tx, {
            runId,
            owner: 'server-1',
            expiresAt: '2026-06-01T09:05:00.000Z' as IsoDateTime,
          }),
        ).toBe(true);
        expect(
          await store.runs.renewLease(tx, {
            runId,
            owner: 'server-1',
            expiresAt: '2026-06-01T09:10:00.000Z' as IsoDateTime,
          }),
        ).toBe(true);
        // A second process must not take a lease whose holder may still be alive.
        expect(
          await store.runs.renewLease(tx, {
            runId,
            owner: 'server-2',
            expiresAt: '2026-06-01T09:10:00.000Z' as IsoDateTime,
          }),
        ).toBe(false);

        await store.runs.finish(tx, {
          runId,
          status: 'completed',
          terminalReason: 'success',
          sessionId: null,
          numTurns: 1,
          usage: MEASURED.usage,
          cost: { usd: 1, is_estimate: false, price_list_id: null },
          wallMs: 10,
        });
        // A heartbeat that arrived late finds the run terminal and writes nothing, which is what
        // lets the sweep and the run's own process race safely.
        expect(
          await store.runs.renewLease(tx, {
            runId,
            owner: 'server-1',
            expiresAt: '2026-06-01T09:15:00.000Z' as IsoDateTime,
          }),
        ).toBe(false);
      });

      it('answers false rather than throwing when a lease is asked for a run that does not exist', async () => {
        expect(
          await store.runs.renewLease(tx, {
            runId: nextId(),
            owner: 'server-1',
            expiresAt: '2026-06-01T09:05:00.000Z' as IsoDateTime,
          }),
        ).toBe(false);
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

      /**
       * `latestOfKind` — the **budget** gate's lookup (WP-28).
       *
       * It answers the opposite question from `forStageAttempt` on purpose, and the difference is
       * the difference between the two gates: a plan approval is about *a plan*, so a second plan
       * needs a second approval; a budget approval is about *the estimate*, which is written once,
       * so a task that has been asked is not asked again however many attempts its stage has had.
       * Both directions here (standing rule 42), plus the kind filter — a lookup that ignored the
       * kind would answer a budget question with a plan approval.
       */
      it('finds the newest approval of a kind whatever attempt asked for it', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const approvalOf = (id: Id, kind: 'plan' | 'budget', requestedAt: string) => ({
          id,
          taskId: stored.task.id,
          projectId,
          kind,
          status: 'pending' as const,
          requestedAt: requestedAt as IsoDateTime,
          deadlineAt: null,
          decidedByUserId: null,
          decidedAt: null,
          reason: null,
          sequence: 1,
        });

        expect(
          await store.approvals.latestOfKind(tx, { taskId: stored.task.id, kind: 'budget' }),
        ).toBeNull();

        const budgetId = nextId();
        await store.approvals.insert(tx, {
          approval: approvalOf(budgetId, 'budget', '2026-06-01T09:00:00.000Z'),
          stage: 'refinement',
          attempt: 1,
        });
        await store.approvals.insert(tx, {
          approval: approvalOf(nextId(), 'plan', '2026-06-01T11:00:00.000Z'),
          stage: 'architecture',
          attempt: 3,
        });

        // Recorded at attempt 1 and found while the task is on attempt 3: the attempt is stored
        // truthfully and is not part of this key.
        const found = await store.approvals.latestOfKind(tx, {
          taskId: stored.task.id,
          kind: 'budget',
        });
        expect(found?.approval.id).toBe(budgetId);
        expect(found?.attempt).toBe(1);
        expect(found?.stage).toBe('refinement');

        // A decided approval still counts as *asked*: the question a second ask would put is the
        // one already answered.
        await store.approvals.save(tx, {
          approval: {
            ...approvalOf(budgetId, 'budget', '2026-06-01T09:00:00.000Z'),
            status: 'rejected',
            decidedByUserId: userId,
            decidedAt: '2026-06-01T10:00:00.000Z' as IsoDateTime,
          },
          stage: 'refinement',
          attempt: 1,
        });
        expect(
          (await store.approvals.latestOfKind(tx, { taskId: stored.task.id, kind: 'budget' }))
            ?.approval.status,
        ).toBe('rejected');

        // Newest wins when there are two of the same kind…
        const newer = nextId();
        await store.approvals.insert(tx, {
          approval: approvalOf(newer, 'budget', '2026-06-02T09:00:00.000Z'),
          stage: 'refinement',
          attempt: 2,
        });
        expect(
          (await store.approvals.latestOfKind(tx, { taskId: stored.task.id, kind: 'budget' }))
            ?.approval.id,
        ).toBe(newer);

        // …and another task's approvals are not this task's.
        const other = task();
        await store.tasks.insert(tx, other);
        expect(
          await store.approvals.latestOfKind(tx, { taskId: other.task.id, kind: 'budget' }),
        ).toBeNull();
      });
    });

    /**
     * The epic-split queue (WP-40) — a port whose two writers race each other by design.
     *
     * The cases are the two places the adapter and the fake could differ and did: what `decide`
     * **answers** (the rows as they are *after* the decision, which a select beside a data-modifying
     * CTE cannot see), and what it refuses (a child somebody has already decided). `redactionCount`
     * rides along because it is summed by two writers — the queue's insert and the decision — and a
     * store that overwrote it instead of adding would hide the queue's own redactions.
     */
    describe('breakdown', () => {
      const seedQueue = async (): Promise<{
        readonly taskId: Id;
        readonly items: readonly StoredBreakdownItem[];
      }> => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const artifactId = nextId();
        await store.artifacts.insert(tx, {
          id: artifactId,
          taskId: stored.task.id,
          type: 'TicketBreakdown',
          version: 1,
          markdown: null,
          data: { children: [] },
          schemaVersion: '1',
          producedByRunId: null,
          createdAt: '2026-06-01T09:00:00.000Z',
        });
        const child = (position: number): StoredBreakdownItem => ({
          id: nextId(),
          projectId,
          taskId: stored.task.id,
          runId: null,
          artifactId,
          position,
          title: `Child ${position + 1}`,
          description: 'What it covers.',
          acceptanceCriteria: [
            {
              id: `AC-${position}`,
              given: 'a queue',
              when: 'a human decides',
              // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
              then: 'the row moves',
              validation: { kind: 'test', value: 'breakdown.test.ts' },
            },
          ],
          size: 'S',
          rationale: 'It can be reverted on its own.',
          status: 'queued',
          decidedByUserId: null,
          decidedAt: null,
          reason: null,
          ticketKey: null,
          ticketUrl: null,
          redactionCount: 2,
          createdAt: '2026-06-01T09:00:00.000Z',
        });
        const items = [child(0), child(1)];
        await store.breakdown.insert(tx, items);
        return { taskId: stored.task.id, items };
      };

      it('answers the rows a decision moved, as they are after it', async () => {
        const queue = await seedQueue();
        const first = queue.items[0] as StoredBreakdownItem;

        const moved = await store.breakdown.decide(tx, {
          taskId: queue.taskId,
          itemIds: [first.id],
          status: 'accepted',
          decidedByUserId: userId,
          decidedAt: '2026-06-02T10:00:00.000Z' as IsoDateTime,
          reason: 'this one first',
          reasonRedactions: 1,
        });

        // The decision, not the state it found: a `select` beside the CTE would answer `queued`
        // here, with a null `decided_at` and the row's original count.
        expect(moved).toHaveLength(1);
        expect(moved[0]).toMatchObject({
          id: first.id,
          status: 'accepted',
          decidedByUserId: userId,
          decidedAt: '2026-06-02T10:00:00.000Z',
          reason: 'this one first',
          // Summed over both writers rather than overwritten (2 from the insert + 1 here).
          redactionCount: 3,
        });
        // …and what the store answers is what the store holds.
        const listed = await store.breakdown.listForTask(tx, queue.taskId);
        expect(listed.map((item) => [item.position, item.status])).toEqual([
          [0, 'accepted'],
          [1, 'queued'],
        ]);
        expect(listed[0]).toEqual(moved[0]);
        expect(listed[0]?.acceptanceCriteria[0]?.given).toBe('a queue');

        // The ticket is stamped on the accepted row by a third writer, and only there.
        await store.breakdown.recordTicket(tx, {
          itemId: first.id,
          ticketKey: 'ACME-1001',
          ticketUrl: 'https://tickets.example.test/browse/ACME-1001',
        });
        expect((await store.breakdown.listForTask(tx, queue.taskId))[0]).toMatchObject({
          ticketKey: 'ACME-1001',
          status: 'accepted',
        });
      });

      it('moves no child a decision has already been made about', async () => {
        const queue = await seedQueue();
        const first = queue.items[0] as StoredBreakdownItem;
        const decide = async (status: 'accepted' | 'rejected', at: string, reason: string) =>
          store.breakdown.decide(tx, {
            taskId: queue.taskId,
            itemIds: [first.id],
            status,
            decidedByUserId: userId,
            decidedAt: at as IsoDateTime,
            reason,
            reasonRedactions: 0,
          });

        expect(await decide('accepted', '2026-06-02T10:00:00.000Z', 'mine')).toHaveLength(1);
        // The second maintainer gets an empty list rather than the first one's decision undone:
        // the `queued` predicate is the store's, so two concurrent deciders cannot both win.
        expect(await decide('rejected', '2026-06-02T10:00:01.000Z', 'no, mine')).toEqual([]);
        expect((await store.breakdown.listForTask(tx, queue.taskId))[0]).toMatchObject({
          status: 'accepted',
          reason: 'mine',
        });

        // A task that owns none of the named rows moves none of them either.
        const other = task();
        await store.tasks.insert(tx, other);
        expect(
          await store.breakdown.decide(tx, {
            taskId: other.task.id,
            itemIds: [queue.items[1]?.id as Id],
            status: 'accepted',
            decidedByUserId: userId,
            decidedAt: '2026-06-02T10:00:02.000Z' as IsoDateTime,
            reason: null,
            reasonRedactions: 0,
          }),
        ).toEqual([]);
      });
    });
  });
};
