/**
 * The `expired_job` row of the recovery table — WP-156 ruling (c), PROGRESS backlog **421**,
 * through `runStrandedRecovery`, the pass production runs.
 *
 * The SQL that reads an expired last try off pg-boss's table (and not a thrown one) is asserted
 * against PostgreSQL in `test/integration/recovery/expired-job-recovery.integration.test.ts`. What is
 * here is what the application decides: which queues it reads, the brief it writes from a payload,
 * the mark before the escalation, and nothing at all when the mark says another pass took the job.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { boundAndEscalateTargets } from '../ports/job-exhaustion.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { askingRefinedSpec } from '../testing/artifact-fixtures.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import {
  describeExpiredJob,
  EXPIRY_RECOVERED_ELSEWHERE,
  type ExpiredJob,
  type ExpiredJobRecoveryStore,
  expiredJobTargets,
} from './expired-job.js';
import { runStrandedRecovery, type StrandedWorkStore } from './stranded.js';

const PROJECT = '00000000-0000-4000-8000-0000000001b1' as Id;
const NOW = '2026-06-01T12:00:00.000Z' as IsoDateTime;
const JOB = '00000000-0000-4000-8000-0000000001e1' as Id;
const CAUSE = '00000000-0000-4000-9000-0000000001c1' as Id;

const emptyStore: StrandedWorkStore = {
  strandedBootstraps: async () => [],
  markBootstrapAttempt: async () => {},
  endBootstrap: async () => {},
  strandedAsks: async () => [],
  markAskAttempt: async () => {},
  endAsk: async () => {},
  strandedHistoryRecords: async () => [],
  markHistoryRecordAttempt: async () => {},
  endHistoryRecord: async () => {},
  strandedCurations: async () => [],
  markCurationAttempt: async () => {},
  endCuration: async () => {},
  asksWithEndedRun: async () => [],
};

const expired = (data: unknown, overrides: Partial<ExpiredJob> = {}): ExpiredJob => ({
  jobId: JOB,
  queue: JOB_QUEUES.pipelineOutbound,
  data,
  tries: 3,
  expireSeconds: 900,
  failedAt: '2026-06-01T11:50:00.000Z' as IsoDateTime,
  writer: 'worker_timer',
  ...overrides,
});

/** A recording store: the mark is an insert that answers whether it was the first for the id. */
const recordingStore = (rows: readonly ExpiredJob[], taken: readonly Id[] = []) => {
  const marks: { jobId: Id; queue: string; taskId: Id | null }[] = [];
  const queries: unknown[] = [];
  const store: ExpiredJobRecoveryStore = {
    expiredJobs: async (_tx, query) => {
      queries.push(query);
      return rows;
    },
    markExpiredJob: async (_tx, input) => {
      if (taken.includes(input.jobId) || marks.some((mark) => mark.jobId === input.jobId)) {
        return false;
      }
      marks.push({ jobId: input.jobId, queue: input.queue, taskId: input.taskId });
      return true;
    },
  };
  return { store, marks, queries };
};

/** A task created from a matched ticket, parked at a stage that can escalate. */
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
      id: '00000000-0000-4000-9000-0000000001a1',
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

const pass = async (harness: PipelineHarness, store: ExpiredJobRecoveryStore) =>
  runStrandedRecovery({
    store: emptyStore,
    unitOfWork: harness.memory,
    jobs: harness.jobs,
    clock: { now: () => NOW },
    graceMs: 60_000,
    expiredJobs: {
      store,
      escalation: { store: harness.store, ids: harness.ids, clock: harness.clock },
    },
  });

const escalations = (harness: PipelineHarness) =>
  harness.events().filter((event) => event.type === 'task.escalated');

describe('which queues the expired_job row reads (WP-156 (c))', () => {
  it('reads every bound-and-escalate target, except the ones another row names', () => {
    const read = expiredJobTargets().map((target) => target.queue);
    const elsewhere = Object.keys(EXPIRY_RECOVERED_ELSEWHERE);
    expect([...read, ...elsewhere].sort()).toEqual(
      boundAndEscalateTargets()
        .map((target) => target.queue)
        .sort(),
    );
    expect(read.sort()).toEqual([JOB_QUEUES.mrCommentDebounce, JOB_QUEUES.pipelineOutbound]);
    expect(elsewhere).toEqual([JOB_QUEUES.stageExecute]);
    // The outbound queue is read for its bound-and-escalate duties only — never a workpad.
    const outbound = expiredJobTargets().find(
      (target) => target.queue === JOB_QUEUES.pipelineOutbound,
    );
    expect(outbound?.duties).toContain('dependency_gate');
    expect(outbound?.duties).not.toContain('workpad');
  });

  it('asks the store for one day back, the targets and the pass’s grace', async () => {
    const harness = createPipelineHarness({ projectId: PROJECT });
    const built = recordingStore([]);
    await pass(harness, built.store);
    expect(built.queries).toEqual([
      {
        olderThan: '2026-06-01T11:59:00.000Z',
        notBefore: '2026-05-31T12:00:00.000Z',
        targets: expiredJobTargets(),
        limit: 50,
      },
    ]);
  });
});

describe('the brief an expired job is described with', () => {
  const task = '00000000-0000-4000-8000-0000000001d1';

  it('is the duty’s own for a bound-and-escalate outbound duty, and none for any other', () => {
    expect(
      describeExpiredJob(
        expired({
          duty: 'dependency_gate',
          task_id: task,
          project_id: PROJECT,
          cause_event_id: CAUSE,
        }),
      ),
    ).toMatchObject({ taskId: task, duty: 'dependency_gate', causeEventId: CAUSE });
    expect(
      describeExpiredJob(expired({ duty: 'workpad', task_id: task, project_id: PROJECT })),
    ).toBeNull();
  });

  it('is the review window’s for mr.comment.debounce', () => {
    expect(
      describeExpiredJob(
        expired(
          { task_id: task, project_id: PROJECT, iid: 12, opened_at: NOW },
          { queue: JOB_QUEUES.mrCommentDebounce },
        ),
      ),
    ).toMatchObject({ taskId: task, duty: null, what: expect.stringContaining('!12') });
  });

  it('refuses a payload that names no task, a task that is not an id, or a window with no merge request', () => {
    expect(
      describeExpiredJob(expired({ duty: 'dependency_gate', project_id: PROJECT })),
    ).toBeNull();
    expect(
      describeExpiredJob(
        expired({ duty: 'dependency_gate', task_id: 'not-an-id', project_id: PROJECT }),
      ),
    ).toBeNull();
    expect(describeExpiredJob(expired(null))).toBeNull();
    expect(
      describeExpiredJob(
        expired(
          { task_id: task, project_id: PROJECT, iid: '12' },
          { queue: JOB_QUEUES.mrCommentDebounce },
        ),
      ),
    ).toBeNull();
    expect(
      describeExpiredJob(
        expired({ task_id: task, project_id: PROJECT }, { queue: JOB_QUEUES.stageExecute }),
      ),
    ).toBeNull();
  });
});

describe('the expired_job row (backlog 421)', () => {
  it('marks the job, then escalates its task once with a brief that says the job ran out of time', async () => {
    const { harness, taskId } = await harnessWithTask();
    const built = recordingStore([
      expired({
        duty: 'dependency_gate',
        task_id: taskId,
        project_id: PROJECT,
        cause_event_id: CAUSE,
      }),
    ]);
    const report = await pass(harness, built.store);

    expect(built.marks).toEqual([{ jobId: JOB, queue: JOB_QUEUES.pipelineOutbound, taskId }]);
    expect(report.find((site) => site.site === 'expired_job')).toEqual({
      site: 'expired_job',
      found: 1,
      reEnqueued: 0,
      ended: 1,
    });
    const [escalated] = escalations(harness);
    expect(escalations(harness)).toHaveLength(1);
    const brief = escalated?.type === 'task.escalated' ? escalated.payload.blocker_brief : '';
    expect(brief).toContain('ran past its 900-second limit on the last of its 3 tries');
    expect(brief).toContain('ACME-1');
    expect(escalated?.type === 'task.escalated' ? escalated.payload.reason : '').toBe(
      'dependency_gate ran past its 900-second limit on the last of 3 tries',
    );
    // Never re-enqueued: an expired call may have landed.
    expect(harness.jobs.take(JOB_QUEUES.pipelineOutbound)).toEqual([]);

    // A second pass over the same row: the mark is taken, nothing more happens.
    const again = await pass(harness, built.store);
    expect(escalations(harness)).toHaveLength(1);
    expect(again.find((site) => site.site === 'expired_job')?.ended).toBe(0);
  });

  it('escalates nothing for a job another pass already marked (the arbiter)', async () => {
    const { harness, taskId } = await harnessWithTask();
    const built = recordingStore(
      [expired({ duty: 'dependency_gate', task_id: taskId, project_id: PROJECT })],
      [JOB],
    );
    await pass(harness, built.store);
    expect(escalations(harness)).toEqual([]);
  });

  it('marks a payload it cannot describe and escalates nothing, so it is read once', async () => {
    const { harness } = await harnessWithTask();
    const built = recordingStore([expired({ duty: 'dependency_gate', project_id: PROJECT })]);
    const report = await pass(harness, built.store);
    expect(built.marks).toEqual([{ jobId: JOB, queue: JOB_QUEUES.pipelineOutbound, taskId: null }]);
    expect(escalations(harness)).toEqual([]);
    expect(report.find((site) => site.site === 'expired_job')?.ended).toBe(0);
  });

  it('tells a finished task’s people instead, since done cannot escalate (Q113)', async () => {
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
    const built = recordingStore([
      expired({
        duty: 'review_only_post',
        task_id: taskId,
        project_id: PROJECT,
        cause_event_id: CAUSE,
      }),
    ]);
    await pass(harness, built.store);
    const notifies = harness.jobs.take(JOB_QUEUES.pipelineOutbound);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]?.data).toMatchObject({
      duty: 'notify',
      notification_class: 'escalation',
      cause_event_id: CAUSE,
      task_id: taskId,
    });
  });

  it('is absent from the report when no store is composed (the canary for the wiring)', async () => {
    const harness = createPipelineHarness({ projectId: PROJECT });
    const report = await runStrandedRecovery({
      store: emptyStore,
      unitOfWork: harness.memory,
      jobs: harness.jobs,
      clock: { now: () => NOW },
      graceMs: 60_000,
    });
    expect(report.map((site) => site.site)).not.toContain('expired_job');
  });
});
