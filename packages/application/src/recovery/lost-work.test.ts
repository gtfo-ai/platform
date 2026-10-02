/**
 * The two WP-124 rows of the recovery table — `knowledge_apply` and `discovery_record` (PROGRESS
 * backlog 366, TD-004's M7 amendment) — through `runStrandedRecovery`, the pass production runs.
 *
 * The SQL that answers each predicate is asserted against PostgreSQL in
 * `test/integration/recovery/lost-work-recovery-stores.integration.test.ts`. What is here is what the
 * application decides: one wake-up per project (or per artifact) under a mark committed first,
 * nothing when the conditional mark says the live path got there, and the ending — `apply_failed`
 * with a platform reason, or the discovery task escalated with a brief.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { EnqueueRequest } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { askingRefinedSpec } from '../testing/artifact-fixtures.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import type { DiscoveryRecordRecoveryStore, StrandedDiscoveryRecord } from './discovery-record.js';
import type { KnowledgeApplyRecoveryStore, StrandedApply } from './knowledge-apply.js';
import { runStrandedRecovery, type StrandedWorkStore } from './stranded.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const OTHER = '00000000-0000-4000-8000-0000000000b2' as Id;
const NOW = '2026-06-01T12:00:00.000Z' as IsoDateTime;
const LAST_PASS = '2026-06-01T10:00:00.000Z' as IsoDateTime;
const P1 = '00000000-0000-4000-8000-0000000000f1' as Id;
const P2 = '00000000-0000-4000-8000-0000000000f2' as Id;
const P3 = '00000000-0000-4000-8000-0000000000f3' as Id;
const ARTIFACT = '00000000-0000-4000-8000-0000000000e1' as Id;
const CAUSE = '00000000-0000-4000-9000-0000000000c1' as Id;

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

/** A recording apply store; `owed` lists proposals the live path reached since the read. */
const applyStore = (rows: readonly StrandedApply[], owed: readonly Id[] = []) => {
  const calls: string[] = [];
  const ended: { ids: readonly Id[]; reason: string }[] = [];
  const store: KnowledgeApplyRecoveryStore = {
    strandedApplies: async () => rows,
    markApplyAttempt: async (_tx, input) => {
      calls.push(`mark:${input.proposalIds.join(',')}`);
      return input.proposalIds.filter((id) => !owed.includes(id));
    },
    endApply: async (_tx, input) => {
      calls.push(`end:${input.proposalIds.join(',')}`);
      const done = input.proposalIds.filter((id) => !owed.includes(id));
      ended.push({ ids: done, reason: input.reason });
      return done;
    },
  };
  return { store, calls, ended };
};

describe('the knowledge_apply row (backlog 366)', () => {
  const pass = async (store: KnowledgeApplyRecoveryStore, harness = createPipelineHarness()) => {
    const report = await runStrandedRecovery({
      store: emptyStore,
      unitOfWork: harness.memory,
      jobs: harness.jobs,
      clock: { now: () => NOW },
      graceMs: 60_000,
      applies: { store },
    });
    return { report, applies: harness.jobs.take(JOB_QUEUES.knowledgeApply) };
  };

  it('marks a project’s unattempted proposals first, then enqueues one apply for the project', async () => {
    const built = applyStore([
      { proposalId: P1, projectId: PROJECT, recoveryAttemptedAt: null },
      { proposalId: P2, projectId: PROJECT, recoveryAttemptedAt: null },
      { proposalId: P3, projectId: OTHER, recoveryAttemptedAt: null },
    ]);
    const { report, applies } = await pass(built.store);

    expect(built.calls).toEqual([`mark:${P1},${P2}`, `mark:${P3}`]);
    expect(applies.map((request) => request.data)).toEqual([
      { project_id: PROJECT, reason: 'recovery' },
      { project_id: OTHER, reason: 'recovery' },
    ]);
    // The apply's own singleton key: a pass already queued for the project absorbs this one.
    expect(applies[0]?.singletonKey).toBe(`project:${PROJECT}`);
    expect(report.find((site) => site.site === 'knowledge_apply')).toEqual({
      site: 'knowledge_apply',
      found: 3,
      reEnqueued: 2,
      ended: 0,
    });
  });

  it('enqueues nothing for a project whose mark wrote nothing — the live path got there (standing rule 9)', async () => {
    const built = applyStore(
      [{ proposalId: P1, projectId: PROJECT, recoveryAttemptedAt: null }],
      [P1],
    );
    const { report, applies } = await pass(built.store);
    expect(applies).toEqual([]);
    expect(report.find((site) => site.site === 'knowledge_apply')?.reEnqueued).toBe(0);
  });

  it('ends an attempted proposal as apply_failed, with a platform reason naming the attempt', async () => {
    const built = applyStore([
      { proposalId: P1, projectId: PROJECT, recoveryAttemptedAt: LAST_PASS },
    ]);
    const { report, applies } = await pass(built.store);
    expect(applies).toEqual([]);
    expect(built.ended).toEqual([{ ids: [P1], reason: expect.stringContaining(LAST_PASS) }]);
    expect(built.ended[0]?.reason).toContain('approve it again to retry');
    expect(report.find((site) => site.site === 'knowledge_apply')?.ended).toBe(1);
  });

  it('is absent from the report when no store is composed (the canary for the wiring)', async () => {
    const harness = createPipelineHarness();
    const report = await runStrandedRecovery({
      store: emptyStore,
      unitOfWork: harness.memory,
      jobs: harness.jobs,
      clock: { now: () => NOW },
      graceMs: 60_000,
    });
    expect(report.map((site) => site.site)).not.toContain('knowledge_apply');
  });
});

/** A discovery task parked somewhere that can escalate, from the harness's scripted refinement. */
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

const discoveryStore = (rows: readonly StrandedDiscoveryRecord[], live: boolean = false) => {
  const calls: string[] = [];
  const store: DiscoveryRecordRecoveryStore = {
    strandedDiscoveryRecords: async () => rows,
    markDiscoveryRecordAttempt: async (_tx, input) => {
      calls.push(`mark:${input.artifactId}`);
      return !live;
    },
    endDiscoveryRecord: async (_tx, input) => {
      calls.push(`end:${input.artifactId}:${input.reason.slice(0, 40)}`);
      return !live;
    },
  };
  return { store, calls };
};

describe('the discovery_record row (backlog 366)', () => {
  const pass = async (harness: PipelineHarness, store: DiscoveryRecordRecoveryStore) =>
    runStrandedRecovery({
      store: emptyStore,
      unitOfWork: harness.memory,
      jobs: harness.jobs,
      clock: { now: () => NOW },
      graceMs: 60_000,
      discoveryRecords: {
        store,
        escalation: { store: harness.store, ids: harness.ids, clock: harness.clock },
      },
    });

  it('marks an unrecorded draft first, then enqueues its own recording job once', async () => {
    const { harness, taskId } = await harnessWithTask();
    const built = discoveryStore([
      {
        artifactId: ARTIFACT,
        projectId: PROJECT,
        taskId,
        artifactEventId: CAUSE,
        recoveryAttemptedAt: null,
      },
    ]);
    const report = await pass(harness, built.store);
    expect(built.calls).toEqual([`mark:${ARTIFACT}`]);
    expect(
      harness.jobs.take(JOB_QUEUES.discoveryRecord).map((r: EnqueueRequest) => r.data),
    ).toEqual([{ project_id: PROJECT, task_id: taskId, artifact_id: ARTIFACT }]);
    expect(report.find((site) => site.site === 'discovery_record')).toEqual({
      site: 'discovery_record',
      found: 1,
      reEnqueued: 1,
      ended: 0,
    });
  });

  it('enqueues nothing when the mark wrote nothing (standing rule 9)', async () => {
    const { harness, taskId } = await harnessWithTask();
    const built = discoveryStore(
      [
        {
          artifactId: ARTIFACT,
          projectId: PROJECT,
          taskId,
          artifactEventId: CAUSE,
          recoveryAttemptedAt: null,
        },
      ],
      true,
    );
    await pass(harness, built.store);
    expect(harness.jobs.take(JOB_QUEUES.discoveryRecord)).toEqual([]);
  });

  it('ends an attempted draft and escalates its task with a brief that says what was lost', async () => {
    const { harness, taskId } = await harnessWithTask();
    const built = discoveryStore([
      {
        artifactId: ARTIFACT,
        projectId: PROJECT,
        taskId,
        artifactEventId: CAUSE,
        recoveryAttemptedAt: LAST_PASS,
      },
    ]);
    const report = await pass(harness, built.store);
    expect(built.calls[0]).toMatch(new RegExp(`^end:${ARTIFACT}:`));
    expect(report.find((site) => site.site === 'discovery_record')?.ended).toBe(1);
    const escalated = harness
      .events()
      .filter((event) => event.type === 'task.escalated')
      .at(-1);
    expect(escalated?.type === 'task.escalated' ? escalated.payload.blocker_brief : '').toContain(
      'could not record what discovery ACME-1 found',
    );
    expect(harness.jobs.take(JOB_QUEUES.discoveryRecord)).toEqual([]);
  });

  it('tells a finished discovery task’s people instead, since done cannot escalate (Q113)', async () => {
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
    const built = discoveryStore([
      {
        artifactId: ARTIFACT,
        projectId: PROJECT,
        taskId,
        artifactEventId: CAUSE,
        recoveryAttemptedAt: LAST_PASS,
      },
    ]);
    await pass(harness, built.store);
    const notifies = harness.jobs.take(JOB_QUEUES.pipelineOutbound);
    // WP-124 review round 1 (orchestrator): exactly one — a doubled enqueue fails here by name.
    expect(notifies).toHaveLength(1);
    const [notify] = notifies;
    expect(notify?.data).toMatchObject({
      duty: 'notify',
      notification_class: 'escalation',
      cause_event_id: CAUSE,
      task_id: taskId,
    });
  });
});
