/**
 * The discovery run whose findings were never recorded — a row of `./stranded.ts`'s table (WP-124,
 * TD-004's M7 amendment, PROGRESS backlog **366**).
 *
 * ## What is lost
 *
 * A Discovery agent's run stores a `DiscoveryDraft` artifact, and the `artifact.created` handler
 * enqueues one `onboarding.discovery` job after its commit (`onboarding/record.ts`). That job writes
 * the readiness evaluation and turns the drafted pages into knowledge proposals. One that throws on
 * every try — or whose wake-up was lost — leaves a **paid** run's output unread: the project keeps
 * its previous evaluation (or answers `409 readiness_not_evaluated`) while its discovery task reads
 * `done`, and since WP-108 only an administrator's failed-jobs list said so.
 *
 * ## The predicate
 *
 *  - a `DiscoveryDraft` artifact older than the pass's grace, and the **newest** of its project: an
 *    older draft a later run superseded is history, and recording it now would overwrite the newer
 *    evaluation with a stale one;
 *  - **no evaluation recorded from it**: no `readiness_evaluations` row of its project with source
 *    `discovery` or `rediscovery` evaluated at or after the artifact was stored (a `recheck` row
 *    carries the previous evaluation forward and does not count);
 *  - **no `onboarding.discovery` job** for that artifact that is `created`, `retry` or `active` —
 *    asked of pg-boss's own table, as `stranded_stage` asks it.
 *
 * ## What it does: once, then an ending
 *
 * The table's shape (backlog 105). The **mark** is a `discovery_record_recoveries` row for the
 * artifact (migration 0075), inserted only while the predicate still holds — the arbiter with the
 * live path (standing rule 9) — and then the artifact's own `onboarding.discovery` job is enqueued
 * again; the recorder re-reads everything when it fires (TD-004). When the one attempt has not
 * recorded an evaluation a whole ending window later, the row is ended with a platform reason, and
 * the discovery task **escalates with a brief** through `pipeline/job-escalation.ts`'s ending: a
 * task that can escalate does; a discovery task is `done` by then (its template ends one stage
 * after it starts, and `done` has no edge to `needs_human`), so its people are told by an
 * escalation notification instead (OPEN-QUESTIONS **Q113**), and the reason is published on the
 * project's re-evaluation read beside the button that starts a new discovery.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  type ExhaustedJobEscalationOptions,
  escalateTaskWithBrief,
} from '../pipeline/job-escalation.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** A discovery run's draft no evaluation was recorded from (backlog 366). */
export interface StrandedDiscoveryRecord {
  readonly artifactId: Id;
  readonly projectId: Id;
  readonly taskId: Id;
  /** The `artifact.created` event that announced it — what keys the ending's notification. */
  readonly artifactEventId: Id | null;
  /** `null` until this pass has spent the artifact's one attempt (migration 0075). */
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

export interface StrandedDiscoveryQuery {
  readonly olderThan: IsoDateTime;
  readonly endingBefore: IsoDateTime;
  readonly limit: number;
}

export interface DiscoveryRecordRecoveryStore {
  /**
   * The module docblock's predicate: an unattempted draft stored before `olderThan`, or an
   * attempted one, not yet ended, whose mark is older than `endingBefore`. Oldest first.
   */
  strandedDiscoveryRecords(
    tx: Transaction,
    query: StrandedDiscoveryQuery,
  ): Promise<readonly StrandedDiscoveryRecord[]>;
  /** Inserts the mark **only while the predicate still holds**; answers whether it did. */
  markDiscoveryRecordAttempt(
    tx: Transaction,
    input: { readonly artifactId: Id; readonly at: IsoDateTime },
  ): Promise<boolean>;
  /** Ends the row with `reason` **only while the predicate still holds**; answers whether it did. */
  endDiscoveryRecord(
    tx: Transaction,
    input: { readonly artifactId: Id; readonly reason: string; readonly at: IsoDateTime },
  ): Promise<boolean>;
}

export interface DiscoveryRecordRecoverySite {
  readonly store: DiscoveryRecordRecoveryStore;
  /** What the ending escalates the discovery task through (`pipeline/job-escalation.ts`). */
  readonly escalation: Omit<ExhaustedJobEscalationOptions, 'jobs' | 'unitOfWork' | 'logger'>;
}

/** The reason on the row and in the brief — platform text only. */
export const discoveryUnrecordedReason = (attemptedAt: IsoDateTime): string =>
  `the discovery run finished and stored its draft, but its readiness evaluation and drafted pages were never recorded — the recording job failed, never ran, or skipped a draft its schema refuses — the recovery pass asked for it once more at ${attemptedAt}, and it still had not recorded an hour later (PROGRESS backlog 366)`;

export interface DiscoveryRecordRecoveryReport {
  readonly site: 'discovery_record';
  readonly found: number;
  readonly reEnqueued: number;
  readonly ended: number;
}

export const recoverStrandedDiscoveryRecords = async (
  options: { readonly unitOfWork: UnitOfWork; readonly jobs: Jobs; readonly logger?: Logger },
  site: DiscoveryRecordRecoverySite,
  rows: readonly StrandedDiscoveryRecord[],
  now: IsoDateTime,
): Promise<DiscoveryRecordRecoveryReport> => {
  const logger = options.logger ?? silentLogger;
  let reEnqueued = 0;
  let ended = 0;
  for (const row of rows) {
    const fields = { project_id: row.projectId, task_id: row.taskId, artifact_id: row.artifactId };
    if (row.recoveryAttemptedAt === null) {
      const marked = await options.unitOfWork.transaction(async (scope) =>
        site.store.markDiscoveryRecordAttempt(scope.tx, { artifactId: row.artifactId, at: now }),
      );
      if (!marked) {
        continue;
      }
      // The artifact's own wake-up, as `discoveryTriggerHandlers` builds it; it re-reads on fire.
      await options.jobs.enqueue({
        queue: JOB_QUEUES.discoveryRecord,
        data: { project_id: row.projectId, task_id: row.taskId, artifact_id: row.artifactId },
      });
      reEnqueued += 1;
      logger.warn(
        fields,
        'a discovery run’s draft was never recorded, so its recording job was enqueued again — once, and the discovery task is escalated if that does not take (PROGRESS backlog 366)',
      );
      continue;
    }
    const reason = discoveryUnrecordedReason(row.recoveryAttemptedAt);
    const endedNow = await options.unitOfWork.transaction(async (scope) =>
      site.store.endDiscoveryRecord(scope.tx, { artifactId: row.artifactId, reason, at: now }),
    );
    if (!endedNow) {
      continue;
    }
    ended += 1;
    const ending = await escalateTaskWithBrief(
      {
        ...site.escalation,
        unitOfWork: options.unitOfWork,
        jobs: options.jobs,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      {
        taskId: row.taskId,
        projectId: row.projectId,
        causeEventId: row.artifactEventId,
        reason: 'the discovery run’s findings were never recorded',
        brief: (ticketKey) =>
          `The platform could not record what discovery ${ticketKey} found: ${reason}. ` +
          'The project keeps its previous readiness evaluation, or none. Run discovery again from the project’s settings (Re-evaluate), which starts a new run.',
      },
    );
    logger.error(
      { ...fields, attempted_at: row.recoveryAttemptedAt, ending },
      'a discovery run’s findings were still not recorded after their one recovery attempt; the discovery task was escalated with a brief (PROGRESS backlog 366)',
    );
  }
  return { site: 'discovery_record', found: rows.length, reEnqueued, ended };
};
