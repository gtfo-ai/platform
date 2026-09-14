/**
 * The `HumanTimeStore` contract, run against the in-memory store and against PostgreSQL.
 *
 * The projector's unit tier runs on the in-memory store, so every claim it makes rests on the two
 * being interchangeable. The cases are chosen for the places they are *not* obviously so: the
 * order review windows come back in (the projector reads the newest activity of each), the
 * `is not distinct from` shape that a `null` user id needs and a plain `=` gets wrong, the update
 * that has to fail loudly when it hits no row, and the two lookups that answer `null` for something
 * that does not exist rather than throwing.
 *
 * It deliberately does not assert transaction isolation — the in-memory store ignores the handle,
 * which is its one kind divergence — nor the foreign keys, which only a database has
 * (`test/integration/cost/` covers those).
 */
import type { HumanTimeStore, NewHumanTimeEntry, Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';

/** What a runner has to be able to put in front of the store. */
export interface HumanTimeStoreSeed {
  /** A task of the suite's project, optionally owning the merge request with this `iid`. */
  task(input: { readonly id: Id; readonly mrIid?: number }): Promise<void>;
  /** One `user_identities` row (WP-31's writer, in miniature). */
  identity(input: {
    readonly provider: string;
    readonly externalId: string;
    readonly userId: Id;
  }): Promise<void>;
  /** A `questions` row with the instant it was asked. */
  question(input: {
    readonly id: Id;
    readonly taskId: Id;
    readonly askedAt: IsoDateTime;
  }): Promise<void>;
  /** The organisation's timezone setting. */
  timezone(value: string | null): Promise<void>;
  /** A platform user the entries may be attributed to. */
  user(id: Id): Promise<void>;
}

export interface HumanTimeStoreHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: HumanTimeStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    readonly seed: HumanTimeStoreSeed;
    cleanup(): Promise<void>;
  }>;
}

let counter = 0x1000;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

const at = (iso: string): IsoDateTime => iso as IsoDateTime;

/**
 * A freshly opened review window, as the projector writes one.
 *
 * `endedAt` follows `startedAt` rather than being a second constant, because migration 0025's
 * `human_time_entries_window_ordered` refuses a row that ends before it begins — and an override of
 * `startedAt` alone would otherwise build exactly that. The database said so; the in-memory store
 * has no such check, which is why its divergence register now carries the asymmetry.
 */
const review = (taskId: Id, overrides: Partial<NewHumanTimeEntry> = {}): NewHumanTimeEntry => {
  const startedAt = overrides.startedAt ?? at('2026-06-01T09:00:00.000Z');
  return {
    taskId,
    kind: 'review',
    userId: null,
    externalAuthor: 'gitlab:ada',
    startedAt,
    endedAt: startedAt,
    minutes: 0,
    ...overrides,
  };
};

export const runHumanTimeStoreContract = (harness: HumanTimeStoreHarness): void => {
  describe(`HumanTimeStore contract (${harness.name})`, () => {
    it('finds the task that owns a merge request, and answers null for one nobody owns', async () => {
      const world = await harness.create();
      try {
        const taskId = nextId();
        await world.seed.task({ id: taskId, mrIid: 7 });
        expect(
          await world.store.taskForMergeRequest(world.tx, { projectId: world.projectId, iid: 7 }),
        ).toBe(taskId);
        expect(
          await world.store.taskForMergeRequest(world.tx, { projectId: world.projectId, iid: 8 }),
        ).toBeNull();
      } finally {
        await world.cleanup();
      }
    });

    it('resolves a mapped provider account and answers null for an unmapped one', async () => {
      const world = await harness.create();
      try {
        const userId = nextId();
        await world.seed.user(userId);
        await world.seed.identity({ provider: 'gitlab', externalId: 'ada', userId });
        expect(
          await world.store.resolveUser(world.tx, { provider: 'gitlab', externalId: 'ada' }),
        ).toBe(userId);
        // The ordinary answer on a fresh instance: `user_identities` is empty until an operator
        // maps an account (WP-31), and an unmapped author is recorded rather than refused.
        expect(
          await world.store.resolveUser(world.tx, { provider: 'gitlab', externalId: 'grace' }),
        ).toBeNull();
        // Two providers can use the same account name; the key is the pair.
        expect(
          await world.store.resolveUser(world.tx, { provider: 'github', externalId: 'ada' }),
        ).toBeNull();
      } finally {
        await world.cleanup();
      }
    });

    it('returns a task’s review windows newest activity first, and only that task’s', async () => {
      const world = await harness.create();
      try {
        const taskId = nextId();
        const otherId = nextId();
        await world.seed.task({ id: taskId });
        await world.seed.task({ id: otherId });
        await world.store.appendEntry(
          world.tx,
          review(taskId, { startedAt: at('2026-06-01T09:00:00.000Z') }),
        );
        await world.store.appendEntry(
          world.tx,
          review(taskId, { startedAt: at('2026-06-01T14:00:00.000Z') }),
        );
        await world.store.appendEntry(world.tx, review(otherId));

        const entries = await world.store.reviewEntries(world.tx, taskId);
        expect(entries.map((entry) => entry.startedAt)).toEqual([
          '2026-06-01T14:00:00.000Z',
          '2026-06-01T09:00:00.000Z',
        ]);
        expect(entries.every((entry) => entry.taskId === taskId)).toBe(true);
      } finally {
        await world.cleanup();
      }
    });

    it('reads back every field of an entry, including the two that may be null', async () => {
      const world = await harness.create();
      try {
        const taskId = nextId();
        const userId = nextId();
        await world.seed.task({ id: taskId });
        await world.seed.user(userId);
        await world.store.appendEntry(
          world.tx,
          review(taskId, { userId, externalAuthor: null, minutes: 12.25 }),
        );
        const [entry] = await world.store.reviewEntries(world.tx, taskId);
        expect(entry).toMatchObject({
          taskId,
          kind: 'review',
          userId,
          externalAuthor: null,
          startedAt: '2026-06-01T09:00:00.000Z',
          endedAt: '2026-06-01T09:00:00.000Z',
          // `numeric(10,2)` arrives as a string from the driver; the port publishes a number, and a
          // value written and read back has to be the *same* number or no backfill can be compared
          // to a live dispatch for equality.
          minutes: 12.25,
        });
      } finally {
        await world.cleanup();
      }
    });

    it('stores the three kinds the enum gained and kept, including migration 0025’s steer', async () => {
      const world = await harness.create();
      try {
        const taskId = nextId();
        const userId = nextId();
        await world.seed.task({ id: taskId });
        await world.seed.user(userId);
        for (const kind of ['question', 'approval', 'steer'] as const) {
          await world.store.appendEntry(world.tx, {
            taskId,
            kind,
            userId,
            externalAuthor: null,
            startedAt: at('2026-06-01T09:00:00.000Z'),
            endedAt: at('2026-06-01T09:10:00.000Z'),
            minutes: 10,
          });
        }
        // Nothing above is a `review`, so the review read must be empty — which is also the proof
        // that `reviewEntries` filters on the kind rather than on the task alone.
        expect(await world.store.reviewEntries(world.tx, taskId)).toEqual([]);
      } finally {
        await world.cleanup();
      }
    });

    it('extends a window it has, and refuses one it does not', async () => {
      const world = await harness.create();
      try {
        const taskId = nextId();
        await world.seed.task({ id: taskId });
        await world.store.appendEntry(world.tx, review(taskId));
        const [entry] = await world.store.reviewEntries(world.tx, taskId);

        await world.store.extendEntry(world.tx, entry?.id as Id, {
          endedAt: at('2026-06-01T10:30:00.000Z'),
          minutes: 90,
        });
        expect((await world.store.reviewEntries(world.tx, taskId))[0]).toMatchObject({
          endedAt: '2026-06-01T10:30:00.000Z',
          minutes: 90,
        });

        // A write that hit no row is how a projection silently stops being written (rule 18).
        await expect(
          world.store.extendEntry(world.tx, '00000000-0000-4000-8000-00000000dead' as Id, {
            endedAt: at('2026-06-01T10:30:00.000Z'),
            minutes: 90,
          }),
        ).rejects.toThrow();
      } finally {
        await world.cleanup();
      }
    });

    it('answers when a question was asked, and null for one that is gone', async () => {
      const world = await harness.create();
      try {
        const taskId = nextId();
        const questionId = nextId();
        await world.seed.task({ id: taskId });
        await world.seed.question({
          id: questionId,
          taskId,
          askedAt: at('2026-06-01T08:50:00.000Z'),
        });
        expect(await world.store.questionAskedAt(world.tx, questionId)).toBe(
          '2026-06-01T08:50:00.000Z',
        );
        expect(
          await world.store.questionAskedAt(world.tx, '00000000-0000-4000-8000-00000000dead' as Id),
        ).toBeNull();
      } finally {
        await world.cleanup();
      }
    });

    it('answers the organisation’s timezone, and null for a project that has no row', async () => {
      const world = await harness.create();
      try {
        // `organizations.timezone` is `not null default 'UTC'` (migration 0003), so the null this
        // port documents is **a project the platform does not have**, not an organisation without a
        // setting. The fake is seeded to match, which is what makes the two interchangeable.
        expect(await world.store.organisationTimezone(world.tx, world.projectId)).toBe('UTC');
        await world.seed.timezone('Europe/Prague');
        expect(await world.store.organisationTimezone(world.tx, world.projectId)).toBe(
          'Europe/Prague',
        );
        expect(
          await world.store.organisationTimezone(
            world.tx,
            '00000000-0000-4000-8000-00000000dead' as Id,
          ),
        ).toBeNull();
      } finally {
        await world.cleanup();
      }
    });
  });
};
