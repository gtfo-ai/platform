/**
 * **The duties a stage is owed, performed before it is planned** — WP-184 (TD-029 decisions 4 and
 * 11, BD-031 rulings 2 and 6).
 *
 * ## What was wrong
 *
 * A completion's handlers decide on two queues with nothing ordering them: the saga enqueues the
 * next stage's `stage.execute` job, and the review conversation's handler enqueues
 * `review_findings_post`, `conversation_replies` and `review_threads_resolve` on `pipeline.outbound`
 * (`review-conversation.ts`); the lifecycle handler enqueues the entry's `ticket_lifecycle` move
 * there too (`ticket-lifecycle.ts`). The planner reads the conversation **once**, at plan time
 * (`planner.ts`, `readConversation`), so after a `code_review` return the Developer's next run was
 * planned before the findings were on the merge request — measured **3.0 s** apart on the e2e clock
 * (WP-183) — and its prompt carried no `conversation` block, no `thread_id` to answer on. The
 * re-review was planned before the Developer's replies were posted, by the same mechanism; and the
 * ticket read *in review* after the review's run had started, once after the next fix run had.
 *
 * ## What the stage job does now
 *
 * {@link performOwedDuties} runs in the `stage.execute` job of an **agent** stage, between its
 * transactions and before the plan — beside the ticket snapshot, at *"the last moment that is ordered
 * with respect to the prompt"* (`jobs.ts`):
 *
 *  1. the lifecycle move the stage's **entry** owes (`performEntryLifecycleMove`): `in_progress`
 *     for a developer stage, `in_review` for `code_review`;
 *  2. the review conversation's duties for the artifacts of the task's **latest completed agent
 *     run** — the findings post and the resolutions for a `ReviewVerdict`, the replies for an
 *     `ImplementationNotes` — through the very functions the outbound duties call, with their
 *     idempotency keys.
 *
 * The outbound duties still fire: they are the durable path, and the only path for a completion
 * with no next agent stage. Whichever performer runs second finds every key recorded and replays —
 * but the executor records a key only **after** its call, so two performers that overlap would both
 * post. They therefore take turns under the task's `review_conversation` duty lease
 * (`duty-lease.ts`, migration 0091): the outbound duties take it in `outbound.ts`, this step takes it
 * here.
 *
 * ## It never fails the stage
 *
 * A provider failure is a `warn` naming the duty and the plan proceeds without that entry (rule 20,
 * WP-180 ruling (b)); the outbound duty posts it later — unless this job holds the lease through
 * all three of that duty's tries (a slow provider, about 3 minutes), which leaves it failed and the
 * post unmade: a residual, stated (WP-184 review round 2). A lease held for the whole wait is the same
 * `warn`. `TransactionOpenError` rethrows — a programming error, not a provider being down.
 *
 * **Shadow mode is skipped** (WP-184 ruling (c)): a shadow write posts nothing, so the prompt would
 * gain no thread, and each write the step made would be a second `would_have` row beside the
 * duty's. The return cause still carries the findings. A review-only task has duties of its own and
 * is skipped, as `reviewConversationHandler` skips it.
 */
import type { Id } from '@platform/contracts';
import { implementationNotesDataSchema, reviewVerdictDataSchema } from '@platform/contracts';
import { TransactionOpenError } from '../events/open-transaction.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  OUTBOUND_DUTY_LEASE_WAIT_MS,
  REVIEW_CONVERSATION_LEASE,
  TASK_DUTY_LEASE_WAIT_MS,
  TaskDutyLeaseBusyError,
  withTaskDutyLease,
} from './duty-lease.js';
import type { PipelineOutboundData } from './jobs.js';
import {
  type ConversationDutyData,
  runConversationReplies,
  runReviewFindingsPost,
  runReviewThreadsResolve,
} from './review-conversation.js';
import { REVIEW_ONLY_TEMPLATE_ID } from './review-only.js';
import type { StoredArtifact, StoredTask } from './store.js';
import type { TaskTransactionOptions } from './task-transaction.js';
import { performEntryLifecycleMove } from './ticket-lifecycle.js';

/** The stage attempt the job is about to plan. */
export interface OwedDutiesEntry {
  readonly stage: string;
  readonly attempt: number;
}

/** The step the `stage.execute` job runs before it plans an agent stage. */
export type OwedDutiesStep = (stored: StoredTask, entry: OwedDutiesEntry) => Promise<void>;

/** The three review-conversation duties, as the outbound queue names them. */
type ConversationDuty = Extract<
  PipelineOutboundData['duty'],
  'review_findings_post' | 'conversation_replies' | 'review_threads_resolve'
>;

const CONVERSATION_DUTIES: Readonly<
  Record<
    ConversationDuty,
    (options: TaskTransactionOptions, data: ConversationDutyData) => Promise<void>
  >
> = {
  review_findings_post: runReviewFindingsPost,
  conversation_replies: runConversationReplies,
  review_threads_resolve: runReviewThreadsResolve,
};

/**
 * The duties the latest completed agent run's artifacts owe, in the order the handler enqueues
 * them — `review_findings_post` before `review_threads_resolve` for a verdict, then the replies.
 * The same conditions as `reviewConversationHandler`: a verdict always owes its post, the
 * resolutions only when it names threads, the replies only when the notes carry any.
 */
const owedConversationDuties = (
  artifacts: readonly StoredArtifact[],
): readonly { readonly duty: ConversationDuty; readonly artifactId: Id }[] => {
  const latestRun = artifacts.findLast(
    (artifact) => artifact.producedByRunId !== null,
  )?.producedByRunId;
  if (latestRun === undefined || latestRun === null) {
    return [];
  }
  const owed: { duty: ConversationDuty; artifactId: Id }[] = [];
  for (const artifact of artifacts.filter((each) => each.producedByRunId === latestRun)) {
    if (artifact.type === 'ReviewVerdict') {
      owed.push({ duty: 'review_findings_post', artifactId: artifact.id });
      const parsed = reviewVerdictDataSchema.safeParse(artifact.data);
      if (parsed.success && (parsed.data.resolved_threads ?? []).length > 0) {
        owed.push({ duty: 'review_threads_resolve', artifactId: artifact.id });
      }
    } else if (artifact.type === 'ImplementationNotes') {
      const parsed = implementationNotesDataSchema.safeParse(artifact.data);
      if (parsed.success && (parsed.data.thread_replies ?? []).length > 0) {
        owed.push({ duty: 'conversation_replies', artifactId: artifact.id });
      }
    }
  }
  return owed;
};

/**
 * Performs what the stage being entered is owed — see the module docblock. Never throws for a
 * provider or a busy lease; rethrows `TransactionOpenError`.
 */
export const performOwedDuties = async (
  options: TaskTransactionOptions,
  stored: StoredTask,
  entry: OwedDutiesEntry,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const { task } = stored;
  if (task.mode === 'shadow' || task.template === REVIEW_ONLY_TEMPLATE_ID) {
    return;
  }
  const taskId = task.id;
  try {
    await withTaskDutyLease(
      options,
      { taskId, lease: REVIEW_CONVERSATION_LEASE, waitMs: TASK_DUTY_LEASE_WAIT_MS },
      async () => {
        await performEntryLifecycleMove(options, stored, entry);
        if (stored.mr === null) {
          return;
        }
        const artifacts = await options.unitOfWork.transaction(async (scope) =>
          options.store.artifacts.listFor(scope.tx, taskId),
        );
        for (const owed of owedConversationDuties(artifacts)) {
          const data: ConversationDutyData = {
            duty: owed.duty,
            task_id: taskId,
            // No `cause_event_id`: no event caused this turn — the stage job did — and the duties
            // read only the three fields `ConversationDutyData` names.
            artifact_id: owed.artifactId,
          };
          try {
            await CONVERSATION_DUTIES[owed.duty](options, data);
          } catch (error) {
            if (error instanceof TransactionOpenError) {
              throw error;
            }
            logger.warn(
              { task_id: taskId, stage: entry.stage, duty: owed.duty, err: error },
              'an owed review-conversation duty failed before the plan; the run is planned without it, and the outbound duty posts it later',
            );
          }
        }
      },
    );
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    logger.warn(
      {
        task_id: taskId,
        stage: entry.stage,
        err: error,
        ...(error instanceof TaskDutyLeaseBusyError ? { lease: error.lease } : {}),
      },
      'the duties owed before the plan were not performed; the run is planned without them, and the outbound duties perform them',
    );
  }
};

/**
 * An outbound duty of the group, performed under the task's lease (WP-184): it waits briefly
 * ({@link OUTBOUND_DUTY_LEASE_WAIT_MS}) for the stage job's turn — or another process's — and then
 * replays what that turn recorded. A lease still held after the wait throws
 * {@link TaskDutyLeaseBusyError}, and pg-boss's retry is the next turn: the one outbound worker is
 * never held for longer than the short wait.
 */
export const underReviewConversationLease = async (
  options: TaskTransactionOptions,
  data: PipelineOutboundData,
  work: () => Promise<void>,
): Promise<void> => {
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return work();
  }
  await withTaskDutyLease(
    options,
    { taskId, lease: REVIEW_CONVERSATION_LEASE, waitMs: OUTBOUND_DUTY_LEASE_WAIT_MS },
    work,
  );
};
