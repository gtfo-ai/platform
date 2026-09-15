/**
 * An in-memory {@link StatsStore} — technical/10: fakes are first-class code (WP-41).
 *
 * It is what the statistics projector's unit tier runs against, and it is held to the same contract
 * suite as the PostgreSQL implementation (`test/contract/support/stats-store-suite.ts`), so *"the
 * projector counts"* and *"the projector counts on a database"* are one claim rather than two.
 *
 * ## Divergence register — a fake may be stricter than the real adapter, never kinder
 *
 * | # | Divergence | Direction | Justification |
 * |---|---|---|---|
 * | 1 | No transaction isolation: a `Transaction` handle is accepted and ignored, so a rolled-back scope keeps its writes. | **kinder** | Rollback cannot be faked in a Map, which is why the same suite runs against PostgreSQL and why the idempotency criterion is asserted on a database as well (`test/integration/stats/stats-backfill.integration.test.ts`). **Positive assertion**: `memory-stats.test.ts` asserts the divergence explicitly rather than warning about it. |
 * | 2 | `recordDelivery` and `addCounter` accept ids no `tasks` or `projects` row has; PostgreSQL refuses both (migration 0034's foreign keys). | **kinder** | Every caller reaches this store with ids the pipeline produced, and the contract suite seeds real rows for exactly that reason. |
 * | 3 | `addCounter` accumulates in JavaScript numbers; PostgreSQL adds a `bigint` and a `numeric(18,6)`. | **different** | The counters here are event tallies and small path counts, far inside 2^53, and the real adapter converts once on the way out. A total past six decimals would round here and be refused there — no producer writes a fraction at all, which the fold makes structural (`countersFor` returns integers). |
 * | 4 | Everything is returned by structural clone. | **stricter** | A caller mutating what it read cannot change the store, which PostgreSQL also does not allow. |
 * | 5 | `organisationTimezone` answers `null` for an unseeded project; on a database `organizations.timezone` is `not null default 'UTC'`, so it answers `'UTC'`. | **different** | Both resolve to UTC through `resolveBudgetTimezone`, which is the only consumer, and the contract runner seeds `'UTC'` so the suite compares like with like. The `null` branch is what an organisation with an empty setting produces and is exercised deliberately. |
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { StatsCounter } from '../stats/metrics.js';
import type { StatsStore } from '../stats/ports.js';

/** One `stats_task_delivery` row, as a test reads it back. */
export interface MemoryDelivery {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly mergedAt: IsoDateTime;
}

/** One `stats_event_daily` row, as a test reads it back. */
export interface MemoryCounter {
  readonly projectId: Id;
  readonly day: string;
  readonly metric: StatsCounter;
  readonly count: number;
  readonly total: number;
}

export interface MemoryStatsStore extends StatsStore {
  seedTimezone(projectId: Id, timezone: string | null): void;
  /** Point a merge request at the task that owns it, as `tasks.mr_ref` does. */
  seedMergeRequest(subject: { readonly projectId: Id; readonly iid: number }, taskId: Id): void;
  /** Every delivery, in write order — what a test counts to assert idempotency (rule 79). */
  readonly deliveries: readonly MemoryDelivery[];
  /** Every counter row, ordered by `(project, day, metric)` as the database's index would. */
  readonly counters: readonly MemoryCounter[];
}

/**
 * The composite key of one counter row.
 *
 * The separator is written as the escape `\0` rather than as a literal NUL: a NUL byte in a source
 * file makes git classify the blob as binary, so its diff renders as `Bin` and `grep` skips it
 * (`pnpm run -s nul:check`, which caught exactly this line). It is a NUL rather than a space
 * because the key is an identity — a separator a value could contain would merge two rows.
 */
const counterKey = (projectId: Id, day: string, metric: string): string =>
  `${projectId}\0${day}\0${metric}`;

export const createMemoryStatsStore = (): MemoryStatsStore => {
  const timezones = new Map<string, string | null>();
  const mergeRequests = new Map<string, Id>();
  const deliveries = new Map<string, MemoryDelivery>();
  const counters = new Map<string, MemoryCounter>();

  return {
    organisationTimezone: async (_tx, projectId) => timezones.get(projectId) ?? null,

    taskForMergeRequest: async (_tx, subject) =>
      mergeRequests.get(`${subject.projectId}#${subject.iid}`) ?? null,

    recordDelivery: async (_tx, delivery) => {
      // `on conflict do nothing`: the first merge is the delivery (migration 0034 says why).
      if (!deliveries.has(delivery.taskId)) {
        deliveries.set(delivery.taskId, { ...delivery });
      }
    },

    addCounter: async (_tx, delta) => {
      const key = counterKey(delta.projectId, delta.day, delta.metric);
      const existing = counters.get(key);
      counters.set(key, {
        projectId: delta.projectId,
        day: delta.day,
        metric: delta.metric,
        count: (existing?.count ?? 0) + delta.count,
        total: (existing?.total ?? 0) + delta.total,
      });
    },

    seedTimezone: (projectId, timezone) => {
      timezones.set(projectId, timezone);
    },

    seedMergeRequest: (subject, taskId) => {
      mergeRequests.set(`${subject.projectId}#${subject.iid}`, taskId);
    },

    get deliveries() {
      return [...deliveries.values()].map((row) => ({ ...row }));
    },

    get counters() {
      return [...counters.values()]
        .map((row) => ({ ...row }))
        .toSorted((a, b) =>
          counterKey(a.projectId, a.day, a.metric) < counterKey(b.projectId, b.day, b.metric)
            ? -1
            : 1,
        );
    },
  };
};
