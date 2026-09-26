/**
 * product/04 S6b's *"The board warns when two active tasks touch the same files"*, and BD-030's
 * *"conflict warnings between concurrent tasks"* — WP-26.
 *
 * A handler that decides and a `pipeline.outbound` duty that calls, which is the shape WP-15d
 * requires of anything that reaches a provider.
 *
 * ## Where the overlap is computed, and what it costs
 *
 * From the **merge requests' changed paths through the git provider** —
 * `GitProviderPort.getMergeRequestDiff`, which WP-24 put on the port — and not from any knowledge of
 * the branches the platform keeps: it keeps none. `tasks.mr_ref` records an iid, a branch and a head
 * sha and no file list, so the alternative would be a column somebody has to keep in step with a
 * provider, which is a second copy of the provider's answer (standing rule 9's shape).
 *
 * The cost is stated rather than discovered. The duty asks for **one read per peer task**, bounded
 * by {@link MAX_CONFLICT_PEERS}, and each read returns the peer's *patches* as well as its paths
 * because that is the shape the port has — the platform then throws the patches away. Since WP-59
 * the reads are **coalesced per `(merge request, head sha)`** (`diff-coalescer.ts`, PROGRESS
 * backlog 64): this task's own diff is the one the risk routing reads at the same gate entry, and a
 * peer's is the one every other task at the gate compares against, so a burst of gate entries after
 * a default-branch move reads each merge request once rather than once per task that compares
 * against it. A paths-only port method would still be the honest read: `…/diffs` has no field
 * selector, and GitLab's GraphQL `MergeRequest.diffStats` answers paths without patches (read at
 * WP-59, `test/fixtures/http/gitlab/SOURCES.md`) — filed as discovered work under WP-59 rather than
 * built here.
 *
 * ## When it is computed
 *
 * On `task.stage.entered` for the rebase gate, which is *both* of product/04 S6b's moments in one:
 * the gate is entered before Ready, and it is entered again on every `default_branch.moved` that
 * finds the task waiting (`ready_for_merge`'s `on` list). technical/02 attributes the conflict
 * warning to `default_branch.moved` directly at priority 20; one handler on the gate's entry reaches
 * it through the same path and also covers the before-Ready case, which a handler on the event alone
 * would miss — the amendment is on that page.
 *
 * **It warns both sides of the pair** (WP-59, PROGRESS backlog 65). The comparison still runs only
 * at a gate entry — recomputing on every `mr.opened` and `mr.updated` of every project would be a
 * provider read per peer per push — but once it has found an overlap it has everything the other
 * side needs: both diffs are read, and the peer's `mr_ref.head_sha` is loaded. So the gate that runs
 * appends `task.conflict.warned` on **both** streams and posts a thread on **both** merge requests,
 * the peer's under the peer's own idempotency key — the key the peer's gate would compute for the
 * same pair — so whichever gate runs first posts both and the other replays both. Until WP-59 the
 * task whose gate ran first was told nothing, which was the developer about to push the conflicting
 * change, and the board badge sat on one card of the pair.
 *
 * **Threads are one per merge request; events are not one per task.** The thread is idempotent on
 * the revision pair, the event is not: every gate entry that finds the overlap appends on both
 * streams, so when A's gate and later B's gate both compare the pair at the same revisions each task
 * gets **two** `task.conflict.warned` — and a re-entry after a default-branch move adds two more.
 * The board reads the latest one per task, so it is unaffected; `concurrent_task_overlaps` counts
 * them all and its definition says so.
 *
 * ## What "surfaced" is on this build
 *
 * Three things. **A thread on each merge request of the pair**, un-anchored, through the
 * `createDiscussion` WP-24 widened — so no port method is added and the warning reaches the humans
 * and the agents who are already looking at either merge request. **`task.conflict.warned` on each
 * task's stream**, which is product/16's *"concurrent-task overlaps"*. And the **board badge**,
 * which WP-41 built as a projection over the latest such event per task (`conflictsFor` in
 * `apps/server/src/queries/pipeline-queries.ts`) — the paragraph that stood here said the badge did
 * not exist, which stopped being true at WP-41 (rule 83).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import type { PathOverlap } from '@platform/domain';
import { buildEvent, MAX_OVERLAP_PATH_CHARS, pathOverlap } from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { FileDiff, MergeRequestRefInput } from '../ports/integrations/git-provider.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { coalescedMergeRequestDiff } from './diff-coalescer.js';
import { integrationsForProject, noRunScopedSecrets, reviewWrites } from './integrations.js';
import { enqueueOutbound, type PipelineOutboundData } from './jobs.js';
import { REBASE_GATE_STAGE, type RebaseJobOptions } from './rebase.js';
import type { PipelineSagaOptions } from './saga.js';
import { PIPELINE_ACTOR, type StoredTask } from './store.js';

/**
 * How many other tasks one gate entry compares against.
 *
 * Ten, and it is a **provider-read budget** rather than a product number: the duty makes one
 * `get_merge_request_diff` per peer, so this is the fan-out of one gate entry. BD-010's shipped WIP
 * limit is smaller than this on every project the platform ships defaults for, so in practice the
 * bound is the project's own concurrency; it exists for the project that raised it.
 */
export const MAX_CONFLICT_PEERS = 10;

/**
 * How many files of one merge request are compared.
 *
 * A hundred, which is two and a half times the forty a review-only prompt carries
 * (`MAX_MR_FILES`), because nothing here goes in a prompt: the patches are discarded and only the
 * paths are kept. A merge request larger than this is compared on its first hundred files and the
 * result carries `truncated`, so "no overlap" is never mistaken for "nothing to find".
 */
export const MAX_CONFLICT_FILES = 100;

/**
 * The idempotency key of one warning.
 *
 * **No part of it is model output or provider prose** (WP-24 round 2's rule): two platform ids and
 * the head sha of the merge request the warning is posted on. The sha is provider metadata and it
 * is what makes the identity *(this task, this revision, that task)* — so a second gate entry on an
 * unchanged revision replays rather than posting the same warning twice, and a revision that moved
 * is a new warning, which is right: the files may no longer overlap.
 */
export const conflictWarningIdempotencyKey = (
  taskId: Id,
  headSha: string,
  otherTaskId: Id,
): string => `conflict_warning:${taskId}:${headSha}:${otherTaskId}`;

/** The marker the warning carries, so a reader can tell the platform's thread from a human's. */
export const conflictWarningMarker = (taskId: Id): string =>
  `<!-- agentic:conflict-warning:${taskId} -->`;

/**
 * What the warning says.
 *
 * Pure, so the same pair renders the same bytes — an idempotent call that posted a different body
 * each time would churn the merge request — and so the untrusted half is visible: `ticketKey` and
 * every path are **provider text**, and they are the only interpolations. They are bounded here and
 * redacted at `reviewWrites.thread`, which is the call that sends them (TD-012, BD-022).
 */
export const renderConflictWarning = (input: {
  readonly taskId: Id;
  readonly ticketKey: string;
  readonly overlap: PathOverlap;
}): string => {
  const paths = input.overlap.paths.map((path) => `- \`${path}\``);
  const key = input.ticketKey.slice(0, MAX_OVERLAP_PATH_CHARS);
  const more =
    input.overlap.count > input.overlap.paths.length
      ? [`…and ${input.overlap.count - input.overlap.paths.length} more.`]
      : [];
  const truncated = input.overlap.truncated
    ? [
        '',
        `The comparison read at most ${MAX_CONFLICT_FILES} files per merge request, so there may be more.`,
      ]
    : [];
  return [
    conflictWarningMarker(input.taskId),
    `**This branch touches the same files as ${key}.**`,
    '',
    ...paths,
    ...more,
    '',
    'Whichever merge request is merged second will have to resolve the overlap. Nothing is blocked by this note.',
    ...truncated,
  ].join('\n');
};

/**
 * `task.stage.entered` at the rebase gate → decide to warn, and let the job call.
 *
 * Priority **120**, the integrations band: it tells the outside world about a transition the core
 * band has already decided, exactly like the workpad. It enqueues and reads nothing else — the duty
 * re-derives everything, because a job is a wake-up and not a message (TD-004).
 */
export const conflictWarningHandler = (options: PipelineSagaOptions): EventHandler => ({
  name: 'pipeline.conflict.warning',
  priority: 120,
  eventTypes: ['task.stage.entered'],
  handle: async (context: HandlerContext) => {
    const event = context.event.event;
    if (event.type !== 'task.stage.entered' || event.payload.stage !== REBASE_GATE_STAGE) {
      return;
    }
    const data: PipelineOutboundData = {
      duty: 'conflict_warn',
      project_id: event.payload.project_id,
      task_id: event.payload.task_id,
      cause_event_id: event.id,
    };
    context.afterCommit(async () => {
      await enqueueOutbound(options.jobs, data);
    });
  },
});

/**
 * The changed paths of one merge request, redacted, or `null` when the project has no git binding.
 *
 * **Redacted here, before anything compares or stores them.** A repository path is untrusted
 * provider text (BD-022) and it reaches two sinks — a merge-request thread and an `events` row —
 * and only the first of those redacts on the way out (`reviewWrites.thread`). So the binding's
 * redactor is applied at the read, in full, *before* `pathOverlap` applies its length cap: an
 * exact-match redactor cannot find a secret a cap has already halved (the rule `ticket-snapshot.ts`
 * states at its own `clean`). The residual is rule 70's, in its harmless direction: redaction is
 * many-to-one, so two different paths that differ only inside a redacted value compare equal and
 * are reported as an overlap. This is a warning nothing branches on, and over-warning is the safe
 * side of it.
 */
const changedPathsOf = async (
  diffOf: (ref: MergeRequestRefInput) => Promise<readonly FileDiff[] | null>,
  redact: (path: string) => string,
  stored: StoredTask,
): Promise<{
  readonly newPaths: readonly string[];
  readonly oldPaths: readonly string[];
  readonly truncated: boolean;
} | null> => {
  if (stored.mr === null) {
    return null;
  }
  const files = await diffOf(stored.mr);
  if (files === null) {
    return null;
  }
  return {
    newPaths: files.map((file) => redact(file.new_path)),
    oldPaths: files.map((file) => redact(file.old_path)),
    // The provider was asked for `MAX_CONFLICT_FILES` and answered with exactly that many, which is
    // how `getMergeRequestDiff` says "there may be more" — the count it would have returned is not
    // part of the answer, by the port's own decision.
    truncated: files.length >= MAX_CONFLICT_FILES,
  };
};

/**
 * `pipeline.outbound` duty **conflict_warn**: compare this task's merge request with its peers'
 * and post one thread per overlap.
 *
 * **What it re-validates on fire, and what it deliberately does not.** It re-reads the task and
 * gives up when the task is gone, terminal, or has no merge request — a warning about a cancelled
 * task is noise. It does **not** require the task to still be sitting at the rebase gate: the gate
 * is evaluated by a `stage.execute` job that routinely settles before this one runs, so that
 * condition would be a warning that almost never fires (TD-004 says re-validate, not re-require the
 * instant).
 *
 * The write is `reviewWrites.thread` — WP-24's un-anchored `createDiscussion`, which needs no new
 * port method — through `IntegrationActionExecutor` like every other outbound call, with a
 * platform-owned idempotency key and the git binding's redactor over the body.
 */
export const runConflictWarning = async (
  options: RebaseJobOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const taskId = data.task_id as Id | undefined;
  if (taskId === undefined) {
    return;
  }
  const loaded = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, taskId);
    if (
      stored === null ||
      stored.mr === null ||
      stored.task.state === 'done' ||
      stored.task.state === 'cancelled'
    ) {
      return null;
    }
    const peers = await options.store.tasks.listWithMergeRequest(scope.tx, stored.task.projectId, {
      excludeTaskId: stored.task.id,
      limit: MAX_CONFLICT_PEERS,
    });
    return { stored, peers };
  });
  if (loaded === null || loaded.peers.length === 0) {
    return;
  }
  const { stored, peers } = loaded;
  const mr = stored.mr;
  /**
   * **No revision, no warning** (standing rule 20's direction for a *write*).
   *
   * `MergeRequestRef.head_sha` is nullish — a merge request the platform learned about before the
   * provider reported a head commit has none — and the head sha is what makes
   * {@link conflictWarningIdempotencyKey} an identity. Keying on the pair alone would post one
   * warning for the whole life of the merge request however many times its files changed; keying on
   * a placeholder would do the same under a name that reads like a revision. So the warning is
   * skipped and said out loud, which costs a notification and nothing else.
   */
  if (mr === null || mr.head_sha === null || mr.head_sha === undefined) {
    if (mr !== null) {
      logger.info(
        { task_id: stored.task.id, iid: mr.iid },
        'rebase gate: no head commit on the merge request, so no conflict warning was posted',
      );
    }
    return;
  }
  const headSha = mr.head_sha;

  // Outside every transaction (WP-15d), and outside a run, so the call's scope holds no minted
  // credential (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    stored.task.projectId,
    noRunScopedSecrets(),
  );
  const writes = reviewWrites(integrations);
  const redactor = integrations.git?.redactor ?? null;
  const redact = (path: string): string =>
    redactor === null ? path : redactor.redactText(path).value;
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };
  // WP-59, backlog 64: one provider read per `(merge request, head sha)` — this task's own diff is
  // the one the risk routing reads at the same gate entry, and each peer's is the one every other
  // task at the gate reads. `diff-coalescer.ts` has the window and the residuals.
  const diffOf = (ref: MergeRequestRefInput) =>
    coalescedMergeRequestDiff(
      { port: options.integrations, integrations, now: options.clock.now() },
      ref,
      MAX_CONFLICT_FILES,
      context,
    );

  const mine = await changedPathsOf(diffOf, redact, stored);
  if (mine === null) {
    return;
  }

  const warned: {
    readonly other: StoredTask;
    /** The overlap as this task sees it, and as the peer does — the same paths, each side's order. */
    readonly overlap: PathOverlap;
    readonly theirs: PathOverlap;
  }[] = [];
  for (const peer of peers) {
    const theirs = await changedPathsOf(diffOf, redact, peer);
    if (theirs === null) {
      continue;
    }
    const overlap = pathOverlap(mine, theirs);
    if (overlap.count === 0) {
      continue;
    }
    await writes.thread(
      {
        ref: mr,
        path: null,
        line: null,
        markdown: renderConflictWarning({
          taskId: stored.task.id,
          // Redacted before the renderer's cap, the order `paths` and `other_ticket_key` already use.
          ticketKey: redact(peer.task.ticket.key),
          overlap,
        }),
        idempotencyKey: conflictWarningIdempotencyKey(stored.task.id, headSha, peer.task.id),
      },
      { ...context, mode: stored.task.mode },
    );
    const peerOverlap = pathOverlap(theirs, mine);
    await warnPeer(writes, redact, { stored, peer, overlap: peerOverlap, logger });
    warned.push({ other: peer, overlap, theirs: peerOverlap });
  }

  if (warned.length === 0) {
    return;
  }
  await options.unitOfWork.transaction(async (scope) => {
    // Every stream this transaction appends to has its `version` bumped **before** any of them is
    // loaded (WP-59 review rounds 1 and 2, `TaskRepository.bumpVersion`): the bump takes the row
    // lock, so a task transaction that has already saved is waited out and the load after it reads
    // the committed sequence; and a task transaction that loaded before this one commits meets
    // `TaskConcurrentModificationError` at its `save` and is retried by its owner, where the stream
    // trigger's `StreamConflictError` is retried by nobody. **In sorted id order**, all of them, own
    // and peers alike: a default-branch move re-enters every gate at once, and A's warning bumping A
    // then B while B's bumps B then A is a PostgreSQL deadlock (`40P01`); one global order makes the
    // second transaction wait instead. A task that is gone throws here and the job retries.
    const streams = [...new Set([taskId, ...warned.map((entry) => entry.other.task.id)])].sort();
    for (const id of streams) {
      await options.store.tasks.bumpVersion(scope.tx, id);
    }
    // Re-loaded for `task.sequence`, which is the stream's next seq and is read where the append
    // happens (`recordRebaseCheck` says why).
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null) {
      return;
    }
    const events: DomainEvent[] = [];
    let seq = current.task.sequence;
    for (const entry of warned) {
      events.push(
        warnedEvent(options, data, {
          on: current,
          seq,
          mr,
          other: entry.other,
          overlap: entry.overlap,
          redact,
        }),
      );
      seq += 1;
    }
    /**
     * **The peer's half** (WP-59, PROGRESS backlog 65): the same overlap, appended on the **other**
     * task's stream at no extra provider read — both diffs were read above — so the pair is told as
     * a pair and the board's badge is on both cards. It lands on a **live** stream — any task with
     * an open merge request, mid-stage included — which is the case WP-26's divergence 7 was about.
     * So the peer gets the same treatment as this task above: its `version` bumped (above, in the
     * sorted pass), then re-loaded here, in the transaction that appends, so its `sequence` is the
     * stream's next one. The peer's own writer that loaded before this commits is the one that
     * loses, and it loses at its `save`, as a retried `TaskConcurrentModificationError` — **not** at
     * its append, where the trigger's `StreamConflictError` would fail its transaction with nothing
     * to retry it (review round 1 found this docblock claiming that retry; it did not exist).
     *
     * **A writer that appends without a `save` is the one shape the token cannot reach**, and it is
     * handled per writer rather than claimed in general (review round 2 measured the general claim
     * wrong): `recordRebaseCheck` bumps the same token before its own load, so it takes the row lock
     * and serialises with this append instead of racing it — without that, its `StreamConflictError`
     * surfaced after the gate had settled, the job's retry found the task past the gate, and the
     * `task.rebase.checked` measurement was lost for good. Any other out-of-band appender that does
     * neither would meet `StreamConflictError` and depend on its own job's retry. This build's others
     * — review-only, the ticket linter, the epic split and the shadow report — append on tasks that
     * carry no merge request, so no pair warning reaches their streams: review-only and the linter
     * write `mr: null` at creation and a shadow task never opens one (read off the tree, not
     * measured; the epic split's claim rests on its templates producing no `ImplementationNotes`,
     * also read). A new appender on a task with a merge request owes itself the same bump. A peer that
     * finished or was cancelled since the list was read gets nothing (its bump is harmless).
     */
    for (const entry of warned) {
      const peer = await options.store.tasks.load(scope.tx, entry.other.task.id);
      if (peer === null || peer.task.state === 'done' || peer.task.state === 'cancelled') {
        continue;
      }
      if (peer.mr === null) {
        continue;
      }
      events.push(
        warnedEvent(options, data, {
          on: peer,
          seq: peer.task.sequence,
          mr: peer.mr,
          other: current,
          overlap: entry.theirs,
          redact,
        }),
      );
    }
    await scope.events.append(events);
  });
  logger.info(
    { task_id: stored.task.id, peers: peers.length, warned: warned.length },
    'rebase gate: concurrent tasks touching the same files',
  );
};

/**
 * One `task.conflict.warned`, on `on`'s stream, naming `other` — the same builder for both halves
 * of a pair, so the two events cannot disagree about what they carry.
 */
const warnedEvent = (
  options: RebaseJobOptions,
  data: PipelineOutboundData,
  input: {
    readonly on: StoredTask;
    readonly seq: number;
    readonly mr: NonNullable<StoredTask['mr']>;
    readonly other: StoredTask;
    readonly overlap: PathOverlap;
    readonly redact: (value: string) => string;
  },
): DomainEvent =>
  buildEvent(
    'task.conflict.warned',
    {
      project_id: input.on.task.projectId,
      task_id: input.on.task.id,
      mr: input.mr,
      other_task_id: input.other.task.id,
      // Redacted **then** capped, for `changedPathsOf`'s reason and on the same argument: a ticket
      // key is provider text (BD-022) and this is the second of the two sinks, the one
      // `reviewWrites.thread` does not cover. An exact-match redactor cannot find a secret a cap
      // has already halved.
      other_ticket_key: input.redact(input.other.task.ticket.key).slice(0, MAX_OVERLAP_PATH_CHARS),
      paths: [...input.overlap.paths],
      path_count: input.overlap.count,
      truncated: input.overlap.truncated,
    },
    { streamType: 'task', streamId: input.on.task.id, streamSeq: input.seq },
    {
      ids: options.ids,
      actor: PIPELINE_ACTOR,
      clock: options.clock as never,
      correlationId: input.on.task.id,
      causeEventId: data.cause_event_id as Id,
    },
  ) as DomainEvent;

/**
 * **The peer gets a thread too** — decided at WP-59 (PROGRESS backlog 65), and what it costs is
 * stated: one more provider write and one more `integration_actions` row per warned pair.
 *
 * The reason is who reads it. The developer about to push the conflicting change is the one on the
 * *peer's* merge request, and the agents re-entering that task read its threads, not this task's.
 * The event alone would reach the board and nobody working in the merge request.
 *
 * It is **the peer's own identity**, and that is what makes the pair one warning rather than two:
 * the key is {@link conflictWarningIdempotencyKey} built from the peer's id, the peer's head sha and
 * this task's id — exactly the key the peer's own gate computes for the same pair at the same
 * revisions. So whichever gate runs first posts both threads, and the other one replays both.
 *
 * Under the peer's own **mode**, so a shadow peer records `would_have` and posts nothing; and not at
 * all when the peer's merge request has no head sha, for the reason the task's own thread is
 * skipped in that case (no revision, no identity) — the event is still appended.
 */
const warnPeer = async (
  writes: ReturnType<typeof reviewWrites>,
  redact: (value: string) => string,
  input: {
    readonly stored: StoredTask;
    readonly peer: StoredTask;
    readonly overlap: PathOverlap;
    readonly logger: Logger;
  },
): Promise<void> => {
  const { stored, peer, overlap } = input;
  const peerHead = peer.mr?.head_sha ?? null;
  if (peer.mr === null || peerHead === null) {
    input.logger.info(
      { task_id: peer.task.id, other_task_id: stored.task.id },
      'rebase gate: the peer merge request has no head commit, so it gets the event and no thread',
    );
    return;
  }
  await writes.thread(
    {
      ref: peer.mr,
      path: null,
      line: null,
      markdown: renderConflictWarning({
        taskId: peer.task.id,
        ticketKey: redact(stored.task.ticket.key),
        overlap,
      }),
      idempotencyKey: conflictWarningIdempotencyKey(peer.task.id, peerHead, stored.task.id),
    },
    { projectId: peer.task.projectId, taskId: peer.task.id, mode: peer.task.mode },
  );
};

/** Every handler the conflict warning registers, for the runtime to spread. */
export const conflictWarningHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  conflictWarningHandler(options),
];
