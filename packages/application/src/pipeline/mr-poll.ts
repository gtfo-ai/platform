/**
 * **The merge-request poller** — technical/06 § "Inbound: webhooks and polling", WP-110, PROGRESS
 * backlog 297.
 *
 * technical/06 specifies polling for both providers — *"GitLab MR/pipeline listing since last
 * cursor; same normaliser; dedup makes both paths safe together"* — and WP-87 built the ticket half.
 * Until this module a GitLab binding on an instance GitLab cannot reach at `APP_BASE_URL` heard
 * nothing about its merge requests: review-only mode never started (`mr.opened` is its only
 * trigger) and a task never learned that its merge request merged or closed. Now a git binding whose
 * configuration switches polling on (`poll_enabled`, the platform's key) is asked, at its own
 * interval, for its repository's merge requests updated since a cursor on the binding
 * (`bindings.mr_poll_cursor`, migration 0068), and each listed merge request becomes the catalogue
 * events a webhook would have produced — recorded through `recordNormalisedDelivery`, the function
 * the webhook ingress records through, on the same `inbox` key rule as WP-87's tickets.
 *
 * ## A listing is a state; the events are transitions
 *
 * A webhook says *what happened* (`open`, `merge`, `close`); a listing says *what is* — a merge
 * request that is `merged` now. So the poller asks the log what it already knows
 * (`MergeRequestLifecycleReader.latest`, the read the recorder's dedup stands on) and drafts only
 * the transition the log does not have yet:
 *
 *  - `opened` → `mr.opened` when the log's newest lifecycle event for it is `mr.closed` (a reopen),
 *    or when the log knows nothing of it and it was **created inside the window**; and `mr.updated`
 *    with the provider's `updated_at`, always — the recorded head moves forward only by that
 *    instant (`provider-signals.ts`), so a repeat is harmless and a missing one leaves a human's
 *    push unrecorded;
 *  - `merged` → `mr.merged` unless the log already has it, and — when the log knows nothing of the
 *    merge request — only when `merged_at` is inside the window;
 *  - `closed` → `mr.closed` when the log's newest is `mr.opened`, or, knowing nothing, when
 *    `closed_at` is inside the window;
 *  - `locked` (GitLab's transient state during a merge) → nothing; the next poll sees the outcome.
 *
 * And a listing whose transition goes **against the log** of a merge request the log already knows
 * is confirmed by one more read of that merge request before it is recorded ({@link confirmListing},
 * review rounds 1 and 2): a webhook that recorded a transition between the list and the record has
 * overtaken the listing, and the listing then records nothing. The **final** state is never lost
 * (a disagreeing re-read means the change came after the list, so the next poll lists it), but an
 * **intermediate** one can be: listed `closed`, reopened before the re-read → no `mr.closed` is ever
 * recorded; the log still ends in GitLab's current state — the same loss as an open and a close
 * between two polls (review round 3). A re-read that fails throws, so the cursor stays put.
 *
 * The **window** rule is the first poll's answer, made for every merge request the log has never
 * heard of: a poll that turned an old merge request somebody commented on today into `mr.opened`
 * would start a review the webhook never would have, and an old merge's `mr.merged` would move a
 * task that a human already dealt with. A transition inside the window is one the cursor has not
 * passed, so nothing the binding missed while it was polling is lost to it.
 *
 * ## What is deduplicated where, stated exactly
 *
 *  - **Poll against poll: the `inbox` key.** One delivery per listed merge request, keyed
 *    `<provider>:poll:<project>:<path>!<iid>@<updated_at>` (redacted, like every `delivery_id`), so
 *    a second poll of an untouched merge request — the overlap every window has — collides on the
 *    key and appends **nothing**.
 *  - **Poll against webhook: the log, not a key.** A webhook's key is the provider's delivery id,
 *    which no listing carries. What makes one merge one `mr.merged`, whichever door saw it first, is
 *    the lifecycle rule in `recordNormalisedDelivery` (`integrations/merge-request-lifecycle.ts`):
 *    a draft that repeats the newest lifecycle event the log holds is dropped, for both doors. Two
 *    `mr.updated` for one push can still land (one from each door); the head handler orders them
 *    by the provider's instant, so the second moves nothing.
 *
 * ## The cursor, the window, the bound on a lost poll
 *
 * WP-87's, unchanged in every respect, and shared rather than restated: the window starts
 * `TICKET_POLL_OVERLAP_MS` behind the cursor (GitLab's `updated_after` is an absolute instant, so
 * only the index lag and the two clocks argue for the overlap here), a page full of merge requests
 * the cursor has passed is widened by `pollWindow` up to `TICKET_POLL_MAX_LIMIT` (the GitLab adapter
 * pages through `per_page` 100 to fill it), the cursor moves **forward only** and only after every
 * listing of the page is recorded, a binding with no cursor polls its last interval, a poll re-arms
 * itself in a `finally`, and a sweep re-arms a lost chain — so the bound on a lost poll is one sweep
 * (`APP_TICKET_POLL_SWEEP_INTERVAL_MS`, which governs both pollers).
 *
 * ## What a poll cannot see
 *
 * A listing carries a merge request's state and nothing that happened inside it: **approvals**
 * (`mr.approved`), **review comments** (`mr.review.comment`), **pipelines**
 * (`ci.pipeline.finished` — the CI gate asks the provider for the head's pipeline itself, so it does
 * not need the event) and **default-branch moves** (`default_branch.moved`) stay webhook-only. A
 * merge request opened and closed between two polls was never seen open: it is one `mr.closed`
 * (inside the window) with no `mr.opened`. And `blocking_threads_resolved` is never sent, because a
 * listing's value is the state rather than the change the event means.
 */
import type { Actor, Id, IsoDateTime, JsonObject } from '@platform/contracts';
import { idSchema } from '@platform/contracts';
import * as z from 'zod';
import { type InboundRecorderOptions, recordNormalisedDelivery } from '../integrations/inbound.js';
import {
  isMergeRequestLifecycleEvent,
  type MergeRequestLifecycleEvent,
} from '../integrations/merge-request-lifecycle.js';
import type { NormalisedDelivery, NormalisedEvent } from '../ports/integrations/common.js';
import {
  type MergeRequestListing,
  type MergeRequestPollPlan,
  mergeRequestListingSchema,
} from '../ports/integrations/git-provider.js';
import { jobQueueDefinition } from '../ports/job-queues.js';
import type { JobHandler, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  type GitBinding,
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrations,
  type PipelineIntegrationsPort,
} from './integrations.js';
import {
  DEFAULT_TICKET_POLL_SWEEP_LIMIT,
  newestUpdatedAt,
  type PolledBinding,
  pollWindow,
  TICKET_POLL_OVERLAP_MS,
} from './ticket-poll.js';

/**
 * The poller's rows (migration 0068). Each method is one statement, never called inside a
 * transaction of the caller's, never while a provider read is in flight.
 */
export interface MergeRequestPollStore {
  /**
   * The git bindings whose merged configuration — `bindings.config` over `integrations.config` —
   * sets `poll_enabled` to `true`, at most `limit`, in a stable order. A pre-filter: the adapter's
   * `pollPlan()` is the authority each poll asks again.
   */
  listPolling(limit: number): Promise<readonly PolledBinding[]>;
  /** `bindings.mr_poll_cursor`, or `null` for a binding never polled (or one that no longer exists). */
  cursorOf(binding: PolledBinding): Promise<IsoDateTime | null>;
  /** Moves the cursor to `to` **only forward**; a binding that no longer exists is a no-op. */
  advanceCursor(binding: PolledBinding, to: IsoDateTime): Promise<void>;
}

/** Listings one poll asks for first; `pollWindow` widens a page the cursor has already passed. */
export const DEFAULT_MR_POLL_LIMIT = 50;

/** The one sweep job's key. */
export const MR_POLL_SWEEP_KEY = 'sweep';

/** A binding's poll chain key — `stately` admits one queued and one active per key. */
export const mrPollKey = (binding: PolledBinding): string =>
  `binding:${binding.projectId}:${binding.integrationId}`;

/** The job payload, parsed on fire. */
export const mrPollJobSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sweep') }),
  z.strictObject({
    kind: z.literal('poll'),
    project_id: idSchema,
    integration_id: idSchema,
  }),
]);
export type MergeRequestPollJob = z.infer<typeof mrPollJobSchema>;

/**
 * The poll's dedup identity — **redacted**, like every `delivery_id`: it is built out of provider
 * text (the repository path) and stored. The project is in it for the ticket poller's reason (one
 * account bound to two projects is polled once per binding).
 */
export const polledMergeRequestKey = (
  git: GitBinding,
  projectId: Id,
  listing: MergeRequestListing,
): string =>
  git.redactor.redactText(
    `${git.ref.provider}:poll:${projectId}:${listing.ref.project_path ?? git.project}!${listing.ref.iid}@${listing.updated_at}`,
  ).value;

type PolledMergeRequestEvent = MergeRequestLifecycleEvent | 'mr.updated';

/**
 * The events one listed merge request is, given what the log already holds for it and where the
 * window starts — the module docblock's table.
 */
export const polledMergeRequestDrafts = (
  input: {
    readonly projectId: Id;
    readonly integrationId: Id;
    readonly git: Pick<GitBinding, 'project' | 'ref'>;
    readonly windowStartMs: number;
  },
  listing: MergeRequestListing,
  headSha: string,
  latest: MergeRequestLifecycleEvent | null,
): NormalisedEvent<PolledMergeRequestEvent>[] => {
  const actor: Actor = {
    kind: 'integration',
    integration_id: input.integrationId,
    provider: input.git.ref.provider,
  };
  const payload = {
    project_id: input.projectId,
    task_id: null,
    mr: {
      provider: listing.ref.provider ?? input.git.ref.provider,
      project_path: listing.ref.project_path ?? input.git.project,
      iid: listing.ref.iid,
      url: listing.ref.url,
      branch: listing.ref.branch ?? null,
      head_sha: headSha,
    },
    draft: listing.draft,
    head_sha: headSha,
    // A listing carries no line counts, and neither does a GitLab delivery (`gitlab/inbound.ts`).
    diff_stats: null,
  };
  const inWindow = (at: string | null | undefined): boolean =>
    typeof at === 'string' && Date.parse(at) >= input.windowStartMs;
  const drafts: NormalisedEvent<PolledMergeRequestEvent>[] = [];
  switch (listing.state) {
    case 'opened':
      if (latest === 'mr.closed' || (latest === null && inWindow(listing.created_at))) {
        drafts.push({ type: 'mr.opened', payload, actor });
      }
      drafts.push({
        type: 'mr.updated',
        payload: { ...payload, updated_at: listing.updated_at },
        actor,
      });
      break;
    case 'merged':
      if (latest !== 'mr.merged' && (latest !== null || inWindow(listing.merged_at))) {
        drafts.push({
          type: 'mr.merged',
          payload: { ...payload, merge_commit_sha: listing.merge_commit_sha ?? null },
          actor,
        });
      }
      break;
    case 'closed':
      if (latest === 'mr.opened' || (latest === null && inWindow(listing.closed_at))) {
        drafts.push({ type: 'mr.closed', payload, actor });
      }
      break;
    case 'locked':
      // GitLab's transient state while a merge is in progress: the next poll sees the outcome.
      break;
  }
  return drafts;
};

/** Polled drafts are never human decisions; asked to decide one, the recorder has found a defect. */
const refusingDecisions: InboundRecorderOptions['decisions'] = {
  apply: async () => {
    throw new Error('a polled merge request produced a human decision, which no poll can carry');
  },
};

export interface MergeRequestPollerOptions {
  readonly jobs: Jobs;
  readonly store: MergeRequestPollStore;
  readonly integrations: PipelineIntegrationsPort;
  /** The webhook ingress's database half; `decisions` is supplied here, refusing. */
  readonly recorder: Omit<InboundRecorderOptions, 'decisions' | 'logger'>;
  readonly clock: { now(): IsoDateTime };
  /** How often the sweep re-arms lost chains — the bound on a lost poll. Must be positive. */
  readonly sweepIntervalMs: number;
  readonly limit?: number;
  readonly sweepLimit?: number;
  readonly logger?: Logger;
}

/** What one poll did — returned for the tests, logged for the operator. */
export type MergeRequestPollReport =
  /** The binding is gone, or points at another integration now: the chain ends. */
  | { readonly kind: 'unbound' }
  /** The binding no longer polls: the chain ends. */
  | { readonly kind: 'off' }
  | {
      readonly kind: 'polled';
      readonly plan: MergeRequestPollPlan;
      readonly listed: number;
      /** Listings recorded as a delivery (whose events may still all be repeats the log held). */
      readonly recorded: number;
      /** Listings whose key an earlier poll already recorded. */
      readonly duplicates: number;
      /** Listings that are no transition the log lacks (an old merge request touched again). */
      readonly unchanged: number;
      /** Listings the provider no longer confirms, read again ({@link confirmListing}). */
      readonly stale: number;
      /** Listings dropped by name: they failed the port schema after redaction, or had no head. */
      readonly skipped: number;
      readonly stalled: boolean;
      readonly cursor: IsoDateTime | null;
    };

/**
 * One poll of one binding: re-validate, list outside every transaction, record each listing in its
 * own transaction, then move the cursor.
 */
export const pollMergeRequestBinding = async (
  options: MergeRequestPollerOptions,
  binding: PolledBinding,
): Promise<MergeRequestPollReport> => {
  const logger = options.logger ?? silentLogger;
  const integrations = await integrationsForProject(
    options.integrations,
    binding.projectId,
    noRunScopedSecrets(),
  );
  const git = integrations.git;
  if (git === null || git.ref.integrationId !== binding.integrationId) {
    return { kind: 'unbound' };
  }
  const plan = git.port.pollPlan();
  if (plan === null) {
    return { kind: 'off' };
  }

  const cursor = await options.store.cursorOf(binding);
  const edge =
    cursor === null
      ? Date.parse(options.clock.now()) - plan.interval_seconds * 1000
      : Date.parse(cursor);
  const window = await pollWindow(
    (since, limit) =>
      gitReads(integrations).mergeRequests(
        { updatedAfter: new Date(since).toISOString(), limit },
        { projectId: binding.projectId, taskId: null },
      ),
    { edge, cursorKnown: cursor !== null, limit: options.limit ?? DEFAULT_MR_POLL_LIMIT },
  );
  if (window.stalled) {
    logger.warn(
      {
        project_id: binding.projectId,
        integration_id: binding.integrationId,
        listed: window.matches.length,
        limit: window.limit,
        cursor,
      },
      'the merge-request poll is stalled: more merge requests than its widest page were updated just before its cursor, so it cannot reach anything newer (TICKET_POLL_MAX_LIMIT)',
    );
  }

  const counts = { recorded: 0, duplicates: 0, unchanged: 0, stale: 0, skipped: 0 };
  for (const raw of window.matches) {
    const outcome = await recordListing(
      options,
      binding,
      integrations,
      git,
      edge - TICKET_POLL_OVERLAP_MS,
      raw,
    );
    counts[outcome] += 1;
  }

  const latest = newestUpdatedAt(window.matches);
  if (latest !== null) {
    await options.store.advanceCursor(binding, latest);
  }
  return {
    kind: 'polled',
    plan,
    listed: window.matches.length,
    ...counts,
    stalled: window.stalled,
    cursor: latest ?? cursor,
  };
};

type ListingOutcome = 'recorded' | 'duplicates' | 'unchanged' | 'stale' | 'skipped';

/**
 * Whether the drafts move a merge request's lifecycle **against** what the log holds for it — the
 * case the provider is asked again before anything is recorded ({@link confirmListing}).
 */
const contradictsLog = (
  latest: MergeRequestLifecycleEvent | null,
  drafts: readonly NormalisedEvent<PolledMergeRequestEvent>[],
): boolean => latest !== null && drafts.some((draft) => isMergeRequestLifecycleEvent(draft.type));

/**
 * **A listing the log may have overtaken is confirmed by one more read of that merge request**
 * (WP-110 review rounds 1 and 2).
 *
 * A listing is a state read at one instant and recorded at a later one; a webhook can record a
 * transition in between. Listed at T0 as `opened`, a webhook's close recorded at T1: the poll would
 * read the log's `mr.closed` and draft a "reopen" from a state that is already history (re-arming
 * review-only for a closed merge request), and the mirror case a close that escalates a task.
 *
 * Round 1 compared the listing's `updated_at` with the platform's `occurred_at` of the log's event
 * — two clocks — and on a **poll-only** binding that lost a real transition for good: an open the
 * poll recorded at 10:00:00 platform time and a merge GitLab stamped 09:59:50 (the merge happening
 * between the list and the record, or any skew) read as stale on every later poll, and the task
 * never learned it merged. Round 2 compares nothing across clocks: when the drafts would move the
 * lifecycle of a merge request the log already knows (the only case a stale listing can mislead),
 * the provider is asked for that merge request **now** (`gitReads.mergeRequest`, audited), and the
 * listing is recorded only if the provider still says its state. If not, the listing is history and
 * records nothing; the newer state carries a newer `updated_at`, so the next poll lists it. The cost
 * is one read per lifecycle transition the poll finds for a known merge request — a merge, a close,
 * a reopen — never per listing. Chosen over storing the provider's instant on every lifecycle event
 * because that needs a catalogue change to three events and a webhook payload that carries the
 * instant on every action, which GitLab's does not state (`actioned_at` is 18.10+), and it would
 * still not order a webhook's transition against a listing read on another instance's clock.
 * A read that fails throws, so the poll fails before the cursor moves and the next one asks again.
 */
const confirmListing = async (
  integrations: PipelineIntegrations,
  binding: PolledBinding,
  listing: MergeRequestListing,
): Promise<boolean> => {
  const current = await gitReads(integrations).mergeRequest(listing.ref, {
    projectId: binding.projectId,
    taskId: null,
  });
  return current !== null && current.state === listing.state;
};

const recordListing = async (
  options: MergeRequestPollerOptions,
  binding: PolledBinding,
  integrations: PipelineIntegrations,
  git: GitBinding,
  windowStartMs: number,
  raw: MergeRequestListing,
): Promise<ListingOutcome> => {
  const logger = options.logger ?? silentLogger;
  // Redacted **before** anything is built from it — the key, the row and the events alike — as a
  // webhook delivery is redacted before its normaliser reads it (BD-003: events are append-only).
  const redacted = git.redactor.redactJson({ listing: raw as unknown as JsonObject });
  const document = redacted.value as { listing: unknown };
  const parsed = mergeRequestListingSchema.safeParse(document.listing);
  const headSha = parsed.success ? (parsed.data.head_sha ?? null) : null;
  if (!parsed.success || headSha === null) {
    // Rule 20, the ticket poller's answer: one listing that is not a listing after redaction, or
    // that names no head (every `mr.*` event requires one), is dropped by name — a poll that threw
    // on it would throw on it every interval, and the cursor would never move.
    logger.warn(
      {
        project_id: binding.projectId,
        integration_id: binding.integrationId,
        path: parsed.success ? 'head_sha' : (parsed.error.issues[0]?.path.join('.') ?? '<root>'),
      },
      'a polled merge request failed the port schema after redaction, or names no head, and was not recorded',
    );
    return 'skipped';
  }
  const listing = parsed.data;
  const deliveryId = polledMergeRequestKey(git, binding.projectId, listing);
  if ((await options.recorder.inbox.find(git.ref.provider, deliveryId)) !== null) {
    return 'duplicates';
  }
  const latest = await options.recorder.mergeRequests.latest({
    projectId: binding.projectId,
    projectPath: listing.ref.project_path ?? git.project,
    iid: listing.ref.iid,
  });
  const drafts = polledMergeRequestDrafts(
    { projectId: binding.projectId, integrationId: binding.integrationId, git, windowStartMs },
    listing,
    headSha,
    latest,
  );
  if (drafts.length === 0) {
    return 'unchanged';
  }
  if (contradictsLog(latest, drafts) && !(await confirmListing(integrations, binding, listing))) {
    return 'stale';
  }
  const normalised: NormalisedDelivery[] = [{ events: [...drafts], ignored: [] }];
  const outcome = await recordNormalisedDelivery(
    { ...options.recorder, decisions: refusingDecisions, logger },
    {
      provider: git.ref.provider,
      deliveryId,
      integrationId: binding.integrationId,
      redactor: git.redactor,
      // A poll has no headers; the row says where it came from in its payload instead.
      headers: { value: {}, count: 0 },
      payload: {
        value: { source: 'poll', listing: document.listing } as JsonObject,
        count: redacted.count,
      },
      normalised,
      byProject: [{ projectId: binding.projectId, drafts }],
    },
  );
  return outcome.kind === 'duplicate' ? 'duplicates' : 'recorded';
};

export const enqueueMergeRequestPoll = async (
  jobs: Jobs,
  job: MergeRequestPollJob,
  options: { readonly startAfter?: Date } = {},
): Promise<void> => {
  await jobs.enqueue({
    queue: JOB_QUEUES.mrPoll,
    data: job,
    singletonKey:
      job.kind === 'sweep'
        ? MR_POLL_SWEEP_KEY
        : mrPollKey({
            projectId: job.project_id as Id,
            integrationId: job.integration_id as Id,
          }),
    ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
  });
};

/** One sweep: a poll enqueued for every polling git binding — collapsed for a live chain. */
export const runMergeRequestPollSweep = async (
  options: MergeRequestPollerOptions,
): Promise<{ readonly bindings: number }> => {
  const bindings = await options.store.listPolling(
    options.sweepLimit ?? DEFAULT_TICKET_POLL_SWEEP_LIMIT,
  );
  for (const binding of bindings) {
    await enqueueMergeRequestPoll(options.jobs, {
      kind: 'poll',
      project_id: binding.projectId,
      integration_id: binding.integrationId,
    });
  }
  return { bindings: bindings.length };
};

const later = (clock: { now(): IsoDateTime }, ms: number): Date =>
  new Date(Date.parse(clock.now()) + ms);

/** The interval to re-arm a failed poll with, or `null` when the plan itself cannot be read. */
const planIntervalMs = async (
  options: MergeRequestPollerOptions,
  binding: PolledBinding,
): Promise<number | null> => {
  try {
    const integrations = await integrationsForProject(
      options.integrations,
      binding.projectId,
      noRunScopedSecrets(),
    );
    const plan =
      integrations.git?.ref.integrationId === binding.integrationId
        ? integrations.git.port.pollPlan()
        : null;
    return plan === null ? null : plan.interval_seconds * 1000;
  } catch {
    // The failed poll already reported the loader's refusal by throwing; the sweep re-arms it.
    return null;
  }
};

/**
 * The queue's handler: a sweep, or one binding's poll. Both re-arm in a `finally`, and a poll
 * re-arms only when it learned a plan — `ticketPollHandler`'s shape, for its reasons.
 */
export const mergeRequestPollHandler = (options: MergeRequestPollerOptions): JobHandler => {
  const logger = options.logger ?? silentLogger;
  return async (context) => {
    const job = mrPollJobSchema.parse(context.data);
    if (job.kind === 'sweep') {
      try {
        await runMergeRequestPollSweep(options);
      } finally {
        await enqueueMergeRequestPoll(options.jobs, job, {
          startAfter: later(options.clock, options.sweepIntervalMs),
        });
      }
      return;
    }
    const binding: PolledBinding = {
      projectId: job.project_id as Id,
      integrationId: job.integration_id as Id,
    };
    let rearmMs: number | null = null;
    try {
      const report = await pollMergeRequestBinding(options, binding);
      if (report.kind === 'polled') {
        rearmMs = report.plan.interval_seconds * 1000;
        if (report.recorded > 0) {
          logger.info(
            {
              project_id: binding.projectId,
              integration_id: binding.integrationId,
              listed: report.listed,
              recorded: report.recorded,
              duplicates: report.duplicates,
            },
            'the merge-request poll recorded listings as inbound deliveries',
          );
        }
      } else {
        logger.info(
          {
            project_id: binding.projectId,
            integration_id: binding.integrationId,
            reason: report.kind,
          },
          'the merge-request poll chain ended: the binding no longer polls this integration',
        );
      }
    } catch (error) {
      // Rule 20: an inbound read that failed is retried by the next tick, never a reason to stop.
      rearmMs = await planIntervalMs(options, binding);
      throw error;
    } finally {
      if (rearmMs !== null) {
        await enqueueMergeRequestPoll(
          options.jobs,
          { kind: 'poll', project_id: binding.projectId, integration_id: binding.integrationId },
          { startAfter: later(options.clock, rearmMs) },
        );
      }
    }
  };
};

/**
 * Declare the queue, start its worker, and put the first sweep on it. The worker is one more pooled
 * connection, counted in `POOL_RESERVATIONS.pipeline` (`apps/server/src/config.ts`).
 */
export const startMergeRequestPoller = async (
  options: MergeRequestPollerOptions,
): Promise<JobWorker> => {
  if (!(options.sweepIntervalMs > 0)) {
    throw new TypeError(`sweepIntervalMs must be positive, got ${options.sweepIntervalMs}`);
  }
  await options.jobs.defineQueue(jobQueueDefinition(JOB_QUEUES.mrPoll));
  const worker = await options.jobs.work({
    queue: JOB_QUEUES.mrPoll,
    handler: mergeRequestPollHandler(options),
    concurrency: 1,
  });
  // Every process start re-establishes the sweep; `stately` collapses N replicas onto one.
  await enqueueMergeRequestPoll(options.jobs, { kind: 'sweep' });
  return worker;
};
