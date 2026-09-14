/**
 * The `AskStore` contract, run against the in-memory store and against PostgreSQL (WP-31).
 *
 * The ask's unit tier runs on the in-memory store, so every claim it makes — that a redelivered
 * ticket comment costs nothing, that an answer and its instant move together, that a refusal
 * carries a reason — rests on the two being interchangeable. The cases here are chosen for the
 * places they are *not* obviously interchangeable:
 *
 *  - the `(project_id, ticket_comment_id)` unique index, which the fake reproduces rather than
 *    approximates: it is what makes a second delivery of one comment not a second paid run;
 *  - `ui` asks, which carry **no** comment id and must therefore never collide — a naive unique
 *    index that treated `null` as a value would let one project ask one question for ever;
 *  - the two projections, which are a **join** in SQL and seeded arrays in the fake (the fake's
 *    divergence register says so), so this suite is the only place they are held to each other.
 *
 * What it deliberately does not assert is transaction isolation: the in-memory store accepts a
 * `Transaction` handle and ignores it, which is its one kind divergence.
 */
import type { AskStore, StoredAsk, Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

export interface AskStoreHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: AskStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    readonly taskId: Id;
    /** A platform user the store may reference — `asked_by_user_id` is a foreign key. */
    readonly userId: Id;
    /** A run of {@link taskId} the projection must find, or `null` when the harness seeded none. */
    readonly runId: Id | null;
    /** A `human_actions` row of {@link taskId}, likewise. */
    readonly auditId: Id | null;
    cleanup(): Promise<void>;
  }>;
}

let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

const AT = '2026-06-01T09:00:00.000Z' as IsoDateTime;

export const runAskStoreContract = (harness: AskStoreHarness): void => {
  describe(`AskStore contract — ${harness.name}`, () => {
    let store: AskStore;
    let tx: Transaction;
    let projectId: Id;
    let taskId: Id;
    let userId: Id;
    let runId: Id | null;
    let auditId: Id | null;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const created = await harness.create();
      ({ store, tx, projectId, taskId, userId, runId, auditId, cleanup } = created);
      return async () => {
        await cleanup();
      };
    });

    const newAsk = (overrides: Partial<Parameters<AskStore['insert']>[1]> = {}) => ({
      id: nextId(),
      taskId,
      projectId,
      source: 'ui' as const,
      askedByUserId: userId,
      askedByIdentity: null,
      ticketCommentId: null,
      question: 'why did you choose a column?',
      redactionCount: 0,
      createdAt: AT,
      ...overrides,
    });

    it('stores a question and reads it back whole', async () => {
      const ask = newAsk({ redactionCount: 2 });
      expect(await store.insert(tx, ask)).toBe('inserted');

      const stored = (await store.load(tx, ask.id)) as StoredAsk;
      expect(stored.question).toBe(ask.question);
      expect(stored.status).toBe('pending');
      expect(stored.runId).toBeNull();
      expect(stored.answer).toBeNull();
      expect(stored.citations).toEqual([]);
      expect(stored.droppedCitations).toBe(0);
      expect(stored.redactionCount).toBe(2);
      expect(stored.mirroredAt).toBeNull();
    });

    it('answers `null` for an ask that does not exist, rather than throwing', async () => {
      expect(await store.load(tx, nextId())).toBeNull();
    });

    it('refuses a second ask for the same ticket comment, and reports it as a duplicate', async () => {
      const first = newAsk({ source: 'ticket', ticketCommentId: 'comment-1' });
      expect(await store.insert(tx, first)).toBe('inserted');
      expect(
        await store.insert(tx, newAsk({ source: 'ticket', ticketCommentId: 'comment-1' })),
      ).toBe('duplicate');
      // And the first one survives untouched: a duplicate writes nothing at all.
      expect((await store.load(tx, first.id))?.question).toBe(first.question);
    });

    it('lets a project ask any number of questions from the UI, which carry no comment id', async () => {
      // The other direction of the index above: `null` is distinct in a PostgreSQL unique index and
      // the fake reproduces that. A store that collided here would let a project ask once, ever.
      expect(await store.insert(tx, newAsk())).toBe('inserted');
      expect(await store.insert(tx, newAsk())).toBe('inserted');
      expect(await store.listForTask(tx, taskId, 10)).toHaveLength(2);
    });

    it('attaches the run that will answer it', async () => {
      const ask = newAsk();
      await store.insert(tx, ask);
      const run = runId ?? nextId();
      if (runId === null) {
        // The SQL harness seeds a real run because `run_id` is a foreign key; the fake does not
        // need one. Skipping rather than inventing keeps the assertion honest in both.
        return;
      }
      await store.attachRun(tx, ask.id, run);
      expect((await store.load(tx, ask.id))?.runId).toBe(run);
    });

    it('records an answer with its citations, its drops and its instant', async () => {
      const ask = newAsk();
      await store.insert(tx, ask);
      await store.recordAnswer(tx, {
        askId: ask.id,
        answer: 'Because a join on every read is worse.',
        citations: [
          { kind: 'artifact', artifact_type: 'ImplementationPlan', version: 2, detail: 'the plan' },
        ],
        droppedCitations: 3,
        answerArtifactId: null,
        redactionCount: 1,
        answeredAt: AT,
      });

      const stored = (await store.load(tx, ask.id)) as StoredAsk;
      expect(stored.status).toBe('answered');
      expect(stored.answer).toBe('Because a join on every read is worse.');
      expect(stored.citations).toHaveLength(1);
      expect(stored.citations[0]?.artifact_type).toBe('ImplementationPlan');
      expect(stored.droppedCitations).toBe(3);
      expect(stored.answeredAt).not.toBeNull();
      // The redaction count **accumulates**: the question's redactions and the answer's are two
      // different passes over two different pieces of text on one row.
      expect(stored.redactionCount).toBe(1);
      expect(stored.refusalReason).toBeNull();
    });

    it.each(['refused', 'failed'] as const)(
      'records a %s ask with the reason it carries',
      async (status) => {
        const ask = newAsk();
        await store.insert(tx, ask);
        await store.recordRefusal(tx, {
          askId: ask.id,
          status,
          reason: 'the task has spent its cap',
        });
        const stored = (await store.load(tx, ask.id)) as StoredAsk;
        expect(stored.status).toBe(status);
        expect(stored.refusalReason).toBe('the task has spent its cap');
        expect(stored.answer).toBeNull();
        expect(stored.answeredAt).toBeNull();
      },
    );

    it('stamps the ticket mirror only when it is asked to', async () => {
      const ask = newAsk();
      await store.insert(tx, ask);
      expect((await store.load(tx, ask.id))?.mirroredAt).toBeNull();
      await store.markMirrored(tx, ask.id, AT);
      expect((await store.load(tx, ask.id))?.mirroredAt).not.toBeNull();
    });

    it('lists a task’s thread newest first, bounded by the limit', async () => {
      const older = newAsk({ createdAt: '2026-06-01T08:00:00.000Z' as IsoDateTime });
      const newer = newAsk({ createdAt: '2026-06-01T10:00:00.000Z' as IsoDateTime });
      await store.insert(tx, older);
      await store.insert(tx, newer);
      expect((await store.listForTask(tx, taskId, 10)).map((ask) => ask.id)).toEqual([
        newer.id,
        older.id,
      ]);
      expect(await store.listForTask(tx, taskId, 1)).toHaveLength(1);
    });

    it('answers an empty thread for a task with no asks, rather than refusing', async () => {
      expect(await store.listForTask(tx, nextId(), 10)).toEqual([]);
    });

    it('projects this task’s runs, and finds the one the harness seeded', async () => {
      const runs = await store.runsForTask(tx, taskId, 10);
      if (runId === null) {
        expect(runs).toEqual([]);
        return;
      }
      const line = runs.find((entry) => entry.runId === runId);
      expect(line).toBeDefined();
      expect(typeof line?.role).toBe('string');
      expect(typeof line?.costUsd).toBe('number');
    });

    it('projects this task’s human actions, and finds the one the harness seeded', async () => {
      const audit = await store.auditForTask(tx, taskId, 10);
      if (auditId === null) {
        expect(audit).toEqual([]);
        return;
      }
      const entry = audit.find((row) => row.id === auditId);
      expect(entry).toBeDefined();
      expect(typeof entry?.action).toBe('string');
      // `params` is client-supplied JSON and is always an object, never null: a reader that had to
      // branch on it would be branching on a storage accident.
      expect(typeof entry?.params).toBe('object');
    });

    it('projects nothing for a task that has neither', async () => {
      const other = nextId();
      expect(await store.runsForTask(tx, other, 10)).toEqual([]);
      expect(await store.auditForTask(tx, other, 10)).toEqual([]);
    });
  });
};
