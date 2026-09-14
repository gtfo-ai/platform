/**
 * An in-memory {@link NotificationStore} — technical/10: fakes are first-class code (WP-32).
 *
 * It is what the notification band's unit tier runs against, and it is held to the same contract
 * suite as the PostgreSQL implementation (`test/contract/support/notification-store-suite.ts`), so
 * "quiet hours defer and never drop" is one claim rather than two.
 *
 * ## Divergence register — a fake may be stricter than the real adapter, never kinder
 *
 * | # | Divergence | Direction | Justification |
 * |---|---|---|---|
 * | 1 | No transaction isolation: a `Transaction` handle is accepted and ignored, so a rolled-back scope keeps its writes. | **kinder** | Rollback cannot be faked in a Map. The same suite runs against PostgreSQL, and the duty's "record, then deliver, then mark" sequence is asserted end to end in the e2e tier. |
 * | 2 | No row locking, so two concurrent `claimForDigest` calls for one project would both claim the same rows. | **kinder** | The SQL adapter claims with a single `update … where delivered_at is null returning`, which is atomic; nothing here is concurrent, so a test cannot observe the difference. The digest queue is `exclusive` for the same reason, which is the first line of defence. |
 * | 3 | `record` compares `(projectId, causeEventId, notificationClass)` by string key; PostgreSQL enforces it with a unique index. | **same** | Both answer `false` for a repeat, which is what makes an at-least-once wake-up idempotent. |
 * | 4 | Everything is returned by structural clone. | **stricter** | A caller mutating what it read cannot change the store, which PostgreSQL also does not allow. |
 * | 5 | `projectsAwaitingDigest` returns projects in insertion order; the SQL adapter orders by the oldest undelivered row. | **different** | Both are stable and neither is part of the contract: the suite asserts membership, never order, because two projects' digests are independent messages. |
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { NotificationEntry, NotificationStore, StoredNotification } from '../notify/ports.js';

const keyOf = (
  entry: Pick<NotificationEntry, 'projectId' | 'causeEventId' | 'notificationClass'>,
) => `${entry.projectId}|${entry.causeEventId}|${entry.notificationClass}`;

export interface MemoryNotificationStore extends NotificationStore {
  /** Every row, oldest first — what a test asserts on. */
  readonly rows: readonly StoredNotification[];
}

export const createMemoryNotificationStore = (): MemoryNotificationStore => {
  const rows = new Map<Id, StoredNotification>();
  const keys = new Set<string>();

  const clone = (row: StoredNotification): StoredNotification => ({ ...row });
  const undelivered = (row: StoredNotification, before: IsoDateTime): boolean =>
    row.deliveredAt === null && row.createdAt < before;

  return {
    get rows() {
      return [...rows.values()].map(clone);
    },

    record: async (_tx, entry) => {
      const key = keyOf(entry);
      if (keys.has(key)) {
        return false;
      }
      keys.add(key);
      rows.set(entry.id, { ...entry, deliveredAt: null, deliveredAs: null, digestDay: null });
      return true;
    },

    markDelivered: async (_tx, input) => {
      const row = rows.get(input.id);
      if (row === undefined) {
        throw new Error(`no notification ${input.id}`);
      }
      rows.set(input.id, { ...row, deliveredAt: input.at, deliveredAs: input.via });
    },

    projectsAwaitingDigest: async (_tx, input) => {
      const projects: Id[] = [];
      for (const row of rows.values()) {
        if (undelivered(row, input.before) && !projects.includes(row.projectId)) {
          projects.push(row.projectId);
        }
      }
      return projects.slice(0, input.limit);
    },

    claimForDigest: async (_tx, input) => {
      const claimed: StoredNotification[] = [];
      for (const row of [...rows.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) {
        if (claimed.length >= input.limit) {
          break;
        }
        // The second bound: a row the duty planned to deliver *immediately* may still be in the
        // middle of that delivery, and the row cannot tell that from a delivery that failed.
        const bound = row.plannedDelivery === 'immediate' ? input.immediateBefore : input.before;
        if (row.projectId !== input.projectId || !undelivered(row, bound)) {
          continue;
        }
        const updated = { ...row, digestDay: input.day };
        rows.set(row.id, updated);
        claimed.push(clone(updated));
      }
      return claimed;
    },

    markDigested: async (_tx, input) => {
      for (const id of input.ids) {
        const row = rows.get(id);
        if (row !== undefined) {
          rows.set(id, { ...row, deliveredAt: input.at, deliveredAs: 'digest' });
        }
      }
    },

    digestDelivered: async (_tx, input) =>
      [...rows.values()].some(
        (row) =>
          row.projectId === input.projectId &&
          row.digestDay === input.day &&
          row.deliveredAt !== null &&
          row.deliveredAs === 'digest',
      ),
  };
};
