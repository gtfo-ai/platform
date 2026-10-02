/**
 * Bound and escalate (WP-124, TD-004's M7 amendment, PROGRESS backlog **366**) — one case per
 * queue that took the shape, each driven through the queue's **real** handler, plus the three
 * endings by the task's state.
 *
 * The failure is injected where every one of these handlers starts: its first database
 * transaction (each loads its task before anything else). That is the one throw all six
 * `pipeline.outbound` duties and the review window share, so the cases are parameterised over the
 * declared set rather than over the one somebody remembered (standing rule 68), and the set itself
 * is read off `OUTBOUND_DUTY_EXHAUSTION` rather than listed here.
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { OUTBOUND_DUTY_EXHAUSTION } from '../ports/job-exhaustion.js';
import type { JobContext } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { askingRefinedSpec } from '../testing/artifact-fixtures.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { escalateExhaustedJob, escalatingOnLastTry } from './job-escalation.js';
import { type PipelineJobOptions, reviewWindowHandler } from './jobs.js';
import { OUTBOUND_ESCALATION_TEXT, pipelineOutboundHandler } from './outbound.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const CAUSE = '00000000-0000-4000-9000-0000000000c1' as Id;

/** A task parked at `waiting_answers` — a state that can escalate. */
const harnessWithTask = async (): Promise<{ harness: PipelineHarness; taskId: Id }> => {
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: askingRefinedSpec(),
      },
    },
  });
  await harness.publish([
    {
      id: '00000000-0000-4000-9000-0000000000a1',
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
        ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
        rule: 'label:agentic',
        priority: 'High',
        issue_type: 'Story',
        epic: null,
        links: [],
      },
    } as never,
  ]);
  const taskId = harness.events().find((event) => event.type === 'task.created')?.stream_id as Id;
  harness.jobs.take(JOB_QUEUES.pipelineOutbound);
  return { harness, taskId };
};

/** The harness's unit of work, except that the first `transaction` throws — a database outage. */
const failingFirst = (inner: UnitOfWork): UnitOfWork => {
  let calls = 0;
  return {
    transaction: async <T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T> => {
      calls += 1;
      if (calls === 1) {
        throw new Error('the database is down');
      }
      return inner.transaction(fn);
    },
  };
};

const escalationOptions = (harness: PipelineHarness, unitOfWork: UnitOfWork = harness.memory) => ({
  unitOfWork,
  store: harness.store,
  jobs: harness.jobs,
  ids: harness.ids,
  clock: harness.clock,
});

const lastTry = { count: 2, limit: 2 };

const BOUND_DUTIES = Object.entries(OUTBOUND_DUTY_EXHAUSTION)
  .filter(([, row]) => row.shape === 'bound_and_escalate')
  .map(([duty]) => duty);

const stateOf = async (harness: PipelineHarness, taskId: Id): Promise<string | undefined> =>
  (await harness.memory.transaction(async (scope) => harness.store.tasks.load(scope.tx, taskId)))
    ?.task.state;

const briefOf = (harness: PipelineHarness): string | undefined => {
  const escalated = harness.events().filter((event) => event.type === 'task.escalated');
  const last = escalated.at(-1);
  return last?.type === 'task.escalated' ? last.payload.blocker_brief : undefined;
};

describe('the declared set (TD-004’s M7 amendment)', () => {
  it('has escalation text for exactly the duties declared bound_and_escalate', () => {
    expect(Object.keys(OUTBOUND_ESCALATION_TEXT).sort()).toEqual([...BOUND_DUTIES].sort());
    // The ruling's four and the two the WP-124 measurement added (backlog 366).
    expect(BOUND_DUTIES.sort()).toEqual([
      'breakdown_create',
      'dependency_gate',
      'ready_head_check',
      'review_only_post',
      'spike_report',
      'ticket_lint_post',
    ]);
  });
});

describe('pipeline.outbound: a duty a person waits on, failing on its last try', () => {
  it.each(BOUND_DUTIES)(
    'escalates the task with a brief naming %s, then still fails the job',
    async (duty) => {
      const { harness, taskId } = await harnessWithTask();
      const handler = pipelineOutboundHandler({
        ...(harness.humanCommands as unknown as Record<string, unknown>),
        ...escalationOptions(harness, failingFirst(harness.memory)),
      } as never);

      await expect(
        handler({
          id: `job-${duty}`,
          queue: JOB_QUEUES.pipelineOutbound,
          signal: new AbortController().signal,
          retries: lastTry,
          data: {
            duty,
            project_id: PROJECT,
            task_id: taskId,
            cause_event_id: CAUSE,
            stage: 'implementation',
          } as never,
        }),
      ).rejects.toThrow('the database is down');

      expect(await stateOf(harness, taskId), `${duty}: the task waits for a person`).toBe(
        'needs_human',
      );
      const brief = briefOf(harness) ?? '';
      expect(brief).toContain(`"${duty}" job failed on all 3 of its tries`);
      expect(brief).toContain(OUTBOUND_ESCALATION_TEXT[duty]?.remedy ?? '∅');
      // Platform text only: the failure's own message is the administrator's list's, not the brief's.
      expect(brief).not.toContain('the database is down');
    },
  );

  it('leaves a throw before the last try to the retry policy, and escalates nothing (the other side)', async () => {
    const { harness, taskId } = await harnessWithTask();
    const handler = pipelineOutboundHandler({
      ...(harness.humanCommands as unknown as Record<string, unknown>),
      ...escalationOptions(harness, failingFirst(harness.memory)),
    } as never);
    await expect(
      handler({
        id: 'job-early',
        queue: JOB_QUEUES.pipelineOutbound,
        signal: new AbortController().signal,
        retries: { count: 1, limit: 2 },
        data: {
          duty: 'breakdown_create',
          project_id: PROJECT,
          task_id: taskId,
          cause_event_id: CAUSE,
        },
      }),
    ).rejects.toThrow('the database is down');
    expect(await stateOf(harness, taskId)).toBe('waiting_answers');
  });

  it('lists a notification-shaped duty only: its last try escalates nothing (rule 20)', async () => {
    const { harness, taskId } = await harnessWithTask();
    const handler = pipelineOutboundHandler({
      ...(harness.humanCommands as unknown as Record<string, unknown>),
      ...escalationOptions(harness, failingFirst(harness.memory)),
    } as never);
    await expect(
      handler({
        id: 'job-workpad',
        queue: JOB_QUEUES.pipelineOutbound,
        signal: new AbortController().signal,
        retries: lastTry,
        data: { duty: 'workpad', project_id: PROJECT, task_id: taskId, cause_event_id: CAUSE },
      }),
    ).rejects.toThrow('the database is down');
    expect(await stateOf(harness, taskId)).toBe('waiting_answers');
  });
});

describe('mr.comment.debounce: a review window failing on its last try', () => {
  it('escalates the task with a brief naming the merge request, then still fails the job', async () => {
    const { harness, taskId } = await harnessWithTask();
    const handler = reviewWindowHandler({
      ...(harness.humanCommands as unknown as PipelineJobOptions),
      ...escalationOptions(harness, failingFirst(harness.memory)),
    } as PipelineJobOptions);

    await expect(
      handler({
        id: 'job-window',
        queue: JOB_QUEUES.mrCommentDebounce,
        signal: new AbortController().signal,
        retries: lastTry,
        data: { task_id: taskId, project_id: PROJECT, iid: 12, opened_at: '2026-06-01T09:00:00Z' },
      }),
    ).rejects.toThrow('the database is down');

    expect(await stateOf(harness, taskId)).toBe('needs_human');
    expect(briefOf(harness)).toContain(
      'turn the review comments on merge request !12 into a return',
    );
  });
});

describe('the endings, by the task’s state', () => {
  const job = (taskId: Id) => ({
    taskId,
    projectId: PROJECT,
    queue: JOB_QUEUES.pipelineOutbound,
    duty: 'review_only_post',
    tries: 3,
    causeEventId: CAUSE,
    what: 'post the review on the merge request',
    remedy: 'Post it yourself.',
  });

  it('adds the brief to a task already waiting for a person, without moving it', async () => {
    const { harness, taskId } = await harnessWithTask();
    expect(await escalateExhaustedJob(escalationOptions(harness), job(taskId))).toBe('escalated');
    expect(await escalateExhaustedJob(escalationOptions(harness), job(taskId))).toBe('amended');
    expect(await stateOf(harness, taskId)).toBe('needs_human');
    expect(harness.events().filter((event) => event.type === 'task.escalated')).toHaveLength(2);
  });

  it('tells a finished task’s people through an escalation notification, since it cannot escalate (Q113)', async () => {
    const { harness, taskId } = await harnessWithTask();
    await harness.memory.transaction(async (scope) => {
      const stored = await harness.store.tasks.load(scope.tx, taskId);
      if (stored !== null) {
        await harness.store.tasks.save(scope.tx, {
          ...stored,
          task: { ...stored.task, state: 'done' },
        });
      }
    });

    expect(await escalateExhaustedJob(escalationOptions(harness), job(taskId))).toBe('notified');
    const notifies = harness.jobs.take(JOB_QUEUES.pipelineOutbound);
    // WP-124 review round 1 (orchestrator): exactly one notification, and no escalation event for a
    // task that cannot escalate — a doubled enqueue would otherwise hide behind the notify dedup.
    expect(notifies).toHaveLength(1);
    expect(harness.events().filter((event) => event.type === 'task.escalated')).toHaveLength(0);
    const [notify] = notifies;
    expect(notify?.data).toMatchObject({
      duty: 'notify',
      task_id: taskId,
      cause_event_id: CAUSE,
      notification_class: 'escalation',
    });
    expect(
      String((notify?.data as { notification_detail?: string } | undefined)?.notification_detail),
    ).toContain('could not post the review on the merge request for ACME-1');
    expect(await stateOf(harness, taskId)).toBe('done');
  });

  it('answers absent for a task that is gone', async () => {
    const { harness } = await harnessWithTask();
    expect(
      await escalateExhaustedJob(
        escalationOptions(harness),
        job('00000000-0000-4000-8000-00000000dead' as Id),
      ),
    ).toBe('absent');
  });

  it('rethrows the job’s own failure when escalating fails too', async () => {
    const { harness, taskId } = await harnessWithTask();
    const broken: UnitOfWork = {
      transaction: async () => {
        throw new Error('still down');
      },
    };
    const wrapped = escalatingOnLastTry(
      escalationOptions(harness, broken),
      async () => {
        throw new Error('the provider said 502');
      },
      () => ({ ...job(taskId), tries: undefined }) as never,
    );
    await expect(
      wrapped({
        id: 'j',
        queue: 'q',
        data: {},
        signal: new AbortController().signal,
        retries: lastTry,
      } as JobContext),
    ).rejects.toThrow('the provider said 502');
  });
});
