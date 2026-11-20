/**
 * BACKLOG 1610 — **a Jira webhook's assignee or status change takes effect from the delivery**,
 * not at the next poll.
 *
 * The owner's report: a person changed a ticket's assignee in Jira and the platform's owner did not
 * follow. Measured on the install: the binding had no `webhook_secret`, so it was poll-only (434
 * poll rows in `inbox`, no webhook row). This suite proves the code path a registered webhook
 * takes, end to end through the real parts on each side of the bus:
 *
 *  - the **real** Jira normaliser (`createJiraInboundNormaliser`, signature verified with the
 *    binding's secret) turns a signed `jira:issue_updated` into events;
 *  - those events are enveloped as the ingress envelopes them (`inbound.ts`'s `envelope`: the
 *    project stream, the receipt instant as `occurred_at`) and published into the **real**
 *    pipeline — the harness's handlers, outbound jobs and stage executor;
 *  - and the assertion is the effect: the task's owner moves to the new assignee (`owner_sync`,
 *    S-26.1), and a ticket a person moved to Done cancels its task (`ticket_status_recheck`,
 *    S-28.5/S-28.14) — inside `harness.publish`, the delivery's own dispatch and the jobs it
 *    enqueued. The harness schedules no ticket poll at all, so nothing but the delivery can have
 *    moved either.
 *
 * How a poll-detected change flows, for comparison (`pipeline/ticket-poll.ts`): the poll re-reads a
 * live task's ticket and records `ticket.updated` with **no** changed fields. The webhook's
 * `ticket.updated` names its fields (`assignee`, `status`) and arrives beside
 * `ticket.status.changed`; both reach the same handlers — `pipeline.ticket.signal` (10) stamps the
 * snapshot stale, `pipeline.owner.sync` (120) and `pipeline.ticket.status.recheck` (120) enqueue
 * their duty — so the paths are equivalent and the webhook's is the one that does not wait.
 *
 * The owner sync still **reads** the ticket for the assignee (one read per burst) rather than
 * taking the changelog's `to`: the read is what every other path does, it re-checks the
 * platform-account guard against the tracker's current answer, and it costs one call per change
 * (BACKLOG 1084 stays open as the optimisation it is).
 */
import type { TaskManagementPort, TicketRefInput } from '@platform/application';
import type { DomainEvent, ExternalIdentity, Id, TicketStatusCategory } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { ticketStatusPolicyOf } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../../../packages/application/src/integrations/redaction.js';
import {
  createPipelineHarness,
  type PipelineHarness,
} from '../../../packages/application/src/testing/pipeline-harness.js';
import {
  createJiraInboundNormaliser,
  signWebhookBody,
} from '../../../packages/integrations/src/providers/jira-cloud/webhook.js';

const PROJECT = '00000000-0000-4000-8000-0000000016a0' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000016a1' as Id;
const ALICE = '00000000-0000-4000-8000-0000000016aa' as Id;
const BOB = '00000000-0000-4000-8000-0000000016bb' as Id;
const ALICE_ACCOUNT = '557058:00000000-0000-4000-8000-0000000016aa';
const BOB_ACCOUNT = '557058:00000000-0000-4000-8000-0000000016bb';
const BOT_ACCOUNT = '557058:00000000-0000-4000-8000-00000000b071';
const SITE = 'https://acme-example.atlassian.net';
const SECRET = 'FAKE-jira-webhook-secret-1610-0123456789';
const ISSUE_ID = '10001';
const KEY = 'ACME-1';

interface TicketState {
  assignee: string | null;
  status: string;
  category: TicketStatusCategory;
}

const identity = (account: string): ExternalIdentity => ({
  provider: 'jira-cloud',
  external_id: account,
  display_name: account === BOB_ACCOUNT ? 'Bob Example' : 'Alice Example',
  verified: false,
});

/** The tracker as the platform reads it back: one ticket, its assignee and status, every read. */
const tracker = (state: TicketState) => {
  let reads = 0;
  const port: Partial<TaskManagementPort> = {
    ref: {
      integrationId: INTEGRATION,
      provider: 'jira-cloud',
      type: 'task_management',
      host: null,
    },
    readTicket: async (ref: TicketRefInput) => {
      reads += 1;
      return {
        ref,
        issue_type: 'Story',
        title: 'Show the totals in the invoice footer',
        description: 'The footer sums the visible rows rather than all of them.',
        status: state.status,
        status_category: state.category,
        priority: null,
        labels: ['agentic'],
        comments: [],
        links: [],
        epic: null,
        siblings: [],
        attachments_text: [],
        assignee: state.assignee === null ? null : identity(state.assignee),
        reporter: null,
        updated_at: '2026-06-01T09:00:00.000Z',
      };
    },
  };
  return { port, reads: () => reads };
};

const harnessFor = (port: Partial<TaskManagementPort>): PipelineHarness => {
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {},
    // The shipped `app` service: the first stage stays queued, so the only ticket reads are
    // intake's and the duties'.
    runsAgents: false,
    taskManagement: port,
    // M28's defaults for a binding with no lifecycle block: To Do starts, Done closes and cancels.
    settings: { ticketStatusPolicy: ticketStatusPolicyOf(null, null) },
  });
  harness.store.seedIdentity('jira-cloud', ALICE_ACCOUNT, ALICE);
  harness.store.seedIdentity('jira-cloud', BOB_ACCOUNT, BOB);
  harness.store.seedProjectMember(PROJECT, ALICE);
  harness.store.seedProjectMember(PROJECT, BOB);
  harness.store.seedBindingAccount(PROJECT, 'jira-cloud', BOT_ACCOUNT);
  return harness;
};

const user = (account: string) => ({
  self: `${SITE}/rest/api/3/user?accountId=${account}`,
  accountId: account,
  accountType: 'atlassian',
  displayName: account === BOB_ACCOUNT ? 'Bob Example' : 'Alice Example',
  active: true,
});

/** A documented-shape envelope (technical/06; the webhooks page's example, adapted). */
const envelope = (
  harness: PipelineHarness,
  webhookEvent: 'jira:issue_created' | 'jira:issue_updated',
  state: TicketState,
  items: readonly Record<string, string | null>[],
) => ({
  timestamp: harness.clock.epochMs,
  webhookEvent,
  issue_event_type_name: 'issue_generic',
  user: user(ALICE_ACCOUNT),
  issue: {
    id: ISSUE_ID,
    self: `${SITE}/rest/api/3/issue/${ISSUE_ID}`,
    key: KEY,
    fields: {
      summary: 'Show the totals in the invoice footer',
      issuetype: { id: '10004', name: 'Story' },
      status: {
        id: '3',
        name: state.status,
        statusCategory: { key: state.category === 'todo' ? 'new' : state.category },
      },
      labels: ['agentic'],
      created: '2026-06-01T08:00:00.000+0000',
      updated: harness.clock.now(),
      assignee: state.assignee === null ? null : user(state.assignee),
    },
  },
  changelog: { id: 10124, items },
});

let deliveries = 0;

/**
 * One delivery through the real normaliser — signed, verified, normalised — and enveloped onto the
 * project stream exactly as `inbound.ts` does, then published. Answers the event types it produced.
 */
const deliver = async (harness: PipelineHarness, body: object): Promise<readonly string[]> => {
  const normaliser = createJiraInboundNormaliser({
    siteUrl: SITE,
    projectKeys: ['ACME'],
    pickup: { kind: 'label', label: 'agentic' },
    redactor: exactSecretRedactor([{ name: 'jira_webhook_secret', value: SECRET }]),
    secret: SECRET,
    clock: harness.clock,
  });
  deliveries += 1;
  const text = JSON.stringify(body);
  const delivery = {
    headers: {
      'x-atlassian-webhook-identifier': `00000000-0000-4000-8000-${deliveries.toString(16).padStart(12, '0')}`,
      'x-hub-signature': signWebhookBody(SECRET, text),
    },
    body: text,
  };
  expect(normaliser.verify(delivery), 'the delivery is authentic').toBe(true);
  const normalised = await normaliser.normalise(delivery, {
    projectId: PROJECT,
    integrationId: INTEGRATION,
    defaultBranch: 'main',
    resolveUser: (who) =>
      who.external_id === ALICE_ACCOUNT ? ALICE : who.external_id === BOB_ACCOUNT ? BOB : null,
    resolveThread: async () => null,
  });
  expect(normalised.ignored).toEqual([]);
  const sequence = Math.max(
    0,
    ...harness
      .events()
      .filter((event) => event.stream_type === 'project' && event.stream_id === PROJECT)
      .map((event) => event.stream_seq),
  );
  const events = normalised.events.map(
    (event, index) =>
      domainEventSchemasByType[event.type].parse({
        id: `00000000-0000-4000-9${deliveries.toString(16).padStart(3, '0')}-${index.toString(16).padStart(12, '0')}`,
        stream_type: 'project',
        stream_id: PROJECT,
        stream_seq: sequence + index + 1,
        correlation_id: null,
        cause_event_id: null,
        actor: event.actor,
        occurred_at: harness.clock.now(),
        type: event.type,
        payload: event.payload,
      }) as DomainEvent,
  );
  await harness.publish(events);
  return events.map((event) => event.type);
};

/** Creates the task from a labelled `jira:issue_created`, assigned to Alice, and answers its id. */
const intakeByWebhook = async (
  harness: PipelineHarness,
  state: TicketState,
): Promise<{ readonly taskId: Id }> => {
  const types = await deliver(harness, envelope(harness, 'jira:issue_created', state, []));
  expect(types).toContain('ticket.matched');
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('the webhook created no task');
  }
  return { taskId: stored.task.id };
};

describe('a Jira webhook moves the platform from the delivery (BACKLOG 1610)', () => {
  it('an assignee change in the changelog moves the task’s owner, with one ticket read', async () => {
    const state: TicketState = { assignee: ALICE_ACCOUNT, status: 'To Do', category: 'todo' };
    const ticket = tracker(state);
    const harness = harnessFor(ticket.port);
    const { taskId } = await intakeByWebhook(harness, state);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({ ownerUserId: ALICE });
    const afterIntake = ticket.reads();

    // Somebody reassigns the ticket to Bob in Jira, a minute later.
    harness.clock.advance(60_000);
    state.assignee = BOB_ACCOUNT;
    const types = await deliver(
      harness,
      envelope(harness, 'jira:issue_updated', state, [
        {
          field: 'assignee',
          fieldtype: 'jira',
          fieldId: 'assignee',
          from: ALICE_ACCOUNT,
          fromString: 'Alice Example',
          to: BOB_ACCOUNT,
          toString: 'Bob Example',
        },
      ]),
    );

    expect(types).toEqual(['ticket.updated']);
    const updated = harness.events().find((event) => event.type === 'ticket.updated');
    expect(updated?.payload).toMatchObject({ changed_fields: ['assignee'], truncated: false });
    // The delivery's own processing reached the owner: the owner_sync duty ran and read once.
    expect(ticket.reads() - afterIntake).toBe(1);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'tracker',
      ticketAssignee: { external_id: BOB_ACCOUNT },
    });
    const changes = harness.events().filter((event) => event.type === 'task.owner.changed');
    expect(changes.at(-1)?.payload).toMatchObject({
      owner_user_id: BOB,
      previous_owner_user_id: ALICE,
      via: 'tracker_sync',
    });
  });

  it('a status change to Done in the changelog cancels a task that never ran', async () => {
    const state: TicketState = { assignee: null, status: 'To Do', category: 'todo' };
    const ticket = tracker(state);
    const harness = harnessFor(ticket.port);
    const { taskId } = await intakeByWebhook(harness, state);
    const live = harness.store.snapshot().find((stored) => stored.task.id === taskId);
    expect(live?.task.state).not.toBe('cancelled');

    harness.clock.advance(60_000);
    state.status = 'Done';
    state.category = 'done';
    const types = await deliver(
      harness,
      envelope(harness, 'jira:issue_updated', state, [
        {
          field: 'status',
          fieldtype: 'jira',
          fieldId: 'status',
          from: '10002',
          fromString: 'To Do',
          to: '10003',
          toString: 'Done',
        },
      ]),
    );

    // Both doors the reverse sync listens on: the status event and the edit naming `status`.
    expect(types).toEqual(['ticket.status.changed', 'ticket.updated']);
    await harness.drain();
    const after = harness.store.snapshot().find((stored) => stored.task.id === taskId);
    expect(after?.task.state).toBe('cancelled');
    const cancelled = harness.events().filter((event) => event.type === 'task.cancelled');
    const outcome = (cancelled.at(-1)?.payload as { outcome?: unknown } | undefined)?.outcome;
    expect(String(outcome)).toContain('ACME-1 was moved to "Done" in Jira by Alice Example');
  });

  it('a change that is neither assignee nor status leaves the owner and the task as they were', async () => {
    const state: TicketState = { assignee: ALICE_ACCOUNT, status: 'To Do', category: 'todo' };
    const ticket = tracker(state);
    const harness = harnessFor(ticket.port);
    const { taskId } = await intakeByWebhook(harness, state);
    const ownerChanges = harness.events().filter((e) => e.type === 'task.owner.changed').length;

    harness.clock.advance(60_000);
    await deliver(
      harness,
      envelope(harness, 'jira:issue_updated', state, [
        { field: 'summary', fieldtype: 'jira', fromString: 'Old', toString: 'New' },
      ]),
    );

    expect(harness.store.ownershipOf(taskId).ownerUserId).toBe(ALICE);
    expect(harness.events().filter((e) => e.type === 'task.owner.changed')).toHaveLength(
      ownerChanges,
    );
    expect(harness.store.snapshot().find((s) => s.task.id === taskId)?.task.state).not.toBe(
      'cancelled',
    );
  });
});
