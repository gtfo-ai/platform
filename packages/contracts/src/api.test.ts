import { describe, expect, it } from 'vitest';
import {
  answerQuestionRequestSchema,
  apiErrorSchema,
  createTaskRequestSchema,
  decideApprovalRequestSchema,
  effectiveConfigResponseSchema,
  eventsQuerySchema,
  listTasksQuerySchema,
  paginationQuerySchema,
  putKbDocRequestSchema,
  runMessagesQuerySchema,
  sseFrameSchema,
  sseTopicSchema,
  startShadowRunsRequestSchema,
  steerRunRequestSchema,
  updateSubscriptionsRequestSchema,
  webhookDeliverySchema,
} from './api.js';

const uuid = (n: number) => `0199aa11-2b3c-7d4e-8f90-${String(n).padStart(12, '0')}`;
const AT = '2026-09-09T10:15:30Z';

describe('request DTOs', () => {
  it('rejects an unknown key on a command body', () => {
    expect(
      answerQuestionRequestSchema.safeParse({ answer: 'billing', anwser: 'typo' }).success,
    ).toBe(false);
    expect(decideApprovalRequestSchema.safeParse({ decision: 'maybe' }).success).toBe(false);
  });

  it('keeps a steer message bounded so a paste cannot blow up the session', () => {
    expect(steerRunRequestSchema.safeParse({ message: 'x' }).success).toBe(true);
    expect(steerRunRequestSchema.safeParse({ message: '' }).success).toBe(false);
    expect(steerRunRequestSchema.safeParse({ message: 'x'.repeat(10_001) }).success).toBe(false);
  });

  it('caps a shadow batch and requires at least one ticket', () => {
    expect(
      startShadowRunsRequestSchema.safeParse({ ticket_keys: [], budget_usd: 10 }).success,
    ).toBe(false);
    expect(
      startShadowRunsRequestSchema.safeParse({
        ticket_keys: Array.from({ length: 51 }, (_, i) => `PROJ-${i}`),
        budget_usd: 10,
      }).success,
    ).toBe(false);
  });

  it('coerces numeric query parameters from their string form', () => {
    expect(paginationQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });

  it('narrows a task listing to values the state machine knows', () => {
    expect(listTasksQuerySchema.safeParse({ state: 'waiting_answers' }).success).toBe(true);
    expect(listTasksQuerySchema.safeParse({ state: 'thinking' }).success).toBe(false);
  });

  it('accepts the documented run-message paging parameters', () => {
    expect(runMessagesQuerySchema.parse({ after: '120', limit: '50', partials: '0' })).toEqual({
      after: 120,
      limit: 50,
      partials: '0',
    });
    expect(runMessagesQuerySchema.safeParse({ partials: 'false' }).success).toBe(false);
  });

  it('takes a ticket key, not a whole ticket, to start a task by hand', () => {
    expect(createTaskRequestSchema.parse({ ticket_key: 'PROJ-123' })).toEqual({
      ticket_key: 'PROJ-123',
    });
    expect(createTaskRequestSchema.safeParse({ ticket_key: '' }).success).toBe(false);
  });

  it('writes a knowledge document by path and content only', () => {
    expect(
      putKbDocRequestSchema.parse({ path: 'technical/overview.md', content: '# Overview' }),
    ).toBeTruthy();
    expect(
      putKbDocRequestSchema.safeParse({
        path: 'technical/overview.md',
        content: '',
        commit_sha: 'abc1234',
      }).success,
    ).toBe(false);
  });
});

describe('response DTOs', () => {
  it('describes an error with a machine-readable code', () => {
    expect(apiErrorSchema.parse({ error: { code: 'not_found', message: 'no such task' } })).toEqual(
      {
        error: { code: 'not_found', message: 'no such task' },
      },
    );
    expect(apiErrorSchema.safeParse({ error: { code: 'NotFound', message: 'x' } }).success).toBe(
      false,
    );
  });

  it('reports the effective config with a source per key (technical/12)', () => {
    const response = {
      config: { version: 1 as const, policies: { autonomy: 'supervised' as const } },
      sources: { 'policies.autonomy': 'repo' as const, version: 'default' as const },
      hash: 'sha256:abc',
      computed_at: AT,
    };
    expect(effectiveConfigResponseSchema.parse(response)).toEqual(response);
    expect(
      effectiveConfigResponseSchema.safeParse({ ...response, sources: { x: 'guess' } }).success,
    ).toBe(false);
  });

  it('records a webhook delivery as opaque, untrusted data (BD-022)', () => {
    const delivery = {
      provider: 'gitlab',
      delivery_id: 'del_1',
      integration_id: uuid(1),
      received_at: AT,
      headers: { 'x-gitlab-token': '[REDACTED sha256:ab12cd]' },
      payload: { object_kind: 'merge_request', nested: { arrays: [1, 'two', null] } },
    };
    expect(webhookDeliverySchema.parse(delivery)).toEqual(delivery);
  });
});

describe('SSE contract (TD-014)', () => {
  it.each([
    ['org', true],
    [`task:${uuid(1)}`, true],
    [`run:${uuid(2)}`, true],
    [`project:${uuid(3)}`, true],
    ['task:123', false],
    ['everything', false],
  ])('validates topic %s', (topic, expected) => {
    expect(sseTopicSchema.safeParse(topic).success).toBe(expected);
  });

  it('carries a per-topic sequence on replayable frames and none on control frames', () => {
    const control = {
      frame: 'control' as const,
      topic: 'org',
      type: 'ping' as const,
      detail: null,
    };
    expect(sseFrameSchema.parse(control)).toEqual(control);
    expect(sseFrameSchema.safeParse({ ...control, seq: 1 }).success).toBe(false);
  });

  it('rejects a control event outside the documented set', () => {
    expect(
      sseFrameSchema.safeParse({ frame: 'control', topic: 'org', type: 'goodbye' }).success,
    ).toBe(false);
  });

  it('wraps a transcript entry for the run topic', () => {
    const frame = {
      frame: 'transcript' as const,
      topic: `run:${uuid(2)}`,
      seq: 7,
      data: {
        run_id: uuid(2),
        seq: 7,
        created_at: AT,
        parent_tool_use_id: null,
        redaction_count: 0,
        kind: 'steer' as const,
        message: 'use the existing helper',
        author_user_id: uuid(4),
      },
    };
    expect(sseFrameSchema.parse(frame)).toEqual(frame);
  });

  it('subscribes and unsubscribes by topic on an existing connection', () => {
    expect(
      updateSubscriptionsRequestSchema.parse({ connection_id: 'c1', add: ['org'] }),
    ).toBeTruthy();
    expect(
      updateSubscriptionsRequestSchema.safeParse({ connection_id: 'c1', add: ['whatever'] })
        .success,
    ).toBe(false);
  });

  it('takes topics as one comma-separated query parameter', () => {
    expect(eventsQuerySchema.parse({ topics: `org,task:${uuid(1)}` })).toBeTruthy();
    expect(eventsQuerySchema.safeParse({ topics: '' }).success).toBe(false);
  });
});
