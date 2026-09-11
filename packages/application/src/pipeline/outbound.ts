/**
 * `pipeline.outbound` — every provider call the pipeline makes because of an event (WP-15d).
 *
 * ## Why there is a queue here at all
 *
 * An event handler runs inside two transactions: the dispatcher's, which owns the event's queue row
 * for the whole dispatch, and its own. A provider call made from there holds a pooled connection
 * and the platform's dispatch slot (`APP_DISPATCH_MAX_CONCURRENCY` ships as **1**) for as long as
 * somebody else's HTTP request takes, and makes the executor's audit write — which commits in a
 * transaction of its own, BD-003 — nest inside the caller's. Both were paid for before the cause
 * was named: `integration_actions_task_id_fkey`, which made every e2e fail because the audit row
 * commits before the task row does, and a pool floor that grew a third connection per in-flight
 * dispatch.
 *
 * Measured at the shipped defaults, with one git read held open by a promise the test resolves: an
 * event with nothing to do with that provider was **not dispatched at all** while the call was in
 * flight (`test/e2e/pipeline/outbound-shape.e2e.test.ts`). So the handler decides and this queue
 * calls — CLAUDE.md's *transaction / no transaction / transaction*, which the stage executor and
 * the two older jobs already had.
 *
 * ## What a duty may assume, and what it may not
 *
 * A job is a **wake-up**, not a message. `Jobs.enqueue` cannot join the handler's transaction
 * (TD-004), so every enqueue goes through `HandlerContext.afterCommit` and every duty re-derives
 * what it should do from committed state when it fires. The payload carries ids, the cause event's
 * id, and the two pieces of event text no row holds — the matched ticket and a blocker brief.
 *
 * Three consequences that are the point rather than the price:
 *
 *  - a duplicate wake-up is harmless: intake finds the task already created, the render writes the
 *    same comment through the same marker, the transition asks for a status the ticket is already
 *    in. On top of that the two ticket **writes** carry an `IdempotencyPlan` keyed by the cause
 *    event, so a retry after the provider already answered replays instead of writing twice;
 *  - a **lost** wake-up costs differently per duty, and that is why only one of them needed a job
 *    rather than a bare callback: the workpad and the status are re-derived from the task row by
 *    the next event, while the intake check is the only chance that ticket has;
 *  - nothing here holds a transaction while it calls. `integrations.forProject` and the executor
 *    both refuse if a later change tries (`events/open-transaction.ts`).
 */
import type { JobHandler } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineOutboundData } from './jobs.js';
import { type PipelineSagaOptions, runIntakeCheck } from './saga.js';
import { runStatusTransition, runWorkpadRender } from './workpad.js';

export interface PipelineOutboundOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
}

/**
 * One job, one duty.
 *
 * The `default` branch **logs and returns** rather than throwing: a duty name this build does not
 * know can only come from a job enqueued by a newer deployment against the same database during a
 * rolling upgrade, and failing it would retry it twice and then dead-letter a wake-up the other
 * half of the fleet is handling correctly. Standing rule 20 — this is a notification, not a
 * mutation.
 */
export const pipelineOutboundHandler = (
  options: PipelineOutboundOptions,
): JobHandler<PipelineOutboundData> => {
  const logger: Logger = options.logger ?? silentLogger;
  return async (job) => {
    const { data } = job;
    switch (data.duty) {
      case 'intake_check':
        await runIntakeCheck(options, data);
        return;
      case 'workpad':
        await runWorkpadRender(options, data);
        return;
      case 'status':
        await runStatusTransition(options, data);
        return;
      default:
        logger.warn(
          { job_id: job.id, duty: String((data as { duty?: unknown }).duty) },
          'an outbound job named a duty this build does not know; leaving it to whoever does',
        );
    }
  };
};
