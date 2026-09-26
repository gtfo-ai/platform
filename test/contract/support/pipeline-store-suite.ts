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
    /**
     * Appends one **committed** event to a task's stream, in the order given (WP-56) — what
     * `tasks.takenOver` reads. PostgreSQL inserts into `events` inside the case's transaction; the
     * in-memory store is built over a list this appends to, as the pipeline harness builds it over
     * `MemoryEventing`'s log.
     */
    appendTaskEvent(event: TaskStreamEvent): Promise<void>;
    cleanup(): Promise<void>;
  }>;
}

/** One event on a task's stream, as the contract's take-over cases write it. */
export interface TaskStreamEvent {
  readonly id: Id;
  readonly taskId: Id;
  readonly seq: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: IsoDateTime;
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
    let appendTaskEvent: (event: TaskStreamEvent) => Promise<void>;

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
      ticketSignalAt: null,
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
      appendTaskEvent = context.appendTaskEvent;
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
       * WP-59 review round 1: `bumpVersion` moves the token and nothing else, so a `save` over a
       * snapshot taken before it refuses with the error every owner retries — which is how an
       * out-of-band append on a live stream (the conflict warning's peer half) stops being a
       * `StreamConflictError` nobody retries.
       */
      it('bumps the version alone, so a save over an older snapshot refuses and a fresh one lands', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const before = (await store.tasks.load(tx, stored.task.id)) as StoredTask;
        await store.tasks.bumpVersion(tx, stored.task.id);

        const after = (await store.tasks.load(tx, stored.task.id)) as StoredTask;
        expect(after.version).toBe(before.version + 1);
        expect(after.task.state).toBe(before.task.state);
        expect(after.costActualUsd).toBe(before.costActualUsd);
        await expect(
          store.tasks.save(tx, { ...before, task: { ...before.task, state: 'active' } }),
        ).rejects.toMatchObject({ concurrencyConflict: true });
        const saved = await store.tasks.save(tx, {
          ...after,
          task: { ...after.task, state: 'active' },
        });
        expect(saved.version).toBe(after.version + 1);
      });

      it('refuses to bump the version of a task that does not exist', async () => {
        await expect(store.tasks.bumpVersion(tx, nextId())).rejects.toThrow();
      });

      /**
       * WP-60, Q61 (b): the task's last provider signal. One statement over every **live** task of
       * the ticket, forward only, no version bump — each property asserted on both stores, because
       * a fake that moved the token or went backwards would certify a writer PostgreSQL does not
       * have (rule 23).
       */
      it('records a ticket signal on the live tasks of that ticket, forward only, and nothing else', async () => {
        const key = `SIG-${counter + 1}`;
        const live = task({}, key);
        const shadow = task({ task: { ...task().task, mode: 'shadow' } }, key);
        const finished = {
          ...shadow,
          task: { ...shadow.task, ticket: TICKET(key), state: 'done' as const },
        };
        const other = task();
        await store.tasks.insert(tx, live);
        await store.tasks.insert(tx, finished);
        await store.tasks.insert(tx, other);
        // The insert never writes the signal, whatever the snapshot carried.
        await store.tasks.insert(tx, { ...task(), ticketSignalAt: '2026-06-01T08:00:00.000Z' });

        const signal = {
          projectId,
          provider: 'fake-jira',
          ticketKey: key,
          at: '2026-06-01T09:10:00.000Z' as IsoDateTime,
        };
        expect(await store.tasks.recordTicketSignal(tx, signal)).toBe(1);
        const loaded = (await store.tasks.load(tx, live.task.id)) as StoredTask;
        expect(loaded.ticketSignalAt).toBe('2026-06-01T09:10:00.000Z');
        expect(loaded.version).toBe(live.version);
        expect((await store.tasks.load(tx, finished.task.id))?.ticketSignalAt).toBeNull();
        expect((await store.tasks.load(tx, other.task.id))?.ticketSignalAt).toBeNull();

        // Older: the row keeps the later instant. Newer: it moves.
        await store.tasks.recordTicketSignal(tx, {
          ...signal,
          at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
        });
        expect((await store.tasks.load(tx, live.task.id))?.ticketSignalAt).toBe(
          '2026-06-01T09:10:00.000Z',
        );
        await store.tasks.recordTicketSignal(tx, {
          ...signal,
          at: '2026-06-01T09:20:00.000Z' as IsoDateTime,
        });
        expect((await store.tasks.load(tx, live.task.id))?.ticketSignalAt).toBe(
          '2026-06-01T09:20:00.000Z',
        );
        expect(await store.tasks.recordTicketSignal(tx, { ...signal, ticketKey: 'NOBODY-1' })).toBe(
          0,
        );
      });

      /**
       * WP-60, PROGRESS backlog 182: the one narrow writer that shares a column with `save`, and
       * therefore the one that bumps the token — asserted on both stores with the stale save it
       * exists to refuse.
       */
      it('moves only the recorded head of the merge request it names, and refuses a stale save after it', async () => {
        const mr = {
          provider: 'fake-git',
          project_path: 'acme/api',
          iid: 7,
          url: 'https://git.example.test/acme/api/-/merge_requests/7',
          branch: 'agentic/acme-7',
          head_sha: 'a'.repeat(40),
        };
        const stored = task({
          task: { ...task().task, state: 'active' },
          mr,
          branch: 'agentic/acme-7',
        });
        await store.tasks.insert(tx, stored);
        const before = (await store.tasks.load(tx, stored.task.id)) as StoredTask;

        expect(
          await store.tasks.saveMergeRequestHead(tx, stored.task.id, {
            iid: 7,
            headSha: 'e'.repeat(40),
            at: '2026-06-01T09:10:00.000Z' as IsoDateTime,
          }),
        ).toBe(true);
        const after = (await store.tasks.load(tx, stored.task.id)) as StoredTask;
        expect(after.mr).toEqual({ ...mr, head_sha: 'e'.repeat(40) });
        expect(after.branch).toBe('agentic/acme-7');
        expect(after.version).toBe(before.version + 1);
        await expect(store.tasks.save(tx, before)).rejects.toMatchObject({
          concurrencyConflict: true,
        });

        // The same revision, another merge request: nothing moves, and the token stays.
        expect(
          await store.tasks.saveMergeRequestHead(tx, stored.task.id, {
            iid: 7,
            headSha: 'e'.repeat(40),
            at: '2026-06-01T09:20:00.000Z' as IsoDateTime,
          }),
        ).toBe(false);
        expect(
          await store.tasks.saveMergeRequestHead(tx, stored.task.id, {
            iid: 8,
            headSha: 'f'.repeat(40),
            at: '2026-06-01T09:30:00.000Z' as IsoDateTime,
          }),
        ).toBe(false);
        expect((await store.tasks.load(tx, stored.task.id))?.version).toBe(after.version);
        await expect(
          store.tasks.saveMergeRequestHead(tx, nextId(), {
            iid: 7,
            headSha: 'f'.repeat(40),
            at: '2026-06-01T09:30:00.000Z' as IsoDateTime,
          }),
        ).rejects.toThrow();
      });

      /**
       * WP-60 review round 1 (measured by the reviewer: `c…` then `b…` left the head at `b…`). The
       * head is what the CI gate asks the pipeline status of, so a late delivery for an older push
       * must not move it back — on both stores. Equal instants move nothing; the same sha still
       * advances the instant, so a stale delivery after it is refused.
       */
      it('moves the recorded head forward only by the provider’s instant, whatever order deliveries arrive in', async () => {
        const mr = {
          provider: 'fake-git',
          project_path: 'acme/api',
          iid: 9,
          url: 'https://git.example.test/acme/api/-/merge_requests/9',
          branch: 'agentic/acme-9',
          head_sha: 'a'.repeat(40),
        };
        const stored = task({ task: { ...task().task, state: 'active' }, mr });
        await store.tasks.insert(tx, stored);
        const at = (minute: number) =>
          `2026-06-01T09:${String(minute).padStart(2, '0')}:00.000Z` as IsoDateTime;
        const head = async () => (await store.tasks.load(tx, stored.task.id))?.mr?.head_sha;
        const move = (headSha: string, minute: number) =>
          store.tasks.saveMergeRequestHead(tx, stored.task.id, { iid: 9, headSha, at: at(minute) });

        expect(await move('c'.repeat(40), 20)).toBe(true);
        // The older push, delivered late: refused.
        expect(await move('b'.repeat(40), 10)).toBe(false);
        expect(await head()).toBe('c'.repeat(40));
        // The same instant, another sha: refused — the first applied stands.
        expect(await move('d'.repeat(40), 20)).toBe(false);
        expect(await head()).toBe('c'.repeat(40));
        // The recorded sha at a later instant advances only the instant, and the token stays…
        const version = (await store.tasks.load(tx, stored.task.id))?.version;
        expect(await move('c'.repeat(40), 30)).toBe(false);
        expect((await store.tasks.load(tx, stored.task.id))?.version).toBe(version);
        // …so a stale delivery between the two is refused too.
        expect(await move('b'.repeat(40), 25)).toBe(false);
        expect(await head()).toBe('c'.repeat(40));
        expect(await move('e'.repeat(40), 31)).toBe(true);
        expect(await head()).toBe('e'.repeat(40));
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
          ticketSignalAt: null,
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
            state: 'returned',
            outcome: 'returned',
            returnReason: `pipeline for sha-${attempt} failed`,
            returnedTo: 'implementation',
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
        // WP-55: this line used to expect `'pipeline for sha-3 failed'` — the gate's own complaint,
        // served back to the gate. The reason is for the stage the return targeted.
        expect(await store.tasks.lastReturnReason(tx, stored.task.id, 'ci_gate', 4)).toBeNull();
        expect(await store.tasks.lastReturnReason(tx, stored.task.id, 'implementation', 2)).toBe(
          'pipeline for sha-3 failed',
        );
      });

      it('has no signatures and no reason for a stage that has not run', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        expect(
          await store.tasks.recentStageSignatures(tx, stored.task.id, 'code_review', 3),
        ).toEqual([]);
        expect(await store.tasks.lastReturnReason(tx, stored.task.id, 'code_review', 1)).toBeNull();
      });
    });

    /**
     * WP-55 (PROGRESS backlog 67): **which** reason a re-run stage is given.
     *
     * Every case is written as the pipeline writes rows — the returning stage's attempt closed with
     * its target, then the target's next attempt entered — so the read is asked the question the
     * stage executor asks: *the finding attempt `n` of this stage was sent back to fix*.
     */
    describe('the return reason a re-run stage is served', () => {
      const enter = (taskId: Id, stage: string, attempt: number) =>
        store.tasks.recordStageEntered(tx, { taskId, stage, attempt, causedByEventId: null });
      const complete = (taskId: Id, stage: string, attempt: number) =>
        store.tasks.recordStageExited(tx, {
          taskId,
          stage,
          attempt,
          state: 'completed',
          outcome: 'approve',
          returnReason: null,
          returnedTo: null,
        });
      const returnFrom = (taskId: Id, stage: string, attempt: number, to: string, reason: string) =>
        store.tasks.recordStageExited(tx, {
          taskId,
          stage,
          attempt,
          state: 'returned',
          outcome: 'returned',
          returnReason: reason,
          returnedTo: to,
        });

      it('is the finding of the stage that returned, not this stage’s own last complaint', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const id = stored.task.id;
        await enter(id, 'architecture', 1);
        await complete(id, 'architecture', 1);
        await enter(id, 'implementation', 1);
        // Implementation complains about the plan: its own sentence, on its own row.
        await returnFrom(id, 'implementation', 1, 'architecture', 'the plan names no migration');
        await enter(id, 'architecture', 2);
        expect(await store.tasks.lastReturnReason(tx, id, 'architecture', 2)).toBe(
          'the plan names no migration',
        );
        await complete(id, 'architecture', 2);
        await enter(id, 'implementation', 2);
        await complete(id, 'implementation', 2);
        await enter(id, 'code_review', 1);
        await returnFrom(id, 'code_review', 1, 'implementation', 'the footer rounds twice');
        await enter(id, 'implementation', 3);

        // Before WP-55 this answered `'the plan names no migration'`: implementation's own words.
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 3)).toBe(
          'the footer rounds twice',
        );
        expect(await store.tasks.lastReturnReason(tx, id, 'code_review', 2)).toBeNull();
      });

      it('is nothing for an attempt entered forward, after the loop that carried a finding', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const id = stored.task.id;
        await enter(id, 'implementation', 1);
        await complete(id, 'implementation', 1);
        await enter(id, 'ci_gate', 1);
        await returnFrom(id, 'ci_gate', 1, 'implementation', 'pipeline p-1 failed: test:unit');
        await enter(id, 'implementation', 2);
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 2)).toBe(
          'pipeline p-1 failed: test:unit',
        );
        // Implementation now sends the task back to architecture, and architecture advances: the
        // third implementation attempt is entered **forward**, and the CI finding was answered.
        await returnFrom(id, 'implementation', 2, 'architecture', 'the plan names no migration');
        await enter(id, 'architecture', 1);
        await complete(id, 'architecture', 1);
        await enter(id, 'implementation', 3);
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 3)).toBeNull();
      });

      it('is the newest return when two loops targeted the same stage', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const id = stored.task.id;
        await enter(id, 'implementation', 1);
        await complete(id, 'implementation', 1);
        await enter(id, 'ci_gate', 1);
        await returnFrom(id, 'ci_gate', 1, 'implementation', 'pipeline p-1 failed: test:unit');
        await enter(id, 'implementation', 2);
        await complete(id, 'implementation', 2);
        await enter(id, 'code_review', 1);
        await returnFrom(id, 'code_review', 1, 'implementation', 'the footer rounds twice');
        await enter(id, 'implementation', 3);
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 3)).toBe(
          'the footer rounds twice',
        );
        // And the second attempt's question is still answered the way it was when it ran.
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 2)).toBe(
          'pipeline p-1 failed: test:unit',
        );
      });

      it('is the human’s note when the task is returned to the stage it is at', async () => {
        // `returnToStageCommand`/`reworkStageCommand` take the current stage as `from`, and nothing
        // refuses `to === from`: a task escalated at implementation, reworked there with a note.
        const stored = task();
        await store.tasks.insert(tx, stored);
        const id = stored.task.id;
        await enter(id, 'implementation', 1);
        await returnFrom(id, 'implementation', 1, 'implementation', 'use the existing helper');
        await enter(id, 'implementation', 2);
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 2)).toBe(
          'use the existing helper',
        );
        // And it is not resurrected by a later forward entry.
        await complete(id, 'implementation', 2);
        await enter(id, 'implementation', 3);
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 3)).toBeNull();
      });

      it('is never the reason an attempt failed with — that is an escalation, not feedback', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const id = stored.task.id;
        await enter(id, 'implementation', 1);
        await store.tasks.recordStageExited(tx, {
          taskId: id,
          stage: 'implementation',
          attempt: 1,
          state: 'failed',
          outcome: 'failed',
          returnReason: 'the run could not be started (LauncherUnavailable)',
          returnedTo: null,
        });
        await enter(id, 'implementation', 2);
        expect(await store.tasks.lastReturnReason(tx, id, 'implementation', 2)).toBeNull();
      });

      it('refuses a return with no target, and a target on a row that is not a return', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const id = stored.task.id;
        await enter(id, 'code_review', 1);
        await expect(
          store.tasks.recordStageExited(tx, {
            taskId: id,
            stage: 'code_review',
            attempt: 1,
            state: 'returned',
            outcome: 'returned',
            returnReason: 'the footer rounds twice',
            returnedTo: null,
          }),
        ).rejects.toThrow(/a return names its target/);
        await expect(
          store.tasks.recordStageExited(tx, {
            taskId: id,
            stage: 'code_review',
            attempt: 1,
            state: 'completed',
            outcome: 'approve',
            returnReason: null,
            returnedTo: 'implementation',
          }),
        ).rejects.toThrow(/a return names its target/);
      });

      it('refuses a state outside the contracts’ vocabulary', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        await enter(stored.task.id, 'code_review', 1);
        await expect(
          store.tasks.recordStageExited(tx, {
            taskId: stored.task.id,
            stage: 'code_review',
            attempt: 1,
            state: 'exited' as never,
            outcome: 'approve',
            returnReason: null,
            returnedTo: null,
          }),
        ).rejects.toThrow();
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
            redactionCount: 0,
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

      /**
       * TD-012's only visible signal on this table (WP-52, migration 0038).
       *
       * Both directions, because one is half a test (standing rule 42): a row whose writer redacted
       * nothing reads **0**, and a row whose writer redacted two things reads **2**. The value the
       * column may never take from a writer is `null` — that spelling is reserved for a row written
       * before the column existed, and `NewArtifact` makes the count required so no caller can
       * claim it.
       */
      it('carries the redaction count back on every read, and 0 is a value rather than an absence', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        await store.artifacts.insert(tx, {
          id: nextId(),
          taskId: stored.task.id,
          type: 'RefinedSpec',
          version: 1,
          markdown: null,
          data: { goal: 'nothing to hide' },
          schemaVersion: '1',
          producedByRunId: null,
          redactionCount: 0,
          createdAt: '2026-06-01T09:00:00.000Z',
        });
        await store.artifacts.insert(tx, {
          id: nextId(),
          taskId: stored.task.id,
          type: 'RefinedSpec',
          version: 2,
          markdown: null,
          data: { goal: '[REDACTED:integration:anthropic_api_key] twice' },
          schemaVersion: '1',
          producedByRunId: null,
          redactionCount: 2,
          createdAt: '2026-06-01T09:01:00.000Z',
        });
        const rows = await store.artifacts.listFor(tx, stored.task.id);
        expect(rows.map((row) => row.redactionCount)).toEqual([0, 2]);
        expect(
          (await store.artifacts.latest(tx, stored.task.id, 'RefinedSpec'))?.redactionCount,
        ).toBe(2);
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
          systemPrompt: null,
          userPrompt: null,
          redactionCount: 0,
          contextPack: null,
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
          systemPrompt: null,
          userPrompt: null,
          redactionCount: 0,
          contextPack: null,
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
          systemPrompt: null,
          userPrompt: null,
          redactionCount: 0,
          contextPack: null,
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
          systemPrompt: null,
          userPrompt: null,
          redactionCount: 0,
          contextPack: null,
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

      it('stores the deadline it was created with and reads it back (WP-56)', async () => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const questionId = nextId();
        await store.questions.insert(tx, {
          id: questionId,
          taskId: stored.task.id,
          projectId,
          stage: 'refinement',
          runId: null,
          text: 'Which currency?',
          options: null,
          blocking: true,
          status: 'open',
          askedAt: '2026-06-05T16:00:00.000Z',
          deadlineAt: '2026-06-08T16:00:00.000Z',
          remindersSent: 0,
          answer: null,
          answeredByUserId: null,
          answeredVia: null,
          answeredAt: null,
          sequence: 1,
        });
        expect((await store.questions.load(tx, questionId))?.deadlineAt).toBe(
          '2026-06-08T16:00:00.000Z',
        );
      });
    });

    describe('the take-over a human still holds (WP-56)', () => {
      const takenOverPayload = (taskId: Id, projectIdOf: Id) => ({
        project_id: projectIdOf,
        task_id: taskId,
        branch: 'agentic/ACME-7',
        session_id: 'session-0001',
        stage: 'implementation',
      });

      /** Appends `types` to a fresh task's stream, one per second from 09:00, and reads it back. */
      const streamOf = async (...types: string[]) => {
        const stored = task();
        await store.tasks.insert(tx, stored);
        const ids: Id[] = [];
        for (const [index, type] of types.entries()) {
          const id = nextId();
          ids.push(id);
          await appendTaskEvent({
            id,
            taskId: stored.task.id,
            seq: index + 1,
            type,
            payload:
              type === 'task.taken_over'
                ? takenOverPayload(stored.task.id, projectId)
                : { project_id: projectId, task_id: stored.task.id },
            occurredAt: `2026-06-05T09:00:0${index}.000Z` as IsoDateTime,
          });
        }
        return { taskId: stored.task.id, ids };
      };

      it('answers null for a task nobody took over', async () => {
        const { taskId } = await streamOf('task.created', 'task.stage.entered');
        expect(await store.tasks.takenOver(tx, taskId)).toBeNull();
      });

      it('answers the newest take-over, with its branch, session, stage and instant', async () => {
        const { taskId, ids } = await streamOf(
          'task.created',
          'task.stage.entered',
          'task.taken_over',
        );
        expect(await store.tasks.takenOver(tx, taskId)).toEqual({
          eventId: ids[2],
          at: '2026-06-05T09:00:02.000Z',
          branch: 'agentic/ACME-7',
          sessionId: 'session-0001',
          stage: 'implementation',
        });
      });

      it('still answers it after an escalation, because the person still holds the task', async () => {
        const { taskId, ids } = await streamOf('task.created', 'task.taken_over', 'task.escalated');
        expect((await store.tasks.takenOver(tx, taskId))?.eventId).toBe(ids[1]);
      });

      it.each([
        'task.handed_back',
        'task.resumed',
        'task.stage.entered',
        'task.completed',
        'task.cancelled',
      ])('answers null once %s follows the take-over', async (ending) => {
        const { taskId } = await streamOf('task.created', 'task.taken_over', ending);
        expect(await store.tasks.takenOver(tx, taskId)).toBeNull();
      });

      it('answers the second take-over when the first was handed back', async () => {
        const { taskId, ids } = await streamOf(
          'task.taken_over',
          'task.handed_back',
          'task.taken_over',
        );
        expect(await store.tasks.takenOver(tx, taskId)).toMatchObject({
          eventId: ids[2],
          at: '2026-06-05T09:00:02.000Z',
        });
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
          // WP-56: every approval carries one now; the column round-trips.
          deadlineAt: '2026-06-02T09:00:00.000Z' as const,
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
        expect((await store.approvals.load(tx, approvalId))?.approval.deadlineAt).toBe(
          '2026-06-02T09:00:00.000Z',
        );
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
          redactionCount: 0,
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
