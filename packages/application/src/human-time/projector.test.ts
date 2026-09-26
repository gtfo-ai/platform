/**
 * The human-time projector, over the in-memory store and the **real** `EventBus`.
 *
 * The branches live here because a branch is cheap to reach in this tier. What this tier cannot
 * say is said elsewhere, deliberately: the rows on a real database and the backfill's equality with
 * a live dispatch are `test/integration/cost/`, and the fold from events a real provider delivery
 * and a real run produced is `test/e2e/cost/human-time.e2e.test.ts` — never from a seeded
 * `human_time_entries` table (WP-29's acceptance criterion 8).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import type { Logger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  createMemoryHumanTimeStore,
  type MemoryHumanTimeStore,
} from '../testing/memory-human-time.js';
import { humanTimeHandlers } from './runtime.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
/** A task the harness never associates with a merge request, for the payload-names-it case. */
const OTHER_TASK = '00000000-0000-4000-8000-0000000000c2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000d1' as Id;
const QUESTION = '00000000-0000-4000-8000-0000000000e1' as Id;
const APPROVAL = '00000000-0000-4000-8000-0000000000e2' as Id;
const ADA = '00000000-0000-4000-8000-0000000000a1' as Id;
const IID = 7;

const MR = {
  provider: 'gitlab',
  project_path: 'acme/api',
  iid: IID,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'agentic/ACME-1',
  head_sha: 'a'.repeat(40),
} as const;

let stream = 0;
let eventId = 0;

const nextIds = (): { readonly seq: number; readonly id: string } => {
  stream += 1;
  eventId += 1;
  return { seq: stream, id: `00000000-0000-4000-9000-${eventId.toString(16).padStart(12, '0')}` };
};

const event = (type: string, occurredAt: string, payload: Record<string, unknown>): DomainEvent => {
  const { seq, id } = nextIds();
  return domainEventSchemasByType[type as keyof typeof domainEventSchemasByType].parse({
    id,
    stream_type: 'task',
    stream_id: TASK,
    stream_seq: seq,
    correlation_id: TASK,
    cause_event_id: null,
    actor: { kind: 'system', component: 'test' },
    occurred_at: occurredAt,
    type,
    payload,
  }) as DomainEvent;
};

const comment = (
  occurredAt: string,
  options: {
    readonly externalId?: string;
    readonly text?: string;
    readonly provider?: string;
    readonly taskId?: Id | null;
  } = {},
): DomainEvent =>
  event('mr.review.comment', occurredAt, {
    project_id: PROJECT,
    task_id: options.taskId ?? null,
    mr: MR,
    thread_id: 'discussion-1',
    author: {
      provider: options.provider ?? 'gitlab',
      external_id: options.externalId ?? 'ada',
      email: null,
      display_name: 'Ada',
      verified: false,
    },
    text: options.text ?? 'the retry helper needs a bound',
    resolved: false,
  });

const merged = (occurredAt: string, iid = IID): DomainEvent =>
  event('mr.merged', occurredAt, {
    project_id: PROJECT,
    task_id: null,
    mr: { ...MR, iid },
    draft: false,
    head_sha: 'a'.repeat(40),
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

const answered = (occurredAt: string, questionId: Id = QUESTION): DomainEvent =>
  event('task.question.answered', occurredAt, {
    project_id: PROJECT,
    task_id: TASK,
    question_id: questionId,
    answer: 'three retries',
    answered_by_user_id: ADA,
    channel: 'ui',
  });

const decided = (
  occurredAt: string,
  decision: 'approved' | 'rejected' | 'expired',
  decidedBy: Id | null = ADA,
): DomainEvent =>
  event('task.approval.decided', occurredAt, {
    project_id: PROJECT,
    task_id: TASK,
    approval_id: APPROVAL,
    decision,
    decided_by_user_id: decidedBy,
    reason: null,
  });

const steered = (occurredAt: string): DomainEvent =>
  event('run.steered', occurredAt, {
    project_id: PROJECT,
    task_id: TASK,
    run_id: RUN,
    message: 'use the existing helper',
    author_user_id: ADA,
  });

interface LoggedLine {
  readonly level: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly message: string;
}

/** A person approved the merge request (WP-60); `approved_at` is the provider's, which is not read. */
const approved = (
  occurredAt: string,
  options: { readonly externalId?: string; readonly approvedAt?: string | null } = {},
): DomainEvent =>
  event('mr.approved', occurredAt, {
    project_id: PROJECT,
    task_id: null,
    mr: MR,
    approver: {
      provider: 'gitlab',
      external_id: options.externalId ?? 'ada',
      email: null,
      display_name: 'Ada',
      verified: false,
    },
    approved_at: options.approvedAt === undefined ? null : options.approvedAt,
  });

interface ProjectorHarness {
  readonly store: MemoryHumanTimeStore;
  readonly logs: readonly LoggedLine[];
  publish(events: readonly DomainEvent[]): Promise<void>;
  /** Dispatches the whole log again, exactly as a redelivery would. */
  redeliver(): Promise<readonly string[]>;
}

const harness = (seed: (store: MemoryHumanTimeStore) => void = () => {}): ProjectorHarness => {
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
  const store = createMemoryHumanTimeStore();
  store.seedMergeRequest({ projectId: PROJECT, iid: IID }, TASK);
  store.seedTimezone(PROJECT, 'UTC');
  seed(store);
  for (const handler of humanTimeHandlers({ store, logger })) {
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

const minutesOf = (store: MemoryHumanTimeStore): readonly (number | null)[] =>
  store.entries.map((entry) => entry.minutes);

describe('the review window', () => {
  it('opens on the first human comment, with the provider account and no platform user', async () => {
    const projector = harness();
    await projector.publish([comment('2026-06-01T09:00:00.000Z')]);

    expect(projector.store.entries).toEqual([
      {
        id: expect.any(String),
        taskId: TASK,
        kind: 'review',
        userId: null,
        externalAuthor: 'gitlab:ada',
        startedAt: '2026-06-01T09:00:00.000Z',
        endedAt: '2026-06-01T09:00:00.000Z',
        // A measured zero, not an absence: the window exists and has not moved yet.
        minutes: 0,
      },
    ]);
  });

  it('extends the same window on a later comment inside the gap', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z'),
      comment('2026-06-01T10:30:00.000Z'),
    ]);

    expect(projector.store.entries).toHaveLength(1);
    expect(projector.store.entries[0]).toMatchObject({
      startedAt: '2026-06-01T09:00:00.000Z',
      endedAt: '2026-06-01T10:30:00.000Z',
      minutes: 90,
    });
  });

  it('starts a second window past the two-hour gap, and the two are not merged', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z'),
      comment('2026-06-01T10:00:00.000Z'),
      // 2 h 1 s after the last activity: past the exclusion, so this is a new sitting.
      comment('2026-06-01T12:00:01.000Z'),
      comment('2026-06-01T12:30:01.000Z'),
    ]);

    expect(minutesOf(projector.store)).toEqual([60, 30]);
  });

  it('ends every open window at the merge, and opens none for a merge with no review', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', { externalId: 'ada' }),
      comment('2026-06-01T09:10:00.000Z', { externalId: 'grace' }),
      merged('2026-06-01T10:00:00.000Z'),
    ]);

    expect(projector.store.entries.map((entry) => [entry.externalAuthor, entry.minutes])).toEqual([
      ['gitlab:ada', 60],
      ['gitlab:grace', 50],
    ]);

    const untouched = harness();
    await untouched.publish([merged('2026-06-01T10:00:00.000Z')]);
    expect(untouched.store.entries).toEqual([]);
  });

  it('does not extend a window the merge is more than two hours after', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z'),
      merged('2026-06-03T09:00:00.000Z'),
    ]);

    // Two days of waiting for a maintainer is not two days of reviewing.
    expect(minutesOf(projector.store)).toEqual([0]);
  });

  it('keeps two unmapped reviewers apart, and attributes a mapped one', async () => {
    const projector = harness((store) => {
      store.seedIdentity({ provider: 'gitlab', externalId: 'ada' }, ADA);
    });
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', { externalId: 'ada' }),
      comment('2026-06-01T09:05:00.000Z', { externalId: 'grace' }),
      comment('2026-06-01T10:00:00.000Z', { externalId: 'ada' }),
      comment('2026-06-01T10:30:00.000Z', { externalId: 'grace' }),
    ]);

    expect(
      projector.store.entries.map((entry) => [entry.userId, entry.externalAuthor, entry.minutes]),
    ).toEqual([
      [ADA, 'gitlab:ada', 60],
      [null, 'gitlab:grace', 85],
    ]);
    // The totals hold in the presence of the null: 145 minutes over two windows, and the task's own
    // total does not care which of them has a platform user (WP-29 criterion 5).
    expect(minutesOf(projector.store).reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0)).toBe(
      145,
    );
  });

  it('extends the same window when the reviewer is mapped between two of their comments', async () => {
    // The fold matches on the provider account when both sides carry one, so a mapping made
    // between two sittings reconciles rather than splitting the window (migration 0025's promise).
    const projector = harness();
    await projector.publish([comment('2026-06-01T09:00:00.000Z', { externalId: 'ada' })]);
    projector.store.seedIdentity({ provider: 'gitlab', externalId: 'ada' }, ADA);
    await projector.publish([comment('2026-06-01T10:00:00.000Z', { externalId: 'ada' })]);

    expect(projector.store.entries.map((entry) => [entry.externalAuthor, entry.minutes])).toEqual([
      ['gitlab:ada', 60],
    ]);
  });

  it('never moves a window backwards when an older event arrives after a newer one', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z'),
      comment('2026-06-01T10:00:00.000Z'),
      // A replay beside live traffic, or a provider clock that went backwards.
      comment('2026-06-01T09:30:00.000Z'),
    ]);

    expect(projector.store.entries).toHaveLength(1);
    expect(projector.store.entries[0]).toMatchObject({
      endedAt: '2026-06-01T10:00:00.000Z',
      minutes: 60,
    });
  });
});

/**
 * product/19 §16's *"approval"* anchor (WP-60, PROGRESS backlog 90). Until the event existed this
 * projector's docblock stated the residual: a reviewer who approved without commenting contributed
 * zero minutes. These cases are that sentence's replacement, in both directions.
 */
describe('an approval is review activity', () => {
  it('opens the approver’s window when they approve without commenting', async () => {
    const projector = harness();
    await projector.publish([approved('2026-06-01T09:00:00.000Z')]);
    expect(projector.store.entries).toEqual([
      expect.objectContaining({
        taskId: TASK,
        kind: 'review',
        externalAuthor: 'gitlab:ada',
        startedAt: '2026-06-01T09:00:00.000Z',
        endedAt: '2026-06-01T09:00:00.000Z',
        minutes: 0,
      }),
    ]);
  });

  it('extends the same person’s window from their comment to their approval, and not another’s', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', { externalId: 'ada' }),
      approved('2026-06-01T09:40:00.000Z', { externalId: 'ada' }),
      approved('2026-06-01T09:50:00.000Z', { externalId: 'grace' }),
    ]);
    expect(projector.store.entries.map((entry) => [entry.externalAuthor, entry.minutes])).toEqual([
      ['gitlab:ada', 40],
      ['gitlab:grace', 0],
    ]);
  });

  it('dates the approval by its receipt, not by the provider’s approved_at', async () => {
    // Two clocks inside one window would make its length depend on two machines agreeing, so the
    // provider's instant — which a GitLab older than 18.10 does not send at all — is not read.
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z'),
      approved('2026-06-01T09:30:00.000Z', { approvedAt: '2026-06-01T08:00:00.000Z' }),
    ]);
    expect(projector.store.entries[0]).toMatchObject({
      startedAt: '2026-06-01T09:00:00.000Z',
      endedAt: '2026-06-01T09:30:00.000Z',
      minutes: 30,
    });
  });
});

/**
 * PROGRESS backlog 88 (WP-61): somebody else's bot carries no platform marker, so until an operator
 * could declare it a machine its comments opened and extended review windows like a person's.
 */
describe('an account an operator declared a machine', () => {
  const withBot = (store: MemoryHumanTimeStore): void => {
    store.seedIdentity({ provider: 'gitlab', externalId: 'renovate' }, null);
  };

  it('neither opens a window nor extends one, for a comment or an approval, and writes no zero row', async () => {
    const projector = harness(withBot);
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', { externalId: 'renovate' }),
      approved('2026-06-01T09:30:00.000Z', { externalId: 'renovate' }),
      comment('2026-06-01T10:00:00.000Z', { externalId: 'renovate' }),
      merged('2026-06-01T10:30:00.000Z'),
    ]);
    expect(projector.store.entries).toEqual([]);
    expect(
      projector.logs.filter((line) => line.message.includes('declared this account a machine')),
    ).toHaveLength(3);
  });

  it('leaves a person’s window on the same merge request exactly as it was', async () => {
    const projector = harness(withBot);
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', { externalId: 'ada' }),
      comment('2026-06-01T09:20:00.000Z', { externalId: 'renovate' }),
      comment('2026-06-01T09:45:00.000Z', { externalId: 'ada' }),
      comment('2026-06-01T11:00:00.000Z', { externalId: 'renovate' }),
    ]);
    expect(projector.store.entries.map((entry) => [entry.externalAuthor, entry.minutes])).toEqual([
      ['gitlab:ada', 45],
    ]);
  });

  it('is an operator’s declaration and nothing else: a name that looks like a bot is still counted', async () => {
    // No `[bot]` suffix is read, and no provider flag: a guess that is wrong here deletes a
    // person's minutes (BD-022, Q10's argument against an email match).
    const projector = harness();
    await projector.publish([comment('2026-06-01T09:00:00.000Z', { externalId: 'renovate[bot]' })]);
    expect(projector.store.entries.map((entry) => entry.externalAuthor)).toEqual([
      'gitlab:renovate[bot]',
    ]);
  });

  it('still refuses the platform’s own marked comment when that account is mapped to a person', async () => {
    // The reason `PLATFORM_COMMENT_MARKERS` (domain `ask/ask.ts`) gives for keeping a marker check:
    // it holds on the day somebody maps the platform's own bot account to a user.
    const projector = harness((store) => {
      store.seedIdentity({ provider: 'gitlab', externalId: 'agentic-bot' }, ADA);
    });
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', {
        externalId: 'agentic-bot',
        text: '<!-- agentic:review:1 --> a finding',
      }),
    ]);
    expect(projector.store.entries).toEqual([]);
  });
});

describe('the review window’s two other shapes', () => {
  it('uses the task the payload already names, without asking the store', async () => {
    // `mr.review.comment` arrives from a normaliser with `task_id: null` — a webhook names a merge
    // request, not a platform task — but the field exists and a later producer may fill it. When it
    // does, it is authoritative: the store is not asked, and the merge request need not be seeded.
    const projector = harness();
    await projector.publish([comment('2026-06-01T09:00:00.000Z', { taskId: OTHER_TASK })]);

    expect(projector.store.entries.map((entry) => entry.taskId)).toEqual([OTHER_TASK]);
  });

  it('extends a window that has no ending yet, from where it started', async () => {
    // `ended_at` and `minutes` are nullable, and this build's projector always writes both — so the
    // branch that reads a window with neither exists for a row **another** writer could leave, and
    // for the backfill of a row written before this rule. It is exercised rather than assumed.
    const projector = harness();
    await projector.store.appendEntry({} as never, {
      taskId: TASK,
      kind: 'review',
      userId: null,
      externalAuthor: 'gitlab:ada',
      startedAt: '2026-06-01T09:00:00.000Z' as never,
      endedAt: null,
      minutes: null,
    });

    await projector.publish([comment('2026-06-01T10:00:00.000Z')]);

    expect(projector.store.entries).toHaveLength(1);
    expect(projector.store.entries[0]).toMatchObject({
      startedAt: '2026-06-01T09:00:00.000Z',
      endedAt: '2026-06-01T10:00:00.000Z',
      minutes: 60,
    });
  });

  it('runs with no logger at all, which is how a composition root without one composes it', async () => {
    const store = createMemoryHumanTimeStore();
    store.seedMergeRequest({ projectId: PROJECT, iid: IID }, TASK);
    store.seedTimezone(PROJECT, 'UTC');
    const memory = new MemoryEventing();
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    for (const handler of humanTimeHandlers({ store })) {
      bus.register(handler);
    }
    stream = 0;
    await memory.transaction(async (scope) =>
      scope.events.append([comment('2026-06-01T09:00:00.000Z')]),
    );
    const [stored] = memory.log;
    expect((await bus.dispatch(stored as NonNullable<typeof stored>)).status).toBe('dispatched');
    expect(store.entries).toHaveLength(1);
  });
});

describe('what the projector refuses to record', () => {
  it('ignores the platform’s own merge-request comment', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', {
        text: '<!-- agentic:review-only:abc -->\n**Review**: three findings.',
      }),
    ]);

    expect(projector.store.entries).toEqual([]);
    expect(projector.logs.map((line) => line.message)).toContain(
      'human time: this comment carries the platform’s own marker, so it is not human review activity',
    );
  });

  it('records nothing for a merge request that belongs to no task', async () => {
    const projector = harness();
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z', { taskId: null }),
      merged('2026-06-01T09:30:00.000Z', 99),
    ]);

    // The comment is on iid 7, which the harness seeded; the merge is on 99, which it did not.
    expect(projector.store.entries).toHaveLength(1);
    expect(projector.logs.map((line) => line.fields)).toContainEqual({
      project_id: PROJECT,
      iid: 99,
    });
  });

  it('refuses an author id too long to be an identity rather than truncating it', async () => {
    const projector = harness();
    await projector.publish([comment('2026-06-01T09:00:00.000Z', { externalId: 'a'.repeat(300) })]);

    expect(projector.store.entries).toEqual([]);
    expect(projector.logs.filter((line) => line.level === 'warn')[0]?.message).toBe(
      'human time: this reviewer’s account id is longer than an identity may be; the minutes are refused rather than attributed to a truncated key',
    );
  });

  it('records nothing for an expired approval or a decision with no decider', async () => {
    const projector = harness();
    await projector.publish([
      decided('2026-06-01T09:00:00.000Z', 'expired', null),
      decided('2026-06-01T09:10:00.000Z', 'approved', null),
    ]);

    expect(projector.store.entries).toEqual([]);
  });

  it('records nothing for an answer whose question row is gone, and says so', async () => {
    const projector = harness();
    await projector.publish([answered('2026-06-01T09:00:00.000Z')]);

    expect(projector.store.entries).toEqual([]);
    expect(projector.logs.filter((line) => line.level === 'warn')[0]?.message).toBe(
      'human time: no questions row for this answer, so "asked → answered" has no beginning; nothing is recorded',
    );
  });
});

describe('the three kinds the platform measures itself', () => {
  it('records a question from asked to answered, capped at thirty minutes', async () => {
    const projector = harness((store) => {
      store.seedQuestion(QUESTION, '2026-06-01T08:50:00.000Z');
    });
    await projector.publish([answered('2026-06-01T09:00:00.000Z')]);

    expect(projector.store.entries).toEqual([
      {
        id: expect.any(String),
        taskId: TASK,
        kind: 'question',
        userId: ADA,
        externalAuthor: null,
        startedAt: '2026-06-01T08:50:00.000Z',
        endedAt: '2026-06-01T09:00:00.000Z',
        minutes: 10,
      },
    ]);
  });

  it('records ten flat minutes per decided approval and five per steer', async () => {
    const projector = harness();
    await projector.publish([
      decided('2026-06-01T09:00:00.000Z', 'approved'),
      decided('2026-06-01T09:30:00.000Z', 'rejected'),
      steered('2026-06-01T10:00:00.000Z'),
    ]);

    expect(projector.store.entries.map((entry) => [entry.kind, entry.minutes])).toEqual([
      ['approval', 10],
      ['approval', 10],
      ['steer', 5],
    ]);
    // A flat kind is a point in time: the equal instants are what say the minutes are a convention
    // rather than something the platform timed.
    expect(projector.store.entries.every((entry) => entry.startedAt === entry.endedAt)).toBe(true);
  });
});

/**
 * **What makes this projection exactly-once, stated so the test is not read as proving more.**
 *
 * The guarantee is TD-005's, not the fold's: every row commits in the same transaction as the
 * `handler_executions` claim, so a redelivered event never reaches the handler and neither does a
 * second backfill pass (`events/replay.ts` claims `(position, handler)` exactly as the dispatcher
 * does). The cost ledger rests on the same mechanism.
 *
 * The fold itself is idempotent for the **review** kind by construction — re-folding an activity
 * already inside a window moves nothing — and is **not** for the three flat kinds, where a second
 * execution would append a second ten-minute approval. That is why the assertion below is a row
 * count taken from the store rather than a return value (standing rule 79), and why the same
 * sequence is asserted against a real `handler_executions` table in
 * `test/integration/cost/human-time-backfill.integration.test.ts`.
 */
describe('idempotency', () => {
  it('appends a row per distinct event, so the redelivery case below is not vacuous', async () => {
    const projector = harness();
    await projector.publish([
      decided('2026-06-01T09:00:00.000Z', 'approved'),
      decided('2026-06-01T09:30:00.000Z', 'approved'),
    ]);

    expect(projector.store.entries).toHaveLength(2);
  });

  it('produces the same rows when every event is dispatched a second time', async () => {
    const projector = harness((store) => {
      store.seedQuestion(QUESTION, '2026-06-01T08:50:00.000Z');
    });
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z'),
      comment('2026-06-01T09:30:00.000Z'),
      answered('2026-06-01T09:40:00.000Z'),
      decided('2026-06-01T09:50:00.000Z', 'approved'),
      steered('2026-06-01T09:55:00.000Z'),
      merged('2026-06-01T10:00:00.000Z'),
    ]);
    const first = projector.store.entries;
    expect(first).toHaveLength(4);

    const statuses = await projector.redeliver();

    // Counted in rows, not in a return value (standing rule 79): the claim is that a redelivery
    // wrote nothing, and only the rows can say that.
    expect(projector.store.entries).toEqual(first);
    expect(new Set(statuses)).toEqual(new Set(['completed']));
  });
});

describe('the calendar', () => {
  it('falls back to UTC on a zone it cannot compute in, and says so by name', async () => {
    const projector = harness((store) => {
      store.seedTimezone(PROJECT, 'Mars/Olympus');
    });
    await projector.publish([
      comment('2026-06-01T09:00:00.000Z'),
      comment('2026-06-01T10:00:00.000Z'),
    ]);

    // The minutes are still recorded — a handler that threw would park the stream and stop
    // measuring for every project (standing rule 20).
    expect(minutesOf(projector.store)).toEqual([60]);
    expect(projector.logs.filter((line) => line.level === 'warn')[0]).toMatchObject({
      fields: { timezone: 'Mars/Olympus', fallback: 'UTC', project_id: PROJECT },
    });
  });
});
