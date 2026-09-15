/**
 * The epic split's API half, composed — the decision and the read (WP-40).
 *
 * One store, both paths, for the reason `composeAsks` states: the rows a PM decides on and the rows
 * the task page renders cannot come apart if they come from the same projection.
 *
 * **No queue is needed and that is the point.** `decideBreakdown` moves rows and appends
 * `task.breakdown.decided`; the *handler* for that event — which runs on a worker — is what enqueues
 * the `pipeline.outbound` duty that files the tickets. So this composes on every process that serves
 * the API, and a deployment whose API and workers are separate containers accepts a breakdown on one
 * and files the tickets from the other, through the outbox rather than through a shared queue handle.
 */

import type { Logger } from '@platform/application';
import { decideBreakdown } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
} from '@platform/infrastructure';
import type { BreakdownCommandPort, BreakdownQueries } from './routes/breakdown.js';
import { toWireBreakdownItem } from './routes/breakdown.js';

export interface BreakdownCompositionOptions {
  readonly eventing: {
    readonly unitOfWork: Parameters<typeof decideBreakdown>[0]['unitOfWork'];
    readonly ids: { next(): Id };
    readonly clock: { now(): IsoDateTime };
  };
  readonly logger: Logger;
}

export interface BreakdownComposition {
  readonly commands: BreakdownCommandPort;
  readonly queries: Pick<BreakdownQueries, 'listBreakdown'>;
}

export const composeBreakdown = (options: BreakdownCompositionOptions): BreakdownComposition => {
  const store = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const { unitOfWork, ids, clock } = options.eventing;
  const deps = {
    store,
    unitOfWork,
    ids,
    clock,
    /**
     * TD-012 step 2 over the decision's `reason`, which is a human's free text stored on every row
     * the decision moves and published by `GET /api/tasks/:task_id/breakdown`.
     *
     * Built here rather than accepted from the caller, exactly as `composeAsks` builds its own: the
     * platform's pattern rules are the whole of what this path can apply (there is no binding in
     * sight), and a redactor a caller could omit is one no caller passes (standing rule 31).
     */
    redactor: redactionAdapters.patternRedactor(),
    logger: options.logger,
  };

  return {
    commands: {
      decide: async (input) =>
        decideBreakdown(deps, {
          taskId: input.taskId as Id,
          itemIds: input.itemIds as readonly Id[],
          decision: input.decision,
          userId: input.userId as Id,
          reason: input.reason,
        }),
    },
    queries: {
      listBreakdown: async (taskId) =>
        (
          await unitOfWork.transaction(async (scope) =>
            store.breakdown.listForTask(scope.tx, taskId as Id),
          )
        ).map((item) =>
          toWireBreakdownItem({ ...item, acceptanceCriteria: [...item.acceptanceCriteria] }),
        ),
    },
  };
};
