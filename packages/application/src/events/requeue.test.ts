/**
 * The re-queue command (WP-95, PROGRESS backlog 126) against a fake store: one accepted state,
 * three refusals, and the wake-up published only for the accepted one.
 *
 * The store's own statement — the conditional update that is the arbiter between two re-queues and
 * between a re-queue and a sweep — is a fact about PostgreSQL and is asserted there
 * (`test/integration/events/dead-letter-requeue.integration.test.ts`); what is asserted here is the
 * mapping from the row's state to the command's answer, which is the part a route depends on.
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EVENTS_APPENDED_TOPIC } from '../ports/broadcast.js';
import type {
  DeadLetterRequeueOutcome,
  DeadLetterRow,
  DeadLetterStore,
} from '../ports/dead-letters.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createDeadLetterCommands, DeadLetterRequeueRefusedError } from './requeue.js';

const ROW: DeadLetterRow = {
  position: 41,
  eventType: 'task.queued',
  streamType: 'task',
  streamId: '00000000-0000-4000-8000-000000000041' as Id,
  occurredAt: '2026-09-29T08:00:00.000Z',
  deadLetteredAt: '2026-09-29T08:20:00.000Z',
  handler: 'core.poison',
  attempts: 10,
  error: 'deterministic',
  task: null,
};

const world = (outcome: DeadLetterRequeueOutcome) => {
  const eventing = new MemoryEventing();
  const wakeUps: string[] = [];
  const asked: number[] = [];
  const store: DeadLetterStore = {
    list: async () => ({ items: [ROW], total: 1 }),
    requeue: async (_tx, position) => {
      asked.push(position);
      return outcome;
    },
  };
  return {
    commands: createDeadLetterCommands({ unitOfWork: eventing, store }),
    wakeUps,
    asked,
    listen: async () =>
      eventing.broadcast.subscribe([EVENTS_APPENDED_TOPIC], (message) => {
        wakeUps.push(message.topic);
      }),
  };
};

describe('createDeadLetterCommands', () => {
  it('re-queues a dead-lettered row, answers it as it was, and wakes a dispatcher once', async () => {
    const setup = world({ status: 'requeued', row: ROW, requeuedAt: '2026-09-30T09:00:00.000Z' });
    await setup.listen();
    const result = await setup.commands.requeue(41);
    expect(result).toEqual({ row: ROW, requeuedAt: '2026-09-30T09:00:00.000Z' });
    expect(setup.asked).toEqual([41]);
    expect(setup.wakeUps).toEqual([EVENTS_APPENDED_TOPIC]);
  });

  it.each([
    ['pending', 'not_dead_lettered'],
    ['dispatched', 'already_dispatched'],
    ['unknown', 'unknown_event'],
  ] as const)('refuses a row that is %s as %s and wakes nobody', async (status, refusal) => {
    const setup = world({ status });
    await setup.listen();
    const attempt = setup.commands.requeue(41);
    await expect(attempt).rejects.toBeInstanceOf(DeadLetterRequeueRefusedError);
    await expect(attempt).rejects.toMatchObject({ position: 41, refusal });
    // The refusal names the position, so an operator reading the 409 knows which row it is about.
    await expect(attempt).rejects.toThrow(/41/);
    expect(setup.wakeUps).toEqual([]);
  });

  it('lists through the store unchanged, total included', async () => {
    const setup = world({ status: 'unknown' });
    expect(await setup.commands.list({ limit: 10 })).toEqual({ items: [ROW], total: 1 });
  });
});
