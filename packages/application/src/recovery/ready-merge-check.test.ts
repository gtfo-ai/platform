/**
 * S-28.13 (M28 ruling R3b) — the recovery pass's merge-check row: a task already waiting at Ready
 * when the check shipped (AUT-6655) is checked once; a check that read "not mergeable" is checked
 * again after its claim goes stale; a mergeable one, a task not at Ready and a shadow task never.
 * Canary: without the row, the waiting task is never enqueued and its threads stay open.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import type { StoredTask } from '../pipeline/store.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { READY_MERGE_RECHECK_MS, recoverReadyMergeChecks } from './ready-merge-check.js';

const PROJECT = '00000000-0000-4000-8000-0000000018a1' as Id;
const NOW = '2026-11-10T09:00:00.000Z' as IsoDateTime;

const stored = (
  id: string,
  state: 'ready_for_merge' | 'active',
  mode: 'normal' | 'shadow' = 'normal',
): StoredTask =>
  ({
    task: {
      id: id as Id,
      projectId: PROJECT,
      ticket: { provider: 'fake-jira', key: id.slice(-4), url: `https://jira.example.test/${id}` },
      template: 'feature',
      mode,
      state,
      currentStage: state === 'ready_for_merge' ? 'ready_for_merge' : 'implementation',
      stageAttempts: {},
      iterationCounters: {},
      limits: {
        code_review: 3,
        business_review: 2,
        ci_fix: 3,
        human_rounds: 3,
        refinement_questions: 2,
        architecture_revisions: 2,
        rebase: 2,
        rebase_rechecks: 10,
        dependency_policy: 2,
      },
      sequence: 1,
    },
    template: FEATURE_TEMPLATE,
    priorityRank: 2,
    createdAt: NOW,
    branch: 'agentic/ACME-1',
    mr: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid: 7,
      url: 'https://git.example.test/acme/api/-/merge_requests/7',
      branch: 'agentic/ACME-1',
      head_sha: 'b'.repeat(40),
    },
    workpad: null,
    costActualUsd: 0,
    estimateUsd: null,
    estimateBasis: null,
    estimateSamples: null,
    ticketSnapshot: null,
    reviewSubject: null,
    historySample: null,
    riskClasses: [],
    coverage: null,
    dependencies: null,
    requiredReviewers: null,
    reviewThreads: null,
    readyHeadSha: null,
    ciHeadSha: null,
    ciExcusedPaths: [],
    requestedByUserId: null,
    pipelineDial: null,
    qaStage: false,
    ticketSnapshotAt: null,
    ticketSignalAt: null,
    version: 1,
  }) as unknown as StoredTask;

const WAITING = '00000000-0000-4000-8000-0000000018b1';
const WORKING = '00000000-0000-4000-8000-0000000018b2';
const SHADOW = '00000000-0000-4000-8000-0000000018b3';

const setup = async () => {
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  await memory.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, stored(WAITING, 'ready_for_merge'));
    await store.tasks.insert(scope.tx, stored(WORKING, 'active'));
    await store.tasks.insert(scope.tx, stored(SHADOW, 'ready_for_merge', 'shadow'));
  });
  const jobs = recordingJobs();
  const pass = (now: IsoDateTime) =>
    recoverReadyMergeChecks(
      { unitOfWork: memory, jobs },
      { tasks: store.tasks },
      {
        now,
        limit: 50,
      },
    );
  const enqueuedTasks = () =>
    jobs.history
      .filter((request) => request.queue === JOB_QUEUES.pipelineOutbound)
      .map((request) => request.data as unknown as PipelineOutboundData)
      .filter((data) => data.duty === 'ready_merge_check')
      .map((data) => data.task_id);
  const record = (mergeable: boolean | null) =>
    memory.transaction(async (scope) =>
      store.tasks.recordReadyMergeCheck(scope.tx, WAITING as Id, {
        checkedAt: NOW,
        mergeable,
        reason: mergeable === false ? 'unresolved_threads' : null,
        providerStatus: mergeable === false ? 'discussions_not_resolved' : null,
        unresolvedThreads: mergeable === false ? 5 : null,
      }),
    );
  return { pass, enqueuedTasks, record };
};

const after = (ms: number): IsoDateTime =>
  new Date(Date.parse(NOW) + ms).toISOString() as IsoDateTime;

describe('the merge check at Ready, for tasks nothing else wakes (S-28.13)', () => {
  it('checks a task already waiting at Ready once — never a working or a shadow task', async () => {
    const world = await setup();
    expect(await world.pass(NOW)).toEqual({ found: 1, enqueued: 1 });
    expect(world.enqueuedTasks()).toEqual([WAITING]);
    // A second pass inside the window finds it claimed.
    expect(await world.pass(after(60_000))).toEqual({ found: 0, enqueued: 0 });
    expect(world.enqueuedTasks()).toEqual([WAITING]);
  });

  it('checks a blocked task again once its claim is stale, until a check reads mergeable', async () => {
    const world = await setup();
    await world.pass(NOW);
    await world.record(false);
    expect((await world.pass(after(READY_MERGE_RECHECK_MS + 1))).enqueued).toBe(1);
    expect(world.enqueuedTasks()).toEqual([WAITING, WAITING]);
    await world.record(true);
    expect((await world.pass(after(3 * READY_MERGE_RECHECK_MS))).enqueued).toBe(0);
  });
});
