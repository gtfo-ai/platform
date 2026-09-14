/**
 * **WP-32's headline criterion: the platform tells a human something.**
 *
 * Everything from the event in is production code — the `notify.chat` handler at TD-005 priority
 * 210, the `pipeline.outbound` duty, the binding loader reading `integrations`/`bindings` and
 * decrypting `secrets`, the strict config parse, the channel read off the key the provider's
 * registration declares, the redactor composition, `IntegrationActionExecutor` with its shadow
 * guard and its idempotency store, the `notifications` table and the `notify.digest` worker. Only
 * the far side of the chat provider's HTTP call is a double.
 *
 * Three things this file is written to be able to fail on.
 *
 *  - **The countable effect is a row, not a return value** (standing rule 79): every assertion is on
 *    `notifications`, on `integration_actions` written by the instance's *own* audit adapter, or on
 *    the messages the fake actually stored.
 *  - **The wait is on the last row the platform writes** (standing rule 87): `delivered_at` is
 *    written in its own transaction *after* the provider call returns, so a test that waited on the
 *    provider's record and then read the row would be racing the platform. Here it is the other way
 *    round, in both cases.
 *  - **The quiet window is configuration, not the clock.** The instance runs on the real clock, so
 *    the window is computed from *now* in the organisation's zone (`TZ=UTC` in this harness) to
 *    cover it — a wall-clock **input**, never a wall-clock assertion (standing rule 2). The
 *    boundaries themselves are asserted with an injected clock in the unit tier.
 */
import { jobs as jobsAdapters } from '@platform/infrastructure';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHAT_CHANNEL,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ticketMatched = (pipeline: PipelineE2E, key: string) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

interface NotificationRow extends Record<string, unknown> {
  class: string;
  planned_delivery: string;
  delivered_as: string | null;
  delivered_at: string | null;
  digest_day: string | null;
  title: string;
  detail: string | null;
  mode: string;
  urgent: boolean;
}

const notifications = (pipeline: PipelineE2E) =>
  pipeline.query<NotificationRow>(
    `select class, planned_delivery, delivered_as, delivered_at, digest_day, title, detail, mode,
            urgent
       from notifications order by created_at`,
  );

/** A window in the organisation's zone that contains this instant, so "now" is quiet. */
const quietHoursAroundNow = (): { from: string; to: string } => {
  const at = (offsetMinutes: number): string => {
    const minutes = (Math.floor(Date.now() / 60_000) + offsetMinutes + 1440 * 2) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  };
  return { from: at(-90), to: at(90) };
};

describe('the notification band, through a composed instance', () => {
  it('opens the task thread and posts what happened, with a row for each', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'notify',
      tickets: TICKETS,
      // Quiet hours off — the shipped default — so everything is immediate.
      config: { features: { digest: { enabled: true, at: '09:00', quiet_hours: null } } },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.current_stage).toBe('ready_for_merge');

    // The last row the platform writes for a notification is `delivered_at`, in a transaction of
    // its own after the provider answered. Waiting on it is what makes the provider assertions
    // below safe (standing rule 87).
    await pipeline.waitFor('the pick-up notification to be delivered', async () => {
      const rows = await notifications(pipeline);
      return rows.some((row) => row.class === 'task_started' && row.delivered_at !== null);
    });

    const rows = await notifications(pipeline);
    const started = rows.find((row) => row.class === 'task_started');
    expect(started).toMatchObject({
      planned_delivery: 'immediate',
      delivered_as: 'immediate',
      mode: 'normal',
      urgent: false,
      title: 'ACME-1 picked up',
    });

    // The messages the provider actually holds — the thread root, in the channel the **account**
    // configured and the loader read off the key Slack's and the fake's registrations declare.
    const messages = pipeline.chat.messagesIn(CHAT_CHANNEL);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.markdown).toContain('ACME-1 picked up');
    // The **root** of the task thread rather than a reply in it: one thread per task (product/08),
    // and the class whose message *is* the root is `task_started`.
    expect(messages[0]?.kind, 'the root of the task thread').toBe('thread');

    // …and the audit rows the instance's own adapter wrote (standing rules 31/35).
    const audit = await pipeline.auditRows();
    const chatActions = audit.filter((row) => row.action.startsWith('post_'));
    expect(chatActions.map((row) => row.action)).toContain('post_task_thread');
    expect(chatActions.every((row) => row.status === 'ok')).toBe(true);

    /**
     * **Criterion 10's measurement**, and the number is produced rather than quoted: how many
     * notifications one feature ticket generates before the human merge. It is the figure that says
     * whether an unbatched path is usable at all, and it is pinned here so a change that made the
     * band chattier fails a test rather than a channel.
     */
    expect(rows.map((row) => row.class)).toEqual(['task_started']);
    expect(pipeline.chat.messages).toHaveLength(1);
  });

  it('holds a notification raised inside quiet hours, and the digest carries it', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'notify-quiet',
      tickets: TICKETS,
      config: {
        features: {
          digest: {
            enabled: true,
            // Always due: this instance runs on the real clock, so the digest's hour must be one
            // that has already passed in the organisation's zone whenever the suite runs.
            at: '00:00',
            quiet_hours: quietHoursAroundNow(),
          },
        },
      },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.waitFor('the pick-up notification to be recorded', async () => {
      const rows = await notifications(pipeline);
      return rows.some((row) => row.class === 'task_started');
    });

    const deferred = (await notifications(pipeline)).find((row) => row.class === 'task_started');
    expect(deferred).toMatchObject({ planned_delivery: 'digest', delivered_at: null });
    expect(pipeline.chat.messages, 'nothing is posted inside the window').toEqual([]);

    /**
     * The tick, enqueued through a **second** pg-boss client on the same database — which is what a
     * second replica is. The instance's own `notify.digest` worker is what runs it; the cron that
     * would have woken it fires every five minutes, which is longer than this suite may wait.
     */
    const runtime = jobsAdapters.createPgBossJobs({
      connectionString: pipeline.database.connectionString,
    });
    await runtime.start();
    try {
      await runtime.jobs.enqueue({ queue: 'notify.digest', data: {} });
    } finally {
      await runtime.stop();
    }

    await pipeline.waitFor('the digest to deliver it', async () => {
      const rows = await notifications(pipeline);
      return rows.some((row) => row.class === 'task_started' && row.delivered_at !== null);
    });

    const digested = (await notifications(pipeline)).find((row) => row.class === 'task_started');
    expect(digested?.delivered_as).toBe('digest');
    expect(digested?.digest_day).not.toBeNull();

    // One digest message, carrying the line that was held back.
    const digests = pipeline.chat.messages.filter((message) => message.kind === 'digest');
    expect(digests).toHaveLength(1);
    expect(digests[0]?.markdown).toContain('ACME-1 picked up');
    const audit = await pipeline.auditRows();
    expect(audit.filter((row) => row.action === 'post_digest')).toHaveLength(1);
  });

  it('schedules the digest tick in the organisation’s zone', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'notify-cron',
      tickets: TICKETS,
    });
    harness = pipeline;
    // pg-boss's own schedule table: the composition root's `scheduleCron`, as the database holds it.
    const schedules = await pipeline.query<{ name: string; cron: string; timezone: string }>(
      "select name, cron, timezone from pgboss.schedule where name = 'notify.digest'",
    );
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.timezone, 'never the host zone (Q38)').toBe('UTC');
  });
});
