/**
 * Two provider signals the pipeline writes down and decides nothing on (WP-60).
 *
 * Both handlers are **records, not steps**: neither moves a task, emits an event or enqueues a job.
 * Each leaves one fact on the task row, through a narrow repository method, for a reader that runs
 * later and in another process — which is why neither needs the saga's load → interpret → apply
 * shape, and why both live here rather than in `saga.ts`.
 *
 * ## `ticket.updated` → `tasks.ticket_signal_at` (Q61 (b), PROGRESS backlog 59)
 *
 * Q61 (b) asked for the ticket snapshot to be re-read at stage start *"when it is older than the
 * task's last provider signal"*, and that quantity did not exist: nothing told the platform a ticket
 * changed. Now the task-management normaliser emits `ticket.updated` on every edit, and this handler
 * stamps its **receipt time** (`occurred_at`) on every live task of that ticket — found by the
 * ticket's stable id first, and by its key only for a task that recorded no id (WP-145, backlog
 * 437), so an edit made after a Jira issue moved to another project reaches the task created under
 * its old key, and the task follows the move ({@link followMovedTicket}).
 * `ensureTicketSnapshot` (`ticket-snapshot.ts`) compares it with `ticket_snapshot_at` — two
 * platform instants from two processes' clocks (`isTicketSnapshotStale` states the skew bound) —
 * and re-reads when the snapshot is older.
 *
 * Why the receipt time and not the provider's `updated_at`: the snapshot's own time is the
 * platform's, and comparing a Jira clock with a platform clock would make the rule depend on two
 * machines agreeing. The residual is in the safe direction — an edit whose delivery arrives while
 * the snapshot is being read is dated after the read's start and triggers one more read.
 *
 * **What this does not build** (WP-60 criterion 7): the linter's *re-lint on edit* and product/18's
 * *"tickets improved after lint"* metric are the event's other two consumers, and neither is here.
 * The re-lint waits on a measurement nobody has taken — how often a real Jira sends an update for a
 * ticket in flight (`docs/TODO.md`) — because a re-lint with no debounce posts on every touch; the
 * metric is a statistics fold the event now makes possible, recorded as discovered work.
 *
 * ## `mr.updated` → `tasks.mr_ref.head_sha` (PROGRESS backlog 182)
 *
 * The recorded revision moved only when a pushing stage reported `ImplementationNotes`, so a human's
 * push to the agent branch — including the product's own take-over — was invisible to every
 * identity keyed on it: the conflict warning's idempotency key, the diff coalescer's key and
 * `tasks.dependencies.head_sha`. `mr.updated` carries the new head, and this handler moves the task's
 * recorded one through `saveMergeRequestHead`, which bumps the version (the column is `save`'s, and
 * rule 79 is why a sharing writer must). The first two keys follow at the next gate entry; the
 * dependency record does **not** move — it names the revision the dependency gate inspected, and
 * only a Developer completion runs that gate again, so after a human push it honestly describes an
 * older revision rather than claiming the new one was inspected.
 *
 * **Forward only** (review round 1, measured by the reviewer: `mr.updated(c…)` then `mr.updated(b…)`
 * left the head at `b…`). The recorded head was what the **CI gate** asked the pipeline status of
 * until round 2 (now it asks the provider's live head, below), and it is what the diff coalescer
 * keys on and what the risk routing's key names, so a late delivery moving it back replays or
 * re-reads against a commit that is no longer the head.
 * GitLab documents no delivery order, so the event carries the provider's `updated_at` and the store
 * moves the head only for a strictly later instant (`tasks.mr_head_at`); an update with no instant
 * moves nothing.
 *
 * `mr.updated` also fires for the platform's **own** pushes, and that is harmless: the stage that
 * pushed records the same sha, and the delivery then only advances the instant. The residual that
 * remains is **one window**: a head a pushing stage recorded through `save` carries no provider
 * instant, so a delivery for an older push that is stamped later than the last *announced* head
 * and arrives before the stage's own push is announced can still move the head back — until that
 * announcement, which carries a later instant, moves it forward again. **What bounds it** (review
 * round 2): the CI gate does not read this record — it asks the provider for the live head on its
 * poll (`gates.ts`) and in `ci_settle` — so the window can cost a replayed conflict warning or one
 * more diff read, never a gate passed on an older commit.
 */
import type { DomainEvent, Id, TicketRef } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { InvariantViolationError, taskBranchName } from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { PipelineStore, StoredTask } from './store.js';
import { PIPELINE_ACTOR } from './store.js';

export interface ProviderSignalOptions {
  readonly store: PipelineStore;
  /** The id of a `task.ticket.rekeyed` this handler appends (WP-145). */
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

/** The handler names are their `handler_executions` keys; renaming one re-runs it over the log. */
export const TICKET_SIGNAL_HANDLER = 'pipeline.ticket.signal';
export const MERGE_REQUEST_HEAD_HANDLER = 'pipeline.merge.request.head';

/**
 * The branch a moved ticket's task keeps (WP-145 ruling (b)): `agentic/<old key>`, pinned only on a
 * `normal` task that has none yet — a review-only, shadow or bootstrap task never pushes one — and
 * `null` for a key with no character a branch may carry, which leaves the task on the default branch
 * as `taskBranchName`'s refusal always has.
 */
const branchToPin = (stored: StoredTask): string | null => {
  if (stored.branch !== null || stored.task.mode !== 'normal') {
    return null;
  }
  try {
    return taskBranchName(stored.task.ticket.key);
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      return null;
    }
    throw error;
  }
};

/**
 * A `ticket.updated` under the task's own issue id and **another key** is the issue's move to
 * another project (WP-145, PROGRESS backlog 437; WP-134 measured that Jira keeps the `id`). Each live
 * task of that id still under an older key is moved to the new key and URL by the narrow writer
 * `rekeyTicket`, and the move is recorded as `task.ticket.rekeyed` on the task's stream with the
 * pipeline's system actor — so the board, the workpad's ticket and the next snapshot read name the
 * issue as it is now, and the audit says when and from what.
 *
 * The append follows the writer, in this handler's transaction: the writer bumps the version and so
 * holds the row, the re-load reads the stream's next sequence under that lock (the order
 * `conflict-warning.ts` states), and a stage transaction that loaded before it is refused at its
 * `save` and retried by its owner. **Kept as they were, and stated**: the branch (`agentic/<old
 * key>`, pinned here when the task has none yet) and the merge request's title — nothing renames a
 * pushed branch or retitles a merge request. A task another task of the project already holds the
 * new key for is **not** moved (the unique key; logged): its signal still reaches it by id.
 */
const followMovedTicket = async (
  options: ProviderSignalOptions,
  context: HandlerContext,
  projectId: Id,
  ticket: TicketRef & { readonly id: string },
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  const tasks = await options.store.tasks.listLiveByTicketId(context.scope.tx, {
    projectId,
    provider: ticket.provider,
    ticketId: ticket.id,
  });
  for (const stored of tasks) {
    const from = stored.task.ticket;
    if (from.key === ticket.key && from.url === ticket.url) {
      continue;
    }
    const moved = await options.store.tasks.rekeyTicket(context.scope.tx, stored.task.id, {
      fromKey: from.key,
      ticketKey: ticket.key,
      ticketUrl: ticket.url,
      pinBranch: branchToPin(stored),
    });
    if (!moved) {
      logger.warn(
        {
          task_id: stored.task.id,
          from_key: from.key,
          ticket_key: ticket.key,
          ticket_id: ticket.id,
        },
        'a moved ticket’s task kept its old key: another task of the project holds the new one, or the task moved on',
      );
      continue;
    }
    const current = await options.store.tasks.load(context.scope.tx, stored.task.id);
    if (current === null) {
      continue;
    }
    const recorded = domainEventSchemasByType['task.ticket.rekeyed'].parse({
      id: options.ids.next(),
      stream_type: 'task',
      stream_id: stored.task.id,
      stream_seq: current.task.sequence,
      correlation_id: context.event.event.correlation_id ?? null,
      cause_event_id: context.event.event.id,
      actor: PIPELINE_ACTOR,
      occurred_at: options.clock.now(),
      type: 'task.ticket.rekeyed',
      payload: {
        project_id: projectId,
        task_id: stored.task.id,
        ticket: { ...current.task.ticket },
        from_key: from.key,
        from_url: from.url,
      },
    }) as DomainEvent;
    await context.emit([recorded]);
    logger.info(
      { task_id: stored.task.id, from_key: from.key, ticket_key: ticket.key, ticket_id: ticket.id },
      'the task’s ticket moved to a new key; the task follows it, and its branch and merge request keep the old key',
    );
  }
};

const ticketSignalHandler = (options: ProviderSignalOptions): EventHandler => ({
  name: TICKET_SIGNAL_HANDLER,
  priority: 10,
  eventTypes: ['ticket.updated'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'ticket.updated') {
      return;
    }
    const ticketId = event.payload.ticket.id ?? null;
    if (ticketId !== null) {
      await followMovedTicket(options, context, event.payload.project_id, {
        ...event.payload.ticket,
        id: ticketId,
      });
    }
    const moved = await options.store.tasks.recordTicketSignal(context.scope.tx, {
      projectId: event.payload.project_id,
      provider: event.payload.ticket.provider,
      ticketKey: event.payload.ticket.key,
      ticketId,
      at: event.occurred_at,
    });
    (options.logger ?? silentLogger).debug(
      {
        project_id: event.payload.project_id,
        ticket_key: event.payload.ticket.key,
        ticket_id: ticketId,
        tasks: moved,
      },
      moved === 0
        ? 'ticket.updated reached no live task; nothing to mark stale'
        : 'ticket.updated marked the live tasks’ ticket snapshots stale',
    );
  },
});

const mergeRequestHeadHandler = (options: ProviderSignalOptions): EventHandler => ({
  name: MERGE_REQUEST_HEAD_HANDLER,
  priority: 10,
  eventTypes: ['mr.updated'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'mr.updated') {
      return;
    }
    const stored = await options.store.tasks.findByMergeRequest(context.scope.tx, {
      projectId: event.payload.project_id,
      iid: event.payload.mr.iid,
    });
    if (stored === null || stored.mr === null) {
      return;
    }
    const at = event.payload.updated_at ?? null;
    if (at === null) {
      // No provider instant, no order: moving on it could move the head back (review round 1).
      (options.logger ?? silentLogger).warn(
        { task_id: stored.task.id, iid: event.payload.mr.iid },
        'mr.updated carried no provider instant, so it cannot be ordered; the recorded head is left as it is',
      );
      return;
    }
    // Called for the recorded sha too: the store then advances only the instant, so a stale
    // delivery arriving after this one is refused (`saveMergeRequestHead`'s docblock).
    const moved = await options.store.tasks.saveMergeRequestHead(context.scope.tx, stored.task.id, {
      iid: event.payload.mr.iid,
      headSha: event.payload.head_sha,
      at,
    });
    if (moved) {
      (options.logger ?? silentLogger).info(
        {
          task_id: stored.task.id,
          iid: event.payload.mr.iid,
          from: stored.mr.head_sha ?? null,
          to: event.payload.head_sha,
        },
        'the merge request moved to a revision the platform did not push; the recorded head follows it',
      );
    }
  },
});

export const providerSignalHandlers = (options: ProviderSignalOptions): readonly EventHandler[] => [
  ticketSignalHandler(options),
  mergeRequestHeadHandler(options),
];
