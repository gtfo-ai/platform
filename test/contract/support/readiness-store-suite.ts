/**
 * The `ReadinessStore` contract, run against the in-memory double and against PostgreSQL (WP-21,
 * technical/10 contract tier).
 *
 * Every unit test of the discovery record job runs on the double, so each of those claims rests on
 * the two stores being interchangeable — standing rule 23's shape for a persistence port: a new
 * obligation lands in the shared suite in the same change, or it is a store-local promise.
 *
 * ## The cases that earn the suite
 *
 * **`record` writes two things.** The row *and* `projects.readiness_level`. A store that wrote the
 * history and forgot the projection would leave every board badge reading `0` while the readiness
 * endpoint answered `3`, and nothing in the unit tier could see it — the double's `levels` map and
 * the adapter's column are read through the harness for exactly that reason.
 *
 * **`latest` is the newest, not the first or the only one.** A project is evaluated again after
 * every merged task (product/17), so the read has to order rather than take what it finds. The
 * suite writes three evaluations with distinct instants and out of order.
 *
 * **`criteria` survives the round trip.** It is a jsonb payload written in snake_case and read back
 * in camelCase, which is two mappings that can disagree; the suite compares the whole array.
 *
 * ## What it does not assert
 *
 * Ordering between two evaluations written in the same microsecond (the doubles break the tie
 * differently — the double's divergence register says so), and transactional rollback, which the
 * in-memory double cannot demonstrate and which the integration tier asserts against the adapter.
 */

import type { ReadinessEvaluation, ReadinessStore, Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

export interface ReadinessStoreHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: ReadinessStore;
    readonly tx: Transaction;
    /**
     * A project that **exists** — a real row where the store has a foreign key.
     *
     * On the harness rather than a literal in the suite, for the reason
     * `knowledge-proposals-suite.ts` states: a literal passes against the double and violates
     * `readiness_evaluations_project_id_fkey` against PostgreSQL, so the kinder store would be the
     * one the whole unit tier runs on (standing rule 1).
     */
    readonly projectId: Id;
    /** A second project, so "per project" is a claim the suite can falsify. */
    readonly otherProjectId: Id;
    /** `projects.readiness_level` as the *harness* reads it — the column, not the port. */
    readLevel(projectId: Id): Promise<number>;
    cleanup(): Promise<void>;
  }>;
}

const CRITERIA: ReadinessEvaluation['criteria'] = [
  {
    id: 'R1',
    passed: true,
    evidence: 'ran `pnpm test`: 42 passed',
    unlocks: 'Implementation self-check',
    detectedBy: 'agent',
  },
  {
    id: 'R9',
    passed: false,
    evidence: 'the git provider reports the default branch as unprotected',
    unlocks: 'Human merge guarantee (BD-007)',
    detectedBy: 'platform',
  },
];

export const runReadinessStoreContract = (harness: ReadinessStoreHarness): void => {
  describe(`ReadinessStore contract (${harness.name})`, () => {
    let context: Awaited<ReturnType<ReadinessStoreHarness['create']>>;

    beforeEach(async () => {
      await context?.cleanup();
      context = await harness.create();
    });

    /**
     * The **last** context has to be cleaned up too, and forgetting it is not a leak of a handle —
     * it is a leak of a *lock*.
     *
     * The PostgreSQL harness runs each case inside an open transaction it rolls back in `cleanup`,
     * and `record` writes `projects.readiness_level`. A suite that only cleaned up in `beforeEach`
     * would leave the final transaction open, holding a row lock on `projects`, and the next file
     * in the same worker that updates that project blocks until the test times out. Measured:
     * `onboarding.integration.test.ts` hung for 120 s in exactly that way.
     */
    afterAll(async () => {
      await context?.cleanup();
    });

    const evaluation = (
      overrides: Partial<ReadinessEvaluation> & { readonly id: Id },
    ): ReadinessEvaluation => ({
      projectId: context.projectId,
      level: 1,
      criteria: CRITERIA,
      evaluatedAt: '2026-09-13T04:00:00.000Z' as IsoDateTime,
      source: 'discovery',
      ...overrides,
    });

    const id = (n: number): Id => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as Id;

    it('answers null for a project that has never been evaluated', async () => {
      expect(await context.store.latest(context.projectId)).toBeNull();
    });

    it('records an evaluation and reads it back whole', async () => {
      const written = evaluation({ id: id(1), level: 2 });
      await context.store.record(context.tx, written);
      const read = await context.store.latest(context.projectId);
      expect(read?.id).toBe(written.id);
      expect(read?.level).toBe(2);
      expect(read?.source).toBe('discovery');
      expect(read?.evaluatedAt).toBe(written.evaluatedAt);
      // The whole array, because the jsonb mapping is written twice (snake_case out, camelCase in).
      expect(read?.criteria).toEqual(CRITERIA);
    });

    it('writes the project’s readiness level with the evaluation', async () => {
      // The second half of `record`, asserted on the **column** rather than on the port: a store
      // that dropped it would pass every other case in this file.
      expect(await context.readLevel(context.projectId)).toBe(0);
      await context.store.record(context.tx, evaluation({ id: id(2), level: 3 }));
      expect(await context.readLevel(context.projectId)).toBe(3);
    });

    it('lowers the level too, because readiness is re-checked and can go down', async () => {
      // Both directions (rule 42): a store that only ever raised the column would pass the case
      // above. product/17 re-checks after every merged task, and a deleted CI job lowers the level.
      await context.store.record(context.tx, evaluation({ id: id(3), level: 3 }));
      await context.store.record(
        context.tx,
        evaluation({ id: id(4), level: 1, evaluatedAt: '2026-09-14T04:00:00.000Z' as IsoDateTime }),
      );
      expect(await context.readLevel(context.projectId)).toBe(1);
    });

    it('answers with the newest evaluation, whatever order they were written in', async () => {
      await context.store.record(
        context.tx,
        evaluation({ id: id(5), level: 1, evaluatedAt: '2026-09-11T04:00:00.000Z' as IsoDateTime }),
      );
      await context.store.record(
        context.tx,
        evaluation({ id: id(6), level: 4, evaluatedAt: '2026-09-13T04:00:00.000Z' as IsoDateTime }),
      );
      // Written last, dated earliest: a store that returned "the last row inserted" fails here.
      await context.store.record(
        context.tx,
        evaluation({ id: id(7), level: 0, evaluatedAt: '2026-09-12T04:00:00.000Z' as IsoDateTime }),
      );
      const read = await context.store.latest(context.projectId);
      expect(read?.id).toBe(id(6));
      expect(read?.level).toBe(4);
    });

    it('keeps one project’s evaluation out of another’s', async () => {
      await context.store.record(context.tx, evaluation({ id: id(8), level: 4 }));
      expect(await context.store.latest(context.otherProjectId)).toBeNull();
      expect(await context.readLevel(context.otherProjectId)).toBe(0);
    });

    it('stores an evaluation with no criteria at all', async () => {
      // Legal and meaningful: a build whose criteria table was empty would still record a level.
      // The case exists because "an empty array round-trips" is exactly what a jsonb mapping that
      // writes `null` instead of `[]` gets wrong.
      await context.store.record(context.tx, evaluation({ id: id(9), criteria: [] }));
      expect(await context.store.latest(context.projectId)).toMatchObject({ criteria: [] });
    });
  });
};
