/**
 * product/04 S0's manual **"Start"** — a ticket a person names by its key (WP-122, PROGRESS backlog
 * 379).
 *
 * *"Trigger: task-management event (label added, status changed, epic membership, JQL match on poll)
 * or manual "Start" in UI."* Until WP-122 the second half had no route and no screen, and the board's
 * empty state told a user it existed.
 *
 * ## It records a match; intake does the rest
 *
 * The ruling is that the manual start bypasses **the pick-up rule and nothing else**. So this module
 * never creates a task: it appends the same `ticket.matched` a webhook or a poll appends, with
 * `rule: 'manual'`, and `pipeline.intake` (`saga.ts`) takes it from there exactly as it takes a rule
 * match — the one-task-per-ticket dedup, the protected-branch check, the classification of the
 * issue type onto a template, the WIP admission that queues a task the limits will not admit, and a
 * refused configuration's park (WP-106). A second copy of any of those here would be a second
 * spelling of one rule (standing rule 9), and the copy is the one that drifts.
 *
 * ## The shape: read outside, then one transaction
 *
 * - **Outside any transaction** it resolves the project's bindings and reads the ticket through the
 *   task-management binding and `IntegrationActionExecutor` (audited, rate-limited, refused inside
 *   a transaction — `ticketReads`, and this command marks every transaction it opens through
 *   `markTransactions`, so that refusal is armed here), which is the integration probe's shape.
 *   Nothing is held open across the provider's round trip.
 * - **In one transaction** it re-asks whether the ticket already has a task, appends the
 *   `ticket.matched` on the project stream and lets the caller write its `human_actions` row
 *   (`record`), so the audit and the event commit together or not at all. A lost race on the
 *   project stream is re-run in place (`appendOnProjectWithRetry`), which repeats only the
 *   transaction — never the provider read.
 *
 * ## The refusals, each typed and each read before anything is recorded
 *
 * - `no_task_management` — the project binds no task-management integration (`409`).
 * - `not_picked_up` — the project's autonomy dial does not pick up new tickets (Observe). Intake
 *   would drop the match without a word (`picksUpNewTickets`, one predicate for both), so the start
 *   refuses rather than answering `202` for a ticket nothing will start (standing rule 18). This one
 *   is the implementer's addition to the ruling's three, recorded under WP-122.
 * - `task_exists` — the ticket already has a task (`409`). Asked before the read and again inside
 *   the append's transaction; two concurrent starts that both pass are absorbed by intake's own
 *   `findByTicket`, which is the backstop the ruling names.
 * - `ticket_not_found` — the provider does not know the key (`404`).
 * - `outside_binding_scope` — the ticket is outside the binding's declared scope (Jira's
 *   `project_keys`), asked of the provider after the read (`409`, naming the scope). The pre-review
 *   round's addition: a scope is not the pick-up rule, so it is not bypassed.
 * - `ticket_unreadable` — the provider failed for any other reason. A mutation fails closed
 *   (standing rule 20): nothing is recorded, and the provider's words stay in the log, never in the
 *   answer.
 *
 * ## What it stores, and what it does not check
 *
 * The event carries the provider's **own** reference (`ticket.ref`, never the typed key) and the
 * fields a webhook match carries, all redacted by the binding's redactor **before** anything is
 * built from them — the poller's rule (`ticket-poll.ts`): events are append-only, so a credential
 * that reached one could never be taken out (BD-003). The ticket's text is not stored here; intake's
 * own read stores it as `tasks.ticket_snapshot`.
 *
 * **A moved ticket is a second key (residual, stated; review round 1).** Jira answers
 * `GET issue/OLD-1` for an issue moved to another project under its **new** key, `NEW-5`. The
 * scope is judged on `NEW-5`, which is right; but both one-task checks here and intake's
 * `unique (project_id, ticket_key, mode)` compare key strings, so a task created as `OLD-1` does
 * not stop a second under `NEW-5`. The webhook door has the same gap (a delivery after a move
 * carries the new key), so it predates this row; it is filed, not closed here.
 *
 * A binding's **scope filter** — Jira's `project_keys` — is consulted through the port's
 * `ticketScope`, after the read and before any write (see the refusal).
 */
import type { Id, IsoDateTime, JsonObject, TicketRef } from '@platform/contracts';
import { ticketMatchedEvent } from '@platform/contracts';
import { markTransactions, TransactionOpenError } from '../events/open-transaction.js';
import type { EventStore } from '../ports/event-store.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { Ticket, TicketRefInput } from '../ports/integrations/task-management.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import {
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrationsPort,
  ticketReads,
} from './integrations.js';
import { appendOnProjectWithRetry } from './project-stream.js';
import { type ProjectSettingsPort, picksUpNewTickets } from './settings.js';
import type { PipelineStore } from './store.js';

/** `ticket.matched.rule` for a ticket a person started by hand. */
export const MANUAL_START_RULE = 'manual';

/** `human_actions.action` for a manual start, and the `Idempotency-Key`'s scope. */
export const MANUAL_START_ACTION = 'task.start';

export type ManualStartRefusal =
  | 'no_task_management'
  | 'not_picked_up'
  | 'task_exists'
  | 'ticket_not_found'
  | 'outside_binding_scope'
  | 'ticket_unreadable';

/** A manual start the platform refused; nothing was recorded. */
export class ManualStartRefusedError extends Error {
  override readonly name = 'ManualStartRefusedError';
  readonly reason: ManualStartRefusal;
  /** The ticket's task, for `task_exists`; `null` otherwise. */
  readonly taskId: Id | null;

  constructor(reason: ManualStartRefusal, message: string, taskId: Id | null = null) {
    super(message);
    this.reason = reason;
    this.taskId = taskId;
  }
}

export interface ManualStartOptions {
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly store: Pick<PipelineStore, 'tasks'>;
  readonly settings: ProjectSettingsPort;
  readonly integrations: PipelineIntegrationsPort;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

/** What the caller's `record` is handed: the match it is about to commit beside. */
export interface ManualStartRecord {
  readonly eventId: Id;
  readonly ticket: TicketRef;
}

export interface ManualStartInput {
  readonly projectId: Id;
  /** The key a person typed, already held to `ticketKeyInputSchema` at the boundary. */
  readonly ticketKey: string;
  readonly userId: Id;
  /**
   * Writes the `human_actions` row **in the append's transaction** — the ruling's *"one
   * transaction"*. A throw rolls the match back with it.
   */
  readonly record: (scope: TransactionScope, started: ManualStartRecord) => Promise<void>;
}

/**
 * The reference the read is asked with. Every adapter addresses a ticket by its key (Jira's
 * `GET /issue/{key}`, the fake's map); the URL is unknown until the provider answers, and the event
 * carries the provider's own `ticket.ref`, never this one.
 */
const requestedRef = (provider: string, key: string): TicketRefInput => ({
  provider,
  key,
  url: 'https://ticket-not-read-yet.invalid/',
});

const existingTask = async (
  options: ManualStartOptions,
  scope: { readonly tx: TransactionScope['tx'] },
  query: { readonly projectId: Id; readonly provider: string; readonly ticketKey: string },
): Promise<Id | null> =>
  (await options.store.tasks.findByTicket(scope.tx, { ...query, mode: 'normal' }))?.task.id ?? null;

const taskExists = (key: string, taskId: Id): ManualStartRefusedError =>
  new ManualStartRefusedError(
    'task_exists',
    `ticket ${key} already has a task in this project (${taskId}); the platform starts one task per ticket`,
    taskId,
  );

/** The match's payload from the provider's answer — redacted before anything is built from it. */
const matchedPayload = (
  projectId: Id,
  ticket: Ticket,
  redactJson: (value: JsonObject) => { readonly value: JsonObject },
) => {
  const draft = {
    project_id: projectId,
    ticket: ticket.ref,
    rule: MANUAL_START_RULE,
    priority: ticket.priority ?? null,
    issue_type: ticket.issue_type,
    epic: ticket.epic?.key ?? null,
    links: ticket.links.map((link) => ({
      kind: link.kind,
      key: link.key,
      url: link.url ?? null,
    })),
  };
  return redactJson(draft as unknown as JsonObject).value as unknown as typeof draft;
};

/**
 * Reads the ticket and records it as matched by hand, or refuses by name.
 *
 * @throws {ManualStartRefusedError} for each refusal in the module note; nothing is recorded.
 * @throws {TransactionOpenError} when called inside a marked transaction, or if the read is ever
 * moved inside one of this command's own (each of which it marks) — the provider read refuses it.
 */
export const startTicketManually = async (
  options: ManualStartOptions,
  input: ManualStartInput,
): Promise<ManualStartRecord> => {
  const logger = options.logger ?? silentLogger;
  const { projectId, ticketKey } = input;
  /**
   * Every transaction this command opens is **marked** (review round 1): `assertOutsideTransaction`
   * — what `integrationsForProject` and `ticketReads` ask — sees only transactions opened through
   * `markTransactions`, and the unit of work a composition root hands in is the plain one. Without
   * this a later edit that moved the read inside one of the transactions below would hold a pooled
   * connection across the tracker's round trip and pass every test; with it, it throws
   * `TransactionOpenError`. The pipeline runtime does the same for the job path (`runtime.ts`).
   */
  const unitOfWork = markTransactions(options.unitOfWork);

  const settings = await options.settings.forProject(projectId);
  if (!picksUpNewTickets(settings)) {
    throw new ManualStartRefusedError(
      'not_picked_up',
      "this project's autonomy dial does not pick up new tickets (Observe), so a started ticket would never become a task; turn the dial up first",
    );
  }

  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const binding = integrations.taskManagement;
  if (binding === null) {
    throw new ManualStartRefusedError(
      'no_task_management',
      'this project binds no task-management integration, so there is no tracker to read the ticket from; bind one in the project settings',
    );
  }

  const before = await unitOfWork.transaction(async (scope) =>
    existingTask(options, scope, { projectId, provider: binding.ref.provider, ticketKey }),
  );
  if (before !== null) {
    throw taskExists(ticketKey, before);
  }

  let ticket: Ticket | null;
  try {
    ticket = await ticketReads(integrations).ticket(requestedRef(binding.ref.provider, ticketKey), {
      projectId,
      taskId: null,
    });
  } catch (error) {
    if (error instanceof TransactionOpenError) {
      throw error;
    }
    if (error instanceof IntegrationError && error.code === 'not_found') {
      throw new ManualStartRefusedError(
        'ticket_not_found',
        `the tracker has no ticket ${ticketKey} that this project's integration can read`,
      );
    }
    // The provider's own words go to the log (the executor redacted them), never to the caller.
    logger.warn(
      { project_id: projectId, ticket_key: ticketKey, err: error },
      'a manual start could not read its ticket, so nothing was recorded',
    );
    throw new ManualStartRefusedError(
      'ticket_unreadable',
      `the tracker could not be read for ${ticketKey}${
        error instanceof IntegrationError ? ` (${error.code})` : ''
      }, so nothing was recorded; try again in a moment`,
    );
  }
  if (ticket === null) {
    // `ticketReads.ticket` answers `null` only for a binding it does not have or a `platform`
    // reference — neither is reachable after the check above, so this is the same refusal.
    throw new ManualStartRefusedError(
      'ticket_not_found',
      `the tracker has no ticket ${ticketKey} that this project's integration can read`,
    );
  }

  /**
   * **The binding's declared scope is not the pick-up rule, and is not bypassed** (WP-122 pre-review
   * round). A binding may declare which of the provider's projects it reads — Jira's
   * `project_keys`, which the webhook applies to every delivery — and without this a member could
   * start a task from another team's ticket that the integration's account happens to be able to
   * read. The provider answers (`ticketScope`), so a provider with no scope concept is never
   * refused.
   *
   * Asked **after** the read and before any write, with the key **the provider answered**
   * (`ticket.ref.key`, Jira's canonical upper-case form) rather than the key a person typed, so a
   * typed `acme-7` is judged as Jira normalises it and exactly as the webhook judges a delivered
   * key. The ticket carries no project field, so the prefix of the canonical key is the read value
   * there is. The cost, stated: one audited read of a ticket that is then refused; nothing is stored.
   */
  const scope = binding.port.ticketScope(ticket.ref.key);
  if (scope.kind === 'out_of_scope') {
    throw new ManualStartRefusedError(
      'outside_binding_scope',
      `ticket ${ticketKey} is outside the projects this project's task-management integration reads (${scope.scope.join(', ')}); start it from the project bound to it`,
    );
  }

  const payload = matchedPayload(projectId, ticket, (value) => binding.redactor.redactJson(value));
  const occurredAt = options.clock.now() as IsoDateTime;
  return appendOnProjectWithRetry(
    { unitOfWork, eventStore: options.eventStore, logger },
    { projectId, writer: 'manual_start' },
    async (scope, streamSeq) => {
      const taskId = await existingTask(options, scope, {
        projectId,
        provider: payload.ticket.provider,
        ticketKey: payload.ticket.key,
      });
      if (taskId !== null) {
        throw taskExists(payload.ticket.key, taskId);
      }
      const event = ticketMatchedEvent.parse({
        id: options.ids.next(),
        stream_type: 'project',
        stream_id: projectId,
        stream_seq: streamSeq,
        correlation_id: null,
        cause_event_id: null,
        actor: { kind: 'user', user_id: input.userId },
        occurred_at: occurredAt,
        type: 'ticket.matched',
        payload,
      });
      await scope.events.append([event]);
      const started: ManualStartRecord = { eventId: event.id as Id, ticket: event.payload.ticket };
      await input.record(scope, started);
      return started;
    },
  );
};
