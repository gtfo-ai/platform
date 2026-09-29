/**
 * **The ticket poller** — technical/06 § "Inbound: webhooks and polling", WP-87, PROGRESS backlog
 * 187's poller half.
 *
 * Until this module a Jira binding with no public URL started no ticket: technical/06 specified a
 * polling fallback and the only production caller of `matchTickets` was the history bootstrap. Now a
 * task-management binding whose configuration switches polling on (`TICKET_POLL_CONFIG_KEYS`) is
 * asked, at its own interval, for the tickets its **pick-up rule** matches since a cursor stored on
 * the binding, and each match is recorded as the same normalised signal a webhook produces.
 *
 * ## The same signal, through the same door
 *
 * A polled match becomes `ticket.matched` **and** `ticket.updated` — the pair Jira's
 * `jira:issue_updated` produces when an edit makes a ticket match — and both are written with an
 * `inbox` row **in one transaction** by `recordNormalisedDelivery`, the function the webhook ingress
 * records through. So the two doors share one dedup table, one redaction rule (the binding's
 * redactor, both TD-012 steps, applied to the match **before** anything is built from it) and one
 * arbiter of "performs nothing twice".
 *
 * ## What is deduplicated where, stated exactly
 *
 * The ruling asks for the poll to deduplicate "on the same `inbox` key" as the webhook, and the
 * sentence has two readings; this module takes the one the providers allow and says why.
 *
 *  - **Poll against poll: the `inbox` key.** A poll's `delivery_id` is
 *    `<provider>:poll:<project>:<ticket>@<updated_at>`, redacted by the binding's redactor, on the
 *    same `inbox(provider, delivery_id)` primary key a webhook's lands on. A second poll of a ticket
 *    nobody touched — the overlapping window every poll has, and a lost cursor write — collides on it
 *    and appends **nothing**. The project is in the key because one Jira site bound to two projects
 *    is polled once per binding, and without it the second project's match would be taken for the
 *    first's redelivery and dropped.
 *  - **Poll against webhook: intake's 1:1 rule, not a shared identifier.** A webhook's key is the
 *    provider's delivery identifier (`X-Atlassian-Webhook-Identifier`), which a search result does
 *    not carry and no read can reconstruct, so no key the poller could build equals it. What makes a
 *    binding with both doors start a ticket once is `pipeline.intake`'s `findByTicket` — intake is
 *    1:1 with a ticket on `tasks_project_id_ticket_key_mode` (`saga.ts`), which is the dedup both
 *    paths already meet — and the e2e tier asserts it in both orders. What the two doors *can* both
 *    append is a second `ticket.matched` / `ticket.updated` for one change: the first is absorbed by
 *    intake, the second re-stamps a live task's ticket signal, which costs one extra snapshot read
 *    (the safe direction, `provider-signals.ts`).
 *
 * ## The cursor, and the first poll
 *
 * The cursor is `bindings.poll_cursor` (migration 0061): the newest `updated_at` the last poll
 * recorded, moved **forward only** and only after every match of the page is recorded, so a poll
 * that dies half-way re-reads its window and the first half collides on the key. Each window starts
 * {@link TICKET_POLL_OVERLAP_MS} behind the cursor, because the provider's search index lags and
 * its clock is not the platform's; the re-read tickets collide on their keys. A page cut by the limit
 * is **not** continued from the cursor (Jira's minute rounding starts every window before it): a full
 * page with nothing newer than the cursor is widened in the same poll (`pollWindow`), up to
 * `TICKET_POLL_MAX_LIMIT`, past which the poll reports itself stalled. `matchTickets`
 * returns the oldest first (a port obligation since WP-87), so a page cut by `limit` continues where
 * it stopped. A binding with **no** cursor polls the last interval only: a first poll of "every
 * ticket that ever carried the label" would start a task for every closed ticket that still has it,
 * which the webhook — whose match means *the change made it match* — never did.
 *
 * ## A lost poll is recovered, and the bound is one sweep
 *
 * Every job re-validates on fire (TD-004): the binding may be gone, re-pointed at another
 * integration, or switched off, and each of those ends the chain without arming the next poll. A
 * poll that ran arms the next one in a `finally`, so a provider outage costs one interval, not the
 * chain. What would lose a chain — a process dying between a poll and its re-arm, or a binding
 * switched on through the API after its last sweep — is recovered by the **sweep**: one job, keyed
 * `sweep`, that lists every polling binding each `sweepIntervalMs` and enqueues a poll for each. The
 * queue is `stately` per key, so for a live chain the sweep's enqueue collapses onto the poll already
 * queued; for a lost one it starts it. The residual is stated: a sweep that lands while a poll is
 * *running* takes the queued slot, so that binding polls once more straight after — one extra read,
 * never a lost one.
 *
 * ## What a poll cannot see
 *
 * A poll asks for the tickets its pick-up rule matches, so an edit to a ticket that **no longer
 * matches** is not seen — a status rule whose ticket the platform's own status mapping moved on, in
 * particular. Such a binding's live tasks get `ticket.updated` only by webhook; technical/06 says so.
 * A polled edit also carries no changed-field names (`changed_fields: []`, the shape an update
 * with no changelog already had), and the poll emits no `ticket.created`, so the ticket readiness
 * linter is a webhook-only feature.
 */
import type { Actor, Id, IsoDateTime, JsonObject } from '@platform/contracts';
import { idSchema } from '@platform/contracts';
import * as z from 'zod';
import { type InboundRecorderOptions, recordNormalisedDelivery } from '../integrations/inbound.js';
import type { NormalisedDelivery, NormalisedEvent } from '../ports/integrations/common.js';
import {
  type TicketMatch,
  type TicketMatchRule,
  type TicketPollPlan,
  ticketMatchSchema,
} from '../ports/integrations/task-management.js';
import { jobQueueDefinition } from '../ports/job-queues.js';
import type { JobHandler, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
  type TaskManagementBinding,
  ticketReads,
} from './integrations.js';

/** One task-management binding the poller serves. */
export interface PolledBinding {
  readonly projectId: Id;
  readonly integrationId: Id;
}

/**
 * The poller's rows (migration 0061). No method runs inside a transaction of the caller's: each is
 * one statement, and none is called while a provider read is in flight.
 */
export interface TicketPollStore {
  /**
   * The task-management bindings whose configuration — `bindings.config` over `integrations.config`
   * — sets `poll_enabled` to `true`, at most `limit`, in a stable order. A pre-filter: the adapter's
   * `pollPlan()` is the authority each poll asks again.
   */
  listPolling(limit: number): Promise<readonly PolledBinding[]>;
  /** `bindings.poll_cursor`, or `null` for a binding never polled (or one that no longer exists). */
  cursorOf(binding: PolledBinding): Promise<IsoDateTime | null>;
  /** Moves the cursor to `to` **only forward**; a binding that no longer exists is a no-op. */
  advanceCursor(binding: PolledBinding, to: IsoDateTime): Promise<void>;
}

/**
 * How far **behind** the cursor each poll's window starts (WP-87 review round 1).
 *
 * The cursor is the newest `updated_at` the last poll recorded, and a window that started exactly
 * there would skip a ticket updated a few seconds *before* it that the provider's search had not
 * indexed yet: Jira's search index lags by seconds (the fake's divergence 7 and the Jira replay's
 * note say so; the figure is not measured here). Two more things make the edge soft: Jira evaluates
 * the relative `updated >= "-Nm"` on **its** clock while the platform computed `N` on its own, and
 * the minutes are rounded up, so the real window is wider by 0–60 s depending on timing — slack
 * nobody can rely on. Five minutes is sixty times "seconds" of index lag plus any NTP-synced clock
 * skew, and it costs nothing but a larger read: every ticket re-read inside the overlap collides on
 * its `@<updated_at>` inbox key and appends nothing. An absolute JQL instant would remove the clock
 * half but not the index half, and Jira reads an absolute date in the site's time zone
 * (`buildJql`'s docblock), which the adapter does not know — so the window stays relative and this
 * overlap carries both.
 */
export const TICKET_POLL_OVERLAP_MS = 5 * 60 * 1000;

/**
 * Matches one poll asks for first. A full page is **not** continued "from the cursor" next time —
 * against Jira a window cannot start at the cursor, because `buildJql` rounds its relative minutes
 * up, so it starts up to a minute (plus clock skew, plus the overlap) before it. Progress is made by
 * {@link pollWindow} instead, which widens the page within the same poll.
 */
export const DEFAULT_TICKET_POLL_LIMIT = 50;

/**
 * The widest page a poll escalates to (WP-87 review round 2) — and the one hard limit the poller has.
 *
 * A bulk edit of more tickets than one page, all inside the minute a window rounds to, fills the page
 * with tickets the cursor has already passed; re-asking for the same page would never reach the rest
 * of the edit. So a poll whose page is full and holds nothing newer than the cursor asks again with
 * four times the limit, up to this cap (the Jira adapter pages through `nextPageToken` to fill it).
 * Past the cap — more than this many tickets updated in the window before the cursor — the poll
 * cannot move, and says so on every poll (`stalled`, a warn line with the count) rather than stalling
 * silently. It does not recover by itself: the window is anchored at the cursor, so neither time nor
 * a newer edit shrinks it. The ways out are the webhook, or moving `bindings.poll_cursor` forward by
 * hand (giving up that window) — technical/06 and the Jira setup guide say so. A thousand is ten Jira pages per poll at worst, bounded by the binding's interval.
 */
export const TICKET_POLL_MAX_LIMIT = 1000;

/** Bindings one sweep re-arms at most. */
export const DEFAULT_TICKET_POLL_SWEEP_LIMIT = 500;

/** The one sweep job's key. */
export const TICKET_POLL_SWEEP_KEY = 'sweep';

/** A binding's poll chain key — `stately` admits one queued and one active per key. */
export const ticketPollKey = (binding: PolledBinding): string =>
  `binding:${binding.projectId}:${binding.integrationId}`;

/** The job payload, parsed on fire: a job is a wire boundary like any other. */
export const ticketPollJobSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sweep') }),
  z.strictObject({
    kind: z.literal('poll'),
    project_id: idSchema,
    integration_id: idSchema,
  }),
]);
export type TicketPollJob = z.infer<typeof ticketPollJobSchema>;

/** The rule as `ticket.matched.rule` carries it — the spelling the Jira webhook uses. */
export const ticketMatchRuleText = (rule: TicketMatchRule): string => {
  switch (rule.kind) {
    case 'label':
      return `label = ${JSON.stringify(rule.label)}`;
    case 'status':
      return `status = ${JSON.stringify(rule.status)}`;
    case 'epic':
      return `epic = ${JSON.stringify(rule.epic_key)}`;
    case 'query':
      return rule.query;
  }
};

/**
 * The poll's dedup identity — **redacted**, like every `delivery_id` (CLAUDE.md's inbound-dedup
 * paragraph): it is built out of provider text (the ticket key) and stored. The residual is
 * `InboundNormaliser.deliveryKey`'s, unchanged: two keys that differ only inside one injected secret
 * collapse onto one row, and the first survives.
 */
export const polledDeliveryKey = (
  binding: TaskManagementBinding,
  projectId: Id,
  match: TicketMatch,
): string =>
  binding.redactor.redactText(
    `${binding.ref.provider}:poll:${projectId}:${match.ref.key}@${match.updated_at}`,
  ).value;

/**
 * The two events a polled match is, in the order a Jira `jira:issue_updated` puts them: the match
 * first, the edit last (`webhook.ts`). The actor is the integration, as a webhook's match is.
 */
export const polledMatchDrafts = (
  projectId: Id,
  integrationId: Id,
  rule: string,
  match: TicketMatch,
): NormalisedEvent<'ticket.matched' | 'ticket.updated'>[] => {
  const actor: Actor = {
    kind: 'integration',
    integration_id: integrationId,
    provider: match.ref.provider,
  };
  return [
    {
      type: 'ticket.matched',
      payload: {
        project_id: projectId,
        ticket: match.ref,
        rule,
        priority: match.priority ?? null,
        issue_type: match.issue_type,
        epic: match.epic ?? null,
        links: match.links.map((link) => ({
          kind: link.kind,
          key: link.key,
          url: link.url ?? null,
        })),
      },
      actor,
    },
    {
      type: 'ticket.updated',
      payload: {
        project_id: projectId,
        ticket: match.ref,
        updated_at: match.updated_at,
        // A search result carries no changelog: the empty list an update with none already has,
        // never an invented one (`ticketUpdatedEvent`'s docblock).
        changed_fields: [],
        truncated: false,
      },
      actor,
    },
  ];
};

/** Polled drafts are never human decisions; asked to decide one, the recorder has found a defect. */
const refusingDecisions: InboundRecorderOptions['decisions'] = {
  apply: async () => {
    throw new Error('a polled ticket match produced a human decision, which no poll can carry');
  },
};

export interface TicketPollerOptions {
  readonly jobs: Jobs;
  readonly store: TicketPollStore;
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
export type TicketPollReport =
  /** The binding is gone, or points at another integration now: the chain ends. */
  | { readonly kind: 'unbound' }
  /** The binding no longer polls (switched off, or no pick-up rule): the chain ends. */
  | { readonly kind: 'off' }
  | {
      readonly kind: 'polled';
      readonly plan: TicketPollPlan;
      readonly matched: number;
      readonly recorded: number;
      readonly duplicates: number;
      /** Matches dropped by name because they failed the port schema after redaction (rule 20). */
      readonly skipped: number;
      /** The widest page held nothing newer than the cursor ({@link TICKET_POLL_MAX_LIMIT}). */
      readonly stalled: boolean;
      readonly cursor: IsoDateTime | null;
    };

const newest = (matches: readonly TicketMatch[]): IsoDateTime | null => {
  let latest: string | null = null;
  for (const match of matches) {
    // An instant nobody can read never becomes the cursor (a provider defect must not wedge it).
    if (!Number.isFinite(Date.parse(match.updated_at))) {
      continue;
    }
    if (latest === null || Date.parse(match.updated_at) > Date.parse(latest)) {
      latest = match.updated_at;
    }
  }
  return latest as IsoDateTime | null;
};

/**
 * Reads one poll's matches so that the poll **makes progress** (WP-87 review round 2).
 *
 * The window starts {@link TICKET_POLL_OVERLAP_MS} before `edge` (the cursor, or a first poll's
 * interval). A page that is full and holds nothing newer than the cursor is read again at four times
 * the limit, up to {@link TICKET_POLL_MAX_LIMIT}; at the cap, once more from `edge` itself without the
 * overlap (against Jira that still starts up to a minute early — the rounding — but drops the five
 * minutes). A page that is **not** full holds everything the window has, so nothing newer exists and
 * nothing more is needed. `stalled` is the one case left: the widest page is full and nothing in it
 * is newer than the cursor.
 */
export const pollWindow = async (
  read: (sinceMs: number, limit: number) => Promise<readonly TicketMatch[] | null>,
  input: { readonly edge: number; readonly cursorKnown: boolean; readonly limit: number },
): Promise<{
  readonly matches: readonly TicketMatch[];
  readonly limit: number;
  readonly stalled: boolean;
}> => {
  const stuck = (page: readonly TicketMatch[], limit: number): boolean =>
    input.cursorKnown &&
    page.length >= limit &&
    !page.some((match) => Date.parse(match.updated_at) > input.edge);
  let limit = input.limit;
  // `null` is "no task-management binding", which the caller has already answered.
  let matches = (await read(input.edge - TICKET_POLL_OVERLAP_MS, limit)) ?? [];
  while (stuck(matches, limit) && limit < TICKET_POLL_MAX_LIMIT) {
    limit = Math.min(limit * 4, TICKET_POLL_MAX_LIMIT);
    matches = (await read(input.edge - TICKET_POLL_OVERLAP_MS, limit)) ?? [];
  }
  if (stuck(matches, limit)) {
    matches = (await read(input.edge, limit)) ?? [];
  }
  return { matches, limit, stalled: stuck(matches, limit) };
};

/**
 * One poll of one binding: re-validate, read outside every transaction (the executor and
 * `integrationsForProject` both refuse one), record each match in its own transaction, then move
 * the cursor. Returns the plan it polled with, so the caller knows when to arm the next one.
 */
export const pollTicketBinding = async (
  options: TicketPollerOptions,
  binding: PolledBinding,
): Promise<TicketPollReport> => {
  const logger = options.logger ?? silentLogger;
  const integrations = await integrationsForProject(
    options.integrations,
    binding.projectId,
    noRunScopedSecrets(),
  );
  const taskManagement = integrations.taskManagement;
  if (taskManagement === null || taskManagement.ref.integrationId !== binding.integrationId) {
    return { kind: 'unbound' };
  }
  const plan = taskManagement.port.pollPlan();
  if (plan === null) {
    return { kind: 'off' };
  }

  const cursor = await options.store.cursorOf(binding);
  // The window's start: the cursor, or the last interval for a first poll — minus the overlap
  // either way ({@link TICKET_POLL_OVERLAP_MS}), so a late-indexed ticket is read next time.
  const edge =
    cursor === null
      ? Date.parse(options.clock.now()) - plan.interval_seconds * 1000
      : Date.parse(cursor);
  const window = await pollWindow(
    (since, limit) =>
      ticketReads(integrations).matches(
        plan.rule,
        { since: new Date(since).toISOString(), limit },
        { projectId: binding.projectId, taskId: null },
      ),
    { edge, cursorKnown: cursor !== null, limit: options.limit ?? DEFAULT_TICKET_POLL_LIMIT },
  );
  const matches = window.matches;
  if (window.stalled) {
    logger.warn(
      {
        project_id: binding.projectId,
        integration_id: binding.integrationId,
        matched: matches.length,
        limit: window.limit,
        cursor,
      },
      'the ticket poll is stalled: more tickets than its widest page were updated just before its cursor, so it cannot reach anything newer (TICKET_POLL_MAX_LIMIT)',
    );
  }

  const rule = ticketMatchRuleText(plan.rule);
  let recorded = 0;
  let duplicates = 0;
  let skipped = 0;
  for (const raw of matches) {
    // Redacted **before** anything is built from it — the key, the row and the events alike — as a
    // webhook delivery is redacted before its normaliser reads it (BD-003: events are append-only).
    const redacted = taskManagement.redactor.redactJson({
      rule,
      match: raw as unknown as JsonObject,
    });
    const document = redacted.value as { rule: string; match: unknown };
    const parsed = ticketMatchSchema.safeParse(document.match);
    if (!parsed.success) {
      // Rule 20: one match that is not a match after redaction (a URL a placeholder broke, a
      // provider shape the schema refuses) is dropped by name rather than failing the whole poll —
      // a poll that threw on it would throw on it every interval, and the cursor would never move.
      skipped += 1;
      logger.warn(
        {
          project_id: binding.projectId,
          integration_id: binding.integrationId,
          path: parsed.error.issues[0]?.path.join('.') ?? '<root>',
        },
        'a polled ticket match failed the port schema after redaction and was not recorded',
      );
      continue;
    }
    const match = parsed.data;
    const deliveryId = polledDeliveryKey(taskManagement, binding.projectId, match);
    // Most of a window is tickets an earlier poll already recorded (the overlap, the minute Jira
    // rounds to, a widened page): one indexed read answers them without opening a transaction.
    if ((await options.recorder.inbox.find(taskManagement.ref.provider, deliveryId)) !== null) {
      duplicates += 1;
      continue;
    }
    const drafts = polledMatchDrafts(
      binding.projectId,
      binding.integrationId,
      document.rule,
      match,
    );
    const normalised: NormalisedDelivery[] = [{ events: [...drafts], ignored: [] }];
    const outcome = await recordNormalisedDelivery(
      { ...options.recorder, decisions: refusingDecisions, logger },
      {
        provider: taskManagement.ref.provider,
        deliveryId,
        integrationId: binding.integrationId,
        redactor: taskManagement.redactor,
        // A poll has no headers; the row says where it came from in its payload instead.
        headers: { value: {}, count: 0 },
        payload: {
          value: { source: 'poll', rule: document.rule, match: document.match } as JsonObject,
          count: redacted.count,
        },
        normalised,
        byProject: [{ projectId: binding.projectId, drafts }],
      },
    );
    if (outcome.kind === 'duplicate') {
      duplicates += 1;
    } else {
      recorded += 1;
    }
  }

  const latest = newest(matches);
  if (latest !== null) {
    await options.store.advanceCursor(binding, latest);
  }
  return {
    kind: 'polled',
    plan,
    matched: matches.length,
    recorded,
    duplicates,
    skipped,
    stalled: window.stalled,
    cursor: latest ?? cursor,
  };
};

export const enqueueTicketPoll = async (
  jobs: Jobs,
  job: TicketPollJob,
  options: { readonly startAfter?: Date } = {},
): Promise<void> => {
  await jobs.enqueue({
    queue: JOB_QUEUES.ticketPoll,
    data: job,
    singletonKey:
      job.kind === 'sweep'
        ? TICKET_POLL_SWEEP_KEY
        : ticketPollKey({
            projectId: job.project_id as Id,
            integrationId: job.integration_id as Id,
          }),
    ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
  });
};

/** One sweep: a poll enqueued for every polling binding — collapsed for a chain that is alive. */
export const runTicketPollSweep = async (
  options: TicketPollerOptions,
): Promise<{ readonly bindings: number }> => {
  const bindings = await options.store.listPolling(
    options.sweepLimit ?? DEFAULT_TICKET_POLL_SWEEP_LIMIT,
  );
  for (const binding of bindings) {
    await enqueueTicketPoll(options.jobs, {
      kind: 'poll',
      project_id: binding.projectId,
      integration_id: binding.integrationId,
    });
  }
  return { bindings: bindings.length };
};

const later = (clock: { now(): IsoDateTime }, ms: number): Date =>
  new Date(Date.parse(clock.now()) + ms);

/**
 * The queue's handler: a sweep, or one binding's poll. Both re-arm in a `finally` — a pass that
 * threw is a pass whose next pass must still happen — and a poll re-arms only when it learned a plan,
 * because a binding that is gone or switched off has no next poll (the sweep starts it again if it
 * is switched back on).
 */
export const ticketPollHandler = (options: TicketPollerOptions): JobHandler => {
  const logger = options.logger ?? silentLogger;
  return async (context) => {
    const job = ticketPollJobSchema.parse(context.data);
    if (job.kind === 'sweep') {
      try {
        await runTicketPollSweep(options);
      } finally {
        await enqueueTicketPoll(options.jobs, job, {
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
      const report = await pollTicketBinding(options, binding);
      if (report.kind === 'polled') {
        rearmMs = report.plan.interval_seconds * 1000;
        if (report.recorded > 0) {
          logger.info(
            {
              project_id: binding.projectId,
              integration_id: binding.integrationId,
              matched: report.matched,
              recorded: report.recorded,
              duplicates: report.duplicates,
            },
            'the ticket poll recorded matches as inbound deliveries',
          );
        }
      } else {
        logger.info(
          {
            project_id: binding.projectId,
            integration_id: binding.integrationId,
            reason: report.kind,
          },
          'the ticket poll chain ended: the binding no longer polls this integration',
        );
      }
    } catch (error) {
      // Rule 20: an inbound read that failed is retried by the next tick, never a reason to stop
      // polling. The interval is re-read from the plan when it can be; otherwise the sweep re-arms.
      rearmMs = await planIntervalMs(options, binding);
      throw error;
    } finally {
      if (rearmMs !== null) {
        await enqueueTicketPoll(
          options.jobs,
          { kind: 'poll', project_id: binding.projectId, integration_id: binding.integrationId },
          { startAfter: later(options.clock, rearmMs) },
        );
      }
    }
  };
};

/** The interval to re-arm a failed poll with, or `null` when the plan itself cannot be read. */
const planIntervalMs = async (
  options: TicketPollerOptions,
  binding: PolledBinding,
): Promise<number | null> => {
  try {
    const integrations = await integrationsForProject(
      options.integrations,
      binding.projectId,
      noRunScopedSecrets(),
    );
    const plan =
      integrations.taskManagement?.ref.integrationId === binding.integrationId
        ? integrations.taskManagement.port.pollPlan()
        : null;
    return plan === null ? null : plan.interval_seconds * 1000;
  } catch {
    // A binding that cannot even be loaded is the loader's refusal to report, which the failed
    // poll already did by throwing; the sweep re-arms it once it loads again.
    return null;
  }
};

/**
 * Declare the queue, start its worker, and put the first sweep on it. The worker is one more pooled
 * connection, counted in `POOL_RESERVATIONS.pipeline` (`apps/server/src/config.ts`).
 */
export const startTicketPoller = async (options: TicketPollerOptions): Promise<JobWorker> => {
  if (!(options.sweepIntervalMs > 0)) {
    throw new TypeError(`sweepIntervalMs must be positive, got ${options.sweepIntervalMs}`);
  }
  await options.jobs.defineQueue(jobQueueDefinition(JOB_QUEUES.ticketPoll));
  const worker = await options.jobs.work({
    queue: JOB_QUEUES.ticketPoll,
    handler: ticketPollHandler(options),
    concurrency: 1,
  });
  // Every process start re-establishes the sweep; `stately` collapses N replicas onto one.
  await enqueueTicketPoll(options.jobs, { kind: 'sweep' });
  return worker;
};
