/**
 * **Out of sync, and when it stops being** (S-28.10 review): a person's **Retry** re-validates on
 * fire and never moves a ticket a later move already moved; a finished task's record is refused as
 * history; and a `merge_request_draft` record does not outlive the draft once the merge request is
 * merged. The stubs answer only what each path may ask — a path that asked for more would throw.
 */
import type { Id, ProviderSync } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { Jobs } from '../ports/jobs.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { retryTicketSyncCommand, TicketSyncTaskFinishedError } from './commands.js';
import type { PipelineOutboundData } from './jobs.js';
import { mergeRequestReadyHandlers } from './merge-request-ready.js';
import { RETRY_KEY_PREFIX, runTicketLifecycle } from './ticket-lifecycle.js';

const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;

const ROW: ProviderSync = {
  subject: 'ticket_status',
  slot: 'in_progress',
  target: 'In Progress',
  observed: 'Ready for Merge',
  available: ['Released'],
  reason: 'no transition to In Progress',
  reason_code: 'invalid_request',
  failed_at: '2026-11-10T09:00:00.000Z',
  attempts: 3,
};

describe('a Retry re-validates on fire (S-28.10 review)', () => {
  const retryData = (status: string): PipelineOutboundData => ({
    duty: 'ticket_lifecycle',
    project_id: PROJECT,
    task_id: TASK,
    cause_event_id: '00000000-0000-4000-9000-0000000000e1',
    status,
    lifecycle_slot: 'in_progress',
    lifecycle_key: `${RETRY_KEY_PREFIX}${TASK}:00000000-0000-4000-9000-0000000000e1`,
  });

  /** The store answers the record, and throws on anything a skipped retry must not reach. */
  const optionsWith = (rows: readonly ProviderSync[]) => {
    const asked: string[] = [];
    const options = {
      unitOfWork: new MemoryEventing(),
      store: {
        tasks: {
          providerSync: async () => rows,
          load: async () => {
            asked.push('load');
            throw new Error('the retry went on to move the ticket');
          },
        },
      },
    };
    return { options: options as never, asked };
  };

  it('moves nothing once a later move cleared the record', async () => {
    const { options, asked } = optionsWith([]);
    await runTicketLifecycle(options, retryData('In Progress'));
    expect(asked).toEqual([]);
  });

  it('moves nothing when the record now names another status', async () => {
    const { options, asked } = optionsWith([{ ...ROW, target: 'Done' }]);
    await runTicketLifecycle(options, retryData('In Progress'));
    expect(asked).toEqual([]);
  });

  it('goes on to the move while the record still names the status', async () => {
    const { options, asked } = optionsWith([ROW]);
    await expect(runTicketLifecycle(options, retryData('In Progress'))).rejects.toThrow(
      'the retry went on to move the ticket',
    );
    expect(asked).toEqual(['load']);
  });
});

describe('a finished task’s record is history (S-28.10 review)', () => {
  it('refuses a Retry on a done task, and enqueues nothing', async () => {
    const enqueued: unknown[] = [];
    const deps = {
      unitOfWork: new MemoryEventing(),
      store: {
        tasks: {
          load: async () => ({ task: { id: TASK, projectId: PROJECT, state: 'done' } }),
          providerSync: async () => [ROW],
        },
      },
      jobs: {
        enqueue: async (job: unknown) => {
          enqueued.push(job);
        },
      } as unknown as Jobs,
      context: () => ({ ids: { next: () => '00000000-0000-4000-9000-0000000000e2' } }),
    } as never;
    await expect(
      retryTicketSyncCommand(deps, { taskId: TASK, userId: TASK }),
    ).rejects.toBeInstanceOf(TicketSyncTaskFinishedError);
    expect(enqueued).toEqual([]);
  });
});

describe('a merged merge request clears its draft notice (S-28.10 review)', () => {
  it('deletes the merge_request_draft record when the task enters merged_gate', async () => {
    const cleared: string[] = [];
    const handler = mergeRequestReadyHandlers({
      store: {
        tasks: {
          clearProviderSync: async (_tx: unknown, taskId: string, subject: string) => {
            cleared.push(`${taskId}:${subject}`);
            return true;
          },
        },
      },
      jobs: { enqueue: async () => undefined } as unknown as Jobs,
    } as never).find((candidate) => candidate.name === 'pipeline.merge-request.draft-state');
    if (handler === undefined) throw new Error('the draft-state handler is not registered');
    await handler.handle({
      scope: { tx: {} },
      event: {
        event: {
          id: '00000000-0000-4000-9000-0000000000e3',
          type: 'task.stage.entered',
          payload: { project_id: PROJECT, task_id: TASK, stage: 'merged_gate', attempt: 1 },
        },
      },
      afterCommit: () => undefined,
    } as never);
    expect(cleared).toEqual([`${TASK}:merge_request_draft`]);
  });
});
