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
 * stamps its **receipt time** (`occurred_at`) on every live task of that ticket.
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
import type { EventHandler } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { PipelineStore } from './store.js';

export interface ProviderSignalOptions {
  readonly store: PipelineStore;
  readonly logger?: Logger;
}

/** The handler names are their `handler_executions` keys; renaming one re-runs it over the log. */
export const TICKET_SIGNAL_HANDLER = 'pipeline.ticket.signal';
export const MERGE_REQUEST_HEAD_HANDLER = 'pipeline.merge.request.head';

const ticketSignalHandler = (options: ProviderSignalOptions): EventHandler => ({
  name: TICKET_SIGNAL_HANDLER,
  priority: 10,
  eventTypes: ['ticket.updated'],
  handle: async (context) => {
    const event = context.event.event;
    if (event.type !== 'ticket.updated') {
      return;
    }
    const moved = await options.store.tasks.recordTicketSignal(context.scope.tx, {
      projectId: event.payload.project_id,
      provider: event.payload.ticket.provider,
      ticketKey: event.payload.ticket.key,
      at: event.occurred_at,
    });
    (options.logger ?? silentLogger).debug(
      {
        project_id: event.payload.project_id,
        ticket_key: event.payload.ticket.key,
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
