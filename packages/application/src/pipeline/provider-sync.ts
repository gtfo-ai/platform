/**
 * **A ticket or a merge request out of sync is visible, never silent** — S-28.10, TD-029's
 * amendment C (2)–(3).
 *
 * AUT-6655 left twenty failed `transition_ticket` calls: Jira stayed at *Ready for Merge* beside a
 * **Draft** merge request, and nothing on the task page said so — a failed lifecycle move was a
 * `warn` log (decision 4) and `mr_ready` trusted its own write. This module is the one writer of
 * `task_provider_sync` (migration 0115):
 *
 * - {@link recordTicketStatusOutOfSync} — a lifecycle move failed: the slot, the status the
 *   platform wanted, the provider's reason (redacted and bounded), what the ticket showed when it
 *   was read after the failure and the statuses it could move to then (each `null` when the
 *   provider could not answer — never guessed). Every read here is best-effort: the record is
 *   written whatever they answer.
 * - {@link recordMergeRequestStillDraft} — `mr_ready` read the merge request back and it was still
 *   a draft.
 * - {@link clearOutOfSync} — a later move or read-back succeeded.
 *
 * The task read serves the rows as `provider_sync`, and the task page says them (*Ticket status out
 * of sync: Jira still says Ready for Merge; the platform wanted In Progress …*) with **Retry**,
 * which re-enqueues the same `ticket_lifecycle` duty (`retryTicketSyncCommand`, `./commands.ts`).
 */
import type { Id, ProviderSync, ProviderSyncSubject } from '@platform/contracts';
import { TransactionOpenError } from '../events/open-transaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { type PipelineIntegrations, ticketReads } from './integrations.js';
import type { StoredTask } from './store.js';
import type { TaskTransactionOptions } from './task-transaction.js';

/** The column bounds of `task_provider_sync` (migration 0115). */
export const PROVIDER_SYNC_TEXT_CHARS = 255;
export const PROVIDER_SYNC_REASON_CHARS = 2000;
export const PROVIDER_SYNC_AVAILABLE_MAX = 50;

const REASON_CODE_SHAPE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Cut to `max` characters, marking the cut; `null` for nothing left. */
const bounded = (text: string, max: number): string | null => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
};

/** The provider's reason, through the binding's redactor when there is one, and bounded. */
const reasonOf = (error: unknown, integrations: PipelineIntegrations | null): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = integrations?.taskManagement?.redactor.redactText(raw).value ?? raw;
  return bounded(redacted, PROVIDER_SYNC_REASON_CHARS) ?? 'the provider gave no reason';
};

/** The failure's code — platform vocabulary, never provider text. */
const reasonCodeOf = (error: unknown): string | null => {
  const code =
    error instanceof IntegrationError ? error.code : error instanceof Error ? error.name : null;
  return code !== null && REASON_CODE_SHAPE.test(code) ? code : null;
};

/** One provider text value the row keeps: redacted, bounded, `null` when empty. */
const providerText = (value: string, integrations: PipelineIntegrations): string | null =>
  bounded(
    integrations.taskManagement?.redactor.redactText(value).value ?? value,
    PROVIDER_SYNC_TEXT_CHARS,
  );

/** A best-effort read: its answer, or `null` when it failed (a transaction error still throws). */
const attempt = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (error instanceof TransactionOpenError) throw error;
    return null;
  }
};

/**
 * A lifecycle move failed: record it, with what the ticket showed and could move to then.
 * `integrations` is the resolution the move used, or `null` when resolving it was what failed.
 */
export const recordTicketStatusOutOfSync = async (
  options: TaskTransactionOptions,
  input: {
    readonly stored: StoredTask;
    readonly slot: string | undefined;
    readonly target: string;
    readonly error: unknown;
    readonly integrations: PipelineIntegrations | null;
  },
): Promise<void> => {
  const { stored, integrations } = input;
  const context = {
    projectId: stored.task.projectId,
    taskId: stored.task.id,
    mode: stored.task.mode,
  };
  let observed: string | null = null;
  let available: string[] | null = null;
  if (integrations !== null) {
    const reads = ticketReads(integrations);
    const ticket = await attempt(async () => reads.ticket(stored.task.ticket, context));
    observed = ticket === null ? null : providerText(ticket.status, integrations);
    const transitions = await attempt(async () => reads.transitions(stored.task.ticket, context));
    if (transitions !== null) {
      const names = new Set<string>();
      for (const transition of transitions) {
        const name = providerText(transition.to.name, integrations);
        if (name !== null) names.add(name);
      }
      available = [...names].slice(0, PROVIDER_SYNC_AVAILABLE_MAX);
    }
  }
  const slot = input.slot !== undefined && /^[a-z_]{1,64}$/.test(input.slot) ? input.slot : null;
  const failure: Omit<ProviderSync, 'attempts'> = {
    subject: 'ticket_status',
    slot,
    target:
      bounded(
        integrations === null ? input.target : (providerText(input.target, integrations) ?? ''),
        PROVIDER_SYNC_TEXT_CHARS,
      ) ?? 'the mapped status',
    observed,
    available,
    reason: reasonOf(input.error, integrations),
    reason_code: reasonCodeOf(input.error),
    failed_at: options.clock.now(),
  };
  await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.recordProviderSyncFailure(scope.tx, stored.task.id, failure),
  );
};

/** `mr_ready` read the merge request back and it is still a draft (amendment C (3)). */
export const recordMergeRequestStillDraft = async (
  options: TaskTransactionOptions,
  input: { readonly taskId: Id; readonly reason: string },
): Promise<void> => {
  await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.recordProviderSyncFailure(scope.tx, input.taskId, {
      subject: 'merge_request_draft',
      slot: null,
      target: 'ready',
      observed: 'draft',
      available: null,
      reason: bounded(input.reason, PROVIDER_SYNC_REASON_CHARS) ?? 'it is still a draft',
      reason_code: 'still_draft',
      failed_at: options.clock.now(),
    }),
  );
};

/** A later move or read-back succeeded: the subject is in sync again. */
export const clearOutOfSync = async (
  options: TaskTransactionOptions,
  taskId: Id,
  subject: ProviderSyncSubject,
  logger: Logger = options.logger ?? silentLogger,
): Promise<void> => {
  const cleared = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.clearProviderSync(scope.tx, taskId, subject),
  );
  if (cleared) {
    logger.info({ task_id: taskId, subject }, 'a subject that was out of sync is in sync again');
  }
};
