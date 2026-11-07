/**
 * S-26.3 — writing the owner back to the tracker, through the real handlers, the real owner command
 * and the real `ticket_owner_assign` duty over the harness (TD-031's 2026-11-06 amendment item 4):
 * criteria 1–4 and 6. The tracker double keeps one ticket's assignee, answers `assignTo` from it and
 * records what `ticket_assignee` held **at the moment of each call**, so "set before the call" is an
 * observation rather than an inference.
 *
 * The pure decisions are `packages/domain/src/tasks/owner-write-back.test.ts`'s; the provider half
 * (the fake and Jira against J4) is the task-management contract suite's (criterion 5).
 */
import type {
  DomainEvent,
  ExternalIdentity,
  Id,
  TicketAssignee,
  TicketLifecycle,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { IntegrationError } from '../ports/integrations/common.js';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { setTaskOwnerCommand, type TaskOwnerCommandDependencies } from './owner-sync.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const ALICE = '00000000-0000-4000-8000-00000000a11c' as Id;
const BOB = '00000000-0000-4000-8000-0000000000b0' as Id;
const CAROL = '00000000-0000-4000-8000-0000000000ca' as Id;
/** A member with no linked account at the tracker. */
const DORA = '00000000-0000-4000-8000-0000000000d0' as Id;
/** The maintainer who assigns on the platform. */
const MAINTAINER = '00000000-0000-4000-8000-0000000000ee' as Id;

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
} as const;

const identity = (account: string): ExternalIdentity => ({
  provider: 'fake-jira',
  external_id: `acct-${account}`,
  display_name: `${account[0]?.toUpperCase() ?? ''}${account.slice(1)} Example`,
  verified: false,
});

/** The lifecycle block: the write-back on (or off), and no claim, so no `assignToSelf` muddies it. */
const lifecycle = (assignOwner: boolean | undefined): TicketLifecycle => ({
  claim: false,
  ...(assignOwner === undefined ? {} : { assign_owner: assignOwner }),
});

interface AssignCall {
  readonly account: string;
  /** `tasks.ticket_assignee` while the call was in flight. */
  readonly storedAtCall: TicketAssignee | null;
}

/** One ticket's assignee, every `assignTo`, and what the next one answers. */
const tracker = (initial: string | null, declares = { assignOthers: true }) => {
  const state: { assignee: string | null; refuse: IntegrationError | null } = {
    assignee: initial,
    refuse: null,
  };
  const calls: AssignCall[] = [];
  let peekStored: () => TicketAssignee | null = () => null;
  const port: Partial<TaskManagementPort> = {
    capabilities: () =>
      ({ assignOthers: declares.assignOthers }) as ReturnType<TaskManagementPort['capabilities']>,
    readTicket: async (ref: TicketRefInput) => ({
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
      assignee: state.assignee === null ? null : identity(state.assignee),
      reporter: null,
      updated_at: '2026-06-01T09:00:00.000Z',
    }),
    assignTo: async (_ref: TicketRefInput, assignee: ExternalIdentity) => {
      calls.push({ account: assignee.external_id, storedAtCall: peekStored() });
      if (state.refuse !== null) {
        throw state.refuse;
      }
      const changed = state.assignee !== assignee.external_id.replace(/^acct-/, '');
      state.assignee = assignee.external_id.replace(/^acct-/, '');
      return { changed, assignee };
    },
  };
  return {
    state,
    port,
    calls,
    watch: (peek: () => TicketAssignee | null) => {
      peekStored = peek;
    },
  };
};

const recordingLogger = () => {
  const lines: { readonly level: string; readonly fields: unknown; readonly message: string }[] =
    [];
  const at =
    (level: string) =>
    (fields: unknown, message?: string): void => {
      lines.push({ level, fields, message: message ?? '' });
    };
  const logger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  } as unknown as Logger;
  return { logger, lines };
};

/**
 * Agent stages never run (`runsAgents: false`), so the only tracker traffic is intake's read, the
 * owner sync's and the write-back's. Alice, Bob and Carol are linked members; Dora is a member with
 * no account at the tracker; the binding acts as `acct-bot`.
 */
const harnessFor = (
  ticket: ReturnType<typeof tracker>,
  options: { readonly assignOwner?: boolean; readonly logger?: Logger } = {},
): PipelineHarness => {
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {},
    runsAgents: false,
    taskManagement: ticket.port,
    settings: {
      ticketLifecycle:
        options.assignOwner === undefined
          ? null
          : { pickUpFrom: null, slots: lifecycle(options.assignOwner) },
    },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  for (const [account, user] of [
    ['alice', ALICE],
    ['bob', BOB],
    ['carol', CAROL],
  ] as const) {
    harness.store.seedIdentity('fake-jira', `acct-${account}`, user);
    harness.store.seedProjectMember(PROJECT, user);
  }
  harness.store.seedProjectMember(PROJECT, DORA);
  harness.store.seedBindingAccount(PROJECT, 'fake-jira', 'acct-bot');
  ticket.watch(() => {
    const [stored] = harness.store.snapshot();
    return stored === undefined ? null : harness.store.ownershipOf(stored.task.id).ticketAssignee;
  });
  return harness;
};

let counter = 0;
const projectEvent = <T extends DomainEvent['type']>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
  occurredAt: string,
): DomainEvent => {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: occurredAt,
    type,
    payload,
  }) as DomainEvent;
};

const ticketMatched = () =>
  projectEvent(
    'ticket.matched',
    {
      project_id: PROJECT,
      ticket: { ...TICKET },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
    '2026-06-01T09:00:00.000Z',
  );

const ticketUpdated = (occurredAt: string) =>
  projectEvent(
    'ticket.updated',
    {
      project_id: PROJECT,
      ticket: { ...TICKET },
      updated_at: occurredAt,
      changed_fields: ['assignee'],
      truncated: false,
    },
    occurredAt,
  );

const taskIdOf = (harness: PipelineHarness): Id => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored.task.id;
};

const commandDeps = (harness: PipelineHarness): TaskOwnerCommandDependencies => ({
  unitOfWork: harness.commands.unitOfWork,
  store: harness.store,
  ids: harness.ids,
  clock: harness.clock,
});

/** A maintainer gives the task to `owner` (or nobody) on the platform, and the loop runs. */
const assign = async (harness: PipelineHarness, owner: Id | null): Promise<void> => {
  harness.clock.advance(1_000);
  await setTaskOwnerCommand(commandDeps(harness), {
    taskId: taskIdOf(harness),
    actorUserId: MAINTAINER,
    actorRole: 'maintainer',
    targetUserId: owner,
  });
  await harness.drain();
};

const writeBackJobs = (harness: PipelineHarness, from = 0) =>
  harness.jobs.history.slice(from).filter((job) => job.data?.duty === 'ticket_owner_assign');

const ownerEvents = (harness: PipelineHarness) =>
  harness.events().filter((event) => event.type === 'task.owner.changed');

const bobsAccount: TicketAssignee = {
  provider: 'fake-jira',
  external_id: 'acct-bob',
  display_name: null,
  platform: false,
};

const alicesAccount: TicketAssignee = {
  provider: 'fake-jira',
  external_id: 'acct-alice',
  display_name: 'Alice Example',
  platform: false,
};

// ── Criterion 1: off by default ────────────────────────────────────────────

describe('with the switch off, a platform assignment makes no provider call (criterion 1)', () => {
  it.each([
    ['no lifecycle block at all', undefined],
    ['a block that says false', false],
  ])('%s: no duty, no call, no audit row', async (_label, assignOwner) => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, assignOwner === undefined ? {} : { assignOwner });
    await harness.publish([ticketMatched()]);
    await assign(harness, BOB);

    expect(harness.store.ownershipOf(taskIdOf(harness)).ownerUserId).toBe(BOB);
    expect(writeBackJobs(harness)).toEqual([]);
    expect(ticket.calls).toEqual([]);
    expect(harness.audit.entriesFor('assign_to')).toEqual([]);
  });
});

// ── Criterion 2: one call, preset before it, the next sync changes nothing ─

describe('with the switch on, one assignTo through the executor (criterion 2)', () => {
  it('assigns the owner’s person account, with ticket_assignee set before the call', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, { assignOwner: true });
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: ALICE,
      ticketAssignee: alicesAccount,
    });

    await assign(harness, BOB);

    expect(ticket.calls).toEqual([{ account: 'acct-bob', storedAtCall: bobsAccount }]);
    expect(harness.audit.entriesFor('assign_to').map((entry) => entry.status)).toEqual(['ok']);
    expect(writeBackJobs(harness)).toHaveLength(1);
    expect(writeBackJobs(harness)[0]?.data).toMatchObject({
      owner_user_id: BOB,
      owner_changed_at: harness.store.ownershipOf(taskId).ownerChangedAt,
    });
    const owned = harness.store.ownershipOf(taskId);
    expect(owned).toMatchObject({ ownerUserId: BOB, ownerSource: 'platform' });

    // The tracker now names Bob, and the webhook says so: the next sync changes nothing.
    const changes = ownerEvents(harness).length;
    harness.clock.advance(60_000);
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(harness.store.ownershipOf(taskId)).toEqual(owned);
    expect(ownerEvents(harness)).toHaveLength(changes);
  });

  it('without the preset that same read writes the row (the control)', async () => {
    // The write-back is off; the tracker moves to Bob by hand after the platform gave Bob the task.
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, { assignOwner: false });
    await harness.publish([ticketMatched()]);
    await assign(harness, BOB);
    const before = harness.store.ownershipOf(taskIdOf(harness));
    expect(before.ticketAssignee).toEqual(alicesAccount);
    ticket.state.assignee = 'bob';
    harness.clock.advance(60_000);
    await harness.publish([ticketUpdated(harness.clock.now())]);
    // The read differs from the stored assignee, so the sync replaces it — the write the preset
    // spares, which the case above proves did not happen (its stored name is still the preset's null).
    expect(harness.store.ownershipOf(taskIdOf(harness))).toEqual({
      ...before,
      ticketAssignee: { ...bobsAccount, display_name: 'Bob Example' },
    });
  });

  it('records would_have for a shadow task, calls nothing and presets nothing', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, { assignOwner: true });
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    await harness.memory.transaction(async (scope) => {
      const stored = await harness.store.tasks.load(scope.tx, taskId);
      const loaded = stored as NonNullable<typeof stored>;
      await harness.store.tasks.save(scope.tx, {
        ...loaded,
        task: { ...loaded.task, mode: 'shadow' },
      });
    });

    await assign(harness, BOB);

    expect(ticket.calls).toEqual([]);
    expect(harness.audit.entriesFor('assign_to').map((entry) => entry.status)).toEqual([
      'would_have',
    ]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ticketAssignee: alicesAccount,
    });
  });

  it('puts the previous value back on a terminal refusal, keeps the owner, and logs it', async () => {
    const ticket = tracker('alice');
    const { logger, lines } = recordingLogger();
    const harness = harnessFor(ticket, { assignOwner: true, logger });
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    ticket.state.refuse = new IntegrationError(
      'forbidden',
      'fake-jira',
      'the binding’s account needs the Assign Issues permission',
      { action: 'assign_to' },
    );

    await assign(harness, BOB);

    // The call was made over the preset, and the preset is gone again.
    expect(ticket.calls).toEqual([{ account: 'acct-bob', storedAtCall: bobsAccount }]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'platform',
      ticketAssignee: alicesAccount,
    });
    expect(harness.audit.entriesFor('assign_to').map((entry) => entry.status)).toEqual(['failed']);
    expect(
      lines.filter((line) => line.level === 'warn' && line.message.includes('ticket_owner_assign')),
    ).toHaveLength(1);
  });

  it('puts the previous value back on an outage and throws, so the retry presets again', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, { assignOwner: true });
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    harness.holdOutbound((data) => data.duty === 'ticket_owner_assign');
    await assign(harness, BOB);
    const [job] = harness.jobs.take(JOB_QUEUES.pipelineOutbound);
    expect(job?.data?.duty).toBe('ticket_owner_assign');
    ticket.state.refuse = new IntegrationError('unavailable', 'fake-jira', 'the tracker is down', {
      action: 'assign_to',
    });

    const outbound = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound);
    await expect(
      outbound?.({ id: 'outage', queue: JOB_QUEUES.pipelineOutbound, data: job?.data } as never),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(ticket.calls.at(-1)).toEqual({ account: 'acct-bob', storedAtCall: bobsAccount });
    expect(harness.store.ownershipOf(taskId).ticketAssignee).toEqual(alicesAccount);

    // The retry, with the tracker back: preset again, and written.
    ticket.state.refuse = null;
    await outbound?.({ id: 'retry', queue: JOB_QUEUES.pipelineOutbound, data: job?.data } as never);
    expect(ticket.state.assignee).toBe('bob');
    expect(harness.store.ownershipOf(taskId).ticketAssignee).toEqual(bobsAccount);
  });
});

// ── Criterion 3: the race ──────────────────────────────────────────────────

describe('the race: Bob on the platform, then Carol in the tracker before the duty fires (criterion 3)', () => {
  it('writes nothing — the duty re-checks the owner and its instant against its event', async () => {
    const ticket = tracker('alice');
    const { logger, lines } = recordingLogger();
    const harness = harnessFor(ticket, { assignOwner: true, logger });
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);

    harness.holdOutbound((data) => data.duty === 'ticket_owner_assign');
    await assign(harness, BOB);
    expect(writeBackJobs(harness)).toHaveLength(1);
    expect(ticket.calls).toEqual([]);

    // Carol takes it in the tracker, and the webhook arrives before the held duty fires.
    ticket.state.assignee = 'carol';
    harness.clock.advance(60_000);
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: CAROL,
      ownerSource: 'tracker',
    });

    harness.holdOutbound(null);
    await harness.drain();

    expect(ticket.calls).toEqual([]);
    expect(ticket.state.assignee).toBe('carol');
    expect(harness.audit.entriesFor('assign_to')).toEqual([]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: CAROL,
      ticketAssignee: { external_id: 'acct-carol' },
    });
    expect(
      lines.filter(
        (line) =>
          line.message.includes('ticket_owner_assign') &&
          (line.fields as { reason?: string }).reason === 'owner_changed',
      ),
    ).toHaveLength(1);
  });

  it('writes nothing for the first of two assignments to the same person (the instant differs)', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, { assignOwner: true });
    await harness.publish([ticketMatched()]);

    harness.holdOutbound((data) => data.duty === 'ticket_owner_assign');
    await assign(harness, BOB);
    await assign(harness, null);
    await assign(harness, BOB);
    // Two platform assignments to Bob, each its own wake-up; the release asked for none.
    expect(writeBackJobs(harness)).toHaveLength(2);

    harness.holdOutbound(null);
    await harness.drain();
    // Only the latest change writes: one call.
    expect(ticket.calls).toEqual([{ account: 'acct-bob', storedAtCall: bobsAccount }]);
  });
});

// ── Criterion 4: no identity, no call ──────────────────────────────────────

describe('an owner with no account at the tracker (criterion 4)', () => {
  it('gets no call and one logged reason', async () => {
    const ticket = tracker('alice');
    const { logger, lines } = recordingLogger();
    const harness = harnessFor(ticket, { assignOwner: true, logger });
    await harness.publish([ticketMatched()]);

    await assign(harness, DORA);

    expect(writeBackJobs(harness)).toHaveLength(1);
    expect(ticket.calls).toEqual([]);
    expect(harness.audit.entriesFor('assign_to')).toEqual([]);
    const reasons = lines.filter(
      (line) =>
        line.message.includes('ticket_owner_assign') &&
        (line.fields as { reason?: string }).reason === 'owner_has_no_identity',
    );
    expect(reasons).toHaveLength(1);
    // The stored assignee is untouched: nothing was going to be written.
    expect(harness.store.ownershipOf(taskIdOf(harness)).ticketAssignee).toEqual(alicesAccount);
  });

  it('gets no call when the provider does not declare assignOthers', async () => {
    const ticket = tracker('alice', { assignOthers: false });
    const harness = harnessFor(ticket, { assignOwner: true });
    await harness.publish([ticketMatched()]);
    await assign(harness, BOB);
    expect(ticket.calls).toEqual([]);
    expect(harness.store.ownershipOf(taskIdOf(harness)).ticketAssignee).toEqual(alicesAccount);
  });
});

// ── Criterion 6: a release writes nothing ──────────────────────────────────

describe('releasing ownership writes nothing to the tracker (criterion 6)', () => {
  it('enqueues no write-back for an unassign, nor for an owner the tracker gave', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, { assignOwner: true });
    // Intake's owner is the tracker's: no write-back for it.
    await harness.publish([ticketMatched()]);
    expect(harness.store.ownershipOf(taskIdOf(harness)).ownerUserId).toBe(ALICE);
    expect(writeBackJobs(harness)).toEqual([]);

    const before = harness.jobs.history.length;
    await assign(harness, null);
    expect(harness.store.ownershipOf(taskIdOf(harness)).ownerUserId).toBeNull();
    expect(ownerEvents(harness).at(-1)?.payload).toMatchObject({
      owner_user_id: null,
      source: 'platform',
    });
    expect(writeBackJobs(harness, before)).toEqual([]);
    expect(ticket.calls).toEqual([]);
    expect(ticket.state.assignee).toBe('alice');
  });
});
