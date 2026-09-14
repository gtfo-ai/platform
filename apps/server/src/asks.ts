/**
 * Ask-the-task, composed for the API half — the command port and the two reads (WP-31).
 *
 * The **one projection** rule of the plan row's criterion 10 is what this file is: `AskStore` is
 * built once here and both the write path (`askTaskCommand`) and the read path
 * (`GET …/asks`, `GET …/audit`) go through it, so the rows an ask's prompt is built from and the
 * rows the task page renders cannot come apart.
 *
 * The reads open a short transaction, which is what `AskStore`'s transaction-bound port costs and
 * is deliberately not worked around: the alternative is a second, non-transactional adapter over
 * the same two queries, which is exactly the second projection this row exists to avoid.
 */

import type { Jobs, Logger } from '@platform/application';
import { askTaskCommand } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { ask as askAdapters, redaction as redactionAdapters } from '@platform/infrastructure';
import type { AskCommandPort, AskQueries } from './routes/asks.js';
import { toWireAsk } from './routes/asks.js';

export interface AskCompositionOptions {
  readonly eventing: {
    readonly unitOfWork: Parameters<typeof askTaskCommand>[0]['unitOfWork'];
    readonly ids: { next(): Id };
    readonly clock: { now(): IsoDateTime };
  };
  /** `null` on a process with no queue: the question would be recorded and never answered. */
  readonly jobs: Jobs | null;
  readonly logger: Logger;
}

export interface AskComposition {
  readonly commands: AskCommandPort | null;
  readonly queries: Pick<AskQueries, 'listAsks' | 'taskAudit'>;
}

export const composeAsks = (options: AskCompositionOptions): AskComposition => {
  const store = askAdapters.createPostgresAskStore();
  const { unitOfWork, ids, clock } = options.eventing;
  const redactor = redactionAdapters.patternRedactor();

  return {
    /**
     * `null` without a queue, for the reason every other command that needs one is.
     *
     * A recorded question with no wake-up is worse than a refusal: the thread shows a `pending` row
     * for ever and nobody is told that this process cannot answer it. The route turns the `null`
     * into a `503` naming the deployment (`routes/asks.ts`).
     */
    commands:
      options.jobs === null
        ? null
        : {
            ask: async (input) =>
              askTaskCommand(
                {
                  unitOfWork,
                  jobs: options.jobs as Jobs,
                  asks: store,
                  redactor,
                  logger: options.logger,
                },
                {
                  id: ids.next(),
                  taskId: input.taskId as Id,
                  projectId: input.projectId as Id,
                  source: 'ui',
                  askedByUserId: input.userId as Id,
                  // A `ui` ask has no provider account behind it: the session *is* the identity.
                  askedByIdentity: null,
                  ticketCommentId: null,
                  question: input.question,
                  createdAt: clock.now(),
                },
              ),
          },
    queries: {
      listAsks: async (taskId, limit) =>
        (
          await unitOfWork.transaction(async (scope) =>
            store.listForTask(scope.tx, taskId as Id, limit),
          )
        ).map(toWireAsk),
      taskAudit: async (taskId, limit) =>
        (
          await unitOfWork.transaction(async (scope) =>
            store.auditForTask(scope.tx, taskId as Id, limit),
          )
        ).map((entry) => ({
          id: entry.id,
          action: entry.action,
          user_id: entry.userId,
          params: entry.params,
          created_at: entry.createdAt,
        })),
    },
  };
};
