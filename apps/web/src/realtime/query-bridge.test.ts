import type { SseFrame, SseTopic } from '@platform/contracts';
import { sseFrameSchema } from '@platform/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/keys.js';
import { createQueryBridge, staleKeysForEvent, staleKeysForTopic } from './query-bridge.js';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';

/**
 * **Parsed rather than cast** (PROGRESS backlog 93, closed by WP-38).
 *
 * This fixture used to be `Record<string, unknown>` overrides closed with `as SseFrame`, which is
 * the one spelling in the `apps/web` tier that was checked on **neither** side: nothing compared it
 * with the published frame, and nothing parsed it at runtime either, because `staleKeysForEvent`
 * takes the frame directly rather than through the endpoint client. Parsing with the published
 * schema restores both halves — a frame this application could never receive now fails here, at the
 * fixture, which is the diagnostic rule 4 asks of an instrument.
 */
const domainEvent = (
  overrides: Record<string, unknown> = {},
): SseFrame & { frame: 'domain_event' } => {
  const data = {
    id: '44444444-4444-4444-8444-444444444444',
    type: 'run.started',
    stream_type: 'run',
    stream_id: RUN,
    occurred_at: '2026-09-10T09:00:00.000Z',
    project_id: PROJECT,
    task_id: TASK,
    run_id: RUN,
    ...overrides,
  };
  const frame = sseFrameSchema.parse({
    frame: 'domain_event',
    topic: `project:${PROJECT}` as SseTopic,
    seq: 1,
    type: data.type,
    data,
  });
  if (frame.frame !== 'domain_event') {
    throw new Error('the fixture above is a domain-event frame by construction');
  }
  return frame;
};

const QUESTION = '55555555-5555-4555-8555-555555555555';
const WORKER = '66666666-6666-4666-8666-666666666666';

describe('staleKeysForEvent', () => {
  it('names the project, task and run prefixes the event could have changed', () => {
    const keys = staleKeysForEvent(domainEvent());

    expect(keys).toContainEqual([...queryKeys.project(PROJECT)]);
    expect(keys).toContainEqual([...queryKeys.task(TASK)]);
    expect(keys).toContainEqual([...queryKeys.run(RUN)]);
    expect(keys).toContainEqual([...queryKeys.agents]);
  });

  it('falls back to the stream when the projection names no id', () => {
    const keys = staleKeysForEvent(
      domainEvent({
        type: 'task.paused',
        stream_type: 'task',
        stream_id: TASK,
        project_id: undefined,
        task_id: undefined,
        run_id: undefined,
      }),
    );

    expect(keys).toContainEqual([...queryKeys.task(TASK)]);
    expect(keys).not.toContainEqual([...queryKeys.agents]);
    expect(keys).not.toContainEqual([...queryKeys.inbox]);
  });

  it('marks the inbox stale for a question or an approval, whichever stream it was appended to', () => {
    expect(staleKeysForEvent(domainEvent({ stream_type: 'question' }))).toContainEqual([
      ...queryKeys.inbox,
    ]);
    expect(staleKeysForEvent(domainEvent({ stream_type: 'approval' }))).toContainEqual([
      ...queryKeys.inbox,
    ]);
    // `task.question.asked` is appended to the **task** stream, so the type and the id decide.
    expect(
      staleKeysForEvent(
        domainEvent({
          type: 'task.question.asked',
          stream_type: 'task',
          stream_id: TASK,
          run_id: undefined,
          question_id: QUESTION,
        }),
      ),
    ).toContainEqual([...queryKeys.inbox]);
    expect(
      staleKeysForEvent(
        domainEvent({
          type: 'task.approval.requested',
          stream_type: 'task',
          stream_id: TASK,
          run_id: undefined,
        }),
      ),
    ).toContainEqual([...queryKeys.inbox]);
  });

  it('refreshes the workers list for a claim that names a worker', () => {
    expect(
      staleKeysForEvent(
        domainEvent({ type: 'run.claimed', worker_id: WORKER, claimant_kind: 'worker' }),
      ),
    ).toContainEqual([...queryKeys.workers]);
    expect(staleKeysForEvent(domainEvent({ type: 'run.claimed' }))).not.toContainEqual([
      ...queryKeys.workers,
    ]);
  });
});

/**
 * S-23.14's three named frames, as the server's projection sends them, driven through the bridge
 * into a real `QueryClient` holding the queries the Agents, Inbox, board and task screens read — so
 * the assertion is that those queries are **invalidated** (a mounted screen refetches without
 * navigation), not merely that a key list contains them.
 */
describe('the live frames the screens refresh on', () => {
  const seeded = () => {
    const queryClient = new QueryClient();
    const keys = {
      agents: [...queryKeys.agents],
      inbox: [...queryKeys.inbox],
      board: [...queryKeys.projectTasks(PROJECT)],
      task: [...queryKeys.task(TASK)],
      run: [...queryKeys.run(RUN)],
      otherTask: [...queryKeys.task('77777777-7777-4777-8777-777777777777')],
    };
    for (const key of Object.values(keys)) {
      queryClient.setQueryData(key, { seeded: true });
    }
    const stale = () =>
      Object.fromEntries(
        Object.entries(keys).map(([name, key]) => [
          name,
          queryClient.getQueryState(key)?.isInvalidated === true,
        ]),
      );
    return { bridge: createQueryBridge({ queryClient }), stale };
  };

  it('run.claimed refreshes the agents list, the board, the task and the run', () => {
    const { bridge, stale } = seeded();
    bridge.onFrame(domainEvent({ type: 'run.claimed', claimant_kind: 'server' }));
    expect(stale()).toEqual({
      agents: true,
      inbox: false,
      board: true,
      task: true,
      run: true,
      otherTask: false,
    });
  });

  it('task.stage.entered refreshes the board and the task, not the agents list or the inbox', () => {
    const { bridge, stale } = seeded();
    bridge.onFrame(
      domainEvent({
        type: 'task.stage.entered',
        stream_type: 'task',
        stream_id: TASK,
        run_id: undefined,
        stage: 'development',
      }),
    );
    expect(stale()).toEqual({
      agents: false,
      inbox: false,
      board: true,
      task: true,
      run: false,
      otherTask: false,
    });
  });

  it('task.question.asked refreshes the inbox, the board and the task', () => {
    const { bridge, stale } = seeded();
    bridge.onFrame(
      domainEvent({
        type: 'task.question.asked',
        stream_type: 'task',
        stream_id: TASK,
        run_id: undefined,
        question_id: QUESTION,
      }),
    );
    expect(stale()).toEqual({
      agents: false,
      inbox: true,
      board: true,
      task: true,
      run: false,
      otherTask: false,
    });
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
