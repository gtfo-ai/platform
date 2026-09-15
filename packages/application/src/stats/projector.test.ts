/**
 * The statistics projector, over the in-memory store and the **real** `EventBus` (WP-41).
 *
 * The branches live here because a branch is cheap to reach in this tier. What this tier cannot say
 * is said elsewhere, deliberately: the rows on a real database and the backfill's **equality** with
 * a live dispatch are `test/integration/stats/stats-backfill.integration.test.ts`, and the fold
 * from events a real instance produced is `test/e2e/server/stats-api.e2e.test.ts` — never from a
 * seeded rollup (this work package's acceptance criterion 8, standing rule 82).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import type { Logger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryStatsStore, type MemoryStatsStore } from '../testing/memory-stats.js';
import { statsHandlers } from './runtime.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const OTHER_TASK = '00000000-0000-4000-8000-0000000000c2' as Id;

const MR = {
  provider: 'gitlab',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'agentic/ACME-1',
  head_sha: 'a'.repeat(40),
} as const;

let stream = 0;
let eventId = 0;

const event = (type: string, occurredAt: string, payload: Record<string, unknown>): DomainEvent => {
  stream += 1;
  eventId += 1;
  return domainEventSchemasByType[type as keyof typeof domainEventSchemasByType].parse({
    id: `00000000-0000-4000-9000-${eventId.toString(16).padStart(12, '0')}`,
    stream_type: 'task',
    stream_id: TASK,
    stream_seq: stream,
    correlation_id: TASK,
    cause_event_id: null,
    actor: { kind: 'system', component: 'test' },
    occurred_at: occurredAt,
    type,
    payload,
  }) as DomainEvent;
};

const merged = (occurredAt: string, taskId: Id | null = TASK, iid: number = MR.iid): DomainEvent =>
  event('mr.merged', occurredAt, {
    project_id: PROJECT,
    task_id: taskId,
    mr: { ...MR, iid },
    draft: false,
    head_sha: 'a'.repeat(40),
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

const rebaseChecked = (
  occurredAt: string,
  outcome: 'clean' | 'resolved' | 'conflicted' | 'exhausted',
): DomainEvent =>
  event('task.rebase.checked', occurredAt, {
    project_id: PROJECT,
    task_id: TASK,
    mr: MR,
    conflicts: outcome !== 'clean',
    attempt: outcome === 'resolved' ? 1 : 0,
    outcome,
  });

const conflictWarned = (occurredAt: string, pathCount: number, truncated = false): DomainEvent =>
  event('task.conflict.warned', occurredAt, {
    project_id: PROJECT,
    task_id: TASK,
    mr: MR,
    other_task_id: OTHER_TASK,
    other_ticket_key: 'ACME-98',
    paths: ['src/retry.ts'],
    path_count: pathCount,
    truncated,
  });

const reviewObserved = (
  occurredAt: string,
  threads: { posted: number; accepted: number; dismissed: number; unresolved: number },
): DomainEvent =>
  event('task.review.observed', occurredAt, {
    project_id: PROJECT,
    task_id: TASK,
    mr: MR,
    head_sha_reviewed: 'a'.repeat(40),
    head_sha_now: 'b'.repeat(40),
    threads_posted: threads.posted,
    threads_resolved: threads.accepted + threads.dismissed,
    threads_accepted: threads.accepted,
    threads_dismissed: threads.dismissed,
    threads_unresolved: threads.unresolved,
  });

const lintPosted = (occurredAt: string, questions: number): DomainEvent =>
  event('task.lint.posted', occurredAt, {
    project_id: PROJECT,
    task_id: TASK,
    ticket: {
      provider: 'jira',
      key: 'ACME-4',
      url: 'https://tickets.example.test/browse/ACME-4',
    },
    score: 62,
    missing: [],
    questions_posted: questions,
    ticket_updated_at: null,
  });

interface LoggedLine {
  readonly level: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

interface ProjectorHarness {
  readonly store: MemoryStatsStore;
  readonly logs: readonly LoggedLine[];
  publish(events: readonly DomainEvent[]): Promise<void>;
  /** Dispatches the whole log again, exactly as a redelivery would. */
  redeliver(): Promise<readonly string[]>;
}

const harness = (timezone: string | null = 'UTC'): ProjectorHarness => {
  stream = 0;
  const logs: LoggedLine[] = [];
  const logger: Logger = {
    debug: (fields, message) => logs.push({ level: 'debug', fields, message }),
    info: (fields, message) => logs.push({ level: 'info', fields, message }),
    warn: (fields, message) => logs.push({ level: 'warn', fields, message }),
    error: (fields, message) => logs.push({ level: 'error', fields, message }),
  };
  const memory = new MemoryEventing();
  const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
  const store = createMemoryStatsStore();
  store.seedTimezone(PROJECT, timezone);
  // `tasks.mr_ref` in miniature: on a real instance this is the **only** way the projector learns
  // which task a merge request belongs to, because the payload's `task_id` is null on every event
  // a git adapter produces.
  store.seedMergeRequest({ projectId: PROJECT, iid: MR.iid }, TASK);
  for (const handler of statsHandlers({ store, logger })) {
    bus.register(handler);
  }
  const drain = async (): Promise<void> => {
    for (let guard = 0; guard < 50; guard += 1) {
      const next = memory.pending[0];
      if (next === undefined) {
        return;
      }
      const stored = memory.log.find((row) => row.position === next.eventPosition);
      if (stored === undefined) {
        return;
      }
      const result = await bus.dispatch(stored);
      if (result.status === 'failed') {
        throw new Error(
          `dispatch failed: ${result.handlers.map((entry) => `${entry.handler}:${entry.error ?? ''}`).join(', ')}`,
        );
      }
    }
    throw new Error('the projector harness dispatched 50 events without draining');
  };
  return {
    store,
    get logs() {
      return [...logs];
    },
    publish: async (events) => {
      await memory.transaction(async (scope) => scope.events.append(events));
      await drain();
    },
    redeliver: async () => {
      const statuses: string[] = [];
      for (const stored of memory.log) {
        statuses.push((await bus.dispatch(stored)).status);
      }
      return statuses;
    },
  };
};

describe('the delivery row', () => {
  it('records the merge at the envelope’s instant, for the task the payload names', async () => {
    const stats = harness();
    await stats.publish([merged('2026-06-01T09:15:00.000Z')]);

    expect(stats.store.deliveries).toEqual([
      { taskId: TASK, projectId: PROJECT, mergedAt: '2026-06-01T09:15:00.000Z' },
    ]);
  });

  it('finds the task by merge request when the payload names none — which is every real event', async () => {
    // The case that matters most and the one a kinder fake hides (standing rule 1): `mr.merged` is
    // produced by a git adapter from a webhook, and `task_id` is null on **every** one of them.
    // A projector that read the payload alone would write no delivery row on any instance while
    // passing the case above.
    const stats = harness();
    await stats.publish([merged('2026-06-01T09:15:00.000Z', null)]);

    expect(stats.store.deliveries).toEqual([
      { taskId: TASK, projectId: PROJECT, mergedAt: '2026-06-01T09:15:00.000Z' },
    ]);
  });

  it('keeps the first merge when a merge request is merged twice', async () => {
    const stats = harness();
    await stats.publish([merged('2026-06-01T09:15:00.000Z'), merged('2026-06-03T11:00:00.000Z')]);

    // Not a redelivery — two genuine events, which a reopened merge request produces. The *first*
    // is the delivery, so a reader who saw the task in Monday's bucket still finds it there.
    expect(stats.store.deliveries).toEqual([
      { taskId: TASK, projectId: PROJECT, mergedAt: '2026-06-01T09:15:00.000Z' },
    ]);
  });

  it('records nothing for a merge request that belongs to no task, and says why', async () => {
    const stats = harness();
    // An iid nothing owns: a human-authored merge request, which is what review-only mode watches.
    await stats.publish([merged('2026-06-01T09:15:00.000Z', null, 404)]);

    expect(stats.store.deliveries).toEqual([]);
    // Standing rule 10: the branch is named, not merely the empty result — an absent row is also
    // what a projector that crashed would leave.
    expect(stats.logs.map((line) => line.message)).toContain(
      'stats: this merge request belongs to no task, so it is not a delivery of one; nothing is recorded',
    );
  });
});

describe('the counters', () => {
  it('counts a rebase settlement under its own outcome', async () => {
    const stats = harness();
    await stats.publish([
      rebaseChecked('2026-06-01T09:00:00.000Z', 'clean'),
      rebaseChecked('2026-06-01T10:00:00.000Z', 'resolved'),
      rebaseChecked('2026-06-01T11:00:00.000Z', 'exhausted'),
      rebaseChecked('2026-06-01T12:00:00.000Z', 'resolved'),
    ]);

    expect(stats.store.counters.map((row) => [row.metric, row.count, row.total])).toEqual([
      ['rebase.clean', 1, 0],
      ['rebase.exhausted', 1, 0],
      ['rebase.resolved', 2, 0],
    ]);
  });

  it('sums the overlapping paths a conflict warning found, not the paths it listed', async () => {
    const stats = harness();
    // `paths` carries one entry and `path_count` says nine: WP-26 bounds the list and counts the
    // overlap. A fold that counted the list would under-report exactly the worst pairs.
    await stats.publish([conflictWarned('2026-06-01T09:00:00.000Z', 9, true)]);

    expect(stats.store.counters).toEqual([
      {
        projectId: PROJECT,
        day: '2026-06-01',
        metric: 'conflict.warned',
        count: 1,
        total: 9,
      },
    ]);
  });

  it('records a review observation as a count and its threads as totals', async () => {
    const stats = harness();
    await stats.publish([
      reviewObserved('2026-06-01T09:00:00.000Z', {
        posted: 5,
        accepted: 3,
        dismissed: 1,
        unresolved: 1,
      }),
    ]);

    expect(stats.store.counters.map((row) => [row.metric, row.count, row.total])).toEqual([
      ['review_only.observed', 1, 0],
      ['review_only.threads_accepted', 1, 3],
      ['review_only.threads_dismissed', 1, 1],
      ['review_only.threads_posted', 1, 5],
    ]);
  });

  it('records a lint comment and the questions it carried', async () => {
    const stats = harness();
    await stats.publish([lintPosted('2026-06-01T09:00:00.000Z', 3)]);

    expect(stats.store.counters).toEqual([
      {
        projectId: PROJECT,
        day: '2026-06-01',
        metric: 'ticket_lint.posted',
        count: 1,
        total: 3,
      },
    ]);
  });

  it('cuts the day in the organisation’s zone, not in UTC', async () => {
    const stats = harness('Pacific/Auckland');
    // 21:30 UTC on the 1st is 09:30 on the **2nd** in Auckland (UTC+12 in June).
    await stats.publish([rebaseChecked('2026-06-01T21:30:00.000Z', 'clean')]);

    expect(stats.store.counters.map((row) => row.day)).toEqual(['2026-06-02']);
  });

  it('falls back to UTC on a zone this runtime cannot use, and says so', async () => {
    const stats = harness('Mars/Olympus');
    await stats.publish([rebaseChecked('2026-06-01T21:30:00.000Z', 'clean')]);

    // Rule 20: being *told* something is not the moment to fail closed — a throw here would park
    // every project's counters over one organisation's settings field.
    expect(stats.store.counters.map((row) => row.day)).toEqual(['2026-06-01']);
    expect(stats.logs.filter((line) => line.level === 'warn').map((line) => line.message)).toEqual([
      'stats: the organisation timezone is not an IANA zone this runtime can do calendar arithmetic in; the day is cut in UTC',
    ]);
  });
});

describe('idempotency', () => {
  /**
   * Standing rule 79: the assertion is on the **rows**, never on a return value — a fold that ran
   * twice and reported "skipped" would look identical from the outside.
   */
  it('produces the same rows when every event is redelivered', async () => {
    const stats = harness();
    await stats.publish([
      merged('2026-06-01T09:15:00.000Z'),
      rebaseChecked('2026-06-01T09:00:00.000Z', 'resolved'),
      conflictWarned('2026-06-01T09:05:00.000Z', 4),
      reviewObserved('2026-06-01T09:10:00.000Z', {
        posted: 2,
        accepted: 1,
        dismissed: 1,
        unresolved: 0,
      }),
      lintPosted('2026-06-01T09:12:00.000Z', 2),
    ]);
    const before = { deliveries: stats.store.deliveries, counters: stats.store.counters };

    const statuses = await stats.redeliver();

    expect(new Set(statuses)).toEqual(new Set(['completed']));
    expect({ deliveries: stats.store.deliveries, counters: stats.store.counters }).toEqual(before);
  });
});
