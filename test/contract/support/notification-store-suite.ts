/**
 * The `NotificationStore` contract, run against the in-memory store and against PostgreSQL (WP-32).
 *
 * The notification band's unit tier runs on the in-memory store, so every claim it makes — *"quiet
 * hours defer and never drop"* most of all — rests on the two being interchangeable. The cases are
 * chosen for the places where they are **not** obviously so:
 *
 *  - the unique key that makes an at-least-once wake-up idempotent;
 *  - the claim, which has to be visible to the *next* call rather than only to this one;
 *  - a claim left behind by a day that never finished, which the next day must re-claim rather than
 *    strand — the difference between a late digest and a lost notification;
 *  - the `before` bound, which is what makes a retried digest claim the same set as the attempt it
 *    is retrying rather than a growing one;
 *  - the **second** bound, `immediateBefore`, which keeps a row whose immediate delivery is still in
 *    flight out of the digest — the one case where "undelivered" does not mean "nobody was told";
 *  - `digestDelivered`, which must answer for a **delivered** day and not for a claimed one.
 *
 * It deliberately does not assert transaction isolation: the in-memory store ignores the handle,
 * which is its one kind divergence and is written down in its register.
 */
import type {
  InboundThreadDirectory,
  NotificationEntry,
  NotificationStore,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { beforeEach, describe, expect, it } from 'vitest';

export interface NotificationStoreHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: NotificationStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    /** A task of that project, or `null` for a store that does not enforce the reference. */
    readonly taskId: Id | null;
    /** An approval on that task, for the message-address cases (WP-65). */
    readonly approvalId: Id;
    /** A question on that task, for the re-check id a `question` row carries (WP-84). */
    readonly questionId: Id;
    /** A platform user the store knows, for the decider's name (WP-73, backlog 234). */
    readonly user: { readonly id: Id; readonly name: string };
    /** A chat account of the project's organisation, for the thread cases (WP-88). */
    readonly integrationId: Id;
    /**
     * The reader of what `recordThread` writes — `InboundThreadDirectory` over the same rows and,
     * for PostgreSQL, the same transaction (WP-88).
     */
    readonly threads: InboundThreadDirectory;
    /** A second question on the same task (WP-88 review round 1: several open in one thread). */
    readonly secondQuestionId: Id;
    /** Moves a question out of `open`, as an answer would (WP-88). */
    closeQuestion(questionId: Id): Promise<void>;
    cleanup(): Promise<void>;
  }>;
}

let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

export const runNotificationStoreContract = (harness: NotificationStoreHarness): void => {
  describe(`NotificationStore contract — ${harness.name}`, () => {
    let context: Awaited<ReturnType<NotificationStoreHarness['create']>>;
    let store: NotificationStore;
    let tx: Transaction;

    beforeEach(async () => {
      context = await harness.create();
      store = context.store;
      tx = context.tx;
      return async () => {
        await context.cleanup();
      };
    });

    const entry = (overrides: Partial<NotificationEntry> = {}): NotificationEntry => ({
      id: nextId(),
      projectId: context.projectId,
      taskId: null,
      notificationClass: 'question',
      causeEventId: nextId(),
      title: 'ACME-1 is waiting for an answer',
      detail: 'Which currency should totals use?',
      url: null,
      urgent: false,
      plannedDelivery: 'digest',
      mode: 'normal',
      createdAt: '2026-06-01T23:00:00.000Z' as IsoDateTime,
      redactionCount: 0,
      ...overrides,
    });

    it('records a notification once per (project, cause event, class)', async () => {
      const first = entry();
      expect(await store.record(tx, first)).toBe(true);
      // A duplicated wake-up: the same cause and class, a new row id.
      expect(
        await store.record(tx, { ...first, id: nextId() }),
        'the second wake-up must not be recorded',
      ).toBe(false);
      // A different class of the same event is a different notification.
      expect(
        await store.record(tx, {
          ...first,
          id: nextId(),
          notificationClass: 'escalation',
        }),
      ).toBe(true);
    });

    it('reads back the question and the approval a row is about, and none for a row about neither (WP-84)', async () => {
      const question = entry({ questionId: context.questionId, taskId: context.taskId });
      const reminder = entry({
        notificationClass: 'reminder',
        approvalId: context.approvalId,
        taskId: context.taskId,
      });
      const plain = entry({ notificationClass: 'escalation' });
      for (const row of [question, reminder, plain]) {
        expect(await store.record(tx, row)).toBe(true);
      }
      const read = async (row: NotificationEntry) =>
        store.findByCause(tx, {
          projectId: context.projectId,
          causeEventId: row.causeEventId,
          notificationClass: row.notificationClass,
        });
      expect(await read(question)).toMatchObject({
        questionId: context.questionId,
        approvalId: null,
      });
      expect(await read(reminder)).toMatchObject({
        questionId: null,
        approvalId: context.approvalId,
      });
      expect(await read(plain)).toMatchObject({ questionId: null, approvalId: null });
    });

    it('closes an undelivered row withheld — terminal, never claimed — and leaves a delivered one alone (WP-84)', async () => {
      const waiting = entry({ notificationClass: 'reminder' });
      const delivered = entry({ notificationClass: 'escalation' });
      await store.record(tx, waiting);
      await store.record(tx, delivered);
      const at = '2026-06-02T07:00:00.000Z' as IsoDateTime;
      await store.markDelivered(tx, { id: delivered.id, at, via: 'immediate' });
      await store.markWithheld(tx, { ids: [waiting.id, delivered.id], at });
      const read = async (row: NotificationEntry) =>
        store.findByCause(tx, {
          projectId: context.projectId,
          causeEventId: row.causeEventId,
          notificationClass: row.notificationClass,
        });
      expect(await read(waiting)).toMatchObject({ deliveredAs: 'withheld', deliveredAt: at });
      expect((await read(delivered))?.deliveredAs).toBe('immediate');
      // Neither the digest's fan-out nor its claim sees a withheld row.
      expect(
        await store.projectsAwaitingDigest(tx, {
          before: '2026-06-03T00:00:00.000Z' as IsoDateTime,
          limit: 10,
        }),
      ).not.toContain(context.projectId);
      expect(
        await store.claimForDigest(tx, {
          projectId: context.projectId,
          day: '2026-06-02',
          before: '2026-06-03T00:00:00.000Z' as IsoDateTime,
          immediateBefore: '2026-06-03T00:00:00.000Z' as IsoDateTime,
          limit: 10,
        }),
      ).toEqual([]);
      // …and a digest counted as delivered is only a digest, never a withheld row.
      expect(
        await store.digestDelivered(tx, { projectId: context.projectId, day: '2026-06-02' }),
      ).toBe(false);
    });

    it('lists a project with something waiting, and stops listing it once delivered', async () => {
      const waiting = entry();
      await store.record(tx, waiting);
      const before = '2026-06-02T09:00:00.000Z' as IsoDateTime;
      expect(await store.projectsAwaitingDigest(tx, { before, limit: 10 })).toContain(
        context.projectId,
      );

      await store.markDelivered(tx, { id: waiting.id, at: before, via: 'immediate' });
      expect(await store.projectsAwaitingDigest(tx, { before, limit: 10 })).not.toContain(
        context.projectId,
      );
    });

    it('claims what is waiting, and claims nothing twice', async () => {
      const waiting = entry();
      await store.record(tx, waiting);
      const claim = {
        projectId: context.projectId,
        day: '2026-06-02',
        before: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-02T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      };
      const claimed = await store.claimForDigest(tx, claim);
      expect(claimed.map((row) => row.id)).toEqual([waiting.id]);
      expect(claimed[0]?.digestDay).toBe('2026-06-02');

      // A retry of the same day claims the same row — it is claimed *and* still undelivered.
      expect((await store.claimForDigest(tx, claim)).map((row) => row.id)).toEqual([waiting.id]);

      await store.markDigested(tx, { ids: [waiting.id], at: claim.before });
      expect(await store.claimForDigest(tx, claim)).toEqual([]);
    });

    it('re-claims a claim a failed day left behind, rather than stranding it', async () => {
      const stranded = entry();
      await store.record(tx, stranded);
      await store.claimForDigest(tx, {
        projectId: context.projectId,
        day: '2026-06-02',
        before: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-02T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      });
      // The post failed: the row is claimed for a day that never delivered.
      const nextDay = await store.claimForDigest(tx, {
        projectId: context.projectId,
        day: '2026-06-03',
        before: '2026-06-03T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-03T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      });
      expect(nextDay.map((row) => row.id)).toEqual([stranded.id]);
      expect(nextDay[0]?.digestDay).toBe('2026-06-03');
    });

    it('honours the `before` bound, so a retry claims the set its first attempt did', async () => {
      await store.record(tx, entry({ createdAt: '2026-06-02T08:00:00.000Z' as IsoDateTime }));
      const late = entry({ createdAt: '2026-06-02T09:30:00.000Z' as IsoDateTime });
      await store.record(tx, late);
      const claimed = await store.claimForDigest(tx, {
        projectId: context.projectId,
        day: '2026-06-02',
        before: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-02T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      });
      expect(claimed.map((row) => row.id)).not.toContain(late.id);
      expect(claimed).toHaveLength(1);
    });

    it('leaves an immediate row that may still be in flight, and claims it once it is old enough', async () => {
      /**
       * The duty records the row, calls the provider, and marks it delivered afterwards. A row
       * recorded seconds before the tick is undelivered because the call is *happening*, which the
       * row cannot distinguish from a call that failed — and claiming it posts the same
       * notification twice, with `delivered_as` decided by whichever write lands last. The second
       * bound is what separates them; a row planned `digest` has no such window.
       */
      const inFlight = entry({
        plannedDelivery: 'immediate',
        createdAt: '2026-06-02T08:59:30.000Z' as IsoDateTime,
      });
      const failedEarlier = entry({
        plannedDelivery: 'immediate',
        createdAt: '2026-06-02T08:40:00.000Z' as IsoDateTime,
      });
      const deferred = entry({ createdAt: '2026-06-02T08:59:45.000Z' as IsoDateTime });
      for (const row of [inFlight, failedEarlier, deferred]) {
        await store.record(tx, row);
      }

      const claimed = await store.claimForDigest(tx, {
        projectId: context.projectId,
        day: '2026-06-02',
        before: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-02T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      });
      expect(
        claimed.map((row) => row.id),
        'oldest first, and the in-flight row left alone',
      ).toEqual([failedEarlier.id, deferred.id]);

      // The next digest holds it to a bound it is now older than, so nothing is lost.
      const nextDay = await store.claimForDigest(tx, {
        projectId: context.projectId,
        day: '2026-06-03',
        before: '2026-06-03T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-03T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      });
      expect(nextDay.map((row) => row.id)).toContain(inFlight.id);
    });

    it('answers digestDelivered for a delivered day only, never for a claimed one', async () => {
      const waiting = entry();
      await store.record(tx, waiting);
      const claim = {
        projectId: context.projectId,
        day: '2026-06-02',
        before: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-02T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      };
      await store.claimForDigest(tx, claim);
      expect(
        await store.digestDelivered(tx, { projectId: context.projectId, day: claim.day }),
        'a claim is not a delivery',
      ).toBe(false);

      await store.markDigested(tx, { ids: [waiting.id], at: claim.before });
      expect(
        await store.digestDelivered(tx, { projectId: context.projectId, day: claim.day }),
      ).toBe(true);
      expect(
        await store.digestDelivered(tx, { projectId: context.projectId, day: '2026-06-03' }),
      ).toBe(false);
    });

    it('keeps what a row says, including the task, the mode and the redaction count', async () => {
      const recorded = entry({
        taskId: context.taskId,
        mode: 'shadow',
        urgent: true,
        plannedDelivery: 'immediate',
        url: 'https://tickets.example.test/browse/ACME-1',
        redactionCount: 2,
      });
      await store.record(tx, recorded);
      const claimed = await store.claimForDigest(tx, {
        projectId: context.projectId,
        day: '2026-06-02',
        before: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        immediateBefore: '2026-06-02T08:58:00.000Z' as IsoDateTime,
        limit: 10,
      });
      expect(claimed[0]).toMatchObject({
        taskId: context.taskId,
        mode: 'shadow',
        urgent: true,
        plannedDelivery: 'immediate',
        url: 'https://tickets.example.test/browse/ACME-1',
        redactionCount: 2,
        title: recorded.title,
        detail: recorded.detail,
      });
    });

    /**
     * **An organisation-scoped row still deduplicates** (WP-65, PROGRESS backlog 80, criterion 2).
     * PostgreSQL's default `NULLS DISTINCT` would have made two rows with a null project never equal
     * — the dedup guarantee gone for exactly the rows that became organisation-scoped. Migration
     * 0051 declares the key `nulls not distinct`, and the in-memory store keys `null` as a value.
     */
    it('records an organisation-scoped notification once per cause and class', async () => {
      const first = entry({ projectId: null, notificationClass: 'budget_exhausted' });
      expect(await store.record(tx, first)).toBe(true);
      expect(await store.record(tx, { ...first, id: nextId() }), 'a replay is refused').toBe(false);
      // The same cause and class for a project is a different notification.
      expect(await store.record(tx, { ...first, id: nextId(), projectId: context.projectId })).toBe(
        true,
      );
    });

    it('finds a row by its key, a null project included, and nothing for another key', async () => {
      const org = entry({ projectId: null, notificationClass: 'budget_exhausted' });
      await store.record(tx, org);
      const key = { causeEventId: org.causeEventId, notificationClass: org.notificationClass };
      expect(await store.findByCause(tx, { projectId: null, ...key })).toMatchObject({
        id: org.id,
        projectId: null,
        deliveredAt: null,
      });
      expect(await store.findByCause(tx, { projectId: context.projectId, ...key })).toBeNull();
    });

    it('never lists an organisation-scoped row for a project digest', async () => {
      await store.record(tx, entry({ projectId: null, notificationClass: 'budget_exhausted' }));
      const listed = await store.projectsAwaitingDigest(tx, {
        before: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        limit: 10,
      });
      expect(listed).not.toContain(null);
    });

    /** WP-65, backlog 202: the address of a posted approval, found again by the approval. */
    it('finds an approval’s message by the approval, once the delivery recorded its address', async () => {
      const posted = entry({
        notificationClass: 'approval',
        plannedDelivery: 'immediate',
        taskId: context.taskId,
        approvalId: context.approvalId,
      });
      await store.record(tx, posted);
      expect(await store.approvalMessage(tx, context.approvalId), 'no address yet').toBeNull();

      const ref = {
        provider: 'fake-chat',
        channel: '#agentic',
        message_id: 'm-7',
        thread_id: 't-1',
        url: null,
      };
      await store.markDelivered(tx, {
        id: posted.id,
        at: '2026-06-01T23:01:00.000Z' as IsoDateTime,
        via: 'immediate',
        messageRef: ref,
      });
      const found = await store.approvalMessage(tx, context.approvalId);
      expect(found).toMatchObject({
        id: posted.id,
        approvalId: context.approvalId,
        messageRef: ref,
      });
    });

    /** WP-88, backlog 233: the question's message, found again by the question. */
    it('finds a question’s message by the question, and never a reminder’s row', async () => {
      const taskId = context.taskId;
      const ref = {
        provider: 'fake-chat',
        channel: '#agentic',
        message_id: 'm-9',
        thread_id: 't-1',
        url: null,
      };
      const reminder = entry({
        notificationClass: 'reminder',
        plannedDelivery: 'immediate',
        taskId,
        questionId: context.questionId,
      });
      await store.record(tx, reminder);
      await store.markDelivered(tx, {
        id: reminder.id,
        at: '2026-06-01T23:01:00.000Z' as IsoDateTime,
        via: 'immediate',
        // An address a reminder never carries in production — here to prove the class filter.
        messageRef: { ...ref, message_id: 'm-reminder' },
      });
      expect(
        await store.questionMessage(tx, context.questionId),
        'a reminder is not it',
      ).toBeNull();

      const asked = entry({ plannedDelivery: 'immediate', taskId, questionId: context.questionId });
      await store.record(tx, asked);
      expect(await store.questionMessage(tx, context.questionId), 'no address yet').toBeNull();
      await store.markDelivered(tx, {
        id: asked.id,
        at: '2026-06-01T23:02:00.000Z' as IsoDateTime,
        via: 'immediate',
        messageRef: ref,
      });
      expect(await store.questionMessage(tx, context.questionId)).toMatchObject({
        id: asked.id,
        questionId: context.questionId,
        messageRef: ref,
      });
    });

    /** WP-88, backlog 195: the thread ↔ task map, written by the store and read by the directory. */
    it('records a task’s thread once, and the directory resolves it — with the open question posted into it', async () => {
      const taskId = context.taskId as Id;
      const key = {
        projectId: context.projectId,
        integrationId: context.integrationId,
        channel: 'C0FAKECHAN1',
        threadId: '1780000000.000100',
      };
      expect(await context.threads.find(key), 'nothing recorded yet').toBeNull();
      const record = { ...key, taskId, at: '2026-06-01T23:00:00.000Z' as IsoDateTime };
      await store.recordThread(tx, record);
      await store.recordThread(tx, record);
      expect(await context.threads.find(key)).toEqual({
        taskId,
        openQuestions: 0,
        questionId: null,
      });
      // Scoped by every key half: another project's binding, another account, another channel and
      // another thread each resolve nothing.
      for (const [half, other] of [
        ['projectId', '00000000-0000-4000-8000-00000000fff1'],
        ['integrationId', '00000000-0000-4000-8000-00000000fff2'],
        ['channel', 'C0FAKEOTHER'],
        ['threadId', '1780000000.000999'],
      ] as const) {
        expect(await context.threads.find({ ...key, [half]: other }), half).toBeNull();
      }

      const post = async (questionId: Id, ts: string, at: string): Promise<void> => {
        const asked = entry({ plannedDelivery: 'immediate', taskId, questionId });
        await store.record(tx, asked);
        await store.markDelivered(tx, {
          id: asked.id,
          at: at as IsoDateTime,
          via: 'immediate',
          messageRef: {
            provider: 'fake-chat',
            channel: key.channel,
            message_id: ts,
            thread_id: key.threadId,
            url: null,
          },
        });
      };

      // A question posted into the thread with an address is what a reply there answers …
      await post(context.questionId, '1780000001.000200', '2026-06-01T23:01:00.000Z');
      expect(await context.threads.find(key)).toEqual({
        taskId,
        openQuestions: 1,
        questionId: context.questionId,
      });

      // … a second open one makes a reply ambiguous: it names neither (review round 1) …
      await post(context.secondQuestionId, '1780000002.000300', '2026-06-01T23:02:00.000Z');
      expect(await context.threads.find(key)).toEqual({
        taskId,
        openQuestions: 2,
        questionId: null,
      });

      // … once one is answered, a reply answers the other …
      await context.closeQuestion(context.questionId);
      expect(await context.threads.find(key)).toEqual({
        taskId,
        openQuestions: 1,
        questionId: context.secondQuestionId,
      });

      // … and once none is open, a reply there is feedback again.
      await context.closeQuestion(context.secondQuestionId);
      expect(await context.threads.find(key)).toEqual({
        taskId,
        openQuestions: 0,
        questionId: null,
      });
    });

    it('names a platform user it knows, and nobody for an id it does not (backlog 234)', async () => {
      expect(await store.userName(tx, context.user.id)).toBe(context.user.name);
      expect(await store.userName(tx, '00000000-0000-4000-8000-00000000ffff' as Id)).toBeNull();
    });

    it('marks nothing for an empty id list', async () => {
      await expect(
        store.markDigested(tx, { ids: [], at: '2026-06-02T09:00:00.000Z' as IsoDateTime }),
      ).resolves.toBeUndefined();
    });
  });
};
