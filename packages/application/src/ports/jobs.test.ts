import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertEnqueueRequest,
  assertJobKey,
  assertJobName,
  coalescingSlotStart,
  isValidJobName,
  JOB_NAME_MAX_LENGTH,
  JOB_QUEUES,
  JobsValidationError,
  pollQueueName,
} from './jobs.js';

describe('job names', () => {
  it.each([
    'dispatch',
    'stage.execute',
    'question.timeout',
    'mr.comment.debounce',
    'db.partitions.maintain',
    'poll.jira_cloud',
    'a1',
  ])('accepts %s', (name) => {
    expect(isValidJobName(name)).toBe(true);
    expect(() => assertJobName(name)).not.toThrow();
  });

  it.each([
    '',
    'Dispatch',
    '1dispatch',
    'stage..execute',
    'stage.',
    '.stage',
    'stage execute',
    'stage;drop',
    "robert'); drop table events;--",
    'a'.repeat(JOB_NAME_MAX_LENGTH + 1),
  ])('rejects %s', (name) => {
    expect(isValidJobName(name)).toBe(false);
    expect(() => assertJobName(name)).toThrow(JobsValidationError);
  });

  it('never accepts a name that could break out of a SQL string literal', () => {
    fc.assert(
      fc.property(fc.string(), (candidate) => {
        if (isValidJobName(candidate)) {
          expect(candidate).not.toMatch(/['"\\;\s]/);
        }
      }),
    );
  });

  it('names every queue TD-004 enumerates', () => {
    for (const name of Object.values(JOB_QUEUES)) {
      expect(isValidJobName(name)).toBe(true);
    }
    expect(JOB_QUEUES.mrCommentDebounce).toBe('mr.comment.debounce');
    expect(pollQueueName('gitlab')).toBe('poll.gitlab');
    expect(() => pollQueueName('GitLab')).toThrow(/poll queue name/);
  });
});

describe('job keys', () => {
  it.each(['task:1', 'mr:42', 'PROJ-123', 'project/main', 'a.b_c-d'])('accepts %s', (key) => {
    expect(() => assertJobKey(key)).not.toThrow();
  });

  it.each(['', ' leading', 'quote"d', "quote'd", 'a'.repeat(201)])('rejects %s', (key) => {
    expect(() => assertJobKey(key)).toThrow(JobsValidationError);
  });
});

describe('assertEnqueueRequest', () => {
  it('accepts a plain request', () => {
    expect(() => assertEnqueueRequest({ queue: 'dispatch' })).not.toThrow();
  });

  it('rejects an invalid queue, key or dead letter queue', () => {
    expect(() => assertEnqueueRequest({ queue: 'Dispatch' })).toThrow(/queue name/);
    expect(() => assertEnqueueRequest({ queue: 'dispatch', singletonKey: '' })).toThrow(
      /singleton key/,
    );
    expect(() => assertEnqueueRequest({ queue: 'dispatch', deadLetterQueue: 'Dead' })).toThrow(
      /dead letter queue/,
    );
  });

  it('rejects an invalid startAfter and a non-integer priority', () => {
    expect(() =>
      assertEnqueueRequest({ queue: 'dispatch', startAfter: new Date('nonsense') }),
    ).toThrow(/startAfter/);
    expect(() => assertEnqueueRequest({ queue: 'dispatch', priority: 1.5 })).toThrow(/priority/);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a coalescing window of %s seconds',
    (windowSeconds) => {
      expect(() =>
        assertEnqueueRequest({
          queue: 'dispatch',
          coalesce: { key: 'mr:1', windowSeconds },
        }),
      ).toThrow(/windowSeconds/);
    },
  );

  it('rejects combining a singleton key with coalescing', () => {
    expect(() =>
      assertEnqueueRequest({
        queue: 'dispatch',
        singletonKey: 'task:1',
        coalesce: { key: 'task:1', windowSeconds: 60 },
      }),
    ).toThrow(/singletonKey and coalesce/);
  });
});

describe('coalescingSlotStart', () => {
  it('floors to the slot grid, in whole seconds', () => {
    expect(coalescingSlotStart(new Date('2026-06-01T10:00:00Z'), 120)).toBe(
      Date.parse('2026-06-01T10:00:00Z') / 1000,
    );
    expect(coalescingSlotStart(new Date('2026-06-01T10:01:59.999Z'), 120)).toBe(
      Date.parse('2026-06-01T10:00:00Z') / 1000,
    );
    expect(coalescingSlotStart(new Date('2026-06-01T10:02:00Z'), 120)).toBe(
      Date.parse('2026-06-01T10:02:00Z') / 1000,
    );
  });

  it('puts two instants in the same slot exactly when they are less than a window apart on the grid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 1, max: 3600 }),
        (seconds, windowSeconds) => {
          const slot = coalescingSlotStart(new Date(seconds * 1000), windowSeconds);
          expect(slot % windowSeconds).toBe(0);
          expect(slot).toBeLessThanOrEqual(seconds);
          expect(slot + windowSeconds).toBeGreaterThan(seconds);
        },
      ),
    );
  });
});
