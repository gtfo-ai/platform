/**
 * The knowledge change a human accepted that no commit carries — a row of `./stranded.ts`'s table
 * (WP-124, TD-004's M7 amendment, PROGRESS backlog **366**).
 *
 * ## What is lost
 *
 * An approval (or a policy's `auto_applied`) enqueues one `knowledge.apply` pass for the project
 * after the decision commits. A pass that throws on every try — the provider down for the length of
 * the retry window, a refused commit — becomes a pg-boss `failed` row, which since WP-108 an
 * administrator can list and nothing acts on. **Measured at WP-124** (backlog 366): the proposal
 * then reads `queued` with `decided_at` set, which the queue card draws exactly like an undecided
 * one; the nightly hygiene pass lists its project in `projectsAwaitingApply` and re-enqueues an
 * apply every night, for ever, and nobody is told.
 *
 * ## The predicate
 *
 *  - the proposal is **awaiting apply** (`isAwaitingApply`: `auto_applied`, or `queued` with a
 *    decision, and no commit) and was decided more than the pass's grace ago (`decided_at`, or
 *    `created_at` for a policy's decision, which has none);
 *  - **no `knowledge.apply` job** keyed `project:<id>` is `created`, `retry` or `active` — asked of
 *    pg-boss's own table, the `stranded_stage` row's way, because a pass in flight or waiting out a
 *    retry delay is the live path and must not be raced.
 *
 * ## What it does: once, then an ending
 *
 * The table's shape (backlog 105). The **mark** — `kb_proposals.apply_recovery_attempted_at`,
 * migration 0075 — is written for the project's unattempted proposals **only while the predicate
 * still holds** (the arbiter with the live path, standing rule 9: an apply enqueued between the
 * pass's read and its mark makes the mark write nothing), and then **one** apply is enqueued for
 * the project with the reason `recovery`. When a marked proposal is still unapplied, with no live
 * job, a whole ending window later, it is moved to **`apply_failed`** with a platform reason —
 * again only while the predicate holds, so a pass that starts or lands meanwhile wins. An
 * `apply_failed` proposal is not awaiting apply, so neither the apply pass nor the hygiene sweep
 * retries it; the queue card says why, and a maintainer's approval is how it is asked for again
 * (`decide.ts`: the decision clears the mark and the reason).
 *
 * **A project with no git binding reaches the same ending**, and that is the intent: the apply
 * pass leaves its proposals where they are and reports `unavailable`, so they were approved and
 * would never land; the reason names both causes rather than guessing which.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { enqueueKnowledgeApply } from '../knowledge/apply.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** An approved proposal no commit carries and no apply job is working on (backlog 366). */
export interface StrandedApply {
  readonly proposalId: Id;
  readonly projectId: Id;
  /** `null` until this pass has spent the proposal's one attempt (migration 0075). */
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

/** `./stranded.ts`'s `StrandedQuery` by another name. */
export interface StrandedApplyQuery {
  readonly olderThan: IsoDateTime;
  readonly endingBefore: IsoDateTime;
  readonly limit: number;
}

export interface KnowledgeApplyRecoveryStore {
  /**
   * The module docblock's predicate: an unattempted proposal decided before `olderThan`, or an
   * attempted one whose mark is older than `endingBefore`. Oldest decision first, at most `limit`.
   */
  strandedApplies(tx: Transaction, query: StrandedApplyQuery): Promise<readonly StrandedApply[]>;
  /**
   * Marks these proposals **only while the predicate still holds for each** (still awaiting apply,
   * unattempted, no live job for its project) and answers the ids it marked.
   */
  markApplyAttempt(
    tx: Transaction,
    input: { readonly proposalIds: readonly Id[]; readonly at: IsoDateTime },
  ): Promise<readonly Id[]>;
  /**
   * The ending: `apply_failed` with `reason`, **only while the predicate still holds** (still
   * awaiting apply, attempted, no live job) — answers the ids it ended.
   */
  endApply(
    tx: Transaction,
    input: { readonly proposalIds: readonly Id[]; readonly reason: string },
  ): Promise<readonly Id[]>;
}

export interface KnowledgeApplyRecoverySite {
  readonly store: KnowledgeApplyRecoveryStore;
}

/** The reason an `apply_failed` card shows — platform text, so it may be rendered and logged. */
export const applyFailedReason = (attemptedAt: IsoDateTime): string =>
  `the platform could not commit this approved change: its apply job failed or never ran, the recovery pass asked for one more apply at ${attemptedAt}, and the change was still not committed an hour later. The project may have no git binding, or the provider refused the commit; approve it again to retry (PROGRESS backlog 366)`;

export interface KnowledgeApplyRecoveryReport {
  readonly site: 'knowledge_apply';
  readonly found: number;
  /** Projects an apply was enqueued for — one per project, however many of its proposals. */
  readonly reEnqueued: number;
  /** Proposals moved to `apply_failed`. */
  readonly ended: number;
}

/**
 * Marks, then wakes, once per project; then the ending. Both writes are conditional, so a proposal
 * the live path reached first is neither woken nor ended, and the report counts what was done.
 */
export const recoverStrandedApplies = async (
  options: {
    readonly unitOfWork: UnitOfWork;
    readonly jobs: Jobs;
    readonly logger?: Logger;
  },
  site: KnowledgeApplyRecoverySite,
  rows: readonly StrandedApply[],
  now: IsoDateTime,
): Promise<KnowledgeApplyRecoveryReport> => {
  const logger = options.logger ?? silentLogger;
  const unattempted = new Map<Id, Id[]>();
  const attempted = new Map<IsoDateTime, Id[]>();
  for (const row of rows) {
    if (row.recoveryAttemptedAt === null) {
      unattempted.set(row.projectId, [...(unattempted.get(row.projectId) ?? []), row.proposalId]);
    } else {
      attempted.set(row.recoveryAttemptedAt, [
        ...(attempted.get(row.recoveryAttemptedAt) ?? []),
        row.proposalId,
      ]);
    }
  }

  let reEnqueued = 0;
  for (const [projectId, proposalIds] of unattempted) {
    // The mark commits before the enqueue — the table's safe order (`runAttemptOrEndSite`).
    const marked = await options.unitOfWork.transaction(async (scope) =>
      site.store.markApplyAttempt(scope.tx, { proposalIds, at: now }),
    );
    if (marked.length === 0) {
      continue;
    }
    await enqueueKnowledgeApply(options.jobs, { projectId, reason: 'recovery' });
    reEnqueued += 1;
    logger.warn(
      { project_id: projectId, proposals: marked.length },
      'approved knowledge proposals had no commit and no apply job, so one apply was enqueued for their project — once, and they read apply_failed if that does not take (PROGRESS backlog 366)',
    );
  }

  let ended = 0;
  for (const [attemptedAt, proposalIds] of attempted) {
    const done = await options.unitOfWork.transaction(async (scope) =>
      site.store.endApply(scope.tx, { proposalIds, reason: applyFailedReason(attemptedAt) }),
    );
    ended += done.length;
    if (done.length > 0) {
      logger.error(
        { proposals: done, attempted_at: attemptedAt },
        'approved knowledge proposals were still not committed after their one recovery attempt, so they read apply_failed on the proposal queue, where a maintainer re-approves them (PROGRESS backlog 366)',
      );
    }
  }

  return { site: 'knowledge_apply', found: rows.length, reEnqueued, ended };
};
