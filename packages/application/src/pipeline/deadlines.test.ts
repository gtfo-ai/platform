/**
 * WP-56 — three deadlines, one mechanism, asserted as countable effects with an injected clock.
 *
 * Every instant here is **fixed** (rules 2, 42 and 86): the harness clock starts at a known Monday
 * and each case moves it to a named instant, never to "now + n". The calendar is the shipped
 * default — Monday to Friday, 09:00–17:00, UTC, no holidays — unless a case says otherwise, so a
 * `1 working day` question asked at 16:00 on Friday 2026-06-05 is due at **16:00 on Monday
 * 2026-06-08** (one hour on Friday, seven on Monday), and 16:00 on Saturday is the wall-clock day
 * that must *not* expire it.
 *
 * The effects are read back from the aggregate (the question's and the approval's status), from
 * the task's state and its `task.escalated` event, and from the workpad the fake ticket received —
 * never from a return value alone.
 */
import type { DomainEvent, Id, IsoDateTime, Slug } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { IllegalTransitionError, materialiseAutonomy } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { CommentRef, TicketRefInput } from '../ports/integrations/task-management.js';
import { JOB_QUEUES, type JobData, type JobHandler } from '../ports/jobs.js';
import { recoverDeadlines } from '../recovery/deadline.js';
import { runStrandedRecovery } from '../recovery/stranded.js';
import { createWorkingCalendar, questionTimeoutAt } from '../scheduling/working-calendar.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import {
  answerTaskQuestion,
  cancelTaskCommand,
  decideTaskApproval,
  handBackTaskCommand,
  retryStageCommand,
  returnToStageCommand,
  takeOverTaskCommand,
} from './commands.js';
import { TAKE_OVER_INACTIVITY_TIMEOUT, takeOverDeadline } from './deadline-rules.js';
import {
  DEADLINE_REARM_FLOOR_MS,
  type DeadlineSweepData,
  deadlineArmingHandler,
  deadlineKey,
  deadlineSweepHandler,
} from './deadlines.js';
import { reminderCauseId } from './reminders.js';
import { staticProjectSettings } from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const USER = '00000000-0000-4000-8000-0000000000c1' as Id;

/** Friday 2026-06-05, 16:00 UTC — the row's own example (criterion 3). */
const FRIDAY_1600 = '2026-06-05T16:00:00.000Z';
/** Twenty-four wall-clock hours later: the day a calendar that ignored weekends would pick. */
const SATURDAY_1600 = '2026-06-06T16:00:00.000Z';
const MONDAY_1559 = '2026-06-08T15:59:59.999Z';
const MONDAY_1600 = '2026-06-08T16:00:00.000Z';
/**
 * Halfway through the eight working hours between Friday 16:00 and Monday 16:00 — Friday 16–17 and
 * Monday 09–12 — which is when BD-006's reminder fires (WP-84, `reminderTimeOf`).
 */
const MONDAY_1200 = '2026-06-08T12:00:00.000Z';

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
} as const;

const REFINED_SPEC = {
  goal: 'Show the totals in the invoice footer.',
  user_value: 'Finance can read the invoice without a calculator.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac1',
      given: 'an invoice with three lines',
      when: 'it is rendered',
      // biome-ignore lint/suspicious/noThenProperty: it is the published field name
      then: 'the footer shows the sum',
      validation: { kind: 'test', value: 'totals.test.ts' },
    },
  ],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: 'in the documented direction' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const ASKING_SPEC = {
  ...REFINED_SPEC,
  decision: 'ask',
  questions: [{ id: 'q1', text: 'Which currency?', blocking: true }],
};

const PLAN = (size: 'M' | 'XL' = 'M') => ({
  approach: 'Sum the lines in the renderer.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'add the sum' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'none',
  risks: [],
  estimated_size: size,
  decisions_to_record: [],
  protected_path_changes: [],
});

const NOTES = {
  summary: 'Added the footer sum.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: 'green' }],
  known_gaps: [],
  followup_tickets: [],
  mr: {
    url: 'https://git.example.test/acme/api/-/merge_requests/7',
    iid: 7,
    head_sha: 'b'.repeat(40),
    branch: 'agentic/acme-1',
  },
};

const completedRun = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

const happyRuns = () => ({
  refinement: completedRun(REFINED_SPEC),
  architecture: completedRun(PLAN()),
  implementation: completedRun(NOTES),
  code_review: completedRun({
    verdict: 'approve',
    findings: [],
    summary: 'Reviewed.',
    protected_path_changes_confirmed: [],
  }),
  business_review: completedRun({
    verdict: 'approve',
    criteria: [{ id: 'ac1', status: 'met', evidence: 'test' }],
    scope_creep: [],
    missing: [],
    ux_notes: [],
  }),
});

/** The markdown of every workpad render the fake ticket received, in order. */
interface Workpads {
  readonly renders: string[];
}

const harnessWith = (
  options: HarnessOptions = {},
): { harness: PipelineHarness; workpads: Workpads } => {
  const workpads: Workpads = { renders: [] };
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: happyRuns(),
    git: {
      getPipelineStatus: async () => ({
        id: 'pipeline-1',
        head_sha: 'b'.repeat(40),
        status: 'success',
        url: null,
        jobs: [],
        coverage_pct: null,
        finished_at: '2026-06-01T09:30:00.000Z',
      }),
      getMergeRequest: async () => ({
        ref: {
          provider: 'fake-git',
          project_path: 'acme/api',
          iid: 7,
          url: 'https://git.example.test/acme/api/-/merge_requests/7',
          branch: 'agentic/acme-1',
          head_sha: 'b'.repeat(40),
        },
        state: 'opened' as const,
        draft: true,
        title: 'Draft: totals',
        description: '',
        source_branch: 'agentic/acme-1',
        target_branch: 'main',
        head_sha: 'b'.repeat(40),
        mergeable: true,
        has_conflicts: false,
        labels: [],
        reviewers: [],
        web_url: 'https://git.example.test/acme/api/-/merge_requests/7',
      }),
    },
    taskManagement: {
      upsertWorkpad: async (
        ref: TicketRefInput,
        markerId: string,
        markdown: string,
      ): Promise<CommentRef> => {
        workpads.renders.push(markdown);
        return {
          provider: ref.provider,
          ticket_key: ref.key,
          comment_id: 'workpad',
          url: null,
          marker_id: markerId,
        };
      },
    },
    ...options,
  });
  return { harness, workpads };
};

/** Moves the harness clock to a named instant; refuses to move it backwards. */
const moveTo = (harness: PipelineHarness, at: string): void => {
  const delta = Date.parse(at) - harness.clock.epochMs;
  expect(delta, `the clock cannot go back to ${at}`).toBeGreaterThanOrEqual(0);
  harness.clock.advance(delta);
};

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: TICKET,
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

const taskOf = (harness: PipelineHarness) => {
  const stored = harness.store.snapshot()[0];
  expect(stored).toBeDefined();
  return stored as NonNullable<typeof stored>;
};

const eventsOf = <T extends DomainEvent['type']>(harness: PipelineHarness, type: T) =>
  harness.events().filter((event) => event.type === type) as Extract<DomainEvent, { type: T }>[];

const deadlineJobs = (harness: PipelineHarness) =>
  harness.jobs.enqueued.filter((request) => request.queue === JOB_QUEUES.deadlineSweep);

/** Plays the `deadline.sweep` worker once, now, whatever the queue's `startAfter` says. */
const fireNow = async (harness: PipelineHarness, data: DeadlineSweepData): Promise<void> => {
  const handler = harness.jobs.handlers.get(JOB_QUEUES.deadlineSweep);
  expect(handler, 'the runtime subscribed deadline.sweep').toBeDefined();
  await handler?.({
    id: 'job-fired-early',
    queue: JOB_QUEUES.deadlineSweep,
    data,
    signal: AbortSignal.abort(),
  });
  await harness.drain();
};

/** A task parked on one blocking question asked at 16:00 on Friday. */
const askedOnFriday = async (options: HarnessOptions = {}) => {
  const built = harnessWith({
    ...options,
    runs: { ...happyRuns(), refinement: completedRun(ASKING_SPEC), ...options.runs },
  });
  moveTo(built.harness, FRIDAY_1600);
  await built.harness.publish([ticketMatched()]);
  expect(taskOf(built.harness).task.state).toBe('waiting_answers');
  const [asked] = eventsOf(built.harness, 'task.question.asked');
  expect(asked).toBeDefined();
  const question = (asked as NonNullable<typeof asked>).payload.question;
  return { ...built, question };
};

describe('a question’s deadline (BD-006, PROGRESS backlog 74)', () => {
  it('is written with the question, from questionTimeoutAt on the composed calendar, and armed after commit', async () => {
    const { harness, question } = await askedOnFriday();

    // Criterion (1): the stored row and the event that announced it agree, and both are the
    // calendar's answer for the instant the row stores as `asked_at`.
    const stored = await harness.store.questions.load({ adapter: 'memory' } as never, question.id);
    expect(stored?.askedAt).toBe(FRIDAY_1600);
    expect(stored?.deadlineAt).toBe(MONDAY_1600);
    expect(question.deadline_at).toBe(MONDAY_1600);
    expect(stored?.deadlineAt).toBe(
      questionTimeoutAt(
        createWorkingCalendar(),
        new Date(FRIDAY_1600),
        '1 working day',
      ).toISOString(),
    );

    // …and exactly one expiry timer is armed for it, at the deadline, keyed on the question — plus,
    // since WP-84, exactly one reminder timer, halfway there on the same calendar.
    const armed = deadlineJobs(harness);
    expect(armed).toHaveLength(2);
    expect(armed[0]?.data).toEqual({
      aggregate: 'question',
      id: question.id,
      kind: 'question_timeout',
    });
    expect(armed[0]?.startAfter?.toISOString()).toBe(MONDAY_1600);
    expect(armed[0]?.singletonKey).toBe(`question:${question.id}:question_timeout`);
    expect(armed[1]?.data).toEqual({
      aggregate: 'question',
      id: question.id,
      kind: 'question_reminder',
    });
    expect(armed[1]?.startAfter?.toISOString()).toBe(MONDAY_1200);
    expect(armed[1]?.singletonKey).toBe(`question:${question.id}:question_reminder`);
  });

  it('never enqueues from inside the handler: the timer is armed only by afterCommit', async () => {
    // `Jobs.enqueue` does not join the handler's transaction (TD-004), so a handler that enqueued
    // directly would leave a timer behind a dispatch that rolled back. Driven with a context that
    // collects the afterCommit callbacks, so "nothing yet" and "exactly one, later" are both seen.
    const calls: string[] = [];
    const handler = deadlineArmingHandler({
      jobs: {
        enqueue: async () => {
          calls.push('enqueue');
          return { status: 'enqueued', jobId: 'x' };
        },
      } as never,
      calendar: createWorkingCalendar(),
    });
    const deferred: (() => Promise<void>)[] = [];
    await handler.handle({
      event: {
        position: 1,
        causeEventPosition: null,
        event: domainEventSchemasByType['task.taken_over'].parse({
          id: '00000000-0000-4000-9000-0000000000a1',
          stream_type: 'task',
          stream_id: '00000000-0000-4000-8000-0000000000d1',
          stream_seq: 4,
          correlation_id: null,
          cause_event_id: null,
          actor: { kind: 'user', user_id: USER },
          occurred_at: FRIDAY_1600,
          type: 'task.taken_over',
          payload: {
            project_id: PROJECT,
            task_id: '00000000-0000-4000-8000-0000000000d1',
            branch: 'agentic/ACME-1',
            session_id: null,
            stage: 'implementation',
          },
        }) as DomainEvent,
      },
      afterCommit: (callback: () => Promise<void>) => {
        deferred.push(callback);
      },
    } as never);
    expect(calls).toEqual([]);
    expect(deferred).toHaveLength(1);
    await deferred[0]?.();
    expect(calls).toEqual(['enqueue']);
  });

  it('arms nothing for a record with no deadline — a row an older build wrote — and says so', async () => {
    const warnings: string[] = [];
    const deferred: unknown[] = [];
    const handler = deadlineArmingHandler({
      jobs: {} as never,
      calendar: createWorkingCalendar(),
      logger: {
        warn: (_fields: unknown, message: string) => {
          warnings.push(message);
        },
      } as never,
    });
    const { harness, question } = await askedOnFriday();
    const [asked] = eventsOf(harness, 'task.question.asked');
    const undated = {
      ...(asked as NonNullable<typeof asked>),
      payload: {
        ...(asked as NonNullable<typeof asked>).payload,
        question: { ...question, deadline_at: null },
      },
    } as DomainEvent;
    await handler.handle({
      event: { position: 1, causeEventPosition: null, event: undated },
      afterCommit: (callback: () => Promise<void>) => {
        deferred.push(callback);
      },
    } as never);
    expect(deferred).toEqual([]);
    expect(warnings).toEqual(['a question was asked with no deadline, so nothing will expire it']);
  });

  it('expires on Monday and not on Saturday — the boundary and one unit either side of it', async () => {
    const { harness, question } = await askedOnFriday();
    const data: DeadlineSweepData = {
      aggregate: 'question',
      id: question.id,
      kind: 'question_timeout',
    };

    // Saturday 16:00 — a day of wall-clock time. The queue has nothing due…
    moveTo(harness, SATURDAY_1600);
    await harness.drain();
    // …and a timer that fired early anyway (the queue's clock is not this process's) re-validates
    // into "not yet" and re-arms at the deadline rather than expiring.
    await fireNow(harness, data);
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe('open');
    expect(taskOf(harness).task.state).toBe('waiting_answers');
    expect(deadlineJobs(harness).at(-1)?.startAfter?.toISOString()).toBe(MONDAY_1600);

    // One millisecond before the deadline on Monday: still not expired.
    moveTo(harness, MONDAY_1559);
    await fireNow(harness, data);
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe('open');
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(0);

    // At the deadline the queue's own timer is due, and playing the worker expires it.
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(1);
    // The saga moved the question on to `escalated` and parked the task with a brief naming it.
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe(
      'escalated',
    );
    expect(taskOf(harness).task.state).toBe('needs_human');
    const [escalated] = eventsOf(harness, 'task.escalated');
    expect(escalated?.payload.reason).toBe(
      'the question asked at "refinement" was not answered in time',
    );
    expect(escalated?.payload.blocker_brief).toContain('Which currency?');

    // A second fire after the expiry finds nothing owed.
    await fireNow(harness, data);
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(1);
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(1);
  });

  it('expires nothing when the question was answered before the timer fired (criterion 2)', async () => {
    const { harness, question } = await askedOnFriday();
    harness.script('refinement', completedRun(REFINED_SPEC));
    moveTo(harness, '2026-06-08T10:00:00.000Z');
    await answerTaskQuestion(harness.commands, {
      questionId: question.id,
      answer: 'EUR',
      userId: USER,
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();

    moveTo(harness, MONDAY_1600);
    await harness.drain();
    // The timer did fire — the queue holds nothing due any more — and it found the question answered.
    expect(
      deadlineJobs(harness).filter(
        (request) => (request.data as DeadlineSweepData).kind === 'question_timeout',
      ),
    ).toEqual([]);
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(0);
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe('answered');
    expect(taskOf(harness).task.state).not.toBe('needs_human');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);
  });

  it('counts on the calendar it was composed with: a Monday holiday moves the deadline to Tuesday', async () => {
    const { harness, question } = await askedOnFriday({
      calendar: createWorkingCalendar({
        timezone: 'UTC',
        working_weekdays: [1, 2, 3, 4, 5],
        working_hours: { start: '09:00', end: '17:00' },
        holidays: ['2026-06-08'],
      }),
    });
    expect(question.deadline_at).toBe('2026-06-09T16:00:00.000Z');

    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(0);
    moveTo(harness, '2026-06-09T16:00:00.000Z');
    await harness.drain();
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(1);
  });

  it('reads the project’s own question_timeout', async () => {
    const { question } = await askedOnFriday({
      settings: { config: { pipeline: { limits: { question_timeout: '2 working hours' } } } },
    });
    // One hour on Friday, one on Monday.
    expect(question.deadline_at).toBe('2026-06-08T10:00:00.000Z');
  });
});

describe('an approval’s deadline (BD-006’s Q95 amendment, PROGRESS backlog 76)', () => {
  const planApprovalOnFriday = async () => {
    const built = harnessWith({
      runs: { ...happyRuns(), architecture: completedRun(PLAN('XL')) },
    });
    moveTo(built.harness, FRIDAY_1600);
    await built.harness.publish([ticketMatched()]);
    expect(taskOf(built.harness).task.state).toBe('waiting_approval');
    const [requested] = eventsOf(built.harness, 'task.approval.requested');
    const approval = (requested as NonNullable<typeof requested>).payload.approval;
    return { ...built, approval };
  };

  it('writes a plan approval’s deadline on the question calendar and expires it on Monday, not Saturday', async () => {
    const { harness, approval } = await planApprovalOnFriday();
    expect(approval.kind).toBe('plan');
    expect(approval.requested_at).toBe(FRIDAY_1600);
    expect(approval.deadline_at).toBe(MONDAY_1600);
    expect(
      deadlineJobs(harness).map((request) => ({
        data: request.data,
        at: request.startAfter?.toISOString(),
      })),
    ).toEqual([
      {
        data: { aggregate: 'approval', id: approval.id, kind: 'approval_timeout' },
        at: MONDAY_1600,
      },
      {
        data: { aggregate: 'approval', id: approval.id, kind: 'approval_reminder' },
        at: MONDAY_1200,
      },
    ]);

    moveTo(harness, SATURDAY_1600);
    await fireNow(harness, { aggregate: 'approval', id: approval.id, kind: 'approval_timeout' });
    moveTo(harness, MONDAY_1559);
    await fireNow(harness, { aggregate: 'approval', id: approval.id, kind: 'approval_timeout' });
    expect((await harness.store.approvals.load({} as never, approval.id))?.approval.status).toBe(
      'pending',
    );
    expect(taskOf(harness).task.state).toBe('waiting_approval');

    moveTo(harness, MONDAY_1600);
    await harness.drain();
    const expired = await harness.store.approvals.load({} as never, approval.id);
    expect(expired?.approval.status).toBe('expired');
    expect(expired?.approval.reason).toBe('deadline passed');
    // The `expired` decision value, produced for the first time, and the saga's third branch.
    expect(
      eventsOf(harness, 'task.approval.decided').map((event) => event.payload.decision),
    ).toEqual(['expired']);
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(eventsOf(harness, 'task.escalated')[0]?.payload.reason).toBe('the approval expired');
  });

  it('expires nothing when a maintainer decided first', async () => {
    const { harness, approval } = await planApprovalOnFriday();
    moveTo(harness, '2026-06-08T09:30:00.000Z');
    await decideTaskApproval(harness.commands, {
      approvalId: approval.id,
      decision: 'approved',
      userId: USER,
      role: 'maintainer',
    });
    await harness.drain();

    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect((await harness.store.approvals.load({} as never, approval.id))?.approval.status).toBe(
      'approved',
    );
    expect(
      eventsOf(harness, 'task.approval.decided').map((event) => event.payload.decision),
    ).toEqual(['approved']);
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);
  });

  it('gives a budget approval the same deadline and the same ending', async () => {
    const shipped = materialiseAutonomy({
      level: 'autonomous',
      at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    const { harness } = harnessWith({
      cost: true,
      settings: {
        autonomy: {
          ...shipped,
          policies: { ...shipped.policies, budget_approval_threshold_usd: 5 },
        },
      },
    });
    harness.cost?.seedHistory(PROJECT, [{ size: 'M', costUsd: 6 }]);
    moveTo(harness, FRIDAY_1600);
    await harness.publish([ticketMatched()]);
    const [requested] = eventsOf(harness, 'task.approval.requested');
    const approval = (requested as NonNullable<typeof requested>).payload.approval;
    expect(approval.kind).toBe('budget');
    expect(approval.deadline_at).toBe(MONDAY_1600);

    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect((await harness.store.approvals.load({} as never, approval.id))?.approval.status).toBe(
      'expired',
    );
    expect(taskOf(harness).task.state).toBe('needs_human');
  });
});

describe('BD-006’s reminder before escalation (WP-84, PROGRESS backlog 165)', () => {
  const MONDAY_1159 = '2026-06-08T11:59:59.999Z';
  const WITH_CHAT: HarnessOptions = { communication: {} };

  const reminders = (harness: PipelineHarness) =>
    harness.notifications.rows.filter((row) => row.notificationClass === 'reminder');
  const reminderMessages = (harness: PipelineHarness) =>
    (harness.communication?.messages ?? []).filter((message) =>
      message.markdown.includes('is still waiting for a person'),
    );

  const planApprovalOnFriday = async () => {
    const built = harnessWith({
      ...WITH_CHAT,
      runs: { ...happyRuns(), architecture: completedRun(PLAN('XL')) },
    });
    moveTo(built.harness, FRIDAY_1600);
    await built.harness.publish([ticketMatched()]);
    const [requested] = eventsOf(built.harness, 'task.approval.requested');
    return { ...built, approval: (requested as NonNullable<typeof requested>).payload.approval };
  };

  it('reminds about a question once, halfway to its deadline on the calendar, and counts it', async () => {
    const { harness, question } = await askedOnFriday(WITH_CHAT);

    moveTo(harness, MONDAY_1159);
    await harness.drain();
    expect(reminderMessages(harness)).toHaveLength(0);
    expect((await harness.store.questions.load({} as never, question.id))?.remindersSent).toBe(0);

    moveTo(harness, MONDAY_1200);
    await harness.drain();
    const posted = reminderMessages(harness);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.markdown).toContain('Still unanswered: Which currency?');
    // Text, never buttons: a reminder is never a second control to go stale.
    expect(posted[0]?.approval).toBeUndefined();
    expect((await harness.store.questions.load({} as never, question.id))?.remindersSent).toBe(1);
    expect(reminders(harness)).toHaveLength(1);
    expect(reminders(harness)[0]?.causeEventId).toBe(reminderCauseId('question', question.id));
    // Still open, still waiting: a reminder moves no state and appends no event.
    expect(taskOf(harness).task.state).toBe('waiting_answers');

    // A second fire — a redelivered timer — finds the reminder sent and does nothing.
    await fireNow(harness, { aggregate: 'question', id: question.id, kind: 'question_reminder' });
    expect(reminderMessages(harness)).toHaveLength(1);
    expect((await harness.store.questions.load({} as never, question.id))?.remindersSent).toBe(1);

    // …and the escalation still comes at the deadline, after its reminder.
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(1);
    expect(reminderMessages(harness)).toHaveLength(1);
  });

  it('reminds nobody about a question answered before its reminder was due', async () => {
    const { harness, question } = await askedOnFriday(WITH_CHAT);
    harness.script('refinement', completedRun(REFINED_SPEC));
    moveTo(harness, '2026-06-08T10:00:00.000Z');
    await answerTaskQuestion(harness.commands, {
      questionId: question.id,
      answer: 'EUR',
      userId: USER,
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();

    moveTo(harness, MONDAY_1200);
    await harness.drain();
    await fireNow(harness, { aggregate: 'question', id: question.id, kind: 'question_reminder' });
    expect(reminderMessages(harness)).toHaveLength(0);
    expect(reminders(harness)).toHaveLength(0);
    expect((await harness.store.questions.load({} as never, question.id))?.remindersSent).toBe(0);
  });

  it('reminds nobody about a question answered after the timer fired and before the post', async () => {
    const { harness, question } = await askedOnFriday(WITH_CHAT);
    harness.script('refinement', completedRun(REFINED_SPEC));
    moveTo(harness, MONDAY_1200);
    // The timer fires and enqueues the notification; the answer lands before the duty runs.
    const handler = harness.jobs.handlers.get(JOB_QUEUES.deadlineSweep);
    await handler?.({
      id: 'reminder-fired',
      queue: JOB_QUEUES.deadlineSweep,
      data: { aggregate: 'question', id: question.id, kind: 'question_reminder' },
      signal: AbortSignal.abort(),
    });
    await answerTaskQuestion(harness.commands, {
      questionId: question.id,
      answer: 'EUR',
      userId: USER,
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();
    // The timer counted what it raised; the duty re-checked the question and posted nothing.
    expect((await harness.store.questions.load({} as never, question.id))?.remindersSent).toBe(1);
    expect(reminderMessages(harness)).toHaveLength(0);
    expect(reminders(harness)).toHaveLength(0);
  });

  it('reminds about an approval once, on the question’s calendar (Q95), and counts it', async () => {
    const { harness, approval } = await planApprovalOnFriday();

    moveTo(harness, MONDAY_1159);
    await harness.drain();
    expect(reminderMessages(harness)).toHaveLength(0);

    moveTo(harness, MONDAY_1200);
    await harness.drain();
    const posted = reminderMessages(harness);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.markdown).toContain('Still waiting for a decision');
    expect(posted[0]?.approval).toBeUndefined();
    const stored = await harness.store.approvals.load({} as never, approval.id);
    expect(stored?.approval.remindersSent).toBe(1);
    expect(stored?.approval.status).toBe('pending');
    expect(reminders(harness)[0]?.causeEventId).toBe(reminderCauseId('approval', approval.id));
    // The reminder row names its approval (what a re-post re-checks) and carries no message
    // address, so the settled-approval edit — which reads only rows with one — never picks it.
    expect(reminders(harness)[0]?.approvalId).toBe(approval.id);
    expect(reminders(harness)[0]?.messageRef).toBeNull();

    await fireNow(harness, { aggregate: 'approval', id: approval.id, kind: 'approval_reminder' });
    expect(reminderMessages(harness)).toHaveLength(1);
    expect(
      (await harness.store.approvals.load({} as never, approval.id))?.approval.remindersSent,
    ).toBe(1);
  });

  it('reminds nobody about an approval a maintainer decided first', async () => {
    const { harness, approval } = await planApprovalOnFriday();
    moveTo(harness, '2026-06-08T09:30:00.000Z');
    await decideTaskApproval(harness.commands, {
      approvalId: approval.id,
      decision: 'approved',
      userId: USER,
      role: 'maintainer',
    });
    await harness.drain();

    moveTo(harness, MONDAY_1200);
    await harness.drain();
    await fireNow(harness, { aggregate: 'approval', id: approval.id, kind: 'approval_reminder' });
    expect(reminderMessages(harness)).toHaveLength(0);
    expect(
      (await harness.store.approvals.load({} as never, approval.id))?.approval.remindersSent,
    ).toBe(0);
  });

  /**
   * **A re-post re-checks the question** (WP-84 review round 1, backlog 292). A row an earlier
   * attempt recorded and never delivered — planted here as that attempt left it — is re-posted by
   * the recovery pass through the wake-up it rebuilds from the row; for an answered question the
   * duty posts nothing and closes the row withheld (review round 2).
   */
  const repostPass = async (harness: PipelineHarness) => {
    const none = async () => [];
    const marked = new Set<string>();
    await runStrandedRecovery({
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
      graceMs: 60_000,
      notifications: {
        store: {
          // The memory twin of the SQL predicate (`postgres-notification-repost-store.ts`).
          undeliveredImmediate: async (_tx, query) =>
            harness.notifications.rows.filter(
              (row) =>
                row.deliveredAt === null &&
                row.plannedDelivery === 'immediate' &&
                row.digestDay === null &&
                !marked.has(row.id) &&
                row.createdAt < query.before,
            ),
          markRepostAttempt: async (_tx, mark) => {
            marked.add(mark.id);
          },
          withholdRepost: async (tx, input) =>
            harness.notifications.markWithheld(tx, { ids: [input.id], at: input.at }),
        },
      },
    });
    await harness.drain();
    return marked;
  };

  const plantUndelivered = async (
    harness: PipelineHarness,
    input: {
      readonly cause: string;
      readonly notificationClass: 'question' | 'reminder';
      readonly questionId: Id;
    },
  ) => {
    await harness.memory.transaction(async (scope) =>
      harness.notifications.record(scope.tx, {
        id: input.cause as Id,
        projectId: PROJECT,
        taskId: taskOf(harness).task.id,
        questionId: input.questionId,
        notificationClass: input.notificationClass,
        causeEventId: input.cause as Id,
        title: 'ACME-1 is waiting for an answer',
        detail: 'Which currency?',
        url: null,
        urgent: false,
        plannedDelivery: 'immediate',
        mode: 'normal',
        createdAt: harness.clock.now() as IsoDateTime,
        redactionCount: 0,
      }),
    );
  };
  const QUESTION_CAUSE = '00000000-0000-4000-9000-0000000084a1';
  const REMINDER_CAUSE = '00000000-0000-4000-9000-0000000084a2';
  const plantedMessages = (harness: PipelineHarness) =>
    (harness.communication?.messages ?? []).filter((message) =>
      message.markdown.includes('Which currency?'),
    );

  it('re-posts an undelivered question row while the question is open (the control)', async () => {
    const { harness, question } = await askedOnFriday(WITH_CHAT);
    await plantUndelivered(harness, {
      cause: QUESTION_CAUSE,
      notificationClass: 'question',
      questionId: question.id,
    });
    const before = plantedMessages(harness).length;
    moveTo(harness, '2026-06-05T16:50:00.000Z');
    const marked = await repostPass(harness);
    expect(marked.has(QUESTION_CAUSE)).toBe(true);
    expect(plantedMessages(harness).length).toBe(before + 1);
    expect(harness.notifications.rows.find((row) => row.id === QUESTION_CAUSE)?.deliveredAs).toBe(
      'immediate',
    );
  });

  it('sends nothing when the question was answered before the re-post, and closes the row withheld', async () => {
    const { harness, question } = await askedOnFriday(WITH_CHAT);
    await plantUndelivered(harness, {
      cause: QUESTION_CAUSE,
      notificationClass: 'question',
      questionId: question.id,
    });
    harness.script('refinement', completedRun(REFINED_SPEC));
    await answerTaskQuestion(harness.commands, {
      questionId: question.id,
      answer: 'EUR',
      userId: USER,
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();
    const before = plantedMessages(harness).length;
    moveTo(harness, '2026-06-05T16:50:00.000Z');
    const marked = await repostPass(harness);
    // The pass tried once (the mark); the duty re-checked the question and posted nothing.
    expect(marked.has(QUESTION_CAUSE)).toBe(true);
    expect(plantedMessages(harness).length).toBe(before);
    // Round 2: closed as withheld — not sent, and not counted as lost by the gauge.
    expect(harness.notifications.rows.find((row) => row.id === QUESTION_CAUSE)?.deliveredAs).toBe(
      'withheld',
    );
  });

  it('sends nothing when a reminder is re-posted after its question was answered', async () => {
    const { harness, question } = await askedOnFriday(WITH_CHAT);
    await plantUndelivered(harness, {
      cause: REMINDER_CAUSE,
      notificationClass: 'reminder',
      questionId: question.id,
    });
    harness.script('refinement', completedRun(REFINED_SPEC));
    await answerTaskQuestion(harness.commands, {
      questionId: question.id,
      answer: 'EUR',
      userId: USER,
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();
    const before = plantedMessages(harness).length;
    moveTo(harness, '2026-06-05T16:50:00.000Z');
    const marked = await repostPass(harness);
    expect(marked.has(REMINDER_CAUSE)).toBe(true);
    expect(plantedMessages(harness).length).toBe(before);
    // Round 2: closed as withheld — not sent, and not counted as lost by the gauge.
    expect(harness.notifications.rows.find((row) => row.id === REMINDER_CAUSE)?.deliveredAs).toBe(
      'withheld',
    );
  });

  /**
   * **The production link, end to end** (WP-84 review round 2): the `task.question.asked` handler
   * puts `question_id` on the wake-up, the duty records it on the row, and a later attempt of the
   * same wake-up re-checks the question by it. The first post fails (the chat is down), the question
   * is answered, and the job's retry — the handler's own payload, replayed — posts nothing and
   * closes the row withheld.
   */
  it('records the question on the row from the handler’s wake-up, and a retry after the answer posts nothing', async () => {
    let chatDown = true;
    const questionPosts: string[] = [];
    const { harness } = harnessWith({
      communication: {
        postMessage: async (
          thread: { channel: string; thread_id: string },
          body: { markdown?: string },
        ) => {
          if ((body.markdown ?? '').includes('Which currency?')) {
            if (chatDown) {
              throw new Error('chat provider unavailable');
            }
            questionPosts.push(body.markdown ?? '');
          }
          return {
            provider: 'fake-chat',
            channel: thread.channel,
            message_id: `m-${questionPosts.length}`,
            thread_id: thread.thread_id,
            url: null,
          };
        },
      },
      runs: { ...happyRuns(), refinement: completedRun(ASKING_SPEC) },
    });
    // Start the workers, then watch what the outbound worker is handed: the wake-up exactly as the
    // handler built it (the recording queue forgets a job once a worker takes it).
    await harness.drain();
    const outbound = harness.jobs.handlers.get(JOB_QUEUES.pipelineOutbound) as JobHandler;
    const handed: JobData[] = [];
    // The recording queue's map is mutable underneath its read-only type; this test replaces one
    // worker with a wrapper that records what it is handed and then does exactly the same.
    (harness.jobs.handlers as Map<string, JobHandler>).set(
      JOB_QUEUES.pipelineOutbound,
      async (job) => {
        handed.push(job.data as JobData);
        return outbound(job);
      },
    );
    moveTo(harness, FRIDAY_1600);
    await expect(harness.publish([ticketMatched()])).rejects.toThrow(/chat provider unavailable/);
    await harness.drain();
    const [asked] = eventsOf(harness, 'task.question.asked');
    const questionId = (asked as NonNullable<typeof asked>).payload.question.id;

    // The handler's payload carries the question, and the duty recorded it on the row.
    const wakeUp = handed.find(
      (data) => (data as { notification_class?: string }).notification_class === 'question',
    );
    expect((wakeUp as { question_id?: string } | undefined)?.question_id).toBe(questionId);
    const row = harness.notifications.rows.find((entry) => entry.notificationClass === 'question');
    expect(row?.questionId).toBe(questionId);
    expect(row?.deliveredAt).toBeNull();

    harness.script('refinement', completedRun(REFINED_SPEC));
    await answerTaskQuestion(harness.commands, {
      questionId,
      answer: 'EUR',
      userId: USER,
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();

    chatDown = false;
    await outbound({
      id: 'notify-retry',
      queue: JOB_QUEUES.pipelineOutbound,
      data: wakeUp as never,
      signal: AbortSignal.abort(),
    });
    // The human sees nothing; the row is closed withheld, not left for the gauge.
    expect(questionPosts).toEqual([]);
    const after = harness.notifications.rows.find((entry) => entry.id === row?.id);
    expect(after?.deliveredAs).toBe('withheld');
  });

  it('never re-posts a withheld row on a later pass', async () => {
    const { harness, question } = await askedOnFriday(WITH_CHAT);
    await plantUndelivered(harness, {
      cause: QUESTION_CAUSE,
      notificationClass: 'question',
      questionId: question.id,
    });
    harness.script('refinement', completedRun(REFINED_SPEC));
    await answerTaskQuestion(harness.commands, {
      questionId: question.id,
      answer: 'EUR',
      userId: USER,
      role: 'member',
      channel: 'ticket',
    });
    await harness.drain();
    moveTo(harness, '2026-06-05T16:50:00.000Z');
    expect((await repostPass(harness)).has(QUESTION_CAUSE)).toBe(true);
    moveTo(harness, '2026-06-05T17:50:00.000Z');
    // A fresh pass — a new mark set — finds nothing: the withheld row is terminal.
    expect((await repostPass(harness)).size).toBe(0);
  });

  it('keeps an answer an answer when a reminder is counted over a stale read', async () => {
    // The lost update the narrow write exists for: a reminder appends no event, so nothing but the
    // statement's own predicate orders it against an answer.
    const { harness, question } = await askedOnFriday();
    const before = await harness.store.questions.load({} as never, question.id);
    await harness.memory.transaction(async (scope) => {
      const answered = { ...(before as NonNullable<typeof before>), status: 'answered' as const };
      await harness.store.questions.save(scope.tx, answered);
    });
    const counted = await harness.memory.transaction(async (scope) =>
      harness.store.questions.recordReminder(scope.tx, { id: question.id, sent: 0 }),
    );
    expect(counted).toBe(false);
    const after = await harness.store.questions.load({} as never, question.id);
    expect(after?.status).toBe('answered');
    expect(after?.remindersSent).toBe(0);
  });
});

describe('a take-over’s inactivity timeout (product/19 §19, PROGRESS backlog 69)', () => {
  /** A task walked to `ready_for_merge` and taken over at 16:00 on Friday. */
  const takenOverOnFriday = async () => {
    const built = harnessWith();
    await built.harness.publish([ticketMatched()]);
    expect(taskOf(built.harness).task.state).toBe('ready_for_merge');
    moveTo(built.harness, FRIDAY_1600);
    await takeOverTaskCommand(built.harness.humanCommands, {
      taskId: taskOf(built.harness).task.id,
      userId: USER,
      authorName: 'Ada',
      tarball: false,
    });
    await built.harness.drain();
    return built;
  };

  /** Five working days of 8 hours from Friday 16:00: 1 h Friday, 8 h × 4 (Mon–Thu), 7 h Friday. */
  const FIVE_WORKING_DAYS_LATER = '2026-06-12T16:00:00.000Z';

  it('escalates after five working days, not five calendar days (criterion 5)', async () => {
    const { harness } = await takenOverOnFriday();
    expect(taskOf(harness).task.state).toBe('paused');
    expect(takeOverDeadline(harness.calendar, FRIDAY_1600 as IsoDateTime)).toBe(
      FIVE_WORKING_DAYS_LATER,
    );
    const armed = deadlineJobs(harness);
    expect(armed.map((request) => request.data)).toEqual([
      { aggregate: 'task', id: taskOf(harness).task.id, kind: 'take_over_inactivity' },
    ]);
    expect(armed[0]?.startAfter?.toISOString()).toBe(FIVE_WORKING_DAYS_LATER);

    const data: DeadlineSweepData = {
      aggregate: 'task',
      id: taskOf(harness).task.id,
      kind: 'take_over_inactivity',
    };
    // Wednesday 16:00 is five *calendar* days; one millisecond before the deadline is the boundary.
    moveTo(harness, '2026-06-10T16:00:00.000Z');
    await fireNow(harness, data);
    moveTo(harness, '2026-06-12T15:59:59.999Z');
    await fireNow(harness, data);
    expect(taskOf(harness).task.state).toBe('paused');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);

    moveTo(harness, FIVE_WORKING_DAYS_LATER);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
    const escalations = eventsOf(harness, 'task.escalated');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.payload.reason).toBe(
      `the take-over was inactive for ${TAKE_OVER_INACTIVITY_TIMEOUT}`,
    );
    expect(escalations[0]?.payload.blocker_brief).toContain('agentic/acme-1');

    // And once: the task is no longer paused, so a later fire owes nothing.
    await fireNow(harness, data);
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(1);

    // The brief says "hand it back", and the escalated task accepts exactly that (backlog 163).
    expect(escalations[0]?.payload.blocker_brief).toContain('Hand it back');
    await handBackTaskCommand(harness.humanCommands, {
      taskId: data.id,
      userId: USER,
      stage: 'code_review' as Slug,
      summary: 'back from holiday',
    });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('is cancelled by hand-back: the timer fires and finds nobody holding the task', async () => {
    const { harness } = await takenOverOnFriday();
    moveTo(harness, '2026-06-09T11:00:00.000Z');
    await handBackTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage: 'code_review' as Slug,
      summary: 'fixed the rounding by hand',
    });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('ready_for_merge');

    moveTo(harness, FIVE_WORKING_DAYS_LATER);
    await harness.drain();
    expect(
      deadlineJobs(harness).filter(
        (request) => (request.data as DeadlineSweepData).kind === 'take_over_inactivity',
      ),
    ).toEqual([]);
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });

  it('resets on the holder’s own command, and not on anybody else’s (WP-44, PROGRESS backlog 167)', async () => {
    const { harness } = await takenOverOnFriday();
    const taskId = taskOf(harness).task.id;
    const WEDNESDAY_1100 = '2026-06-10T11:00:00.000Z' as IsoDateTime;
    // The negative first: a command by somebody who does not hold the task, on Thursday, after
    // the holder's — it must not move the clock past the holder's own activity.
    harness.recordHumanAction({ taskId, userId: USER, at: WEDNESDAY_1100 });
    harness.recordHumanAction({
      taskId,
      userId: '00000000-0000-4000-8000-00000000beef' as Id,
      at: '2026-06-11T11:00:00.000Z' as IsoDateTime,
    });
    const reset = takeOverDeadline(harness.calendar, WEDNESDAY_1100);
    // Five working days from Wednesday 11:00 is the next Wednesday 11:00 — not Thursday's, which
    // is what the bystander's row would have produced.
    expect(reset).toBe('2026-06-17T11:00:00.000Z');

    // The fire at the take-over's own deadline finds a take-over that is not quiet yet.
    moveTo(harness, FIVE_WORKING_DAYS_LATER);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('paused');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);
    // …and re-armed for the holder's last activity, with no new arming path.
    expect(
      deadlineJobs(harness)
        .filter((request) => (request.data as DeadlineSweepData).kind === 'take_over_inactivity')
        .at(-1)
        ?.startAfter?.toISOString(),
    ).toBe(reset);

    moveTo(harness, '2026-06-17T10:59:59.999Z');
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('paused');

    moveTo(harness, reset);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
    const brief = eventsOf(harness, 'task.escalated')[0]?.payload.blocker_brief ?? '';
    expect(brief).toContain(`no command from them on this task since ${WEDNESDAY_1100}`);
  });

  it('is not reset by a bystander alone: the take-over’s own deadline still escalates', async () => {
    const { harness } = await takenOverOnFriday();
    const taskId = taskOf(harness).task.id;
    harness.recordHumanAction({
      taskId,
      userId: '00000000-0000-4000-8000-00000000beef' as Id,
      at: '2026-06-10T11:00:00.000Z' as IsoDateTime,
    });
    moveTo(harness, FIVE_WORKING_DAYS_LATER);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
  });

  it('counts from the take-over the task holds now, not from one that was handed back', async () => {
    const { harness } = await takenOverOnFriday();
    const taskId = taskOf(harness).task.id;
    moveTo(harness, '2026-06-09T11:00:00.000Z');
    await handBackTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'code_review' as Slug,
      summary: 'handing it back',
    });
    await harness.drain();
    // Taken again on Wednesday at 10:00: five working days from *then* is the following Wednesday.
    moveTo(harness, '2026-06-10T10:00:00.000Z');
    await takeOverTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      authorName: 'Ada',
      tarball: false,
    });
    await harness.drain();

    // The first take-over's deadline passes: its timer re-validates against the second.
    moveTo(harness, FIVE_WORKING_DAYS_LATER);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('paused');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);

    moveTo(harness, '2026-06-17T10:00:00.000Z');
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(1);
  });
});

describe('the workpad follows state, not the wake-up (criterion 6)', () => {
  const BRANCH_LINE = 'git fetch && git checkout agentic/acme-1';

  it('keeps the branch line on the render the take-over’s own escalation causes', async () => {
    const { harness, workpads } = harnessWith();
    await harness.publish([ticketMatched()]);
    moveTo(harness, FRIDAY_1600);
    await takeOverTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      authorName: 'Ada',
      tarball: false,
    });
    await harness.drain();
    expect(workpads.renders.at(-1)).toContain(BRANCH_LINE);
    const beforeEscalation = workpads.renders.length;

    moveTo(harness, '2026-06-12T16:00:00.000Z');
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
    // A render was woken by `task.escalated` — a wake-up that carries no branch — and it still
    // tells the person holding the task where their work is, beside the escalation.
    expect(workpads.renders.length).toBeGreaterThan(beforeEscalation);
    const escalated = workpads.renders.at(-1) as string;
    expect(escalated).toContain('**Needs a human**');
    expect(escalated).toContain('**Taken over by a human**');
    expect(escalated).toContain(BRANCH_LINE);
  });

  it('drops the block on the render after a hand-back', async () => {
    const { harness, workpads } = harnessWith();
    await harness.publish([ticketMatched()]);
    const taskId = taskOf(harness).task.id;
    await takeOverTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      authorName: 'Ada',
      tarball: false,
    });
    await harness.drain();
    expect(workpads.renders.at(-1)).toContain(BRANCH_LINE);
    await handBackTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'code_review' as Slug,
      summary: 'done by hand',
    });
    await harness.drain();
    expect(workpads.renders.at(-1)).not.toContain('**Taken over by a human**');
  });
});

describe('deadline.sweep re-validation, directly', () => {
  const sweepOf = (harness: PipelineHarness) =>
    deadlineSweepHandler({
      unitOfWork: harness.memory,
      store: harness.store,
      jobs: harness.jobs,
      calendar: harness.calendar,
      ids: harness.ids,
      clock: harness.clock,
      redactor: exactSecretRedactor([]),
    });

  it('skips a wake-up it cannot read rather than failing it', async () => {
    const { harness } = harnessWith();
    await expect(
      sweepOf(harness)({
        id: 'job-x',
        queue: JOB_QUEUES.deadlineSweep,
        data: { aggregate: 'question', id: 'not-an-id', kind: 'question_timeout', extra: 1 },
        signal: AbortSignal.abort(),
      }),
    ).resolves.toBeUndefined();
    expect(deadlineJobs(harness)).toEqual([]);
  });

  it('re-arms an early fire no sooner than the floor, so two disagreeing clocks cannot spin it', async () => {
    const { harness, question } = await askedOnFriday();
    const before = deadlineJobs(harness).length;
    moveTo(harness, '2026-06-08T15:59:30.000Z');
    const data: DeadlineSweepData = {
      aggregate: 'question',
      id: question.id,
      kind: 'question_timeout',
    };
    await sweepOf(harness)({
      id: 'job-early',
      queue: JOB_QUEUES.deadlineSweep,
      data,
      signal: AbortSignal.abort(),
    });
    const rearmed = deadlineJobs(harness).slice(before);
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]?.singletonKey).toBe(deadlineKey(data));
    expect(rearmed[0]?.startAfter?.getTime()).toBe(
      Date.parse('2026-06-08T15:59:30.000Z') + DEADLINE_REARM_FLOOR_MS,
    );
  });

  it('settles a question that does not exist', async () => {
    const { harness } = harnessWith();
    await sweepOf(harness)({
      id: 'job-gone',
      queue: JOB_QUEUES.deadlineSweep,
      data: {
        aggregate: 'question',
        id: '00000000-0000-4000-8000-00000000dead',
        kind: 'question_timeout',
      },
      signal: AbortSignal.abort(),
    });
    expect(deadlineJobs(harness)).toEqual([]);
    expect(harness.events()).toEqual([]);
  });
});

describe('what an escalated wait tells a person to do, and that it works (backlog 163)', () => {
  it('names commands the expired question’s task accepts, and not the answer it refuses', async () => {
    const { harness, question } = await askedOnFriday();
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    const brief = eventsOf(harness, 'task.escalated')[0]?.payload.blocker_brief ?? '';
    expect(brief).not.toContain('carry on from where it stopped');
    expect(brief).toContain('can no longer be answered');
    expect(brief).toContain('retry "refinement"');
    // A return is not offered, because the state machine refuses it on a `needs_human` task.
    // Any wording of a return, not one phrase (WP-56 review round 2: "…or return to a stage…" passed).
    expect(brief).not.toMatch(/\breturn\b/i);

    // The promise the old sentence made is refused by the aggregate…
    await expect(
      answerTaskQuestion(harness.commands, {
        questionId: question.id,
        answer: 'EUR',
        userId: USER,
        role: 'member',
        channel: 'ticket',
      }),
    ).rejects.toThrow(IllegalTransitionError);
    // …and so is the return a reader might reach for, which is why the brief does not name it.
    await expect(
      returnToStageCommand(harness.humanCommands, {
        taskId: taskOf(harness).task.id,
        userId: USER,
        stage: 'refinement' as Slug,
        reason: 'EUR',
      }),
    ).rejects.toThrow(IllegalTransitionError);
    // The one the brief does name is accepted, and it asks afresh — a question that can be answered.
    await retryStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage: 'refinement' as Slug,
    });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('waiting_answers');
    expect(eventsOf(harness, 'task.question.asked')).toHaveLength(2);
  });

  it('names a retry for an expired plan approval, which is accepted and asks for the plan again', async () => {
    const { harness } = harnessWith({
      runs: { ...happyRuns(), architecture: completedRun(PLAN('XL')) },
    });
    moveTo(harness, FRIDAY_1600);
    await harness.publish([ticketMatched()]);
    const [requested] = eventsOf(harness, 'task.approval.requested');
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    const brief = eventsOf(harness, 'task.escalated')[0]?.payload.blocker_brief ?? '';
    expect(brief).not.toContain('Approve or reject it in the UI');
    expect(brief).toContain('retry "architecture"');
    // Any wording of a return, not one phrase (WP-56 review round 2: "…or return to a stage…" passed).
    expect(brief).not.toMatch(/\breturn\b/i);

    await expect(
      decideTaskApproval(harness.commands, {
        approvalId: requested?.payload.approval.id as Id,
        decision: 'approved',
        userId: USER,
        role: 'maintainer',
      }),
    ).rejects.toThrow(IllegalTransitionError);
    await retryStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage: 'architecture' as Slug,
    });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('waiting_approval');
    expect(eventsOf(harness, 'task.approval.requested')).toHaveLength(2);
  });

  it('says a budget retry carries on without asking again — and it does', async () => {
    const shipped = materialiseAutonomy({
      level: 'autonomous',
      at: '2026-06-01T09:00:00.000Z' as IsoDateTime,
      appliedBy: null,
    });
    const { harness } = harnessWith({
      cost: true,
      settings: {
        autonomy: {
          ...shipped,
          policies: { ...shipped.policies, budget_approval_threshold_usd: 5 },
        },
      },
    });
    harness.cost?.seedHistory(PROJECT, [{ size: 'M', costUsd: 6 }]);
    moveTo(harness, FRIDAY_1600);
    await harness.publish([ticketMatched()]);
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    const stage = taskOf(harness).task.currentStage as Slug;
    const brief = eventsOf(harness, 'task.escalated')[0]?.payload.blocker_brief ?? '';
    expect(brief).toContain(`retry "${stage}"`);
    expect(brief).toContain('without asking for the budget again');

    await retryStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage,
    });
    await harness.drain();
    expect(eventsOf(harness, 'task.approval.requested')).toHaveLength(1);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
  });
});

describe('a finished task owes nobody an answer (re-validation, round 2)', () => {
  it('expires nothing on a task cancelled while it waited', async () => {
    const { harness, question } = await askedOnFriday();
    await cancelTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
    });
    await harness.drain();
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(0);
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe('open');
    expect(taskOf(harness).task.state).toBe('cancelled');
  });

  it('expires no approval on a cancelled task either', async () => {
    const { harness } = harnessWith({
      runs: { ...happyRuns(), architecture: completedRun(PLAN('XL')) },
    });
    moveTo(harness, FRIDAY_1600);
    await harness.publish([ticketMatched()]);
    const [requested] = eventsOf(harness, 'task.approval.requested');
    await cancelTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
    });
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect(
      (await harness.store.approvals.load({} as never, requested?.payload.approval.id as Id))
        ?.approval.status,
    ).toBe('pending');
    expect(eventsOf(harness, 'task.approval.decided')).toHaveLength(0);
  });
});

describe('the recovery row: a lost arm, and a row older than deadlines (backlog 161, 162)', () => {
  const GRACE_MS = 60_000;
  const siteOf = (harness: PipelineHarness) => ({
    store: harness.store.deadlineRecovery,
    settings: staticProjectSettings(() => harness.settings),
    sweep: {
      unitOfWork: harness.memory,
      store: harness.store,
      jobs: harness.jobs,
      calendar: harness.calendar,
      ids: harness.ids,
      redactor: exactSecretRedactor([]),
    },
  });
  const pass = async (harness: PipelineHarness) => {
    const report = await recoverDeadlines(siteOf(harness), {
      now: harness.clock.now(),
      graceMs: GRACE_MS,
      limit: 50,
      clock: harness.clock,
    });
    await harness.drain();
    return report;
  };
  /** The timer the handler armed, dropped — what a process dying after commit leaves. */
  const dropTimers = (harness: PipelineHarness) => harness.jobs.take(JOB_QUEUES.deadlineSweep);

  it('expires a question whose arming was dropped, once the grace has passed and not before', async () => {
    const { harness, question } = await askedOnFriday();
    // The expiry and (since WP-84) the reminder: both arms lost with the process.
    expect(dropTimers(harness)).toHaveLength(2);

    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect(await pass(harness)).toEqual({ found: 0, expired: 0, backfilled: 0 });
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe('open');
    // Inside the grace, where the armed job and this pass would race if the grace were ignored.
    moveTo(harness, '2026-06-08T16:00:30.000Z');
    expect(await pass(harness)).toEqual({ found: 0, expired: 0, backfilled: 0 });
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe('open');

    moveTo(harness, '2026-06-08T16:01:00.001Z');
    expect(await pass(harness)).toEqual({ found: 1, expired: 1, backfilled: 0 });
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe(
      'escalated',
    );
    expect(taskOf(harness).task.state).toBe('needs_human');
    // Nothing left for the next pass: the expiry moved the row out of the query.
    expect(await pass(harness)).toEqual({ found: 0, expired: 0, backfilled: 0 });
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(1);
  });

  it('rides the stranded pass as its `deadline` site', async () => {
    const { harness } = await askedOnFriday();
    dropTimers(harness);
    moveTo(harness, '2026-06-08T16:01:00.001Z');
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
      deadlines: siteOf(harness),
    });
    expect(report.find((site) => site.site === 'deadline')).toEqual({
      site: 'deadline',
      found: 1,
      reEnqueued: 0,
      ended: 1,
    });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
  });

  it('does not touch a question whose timer fired normally', async () => {
    const { harness } = await askedOnFriday();
    moveTo(harness, MONDAY_1600);
    await harness.drain();
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(1);
    moveTo(harness, '2026-06-08T16:01:00.001Z');
    expect(await pass(harness)).toEqual({ found: 0, expired: 0, backfilled: 0 });
    expect(eventsOf(harness, 'task.question.expired')).toHaveLength(1);
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(1);
  });

  it('escalates a take-over whose timer was dropped', async () => {
    const { harness } = harnessWith();
    await harness.publish([ticketMatched()]);
    moveTo(harness, FRIDAY_1600);
    await takeOverTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      authorName: 'Ada',
      tarball: false,
    });
    await harness.drain();
    expect(dropTimers(harness)).toHaveLength(1);
    moveTo(harness, '2026-06-12T16:00:30.000Z');
    expect((await pass(harness)).found).toBe(0);
    moveTo(harness, '2026-06-12T16:01:00.001Z');
    expect(await pass(harness)).toEqual({ found: 1, expired: 1, backfilled: 0 });
    expect(taskOf(harness).task.state).toBe('needs_human');
  });

  it('gives a question written before deadlines its first one, counted from the pass — not from when it was asked', async () => {
    const { harness, question } = await askedOnFriday();
    dropTimers(harness);
    const stored = await harness.store.questions.load({} as never, question.id);
    await harness.store.questions.save({} as never, {
      ...(stored as NonNullable<typeof stored>),
      deadlineAt: null,
    });

    // Wednesday: counted from `asked_at` (Friday) the question would be two days overdue.
    const WEDNESDAY_1000 = '2026-06-10T10:00:00.000Z';
    moveTo(harness, WEDNESDAY_1000);
    expect(await pass(harness)).toEqual({ found: 1, expired: 0, backfilled: 1 });
    const backfilled = await harness.store.questions.load({} as never, question.id);
    expect(backfilled?.status).toBe('open');
    expect(backfilled?.deadlineAt).toBe('2026-06-11T10:00:00.000Z');
    const armed = deadlineJobs(harness);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.startAfter?.toISOString()).toBe('2026-06-11T10:00:00.000Z');
    // Once: the column is no longer null.
    expect(await pass(harness)).toEqual({ found: 0, expired: 0, backfilled: 0 });

    moveTo(harness, '2026-06-11T10:00:00.000Z');
    await harness.drain();
    expect((await harness.store.questions.load({} as never, question.id))?.status).toBe(
      'escalated',
    );
  });

  it('gives an approval written before deadlines its first one too', async () => {
    const { harness } = harnessWith({
      runs: { ...happyRuns(), architecture: completedRun(PLAN('XL')) },
    });
    moveTo(harness, FRIDAY_1600);
    await harness.publish([ticketMatched()]);
    dropTimers(harness);
    const [requested] = eventsOf(harness, 'task.approval.requested');
    const id = requested?.payload.approval.id as Id;
    const stored = await harness.store.approvals.load({} as never, id);
    const withoutDeadline = stored as NonNullable<typeof stored>;
    await harness.store.approvals.save({} as never, {
      ...withoutDeadline,
      approval: { ...withoutDeadline.approval, deadlineAt: null },
    });
    moveTo(harness, '2026-06-10T10:00:00.000Z');
    expect(await pass(harness)).toEqual({ found: 1, expired: 0, backfilled: 1 });
    expect((await harness.store.approvals.load({} as never, id))?.approval.deadlineAt).toBe(
      '2026-06-11T10:00:00.000Z',
    );
  });
});
