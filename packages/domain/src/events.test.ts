import { domainEventSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';
import { buildEvent, type CommandContext, eventRecorder } from './events.js';
import { sequentialIds } from './ids.js';

const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';

const context = (): CommandContext => ({
  ids: sequentialIds(),
  actor: { kind: 'system', component: 'test' },
  clock: fixedClock('2026-09-09T09:00:00.000Z', 1_000),
});

const ticket = {
  provider: 'jira-cloud',
  key: 'PROJ-1',
  url: 'https://example.invalid/browse/PROJ-1',
};

describe('buildEvent', () => {
  it('fills the envelope from the aggregate, the context and the clock', () => {
    const event = buildEvent(
      'task.created',
      {
        project_id: PROJECT_ID,
        task_id: TASK_ID,
        ticket,
        template: 'feature',
        mode: 'normal',
        estimate_usd: null,
      },
      { streamType: 'task', streamId: TASK_ID, streamSeq: 0 },
      { ...context(), correlationId: TASK_ID },
    );

    expect(event.type).toBe('task.created');
    expect(event.stream_type).toBe('task');
    expect(event.stream_id).toBe(TASK_ID);
    expect(event.stream_seq).toBe(0);
    expect(event.correlation_id).toBe(TASK_ID);
    expect(event.cause_event_id).toBeNull();
    expect(event.occurred_at).toBe('2026-09-09T09:00:00.000Z');
    expect(event.actor).toEqual({ kind: 'system', component: 'test' });
    // `actor` lives in the envelope, never in the payload (technical/02, WP-01).
    expect(Object.keys(event.payload)).not.toContain('actor');
  });

  it('produces events the catalogue schema accepts', () => {
    const event = buildEvent(
      'task.paused',
      { project_id: PROJECT_ID, task_id: TASK_ID, reason: 'budget' },
      { streamType: 'task', streamId: TASK_ID, streamSeq: 3 },
      context(),
    );
    expect(() => domainEventSchema.parse(event)).not.toThrow();
  });

  it('rejects a payload that drifts from the catalogue', () => {
    expect(() =>
      buildEvent(
        'task.paused',
        // `reason` is an enum of budget | manual | taken_over.
        { project_id: PROJECT_ID, task_id: TASK_ID, reason: 'because' } as never,
        { streamType: 'task', streamId: TASK_ID, streamSeq: 0 },
        context(),
      ),
    ).toThrow();
  });

  it('carries the causing event when the command runs inside a handler', () => {
    const cause = '00000000-0000-4000-8000-0000000000cc';
    const event = buildEvent(
      'task.resumed',
      { project_id: PROJECT_ID, task_id: TASK_ID, reason: null },
      { streamType: 'task', streamId: TASK_ID, streamSeq: 1 },
      { ...context(), causeEventId: cause },
    );
    expect(event.cause_event_id).toBe(cause);
  });
});

describe('eventRecorder', () => {
  it('numbers events contiguously from the aggregate sequence', () => {
    const recorder = eventRecorder({ streamType: 'task', streamId: TASK_ID }, 7, context());
    recorder.emit('task.paused', {
      project_id: PROJECT_ID,
      task_id: TASK_ID,
      reason: 'manual',
    });
    recorder.emit('task.resumed', { project_id: PROJECT_ID, task_id: TASK_ID, reason: null });

    expect(recorder.events.map((event) => event.stream_seq)).toEqual([7, 8]);
    expect(recorder.sequence).toBe(9);
    expect(new Set(recorder.events.map((event) => event.id)).size).toBe(2);
    // One command, one transaction, one instant — the clock is read once per recorder.
    expect(recorder.events.map((event) => event.occurred_at)).toEqual([
      '2026-09-09T09:00:00.000Z',
      '2026-09-09T09:00:00.000Z',
    ]);
    expect(recorder.occurredAt).toBe('2026-09-09T09:00:00.000Z');
  });

  it('starts empty', () => {
    const recorder = eventRecorder({ streamType: 'run', streamId: TASK_ID }, 0, context());
    expect(recorder.events).toEqual([]);
    expect(recorder.sequence).toBe(0);
  });
});
