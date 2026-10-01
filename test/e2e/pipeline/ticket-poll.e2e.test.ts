/**
 * **WP-87 criterion 1, end to end: a poll starts a ticket, and a poll and a webhook of one ticket
 * start it once, in either order.**
 *
 * A whole `apps/server` instance on PostgreSQL, the fake task manager reached through its
 * registration, and nothing appended by the test: polling is switched on the way an operator does
 * it — `poll_enabled` in `bindings.config` — and everything from there is production code: the
 * sweep's query, the `ticket.poll` queue, the binding loader, the executor's audited read, the
 * shared recorder writing `inbox` and the events in one transaction, the outbox and intake.
 *
 * Two facts about the harness the cases rest on, stated so a reader need not rediscover them:
 *
 *  - **The fake's clock is not the wall clock** (`FAKE_EPOCH`), and a binding's first poll reads
 *    only its last interval. So each case seeds the cursor at the fake's epoch — the same column a
 *    real binding's previous poll would have left — rather than waiting on two clocks to agree.
 *  - **The platform's own writes move the ticket** (the status mapping and the workpad bump the
 *    fake's `updated_at`), so a later poll records a *new* state of the ticket and appends a second
 *    `ticket.matched`. That is the case the criterion is about: intake's 1:1 rule must absorb it,
 *    and `taskCount()` is what is asserted — never a count of matches.
 */
import type { Id } from '@platform/contracts';
import { FAKE_EPOCH } from '@platform/integrations';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestPool } from '../../integration/support/postgres.js';
import { type PipelineE2E, startPipeline, TICKETS_INTEGRATION_ID } from '../support/pipeline.js';
import { featureScenarios } from '../support/scenarios.js';

/** The pick-up ticket, labelled for the fake registration's default pick-up rule. */
const LABELLED = [
  {
    key: 'ACME-1',
    title: 'Show the totals in the invoice footer',
    description: 'The footer sums the visible rows rather than all of them.',
    issueType: 'Story',
    labels: ['agentic'],
  },
];
const POLL_PREFIX = 'fake-task-management:poll:';

let harness: PipelineE2E | undefined;
let pool: pg.Pool | undefined;

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  await harness?.stop();
  harness = undefined;
});

const start = async (label: string): Promise<{ pipeline: PipelineE2E; sql: pg.Pool }> => {
  const pipeline = await startPipeline({
    scenarios: featureScenarios,
    label,
    tickets: LABELLED,
    // The sweep is what notices a binding switched on after boot; turned down so a case does not
    // wait a minute for it. The binding's own interval stays at the 30-second floor.
    env: { APP_TICKET_POLL_SWEEP_INTERVAL_MS: '500' },
  });
  harness = pipeline;
  pool = createTestPool(pipeline.database.connectionString, { max: 2 });
  return { pipeline, sql: pool };
};

/** What an operator does, plus the cursor a previous poll would have left (see the docblock). */
const switchPollingOn = async (sql: pg.Pool, projectId: Id): Promise<void> => {
  await sql.query(
    `update bindings
        set config = config || '{"poll_enabled": true, "poll_interval_seconds": 30}'::jsonb,
            poll_cursor = $3::timestamptz
      where project_id = $1 and integration_id = $2`,
    [projectId, TICKETS_INTEGRATION_ID, FAKE_EPOCH],
  );
};

const pollReads = async (pipeline: PipelineE2E): Promise<number> =>
  (await pipeline.auditRows()).filter(
    (row) => row.action === 'match_tickets' && row.status === 'ok',
  ).length;

const polledRows = async (pipeline: PipelineE2E): Promise<number> =>
  (await pipeline.inbox()).filter((row) => row.delivery_id.startsWith(POLL_PREFIX)).length;

describe('the ticket poller', () => {
  it('starts a ticket from a poll; a second poll and a later webhook of the same ticket start nothing', async () => {
    const { pipeline, sql } = await start('poll-first');
    expect(await pipeline.taskCount()).toBe(0);

    await switchPollingOn(sql, pipeline.projectId);
    await pipeline.settle('the task a poll started', (task) => task.id.length > 0);
    expect(await pollReads(pipeline)).toBeGreaterThanOrEqual(1);

    // The binding's next poll, a whole interval later — the chain re-armed itself.
    const before = await pollReads(pipeline);
    await pipeline.waitFor('a second poll of the binding', async () => {
      return (await pollReads(pipeline)) > before;
    });

    // And the webhook of the same ticket arrives afterwards: recorded, and absorbed by intake.
    const response = await pipeline.deliver(
      pipeline.tickets.emitTicketMatched({ ticketKey: 'ACME-1', rule: 'label:agentic' }),
    );
    expect(response.status).toBe(202);
    const webhookMatch = (await pipeline.events()).findLast(
      (event) => event.type === 'ticket.matched',
    );
    await pipeline.waitFor('the webhook’s match dispatched', async () => {
      return webhookMatch !== undefined && !(await pipeline.awaitingDispatch(webhookMatch.id));
    });

    expect(await pipeline.taskCount()).toBe(1);
    expect(await polledRows(pipeline)).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it('does not start a webhook-started ticket again, and records a polled edit as ticket.updated', async () => {
    const { pipeline, sql } = await start('webhook-first');

    const response = await pipeline.deliver(
      pipeline.tickets.emitTicketMatched({ ticketKey: 'ACME-1', rule: 'label:agentic' }),
    );
    expect(response.status).toBe(202);
    await pipeline.settle('the task the webhook started', (task) => task.id.length > 0);

    await switchPollingOn(sql, pipeline.projectId);
    await pipeline.waitFor('the poll’s first recorded match', async () => {
      return (await polledRows(pipeline)) >= 1;
    });
    const polledMatch = (await pipeline.events()).findLast(
      (event) => event.type === 'ticket.matched',
    );
    await pipeline.waitFor('the polled match dispatched', async () => {
      return polledMatch !== undefined && !(await pipeline.awaitingDispatch(polledMatch.id));
    });
    expect(await pipeline.taskCount()).toBe(1);

    // A human edits the ticket; this binding's webhook never says so. The next poll must.
    pipeline.tickets.emitTicketUpdated({
      ticketKey: 'ACME-1',
      description: 'Now with acceptance criteria.',
    });
    const edited = Date.parse(pipeline.tickets.peek('ACME-1')?.updated_at ?? '');
    await pipeline.waitFor('a polled ticket.updated at or after the edit', async () =>
      (await pipeline.events()).some(
        (event) =>
          event.type === 'ticket.updated' &&
          Date.parse((event.payload as { updated_at: string }).updated_at) >= edited,
      ),
    );
    // WP-60's consumer saw it: the live task's ticket signal moved (Q61 (b)).
    await pipeline.waitFor('the live task’s ticket signal stamped', async () => {
      const { rows } = await sql.query<{ ticket_signal_at: Date | null }>(
        'select ticket_signal_at from tasks',
      );
      return rows.length === 1 && rows[0]?.ticket_signal_at !== null;
    });
    expect(await pipeline.taskCount()).toBe(1);
  }, 240_000);
});

/**
 * **WP-110 criterion 4, PROGRESS backlog 298: a status-rule binding sees an edit to a ticket the
 * platform has moved on.** The pick-up rule is a **status** (`pickup_status`), and the project's
 * status mapping moves the ticket to *In Progress* at refinement — after which the rule no longer
 * matches it. The poll's second read, the live tasks' tickets whatever the rule says, is what
 * records the human's edit; it records it as `ticket.updated` only, and WP-60's ticket signal
 * stamps the live task.
 */
describe('the ticket poller, on a status-rule binding (WP-110)', () => {
  it('stamps the live task’s ticket signal for an edit made after the status mapping moved the ticket on', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'poll-status-rule',
      tickets: [{ ...(LABELLED[0] as (typeof LABELLED)[number]), status: 'Ready for agent' }],
      config: {
        version: 1,
        status_mapping: { refinement: 'In Progress', ready_for_merge: 'In Review' },
      },
      env: { APP_TICKET_POLL_SWEEP_INTERVAL_MS: '500' },
    });
    harness = pipeline;
    pool = createTestPool(pipeline.database.connectionString, { max: 2 });
    const sql = pool;
    await sql.query(
      `update bindings
          set config = config || '{"poll_enabled": true, "poll_interval_seconds": 30, "pickup_status": "Ready for agent"}'::jsonb,
              poll_cursor = $3::timestamptz
        where project_id = $1 and integration_id = $2`,
      [pipeline.projectId, TICKETS_INTEGRATION_ID, FAKE_EPOCH],
    );

    await pipeline.settle('the task a poll started', (task) => task.id.length > 0);
    await pipeline.waitFor(
      'the status mapping moved the ticket off the pick-up status',
      async () => pipeline.tickets.peek('ACME-1')?.status === 'In Progress',
    );
    const matchedBefore = (await pipeline.events()).filter(
      (event) => event.type === 'ticket.matched',
    ).length;

    // A human edits the ticket. This binding has no webhook, and its rule no longer matches.
    const editedAt = Date.now();
    pipeline.tickets.emitTicketUpdated({
      ticketKey: 'ACME-1',
      description: 'Now with acceptance criteria.',
    });
    const edited = Date.parse(pipeline.tickets.peek('ACME-1')?.updated_at ?? '');

    await pipeline.waitFor('the live task’s ticket signal stamped after the edit', async () => {
      const { rows } = await sql.query<{ ticket_signal_at: Date | null }>(
        'select ticket_signal_at from tasks',
      );
      const at = rows[0]?.ticket_signal_at ?? null;
      return rows.length === 1 && at !== null && at.getTime() >= editedAt;
    });
    // The signal came from a polled `ticket.updated` carrying the edit's own instant …
    expect(
      (await pipeline.events()).some(
        (event) =>
          event.type === 'ticket.updated' &&
          Date.parse((event.payload as { updated_at: string }).updated_at) >= edited,
      ),
    ).toBe(true);
    // … and never from a pick-up: no `ticket.matched` since the ticket left the rule.
    expect(
      (await pipeline.events()).filter((event) => event.type === 'ticket.matched'),
    ).toHaveLength(matchedBefore);
    expect(await pipeline.taskCount()).toBe(1);
  }, 240_000);
});
