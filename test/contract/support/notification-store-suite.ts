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
import type { NotificationEntry, NotificationStore, Transaction } from '@platform/application';
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

    it('marks nothing for an empty id list', async () => {
      await expect(
        store.markDigested(tx, { ids: [], at: '2026-06-02T09:00:00.000Z' as IsoDateTime }),
      ).resolves.toBeUndefined();
    });
  });
};
