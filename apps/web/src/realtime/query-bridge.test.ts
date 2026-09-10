import type { SseFrame, SseTopic } from '@platform/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/keys.js';
import { createQueryBridge, staleKeysForEvent, staleKeysForTopic } from './query-bridge.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';

const domainEvent = (
  overrides: Record<string, unknown> = {},
): SseFrame & { frame: 'domain_event' } =>
  ({
    frame: 'domain_event',
    topic: `project:${PROJECT}` as SseTopic,
    seq: 1,
    type: 'run.started',
    data: {
      id: '44444444-4444-4444-8444-444444444444',
      stream_type: 'run',
      stream_id: RUN,
      stream_seq: 1,
      correlation_id: TASK,
      cause_event_id: null,
      actor: { kind: 'system', component: 'pipeline' },
      occurred_at: '2026-09-10T09:00:00.000Z',
      type: 'run.started',
      payload: { project_id: PROJECT, task_id: TASK, run_id: RUN },
      ...overrides,
    },
  }) as SseFrame & { frame: 'domain_event' };

describe('staleKeysForEvent', () => {
  it('names the project, task and run prefixes the event could have changed', () => {
    const keys = staleKeysForEvent(domainEvent());

    expect(keys).toContainEqual([...queryKeys.project(PROJECT)]);
    expect(keys).toContainEqual([...queryKeys.task(TASK)]);
    expect(keys).toContainEqual([...queryKeys.run(RUN)]);
    expect(keys).toContainEqual([...queryKeys.agents]);
  });

  it('falls back to the stream when the payload names no id', () => {
    const keys = staleKeysForEvent(
      domainEvent({ stream_type: 'task', stream_id: TASK, correlation_id: null, payload: {} }),
    );

    expect(keys).toContainEqual([...queryKeys.task(TASK)]);
  });

  it('marks the inbox stale for a question or an approval', () => {
    expect(staleKeysForEvent(domainEvent({ stream_type: 'question' }))).toContainEqual([
      ...queryKeys.inbox,
    ]);
    expect(staleKeysForEvent(domainEvent({ stream_type: 'approval' }))).toContainEqual([
      ...queryKeys.inbox,
    ]);
  });
});

describe('staleKeysForTopic', () => {
  it('scopes a project reset to that project and the project list', () => {
    expect(staleKeysForTopic(`project:${PROJECT}` as SseTopic)).toEqual([
      [...queryKeys.project(PROJECT)],
      [...queryKeys.projects],
    ]);
  });

  it('scopes a task and a run reset to their own subtree', () => {
    expect(staleKeysForTopic(`task:${TASK}` as SseTopic)).toEqual([[...queryKeys.task(TASK)]]);
    expect(staleKeysForTopic(`run:${RUN}` as SseTopic)).toEqual([[...queryKeys.run(RUN)]]);
  });

  it('invalidates everything for the org topic and for a connection-level reset', () => {
    // `[]` is TanStack Query's "every query": the server has said it cannot prove what was missed.
    expect(staleKeysForTopic('org' as SseTopic)).toEqual([[]]);
    expect(staleKeysForTopic(null)).toEqual([[]]);
  });
});

describe('createQueryBridge', () => {
  it('invalidates on a domain event', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const bridge = createQueryBridge({ queryClient });

    bridge.onFrame(domainEvent());

    expect(invalidate).toHaveBeenCalledWith({ queryKey: [...queryKeys.run(RUN)] });
  });

  it('routes a transcript frame to the transcript sink and not to the cache', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const onTranscript = vi.fn();
    const bridge = createQueryBridge({ queryClient, onTranscript });

    bridge.onFrame({
      frame: 'transcript',
      topic: `run:${RUN}` as SseTopic,
      seq: 4,
      data: {
        kind: 'assistant',
        run_id: RUN,
        seq: 4,
        created_at: '2026-09-10T09:00:00.000Z',
        redaction_count: 0,
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'hello' }],
      },
    });

    expect(onTranscript).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates everything on a connection-level reset', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const bridge = createQueryBridge({ queryClient });

    bridge.onReset(null);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: [] });
  });
});
