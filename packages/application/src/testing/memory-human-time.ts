/**
 * An in-memory {@link HumanTimeStore} — technical/10: fakes are first-class code.
 *
 * It is what the projector's unit tier runs against, and it is held to the same contract suite as
 * the PostgreSQL implementation (`test/contract/support/human-time-store-suite.ts`), so "the
 * projector works" and "the projector works on a database" are one claim rather than two.
 *
 * ## Divergence register — a fake may be stricter than the real adapter, never kinder
 *
 * | # | Divergence | Direction | Justification |
 * |---|---|---|---|
 * | 1 | No transaction isolation: a `Transaction` handle is accepted and ignored, so a rolled-back scope keeps its writes. | **kinder** | Rollback cannot be faked in a Map, which is why the same suite runs against PostgreSQL and why the idempotency criterion is also asserted on a database. **Positive assertion**: `memory-human-time.test.ts` asserts the divergence explicitly rather than warning about it. |
 * | 2 | `appendEntry` accepts a `taskId` no task row has; PostgreSQL refuses it (`task_id references tasks(id)`). | **kinder** | Every caller reaches this store with a task id the pipeline produced. The foreign key is what makes the real adapter refuse an entry for a deleted task, and the contract suite seeds a real task for exactly that reason. |
 * | 3 | `reviewEntries` breaks a tie on `started_at` by insertion order; PostgreSQL breaks it on `id`. | **different** | Two rows tie only if two activities landed on the same millisecond, which no producer in this build does — and the projector reads the *set* of a task's windows rather than the first of them, so the tie-break decides nothing. The suite asserts what it does depend on, newest activity first, against both. |
 * | 4 | Everything is returned by structural clone. | **stricter** | A caller mutating what it read cannot change the store, which PostgreSQL also does not allow. |
 * | 5 | `extendEntry` throws on an unknown id; the SQL `update` would touch zero rows. | **same** | The SQL adapter checks `rowCount` and throws the same error — a projection that silently stops being written is standing rule 18's shape. |
 * | 6 | It accepts an entry whose `ended_at` precedes its `started_at`, and a negative `minutes`; PostgreSQL refuses both (migration 0025's `human_time_entries_window_ordered` and `human_time_entries_minutes_nonnegative`). | **kinder** | Found by the real database, on the contract suite's own helper: an override of `startedAt` alone left the default ending behind it and the constraint caught the row. Nothing in a Map can, so the check is stated here and the suite builds a window whose ending follows its start. |
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type {
  AccountResolution,
  ExternalAccount,
  HumanTimeEntry,
  HumanTimeStore,
  NewHumanTimeEntry,
} from '../human-time/ports.js';

export class HumanTimeStoreError extends Error {
  override readonly name = 'HumanTimeStoreError';
}

export interface MemoryHumanTimeStore extends HumanTimeStore {
  /** Point a merge request at the task that owns it, as `tasks.mr_ref` does. */
  seedMergeRequest(subject: { readonly projectId: Id; readonly iid: number }, taskId: Id): void;
  /**
   * One `user_identities` row: a provider account mapped to a platform user (WP-31), or — with
   * `null` — declared a machine (WP-61, migration 0045).
   */
  seedIdentity(account: ExternalAccount, userId: Id | null): void;
  seedQuestion(questionId: Id, askedAt: IsoDateTime): void;
  seedTimezone(projectId: Id, timezone: string | null): void;
  /** Every row, in write order — what a test counts to assert idempotency (standing rule 79). */
  readonly entries: readonly HumanTimeEntry[];
}

const clone = <T>(value: T): T => structuredClone(value) as T;

/**
 * The map key for a provider account.
 *
 * The separator is written as the **escape** `\0` and never as a literal NUL byte: a NUL in a
 * source file makes git treat the blob as binary, so the diff renders as `Bin`, the file cannot be
 * three-way merged and `grep` skips it (CLAUDE.md; `pnpm run -s nul:check` fails the build on one,
 * and it failed on this very line before this comment existed). It is a NUL rather than a colon
 * because neither half may contain one, so `(a, b)` and `(a:b, '')` cannot collide.
 */
const accountKey = (account: ExternalAccount): string =>
  `${account.provider}\0${account.externalId}`;

/**
 * **No reader seams**, deliberately. `MemoryCostStore` takes `runs` and `estimates` callbacks so the
 * pipeline harness can answer out of its own rows (standing rule 82); this store takes none, because
 * nothing in this build drives the projector through that harness — the fold from a real pipeline is
 * the e2e tier's, against the production adapter. A seam with no caller is surface to keep true, and
 * the day one is needed it is four lines (standing rule 31).
 */
export const createMemoryHumanTimeStore = (): MemoryHumanTimeStore => {
  const rows: HumanTimeEntry[] = [];
  const mergeRequests = new Map<string, Id>();
  const identities = new Map<string, Id | null>();
  const questions = new Map<Id, IsoDateTime>();
  const timezones = new Map<Id, string | null>();
  let nextId = 0;

  return {
    seedMergeRequest: (subject, taskId) => {
      mergeRequests.set(`${subject.projectId}!${subject.iid}`, taskId);
    },
    seedIdentity: (account, userId) => {
      identities.set(accountKey(account), userId);
    },
    seedQuestion: (questionId, askedAt) => {
      questions.set(questionId, askedAt);
    },
    seedTimezone: (projectId, timezone) => {
      timezones.set(projectId, timezone);
    },
    get entries() {
      return clone(rows);
    },

    taskForMergeRequest: async (_tx, subject) =>
      mergeRequests.get(`${subject.projectId}!${subject.iid}`) ?? null,

    resolveAccount: async (_tx, account): Promise<AccountResolution> => {
      const key = accountKey(account);
      if (!identities.has(key)) {
        return { kind: 'unmapped' };
      }
      const userId = identities.get(key) ?? null;
      return userId === null ? { kind: 'machine' } : { kind: 'person', userId };
    },

    reviewEntries: async (_tx, taskId) =>
      clone(
        rows
          .filter((row) => row.taskId === taskId && row.kind === 'review')
          .toSorted((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0)),
      ),

    appendEntry: async (_tx, entry: NewHumanTimeEntry) => {
      nextId += 1;
      rows.push(clone({ ...entry, id: `memory-human-time-${nextId}` as Id }));
    },

    extendEntry: async (_tx, id, window) => {
      const index = rows.findIndex((row) => row.id === id);
      const row = rows[index];
      if (row === undefined) {
        throw new HumanTimeStoreError(
          `human_time_entries ${id} does not exist; the window cannot be extended`,
        );
      }
      rows[index] = { ...row, endedAt: window.endedAt, minutes: window.minutes };
    },

    questionAskedAt: async (_tx, questionId) => questions.get(questionId) ?? null,

    organisationTimezone: async (_tx, projectId) => timezones.get(projectId) ?? null,
  };
};
