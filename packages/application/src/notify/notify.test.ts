/**
 * The notification band, driven through the real handler, the real `pipeline.outbound` duty and the
 * real `IntegrationActionExecutor` over the harness's doubles (WP-32).
 *
 * What lives here is the **branches**: a project with no chat binding, a platform-issued ticket, a
 * duplicated wake-up, a planted credential, a shadow task, and both sides of the quiet window with
 * an injected clock. The e2e tier runs the same band on PostgreSQL through the real registration
 * and the real binding loader, which is where the rows, the decryption and the config validation
 * stop being doubles.
 *
 * The clock is **always** injected (standing rule 2): every quiet-hours case constructs its own
 * `testClock` at a named instant, so nothing here depends on when the suite runs.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { markTransactions } from '../events/open-transaction.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import { staticProjectSettings } from '../pipeline/settings.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
  testClock,
} from '../testing/pipeline-harness.js';
import { approvalSettledKey, runApprovalSettled } from './approval-settled.js';
import { digestTickHandler, runOrganisationDigest } from './digest.js';
import { runNotification } from './duty.js';
import {
  approvalSettledHandler,
  decideNotification,
  notifyHandler,
  questionSettledHandler,
} from './handlers.js';
import type { NotifyOptions } from './options.js';
import { runOrganisationNotification } from './organisation.js';
import { digestSettingsOf } from './policy.js';
import { awaitsImmediateRetry, type StoredNotification } from './ports.js';
import { questionSettledKey, runQuestionSettled } from './question-settled.js';
import {
  boundText,
  boundUrl,
  NOTIFICATION_DETAIL_MAX,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_URL_MAX,
  notificationBody,
  notificationDraft,
  unlabelledLinks,
} from './render.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const TICKET_KEY = 'ACME-1';
const TICKET_URL = 'https://tickets.example.test/browse/ACME-1';
const CAUSE = '00000000-0000-4000-9000-00000000ca01' as Id;

/** An obviously fake credential (BD-002), planted so the redaction assertion has a target. */
const PLANTED = 'FAKE-chat-token-not-a-real-secret-0000';
const PLACEHOLDER = '[REDACTED:integration:chat_token]';
const PLANTED_NAME = 'chat_token';

let stream = 0;

/** A matched ticket. `url` is a parameter because it is one of the untrusted fields under test. */
const matched = (url: string = TICKET_URL): DomainEvent => {
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
      ticket: { provider: 'fake-jira', key: TICKET_KEY, url },
      rule: 'label:agentic',
      priority: 'Medium',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;
};

const harnessWith = (overrides: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT as Id,
    communication: {},
    runs: {},
    ...overrides,
  });

/** The duty's dependencies, built out of the harness, with the transaction guard **armed**. */
const optionsOf = (
  harness: PipelineHarness,
  overrides: { readonly timezone?: string; readonly now?: string } = {},
): NotifyOptions => {
  const clock = overrides.now === undefined ? harness.clock : testClock(overrides.now);
  return {
    store: harness.store,
    settings: staticProjectSettings(() => harness.settings),
    jobs: harness.jobs,
    calendar: harness.calendar,
    integrations: staticPipelineIntegrations(harness.integrations),
    ids: harness.ids,
    clock: { now: () => clock.now() },
    // Marked, so a duty that reached a provider from inside a transaction is refused here rather
    // than reviewed for (WP-15d's guard; the harness's own runtime marks its copy the same way).
    unitOfWork: markTransactions(harness.memory),
    notifications: harness.notifications,
    timezone: overrides.timezone ?? 'UTC',
    organisation: harness.organisation,
    heldConnections: harness.heldConnections,
    organisationSettings: harness.organisationSettings,
  };
};

/** Drives a ticket to a task and returns it, so a notification has something real to be about. */
const taskOf = async (harness: PipelineHarness, url: string = TICKET_URL): Promise<Id> => {
  await harness.publish([matched(url)]);
  const task = harness.store.snapshot()[0];
  expect(task, 'intake created no task').toBeDefined();
  return (task as NonNullable<typeof task>).task.id;
};

const notify = async (
  harness: PipelineHarness,
  data: Partial<PipelineOutboundData> & { readonly notification_class: string },
  overrides: Parameters<typeof optionsOf>[1] = {},
): Promise<void> => {
  await runNotification(optionsOf(harness, overrides), {
    duty: 'notify',
    project_id: PROJECT,
    cause_event_id: CAUSE,
    ...data,
  });
};

describe('what an event would say', () => {
  it('maps every event the band consumes onto a class, and nothing else', () => {
    expect(decideNotification(matched())).toBeNull();
    const created = domainEventSchemasByType['task.created'].parse({
      id: '00000000-0000-4000-9000-00000000dd01',
      stream_type: 'task',
      stream_id: '00000000-0000-4000-8000-0000000000c1',
      stream_seq: 1,
      correlation_id: null,
      cause_event_id: null,
      actor: { kind: 'system', component: 'pipeline' },
      occurred_at: '2026-06-01T09:00:00.000Z',
      type: 'task.created',
      payload: {
        project_id: PROJECT,
        task_id: '00000000-0000-4000-8000-0000000000c1',
        ticket: { provider: 'fake-jira', key: TICKET_KEY, url: TICKET_URL },
        template: 'feature',
        mode: 'normal',
      },
    }) as DomainEvent;
    expect(decideNotification(created)).toMatchObject({
      notificationClass: 'task_started',
      projectId: PROJECT,
      detail: 'Pipeline: feature.',
    });
  });

  it('routes an organisation-scoped budget to the organisation, and a project’s to the project (WP-65)', () => {
    const budget = (projectId: string | null) =>
      domainEventSchemasByType['budget.exhausted'].parse({
        id: '00000000-0000-4000-9000-00000000dd02',
        stream_type: 'budget',
        stream_id: '00000000-0000-4000-8000-0000000000f1',
        stream_seq: 1,
        correlation_id: null,
        cause_event_id: null,
        actor: { kind: 'system', component: 'pipeline' },
        occurred_at: '2026-06-01T09:00:00.000Z',
        type: 'budget.exhausted',
        payload: {
          project_id: projectId,
          budget_id: '00000000-0000-4000-8000-0000000000f1',
          scope: projectId === null ? 'org' : 'project',
          scope_id: null,
          window: 'month',
          limit_usd: 10,
          spent_usd: 12.5,
        },
      }) as DomainEvent;
    // Backlog 80: it was `null` — decided, and heard by nobody. It is the organisation's now.
    expect(decideNotification(budget(null))).toMatchObject({
      notificationClass: 'budget_exhausted',
      projectId: null,
      taskId: null,
      subject: 'The organisation',
      detail: expect.stringContaining('$12.50 of $10.00'),
    });
    // Criterion 3: the project-scoped path is unchanged.
    expect(decideNotification(budget(PROJECT))).toMatchObject({
      projectId: PROJECT,
      notificationClass: 'budget_exhausted',
      taskId: null,
      subject: 'This project',
      detail: expect.stringContaining('$12.50 of $10.00'),
    });
  });

  it('renders a body out of platform text and bounds every untrusted field', () => {
    const draft = notificationDraft({
      notificationClass: 'escalation',
      subject: { name: 'A'.repeat(500), url: TICKET_URL },
      detail: 'B'.repeat(5000),
    });
    expect(draft.title.length).toBeLessThanOrEqual(NOTIFICATION_TITLE_MAX);
    expect(draft.detail?.length).toBeLessThanOrEqual(NOTIFICATION_DETAIL_MAX);
    expect(draft.title).toContain('needs a human');
    // The markdown is the platform's sentence with the values quoted into it, and no `blocks`:
    // blocks are structure whose text the provider does not escape (the port says so).
    expect(notificationBody(draft)).toEqual({
      markdown: `**${draft.title}**\n${draft.detail}\n${TICKET_URL}`,
    });
    expect(boundText('short', 10)).toBe('short');
    expect(boundText('0123456789', 5)).toBe('0123…');
  });
});

/** `task.created` as intake emits it — used where a test dispatches by hand. */
const taskCreated = (): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType['task.created'].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'task',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'pipeline' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'task.created',
    payload: {
      project_id: PROJECT,
      task_id: `00000000-0000-4000-8000-${suffix}`,
      ticket: { provider: 'fake-jira', key: TICKET_KEY, url: TICKET_URL },
      template: 'feature',
      mode: 'normal',
    },
  }) as DomainEvent;
};

describe('the handler decides and never calls', () => {
  it('enqueues one outbound duty per notified event, after the commit', async () => {
    const harness = harnessWith();
    // Dispatched by hand rather than through `publish`, which drains the queue it would be read
    // from: what is asserted here is the **wake-up** the handler enqueues, not what running it did.
    await harness.memory.transaction(async (scope) => scope.events.append([taskCreated()]));
    for (const pending of [...harness.memory.pending]) {
      const stored = harness.memory.log.find((row) => row.position === pending.eventPosition);
      if (stored !== undefined) {
        await harness.bus.dispatch(stored);
      }
    }
    const enqueued = harness.jobs
      .take(JOB_QUEUES.pipelineOutbound)
      .map((job) => job.data as PipelineOutboundData)
      .filter((data) => data.duty === 'notify');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      notification_class: 'task_started',
      project_id: PROJECT,
      notification_detail: 'Pipeline: feature.',
    });
  });

  it('registers at TD-005 priority 210 for the nine types technical/02 names', () => {
    const handler = notifyHandler({} as never);
    expect(handler.priority).toBe(210);
    expect(handler.eventTypes).toEqual([
      'task.created',
      'task.stage.returned',
      'task.question.asked',
      'task.escalated',
      'task.completed',
      'task.cancelled',
      'budget.threshold.reached',
      'budget.exhausted',
      // WP-43: the buttons technical/02 names, now that a click can reach the platform.
      'task.approval.requested',
    ]);
  });

  it('posts the thread and the message through the executor, and records the row', async () => {
    const harness = harnessWith();
    await harness.publish([matched()]);
    const rows = harness.notifications.rows.filter(
      (row) => row.notificationClass === 'task_started',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notificationClass: 'task_started',
      plannedDelivery: 'immediate',
      deliveredAs: 'immediate',
      mode: 'normal',
    });
    expect(harness.communication?.messages[0]?.markdown).toBe(
      `**${TICKET_KEY} picked up**\nPipeline: feature.\n${TICKET_URL}`,
    );
    // Through the executor, so there is an audit row naming the action (BD-003).
    expect(harness.audit.entries.map((entry) => entry.action)).toContain('post_task_thread');
  });
});

describe('quiet hours defer and never drop', () => {
  const quiet = {
    settings: {
      config: {
        features: { digest: { enabled: true, quiet_hours: { from: '22:00', to: '08:00' } } },
      },
    },
  } as HarnessOptions;

  it('holds a non-urgent notification raised inside the window for the digest', async () => {
    const harness = harnessWith(quiet);
    const taskId = await taskOf(harness);
    harness.communication?.messages.splice(0);
    await notify(
      harness,
      { task_id: taskId, notification_class: 'question', notification_detail: 'Which currency?' },
      { now: '2026-06-01T22:00:00.000Z' },
    );
    const row = harness.notifications.rows.at(-1);
    expect(row).toMatchObject({ notificationClass: 'question', plannedDelivery: 'digest' });
    expect(row?.deliveredAt, 'a deferred notification is not delivered yet').toBeNull();
    expect(harness.communication?.messages, 'nothing is posted inside the window').toEqual([]);
  });

  it('delivers the same notification raised a minute outside the window', async () => {
    const harness = harnessWith(quiet);
    const taskId = await taskOf(harness);
    harness.communication?.messages.splice(0);
    await notify(
      harness,
      { task_id: taskId, notification_class: 'question', notification_detail: 'Which currency?' },
      { now: '2026-06-01T21:59:00.000Z' },
    );
    expect(harness.notifications.rows.at(-1)).toMatchObject({
      plannedDelivery: 'immediate',
      deliveredAs: 'immediate',
    });
    expect(harness.communication?.messages.at(-1)?.markdown).toContain('Which currency?');
  });

  it('delivers an urgent class inside the window, and defers it when the project says otherwise', async () => {
    const harness = harnessWith(quiet);
    const taskId = await taskOf(harness);
    harness.communication?.messages.splice(0);
    await notify(
      harness,
      { task_id: taskId, notification_class: 'escalation', notification_detail: 'CI is down' },
      { now: '2026-06-01T23:30:00.000Z' },
    );
    expect(harness.notifications.rows.at(-1)).toMatchObject({
      urgent: true,
      deliveredAs: 'immediate',
    });

    const relaxed = harnessWith({
      settings: {
        config: {
          features: {
            digest: { enabled: true, quiet_hours: { from: '22:00', to: '08:00' }, urgent: [] },
          },
        },
      },
    });
    const relaxedTask = await taskOf(relaxed);
    relaxed.communication?.messages.splice(0);
    await notify(
      relaxed,
      {
        task_id: relaxedTask,
        notification_class: 'escalation',
        notification_detail: 'CI is down',
      },
      { now: '2026-06-01T23:30:00.000Z' },
    );
    expect(relaxed.notifications.rows.at(-1)).toMatchObject({
      urgent: false,
      plannedDelivery: 'digest',
    });
    expect(relaxed.communication?.messages).toEqual([]);
  });

  it('reads the window in the organisation’s zone, not the host’s', async () => {
    // 21:30 UTC is 23:30 in Prague — inside a 22:00–08:00 window there and outside it in UTC.
    const harness = harnessWith(quiet);
    const taskId = await taskOf(harness);
    await notify(
      harness,
      { task_id: taskId, notification_class: 'question', notification_detail: 'Which currency?' },
      { now: '2026-06-01T21:30:00.000Z', timezone: 'Europe/Prague' },
    );
    expect(harness.notifications.rows.at(-1)?.plannedDelivery).toBe('digest');
  });
});

describe('what the duty refuses', () => {
  it('says nothing for a project with no chat binding, and writes no row', async () => {
    const harness = harnessWith({ communication: null });
    const taskId = await taskOf(harness);
    await notify(harness, { task_id: taskId, notification_class: 'question' });
    expect(harness.notifications.rows).toEqual([]);
  });

  it('records a duplicated wake-up once and posts once', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    harness.communication?.messages.splice(0);
    const twice = async () =>
      notify(harness, {
        task_id: taskId,
        notification_class: 'escalation',
        notification_detail: 'Look at the merge request',
      });
    await twice();
    await twice();
    expect(harness.notifications.rows.filter((row) => row.causeEventId === CAUSE)).toHaveLength(1);
    /**
     * **One** message, and the number is the evidence rather than an off-by-one.
     *
     * The task's thread was opened by the `task_started` notification the drain above already
     * delivered, and `taskThread` carries an idempotency plan keyed by the task — so the second
     * call replays the stored `ThreadRef` and never enters the provider (which is the half
     * `threads.ts` has described as *available and unused* since WP-10). What is posted here is the
     * escalation alone, once, however many times the wake-up arrives.
     */
    expect(harness.communication?.messages).toHaveLength(1);
    expect(harness.communication?.messages[0]?.thread).not.toBeNull();
  });

  /**
   * The project path's half of the same fix: with the digest **off**, nothing but the job's retry
   * can deliver an immediate notification whose first post failed.
   */
  it('delivers on the job’s retry when the first post failed, on a project with the digest off', async () => {
    let failures = 0;
    const harness = harnessWith({
      settings: { config: { features: { digest: { enabled: false } } } },
      communication: {
        postMessage: async (thread: { channel: string; thread_id: string }) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('chat provider unavailable');
          }
          return {
            provider: 'fake-chat',
            channel: thread.channel,
            message_id: 'esc-1',
            thread_id: thread.thread_id,
            url: null,
          };
        },
      },
    });
    const taskId = await taskOf(harness);
    // Armed after intake, whose own drain posts through the same port.
    failures = 1;
    const okPosts = () =>
      harness.audit.entries.filter(
        (entry) => entry.action === 'post_message' && entry.status === 'ok',
      ).length;
    const before = okPosts();
    const escalate = () =>
      notify(harness, {
        task_id: taskId,
        notification_class: 'escalation',
        notification_detail: 'Look at the merge request',
      });
    await expect(escalate()).rejects.toThrow();
    await escalate();
    await escalate();
    const rows = harness.notifications.rows.filter((row) => row.causeEventId === CAUSE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deliveredAs).toBe('immediate');
    expect(okPosts() - before, 'one successful post for the escalation').toBe(1);
  });

  it('re-posts a task’s undelivered row from the row alone, with the row’s own words (WP-84)', async () => {
    let failing = false;
    const bodies: string[] = [];
    const harness = harnessWith({
      settings: { config: { features: { digest: { enabled: false } } } },
      communication: {
        postMessage: async (
          thread: { channel: string; thread_id: string },
          body: { markdown?: string },
        ) => {
          if (failing) {
            throw new Error('chat provider unavailable');
          }
          bodies.push(body.markdown ?? '');
          return {
            provider: 'fake-chat',
            channel: thread.channel,
            message_id: `m-${bodies.length}`,
            thread_id: thread.thread_id,
            url: null,
          };
        },
      },
    });
    const taskId = await taskOf(harness);
    failing = true;
    await expect(
      notify(harness, {
        task_id: taskId,
        notification_class: 'escalation',
        notification_detail: 'Look at the merge request',
      }),
    ).rejects.toThrow();
    failing = false;
    bodies.splice(0);
    // The payload the recovery pass rebuilds from the row: no detail rides it.
    await notify(harness, { task_id: taskId, notification_class: 'escalation' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('needs a human');
    expect(bodies[0]).toContain('Look at the merge request');
    const rows = harness.notifications.rows.filter((row) => row.causeEventId === CAUSE);
    expect(rows[0]?.deliveredAs).toBe('immediate');
  });

  it('replays rather than re-sends a task row whose post succeeded before the row was marked (WP-84)', async () => {
    const harness = harnessWith({
      settings: { config: { features: { digest: { enabled: false } } } },
    });
    const taskId = await taskOf(harness);
    let marks = 0;
    const flaky: NotifyOptions = {
      ...optionsOf(harness),
      notifications: {
        ...harness.notifications,
        markDelivered: async (tx, input) => {
          marks += 1;
          if (marks === 1) {
            throw new Error('the database went away after the post');
          }
          await harness.notifications.markDelivered(tx, input);
        },
      },
    };
    const escalations = () =>
      (harness.communication?.messages ?? []).filter((message) =>
        message.markdown.includes('Look at the merge request'),
      );
    await expect(
      runNotification(flaky, {
        duty: 'notify',
        project_id: PROJECT,
        task_id: taskId,
        cause_event_id: CAUSE,
        notification_class: 'escalation',
        notification_detail: 'Look at the merge request',
      }),
    ).rejects.toThrow(/went away/);
    expect(escalations()).toHaveLength(1);

    // The recovery pass's rebuilt wake-up: the same cause and class, so the same idempotency key.
    await runNotification(flaky, {
      duty: 'notify',
      project_id: PROJECT,
      task_id: taskId,
      cause_event_id: CAUSE,
      notification_class: 'escalation',
    });
    expect(escalations(), 'replayed by the executor, never posted twice').toHaveLength(1);
    const row = harness.notifications.rows.find((entry) => entry.causeEventId === CAUSE);
    expect(row?.deliveredAs).toBe('immediate');
  });

  it('stays quiet about a platform-issued ticket’s lifecycle, but not about its escalation', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    // The lint, review-only and discovery tasks all carry `platform:<something>!<id>`.
    const stored = harness.store.snapshot()[0];
    await harness.memory.transaction(async (scope) => {
      await harness.store.tasks.save(scope.tx, {
        ...(stored as NonNullable<typeof stored>),
        task: {
          ...(stored as NonNullable<typeof stored>).task,
          ticket: { provider: 'platform', key: `lint!${TICKET_KEY}`, url: TICKET_URL },
        },
      });
    });
    harness.communication?.messages.splice(0);

    await notify(harness, { task_id: taskId, notification_class: 'task_completed' });
    expect(harness.notifications.rows.filter((row) => row.causeEventId === CAUSE)).toEqual([]);

    await notify(harness, {
      task_id: taskId,
      notification_class: 'escalation',
      notification_detail: 'Nobody can decide this',
    });
    expect(harness.notifications.rows.at(-1)?.notificationClass).toBe('escalation');
  });

  it('says nothing for a class this build does not know', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    await notify(harness, { task_id: taskId, notification_class: 'volcano' });
    expect(harness.notifications.rows.filter((row) => row.causeEventId === CAUSE)).toEqual([]);
  });
});

describe('what a notification must never carry', () => {
  it('redacts a planted credential out of the stored row and the message', async () => {
    const harness = harnessWith({
      chatRedactor: exactSecretRedactor([{ name: PLANTED_NAME, value: PLANTED }]),
    });
    const taskId = await taskOf(harness);
    harness.communication?.messages.splice(0);
    await notify(harness, {
      task_id: taskId,
      notification_class: 'escalation',
      notification_detail: `The runner refused the token ${PLANTED} twice`,
    });
    const row = harness.notifications.rows.at(-1);
    expect(row?.detail).toContain(PLACEHOLDER);
    expect(row?.detail).not.toContain(PLANTED);
    expect(row?.redactionCount).toBeGreaterThan(0);
    for (const message of harness.communication?.messages ?? []) {
      expect(message.markdown).not.toContain(PLANTED);
    }
  });

  it('redacts a planted credential out of the ticket URL, in the row and in the message', async () => {
    /**
     * The URL is provider text like the title and the detail — `tasks.ticket_url` is whatever the
     * ticket said, and a query string is a place a credential ends up. It is stored in
     * `notifications.url` and concatenated into the body, so it goes through the binding's redactor
     * and its replacements are counted into the row (standing rule 42: both sides).
     */
    const harness = harnessWith({
      chatRedactor: exactSecretRedactor([{ name: PLANTED_NAME, value: PLANTED }]),
    });
    const taskId = await taskOf(harness, `${TICKET_URL}?token=${PLANTED}`);
    harness.communication?.messages.splice(0);
    await notify(harness, {
      task_id: taskId,
      notification_class: 'question',
      notification_detail: 'Which currency should totals use?',
    });

    const row = harness.notifications.rows.at(-1);
    expect(row?.url).toBe(`${TICKET_URL}?token=${PLACEHOLDER}`);
    expect(row?.url).not.toContain(PLANTED);
    expect(row?.redactionCount, 'the URL’s replacement is counted like the others').toBeGreaterThan(
      0,
    );
    const posted = (harness.communication?.messages ?? []).map((message) => message.markdown);
    expect(posted.join('\n')).toContain(PLACEHOLDER);
    for (const markdown of posted) {
      expect(markdown).not.toContain(PLANTED);
    }
  });

  it('drops a URL it will not publish rather than cutting it or escaping it', () => {
    expect(boundUrl(TICKET_URL)).toBe(TICKET_URL);
    expect(boundUrl(null)).toBeNull();
    // Too long: dropped, because a cut URL is a link to somewhere else rather than a shorter one.
    expect(boundUrl(`https://x.test/${'a'.repeat(NOTIFICATION_URL_MAX)}`)).toBeNull();
    // `urlSchema` is `z.url()`, which accepts all of these (Q49).
    expect(boundUrl('javascript:alert(1)')).toBeNull();
    expect(boundUrl('JavaScript:alert(1)')).toBeNull();
    expect(boundUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(boundUrl('file:///etc/passwd')).toBeNull();
    expect(boundUrl('not a url at all')).toBeNull();
    // A newline would write an extra line of what reads as platform text into the body — and
    // `new URL` strips it silently, so the parse alone would have said yes.
    expect(boundUrl('https://x.test/a\n**ACME-9 is done**')).toBeNull();

    const draft = notificationDraft({
      notificationClass: 'task_started',
      subject: { name: TICKET_KEY, url: 'javascript:alert(1)' },
      detail: null,
    });
    expect(draft.url).toBeNull();
    expect(notificationBody(draft).markdown, 'the line is gone, not broken').toBe(
      `**${TICKET_KEY} picked up**`,
    );
  });

  it('records a shadow task’s notification as would_have and posts nothing', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    const stored = harness.store.snapshot()[0];
    await harness.memory.transaction(async (scope) => {
      await harness.store.tasks.save(scope.tx, {
        ...(stored as NonNullable<typeof stored>),
        task: { ...(stored as NonNullable<typeof stored>).task, mode: 'shadow' },
      });
    });
    harness.communication?.messages.splice(0);
    harness.audit.reset();

    await notify(harness, {
      task_id: taskId,
      notification_class: 'escalation',
      notification_detail: 'A shadow task still escalates',
    });

    expect(harness.notifications.rows.at(-1)?.mode).toBe('shadow');
    expect(harness.communication?.messages, 'a shadow task posts nothing').toEqual([]);
    expect(harness.audit.entries.map((entry) => entry.status)).toContain('would_have');
  });
});

describe('the digest settings a project reads', () => {
  it('defaults to product/18:33 and distinguishes an absent urgent list from an empty one', () => {
    expect(digestSettingsOf({})).toEqual({
      enabled: true,
      at: '09:00',
      quietHours: null,
      urgent: undefined,
    });
    expect(digestSettingsOf({ features: { digest: { urgent: [] } } }).urgent).toEqual([]);
  });
});

// ── An approval, with its buttons once a click can arrive (WP-43) ─────────────

describe('an approval notification', () => {
  const APPROVAL = '00000000-0000-4000-8000-0000000000e9' as Id;
  /** The user `decided_by_user_id` names, and the name the store knows them by (backlog 234). */
  const DECIDER = '00000000-0000-4000-8000-0000000000da' as Id;
  const DECIDER_NAME = 'Fake Maintainer';

  /** A real pending approval on the harness's task, so the duty's reload has a row to read. */
  const pendingApproval = async (
    harness: PipelineHarness,
    taskId: Id,
    status: 'pending' | 'approved' = 'pending',
  ): Promise<void> => {
    await harness.memory.transaction(async (scope) => {
      await harness.store.approvals.insert(scope.tx, {
        approval: {
          id: APPROVAL,
          taskId,
          projectId: PROJECT as Id,
          kind: 'plan',
          status,
          requestedAt: '2026-06-01T09:00:00.000Z' as never,
          deadlineAt: null,
          decidedByUserId: null,
          decidedAt: null,
          reason: null,
          remindersSent: 0,
          sequence: 1,
        },
        stage: 'architecture' as never,
        attempt: 1,
      });
    });
  };

  it('posts Approve / Request changes into the task thread when the binding can receive a click', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    await pendingApproval(harness, taskId);
    harness.communication?.messages.splice(0);

    await notify(harness, {
      task_id: taskId,
      notification_class: 'approval',
      notification_detail: 'The implementation plan needs a maintainer’s approval.',
      approval_id: APPROVAL,
    });

    expect(harness.communication?.messages).toHaveLength(1);
    expect(harness.communication?.messages[0]).toMatchObject({ approval: APPROVAL });
    expect(harness.communication?.messages[0]?.markdown).toContain(
      `${TICKET_KEY} is waiting for an approval`,
    );
    expect(harness.audit.entries.map((entry) => entry.action)).toContain('post_approval');
    expect(
      harness.notifications.rows.find((row) => row.notificationClass === 'approval'),
    ).toMatchObject({ deliveredAs: 'immediate' });
  });

  it('posts text naming the task page when the binding cannot receive a click', async () => {
    const harness = harnessWith({
      communication: {
        capabilities: () => ({
          threads: true,
          buttons: false,
          messageUpdate: true,
          socketMode: true,
          digest: true,
        }),
      },
    });
    const taskId = await taskOf(harness);
    await pendingApproval(harness, taskId);
    harness.communication?.messages.splice(0);

    await notify(harness, {
      task_id: taskId,
      notification_class: 'approval',
      approval_id: APPROVAL,
    });

    expect(harness.communication?.messages).toHaveLength(1);
    expect(harness.communication?.messages[0]?.approval).toBeUndefined();
    expect(harness.communication?.messages[0]?.markdown).toContain('Decide on the task page');
  });

  /**
   * PROGRESS backlog 200 (WP-72): a held transport posts buttons only while **a process holds it**,
   * which the configuration cannot say. Both directions over one binding whose configuration says
   * yes; the two-process tier asserts the same through the real row.
   */
  it.each([
    { held: true, buttons: true },
    { held: false, buttons: false },
  ])(
    'over a held transport, posts buttons only while a process holds it (held: $held)',
    async ({ held, buttons }) => {
      const harness = harnessWith({ chatConnectionHeld: held });
      const taskId = await taskOf(harness);
      await pendingApproval(harness, taskId);
      harness.communication?.messages.splice(0);

      await notify(harness, {
        task_id: taskId,
        notification_class: 'approval',
        approval_id: APPROVAL,
      });

      expect(harness.communication?.messages).toHaveLength(1);
      const [message] = harness.communication?.messages ?? [];
      if (buttons) {
        expect(message).toMatchObject({ approval: APPROVAL });
      } else {
        expect(message?.approval).toBeUndefined();
        expect(message?.markdown).toContain(
          'Decide on the task page: no process is holding this chat’s connection',
        );
      }
    },
  );

  it('does not ask the liveness row for a transport it does not hold (the HTTP one)', async () => {
    const harness = harnessWith({
      chatConnectionHeld: false,
      communication: {
        capabilities: () => ({
          threads: true,
          buttons: true,
          messageUpdate: true,
          socketMode: false,
          digest: true,
        }),
      },
    });
    const taskId = await taskOf(harness);
    await pendingApproval(harness, taskId);
    harness.communication?.messages.splice(0);

    await notify(harness, {
      task_id: taskId,
      notification_class: 'approval',
      approval_id: APPROVAL,
    });

    // A click over HTTP reaches `/webhooks/*`, which no row describes: buttons, as before WP-72.
    expect(harness.communication?.messages[0]).toMatchObject({ approval: APPROVAL });
  });

  it('announces nothing for an approval somebody already decided — no row, no message', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    await pendingApproval(harness, taskId, 'approved');
    harness.communication?.messages.splice(0);

    await notify(harness, {
      task_id: taskId,
      notification_class: 'approval',
      approval_id: APPROVAL,
    });

    expect(harness.communication?.messages).toEqual([]);
    expect(
      harness.notifications.rows.filter((row) => row.notificationClass === 'approval'),
    ).toEqual([]);
  });

  /** Settles the approval the way the aggregate would — the row's status, decided now. */
  const settle = async (
    harness: PipelineHarness,
    status: 'approved' | 'rejected' | 'expired',
    decidedBy: Id | null = status === 'expired' ? null : DECIDER,
  ): Promise<void> => {
    await harness.memory.transaction(async (scope) => {
      const stored = await harness.store.approvals.load(scope.tx, APPROVAL);
      if (stored === null) {
        throw new Error('no approval to settle');
      }
      await harness.store.approvals.save(scope.tx, {
        ...stored,
        approval: {
          ...stored.approval,
          status,
          decidedByUserId: decidedBy,
          decidedAt: '2026-06-01T10:00:00.000Z' as never,
          sequence: stored.approval.sequence + 1,
        },
      });
    });
  };

  const settled = async (harness: PipelineHarness, decision: string): Promise<void> => {
    await runApprovalSettled(optionsOf(harness), {
      duty: 'approval_settled',
      project_id: PROJECT,
      cause_event_id: '00000000-0000-4000-9000-00000000ca77',
      approval_id: APPROVAL,
      approval_decision: decision,
    });
  };

  /**
   * **A settled approval's buttons are removed** (WP-65, PROGRESS backlog 202). Read back from the
   * fake's recorded update *and* from the executor's audit row (rule 79), once per outcome.
   */
  for (const [outcome, sentence] of [
    // The user in `decided_by_user_id`, by name (WP-73, backlog 234) — not a role.
    ['approved', `Approved by ${DECIDER_NAME}.`],
    ['rejected', `Changes requested by ${DECIDER_NAME}.`],
    ['expired', 'Expired: nobody decided before the deadline'],
  ] as const) {
    it(`edits the posted message when the approval is ${outcome}, and its buttons are gone`, async () => {
      const harness = harnessWith({ users: { [DECIDER]: DECIDER_NAME } });
      const taskId = await taskOf(harness);
      await pendingApproval(harness, taskId);
      await notify(harness, {
        task_id: taskId,
        notification_class: 'approval',
        approval_id: APPROVAL,
      });
      const posted = harness.notifications.rows.find((row) => row.notificationClass === 'approval');
      expect(posted?.approvalId).toBe(APPROVAL);
      expect(
        posted?.messageRef?.message_id,
        'the address is recorded with the delivery',
      ).toBeTruthy();

      await settle(harness, outcome);
      await settled(harness, outcome);

      const updates = harness.communication?.updates ?? [];
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message_id).toBe(posted?.messageRef?.message_id);
      expect(updates[0]?.markdown).toContain(sentence);
      expect(updates[0]?.markdown).toContain(`${TICKET_KEY}: the approval is settled`);
      const audit = harness.audit.entries.filter((entry) => entry.action === 'update_message');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.status).toBe('ok');

      // A redelivered wake-up replays under the same key instead of editing twice.
      await settled(harness, outcome);
      expect(harness.communication?.updates).toHaveLength(1);
    });
  }

  it('keeps the role wording for a decider the store cannot name, and bounds a hostile name (backlog 234)', async () => {
    for (const [users, expected, absent] of [
      [{}, 'Approved by a maintainer. The task page names who.', 'Approved by .'],
      [
        { [DECIDER]: `[Ada](https://attacker.example) ${'x'.repeat(200)}` },
        'Approved by https://attacker.example',
        '[Ada](',
      ],
    ] as const) {
      const harness = harnessWith({ users });
      const taskId = await taskOf(harness);
      await pendingApproval(harness, taskId);
      await notify(harness, {
        task_id: taskId,
        notification_class: 'approval',
        approval_id: APPROVAL,
      });
      await settle(harness, 'approved');
      await settled(harness, 'approved');
      const markdown = harness.communication?.updates[0]?.markdown ?? '';
      expect(markdown).toContain(expected);
      expect(markdown).not.toContain(absent);
      expect(markdown).not.toContain('x'.repeat(100));
    }
  });

  it('edits nothing while the approval is pending, or when no message with buttons was posted', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    await pendingApproval(harness, taskId);
    await settled(harness, 'approved');
    expect(harness.communication?.updates).toEqual([]);

    await settle(harness, 'approved');
    // No `approval` notification was ever delivered, so there is no address to edit.
    await settled(harness, 'approved');
    expect(harness.communication?.updates).toEqual([]);
  });

  it('leaves a provider that cannot edit alone rather than posting a second message', async () => {
    const harness = harnessWith({
      communication: {
        capabilities: () => ({
          threads: true,
          buttons: true,
          messageUpdate: false,
          socketMode: true,
          digest: true,
        }),
      },
    });
    const taskId = await taskOf(harness);
    await pendingApproval(harness, taskId);
    await notify(harness, {
      task_id: taskId,
      notification_class: 'approval',
      approval_id: APPROVAL,
    });
    const before = harness.communication?.messages.length ?? 0;
    await settle(harness, 'expired');
    await settled(harness, 'expired');
    expect(harness.communication?.updates).toEqual([]);
    expect(harness.communication?.messages).toHaveLength(before);
  });

  it('closes the race: an approval settled while its buttons were being posted is edited by the posting duty', async () => {
    let settleDuringPost: (() => Promise<void>) | null = null;
    const harness = harnessWith({
      communication: {
        postApproval: async (thread, approval) => {
          // The person decides on the task page while the post is in flight.
          await settleDuringPost?.();
          return {
            provider: 'fake-chat',
            channel: thread.channel,
            message_id: `approval-${approval.id}`,
            thread_id: thread.thread_id,
            url: null,
          };
        },
      },
    });
    const taskId = await taskOf(harness);
    await pendingApproval(harness, taskId);
    settleDuringPost = async () => {
      await settle(harness, 'approved');
      // The settled duty runs now, finds no address yet, and stops.
      await settled(harness, 'approved');
    };
    await notify(harness, {
      task_id: taskId,
      notification_class: 'approval',
      approval_id: APPROVAL,
    });

    const updates = harness.communication?.updates ?? [];
    expect(updates, 'the posting duty edited it after recording the address').toHaveLength(1);
    expect(updates[0]?.message_id).toBe(`approval-${APPROVAL}`);
    expect(approvalSettledKey(APPROVAL as Id)).toBe(`notify:approval-settled:${APPROVAL}`);
  });

  it('is woken by task.approval.decided in the notify band, after the commit', () => {
    const handler = approvalSettledHandler({} as never);
    expect(handler.priority).toBe(210);
    expect(handler.eventTypes).toEqual(['task.approval.decided']);
  });
});

/**
 * **A question is posted through `postQuestion`, and its message is edited when it is settled**
 * (WP-88, PROGRESS backlog 195 and 233). The thread the question lives in is recorded durably, so a
 * reply in it reaches the task through a process that never opened it.
 */
describe('a question notification (WP-88)', () => {
  const QUESTION = '00000000-0000-4000-8000-0000000000f9' as Id;
  const ANSWERER = '00000000-0000-4000-8000-0000000000db' as Id;
  const ANSWERER_NAME = 'Fake Product Owner';

  const openedQuestion = async (harness: PipelineHarness, taskId: Id): Promise<void> => {
    await harness.memory.transaction(async (scope) => {
      await harness.store.questions.insert(scope.tx, {
        id: QUESTION,
        taskId,
        projectId: PROJECT as Id,
        stage: 'refinement' as never,
        runId: null,
        text: 'Which currency should totals use?',
        options: ['EUR', 'CZK'],
        blocking: true,
        status: 'open',
        askedAt: '2026-06-01T09:00:00.000Z' as never,
        deadlineAt: null,
        remindersSent: 0,
        answer: null,
        answeredByUserId: null,
        answeredVia: null,
        answeredAt: null,
        sequence: 1,
      });
    });
  };

  const ask = async (harness: PipelineHarness, taskId: Id): Promise<void> => {
    await notify(harness, {
      task_id: taskId,
      notification_class: 'question',
      notification_detail: 'Which currency should totals use?',
      question_id: QUESTION,
    });
  };

  /** Settles the question the way the aggregate would. */
  const settle = async (
    harness: PipelineHarness,
    status: 'answered' | 'expired',
  ): Promise<void> => {
    await harness.memory.transaction(async (scope) => {
      const question = await harness.store.questions.load(scope.tx, QUESTION);
      if (question === null) {
        throw new Error('no question to settle');
      }
      await harness.store.questions.save(scope.tx, {
        ...question,
        status,
        ...(status === 'answered'
          ? {
              answer: 'EUR',
              answeredByUserId: ANSWERER,
              answeredVia: 'slack' as const,
              answeredAt: '2026-06-01T10:00:00.000Z' as never,
            }
          : {}),
        sequence: question.sequence + 1,
      });
    });
  };

  const settled = async (harness: PipelineHarness): Promise<void> => {
    await runQuestionSettled(optionsOf(harness), {
      duty: 'question_settled',
      project_id: PROJECT,
      cause_event_id: '00000000-0000-4000-9000-00000000ca78',
      question_id: QUESTION,
    });
  };

  it('posts the question through `postQuestion` with its options, records its address and the thread', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    await openedQuestion(harness, taskId);
    harness.communication?.messages.splice(0);

    await ask(harness, taskId);

    const [message] = harness.communication?.messages ?? [];
    expect(harness.communication?.messages).toHaveLength(1);
    expect(message).toMatchObject({ question: QUESTION, options: ['EUR', 'CZK'] });
    expect(harness.audit.entries.map((entry) => entry.action)).toContain('post_question');
    const row = harness.notifications.rows.find((entry) => entry.notificationClass === 'question');
    expect(row).toMatchObject({ deliveredAs: 'immediate', questionId: QUESTION });
    expect(row?.messageRef?.thread_id, 'the address names the thread it was posted into').toBe(
      message?.thread,
    );
    // The durable half of the thread map (backlog 195): the thread the question went into.
    expect(harness.notifications.threads).toEqual([
      expect.objectContaining({
        projectId: PROJECT,
        integrationId: harness.communication?.port.ref.integrationId,
        taskId,
        threadId: message?.thread,
      }),
    ]);
  });

  it('posts text naming the task page when no reply or click can arrive, and still records its address', async () => {
    const harness = harnessWith({ chatConnectionHeld: false });
    const taskId = await taskOf(harness);
    await openedQuestion(harness, taskId);
    harness.communication?.messages.splice(0);

    await ask(harness, taskId);

    const [message] = harness.communication?.messages ?? [];
    expect(message?.question).toBeUndefined();
    expect(message?.markdown).toContain(
      'Answer on the task page: no process is holding this chat’s connection',
    );
    expect(
      harness.notifications.rows.find((entry) => entry.notificationClass === 'question')
        ?.messageRef,
    ).not.toBeNull();
  });

  it('records no thread for a shadow task, whose thread is a would-have placeholder (BD-021)', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    await harness.memory.transaction(async (scope) => {
      const stored = await harness.store.tasks.load(scope.tx, taskId);
      if (stored === null) {
        throw new Error('no task');
      }
      await harness.store.tasks.save(scope.tx, {
        ...stored,
        task: { ...stored.task, mode: 'shadow' },
      });
    });
    await openedQuestion(harness, taskId);
    // The real thread the task's `task_started` opened before it turned shadow is already there.
    const before = harness.notifications.threads;
    await ask(harness, taskId);
    expect(harness.notifications.threads).toEqual(before);
    expect(
      harness.notifications.threads.filter((thread) => thread.threadId.startsWith('would-have')),
    ).toEqual([]);
  });

  for (const [outcome, sentence] of [
    ['answered', `Answered by ${ANSWERER_NAME}.`],
    ['expired', 'Expired: nobody answered before the deadline'],
  ] as const) {
    it(`edits the posted question when it is ${outcome}: its buttons go, and the answer is not repeated`, async () => {
      const harness = harnessWith({ users: { [ANSWERER]: ANSWERER_NAME } });
      const taskId = await taskOf(harness);
      await openedQuestion(harness, taskId);
      await ask(harness, taskId);
      const posted = harness.notifications.rows.find((row) => row.notificationClass === 'question');

      await settle(harness, outcome);
      await settled(harness);

      const updates = harness.communication?.updates ?? [];
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message_id).toBe(posted?.messageRef?.message_id);
      expect(updates[0]?.markdown).toContain(sentence);
      expect(updates[0]?.markdown).toContain(`${TICKET_KEY}: the question is settled`);
      expect(updates[0]?.markdown).not.toContain('EUR');
      const audit = harness.audit.entries.filter((entry) => entry.action === 'update_message');
      expect(audit).toHaveLength(1);
      expect(audit[0]?.status).toBe('ok');

      // A redelivered wake-up replays under the same key instead of editing twice.
      await settled(harness);
      expect(harness.communication?.updates).toHaveLength(1);
    });
  }

  it('edits nothing while the question is open, when nothing was posted, or when the provider cannot edit', async () => {
    const harness = harnessWith();
    const taskId = await taskOf(harness);
    await openedQuestion(harness, taskId);
    await settled(harness);
    expect(harness.communication?.updates, 'still open').toEqual([]);
    await settle(harness, 'answered');
    await settled(harness);
    expect(harness.communication?.updates, 'no message was ever posted').toEqual([]);

    const cannot = harnessWith({
      communication: {
        capabilities: () => ({
          threads: true,
          buttons: true,
          messageUpdate: false,
          socketMode: true,
          digest: true,
        }),
      },
    });
    const other = await taskOf(cannot);
    await openedQuestion(cannot, other);
    await ask(cannot, other);
    const before = cannot.communication?.messages.length ?? 0;
    await settle(cannot, 'expired');
    await settled(cannot);
    expect(cannot.communication?.updates).toEqual([]);
    expect(cannot.communication?.messages).toHaveLength(before);
  });

  it('closes the race: a question answered while it was being posted is edited by the posting duty', async () => {
    let answerDuringPost: (() => Promise<void>) | null = null;
    const harness = harnessWith({
      communication: {
        postQuestion: async (thread, question) => {
          await answerDuringPost?.();
          return {
            provider: 'fake-chat',
            channel: thread.channel,
            message_id: `question-${question.id}`,
            thread_id: thread.thread_id,
            url: null,
          };
        },
      },
    });
    const taskId = await taskOf(harness);
    await openedQuestion(harness, taskId);
    answerDuringPost = async () => {
      await settle(harness, 'answered');
      await settled(harness);
    };
    await ask(harness, taskId);

    const updates = harness.communication?.updates ?? [];
    expect(updates, 'the posting duty edited it after recording the address').toHaveLength(1);
    expect(updates[0]?.message_id).toBe(`question-${QUESTION}`);
    expect(questionSettledKey(QUESTION)).toBe(`notify:question-settled:${QUESTION}`);
  });

  it('is woken by an answer and by an expiry in the notify band, after the commit', () => {
    const handler = questionSettledHandler({} as never);
    expect(handler.priority).toBe(210);
    expect(handler.eventTypes).toEqual(['task.question.answered', 'task.question.expired']);
  });
});

/**
 * **An organisation budget has a channel** (WP-65, PROGRESS backlog 80, answer (c)).
 *
 * The countable effect is the executor's audit row (rule 79), not the port's return value: exactly
 * one `post_channel_message`, attributed to the **organisation's** account (its own integration id)
 * and to no project; and a replay of the same wake-up adds none.
 */
describe('an organisation-scoped notification', () => {
  const orgExhausted = (): DomainEvent => {
    stream += 1;
    const suffix = stream.toString(16).padStart(12, '0');
    const budget = `00000000-0000-4000-8000-${suffix}`;
    return domainEventSchemasByType['budget.exhausted'].parse({
      id: `00000000-0000-4000-9000-${suffix}`,
      stream_type: 'budget',
      stream_id: budget,
      stream_seq: 1,
      correlation_id: null,
      cause_event_id: null,
      actor: { kind: 'system', component: 'pipeline' },
      occurred_at: '2026-06-01T09:00:00.000Z',
      type: 'budget.exhausted',
      payload: {
        project_id: null,
        budget_id: budget,
        scope: 'org',
        scope_id: null,
        window: 'month',
        limit_usd: 100,
        spent_usd: 100.25,
      },
    }) as DomainEvent;
  };

  it('posts exactly one message to the organisation’s own channel, audited to its account and no project', async () => {
    const harness = harnessWith({ organisationCommunication: {} });
    const event = orgExhausted();
    await harness.publish([event]);

    const audit = harness.audit.entries.filter((entry) => entry.action === 'post_channel_message');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      integrationId: harness.organisationCommunication?.port.ref.integrationId,
      projectId: null,
      taskId: null,
      status: 'ok',
    });
    expect(harness.organisationCommunication?.messages).toEqual([
      expect.objectContaining({ channel: '#org-alerts', thread: null }),
    ]);
    expect(harness.organisationCommunication?.messages[0]?.markdown).toContain(
      'The organisation has spent its budget',
    );
    // Never a project's channel: the project binding said nothing.
    expect(harness.communication?.messages).toEqual([]);

    const rows = harness.notifications.rows.filter((row) => row.projectId === null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notificationClass: 'budget_exhausted',
      taskId: null,
      urgent: true,
      deliveredAs: 'immediate',
    });

    // A duplicated wake-up — pg-boss is at-least-once — runs the same duty for the same event again.
    await runOrganisationNotification(optionsOf(harness), {
      duty: 'notify_organisation',
      cause_event_id: event.id,
      notification_class: 'budget_exhausted',
      notification_subject: 'The organisation',
      notification_detail: 'replayed',
    });
    expect(
      harness.audit.entries.filter((entry) => entry.action === 'post_channel_message'),
    ).toHaveLength(1);
    expect(harness.organisationCommunication?.messages).toHaveLength(1);
  });

  /**
   * **The retry of a failed post delivers** (WP-65 review round 1). The row is recorded before the
   * post, so the job's retry meets `record → false`; it must read the row back and post, not read
   * "already recorded" as "already told". One failed and one successful audit row, one message.
   */
  it('delivers on the job’s retry when the first post failed, exactly once', async () => {
    let failures = 1;
    const harness = harnessWith({
      organisationCommunication: {
        postChannelMessage: async (channel: string) => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('chat provider unavailable');
          }
          return {
            provider: 'fake-chat',
            channel,
            message_id: 'org-1',
            thread_id: null,
            url: null,
          };
        },
      },
    });
    const data = {
      duty: 'notify_organisation' as const,
      cause_event_id: '00000000-0000-4000-9000-00000000ca65',
      notification_class: 'budget_exhausted',
      notification_subject: 'The organisation',
      notification_detail: '$100.25 of $100.00 spent in the month window.',
    };
    await expect(runOrganisationNotification(optionsOf(harness), data)).rejects.toThrow();
    expect(harness.notifications.rows[0]?.deliveredAt, 'recorded, not delivered').toBeNull();

    await runOrganisationNotification(optionsOf(harness), data); // pg-boss's retry
    await runOrganisationNotification(optionsOf(harness), data); // and a late duplicate

    const posts = harness.audit.entries.filter((entry) => entry.action === 'post_channel_message');
    expect(posts.filter((entry) => entry.status === 'ok')).toHaveLength(1);
    expect(posts.filter((entry) => entry.status !== 'ok').length).toBeGreaterThan(0);
    expect(harness.notifications.rows).toHaveLength(1);
    expect(harness.notifications.rows[0]?.deliveredAs).toBe('immediate');
  });

  /**
   * **The re-post rebuilt from the row posts the row's own words** (WP-84, backlog 236 (2)). The
   * recovery pass re-enqueues this duty with the cause and the class only — no subject, no detail —
   * so a retry that re-rendered its payload would post a message with no budget line in it.
   */
  it('re-posts the recorded row’s text when woken from the row alone, once', async () => {
    let failing = true;
    const bodies: string[] = [];
    const harness = harnessWith({
      organisationCommunication: {
        postChannelMessage: async (channel: string, body: { markdown?: string }) => {
          if (failing) {
            throw new Error('chat provider unavailable');
          }
          bodies.push(body.markdown ?? '');
          return {
            provider: 'fake-chat',
            channel,
            message_id: 'org-2',
            thread_id: null,
            url: null,
          };
        },
      },
    });
    const cause = '00000000-0000-4000-9000-00000000ca84';
    await expect(
      runOrganisationNotification(optionsOf(harness), {
        duty: 'notify_organisation',
        cause_event_id: cause,
        notification_class: 'budget_exhausted',
        notification_subject: 'The organisation',
        notification_detail: '$100.25 of $100.00 spent in the month window.',
      }),
    ).rejects.toThrow();
    expect(harness.notifications.rows[0]?.deliveredAt).toBeNull();

    failing = false;
    // Exactly the payload `recovery/stranded.ts` rebuilds from the row.
    const rebuilt = {
      duty: 'notify_organisation' as const,
      cause_event_id: cause,
      notification_class: 'budget_exhausted',
    };
    await runOrganisationNotification(optionsOf(harness), rebuilt);
    await runOrganisationNotification(optionsOf(harness), rebuilt);

    const sent = harness.audit.entries.filter(
      (entry) => entry.action === 'post_channel_message' && entry.status === 'ok',
    );
    expect(sent).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('The organisation has spent its budget');
    expect(bodies[0]).toContain('$100.25 of $100.00 spent in the month window.');
    expect(harness.notifications.rows).toHaveLength(1);
    expect(harness.notifications.rows[0]?.deliveredAs).toBe('immediate');
  });

  /**
   * **The same idempotency key**: a first post that succeeded but whose `markDelivered` failed is
   * **replayed** by the executor on the re-post, not sent again (WP-84, backlog 236 (2)).
   */
  it('replays rather than re-sends a post that had succeeded before its row was marked', async () => {
    let marks = 0;
    const harness = harnessWith({ organisationCommunication: {} });
    const options = optionsOf(harness);
    const flaky: NotifyOptions = {
      ...options,
      notifications: {
        ...harness.notifications,
        markDelivered: async (tx, input) => {
          marks += 1;
          if (marks === 1) {
            throw new Error('the database went away after the post');
          }
          await harness.notifications.markDelivered(tx, input);
        },
      },
    };
    const cause = '00000000-0000-4000-9000-00000000ca85';
    await expect(
      runOrganisationNotification(flaky, {
        duty: 'notify_organisation',
        cause_event_id: cause,
        notification_class: 'budget_exhausted',
        notification_detail: '$101.00 of $100.00 spent in the month window.',
      }),
    ).rejects.toThrow(/went away/);
    expect(harness.organisationCommunication?.messages).toHaveLength(1);

    await runOrganisationNotification(flaky, {
      duty: 'notify_organisation',
      cause_event_id: cause,
      notification_class: 'budget_exhausted',
    });
    // One message on the provider, and the row delivered by the replay.
    expect(harness.organisationCommunication?.messages).toHaveLength(1);
    expect(harness.notifications.rows[0]?.deliveredAs).toBe('immediate');
  });

  /**
   * **A refused configuration leaves a row the gauge counts** (WP-84, backlog 236 (2), Q103). The
   * loader's refusal — two accounts each naming a channel — used to throw before `record`, so the
   * alarm left no row at all and `notifications_undelivered` could not count it.
   */
  it('records the undelivered row when the organisation’s configuration is refused, and still fails the job', async () => {
    const harness = harnessWith();
    const refusing: NotifyOptions = {
      ...optionsOf(harness),
      organisation: {
        forOrganisation: async () => {
          throw new Error(
            'the organisation has 2 communication accounts that name a channel of their own',
          );
        },
      },
    };
    const data = {
      duty: 'notify_organisation' as const,
      cause_event_id: '00000000-0000-4000-9000-00000000ca86',
      notification_class: 'budget_exhausted',
      notification_subject: 'The organisation',
      notification_detail: '$100.25 of $100.00 spent in the month window.',
    };
    await expect(runOrganisationNotification(refusing, data)).rejects.toThrow(/2 communication/);
    await expect(runOrganisationNotification(refusing, data)).rejects.toThrow(/2 communication/);

    // One row — the retry stops at the unique key — undelivered and planned immediate, which is
    // exactly what the gauge counts past the job's retry window and the re-post row picks up.
    expect(harness.notifications.rows).toHaveLength(1);
    expect(harness.notifications.rows[0]).toMatchObject({
      projectId: null,
      taskId: null,
      notificationClass: 'budget_exhausted',
      plannedDelivery: 'immediate',
      deliveredAt: null,
      digestDay: null,
      redactionCount: 0,
    });
    expect(harness.notifications.rows[0]?.detail).toContain('$100.25 of $100.00');
  });

  it('tells nobody — and writes no row — when the organisation has no chat account', async () => {
    const harness = harnessWith();
    await harness.publish([orgExhausted()]);
    expect(
      harness.audit.entries.filter((entry) => entry.action === 'post_channel_message'),
    ).toEqual([]);
    expect(harness.notifications.rows.filter((row) => row.projectId === null)).toEqual([]);
  });

  it('keeps a project’s own exhaustion on the project’s binding (criterion 3)', async () => {
    const harness = harnessWith({ organisationCommunication: {} });
    await notify(harness, {
      notification_class: 'budget_exhausted',
      notification_subject: 'This project',
      notification_detail: '$12.50 of $10.00 spent in the month window.',
    });
    expect(harness.communication?.messages).toHaveLength(1);
    expect(harness.organisationCommunication?.messages).toEqual([]);
    expect(harness.notifications.rows[0]?.projectId).toBe(PROJECT);
  });
});

/**
 * **The organisation's own quiet hours** (WP-93, PROGRESS backlog 235, criterion 3). Before WP-93
 * an organisation-scoped notification was always immediate — quiet hours were a project setting and
 * the organisation had no settings document. Now `notifications.quiet_hours` defers the non-urgent
 * class into the organisation's digest, and the urgent one still goes at once.
 */
describe('an organisation notification inside the organisation’s quiet hours', () => {
  const QUIET = {
    notifications: { quiet_hours: { from: '22:00', to: '07:00' }, digest_at: '08:30' },
  };
  const NIGHT = '2026-06-01T23:30:00.000Z';
  const data = (notificationClass: string, id: string) => ({
    duty: 'notify_organisation' as const,
    cause_event_id: `00000000-0000-4000-9000-0000000093${id}`,
    notification_class: notificationClass,
    notification_subject: 'The organisation',
    notification_detail: '$80.00 of $100.00 spent in the month window.',
  });

  it('holds budget_threshold for the organisation digest and posts budget_exhausted at once', async () => {
    const harness = harnessWith({ organisationCommunication: {}, organisationSettings: QUIET });
    const night = optionsOf(harness, { now: NIGHT });

    await runOrganisationNotification(night, data('budget_threshold', '01'));
    expect(harness.organisationCommunication?.messages).toEqual([]);
    expect(harness.notifications.rows).toHaveLength(1);
    expect(harness.notifications.rows[0]).toMatchObject({
      projectId: null,
      notificationClass: 'budget_threshold',
      plannedDelivery: 'digest',
      deliveredAt: null,
      urgent: false,
    });

    await runOrganisationNotification(night, data('budget_exhausted', '02'));
    expect(harness.organisationCommunication?.messages).toHaveLength(1);
    expect(harness.notifications.rows[1]).toMatchObject({
      notificationClass: 'budget_exhausted',
      plannedDelivery: 'immediate',
      deliveredAs: 'immediate',
    });
  });

  it('posts budget_threshold at once outside the window, and with no window at all', async () => {
    const outside = harnessWith({ organisationCommunication: {}, organisationSettings: QUIET });
    await runOrganisationNotification(
      optionsOf(outside, { now: '2026-06-01T12:00:00.000Z' }),
      data('budget_threshold', '03'),
    );
    expect(outside.organisationCommunication?.messages).toHaveLength(1);

    const none = harnessWith({ organisationCommunication: {} });
    await runOrganisationNotification(
      optionsOf(none, { now: NIGHT }),
      data('budget_threshold', '04'),
    );
    expect(none.organisationCommunication?.messages).toHaveLength(1);
    expect(none.notifications.rows[0]?.plannedDelivery).toBe('immediate');
  });

  it('is carried by the organisation digest at digest_at, once, on the organisation’s channel', async () => {
    const harness = harnessWith({ organisationCommunication: {}, organisationSettings: QUIET });
    await runOrganisationNotification(
      optionsOf(harness, { now: NIGHT }),
      data('budget_threshold', '05'),
    );

    // Before 08:30 in the organisation's zone the digest is not due.
    expect(
      await runOrganisationDigest(optionsOf(harness, { now: '2026-06-02T08:00:00.000Z' }), {
        at: '2026-06-02T08:00:00.000Z' as never,
      }),
    ).toBe('not_due');
    expect(harness.organisationCommunication?.messages).toEqual([]);

    // The tick serves the organisation's row beside the projects' (none are waiting here).
    const morning = optionsOf(harness, { now: '2026-06-02T08:35:00.000Z' });
    await digestTickHandler(morning)([] as never);
    expect(harness.organisationCommunication?.messages).toEqual([
      expect.objectContaining({ channel: '#org-alerts', thread: null }),
    ]);
    expect(harness.notifications.rows[0]).toMatchObject({ deliveredAs: 'digest' });
    // Audited against the organisation's account and no project, like the immediate post.
    expect(harness.audit.entries.filter((entry) => entry.action === 'post_digest')).toEqual([
      expect.objectContaining({ projectId: null, status: 'ok' }),
    ]);
    // A second tick the same day posts nothing.
    await digestTickHandler(morning)([] as never);
    expect(harness.organisationCommunication?.messages).toHaveLength(1);
  });

  it('has no digest when the organisation states no quiet hours', async () => {
    const harness = harnessWith({ organisationCommunication: {} });
    expect(
      await runOrganisationDigest(optionsOf(harness), { at: '2026-06-02T09:00:00.000Z' as never }),
    ).toBe('disabled');
  });

  it('records the undelivered row and fails the job when the organisation document does not parse', async () => {
    const harness = harnessWith({ organisationCommunication: {} });
    const refusing: NotifyOptions = {
      ...optionsOf(harness),
      organisationSettings: {
        read: async () => {
          throw new Error('organizations.settings does not parse (notifications.digest_at: "9am")');
        },
      },
    };
    await expect(
      runOrganisationNotification(refusing, data('budget_threshold', '06')),
    ).rejects.toThrow(/does not parse/);
    expect(harness.organisationCommunication?.messages).toEqual([]);
    expect(harness.notifications.rows).toEqual([
      expect.objectContaining({ projectId: null, plannedDelivery: 'immediate', deliveredAt: null }),
    ]);
  });
});

/**
 * **A link in a notification's detail is posted without its label** (WP-65, PROGRESS backlog 215).
 */
describe('links in a notification’s detail', () => {
  it('drops the label and keeps the target, to a fixpoint', () => {
    expect(unlabelledLinks('see [Approve](https://attacker.example/x) now')).toBe(
      'see https://attacker.example/x now',
    );
    // One pass would rebuild `[y](https://a)` out of what it removed.
    expect(unlabelledLinks('[x]([y](https://a.example))')).toBe('https://a.example');
    expect(unlabelledLinks('no links here')).toBe('no links here');
    // A mention written as a link keeps no brackets either; `toMrkdwn` keeps it inert.
    expect(unlabelledLinks('[urgent](!channel)')).toBe('!channel');
  });

  it('applies to the detail and to the subject’s name, never to the platform’s own sentence', () => {
    const draft = notificationDraft({
      notificationClass: 'stage_returned',
      subject: { name: '[ACME-1](https://evil.example)', url: TICKET_URL },
      detail: 'review → implementation: [summary] [Approve](https://attacker.example) <!channel>',
    });
    expect(draft.title).toBe('https://evil.example went back a stage');
    expect(draft.detail).toBe(
      'review → implementation: [summary] https://attacker.example <!channel>',
    );
    expect(draft.url).toBe(TICKET_URL);
  });
});

describe('which recorded row a retried wake-up still delivers', () => {
  const row = (overrides: Partial<StoredNotification>): StoredNotification => ({
    id: '00000000-0000-4000-8000-000000000001' as Id,
    projectId: null,
    taskId: null,
    approvalId: null,
    questionId: null,
    notificationClass: 'budget_exhausted',
    causeEventId: '00000000-0000-4000-8000-000000000002' as Id,
    title: 'Budget exhausted',
    detail: null,
    url: null,
    urgent: true,
    plannedDelivery: 'immediate',
    mode: 'normal',
    createdAt: '2026-09-27T08:00:00.000Z' as StoredNotification['createdAt'],
    redactionCount: 0,
    messageRef: null,
    deliveredAt: null,
    deliveredAs: null,
    digestDay: null,
    ...overrides,
  });

  it('delivers an immediate row nobody delivered or claimed', () => {
    expect(awaitsImmediateRetry(row({}))).toBe(true);
  });

  it('posts nothing for a row a digest has claimed, a delivered row, a digest-planned row or none', () => {
    // The digest owns a row it claimed: re-posting it from the retry would send it twice.
    expect(awaitsImmediateRetry(row({ digestDay: '2026-09-27' }))).toBe(false);
    expect(
      awaitsImmediateRetry(
        row({ deliveredAt: '2026-09-27T08:01:00.000Z' as StoredNotification['createdAt'] }),
      ),
    ).toBe(false);
    expect(awaitsImmediateRetry(row({ plannedDelivery: 'digest' }))).toBe(false);
    expect(awaitsImmediateRetry(null)).toBe(false);
  });
});
