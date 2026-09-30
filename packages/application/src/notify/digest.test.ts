/**
 * The daily digest — what it collects, when it is due, and what stops it posting twice (WP-32).
 *
 * Every case drives `runProjectDigest` or the tick handler with an **injected** clock at a named
 * instant (standing rule 2), and asserts on two countable things: the messages the chat double was
 * actually handed, and the `integration_actions` rows the real `IntegrationActionExecutor` wrote.
 * The port's return value is deliberately not the evidence (standing rule 79).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { markTransactions } from '../events/open-transaction.js';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import { staticProjectSettings } from '../pipeline/settings.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  cannotStart,
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
  testClock,
} from '../testing/pipeline-harness.js';
import {
  DIGEST_ITEM_LIMIT,
  DIGEST_TICK_CRON,
  digestItemOf,
  digestTickHandler,
  runProjectDigest,
} from './digest.js';
import { runNotification } from './duty.js';
import type { NotifyOptions } from './options.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TICKET_KEY = 'ACME-1';
const TICKET_URL = 'https://tickets.example.test/browse/ACME-1';

let stream = 0;

const matched = (): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType['ticket.matched'].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key: TICKET_KEY, url: TICKET_URL },
      rule: 'label:agentic',
      priority: 'Medium',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;
};

/** Quiet all night, digest at 09:00 — product/18:33's shape with the window switched on. */
const QUIET: HarnessOptions = {
  settings: {
    config: {
      features: {
        digest: { enabled: true, at: '09:00', quiet_hours: { from: '22:00', to: '08:00' } },
      },
    },
  },
};

const harnessWith = (overrides: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    communication: {},
    runs: {},
    ...QUIET,
    ...overrides,
  });

const optionsOf = (harness: PipelineHarness, now: string, timezone = 'UTC'): NotifyOptions => {
  const clock = testClock(now);
  return {
    store: harness.store,
    settings: staticProjectSettings(() => harness.settings),
    jobs: harness.jobs,
    calendar: harness.calendar,
    integrations: staticPipelineIntegrations(harness.integrations),
    ids: harness.ids,
    clock: { now: () => clock.now() },
    unitOfWork: markTransactions(harness.memory),
    notifications: harness.notifications,
    timezone,
    organisation: harness.organisation,
    heldConnections: harness.heldConnections,
    organisationSettings: harness.organisationSettings,
  };
};

/** Why the walk may stop at refinement in this file (backlog 249). */
const NO_STAGE =
  'this case is about what the notification band does with a task; the walk stops at its first stage, which escalates as a runner that cannot start';

/** Drives a ticket to a task; the walk stops at its first stage, declared (backlog 249). */
const taskOf = async (harness: PipelineHarness): Promise<void> => {
  harness.script('refinement', cannotStart(NO_STAGE));
  await harness.publish([matched()]);
};

/** A task, and one notification deferred into the night. */
const deferred = async (
  harness: PipelineHarness,
  overrides: {
    readonly cause?: string;
    readonly at?: string;
    readonly notificationClass?: string;
  } = {},
): Promise<void> => {
  const task = harness.store.snapshot()[0];
  await runNotification(optionsOf(harness, overrides.at ?? '2026-06-01T23:00:00.000Z'), {
    duty: 'notify',
    project_id: PROJECT,
    task_id: (task as NonNullable<typeof task>).task.id,
    cause_event_id: overrides.cause ?? '00000000-0000-4000-9000-00000000ca01',
    notification_class: overrides.notificationClass ?? 'question',
    notification_detail: 'Which currency should totals use?',
  });
};

/** Moves the harness's one task into shadow mode (BD-021), so its next row carries it. */
const intoShadowMode = async (harness: PipelineHarness): Promise<void> => {
  const stored = harness.store.snapshot()[0] as NonNullable<
    ReturnType<PipelineHarness['store']['snapshot']>[number]
  >;
  await harness.memory.transaction(async (scope) => {
    await harness.store.tasks.save(scope.tx, {
      ...stored,
      task: { ...stored.task, mode: 'shadow' },
    });
  });
};

const digestCalls = (harness: PipelineHarness) =>
  harness.audit.entries.filter((entry) => entry.action === 'post_digest');

/**
 * The idempotency keys the digest's calls actually reserved, decoded out of their storage keys.
 *
 * `idempotencyStorageKey` is `integration:action:key` with each part percent-encoded, so the third
 * segment is the key `communicationWrites.digest` cut — which is what the assertion is about.
 */
const digestKeys = (harness: PipelineHarness): readonly string[] =>
  harness.idempotency
    .keys()
    .map((key) => key.split(':'))
    .filter((parts) => parts[1] === 'post_digest')
    .map((parts) => decodeURIComponent(parts[2] ?? ''));

describe('the digest', () => {
  it('posts nothing before the project’s own hour, and posts at it', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    await deferred(harness);
    harness.communication?.messages.splice(0);

    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T08:55:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T08:55:00.000Z',
      }),
    ).toBe('not_due');
    expect(harness.communication?.messages).toEqual([]);

    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T09:00:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T09:00:00.000Z',
      }),
    ).toBe('posted');
    expect(harness.communication?.messages).toHaveLength(1);
    expect(harness.communication?.messages[0]?.markdown).toContain(`${TICKET_KEY} is waiting`);
  });

  it('carries the deferred notification and marks it delivered by digest', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    await deferred(harness);
    await runProjectDigest(optionsOf(harness, '2026-06-02T09:00:00.000Z'), {
      projectId: PROJECT,
      at: '2026-06-02T09:00:00.000Z',
    });
    const row = harness.notifications.rows.find((entry) => entry.notificationClass === 'question');
    expect(row).toMatchObject({
      plannedDelivery: 'digest',
      deliveredAs: 'digest',
      digestDay: '2026-06-02',
    });
    expect(row?.deliveredAt).not.toBeNull();
  });

  it('posts one message for a day however often the job runs — read from the audit, not the port', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    await deferred(harness);
    harness.communication?.messages.splice(0);
    const run = async () =>
      runProjectDigest(optionsOf(harness, '2026-06-02T09:00:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T09:00:00.000Z',
      });

    expect(await run()).toBe('posted');
    expect(await run()).toBe('sent');
    expect(harness.communication?.messages, 'the provider is entered once a day').toHaveLength(1);
    expect(digestCalls(harness)).toHaveLength(1);
  });

  it('makes one call per mode, so a shadow task’s lines never ride in a real message', async () => {
    /**
     * BD-021: a shadow task's mutations are *recorded* and never performed. A digest spans tasks
     * and the executor's shadow guard takes the mode of the **call**, so a single call carrying
     * both modes would either post a shadow task's lines to the channel or suppress a real task's.
     * The claim this pins is therefore about the *split*, not about the port's return value: two
     * executor rows, one per mode, each carrying only its own line — and only the normal one
     * reaching the provider.
     */
    const harness = harnessWith();
    await taskOf(harness);
    await deferred(harness);
    await intoShadowMode(harness);
    await deferred(harness, {
      cause: '00000000-0000-4000-9000-00000000ca02',
      at: '2026-06-01T23:05:00.000Z',
      notificationClass: 'stage_returned',
    });
    expect(
      harness.notifications.rows.filter((row) => row.deliveredAt === null).map((row) => row.mode),
      'the outbox holds one waiting row of each mode',
    ).toEqual(['normal', 'shadow']);
    harness.communication?.messages.splice(0);

    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T09:00:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T09:00:00.000Z',
      }),
    ).toBe('posted');

    expect(
      digestCalls(harness).map((entry) => [entry.status, entry.payload.item_count]),
      'one call per mode, each with its own rows',
    ).toEqual([
      ['ok', 1],
      ['would_have', 1],
    ]);
    expect(harness.communication?.messages, 'the shadow call posts nothing').toHaveLength(1);
    expect(harness.communication?.messages[0]?.markdown).toContain('is waiting for an answer');
    expect(
      harness.communication?.messages[0]?.markdown,
      'the shadow task’s line is not in the real message',
    ).not.toContain('went back a stage');
    /**
     * The key the posted call reserved, in full. The shadow call reserved none: the executor
     * answers a mutating shadow request at step 1, *before* the idempotency step, so its `:shadow`
     * suffix cannot be observed through the store on this build — measured, and said at the line
     * that builds the key rather than claimed here.
     */
    expect(digestKeys(harness)).toEqual([`fake-chat:digest:#agentic:2026-06-02:${PROJECT}`]);
    // Both rows are settled by this digest: the shadow one is recorded, not left for tomorrow.
    expect(harness.notifications.rows.filter((row) => row.deliveredAs === 'digest').length).toBe(2);
  });

  /**
   * **Two projects on one account and one channel are two digests** (WP-93, PROGRESS backlog 317).
   * The executor scopes a key by account and action alone; with no project in the key the second
   * project's digest of the day was answered as a replay of the first's — marked digested, logged
   * "posted", never sent.
   */
  it('posts one digest per project when two projects share an account and a channel on one day', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    await deferred(harness);
    const OTHER = '00000000-0000-4000-8000-0000000000b2' as Id;
    // The second project's row, written as the duty would have written it; the harness's
    // integrations answer the same account and channel for every project.
    await harness.memory.transaction(async (scope) =>
      harness.notifications.record(scope.tx, {
        id: '00000000-0000-4000-8000-0000000000f2' as Id,
        projectId: OTHER,
        taskId: null,
        notificationClass: 'question',
        causeEventId: '00000000-0000-4000-9000-00000000ca02' as Id,
        title: 'OTHER-1 is waiting for an answer',
        detail: null,
        url: null,
        urgent: false,
        plannedDelivery: 'digest',
        mode: 'normal',
        createdAt: '2026-06-01T23:30:00.000Z' as never,
        redactionCount: 0,
      }),
    );
    harness.communication?.messages.splice(0);
    const at = '2026-06-02T09:00:00.000Z';
    for (const projectId of [PROJECT, OTHER]) {
      expect(await runProjectDigest(optionsOf(harness, at), { projectId, at: at as never })).toBe(
        'posted',
      );
    }
    expect(harness.communication?.messages, 'two digests reached the channel').toHaveLength(2);
    expect(harness.communication?.messages[1]?.markdown).toContain('OTHER-1');
    expect([...digestKeys(harness)].sort()).toEqual(
      [
        `fake-chat:digest:#agentic:2026-06-02:${PROJECT}`,
        `fake-chat:digest:#agentic:2026-06-02:${OTHER}`,
      ].sort(),
    );
  });

  it('says so when a day fills the item limit, instead of shedding the remainder in silence', async () => {
    const harness = harnessWith();
    const lines: string[] = [];
    const logger: Logger = {
      ...silentLogger,
      info: (_fields, message) => {
        lines.push(message);
      },
    };
    await harness.memory.transaction(async (scope) => {
      for (let index = 0; index <= DIGEST_ITEM_LIMIT; index += 1) {
        await harness.notifications.record(scope.tx, {
          id: harness.ids.next(),
          projectId: PROJECT,
          taskId: null,
          notificationClass: 'budget_threshold',
          causeEventId: `00000000-0000-4000-9000-${index.toString(16).padStart(12, '0')}` as Id,
          title: `row ${index}`,
          detail: null,
          url: null,
          urgent: false,
          plannedDelivery: 'digest',
          mode: 'normal',
          createdAt: '2026-06-01T23:00:00.000Z',
          redactionCount: 0,
        });
      }
    });

    expect(
      await runProjectDigest(
        { ...optionsOf(harness, '2026-06-02T09:00:00.000Z'), logger },
        { projectId: PROJECT, at: '2026-06-02T09:00:00.000Z' },
      ),
    ).toBe('posted');
    expect(lines.some((message) => message.includes('filled the item limit'))).toBe(true);
    // Nothing is lost: the row over the limit is still waiting, for the next digest to claim.
    expect(harness.notifications.rows.filter((row) => row.deliveredAt === null)).toHaveLength(1);
  });

  it('posts nothing at all on an empty day', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    // Everything the drain produced was delivered immediately (09:00 is outside the window).
    harness.communication?.messages.splice(0);
    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T09:00:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T09:00:00.000Z',
      }),
    ).toBe('empty');
    expect(harness.communication?.messages).toEqual([]);
    expect(digestCalls(harness)).toEqual([]);
  });

  it('skips a project that switched the digest off, and leaves its rows undelivered', async () => {
    const harness = harnessWith({
      settings: {
        config: {
          features: {
            digest: { enabled: false, at: '09:00', quiet_hours: { from: '22:00', to: '08:00' } },
          },
        },
      },
    });
    await taskOf(harness);
    // With the digest off nothing is ever deferred, so this row is an immediate delivery that
    // failed — which the digest does not turn into a daily message the project did not ask for.
    await harness.memory.transaction(async (scope) =>
      harness.notifications.record(scope.tx, {
        id: '00000000-0000-4000-8000-00000000aa01' as Id,
        projectId: PROJECT,
        taskId: null,
        notificationClass: 'budget_threshold',
        causeEventId: '00000000-0000-4000-9000-00000000ca09' as Id,
        title: 'This project is close to its budget',
        detail: null,
        url: null,
        urgent: false,
        plannedDelivery: 'immediate',
        mode: 'normal',
        createdAt: '2026-06-01T23:00:00.000Z',
        redactionCount: 0,
      }),
    );
    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T09:00:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T09:00:00.000Z',
      }),
    ).toBe('disabled');
    expect(harness.notifications.rows.at(-1)?.deliveredAt).toBeNull();
  });

  it('says so for a project with no chat binding', async () => {
    const harness = harnessWith({ communication: null });
    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T09:00:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T09:00:00.000Z',
      }),
    ).toBe('no_binding');
  });

  it('reads the day and the hour in the organisation’s zone', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    await deferred(harness, { at: '2026-06-01T23:00:00.000Z' });
    harness.communication?.messages.splice(0);
    // 07:30 UTC is 09:30 in Prague: due there, an hour and a half early in UTC.
    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T07:30:00.000Z'), {
        projectId: PROJECT,
        at: '2026-06-02T07:30:00.000Z',
      }),
    ).toBe('not_due');
    expect(
      await runProjectDigest(optionsOf(harness, '2026-06-02T07:30:00.000Z', 'Europe/Prague'), {
        projectId: PROJECT,
        at: '2026-06-02T07:30:00.000Z',
      }),
    ).toBe('posted');
    const row = harness.notifications.rows.find((entry) => entry.notificationClass === 'question');
    expect(row?.digestDay, 'the day is the organisation’s, not UTC’s').toBe('2026-06-02');
  });

  it('renders one line per notification, with the class as the state', async () => {
    expect(
      digestItemOf({
        id: '00000000-0000-4000-8000-00000000aa02' as Id,
        projectId: PROJECT,
        taskId: null,
        notificationClass: 'escalation',
        causeEventId: '00000000-0000-4000-9000-00000000ca02' as Id,
        title: 'ACME-1 needs a human',
        detail: 'CI is down',
        url: null,
        urgent: true,
        plannedDelivery: 'digest',
        mode: 'normal',
        createdAt: '2026-06-01T23:00:00.000Z',
        redactionCount: 0,
        approvalId: null,
        questionId: null,
        messageRef: null,
        deliveredAt: null,
        deliveredAs: null,
        digestDay: null,
      }),
    ).toEqual({ title: 'ACME-1 needs a human', state: 'escalation', detail: 'CI is down' });
  });

  it('serves every project with something waiting from one tick', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    await deferred(harness);
    harness.communication?.messages.splice(0);
    await digestTickHandler(optionsOf(harness, '2026-06-02T09:00:00.000Z'))({
      id: 'job-1',
      queue: JOB_QUEUES.notifyDigest,
      data: {},
      signal: AbortSignal.abort(),
    });
    expect(harness.communication?.messages).toHaveLength(1);
  });

  it('is scheduled by the composition root, in the organisation’s zone', async () => {
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: {},
      timezone: 'Europe/Prague',
    });
    // `drain` is what starts the runtime in this harness, so one is enough to see the schedule.
    await harness.drain();
    expect(harness.jobs.crons).toContainEqual({
      queue: JOB_QUEUES.notifyDigest,
      cron: DIGEST_TICK_CRON,
      timezone: 'Europe/Prague',
      key: 'tick',
    });
  });
});

/**
 * **The digest re-checks a question's reminder** (WP-84 review round 2, PROGRESS backlog 292). A
 * reminder raised during quiet hours is planned for the morning digest; a question answered
 * overnight must not be carried as "still waiting", and its row is closed **withheld** — not left
 * undelivered for the gauge to count, the re-post to retry or tomorrow's digest to carry.
 */
describe('the digest re-checks what it carries (WP-84 review round 2)', () => {
  const QUESTION = '00000000-0000-4000-8000-0000000084b1' as Id;
  const REMINDER_CAUSE = '00000000-0000-4000-9000-0000000084b2';

  const withOpenQuestion = async (harness: PipelineHarness): Promise<Id> => {
    const task = (
      harness.store.snapshot()[0] as NonNullable<
        ReturnType<PipelineHarness['store']['snapshot']>[number]
      >
    ).task;
    await harness.memory.transaction(async (scope) =>
      harness.store.questions.insert(scope.tx, {
        id: QUESTION,
        taskId: task.id,
        projectId: PROJECT,
        stage: 'refinement' as never,
        runId: null,
        text: 'Which currency should totals use?',
        options: null,
        blocking: true,
        status: 'open',
        askedAt: '2026-06-01T15:00:00.000Z' as never,
        deadlineAt: '2026-06-02T15:00:00.000Z' as never,
        remindersSent: 0,
        answer: null,
        answeredByUserId: null,
        answeredVia: null,
        answeredAt: null,
        sequence: 1,
      }),
    );
    return task.id;
  };

  /** The reminder the timer raises at 23:00, deferred by quiet hours into the digest. */
  const remindAtNight = async (harness: PipelineHarness, taskId: Id): Promise<void> => {
    await runNotification(optionsOf(harness, '2026-06-01T23:00:00.000Z'), {
      duty: 'notify',
      project_id: PROJECT,
      task_id: taskId,
      cause_event_id: REMINDER_CAUSE,
      notification_class: 'reminder',
      notification_detail: 'Still unanswered: Which currency should totals use?',
      reminder_of: QUESTION,
      reminder_aggregate: 'question',
    });
  };

  const answer = async (harness: PipelineHarness): Promise<void> => {
    const question = await harness.store.questions.load({} as never, QUESTION);
    await harness.memory.transaction(async (scope) =>
      harness.store.questions.save(scope.tx, {
        ...(question as NonNullable<typeof question>),
        status: 'answered',
        answer: 'EUR',
        answeredAt: '2026-06-02T07:00:00.000Z' as never,
      }),
    );
  };

  const morning = (harness: PipelineHarness, at = '2026-06-02T09:00:00.000Z') =>
    runProjectDigest(optionsOf(harness, at), { projectId: PROJECT, at: at as never });

  const reminderRow = (harness: PipelineHarness) =>
    harness.notifications.rows.find((row) => row.causeEventId === REMINDER_CAUSE);

  it('carries a reminder whose question is still open (the control)', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    const taskId = await withOpenQuestion(harness);
    await remindAtNight(harness, taskId);
    expect(reminderRow(harness)).toMatchObject({ plannedDelivery: 'digest', questionId: QUESTION });
    harness.communication?.messages.splice(0);

    expect(await morning(harness)).toBe('posted');
    expect(harness.communication?.messages[0]?.markdown).toContain('still waiting');
    expect(reminderRow(harness)?.deliveredAs).toBe('digest');
  });

  it('does not carry a reminder answered overnight, closes it withheld, and never carries it later', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    const taskId = await withOpenQuestion(harness);
    await remindAtNight(harness, taskId);
    await answer(harness);
    harness.communication?.messages.splice(0);

    expect(await morning(harness)).toBe('empty');
    expect(harness.communication?.messages).toEqual([]);
    expect(digestCalls(harness)).toHaveLength(0);
    expect(reminderRow(harness)?.deliveredAs).toBe('withheld');
    expect(reminderRow(harness)?.deliveredAt).not.toBeNull();

    // A withheld row is terminal: the next day's digest has nothing to claim.
    expect(await morning(harness, '2026-06-03T09:00:00.000Z')).toBe('empty');
    expect(harness.communication?.messages).toEqual([]);
  });

  it('carries the rest of the day and withholds only the settled reminder', async () => {
    const harness = harnessWith();
    await taskOf(harness);
    const taskId = await withOpenQuestion(harness);
    await remindAtNight(harness, taskId);
    await deferred(harness, {
      cause: '00000000-0000-4000-9000-0000000084b3',
      at: '2026-06-01T23:05:00.000Z',
      notificationClass: 'stage_returned',
    });
    await answer(harness);
    harness.communication?.messages.splice(0);

    expect(await morning(harness)).toBe('posted');
    const posted = harness.communication?.messages[0]?.markdown ?? '';
    expect(posted).toContain('went back a stage');
    expect(posted).not.toContain('still waiting');
    expect(reminderRow(harness)?.deliveredAs).toBe('withheld');
  });
});
