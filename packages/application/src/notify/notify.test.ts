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
import { runNotification } from './duty.js';
import { decideNotification, notifyHandler } from './handlers.js';
import type { NotifyOptions } from './options.js';
import { digestSettingsOf } from './policy.js';
import {
  boundText,
  boundUrl,
  NOTIFICATION_DETAIL_MAX,
  NOTIFICATION_TITLE_MAX,
  NOTIFICATION_URL_MAX,
  notificationBody,
  notificationDraft,
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

  it('refuses an organisation-scoped budget, which has no project and therefore no channel', () => {
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
    expect(decideNotification(budget(null))).toBeNull();
    expect(decideNotification(budget(PROJECT))).toMatchObject({
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

  it('registers at TD-005 priority 210 for the eight types technical/02 names', () => {
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
