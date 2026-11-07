/**
 * **Is anybody still waiting for this notification?** — the one re-check the notify duty, the
 * recovery pass's re-post and the digest share (WP-84 and its review rounds 1 and 2, PROGRESS
 * backlog 292).
 *
 * A `question` asks a person to answer; a `reminder` asks again; an `approval` asks for a decision.
 * Each is worth sending only while its aggregate still waits — an answered or expired question, a
 * decided or expired approval, makes the message a request for something already done. The first
 * attempt runs minutes after the event, a re-post up to the re-post window later, and a
 * digest-planned row the next morning, so all three ask here, and a row that fails the check is
 * closed **withheld** (`NotificationStore.markWithheld`) rather than left undelivered: it was
 * correctly not sent, which is neither a delivery nor a loss.
 */
import type { Id, NotificationClass } from '@platform/contracts';
import type { PipelineStore } from '../pipeline/store.js';
import type { Transaction } from '../ports/transaction.js';
import type { StoredNotification } from './ports.js';

export interface WaitingAggregate {
  readonly aggregate: 'question' | 'approval';
  readonly id: Id;
}

/**
 * Which aggregate a recorded row waits on: `null` for a class nobody answers (it is sent as it is),
 * `'unknown'` for a class that asks somebody something but whose row names no aggregate — a row a
 * pre-WP-84 build wrote, or one whose question row was deleted (`on delete set null`).
 */
export const waitingAggregateOfRow = (
  row: Pick<StoredNotification, 'notificationClass' | 'questionId' | 'approvalId'>,
): WaitingAggregate | 'unknown' | null => {
  if (!asksSomebody(row.notificationClass)) {
    return null;
  }
  if (row.questionId !== null && row.notificationClass !== 'approval') {
    return { aggregate: 'question', id: row.questionId };
  }
  if (row.approvalId !== null && row.notificationClass !== 'question') {
    return { aggregate: 'approval', id: row.approvalId };
  }
  return 'unknown';
};

/** The classes that ask a person for something, and so go stale when it is done. */
export const asksSomebody = (notificationClass: NotificationClass): boolean =>
  notificationClass === 'question' ||
  notificationClass === 'reminder' ||
  notificationClass === 'approval';

/**
 * Still open (a question) or still pending (an approval), read inside the caller's transaction.
 *
 * **A reminder about an approval also needs its task still waiting for it** (S-27.1, BACKLOG 1480):
 * an approval is not reminded about while its task is paused, so a reminder raised just before a
 * pause is withheld when it would be posted, and the resume back into the wait arms the next one.
 */
export const isStillWaiting = async (
  store: Pick<PipelineStore, 'questions' | 'approvals' | 'tasks'>,
  tx: Transaction,
  waiting: WaitingAggregate,
  notificationClass?: NotificationClass,
): Promise<boolean> => {
  if (waiting.aggregate === 'question') {
    return (await store.questions.load(tx, waiting.id))?.status === 'open';
  }
  const stored = await store.approvals.load(tx, waiting.id);
  if (stored?.approval.status !== 'pending') {
    return false;
  }
  if (notificationClass !== 'reminder') {
    return true;
  }
  return (await store.tasks.load(tx, stored.approval.taskId))?.task.state === 'waiting_approval';
};
