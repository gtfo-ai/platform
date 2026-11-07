/**
 * WP-177 at the fake-Claude e2e tier — the ticket claim and `status_mapping`, through a whole
 * `apps/server` instance on PostgreSQL (BD-031 rulings 2 and 5, TD-029 decisions 1, 3 and 5), and
 * since S-26.2 the claim that keeps a linked member's ticket.
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

  /**
   * S-26.2 criterion 6 (BD-031's 2026-11-06 amendment 2, TD-031's amendment item 5): a ticket
   * assigned to a **linked member** of the project, on a claiming binding that does not take
   * assigned tickets, runs to Ready and is still that member's — through the production directory
   * (`user_identities` and the member's role, `createPostgresTaskOwnerDirectory`), the production
   * store and every call through `IntegrationActionExecutor`. Before S-26.2 intake skipped it.
   */
  it('S-26.2 (6): a ticket assigned to a linked member runs to Ready and is still assigned to that member', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'lifecycle-member-held',
      tickets: [
        {
          ...(TICKETS[0] as (typeof TICKETS)[number]),
          status: 'Ready for the agent',
          assignee: 'acct-dana',
        },
      ],
      ticketStatuses: STATUSES,
      config: { version: 1 },
    });
    harness = pipeline;
    // Dana is the seeded operator, a `member` by default; her tracker account is linked to her.
    await pipeline.query(
      `insert into user_identities (provider, external_id, user_id, display_name)
       values ('fake-task-management', 'acct-dana', $1, 'Dana')`,
      [pipeline.userId],
    );
    await bindTicketLifecycle(pipeline, {
      pickup_status: 'Ready for the agent',
      lifecycle: {
        in_progress: 'Doing',
        in_review: 'Waiting for review',
        take_assigned_tickets: false,
      },
    });
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    await pipeline.waitFor('the in_review move reached the ticket', async () =>
      Promise.resolve(pipeline.tickets.peek('ACME-1')?.status === 'Waiting for review'),
    );

    // Still Dana's: the platform wrote no assignment and took nothing off.
    expect(pipeline.tickets.peek('ACME-1')?.assignee).toBe('acct-dana');
    const calls = pipeline.tickets.core.calls.map((call) => call.action);
    expect(calls).not.toContain('assign_to_self');
    expect(calls).not.toContain('unassign');
    const actions = (await pipeline.auditRows()).map((row) => row.action);
    expect(actions).not.toContain('assign_to_self');
    expect(actions).not.toContain('unassign');
    const types = (await pipeline.events()).map((event) => event.type);
    expect(types).not.toContain('ticket.intake.skipped');
    expect(types).not.toContain('ticket.claim.refused');
    expect(types.filter((type) => type === 'ticket.claimed')).toHaveLength(1);
    const rows = await pipeline.query<{
      ticket_claim: { held_by?: string; status: string; in_progress_written: boolean };
      owner_user_id: string | null;
      ticket_assignee: { external_id: string; platform: boolean } | null;
    }>('select ticket_claim, owner_user_id, ticket_assignee from tasks where project_id = $1', [
      pipeline.projectId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ticket_claim).toMatchObject({
      held_by: 'member',
      status: 'confirmed',
      in_progress_written: true,
    });
    expect(rows[0]?.owner_user_id).toBe(pipeline.userId);
    expect(rows[0]?.ticket_assignee).toMatchObject({ external_id: 'acct-dana', platform: false });
  });
});
