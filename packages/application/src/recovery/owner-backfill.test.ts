/**
 * BACKLOG 1510 — the owner backfill: a live task with no stored tracker assignee is read once by
 * the recovery pass, even though its ticket never changes, and never again.
 *
 * "Before S-26.1" is made the one way this build can make it: intake reads the ticket while it is
 * **unassigned**, and the ticket is assigned afterwards with no `ticket.updated` — so the task's
 * snapshot is fresh, its `ticket_assignee` is null, and no read the platform makes today reaches
 * it (the ordinary `owner_sync` duty reads only a stale snapshot). That is AUT-6676's shape.
 */
import type { DomainEvent, ExternalIdentity, Id, IsoDateTime } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor, secretPlaceholder } from '../integrations/redaction.js';
import { enqueueOutbound } from '../pipeline/jobs.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  OWNER_BACKFILL_PER_PASS,
  OWNER_BACKFILL_SITE,
  recoverOwnerBackfill,
} from './owner-backfill.js';
import { runStrandedRecovery } from './stranded.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const ALICE = '00000000-0000-4000-8000-00000000a11c' as Id;
const GRACE_MS = 60_000;

const identity = (account: string): ExternalIdentity => ({
  provider: 'fake-jira',
  external_id: `acct-${account}`,
  display_name: `${account[0]?.toUpperCase() ?? ''}${account.slice(1)} Example`,
  verified: false,
});

/** Every ticket's assignee (one for all of them), and every read of any of them. */
const tracker = (assignee: string | null, displayName?: string) => {
  const state = { assignee, displayName };
  const reads: string[] = [];
  const port: Partial<TaskManagementPort> = {
    readTicket: async (ref: TicketRefInput) => {
      reads.push(ref.key);
      return {
        ref,
        issue_type: 'Story',
        title: 'Show the totals in the invoice footer',
        description: 'The footer sums the visible rows rather than all of them.',
        status: 'Ready for the agent',
        priority: null,
        labels: [],
        comments: [],
        links: [],
        epic: null,
        siblings: [],
        attachments_text: [],
        assignee:
          state.assignee === null
            ? null
            : {
                ...identity(state.assignee),
                ...(state.displayName === undefined ? {} : { display_name: state.displayName }),
              },
        reporter: null,
        updated_at: '2026-06-01T09:00:00.000Z',
      };
    },
  };
  return { state, port, reads: () => reads.length };
};

/** Agent stages never run, so the only reads are intake's and the duties' (as `owner-sync.test.ts`). */
const harnessFor = (
  ticket: ReturnType<typeof tracker>,
  ticketRedactor?: SecretRedactor,
): PipelineHarness => {
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {},
    runsAgents: false,
    taskManagement: ticket.port,
    ...(ticketRedactor === undefined ? {} : { ticketRedactor }),
  });
  harness.store.seedIdentity('fake-jira', 'acct-alice', ALICE);
  harness.store.seedProjectMember(PROJECT, ALICE);
  harness.store.seedBindingAccount(PROJECT, 'fake-jira', 'acct-bot');
  return harness;
};

let counter = 0;
const ticketMatched = (key: string): DomainEvent => {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, '0');
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
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;
};

/** AUT-6676's shape: created while unassigned, stopped `needs_human`, assigned later, untouched. */
const idleTasks = async (
  harness: PipelineHarness,
  ticket: ReturnType<typeof tracker>,
  keys: readonly string[],
  assignee: string | null,
): Promise<Id[]> => {
  ticket.state.assignee = null;
  await harness.publish(keys.map(ticketMatched));
  for (const stored of harness.store.snapshot()) {
    await harness.commands.unitOfWork.transaction(async (scope) => {
      const current = await harness.store.tasks.load(scope.tx, stored.task.id);
      if (current === null) throw new Error('no task');
      await harness.store.tasks.save(scope.tx, {
        ...current,
        task: { ...current.task, state: 'needs_human' },
      });
    });
  }
  ticket.state.assignee = assignee;
  // Past the grace, so the pass sees a task whose own reads have had their chance.
  harness.clock.advance(GRACE_MS + 1_000);
  return harness.store.snapshot().map((stored) => stored.task.id);
};

/** One recovery pass's owner row, then every job it enqueued, as the worker would run them. */
const pass = async (harness: PipelineHarness, limit = 50) => {
  const now = harness.clock.now();
  const report = await recoverOwnerBackfill(
    { unitOfWork: harness.memory, jobs: harness.jobs },
    { tasks: harness.store.tasks },
    { now, olderThan: new Date(Date.parse(now) - GRACE_MS).toISOString() as IsoDateTime, limit },
  );
  await harness.drain();
  return report;
};

const ownerEvents = (harness: PipelineHarness) =>
  harness.events().filter((event) => event.type === 'task.owner.changed');

describe('the owner backfill (BACKLOG 1510)', () => {
  it('reads an idle task’s ticket once on the next pass, stores its assignee, and reads nothing on the pass after', async () => {
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    const [taskId] = await idleTasks(harness, ticket, ['AUT-6676'], 'vojtech');
    const afterIntake = ticket.reads();
    expect(afterIntake).toBe(1);
    expect(harness.store.ownershipOf(taskId as Id).ticketAssignee).toBeNull();
    expect(harness.store.ownerBackfillOf(taskId as Id)).toBeNull();

    // The ordinary duty reads nothing for this task: its snapshot is fresh. That is the gap.
    await enqueueOutbound(harness.jobs, {
      duty: 'owner_sync',
      project_id: PROJECT,
      task_id: taskId as Id,
      cause_event_id: taskId as Id,
    });
    await harness.drain();
    expect(ticket.reads()).toBe(afterIntake);

    harness.audit.reset();
    expect(await pass(harness)).toEqual({ found: 1, enqueued: 1 });
    expect(ticket.reads()).toBe(afterIntake + 1);
    expect(harness.store.ownershipOf(taskId as Id)).toEqual({
      ownerUserId: null,
      ownerSource: null,
      ownerChangedAt: null,
      ticketAssignee: {
        provider: 'fake-jira',
        external_id: 'acct-vojtech',
        display_name: 'Vojtech Example',
        platform: false,
      },
    });
    expect(harness.store.ownerBackfillOf(taskId as Id)).not.toBeNull();
    // Through `IntegrationActionExecutor`, for this task, like every other provider read.
    const audited = harness.audit.entriesFor('read_ticket');
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ taskId, status: 'ok', mutating: false });

    harness.clock.advance(GRACE_MS);
    expect(await pass(harness)).toEqual({ found: 0, enqueued: 0 });
    expect(ticket.reads()).toBe(afterIntake + 1);
  });

  it('reads an unassigned ticket once and never again, though its assignee stays null', async () => {
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    const [taskId] = await idleTasks(harness, ticket, ['ACME-1'], null);
    const afterIntake = ticket.reads();

    expect(await pass(harness)).toEqual({ found: 1, enqueued: 1 });
    expect(ticket.reads()).toBe(afterIntake + 1);
    expect(harness.store.ownershipOf(taskId as Id).ticketAssignee).toBeNull();

    for (let round = 0; round < 3; round += 1) {
      harness.clock.advance(GRACE_MS);
      expect(await pass(harness)).toEqual({ found: 0, enqueued: 0 });
    }
    expect(ticket.reads()).toBe(afterIntake + 1);
  });

  it('makes a linked member the owner, with task.owner.changed naming no cause event', async () => {
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    const [taskId] = await idleTasks(harness, ticket, ['ACME-2'], 'alice');
    expect(ownerEvents(harness)).toEqual([]);

    await pass(harness);
    expect(harness.store.ownershipOf(taskId as Id)).toMatchObject({
      ownerUserId: ALICE,
      ownerSource: 'tracker',
      ticketAssignee: { external_id: 'acct-alice', platform: false },
    });
    const changed = ownerEvents(harness);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      stream_id: taskId,
      cause_event_id: null,
      payload: { owner_user_id: ALICE, previous_owner_user_id: null, via: 'tracker_sync' },
    });
  });

  it('stores the binding’s own account as a platform assignee and sets no owner', async () => {
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    const [taskId] = await idleTasks(harness, ticket, ['ACME-3'], 'bot');

    await pass(harness);
    expect(harness.store.ownershipOf(taskId as Id)).toMatchObject({
      ownerUserId: null,
      ticketAssignee: { external_id: 'acct-bot', platform: true },
    });
    expect(ownerEvents(harness)).toEqual([]);
  });

  it('stores the assignee’s name through the binding’s redactor (BD-022)', async () => {
    const SECRET = 'jira-FAKE-notarealtokenatall';
    const ticket = tracker(null, `Vojtech ${SECRET}`);
    const harness = harnessFor(
      ticket,
      exactSecretRedactor([{ name: 'fake_jira_token', value: SECRET }]),
    );
    const [taskId] = await idleTasks(harness, ticket, ['ACME-4'], 'vojtech');

    await pass(harness);
    const stored = harness.store.ownershipOf(taskId as Id).ticketAssignee;
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(stored?.display_name).toBe(`Vojtech ${secretPlaceholder('fake_jira_token')}`);
  });

  it('holds the bound: at most OWNER_BACKFILL_PER_PASS a pass, and never more than the pass’s limit', async () => {
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    const keys = Array.from({ length: OWNER_BACKFILL_PER_PASS + 5 }, (_, i) => `BULK-${i + 1}`);
    await idleTasks(harness, ticket, keys, 'vojtech');
    const afterIntake = ticket.reads();

    expect(await pass(harness, 3)).toEqual({ found: 3, enqueued: 3 });
    expect(ticket.reads()).toBe(afterIntake + 3);
    expect(await pass(harness)).toEqual({
      found: OWNER_BACKFILL_PER_PASS,
      enqueued: OWNER_BACKFILL_PER_PASS,
    });
    expect(ticket.reads()).toBe(afterIntake + 3 + OWNER_BACKFILL_PER_PASS);
    expect(await pass(harness)).toEqual({ found: 2, enqueued: 2 });
    expect(await pass(harness)).toEqual({ found: 0, enqueued: 0 });
    expect(ticket.reads()).toBe(afterIntake + keys.length);
  });

  it('reads nothing for a task younger than the grace, a finished one, or one that already has an assignee', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket);
    // Intake stored Alice: an assignee on record is never owed a backfill.
    await harness.publish([ticketMatched('ACME-5')]);
    harness.clock.advance(GRACE_MS + 1_000);
    expect(await pass(harness)).toEqual({ found: 0, enqueued: 0 });

    // A task intake saw unassigned, still inside the grace: not yet.
    ticket.state.assignee = null;
    await harness.publish([ticketMatched('ACME-6')]);
    expect(await pass(harness)).toEqual({ found: 0, enqueued: 0 });

    // Finished: not found at all.
    const younger = harness.store.snapshot().find((stored) => stored.task.ticket.key === 'ACME-6');
    await harness.commands.unitOfWork.transaction(async (scope) => {
      if (younger === undefined) throw new Error('no task');
      const current = await harness.store.tasks.load(scope.tx, younger.task.id);
      if (current === null) throw new Error('no task');
      await harness.store.tasks.save(scope.tx, {
        ...current,
        task: { ...current.task, state: 'cancelled' },
      });
    });
    harness.clock.advance(GRACE_MS + 1_000);
    const reads = ticket.reads();
    expect(await pass(harness)).toEqual({ found: 0, enqueued: 0 });
    expect(ticket.reads()).toBe(reads);
  });

  it('re-validates on fire: a task whose assignee was stored since the pass, or that finished, is not read', async () => {
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    const [first, second] = await idleTasks(harness, ticket, ['ACME-7', 'ACME-8'], 'vojtech');
    const now = harness.clock.now();
    // The pass marks and enqueues, and nothing has run yet.
    expect(
      await recoverOwnerBackfill(
        { unitOfWork: harness.memory, jobs: harness.jobs },
        { tasks: harness.store.tasks },
        { now, olderThan: now, limit: 50 },
      ),
    ).toEqual({ found: 2, enqueued: 2 });
    const queued = harness.jobs.history.filter(
      (request) =>
        request.queue === JOB_QUEUES.pipelineOutbound && request.data?.owner_backfill === true,
    );
    expect(queued).toHaveLength(2);

    // Meanwhile a read stored the first task's assignee, and the second task was cancelled.
    await harness.commands.unitOfWork.transaction(async (scope) => {
      await harness.store.tasks.saveOwner(scope.tx, first as Id, {
        expected: { ownerUserId: null, ticketAssignee: null },
        next: {
          ownerUserId: null,
          ownerSource: null,
          ownerChangedAt: null,
          ticketAssignee: {
            provider: 'fake-jira',
            external_id: 'acct-erin',
            display_name: 'Erin Example',
            platform: false,
          },
        },
      });
      const current = await harness.store.tasks.load(scope.tx, second as Id);
      if (current === null) throw new Error('no task');
      await harness.store.tasks.save(scope.tx, {
        ...current,
        task: { ...current.task, state: 'cancelled' },
      });
    });
    const reads = ticket.reads();
    await harness.drain();
    expect(ticket.reads()).toBe(reads);
    expect(harness.store.ownershipOf(first as Id).ticketAssignee?.external_id).toBe('acct-erin');
  });

  it('is a row of the stranded pass, reported as owner_backfill', async () => {
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    await idleTasks(harness, ticket, ['ACME-9'], 'vojtech');
    const none = async () => [];
    const report = await runStrandedRecovery({
      store: {
        strandedBootstraps: none,
        markBootstrapAttempt: async () => {},
        endBootstrap: async () => {},
        strandedAsks: none,
        markAskAttempt: async () => {},
        endAsk: async () => {},
        strandedHistoryRecords: none,
        markHistoryRecordAttempt: async () => {},
        endHistoryRecord: async () => {},
        strandedCurations: none,
        markCurationAttempt: async () => {},
        endCuration: async () => {},
        asksWithEndedRun: none,
      },
      unitOfWork: harness.memory,
      jobs: harness.jobs,
      clock: harness.clock,
      graceMs: GRACE_MS,
      ownerBackfill: { tasks: harness.store.tasks },
    });
    expect(report).toContainEqual({ site: OWNER_BACKFILL_SITE, found: 1, reEnqueued: 1, ended: 0 });
    const reads = ticket.reads();
    await harness.drain();
    expect(ticket.reads()).toBe(reads + 1);
  });
});
