/**
 * **The ticket claim** — BD-031 ruling 5, TD-029 decision 5, technical/02's M10-head amendment
 * (WP-177).
 *
 * Before an **agent** run is admitted, on a binding whose `lifecycle` block claims, the platform
 * assigns the ticket to the binding's own account, moves it to the `in_progress` slot when that is
 * mapped, re-reads the ticket, and starts the run only when the re-read shows that account holding
 * it. Somebody else holding it escalates the task to `needs_human` with the reason
 * `ticket_assigned_elsewhere` and one ticket comment opened by the marker
 * `agentic:claim-refused:<task>`; a refused claim write escalates with `ticket_claim_failed` and a
 * brief naming the permission the assign needs. **No run row exists** after either refusal.
 *
 * ## Where it runs, and why there
 *
 * In the `stage.execute` job, between its transactions, beside `ensureTicketSnapshot` and before
 * the stage executor creates the run row and asks the admission guard (`stage-executor.ts`). The
 * claim is **not an aggregate transition** (technical/02): it is a precondition of admission, and
 * the job path is the one place that is both outside every transaction — so the provider calls are
 * allowed (WP-15d) — and ordered before the run. Gates claim nothing. A WIP-queued task holds no
 * ticket, which is why the claim is not intake's (TD-029's alternatives).
 *
 * ## When it acts
 *
 * Only when the task names a provider ticket, the project's binding has a `lifecycle` block whose
 * `claim` is not `false` (TD-029 decision 1: a binding with no block behaves exactly as before),
 * and the task's claim is absent, stale or released (`ticketClaimNeeded`). A held claim costs one
 * row read per agent stage and no provider call.
 *
 * ## What it records
 *
 * `tasks.ticket_claim` through the narrow `TaskRepository.saveTicketClaim`, and `ticket.claimed`
 * on the task's stream in the same transaction; a refusal records `ticket.claim.refused` beside the
 * escalation's own events. In shadow mode the writes are `would_have` (the executor's rule), the
 * re-read is skipped — the ticket was never assigned, so its assignee says nothing about a race —
 * and the claim is recorded `shadow`, never `confirmed`; the run proceeds.
 *
 * ## Failures
 *
 * - The `in_progress` move failing does not refuse the claim: it is a lifecycle write, and a
 *   failed lifecycle write never blocks a stage (TD-029 decision 4); it is logged, and the claim
 *   records `in_progress_written: false`.
 * - A provider that is **unavailable or rate-limited** past the executor's own retries throws, so
 *   the job's retry policy and the stranded-stage recovery own it (`JOB_EXHAUSTION`'s
 *   `stage.execute` row) — a tracker outage does not park every task on a person.
 * - Every other `IntegrationError` (a refused permission, an unknown ticket, a provider that cannot
 *   assign) is `ticket_claim_failed`: no retry fixes it, and only a person can.
 * - A `TransactionOpenError` and anything that is not an `IntegrationError` is rethrown: those are
 *   programming errors, not a tracker's answer.
 */
import type {
  DomainEvent,
  ExternalIdentity,
  Id,
  Slug,
  StoredTicketClaim,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import {
  type ClaimReadback,
  claimReadback,
  claimRefusedCommentMarker,
  compilePipeline,
  isRunnableTaskState,
  lifecycleClaims,
  ticketClaimIsFirst,
  ticketClaimNeeded,
} from '@platform/domain';
import { TransactionOpenError } from '../events/open-transaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { BindingLifecycle } from './binding-lifecycle.js';
import {
  integrationsForProject,
  namesAProviderTicket,
  noRunScopedSecrets,
  type PipelineIntegrations,
  ticketReads,
  ticketWrites,
} from './integrations.js';
import type { OutboundJobData } from './jobs.js';
import { PIPELINE_ACTOR, type StoredTask } from './store.js';
import { inTaskTransaction, type TaskTransactionOptions } from './task-transaction.js';
import { releaseTicket } from './ticket-release.js';
import { applyDecision } from './transitions.js';

/** The two reasons a claim refuses (technical/02's catalogue, `ticketClaimRefusalSchema`). */
export type TicketClaimRefusal = 'ticket_assigned_elsewhere' | 'ticket_claim_failed';

/** What the `stage.execute` job does next. */
export type TicketClaimOutcome =
  | { readonly kind: 'proceed' }
  /** The task was escalated (or had already moved on); no run is started. */
  | { readonly kind: 'refused'; readonly reason: TicketClaimRefusal };

/** The stage entry the claim admits — the idempotency keys' identity. */
export interface TicketClaimRequest {
  readonly taskId: Id;
  readonly stage: Slug;
  readonly attempt: number;
}

const PROCEED: TicketClaimOutcome = { kind: 'proceed' };

/** The permission the brief names when the provider declares none (`TaskManagementBinding`). */
const GENERIC_ASSIGN_PERMISSION = 'the permission to assign tickets';

/**
 * The claim — see the module docblock. Called with the task the job's first transaction loaded,
 * for an agent stage only.
 */
export const ensureTicketClaim = async (
  options: TaskTransactionOptions,
  stored: StoredTask,
  request: TicketClaimRequest,
): Promise<TicketClaimOutcome> => {
  const { task } = stored;
  if (!namesAProviderTicket(task.ticket)) {
    return PROCEED;
  }
  const settings = await options.settings.forProject(task.projectId);
  const lifecycle = settings.ticketLifecycle;
  if (lifecycle === null || !lifecycleClaims(lifecycle.slots)) {
    return PROCEED;
  }
  const read = await options.unitOfWork.transaction(async (scope) =>
    (await canStillRun(options, scope.tx, request))
      ? { claim: await options.store.tasks.ticketClaim(scope.tx, task.id) }
      : null,
  );
  if (read === null) {
    // The executor's own re-validation skips this wake-up and says why; the claim touches nothing
    // (TD-029 decision 5's WP-177 amendment (b)).
    return PROCEED;
  }
  if (!ticketClaimNeeded(read.claim)) {
    return PROCEED;
  }
  /**
   * **A Rework's release, then the claim — in this job, in that order** (WP-178 criterion (17)
   * (i), PROGRESS backlog 541). The *Rework* command marks the claim stale with `stale_cause:
   * 'rework'` and enqueues nothing; the release runs here, on the task's `stage.execute` path, so a
   * re-claim can no longer land between the release's check and its `unassign` and be undone by it.
   * The release then reads the claim released, and the claim below is a first one (amendment (c)).
   */
  let claimNow = read.claim;
  if (
    claimNow?.stale === true &&
    claimNow.stale_cause === 'rework' &&
    claimNow.released_at === null
  ) {
    await releaseTicket(options, {
      taskId: task.id,
      cause: 'rework',
      // One release per stage entry: a redelivered job replays its writes.
      keySuffix: `rework:${request.stage}:${String(request.attempt)}`,
      causeEventId: null,
    });
    claimNow = await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.ticketClaim(scope.tx, task.id),
    );
  }
  /**
   * A first claim reads before it writes (the amendment's (a)); only a claim stale for a **human
   * return** takes the ticket back. A claim the platform **released** (a Rework, a cancellation)
   * counts as first (the amendment's (c)): the release put the ticket back in the pick-up pool, so a
   * person who holds it afterwards took it from there and is never overwritten — and so, since
   * WP-178, does a claim stale because its task **stopped** between the assign and the record,
   * whether or not its `stopped` release ran (`ticketClaimIsFirst`, PROGRESS backlog 543).
   */
  const first = ticketClaimIsFirst(claimNow);
  // Outside a run: the claim holds no minted credential (Q55).
  const integrations = await integrationsForProject(
    options.integrations,
    task.projectId,
    noRunScopedSecrets(),
  );
  if (integrations.taskManagement === null) {
    return PROCEED;
  }

  let attempt: ClaimAttempt;
  try {
    attempt = await claim(options, integrations, stored, lifecycle, request, first);
  } catch (error) {
    if (
      error instanceof TransactionOpenError ||
      !(error instanceof IntegrationError) ||
      error.retryable
    ) {
      throw error;
    }
    (options.logger ?? silentLogger).warn(
      {
        task_id: task.id,
        stage: request.stage,
        code: error.code,
        action: error.action,
        err: error,
      },
      'the tracker refused the ticket claim; the task is escalated and no run starts',
    );
    return refuse(options, integrations, stored, request, {
      reason: 'ticket_claim_failed',
      assignee: null,
      code: error.code,
    });
  }

  if (attempt.readback.kind === 'elsewhere') {
    (options.logger ?? silentLogger).warn(
      { task_id: task.id, stage: request.stage },
      'the ticket is assigned to somebody other than the binding’s own account; the task is escalated and no run starts',
    );
    return refuse(options, integrations, stored, request, {
      reason: 'ticket_assigned_elsewhere',
      assignee: attempt.readback.assignee,
      code: null,
    });
  }
  await recordClaim(options, stored, request, attempt);
  return PROCEED;
};

/**
 * **Only a task that can still run claims** (TD-029 decision 5, WP-177 amendment (b)): the
 * executor's own re-validation questions (`revalidateOpen` in `stage-executor.ts`) — the state is
 * runnable, the stage and its attempt are the job's, the attempt's stage row is not closed. A task
 * cancelled, paused or escalated after the job was enqueued makes no tracker call, so no claim is
 * left on a task whose release has already run.
 */
const canStillRun = async (
  options: TaskTransactionOptions,
  tx: Transaction,
  request: TicketClaimRequest,
): Promise<boolean> => {
  const current = await options.store.tasks.load(tx, request.taskId);
  if (
    current === null ||
    !isRunnableTaskState(current.task.state) ||
    current.task.currentStage !== request.stage ||
    (current.task.stageAttempts[request.stage] ?? 0) !== request.attempt
  ) {
    return false;
  }
  return (
    (await options.store.tasks.stageAttemptState(
      tx,
      request.taskId,
      request.stage,
      request.attempt,
    )) !== 'closed'
  );
};

interface ClaimAttempt {
  readonly self: ExternalIdentity;
  readonly inProgressWritten: boolean;
  readonly shadow: boolean;
  readonly readback: ClaimReadback;
}

/**
 * The steps of TD-029 decision 5: who am I (and, on a **first** claim, who holds the ticket now —
 * the WP-177 amendment (a)), assign, `in_progress`, re-read.
 */
const claim = async (
  options: TaskTransactionOptions,
  integrations: PipelineIntegrations,
  stored: StoredTask,
  lifecycle: BindingLifecycle,
  request: TicketClaimRequest,
  first: boolean,
): Promise<ClaimAttempt> => {
  const { task } = stored;
  const context = { projectId: task.projectId, taskId: task.id };
  const shadow = task.mode === 'shadow';
  const self = await ticketReads(integrations).selfIdentity(context);
  if (self === null) {
    // `integrations.taskManagement` was checked by the caller; a null here is a port that
    // answered nothing, which the claim cannot compare with anybody.
    throw new IntegrationError(
      'invalid_response',
      integrations.taskManagement?.ref.provider ?? 'unknown',
      'the binding answered no account of its own',
      { action: 'self_identity' },
    );
  }
  /**
   * **A first claim never overwrites a person** (amendment (a), BD-031 ruling 5): the assignee is
   * read before the assign, and somebody else holding the ticket refuses without writing — unless
   * the binding takes assigned tickets. A re-claim (a stale claim after a human return) takes the
   * ticket back, because the person who returned it may well hold it. A shadow task skips the
   * question: it writes nothing anyway, and shadow mode runs beside the person who holds the ticket.
   */
  if (first && !shadow && lifecycle.slots.take_assigned_tickets !== true) {
    const before = await ticketReads(integrations).ticket(task.ticket, context);
    const holder = before?.assignee ?? null;
    if (holder !== null && claimReadback(self, holder).kind === 'elsewhere') {
      return {
        self,
        inProgressWritten: false,
        shadow,
        readback: { kind: 'elsewhere', assignee: holder },
      };
    }
  }
  // One key per stage entry: a redelivered job replays the write, a later entry claims afresh.
  const entry = `${task.id}:${request.stage}:${String(request.attempt)}`;
  const writeContext = { ...context, mode: task.mode, causeEventId: null };
  await ticketWrites(integrations).assignToSelf(task.ticket, {
    ...writeContext,
    idempotencyKey: `ticket_claim_assign:${entry}`,
    self,
  });
  const inProgressWritten = await moveToInProgress(
    options,
    integrations,
    stored,
    lifecycle,
    `ticket_claim_in_progress:${entry}`,
  );
  if (shadow) {
    return { self, inProgressWritten, shadow, readback: { kind: 'held' } };
  }
  const reread = await ticketReads(integrations).ticket(task.ticket, context);
  return {
    self,
    inProgressWritten,
    shadow,
    readback: claimReadback(self, reread?.assignee ?? null),
  };
};

/** Step 3: the `in_progress` slot, when mapped. A failure is logged and never refuses the claim. */
const moveToInProgress = async (
  options: TaskTransactionOptions,
  integrations: PipelineIntegrations,
  stored: StoredTask,
  lifecycle: BindingLifecycle,
  idempotencyKey: string,
): Promise<boolean> => {
  const status = lifecycle.slots.in_progress;
  if (status === undefined) {
    return false;
  }
  const { task } = stored;
  try {
    const moved = await ticketWrites(integrations).transition(task.ticket, status, {
      projectId: task.projectId,
      taskId: task.id,
      mode: task.mode,
      causeEventId: null,
      idempotencyKey,
    });
    // A shadow task's move is `would_have`: not written.
    return moved !== null && task.mode !== 'shadow';
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    (options.logger ?? silentLogger).warn(
      { task_id: task.id, slot: 'in_progress', err: error },
      'the claim could not move the ticket to the in_progress slot; the claim stands and the stage runs',
    );
    return false;
  }
};

/** The claim held: the record and `ticket.claimed`, in one transaction on the task's stream. */
const recordClaim = async (
  options: TaskTransactionOptions,
  stored: StoredTask,
  request: TicketClaimRequest,
  attempt: ClaimAttempt,
): Promise<void> => {
  const { task } = stored;
  const record: StoredTicketClaim = {
    account_id: attempt.self.external_id.slice(0, 255),
    claimed_at: options.clock.now() as StoredTicketClaim['claimed_at'],
    status: attempt.shadow ? 'shadow' : 'confirmed',
    in_progress_written: attempt.inProgressWritten,
    stale: false,
    released_at: null,
    release_cause: null,
    stale_cause: null,
  };
  const stopped = await inTaskTransaction(
    options,
    task.id,
    'recording the ticket claim',
    async (scope) => {
      // The row lock first, so the sequence read below is the committed one (`bumpVersion`).
      await options.store.tasks.bumpVersion(scope.tx, task.id);
      const current = await options.store.tasks.load(scope.tx, task.id);
      if (current === null) {
        return null;
      }
      /**
       * Asked again under the row lock (amendments (b) and (c)): a task that stopped while the tracker
       * answered starts no run (the executor skips it). A shadow claim assigned nothing, so nothing
       * is recorded. A real assign is **not left behind**: the claim is recorded **stale** — the token
       * the release reads, which only a later re-claim clears — and a `ticket_release` (cause
       * `stopped`) is enqueued after this commit; it unassigns only while the ticket is still the
       * binding's own, and does nothing once a resumed task has claimed again.
       */
      if (!(await canStillRun(options, scope.tx, request))) {
        (options.logger ?? silentLogger).warn(
          { task_id: task.id, stage: request.stage, shadow: attempt.shadow },
          'the task stopped while the ticket was being claimed; no claim is held, and a real assign is released',
        );
        if (attempt.shadow) {
          return null;
        }
        // `stale_cause: 'stopped'` (WP-178, backlog 543): the next claim is a first claim even if
        // this release is lost, so a person who took the ticket meanwhile is never overwritten.
        await options.store.tasks.saveTicketClaim(scope.tx, task.id, {
          ...record,
          stale: true,
          stale_cause: 'stopped',
        });
        return 'stopped' as const;
      }
      await options.store.tasks.saveTicketClaim(scope.tx, task.id, record);
      const event = domainEventSchemasByType['ticket.claimed'].parse({
        id: options.ids.next(),
        stream_type: 'task',
        stream_id: task.id,
        stream_seq: current.task.sequence,
        correlation_id: task.id,
        cause_event_id: null,
        actor: PIPELINE_ACTOR,
        occurred_at: options.clock.now(),
        type: 'ticket.claimed',
        payload: {
          project_id: task.projectId,
          task_id: task.id,
          ticket: { ...current.task.ticket },
          account_id: record.account_id,
          in_progress_written: record.in_progress_written,
          shadow: attempt.shadow,
        },
      }) as DomainEvent;
      await scope.events.append([event]);
      return null;
    },
  );
  if (stopped === 'stopped') {
    // After the commit, as every enqueue (TD-004): the claim the duty reads is committed first.
    // `releaseRequest`'s shape (`ticket-lifecycle.ts`), written out here because importing it
    // (or `enqueueOutbound`) from there closes a module cycle through `jobs.ts`.
    await options.jobs.enqueue<OutboundJobData>({
      queue: JOB_QUEUES.pipelineOutbound,
      data: {
        duty: 'ticket_release',
        project_id: task.projectId,
        task_id: task.id,
        // No event caused it: a fresh id is the wake-up's identity (its idempotency keys).
        cause_event_id: options.ids.next(),
        release_cause: 'stopped',
      },
    });
  }
};

/** The platform's own words for a refusal: the escalation's brief. No provider text but the key. */
const refusalBrief = (
  stored: StoredTask,
  stage: Slug,
  refusal: { readonly reason: TicketClaimRefusal; readonly code: string | null },
  assignPermission: string,
): string => {
  const key = stored.task.ticket.key;
  if (refusal.reason === 'ticket_assigned_elsewhere') {
    return (
      `The platform did not start the "${stage}" stage of ${key}: the ticket is assigned to somebody other than the account this project's tracker binding uses, ` +
      'and two workers on one ticket is what the claim prevents. Agree with the assignee who takes it; to let the agent work it, unassign the ticket ' +
      'or assign it to the binding’s account, then hand the task back.'
    );
  }
  return (
    `The platform could not claim ${key} before the "${stage}" stage: the tracker refused the claim (${refusal.code ?? 'unknown'}). ` +
    `Give the account this project's tracker binding uses ${assignPermission === GENERIC_ASSIGN_PERMISSION ? assignPermission : `the "${assignPermission}" permission`}, ` +
    "or set claim: false in the binding's lifecycle block, then hand the task back."
  );
};

/** The ticket comment a `ticket_assigned_elsewhere` refusal posts. Platform text only. */
export const CLAIM_REFUSED_COMMENT =
  'The agent did not start work on this ticket: it is assigned to somebody else. A maintainer has been asked who should take it.';

/**
 * A refusal: the escalation and `ticket.claim.refused` in one transaction, then — for a ticket held
 * elsewhere — the one ticket comment, outside it. A task that moved on meanwhile is left alone.
 */
const refuse = async (
  options: TaskTransactionOptions,
  integrations: PipelineIntegrations,
  stored: StoredTask,
  request: TicketClaimRequest,
  refusal: {
    readonly reason: TicketClaimRefusal;
    readonly assignee: ExternalIdentity | null;
    readonly code: string | null;
  },
): Promise<TicketClaimOutcome> => {
  const { task } = stored;
  const blockerBrief = refusalBrief(
    stored,
    request.stage,
    refusal,
    integrations.taskManagement?.assignPermission ?? GENERIC_ASSIGN_PERMISSION,
  );
  const escalated = await inTaskTransaction(
    options,
    task.id,
    'refusing the ticket claim',
    async (scope) => {
      const current = await options.store.tasks.load(scope.tx, task.id);
      if (
        current === null ||
        current.task.currentStage !== request.stage ||
        !isRunnableTaskState(current.task.state) ||
        (await options.store.tasks.stageAttemptState(
          scope.tx,
          task.id,
          request.stage,
          request.attempt,
        )) === 'closed'
      ) {
        return null;
      }
      // The refusal first on the stream, the escalation it causes after it.
      const refused = domainEventSchemasByType['ticket.claim.refused'].parse({
        id: options.ids.next(),
        stream_type: 'task',
        stream_id: task.id,
        stream_seq: current.task.sequence,
        correlation_id: task.id,
        cause_event_id: null,
        actor: PIPELINE_ACTOR,
        occurred_at: options.clock.now(),
        type: 'ticket.claim.refused',
        payload: {
          project_id: task.projectId,
          task_id: task.id,
          ticket: { ...current.task.ticket },
          reason: refusal.reason,
          assignee: refusal.assignee,
        },
      }) as DomainEvent;
      const after: StoredTask = {
        ...current,
        task: { ...current.task, sequence: current.task.sequence + 1 },
      };
      const applied = await applyDecision({
        store: options.store,
        pipeline: compilePipeline(
          current.task.template,
          current.template,
          current.pipelineDial,
          current.qaStage,
        ),
        tx: scope.tx,
        stored: after,
        decision: { kind: 'escalate', reason: refusal.reason, blockerBrief },
        escalationOutcome: refusal.reason,
        context: {
          ids: options.ids,
          actor: PIPELINE_ACTOR,
          clock: options.clock as never,
          correlationId: task.id,
          causeEventId: null,
        },
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append([refused, ...applied.events]);
      return true;
    },
  );
  if (escalated === true && refusal.reason === 'ticket_assigned_elsewhere') {
    await postRefusalComment(options, integrations, stored, request);
  }
  return { kind: 'refused', reason: refusal.reason };
};

/** The one comment, keyed by the stage entry so a redelivered job replays it. Fails open. */
const postRefusalComment = async (
  options: TaskTransactionOptions,
  integrations: PipelineIntegrations,
  stored: StoredTask,
  request: TicketClaimRequest,
): Promise<void> => {
  const { task } = stored;
  try {
    await ticketWrites(integrations).claimRefusedComment(task.ticket, CLAIM_REFUSED_COMMENT, {
      projectId: task.projectId,
      taskId: task.id,
      mode: task.mode,
      idempotencyKey: `ticket_claim_refused:${task.id}:${request.stage}:${String(request.attempt)}`,
      markerId: claimRefusedCommentMarker(task.id),
    });
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    // A notification: the escalation is recorded and a person is told on the task page.
    (options.logger ?? silentLogger).warn(
      { task_id: task.id, err: error },
      'the claim refusal’s ticket comment could not be posted; the escalation stands',
    );
  }
};
