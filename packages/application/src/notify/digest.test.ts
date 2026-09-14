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
    integrations: staticPipelineIntegrations(harness.integrations),
    ids: harness.ids,
    clock: { now: () => clock.now() },
    unitOfWork: markTransactions(harness.memory),
    notifications: harness.notifications,
    timezone,
  };
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
    await harness.publish([matched()]);
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
    await harness.publish([matched()]);
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
    await harness.publish([matched()]);
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
    await harness.publish([matched()]);
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
    expect(digestKeys(harness)).toEqual(['fake-chat:digest:#agentic:2026-06-02']);
    // Both rows are settled by this digest: the shadow one is recorded, not left for tomorrow.
    expect(harness.notifications.rows.filter((row) => row.deliveredAs === 'digest').length).toBe(2);
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
    await harness.publish([matched()]);
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
    await harness.publish([matched()]);
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
    await harness.publish([matched()]);
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
        deliveredAt: null,
        deliveredAs: null,
        digestDay: null,
      }),
    ).toEqual({ title: 'ACME-1 needs a human', state: 'escalation', detail: 'CI is down' });
  });

  it('serves every project with something waiting from one tick', async () => {
    const harness = harnessWith();
    await harness.publish([matched()]);
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
