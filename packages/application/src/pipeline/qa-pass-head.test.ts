/**
 * S-28.18 (BACKLOG 1608) — the head QA's pass records at Ready, and the recovery's one write for a
 * task that passed QA before it did. QA's pass itself is driven through the pipeline harness in
 * `human-return.test.ts` (*"(6) at qa"*); the recovery through the merge check in
 * `platform-merge.test.ts` (*"a task that passed QA with no reviewed head recorded"*).
 */
import type { Id, PipelineTemplate } from '@platform/contracts';
import { compilePipeline, FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import {
  adoptQaPassHead,
  judgedQaPassHead,
  qaPassHead,
  qaPassHeadToAdopt,
} from './qa-pass-head.js';
import type { StoredTask } from './store.js';

const CI_PASSED = 'b'.repeat(40);
const TASK = '00000000-0000-4000-8000-0000000028b1' as Id;

const withoutCi = (template: PipelineTemplate): PipelineTemplate => ({
  ...template,
  stages: template.stages.map((stage) =>
    stage.id === 'ci_gate' ? { ...stage, enabled: false } : stage,
  ),
});

const stored = (overrides: Partial<StoredTask> & { readonly at?: string } = {}): StoredTask => {
  const { at = 'ready_for_merge', ...rest } = overrides;
  return {
    task: {
      id: TASK,
      projectId: '00000000-0000-4000-8000-0000000028a1',
      ticket: { provider: 'fake-jira', key: 'ACME-28', url: 'https://jira.example.test/ACME-28' },
      template: 'feature',
      mode: 'normal',
      state: at === 'ready_for_merge' ? 'ready_for_merge' : 'active',
      currentStage: at,
      stageAttempts: { [at]: 1 },
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
    pipelineDial: null,
    qaStage: true,
    priorityRank: 2,
    createdAt: '2026-11-20T09:00:00.000Z',
    branch: 'agentic/ACME-28',
    mr: null,
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
    ciHeadSha: CI_PASSED,
    ciExcusedPaths: [],
    requestedByUserId: null,
    ticketSnapshotAt: null,
    ticketSignalAt: null,
    version: 1,
    ...rest,
  } as unknown as StoredTask;
};

describe('qaPassHead', () => {
  it('is the head CI passed on a pipeline that runs ci_gate — the head the rebase gate agreed with into qa', () => {
    const pipeline = compilePipeline('feature', FEATURE_TEMPLATE, null, true);
    expect(qaPassHead(pipeline, { ciHeadSha: CI_PASSED })).toBe(CI_PASSED);
    expect(qaPassHead(pipeline, { ciHeadSha: null })).toBeNull();
  });

  it('is nothing on a pipeline with no CI gate: no head was persisted for QA to carry', () => {
    const pipeline = compilePipeline('feature', withoutCi(FEATURE_TEMPLATE), null, true);
    expect(qaPassHead(pipeline, { ciHeadSha: CI_PASSED })).toBeNull();
  });
});

describe('qaPassHeadToAdopt', () => {
  it('answers the head CI passed for a task at Ready with no head whose qa stage is enabled', () => {
    expect(qaPassHeadToAdopt(stored())).toBe(CI_PASSED);
  });

  it('answers nothing for a recorded head, a task without qa, a task not at Ready, or no CI head', () => {
    // The same columns the recovery row reads, so a task it finds is a task this accepts.
    expect(qaPassHeadToAdopt(stored({ readyHeadSha: 'c'.repeat(40) }))).toBeNull();
    expect(qaPassHeadToAdopt(stored({ qaStage: false }))).toBeNull();
    expect(qaPassHeadToAdopt(stored({ at: 'qa' }))).toBeNull();
    expect(qaPassHeadToAdopt(stored({ ciHeadSha: null }))).toBeNull();
  });
});

describe('judgedQaPassHead', () => {
  const pipeline = compilePipeline('feature', FEATURE_TEMPLATE, null, true);
  const judged = async (task: StoredTask) => {
    const memory = new MemoryEventing();
    const store = createMemoryPipelineStore();
    return memory.transaction(async (scope) => judgedQaPassHead(store, scope.tx, pipeline, task));
  };

  it('is the head CI passed when CI excused no protected path', async () => {
    expect(await judged(stored())).toBe(CI_PASSED);
  });

  it('is nothing while a path CI excused is not confirmed by the latest review (WP-102)', async () => {
    // No Review Verdict confirms `.gitlab-ci.yml`: a hand-back into qa skipped the rebase gate that
    // reads the confirmation, so the head is not recorded and a person decides the merge.
    expect(await judged(stored({ ciExcusedPaths: ['.gitlab-ci.yml'] }))).toBeNull();
  });
});

describe('adoptQaPassHead', () => {
  it('records the head once, and only while the column is still empty', async () => {
    const memory = new MemoryEventing();
    const store = createMemoryPipelineStore();
    await memory.transaction(async (scope) => {
      await store.tasks.insert(scope.tx, stored());
      // The insert leaves both heads null, as the SQL one does; CI's is a narrow write.
      await store.tasks.saveCiSettlement(scope.tx, TASK, { headSha: CI_PASSED, excusedPaths: [] });
    });
    const options = { unitOfWork: memory, store };
    expect(await adoptQaPassHead(options, TASK)).toBe(CI_PASSED);
    const after = await memory.transaction(async (scope) => store.tasks.load(scope.tx, TASK));
    expect(after?.readyHeadSha).toBe(CI_PASSED);
    // Idempotent: a second check (a replayed duty, a second pass) writes nothing.
    expect(await adoptQaPassHead(options, TASK)).toBeNull();
    // And it never overwrites a head an entry recorded.
    await memory.transaction(async (scope) =>
      store.tasks.saveReadyHead(scope.tx, TASK, 'd'.repeat(40)),
    );
    expect(await adoptQaPassHead(options, TASK)).toBeNull();
    const kept = await memory.transaction(async (scope) => store.tasks.load(scope.tx, TASK));
    expect(kept?.readyHeadSha).toBe('d'.repeat(40));
  });
});
