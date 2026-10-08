/**
 * WP-177 at the fake-Claude e2e tier — the ticket claim and `status_mapping`, through a whole
 * `apps/server` instance on PostgreSQL (BD-031 rulings 2 and 5, TD-029 decisions 1, 3 and 5).
 *
 * The binding's `lifecycle` block is written into `bindings.config` the way `PUT …/bindings`
 * stores it, so the production settings port reads it (`readTicketLifecycle`), the production
 * loader validates it against the fake registration's schema, and every call reaches the fake
 * tracker through `IntegrationActionExecutor` with its `integration_actions` row.
 *
 * Every status name here is an invented fixture value (BD-031 ruling 1).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  inboundEvent,
  type PipelineE2E,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const STATUSES = ['Ready for the agent', 'Doing', 'Waiting for review', 'Finished'];

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

/** The project's task-management binding overlay, as `PUT …/bindings` would have stored it. */
const bindTicketLifecycle = async (pipeline: PipelineE2E, config: object): Promise<void> => {
  await pipeline.query(
    'update bindings set config = $3::jsonb where project_id = $1 and integration_id = $2',
    [pipeline.projectId, TICKETS_INTEGRATION_ID, JSON.stringify(config)],
  );
};

/** The lifecycle calls the fake tracker saw — the claim's and the release's, never a read. */
const LIFECYCLE_ACTIONS = new Set(['self_identity', 'assign_to_self', 'unassign']);

describe('the ticket claim and status_mapping at the e2e tier (WP-177)', () => {
  it('(5) with no lifecycle block: zero assign, unassign or lifecycle calls, and status_mapping applies as before', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'lifecycle-none',
      tickets: [{ ...(TICKETS[0] as (typeof TICKETS)[number]), status: 'Ready for the agent' }],
      ticketStatuses: STATUSES,
      config: { version: 1, status_mapping: { refinement: 'Doing' } },
    });
    harness = pipeline;
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    await pipeline.waitFor('the mapped status reached the ticket', async () =>
      Promise.resolve(pipeline.tickets.peek('ACME-1')?.status === 'Doing'),
    );

    const calls = pipeline.tickets.core.calls.map((call) => call.action);
    expect(calls.filter((action) => LIFECYCLE_ACTIONS.has(action))).toEqual([]);
    // One transition — the mapping's — and no lifecycle move.
    expect(calls.filter((action) => action === 'transition')).toHaveLength(1);
    const actions = (await pipeline.auditRows()).map((row) => row.action);
    expect(actions).not.toContain('assign_to_self');
    expect(actions).not.toContain('unassign');
    expect(actions).not.toContain('self_identity');
    const types = (await pipeline.events()).map((event) => event.type);
    expect(types).not.toContain('ticket.claimed');
    const claims = await pipeline.query<{ ticket_claim: unknown; qa_stage: boolean }>(
      'select ticket_claim, qa_stage from tasks where project_id = $1',
      [pipeline.projectId],
    );
    expect(claims).toEqual([{ ticket_claim: null, qa_stage: false }]);
    expect(pipeline.tickets.peek('ACME-1')?.assignee ?? null).toBeNull();
  });

  it('(1) with a lifecycle block: the first agent admission claims, moves to in_progress, records ticket.claimed, and the run starts; status_mapping is superseded', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'lifecycle-claim',
      tickets: [{ ...(TICKETS[0] as (typeof TICKETS)[number]), status: 'Ready for the agent' }],
      ticketStatuses: STATUSES,
      // Mapped, and superseded by the block below: it must move nothing.
      config: { version: 1, status_mapping: { ready_for_merge: 'Finished' } },
    });
    harness = pipeline;
    await bindTicketLifecycle(pipeline, {
      pickup_status: 'Ready for the agent',
      lifecycle: { in_progress: 'Doing', in_review: 'Waiting for review' },
    });
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    await pipeline.waitFor('the in_review move reached the ticket', async () =>
      Promise.resolve(pipeline.tickets.peek('ACME-1')?.status === 'Waiting for review'),
    );

    const ticket = pipeline.tickets.peek('ACME-1');
    expect(ticket?.assignee).toBe('agentic-bot');
    const calls = pipeline.tickets.core.calls.map((call) => call.action);
    expect(calls.filter((action) => LIFECYCLE_ACTIONS.has(action))).toEqual([
      'self_identity',
      'assign_to_self',
    ]);
    const events = await pipeline.events();
    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === 'ticket.claimed')).toHaveLength(1);
    expect(types.indexOf('ticket.claimed')).toBeLessThan(types.indexOf('run.created'));
    expect(types.filter((type) => type === 'run.created').length).toBeGreaterThan(1);
    const rows = await pipeline.query<{ ticket_claim: { status: string; account_id: string } }>(
      'select ticket_claim from tasks where project_id = $1',
      [pipeline.projectId],
    );
    expect(rows[0]?.ticket_claim).toMatchObject({
      status: 'confirmed',
      account_id: 'agentic-bot',
      in_progress_written: true,
    });
    // The superseded mapping moved nothing: the ticket never reached its status.
    expect(
      (await pipeline.auditRows())
        .filter((row) => row.action === 'transition_ticket')
        .map((row) => (row.payload as { to: string }).to),
    ).not.toContain('Finished');
  });
});
