/**
 * **A person's limit at admission, end to end over the harness** (S-28.6, the M28 ruling B): the
 * real intake makes a linked assignee the owner and then asks the person's limit; the real
 * scheduler wakes on each event that may free a person's place — in the event's project **and in
 * every other project where that person has a queued task** — and a resume over the limit is never
 * refused. Agents never run here (`runsAgents: false`), so an admitted task stays `active` and holds
 * its owner's place.
 */
import type { DomainEvent, Id, IsoDateTime, Slug } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { DEFAULT_WIP_LIMITS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { pauseTaskCommand, resumeTaskCommand } from './commands.js';

const A = '00000000-0000-4000-8000-0000000028a1' as Id;
const B = '00000000-0000-4000-8000-0000000028b1' as Id;
const JAN = '00000000-0000-4000-8000-00000000a001' as Id;
const BOB = '00000000-0000-4000-8000-00000000b001' as Id;

/** Every ticket is assigned to whoever `assignees` names for its key, Jan otherwise. */
const tracker = (assignees: Record<string, string> = {}): Partial<TaskManagementPort> => ({
  readTicket: async (ref: TicketRefInput) => {
    const who = assignees[ref.key] ?? 'jan';
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
      assignee: {
        provider: 'fake-jira',
        external_id: `acct-${who}`,
        display_name: who,
        verified: false,
      },
      reporter: null,
      updated_at: '2026-06-01T09:00:00.000Z',
    };
  },
});

const harnessFor = (assignees: Record<string, string> = {}): PipelineHarness => {
  const harness = createPipelineHarness({
    projectId: A,
    runs: {},
    runsAgents: false,
    taskManagement: tracker(assignees),
    settings: {
      wip: {
        ...DEFAULT_WIP_LIMITS,
        maxParallelTasks: 10,
        maxTasksInPipeline: 10,
        maxTasksPerOwner: 1,
      },
    },
  });
  harness.store.seedIdentity('fake-jira', 'acct-jan', JAN);
  harness.store.seedIdentity('fake-jira', 'acct-bob', BOB);
  for (const project of [A, B]) {
    harness.store.seedProjectMember(project, JAN);
    harness.store.seedProjectMember(project, BOB);
  }
  return harness;
};

let counter = 0;
const domainEvent = <T extends DomainEvent['type']>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
  streamType: DomainEvent['stream_type'] = 'project',
): DomainEvent => {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: streamType,
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: A, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const matched = (project: Id, key: string) =>
  domainEvent('ticket.matched', {
    project_id: project,
    ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const byKey = (harness: PipelineHarness, key: string) => {
  const found = harness.store.snapshot().find((stored) => stored.task.ticket.key === key);
  if (found === undefined) throw new Error(`no task ${key}`);
  return found;
};
const stateOf = (harness: PipelineHarness, key: string) => byKey(harness, key).task.state;

/** Writes a task's state with no event — a place freed that nothing has announced yet. */
const silently = async (harness: PipelineHarness, key: string, state: 'paused') => {
  const stored = byKey(harness, key);
  await harness.store.tasks.save({} as never, { ...stored, task: { ...stored.task, state } });
};

describe('a person’s limit at intake (S-28.6)', () => {
  it('queues a ticket whose new owner is already at their limit, and admits another person’s', async () => {
    const harness = harnessFor({ 'ACME-3': 'bob' });
    await harness.publish([matched(A, 'ACME-1')]);
    await harness.publish([matched(A, 'ACME-2')]);
    await harness.publish([matched(A, 'ACME-3')]);
    expect(harness.store.ownershipOf(byKey(harness, 'ACME-2').task.id).ownerUserId).toBe(JAN);
    expect(['ACME-1', 'ACME-2', 'ACME-3'].map((key) => stateOf(harness, key))).toEqual([
      'active',
      'queued',
      'active',
    ]);
  });
});

describe('the scheduler wakes on each event that may free a person’s place (S-28.6)', () => {
  /** ACME-1 Jan's and active, ACME-2 Jan's and queued at intake, ACME-3 Bob's and active. */
  const given = async () => {
    const harness = harnessFor({ 'ACME-3': 'bob' });
    await harness.publish([matched(A, 'ACME-1')]);
    await harness.publish([matched(A, 'ACME-2')]);
    await harness.publish([matched(A, 'ACME-3')]);
    expect(stateOf(harness, 'ACME-2')).toBe('queued');
    return harness;
  };
  const taskEvent = (harness: PipelineHarness, key: string): { project_id: Id; task_id: Id } => ({
    project_id: A,
    task_id: byKey(harness, key).task.id,
  });

  it('task.owner.changed: Jan’s task handed to Bob frees Jan’s place', async () => {
    const harness = await given();
    const first = byKey(harness, 'ACME-1').task.id;
    const current = harness.store.ownershipOf(first);
    await harness.store.tasks.saveOwner({} as never, first, {
      expected: { ownerUserId: current.ownerUserId, ticketAssignee: current.ticketAssignee },
      next: {
        ownerUserId: BOB,
        ownerSource: 'platform',
        ownerChangedAt: '2026-06-01T09:05:00.000Z' as IsoDateTime,
        ticketAssignee: current.ticketAssignee,
      },
    });
    await harness.publish([
      domainEvent(
        'task.owner.changed',
        {
          ...taskEvent(harness, 'ACME-1'),
          owner_user_id: BOB,
          previous_owner_user_id: JAN,
          source: 'platform',
          via: 'command',
        },
        'task',
      ),
    ]);
    expect(stateOf(harness, 'ACME-2')).toBe('active');
  });

  it('task.resumed: the scheduler asks again on a resume', async () => {
    const harness = await given();
    await silently(harness, 'ACME-1', 'paused');
    expect(stateOf(harness, 'ACME-2')).toBe('queued');
    await harness.publish([
      domainEvent('task.resumed', { ...taskEvent(harness, 'ACME-3'), reason: null }, 'task'),
    ]);
    expect(stateOf(harness, 'ACME-2')).toBe('active');
  });

  it('task.handed_back: the scheduler asks again on a hand-back', async () => {
    const harness = await given();
    await silently(harness, 'ACME-1', 'paused');
    await harness.publish([
      domainEvent(
        'task.handed_back',
        {
          ...taskEvent(harness, 'ACME-3'),
          branch: 'agentic/acme-3',
          stage: 'implementation' as Slug,
          summary: 'done by hand',
        },
        'task',
      ),
    ]);
    expect(stateOf(harness, 'ACME-2')).toBe('active');
  });
});

describe('a person’s place freed in one project starts their task in another (S-28.6)', () => {
  it('pausing Jan’s task in A starts Jan’s queued task in B', async () => {
    const harness = harnessFor();
    await harness.publish([matched(A, 'ACME-1')]);
    await harness.publish([matched(B, 'BETA-1')]);
    expect(stateOf(harness, 'BETA-1')).toBe('queued');
    await pauseTaskCommand(harness.humanCommands, {
      taskId: byKey(harness, 'ACME-1').task.id,
      userId: JAN,
    });
    await harness.drain();
    expect(stateOf(harness, 'ACME-1')).toBe('paused');
    expect(stateOf(harness, 'BETA-1')).toBe('active');
  });
});

describe('a resume over the limit is never refused (S-28.6)', () => {
  it('resumes Jan’s paused task although Jan is at the limit again', async () => {
    const harness = harnessFor();
    await harness.publish([matched(A, 'ACME-1')]);
    await harness.publish([matched(A, 'ACME-2')]);
    await pauseTaskCommand(harness.humanCommands, {
      taskId: byKey(harness, 'ACME-1').task.id,
      userId: JAN,
    });
    await harness.drain();
    // The pause freed Jan's place and ACME-2 took it: Jan is at the limit.
    expect(stateOf(harness, 'ACME-2')).toBe('active');
    await resumeTaskCommand(harness.humanCommands, {
      taskId: byKey(harness, 'ACME-1').task.id,
      userId: JAN,
    });
    await harness.drain();
    expect(stateOf(harness, 'ACME-1')).toBe('active');
  });
});
