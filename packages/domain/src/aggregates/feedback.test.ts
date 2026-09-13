import { domainEventSchemasByType, feedbackRecordSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import { InvariantViolationError } from '../errors.js';
import { type CommandContext, FIRST_STREAM_SEQ } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import { MAX_FEEDBACK_TEXT_CHARS, recordFeedback, toFeedbackRecord } from './feedback.js';

const FEEDBACK_ID = '00000000-0000-4000-8000-0000000000f1';
const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';
const USER_ID = '00000000-0000-4000-8000-0000000000e9';

const world = (): { ids: IdSource; clock: Clock } => ({
  ids: sequentialIds(),
  clock: fixedClock('2026-09-13T09:00:00.000Z', 1_000),
});

const context = (shared = world()): CommandContext => ({
  ids: shared.ids,
  actor: { kind: 'user', user_id: USER_ID },
  clock: shared.clock,
});

const input = (overrides: Record<string, unknown> = {}) => ({
  id: FEEDBACK_ID,
  projectId: PROJECT_ID,
  taskId: TASK_ID,
  authorUserId: USER_ID,
  scope: 'task' as const,
  text: 'The plan read well but the tests were thin.',
  sourceChannel: 'ui' as const,
  ...overrides,
});

describe('recordFeedback', () => {
  it('emits `feedback.received` on the feedback’s own stream, correlated to the task', () => {
    const decision = recordFeedback(input(), context());

    expect(decision.aggregate.sequence).toBe(FIRST_STREAM_SEQ + 1);
    expect(decision.events).toHaveLength(1);
    const event = decision.events[0];
    expect(event?.type).toBe('feedback.received');
    expect(event?.stream_type).toBe('feedback');
    expect(event?.stream_id).toBe(FEEDBACK_ID);
    expect(event?.stream_seq).toBe(FIRST_STREAM_SEQ);
    expect(event?.correlation_id).toBe(TASK_ID);
    expect(event?.actor).toEqual({ kind: 'user', user_id: USER_ID });

    // The payload is the published one, parsed by the catalogue's own schema: a record this
    // aggregate could not fill would fail here rather than at the first consumer (WP-24's).
    const parsed = domainEventSchemasByType['feedback.received'].parse(event);
    const payload = parsed.payload as { feedback: unknown; task_id: string | null };
    expect(payload.feedback).toEqual(toFeedbackRecord(decision.aggregate));
    expect(payload.task_id).toBe(TASK_ID);
    expect(feedbackRecordSchema.parse(payload.feedback).scope).toBe('task');
  });

  it('keeps the stage and the artifact the request scoped it to', () => {
    const stage = recordFeedback(
      input({ scope: 'stage', stage: 'implementation' }),
      context(),
    ).aggregate;
    expect(stage.stage).toBe('implementation');
    expect(stage.artifactId).toBeNull();

    const artifact = recordFeedback(
      input({ scope: 'artifact', artifactId: '00000000-0000-4000-8000-0000000000c1' }),
      context(),
    ).aggregate;
    expect(artifact.artifactId).toBe('00000000-0000-4000-8000-0000000000c1');
  });

  it('refuses a scope whose subject is missing, rather than quietly widening it to the task', () => {
    expect(() => recordFeedback(input({ scope: 'stage' }), context())).toThrow(
      InvariantViolationError,
    );
    expect(() => recordFeedback(input({ scope: 'artifact' }), context())).toThrow(
      InvariantViolationError,
    );
    // The other direction is deliberately allowed: a stage named on task-scoped feedback is
    // context, not a contradiction.
    expect(
      recordFeedback(input({ scope: 'task', stage: 'code_review' }), context()).aggregate.stage,
    ).toBe('code_review');
  });

  it('bounds the text at both sides of the cap and refuses rather than truncating', () => {
    const exact = 'x'.repeat(MAX_FEEDBACK_TEXT_CHARS);
    expect(recordFeedback(input({ text: exact }), context()).aggregate.text).toBe(exact);
    expect(() => recordFeedback(input({ text: `${exact}x` }), context())).toThrow(
      InvariantViolationError,
    );
    // Whitespace is not words.
    expect(() => recordFeedback(input({ text: '   \n ' }), context())).toThrow(
      InvariantViolationError,
    );
  });

  it('refuses a rating outside 1–5, at both edges', () => {
    expect(recordFeedback(input({ rating: 1 }), context()).aggregate.rating).toBe(1);
    expect(recordFeedback(input({ rating: 5 }), context()).aggregate.rating).toBe(5);
    for (const rating of [0, 6, 2.5]) {
      expect(() => recordFeedback(input({ rating }), context()), String(rating)).toThrow(
        InvariantViolationError,
      );
    }
  });

  it('records an author-less note without promoting an identity to a user', () => {
    const decision = recordFeedback(
      input({
        authorUserId: null,
        taskId: null,
        scope: 'project',
        authorIdentity: {
          provider: 'slack',
          external_id: 'U123',
          email: 'nobody@example.test',
          display_name: 'Nobody',
          verified: false,
        },
      }),
      context(),
    );
    expect(decision.aggregate.authorUserId).toBeNull();
    expect(decision.aggregate.authorIdentity?.verified).toBe(false);
    expect(decision.aggregate.taskId).toBeNull();
    // With no task, the correlation is the feedback itself rather than a null.
    expect(decision.events[0]?.correlation_id).toBe(FEEDBACK_ID);
  });
});
