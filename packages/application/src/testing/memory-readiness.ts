/**
 * The in-memory `ReadinessStore` double (WP-21).
 *
 * ## Divergence register (standing rules 1 and 12)
 *
 * Every divergence below is in the direction of being **stricter or equal**, never kinder, and the
 * shared contract suite (`test/contract/support/readiness-store-suite.ts`) runs against both this
 * and PostgreSQL so the list is checkable rather than asserted.
 *
 * 1. **No foreign key.** `readiness_evaluations.project_id` references `projects`, so the adapter
 *    refuses an evaluation for a project that does not exist and this does not. The suite therefore
 *    only ever records against a project the harness created — which is why `projectId` is on the
 *    harness rather than a literal in the suite (the shape `knowledge-proposals-suite.ts` uses for
 *    the same reason).
 * 2. **No level constraint.** `readiness_evaluations_level_range` refuses a level outside 0…5; this
 *    double stores what it is handed. Nothing in the platform produces one —
 *    `readinessLevelFor` returns 0…4 by construction — so the check has no caller to catch.
 * 3. **No transaction.** `record` ignores the handle, so a rollback leaves the row here. The suite
 *    does not test rollback; the integration tier does, against the real adapter.
 * 4. **Ordering ties.** `latest` sorts by `(evaluatedAt, id)` descending, which is the adapter's
 *    `order by`. Two evaluations at the *same* instant with the same id cannot be told apart by
 *    either store, so the suite only ever asserts `latest` on distinct instants. The first draft of
 *    this double returned "the last row inserted" and the shared suite caught it, which is the
 *    reason the suite exists (standing rule 1: kinder is the direction that matters, and "whatever
 *    was written last" is kinder than "the newest").
 */
import type { Id } from '@platform/contracts';
import type { ReadinessEvaluation, ReadinessStore } from '../onboarding/ports.js';
import type { Transaction } from '../ports/transaction.js';

export interface MemoryReadinessStore extends ReadinessStore {
  /** Every evaluation written, oldest first — what a test asserts on. */
  readonly rows: readonly ReadinessEvaluation[];
  /** The narrow `projects.readiness_level` write, as the double records it. */
  readonly levels: ReadonlyMap<Id, number>;
}

export const memoryReadinessStore = (): MemoryReadinessStore => {
  const rows: ReadinessEvaluation[] = [];
  const levels = new Map<Id, number>();
  return {
    rows,
    levels,
    record: async (_tx: Transaction, evaluation: ReadinessEvaluation) => {
      rows.push(evaluation);
      // The pair is one write for the same reason it is one method on the port: a build that wrote
      // the row without the projection would show a level no evaluation supports.
      levels.set(evaluation.projectId, evaluation.level);
    },
    latest: async (projectId: Id) =>
      [...rows]
        .filter((row) => row.projectId === projectId)
        .sort((left, right) =>
          left.evaluatedAt === right.evaluatedAt
            ? right.id.localeCompare(left.id)
            : right.evaluatedAt.localeCompare(left.evaluatedAt),
        )[0] ?? null,
  };
};
