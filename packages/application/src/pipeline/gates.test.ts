/**
 * The gate evaluator, called directly.
 *
 * `saga.test.ts` drives the gates through the whole loop, which is the right tier for "a failing
 * gate returns the task to Implementation". It is the wrong tier for *what the gate returned*: the
 * loop only ever observes `passed`, so the `detail` string — the platform's only account of **why**
 * a gate failed — is invisible there, and so is every branch that refuses to evaluate.
 *
 * Both matter enough to have their own tier:
 *
 *  - **The CI gate's failure branch is a guard, and a guard that fails open is worse than absent**
 *    (standing rule 14). `ci_gate` is a `BUILTIN_GATE_STAGE_ID`, so the stage job polls
 *    `pipelineStatus` whatever the template's `on` says; a bug that made a `failed` pipeline settle
 *    as `passed: true` would advance the task to code review on red CI, and until this file existed
 *    the whole unit+contract tier stayed green with `CI_TERMINAL_FAIL` settling as passed.
 *  - **`detail` is the CI-gate cut** (Q55): this gate reports the failing job *names*, not
 *    product/04 S4's error block, because fetching the log needs `getJobLog` and a redactor for a
 *    run-scoped credential that does not exist yet. A cut that is only written down drifts; pinning
 *    the string is what makes closing Q55 a deliberate change rather than an accident.
 *
 * The refusal branches (`unsupported`) are asserted here for the same reason: each one is the
 * fail-closed half of a pair whose fail-open half is silent.
 */
import type { IsoDateTime, Slug } from '@platform/contracts';
import type { PipelineStage } from '@platform/domain';
import { compilePipeline, FEATURE_TEMPLATE, stageOf } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { GitProviderPort, PipelineStatus } from '../ports/integrations/git-provider.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import { createGateEvaluator } from './gates.js';
import type { PipelineIntegrations } from './integrations.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const HEAD_SHA = 'b'.repeat(40);

const integrationsWith = (git: Partial<GitProviderPort> | null): PipelineIntegrations => {
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({}),
    getPipelineStatus: async () => {
      throw new Error('the test did not script getPipelineStatus');
    },
    getMergeRequest: async () => {
      throw new Error('the test did not script getMergeRequest');
    },
    ...git,
  } as unknown as GitProviderPort;
  return {
    executor: createIntegrationActionExecutor({
      auditLog: createMemoryAuditLog(),
      redactor: exactSecretRedactor([]),
      // Standing rule: a sleep on a clock nothing drives hangs the suite instead of failing it.
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
    }),
    git: git === null ? null : { port, ref: port.ref, project: 'acme/api' },
    taskManagement: null,
  };
};

const pipelineStatus = (
  status: PipelineStatus['status'],
  jobs: PipelineStatus['jobs'] = [],
): PipelineStatus => ({
  id: 'pipeline-1',
  head_sha: HEAD_SHA,
  status,
  url: null,
  jobs,
  coverage_pct: null,
  finished_at: '2026-06-01T09:30:00.000Z',
});

const job = (
  name: string,
  status: PipelineStatus['status'],
  allowFailure = false,
): PipelineStatus['jobs'][number] => ({
  id: `job-${name}`,
  name,
  status,
  log_ref: `log:${name}`,
  allow_failure: allowFailure,
});

const storedTask = (mr: StoredTask['mr']): StoredTask => ({
  task: {
    id: TASK,
    projectId: PROJECT,
    ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
    template: 'feature',
    mode: 'normal',
    state: 'active',
    currentStage: 'ci_gate',
    stageAttempts: { ci_gate: 1 },
    iterationCounters: {},
    limits: {
      code_review: 3,
      business_review: 2,
      ci_fix: 3,
      human_rounds: 3,
      refinement_questions: 2,
      architecture_revisions: 2,
      rebase: 2,
    },
    sequence: 1,
  },
  template: FEATURE_TEMPLATE,
  priorityRank: 2,
  createdAt: '2026-06-01T09:00:00.000Z',
  branch: 'agentic/acme-1',
  mr,
  workpad: null,
  costActualUsd: 0,
  estimateUsd: null,
});

const MR: StoredTask['mr'] = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'agentic/acme-1',
  head_sha: HEAD_SHA,
};

const templateStage = (id: Slug): PipelineStage => {
  const stage = stageOf(compilePipeline('feature', FEATURE_TEMPLATE), id);
  if (stage === null) {
    throw new Error(`the feature template has no stage "${id}"`);
  }
  return stage;
};

/** A gate a project declared itself, in the shape the interpreter normalises one into. */
const customGate = (overrides: Partial<PipelineStage> = {}): PipelineStage => ({
  ...templateStage('ci_gate'),
  id: 'security_scan',
  custom: true,
  on: [],
  ...overrides,
});

const evaluate = (stage: PipelineStage, stored: StoredTask, git: Partial<GitProviderPort> | null) =>
  createGateEvaluator(integrationsWith(git)).evaluate(stage, stored);

describe('the CI gate', () => {
  it('settles a failed pipeline as not passed, naming the jobs that failed', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () =>
        pipelineStatus('failed', [
          job('test:unit', 'failed'),
          job('lint', 'success'),
          job('test:e2e', 'failed'),
        ]),
    });
    // Rule 14: the failure branch is the guard. `passed` and the reason are asserted together,
    // because a gate that says "not passed" with an empty account is a task nobody can triage.
    expect(result).toEqual({
      kind: 'settled',
      passed: false,
      detail: 'pipeline pipeline-1 failed: test:unit, test:e2e',
    });
  });

  it('settles a canceled pipeline as not passed', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('canceled', [job('test:unit', 'canceled')]),
    });
    // No job reports `failed`, so there are no names to give: the status is the whole account.
    expect(result).toEqual({
      kind: 'settled',
      passed: false,
      detail: 'pipeline pipeline-1 canceled',
    });
  });

  it('settles a skipped pipeline as not passed rather than as "nothing to check"', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('skipped'),
    });
    // A skipped pipeline is not evidence: "the project has no CI" is `null`, and that is the only
    // shape product/04 S4 lets pass without a run.
    expect(result).toEqual({
      kind: 'settled',
      passed: false,
      detail: 'pipeline pipeline-1 skipped',
    });
  });

  it('ignores a failing job the project allowed to fail', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () =>
        pipelineStatus('failed', [
          job('flaky:browser', 'failed', true),
          job('test:unit', 'failed'),
        ]),
    });
    expect(result).toEqual({
      kind: 'settled',
      passed: false,
      detail: 'pipeline pipeline-1 failed: test:unit',
    });
  });

  it('reports the failing job names, not the error block (the Q55 cut)', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('failed', [job('test:unit', 'failed')]),
    });
    // product/04 S4 asks for "the failing job's error block"; this gate reads no log, because
    // `getJobLog`'s redaction obligation for a run-scoped credential is open (Q55). The cut is
    // pinned so that closing Q55 changes a failing test rather than nothing at all.
    const detail = result.kind === 'settled' ? result.detail : '';
    expect(detail).toContain('test:unit');
    expect(detail).not.toContain('log:test:unit');
  });

  it('passes a successful pipeline', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('success', [job('test:unit', 'success')]),
    });
    expect(result).toEqual({
      kind: 'settled',
      passed: true,
      detail: 'pipeline pipeline-1 succeeded',
    });
  });

  it('passes when the project has no pipeline for the commit (product/04 S4)', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => null,
    });
    expect(result.kind).toBe('settled');
    expect(result).toMatchObject({ passed: true });
  });

  it('waits while the pipeline is still running', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('running'),
    });
    expect(result).toEqual({ kind: 'pending', detail: 'pipeline pipeline-1 is running' });
  });

  it('waits — rather than passing — while the merge request has no head commit', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask({ ...MR, head_sha: null }), {
      getPipelineStatus: async () => pipelineStatus('success'),
    });
    expect(result).toEqual({ kind: 'pending', detail: 'the merge request has no head commit yet' });
  });
});

describe('what the platform refuses to evaluate', () => {
  it('refuses a gate that runs a command, because nothing provisions a workspace for one', async () => {
    const result = await evaluate(
      customGate({ id: 'ci_gate', custom: false, command: 'make check' }),
      storedTask(MR),
      { getPipelineStatus: async () => pipelineStatus('success') },
    );
    // Ordered before the builtin-id branch on purpose: a `command` on a stage named `ci_gate` must
    // not be waved through by the platform's own evaluation of that id.
    expect(result.kind).toBe('unsupported');
    expect(result.detail).toContain('make check');
  });

  it('refuses a custom gate that declares no event', async () => {
    const result = await evaluate(customGate(), storedTask(MR), null);
    expect(result.kind).toBe('unsupported');
    expect(result.detail).toContain('declares no event');
  });

  it('waits for a custom gate that names the event which settles it', async () => {
    const result = await evaluate(
      customGate({ on: [{ on: 'ci.pipeline.finished', to: null }] }),
      storedTask(MR),
      null,
    );
    expect(result).toEqual({ kind: 'pending', detail: 'waiting for ci.pipeline.finished' });
  });

  it('refuses a merge-request gate on a task that has no merge request', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(null), null);
    expect(result.kind).toBe('unsupported');
    expect(result.detail).toContain('needs a merge request');
  });

  it('refuses the rebase gate when the project has no git binding', async () => {
    // `gitReads` answers `null` for an unbound project rather than throwing, and `null` here is
    // "the platform cannot tell", never "the branch is clean".
    const result = await evaluate(templateStage('rebase_gate'), storedTask(MR), null);
    expect(result.kind).toBe('unsupported');
    expect(result.detail).toContain('no git binding');
  });
});

describe('the merged gate', () => {
  it('passes on the trigger itself: the task only reaches it through mr.merged', async () => {
    const result = await evaluate(templateStage('merged_gate'), storedTask(MR), null);
    expect(result).toEqual({
      kind: 'settled',
      passed: true,
      detail: 'the merge request was merged',
    });
  });
});
