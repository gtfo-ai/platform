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
 * The cost is stated rather than discovered. The duty makes **one provider read per peer task**,
 * bounded by {@link MAX_CONFLICT_PEERS}, and each read returns the peer's *patches* as well as its
 * paths because that is the shape the port has — the platform then throws the patches away. A
 * paths-only port method would be the honest read and is recorded as discovered work rather than
 * added here: it is a method, a fake, a shared contract suite, a GitLab adapter and a fixture with
 * provenance, which is a work package rather than a corner of this one.
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
 * **It warns one side of the pair, and that is a property of the trigger rather than an oversight.**
 * A task whose gate ran before the other task had a merge request is told nothing; the other one, at
 * its own gate, is told about both. Warning both would mean recomputing on every `mr.opened` and
 * `mr.updated` of every project, which is a provider read per peer per push.
 *
 * ## What "surfaced" is on this build
 *
 * Two things, and neither is the board. **A thread on the task's own merge request**, un-anchored,
 * through the `createDiscussion` WP-24 widened — so no port method is added and the warning reaches
 * the humans and the agents who are already looking at that merge request. And
 * **`task.conflict.warned`**, which is product/16's *"concurrent-task overlaps"* and is what a board
 * projection will read when one exists. The board badge itself needs a DTO field and a screen,
 * neither of which exists, and adding a client path with no screen is what the WP-15h census
 * refuses; it is recorded as discovered work with the field it needs.
 */
import type { Id } from '@platform/contracts';
import type { PathOverlap } from '@platform/domain';
import { buildEvent, MAX_OVERLAP_PATH_CHARS, pathOverlap } from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  reviewWrites,
} from './integrations.js';
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
  reads: ReturnType<typeof gitReads>,
  redact: (path: string) => string,
  stored: StoredTask,
  context: { readonly projectId: Id; readonly taskId: Id },
): Promise<{
  readonly newPaths: readonly string[];
  readonly oldPaths: readonly string[];
  readonly truncated: boolean;
} | null> => {
  if (stored.mr === null) {
    return null;
  }
  const files = await reads.mergeRequestDiff(stored.mr, MAX_CONFLICT_FILES, context);
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
  const reads = gitReads(integrations);
  const writes = reviewWrites(integrations);
  const redactor = integrations.git?.redactor ?? null;
  const redact = (path: string): string =>
    redactor === null ? path : redactor.redactText(path).value;
  const context = { projectId: stored.task.projectId, taskId: stored.task.id };

  const mine = await changedPathsOf(reads, redact, stored, context);
  if (mine === null) {
    return;
  }

  const warned: {
    readonly other: StoredTask;
    readonly overlap: PathOverlap;
  }[] = [];
  for (const peer of peers) {
    const theirs = await changedPathsOf(reads, redact, peer, context);
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
    warned.push({ other: peer, overlap });
  }

  if (warned.length === 0) {
    return;
  }
  await options.unitOfWork.transaction(async (scope) => {
    // Re-loaded for `task.sequence`, which is the stream's next seq and is read where the append
    // happens (`recordRebaseCheck` says why).
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null) {
      return;
    }
    let seq = current.task.sequence;
    const events = warned.map((entry) => {
      const event = buildEvent(
        'task.conflict.warned',
        {
          project_id: current.task.projectId,
          task_id: current.task.id,
          mr,
          other_task_id: entry.other.task.id,
          // Redacted **then** capped, for `changedPathsOf`'s reason and on the same argument: a
          // ticket key is provider text (BD-022) and this is the second of the two sinks, the one
          // `reviewWrites.thread` does not cover. An exact-match redactor cannot find a secret a
          // cap has already halved.
          other_ticket_key: redact(entry.other.task.ticket.key).slice(0, MAX_OVERLAP_PATH_CHARS),
          paths: [...entry.overlap.paths],
          path_count: entry.overlap.count,
          truncated: entry.overlap.truncated,
        },
        { streamType: 'task', streamId: current.task.id, streamSeq: seq },
        {
          ids: options.ids,
          actor: PIPELINE_ACTOR,
          clock: options.clock as never,
          correlationId: current.task.id,
          causeEventId: data.cause_event_id as Id,
        },
      );
      seq += 1;
      return event;
    });
    await scope.events.append(events);
  });
  logger.info(
    { task_id: stored.task.id, peers: peers.length, warned: warned.length },
    'rebase gate: concurrent tasks touching the same files',
  );
};

/** Every handler the conflict warning registers, for the runtime to spread. */
export const conflictWarningHandlers = (options: PipelineSagaOptions): readonly EventHandler[] => [
  conflictWarningHandler(options),
];
