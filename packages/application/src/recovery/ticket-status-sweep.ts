/**
 * **The one-off ticket-status sweep** (S-28.5, M28 ruling 5, TD-029 amendment B decision 4) — a row
 * of the recovery pass (`./stranded.ts`).
 *
 * The reverse sync (`pipeline/ticket-status-recheck.ts`) acts on a **signal**: a status change, or a
 * polled edit. A task whose ticket a person finished **before** S-28.5 was deployed — AUT-6676,
 * *Released* three weeks before it became a task — sends none, so it would wait for ever. This row
 * re-reads every live `normal` task's ticket **once**: it records the task in `ticket_status_sweeps`
 * (migration 0115, `insert … on conflict do nothing` — two passes that found the same task claim it
 * once) and only then enqueues the `ticket_status_recheck` duty with `ticket_status_sweep: true`,
 * which reads the ticket through `IntegrationActionExecutor` and applies the reverse sync's table —
 * so a status the platform wrote (a slot, `returned`, a `status_mapping` target) never stops a task,
 * and neither does a human stage or a merged task.
 *
 * **Once per revision** (S-28.11): only tasks created before {@link TICKET_STATUS_SWEEP_REVISION_AT}
 * are considered, and each once in that revision (`TaskRepository.ticketStatusSweepDue`). A lost
 * enqueue is not retried — the record is written first, the `./stranded.ts` ordering — and the task
 * is then covered by the next status signal and by the claim's re-check, as any task is.
 *
 * **The bound**: {@link TICKET_STATUS_SWEEP_PER_PASS} tasks per pass, the most recently touched
 * first, never more than the pass's own `limit` — one `readTicket` each.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { enqueueOutbound } from '../pipeline/jobs.js';
import type { TaskRepository } from '../pipeline/store.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The site name the pass reports under (`./stranded.ts`). */
export const TICKET_STATUS_SWEEP_SITE = 'ticket_status_sweep';

/** Tasks one pass sweeps, at most — the owner backfill's bound, for the same reason (20 reads/min). */
export const TICKET_STATUS_SWEEP_PER_PASS = 20;

/**
 * **The sweep's revision** (S-28.11): the instant the current rule of the reverse sync took effect.
 * A task recorded by an earlier revision is due again — S-28.5's sweep exempted every status the
 * binding's lifecycle *could* write, so a queued task whose ticket a person had delivered to the
 * `done` slot's status (AUT-6743, *Ready for Merge*) was judged the platform's own and started —
 * and a record this revision writes is `greatest(now, revision)`, so it is never due again. Only
 * tasks created before it are swept: a later one went through intake and the claim under the
 * corrected rule. Bump it when the rule that decides a stop changes.
 */
export const TICKET_STATUS_SWEEP_REVISION_AT = '2026-11-11T00:00:00.000Z' as IsoDateTime;

export interface TicketStatusSweepRecoverySite {
  readonly tasks: Pick<TaskRepository, 'ticketStatusSweepDue' | 'claimTicketStatusSweep'>;
}

/** One pass: the tasks not swept yet, each recorded in a transaction of its own, then its read. */
export const recoverTicketStatusSweep = async (
  options: { readonly unitOfWork: UnitOfWork; readonly jobs: Jobs; readonly logger?: Logger },
  site: TicketStatusSweepRecoverySite,
  input: {
    readonly now: IsoDateTime;
    readonly olderThan: IsoDateTime;
    readonly limit: number;
    /** The sweep's revision; {@link TICKET_STATUS_SWEEP_REVISION_AT} when absent (tests pass one). */
    readonly revisionAt?: IsoDateTime;
  },
): Promise<{ readonly found: number; readonly enqueued: number }> => {
  const due = await options.unitOfWork.transaction(async (scope) =>
    site.tasks.ticketStatusSweepDue(scope.tx, {
      olderThan: input.olderThan,
      revisionAt: input.revisionAt ?? TICKET_STATUS_SWEEP_REVISION_AT,
      limit: Math.max(0, Math.min(input.limit, TICKET_STATUS_SWEEP_PER_PASS)),
    }),
  );
  const enqueued: Id[] = [];
  for (const row of due) {
    const claimed = await options.unitOfWork.transaction(async (scope) =>
      site.tasks.claimTicketStatusSweep(
        scope.tx,
        row.taskId,
        input.now,
        input.revisionAt ?? TICKET_STATUS_SWEEP_REVISION_AT,
      ),
    );
    if (!claimed) {
      // Another pass recorded it first; that pass enqueued the read.
      continue;
    }
    await enqueueOutbound(options.jobs, {
      duty: 'ticket_status_recheck',
      project_id: row.projectId,
      task_id: row.taskId,
      // Required on the wire; the sweep has no cause event, and the task id names what woke it.
      cause_event_id: row.taskId,
      ticket_status_sweep: true,
    });
    enqueued.push(row.taskId);
  }
  if (enqueued.length > 0) {
    (options.logger ?? silentLogger).info(
      { enqueued: enqueued.length, task_ids: enqueued },
      'live tasks had their ticket’s status re-read once, so a ticket a person finished before this release stops its task (S-28.5)',
    );
  }
  return { found: due.length, enqueued: enqueued.length };
};
