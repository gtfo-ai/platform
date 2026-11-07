/**
 * S-26.1 — a task's owner through the real handlers, the real intake and the real `owner_sync`
 * duty over the harness, with a tracker double that keeps one ticket's assignee and counts its
 * reads (criteria 1, 3's command half, 4 and 5; TD-031's 2026-11-06 amendment items 1–3 and 6).
 *
 * The owner directory is the memory store's (`seedIdentity`, `seedProjectMember`,
 * `seedBindingAccount`, its divergence 14); that the PostgreSQL directory answers the same over
 * `user_identities`, the roles and `bindings.account_identity` is
 * `test/integration/pipeline/task-owner.integration.test.ts`'s.
 */
import type { DomainEvent, ExternalIdentity, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor, secretPlaceholder } from '../integrations/redaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  adoptOwnersOnLink,
  OwnerChangeRefusedError,
  setTaskOwnerCommand,
  type TaskOwnerCommandDependencies,
} from './owner-sync.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const ALICE = '00000000-0000-4000-8000-00000000a11c' as Id;
const BOB = '00000000-0000-4000-8000-0000000000b0' as Id;
const VIEWER = '00000000-0000-4000-8000-0000000000c0' as Id;

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

/** One ticket's assignee, and every read of it. */
const tracker = (assignee: string | null, displayName?: string) => {
  const state = { assignee, displayName };
  let reads = 0;
  const port: Partial<TaskManagementPort> = {
    readTicket: async (ref: TicketRefInput) => {
      reads += 1;
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
  return { state, port, reads: () => reads };
};

/**
 * A harness whose agent stages never run (`runsAgents: false`, the shipped `app` service): intake
 * creates the task and leaves its first stage queued, so the task stays live at refinement and the
 * only reads of the ticket are intake's and the duty's. Alice and Bob are linked members, Carol is
 * linked but only a viewer of the project, Dan is a machine and the binding acts as `acct-bot`.
 */
const harnessFor = (
  ticket: ReturnType<typeof tracker>,
  runsAgents = false,
  ticketRedactor?: SecretRedactor,
): PipelineHarness => {
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {},
    runsAgents,
    taskManagement: ticket.port,
    ...(ticketRedactor === undefined ? {} : { ticketRedactor }),
  });
  harness.store.seedIdentity('fake-jira', 'acct-alice', ALICE);
  harness.store.seedIdentity('fake-jira', 'acct-bob', BOB);
  harness.store.seedIdentity('fake-jira', 'acct-carol', VIEWER);
  harness.store.seedIdentity('fake-jira', 'acct-dan', null);
  harness.store.seedProjectMember(PROJECT, ALICE);
  harness.store.seedProjectMember(PROJECT, BOB);
  harness.store.seedBindingAccount(PROJECT, 'fake-jira', 'acct-bot');
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

const ownerEvents = (harness: PipelineHarness) =>
  harness.events().filter((event) => event.type === 'task.owner.changed');

const commandDeps = (harness: PipelineHarness): TaskOwnerCommandDependencies => ({
  unitOfWork: harness.commands.unitOfWork,
  store: harness.store,
  ids: harness.ids,
  clock: harness.clock,
});

// ── Criterion 1: intake records the owner ──────────────────────────────────

describe('intake records the owner (S-26.1 criterion 1)', () => {
  it('makes a linked member assignee the owner, with task.owner.changed from the tracker sync', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket);
    await harness.publish([ticketMatched()]);

    const taskId = taskIdOf(harness);
    expect(harness.store.ownershipOf(taskId)).toEqual({
      ownerUserId: ALICE,
      ownerSource: 'tracker',
      // The harness's clock does not move by itself: intake's instant is still `now`.
      ownerChangedAt: harness.clock.now(),
      ticketAssignee: {
        provider: 'fake-jira',
        external_id: 'acct-alice',
        display_name: 'Alice Example',
        platform: false,
      },
    });
    const changed = ownerEvents(harness);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      stream_type: 'task',
      stream_id: taskId,
      actor: { kind: 'system' },
      payload: {
        project_id: PROJECT,
        task_id: taskId,
        owner_user_id: ALICE,
        previous_owner_user_id: null,
        source: 'tracker',
        via: 'tracker_sync',
      },
    });
    // On the task's stream after the creation's own events, at the next free sequence.
    const taskStream = harness
      .events()
      .filter((event) => event.stream_type === 'task' && event.stream_id === taskId);
    expect(taskStream.map((event) => event.stream_seq)).toEqual(
      taskStream.map((_event, index) => index + 1),
    );
  });

  it.each([
    ['an unlinked person', 'erin', false],
    ['a linked user below member', 'carol', false],
    ['a machine identity', 'dan', true],
    ['the binding’s own account', 'bot', true],
  ])(
    'leaves the owner null for %s, with the assignee stored',
    async (_label, account, platform) => {
      const ticket = tracker(account);
      const harness = harnessFor(ticket);
      await harness.publish([ticketMatched()]);

      expect(harness.store.ownershipOf(taskIdOf(harness))).toEqual({
        ownerUserId: null,
        ownerSource: null,
        ownerChangedAt: null,
        ticketAssignee: {
          provider: 'fake-jira',
          external_id: `acct-${account}`,
          display_name: identity(account).display_name,
          platform,
        },
      });
      expect(ownerEvents(harness)).toEqual([]);
    },
  );

  it('stores the assignee’s name through the binding’s redactor, never the secret in it (BD-022)', async () => {
    // A credential a person pasted into their tracker display name: provider text, stored on the row.
    const SECRET = 'jira-FAKE-notarealtokenatall';
    const ticket = tracker('erin', `Erin ${SECRET}`);
    const harness = harnessFor(
      ticket,
      false,
      exactSecretRedactor([{ name: 'fake_jira_token', value: SECRET }]),
    );
    await harness.publish([ticketMatched()]);

    const stored = harness.store.ownershipOf(taskIdOf(harness)).ticketAssignee;
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(stored?.display_name).toBe(`Erin ${secretPlaceholder('fake_jira_token')}`);
    // The identity the mapping is keyed by is left alone: it is what a later link compares.
    expect(stored?.external_id).toBe('acct-erin');
  });

  it('stores nothing for an unassigned ticket', async () => {
    const harness = harnessFor(tracker(null));
    await harness.publish([ticketMatched()]);
    expect(harness.store.ownershipOf(taskIdOf(harness)).ticketAssignee).toBeNull();
    expect(ownerEvents(harness)).toEqual([]);
  });
});

// ── Criterion 5: the stage offer names the owner ───────────────────────────

describe('a stage offer names the owner as its assignee (S-26.1 criterion 5, backlog 730)', () => {
  it('gives the owner’s online machine the head start on the first stage', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket, true);
    harness.store.setAssigneeOnline(PROJECT, ALICE, true);
    const offeredAt = harness.clock.now();
    await harness.publish([ticketMatched()]);

    const [offer] = harness.store.offerRows();
    const headStartEnds = new Date(Date.parse(offeredAt) + 120_000).toISOString();
    expect(offer).toMatchObject({
      kind: 'stage',
      stage: 'refinement',
      // The server is preferred, so it waits out the owner's window before it may claim.
      state: 'open',
      routing: { assigneeUserId: ALICE, assigneeUntil: headStartEnds, serverFrom: headStartEnds },
    });
  });
});

// ── Criterion 4: the owner_sync duty ───────────────────────────────────────

describe('the owner_sync duty (S-26.1 criterion 4)', () => {
  it('makes one ticket read per burst, and changes the owner only on an assignee change', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket);
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    const afterIntake = ticket.reads();
    expect(ownerEvents(harness)).toHaveLength(1);

    // Bob takes it in the tracker; the webhook says so three times.
    harness.clock.advance(60_000);
    ticket.state.assignee = 'bob';
    const at = harness.clock.now();
    await harness.publish([ticketUpdated(at), ticketUpdated(at), ticketUpdated(at)]);

    expect(ticket.reads() - afterIntake).toBe(1);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'tracker',
      ticketAssignee: { external_id: 'acct-bob' },
    });
    expect(ownerEvents(harness).map((event) => event.payload)).toEqual([
      expect.objectContaining({ owner_user_id: ALICE, previous_owner_user_id: null }),
      expect.objectContaining({
        owner_user_id: BOB,
        previous_owner_user_id: ALICE,
        source: 'tracker',
        via: 'tracker_sync',
      }),
    ]);

    // An update that is not an assignee change: one more read, and no owner change.
    harness.clock.advance(60_000);
    const later = harness.clock.now();
    await harness.publish([ticketUpdated(later)]);
    expect(ticket.reads() - afterIntake).toBe(2);
    expect(ownerEvents(harness)).toHaveLength(2);
    expect(harness.store.ownershipOf(taskId).ownerUserId).toBe(BOB);
  });

  it('keeps a platform assignment until somebody changes the tracker (latest change wins)', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket);
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);

    // A maintainer gives it to Bob on the platform; the tracker still says Alice.
    const set = await setTaskOwnerCommand(commandDeps(harness), {
      taskId,
      actorUserId: VIEWER,
      actorRole: 'maintainer',
      targetUserId: BOB,
    });
    expect(set).toEqual({ changed: true, ownerUserId: BOB });

    harness.clock.advance(60_000);
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'platform',
    });

    // Now the tracker moves to an unlinked person: that is a change, and it wins.
    harness.clock.advance(60_000);
    ticket.state.assignee = 'erin';
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: null,
      ownerSource: 'tracker',
      ticketAssignee: { external_id: 'acct-erin', platform: false },
    });
  });

  it('keeps a member’s owner when the claim’s own assign reads back, and follows a real change after it (review of #92)', async () => {
    // The ticket is unassigned at intake; Alice takes the task on the platform before its first
    // claim; the claim's `assignToSelf` then puts the binding's own account on the ticket, and the
    // webhook says so. Until S-26.2 stops that re-assignment, this read must not cost Alice the task.
    const ticket = tracker(null);
    const harness = harnessFor(ticket);
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    await setTaskOwnerCommand(commandDeps(harness), {
      taskId,
      actorUserId: ALICE,
      actorRole: 'member',
      targetUserId: ALICE,
    });
    const taken = harness.store.ownershipOf(taskId);
    expect(taken).toMatchObject({ ownerUserId: ALICE, ownerSource: 'platform' });

    harness.clock.advance(60_000);
    ticket.state.assignee = 'bot';
    const reads = ticket.reads();
    await harness.publish([ticketUpdated(harness.clock.now())]);
    // The read happened, the assignee is stored, and the owner, its source and its instant stand.
    expect(ticket.reads() - reads).toBe(1);
    expect(harness.store.ownershipOf(taskId)).toEqual({
      ...taken,
      ticketAssignee: {
        provider: 'fake-jira',
        external_id: 'acct-bot',
        display_name: 'Bot Example',
        platform: true,
      },
    });
    const recorded = ownerEvents(harness).length;

    // A machine account is the same answer.
    harness.clock.advance(60_000);
    ticket.state.assignee = 'dan';
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({ ownerUserId: ALICE });
    expect(ownerEvents(harness)).toHaveLength(recorded);

    // …and a person changing the tracker after it is still the latest change, and wins.
    harness.clock.advance(60_000);
    ticket.state.assignee = 'bob';
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'tracker',
    });
    expect(ownerEvents(harness).at(-1)?.payload).toMatchObject({
      owner_user_id: BOB,
      previous_owner_user_id: ALICE,
      via: 'tracker_sync',
    });
  });

  it('keeps a tracker owner through the claim’s assign too', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket);
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    harness.clock.advance(60_000);
    ticket.state.assignee = 'bot';
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: ALICE,
      ownerSource: 'tracker',
      ticketAssignee: { external_id: 'acct-bot', platform: true },
    });
    expect(ownerEvents(harness)).toHaveLength(1);
  });

  it('reads nothing for a finished task', async () => {
    const ticket = tracker('alice');
    const harness = harnessFor(ticket);
    await harness.publish([ticketMatched()]);
    const before = harness.jobs.history.length;
    const [stored] = harness.store.snapshot();
    await harness.commands.unitOfWork.transaction(async (scope) => {
      if (stored === undefined) throw new Error('no task');
      await harness.store.tasks.save(scope.tx, {
        ...stored,
        task: { ...stored.task, state: 'cancelled' },
      });
    });
    const reads = ticket.reads();
    harness.clock.advance(60_000);
    await harness.publish([ticketUpdated(harness.clock.now())]);
    expect(ticket.reads()).toBe(reads);
    expect(
      harness.jobs.history.slice(before).filter((request) => request.data?.duty === 'owner_sync'),
    ).toEqual([]);
  });
});

// ── Criterion 4's second half: a link adopts the owner ─────────────────────

describe('a link made later adopts the owner, with no provider call (the hook S-26.6 calls)', () => {
  it('sets the newly linked member as the owner of the live task their identity holds', async () => {
    const ticket = tracker('erin');
    const harness = harnessFor(ticket);
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    expect(harness.store.ownershipOf(taskId).ownerUserId).toBeNull();
    const reads = ticket.reads();

    const ERIN = '00000000-0000-4000-8000-0000000000e7' as Id;
    harness.store.seedIdentity('fake-jira', 'acct-erin', ERIN);
    harness.store.seedProjectMember(PROJECT, ERIN);
    const adopted = await adoptOwnersOnLink(commandDeps(harness), {
      userId: ERIN,
      provider: 'fake-jira',
      externalId: 'acct-erin',
    });

    expect(adopted).toEqual([taskId]);
    expect(ticket.reads()).toBe(reads);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: ERIN,
      ownerSource: 'tracker',
    });
    expect(ownerEvents(harness).at(-1)?.payload).toMatchObject({
      owner_user_id: ERIN,
      source: 'tracker',
      via: 'link',
    });
    // A second call finds nothing left to adopt.
    expect(
      await adoptOwnersOnLink(commandDeps(harness), {
        userId: ERIN,
        provider: 'fake-jira',
        externalId: 'acct-erin',
      }),
    ).toEqual([]);
  });

  it('adopts nothing when the identity is linked to somebody else than the caller names', async () => {
    const harness = harnessFor(tracker('erin'));
    await harness.publish([ticketMatched()]);
    const ERIN = '00000000-0000-4000-8000-0000000000e7' as Id;
    // `acct-erin` is linked to Bob, a member; a hook that names Erin for it adopts nothing.
    harness.store.seedIdentity('fake-jira', 'acct-erin', BOB);
    harness.store.seedProjectMember(PROJECT, ERIN);
    expect(
      await adoptOwnersOnLink(commandDeps(harness), {
        userId: ERIN,
        provider: 'fake-jira',
        externalId: 'acct-erin',
      }),
    ).toEqual([]);
    expect(harness.store.ownershipOf(taskIdOf(harness)).ownerUserId).toBeNull();
  });

  it('adopts nothing for a linked user below member', async () => {
    const harness = harnessFor(tracker('erin'));
    await harness.publish([ticketMatched()]);
    const ERIN = '00000000-0000-4000-8000-0000000000e7' as Id;
    harness.store.seedIdentity('fake-jira', 'acct-erin', ERIN);
    expect(
      await adoptOwnersOnLink(commandDeps(harness), {
        userId: ERIN,
        provider: 'fake-jira',
        externalId: 'acct-erin',
      }),
    ).toEqual([]);
    expect(harness.store.ownershipOf(taskIdOf(harness)).ownerUserId).toBeNull();
  });
});

// ── Criterion 3's command half: the matrix over the rows ───────────────────

describe('the owner command over the rows (S-26.1 criterion 3)', () => {
  it('lets a member take an unassigned task, records it as theirs, and lets them give it back', async () => {
    const harness = harnessFor(tracker('bot'));
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);

    expect(
      await setTaskOwnerCommand(commandDeps(harness), {
        taskId,
        actorUserId: ALICE,
        actorRole: 'member',
        targetUserId: ALICE,
      }),
    ).toEqual({ changed: true, ownerUserId: ALICE });
    expect(ownerEvents(harness).at(-1)).toMatchObject({
      actor: { kind: 'user', user_id: ALICE },
      payload: { owner_user_id: ALICE, source: 'platform', via: 'command' },
    });
    // Taking it again changes nothing and records nothing.
    const recorded = ownerEvents(harness).length;
    expect(
      await setTaskOwnerCommand(commandDeps(harness), {
        taskId,
        actorUserId: ALICE,
        actorRole: 'member',
        targetUserId: ALICE,
      }),
    ).toEqual({ changed: false, ownerUserId: ALICE });
    expect(ownerEvents(harness)).toHaveLength(recorded);
    // Bob, a member, may neither take it nor release it.
    for (const targetUserId of [BOB, null]) {
      await expect(
        setTaskOwnerCommand(commandDeps(harness), {
          taskId,
          actorUserId: BOB,
          actorRole: 'member',
          targetUserId,
        }),
      ).rejects.toMatchObject({ reason: 'owner_change_not_permitted' });
    }
    expect(
      await setTaskOwnerCommand(commandDeps(harness), {
        taskId,
        actorUserId: ALICE,
        actorRole: 'member',
        targetUserId: null,
      }),
    ).toEqual({ changed: true, ownerUserId: null });
  });

  it('refuses a member a task held elsewhere, and a maintainer a target below member', async () => {
    const harness = harnessFor(tracker('erin'));
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    await expect(
      setTaskOwnerCommand(commandDeps(harness), {
        taskId,
        actorUserId: ALICE,
        actorRole: 'member',
        targetUserId: ALICE,
      }),
    ).rejects.toBeInstanceOf(OwnerChangeRefusedError);
    await expect(
      setTaskOwnerCommand(commandDeps(harness), {
        taskId,
        actorUserId: BOB,
        actorRole: 'maintainer',
        targetUserId: VIEWER,
      }),
    ).rejects.toMatchObject({ reason: 'owner_not_project_member' });
    // …and the maintainer may give it to a member though the tracker names Erin.
    expect(
      await setTaskOwnerCommand(commandDeps(harness), {
        taskId,
        actorUserId: BOB,
        actorRole: 'maintainer',
        targetUserId: ALICE,
      }),
    ).toEqual({ changed: true, ownerUserId: ALICE });
    // A refusal wrote nothing: the only owner change is the maintainer's.
    expect(ownerEvents(harness).map((event) => event.payload)).toEqual([
      expect.objectContaining({ owner_user_id: ALICE, via: 'command' }),
    ]);
  });

  it('treats a member’s release as unassigned: another member may then take it', async () => {
    const harness = harnessFor(tracker('alice'));
    await harness.publish([ticketMatched()]);
    const taskId = taskIdOf(harness);
    await setTaskOwnerCommand(commandDeps(harness), {
      taskId,
      actorUserId: ALICE,
      actorRole: 'member',
      targetUserId: null,
    });
    // The ticket is still Alice's in the tracker, but she is a linked member: not held elsewhere.
    expect(
      await setTaskOwnerCommand(commandDeps(harness), {
        taskId,
        actorUserId: BOB,
        actorRole: 'member',
        targetUserId: BOB,
      }),
    ).toEqual({ changed: true, ownerUserId: BOB });
  });
});
