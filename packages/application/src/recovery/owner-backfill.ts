/**
 * **The owner backfill** — a live task's tracker assignee is read once even if its ticket never
 * changes (BACKLOG 1510, closing S-26.1's gap). A row of the recovery pass (`./stranded.ts`).
 *
 * ## What it is for
 *
 * S-26.1 stores the ticket's assignee as `tasks.ticket_assignee` at every read the platform makes
 * of the ticket — intake, a stage's re-read, the `owner_sync` duty on `ticket.updated`, the claim's
 * pre-read (`pipeline/owner-sync.ts` § Where the tracker is read). A task created **before** S-26.1
 * had no such read, and if it sits idle — `needs_human`, say — while its ticket does not change, it
 * gets none of them: the ticket poll's live-task re-read (`pipeline/ticket-poll.ts`, WP-110) asks
 * only for tickets **changed** since its window, and the duty runs only on a change. Measured on
 * Autix: AUT-6676 stopped `ticket_assigned_elsewhere`, its Jira ticket assigned to a colleague, and
 * its `ticket_assignee` null, so the held-ticket callout said *someone else* instead of the name.
 *
 * ## Where it runs: the recovery pass, not the ticket poll
 *
 * The brief offered both. The poll was the narrower change (it already holds the binding and the
 * jobs), but it runs **only** for a binding with `poll_enabled`; a webhook-only binding's idle tasks
 * would stay nameless. This pass runs on every core with a pipeline, at
 * `APP_INTAKE_RECONCILE_INTERVAL_MS`, over every project, and its contract is exactly this row's —
 * *find the row, enqueue the wake-up, bounded by an attempt mark* (`./stranded.ts`) — with
 * precedent for a row that backfills what an earlier build left: `run_offer_reroute`
 * (`./offer-timeout.ts`) routes offers written before WP-278, and `deadline` (`./deadline.ts`)
 * arms questions written before deadlines existed.
 *
 * ## The marker: new columns, `tasks.owner_backfill_*` (migration 0110)
 *
 * No existing field says "this task has had an owner-sync read". `ticket_assignee` is null both for
 * *never read* and for *read, unassigned* (migration 0104 says so), so it alone would re-read an
 * unassigned ticket at every pass, for ever. `ticket_snapshot_at` is written by reads made before
 * S-26.1 too, so it cannot tell a pre-S-26.1 snapshot from one the owner sync applied. And stamping
 * a marker at every sync path would put a write into intake's insert and the claim's transactions
 * (S-26.2's, and PR #117's) for columns whose only reader is this pass. So the pass keeps its own
 * three, each with one writer:
 *
 *  - **an attempt is claimed before the wake-up is enqueued** (`claimOwnerBackfillAttempt`:
 *    `owner_backfill_attempts + 1` and `owner_backfill_retry_at`, one conditional statement) — the
 *    ordering `./stranded.ts` gives every attempt mark (PROGRESS backlog 105: a mark the duty wrote
 *    would leave a row whose duty never fired to be re-enqueued at every pass). An enqueue that is
 *    lost is therefore retried after the same wait, and counted;
 *  - **the duty settles it** (`settleOwnerBackfill`, `owner_backfill_at`) when the provider answered
 *    definitively — the ticket, an **unassigned one included**, which is then never asked for
 *    again; a 404; a permission refusal — and leaves it owed after a **transient** failure (an
 *    outage, a 429, a 401, a binding that will not load: BACKLOG 1511), so a later pass tries again
 *    15 minutes and then 2 hours later; after {@link OWNER_BACKFILL_MAX_ATTEMPTS} attempts it
 *    settles it anyway and logs that it stopped (`settleOwnerBackfillRead`, `pipeline/owner-sync.ts`);
 *  - a task created since S-26.1 whose ticket was unassigned at intake is also found once and costs
 *    one read (BACKLOG 1512). That is the price of a marker no sync path writes, and it is bounded
 *    the same way.
 *
 * ## The bound
 *
 * {@link OWNER_BACKFILL_PER_PASS} tasks per pass, the most recently touched first (`updated_at`
 * descending — the task a person is looking at now before one nobody has opened for a month), and
 * never more than the pass's own `limit`. Each costs one `readTicket` through
 * `IntegrationActionExecutor`, which charges the binding's rate limit and writes the audit row.
 *
 * ## What the duty does
 *
 * Exactly the `owner_sync` duty (`runOwnerSync`), with `owner_backfill: true`: re-validated on fire
 * (the task live, and still with no stored assignee), one read between its transactions, and the
 * read's assignee applied by `ownerSyncOnRead` — the redacted, bounded display name, the owner set
 * when a linked member holds the ticket, and the platform-account guard of `syncOwnerFromTracker`.
 * The one difference is `ensureTicketSnapshot`'s `read: 'always'`: the snapshot of an idle task is
 * fresh, and the ordinary duty would read nothing.
 * And afterwards it settles the backfill, or leaves it owed, by the read's outcome
 * (`classifyTicketReadError`, `settleOwnerBackfillRead`).
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { enqueueOutbound } from '../pipeline/jobs.js';
import { OWNER_BACKFILL_MAX_ATTEMPTS, ownerBackfillRetryAt } from '../pipeline/owner-sync.js';
import type { TaskRepository } from '../pipeline/store.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The site name the pass reports under (`./stranded.ts`). */
export const OWNER_BACKFILL_SITE = 'owner_backfill';

/**
 * Tasks one pass enqueues a backfill read for, at most (BACKLOG 1510).
 *
 * A fifth of `MAX_TICKET_MATCH_KEYS` (100, the poll's live re-read of one Jira page): at the
 * shipped one-minute pass interval the row costs at most twenty single-issue reads a minute across
 * the installation, on top of whatever the binding's own traffic is, and an installation with a
 * hundred pre-S-26.1 live tasks is drained in five passes. A backlog past it waits a pass, never
 * longer than `ceil(n / 20)` intervals.
 */
export const OWNER_BACKFILL_PER_PASS = 20;

export interface OwnerBackfillRecoverySite {
  readonly tasks: Pick<TaskRepository, 'ownerBackfillDue' | 'claimOwnerBackfillAttempt'>;
}

/**
 * One pass: read the tasks whose next backfill attempt may be claimed now, then for each claim it
 * in a transaction of its own and — only when the claim was this pass's — enqueue the `owner_sync`
 * duty with the attempt's number.
 */
export const recoverOwnerBackfill = async (
  options: { readonly unitOfWork: UnitOfWork; readonly jobs: Jobs; readonly logger?: Logger },
  site: OwnerBackfillRecoverySite,
  input: { readonly now: IsoDateTime; readonly olderThan: IsoDateTime; readonly limit: number },
): Promise<{ readonly found: number; readonly enqueued: number }> => {
  const logger = options.logger ?? silentLogger;
  const due = await options.unitOfWork.transaction(async (scope) =>
    site.tasks.ownerBackfillDue(scope.tx, {
      olderThan: input.olderThan,
      now: input.now,
      maxAttempts: OWNER_BACKFILL_MAX_ATTEMPTS,
      limit: Math.max(0, Math.min(input.limit, OWNER_BACKFILL_PER_PASS)),
    }),
  );
  const enqueued: Id[] = [];
  for (const row of due) {
    const attempt = await options.unitOfWork.transaction(async (scope) =>
      site.tasks.claimOwnerBackfillAttempt(scope.tx, row.taskId, {
        now: input.now,
        expectedAttempts: row.attempts,
        // The wait after the attempt this claim makes, which is the row's count plus one.
        retryAt: ownerBackfillRetryAt(input.now, row.attempts + 1),
      }),
    );
    if (attempt === null) {
      // Another pass claimed it first; that pass enqueued the read.
      continue;
    }
    await enqueueOutbound(options.jobs, {
      duty: 'owner_sync',
      project_id: row.projectId,
      task_id: row.taskId,
      // The field is required on the wire; a backfill has no cause event, and the duty records
      // none (`runOwnerSync`). The task id names what woke it.
      cause_event_id: row.taskId,
      owner_backfill: true,
      owner_backfill_attempt: attempt,
    });
    enqueued.push(row.taskId);
  }
  if (enqueued.length > 0) {
    logger.info(
      { enqueued: enqueued.length, task_ids: enqueued },
      'live tasks with no tracker assignee on record had their ticket read, so a task created before task ownership names who holds its ticket (BACKLOG 1510)',
    );
  }
  return { found: due.length, enqueued: enqueued.length };
};
