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
 *  - **`detail` is what the next Implementation run is told** (Q55, closed at WP-81): the failing
 *    job names **and** the first failing job's log, redacted before it is bounded to its head and
 *    tail. Until WP-81 this file pinned the opposite — names only, no log read — so that closing Q55
 *    would change a failing test rather than nothing; that case is **inverted by name** below, not
 *    deleted.
 *  - **The tamper check is part of the gate's read** (WP-81, BD-024 §2): its branches are asserted
 *    here, and the three saga cases in `saga.test.ts` drive it through the loop.
 *
 * The refusal branches (`unsupported`) are asserted here for the same reason: each one is the
 * fail-closed half of a pair whose fail-open half is silent.
 */
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { BUILTIN_GATE_STAGE_IDS } from '@platform/contracts';
import type { PipelineStage } from '@platform/domain';
import { compilePipeline, FEATURE_TEMPLATE, stageOf } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  FileDiff,
  GitProviderPort,
  PipelineStatus,
} from '../ports/integrations/git-provider.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import { CI_LOG_HEAD_CHARS, CI_LOG_TAIL_CHARS } from './ci-log.js';
import { MAX_CONFLICT_FILES } from './diff-coalescer.js';
import { createGateEvaluator, rebaseAgainstCi } from './gates.js';
import type { PipelineIntegrations } from './integrations.js';
import { staticPipelineIntegrations } from './integrations.js';
import { defaultProjectSettings, staticProjectSettings } from './settings.js';
import type { StoredArtifact, StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const HEAD_SHA = 'b'.repeat(40);

/** A file the default protected paths do not cover, so a case that is not about tampering passes it. */
const ORDINARY_FILE: FileDiff = {
  new_path: 'src/totals.ts',
  old_path: 'src/totals.ts',
  diff: '@@ -1 +1 @@\n-a\n+b',
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  omitted: false,
};

const changed = (path: string, overrides: Partial<FileDiff> = {}): FileDiff => ({
  ...ORDINARY_FILE,
  new_path: path,
  old_path: path,
  ...overrides,
});

/** A token of the binding's own, planted where a CI job would print it (TD-012). */
const BINDING_TOKEN = 'fake-binding-token-000000000000000000000001';

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
    // The CI gate reads the merge request's **live** head (WP-60 review round 2); unless a test says
    // otherwise, the branch is where the task recorded it. Mergeability is not computed, so a rebase
    // gate case that forgot to script it waits rather than passing.
    getMergeRequest: async () => liveMergeRequest(HEAD_SHA),
    // WP-81: the tamper check reads the diff whenever the pipeline is terminal. One ordinary file
    // unless a case says otherwise — an empty list is "not computed yet" and keeps the gate pending.
    getMergeRequestDiff: async () => [ORDINARY_FILE],
    // No log unless a case scripts one: the failure detail then says so (standing rule 20).
    getJobLog: async () => {
      throw new IntegrationError('not_found', 'fake-git', 'no log for this job', {
        action: 'get_job_log',
      });
    },
    ...git,
  } as unknown as GitProviderPort;
  return {
    executor: createIntegrationActionExecutor({
      // Declared open on purpose (WP-51): this file is not about the egress allow-list, and an
      // omitted policy is not a thing `IntegrationActionExecutorOptions` permits.
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor: exactSecretRedactor([]),
      // Standing rule: a sleep on a clock nothing drives hangs the suite instead of failing it.
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
    }),
    git:
      git === null
        ? null
        : {
            port,
            ref: port.ref,
            project: 'acme/api',
            // The binding's redactor holds its own credential, as the loader's does (TD-012 step 1).
            redactor: exactSecretRedactor([{ name: 'fake_git_token', value: BINDING_TOKEN }]),
          },
    taskManagement: null,
    communication: null,
  };
};

const liveMergeRequest = (headSha: string, hasConflicts: boolean | null = null) => ({
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid: 7,
    url: 'https://git.example.test/acme/api/-/merge_requests/7',
    branch: 'agentic/acme-1',
    head_sha: headSha,
  },
  state: 'opened' as const,
  draft: false,
  title: 'totals',
  description: '',
  source_branch: 'agentic/acme-1',
  target_branch: 'main',
  head_sha: headSha,
  mergeable: true,
  has_conflicts: hasConflicts,
  labels: [],
  reviewers: [],
  web_url: 'https://git.example.test/acme/api/-/merge_requests/7',
});

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
      rebase_rechecks: 10,
      dependency_policy: 2,
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
  ticketSnapshotAt: null,
  ticketSignalAt: null,
  version: 1,
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
  const stage = stageOf(compilePipeline('feature', FEATURE_TEMPLATE, null), id);
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

/** A unit of work that runs the body with no transaction: the gate only reads artifacts in it. */
const noTransaction: UnitOfWork = {
  transaction: async (fn) => fn({ tx: {} as never, events: {} as never } as never),
} as UnitOfWork;

const evaluate = (
  stage: PipelineStage,
  stored: StoredTask,
  git: Partial<GitProviderPort> | null,
  world: {
    readonly artifacts?: readonly StoredArtifact[];
    readonly protectedPaths?: readonly string[];
    /** WP-106 (backlog 354): the port's answer for a stored document this release refuses. */
    readonly configRefusal?: string;
  } = {},
) =>
  createGateEvaluator({
    integrations: staticPipelineIntegrations(integrationsWith(git)),
    settings: staticProjectSettings((projectId) =>
      defaultProjectSettings(projectId, {
        ...(world.protectedPaths === undefined
          ? {}
          : { config: { policies: { protected_paths: [...world.protectedPaths] } } }),
        ...(world.configRefusal === undefined ? {} : { configRefusal: world.configRefusal }),
      }),
    ),
    unitOfWork: noTransaction,
    store: { artifacts: { listFor: async () => [...(world.artifacts ?? [])] } as never },
    clock: { now: () => '2026-06-01T09:00:00.000Z' },
  }).evaluate(stage, stored);

let artifactSeq = 0;
const artifact = (type: StoredArtifact['type'], data: unknown): StoredArtifact => {
  artifactSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${artifactSeq.toString(16).padStart(12, '0')}` as Id,
    taskId: TASK,
    type,
    version: 1,
    markdown: null,
    data: data as never,
    schemaVersion: '1',
    producedByRunId: null,
    redactionCount: 0,
    createdAt: '2026-06-01T09:00:00.000Z' as IsoDateTime,
  };
};

const PLAN = (declared: readonly string[]) => ({
  approach: 'Sum the lines.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'sum' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [],
  test_plan: [],
  rollout_notes: '',
  risks: [],
  estimated_size: 'S',
  decisions_to_record: [],
  protected_path_changes: declared.map((path) => ({ path, reason: 'the assertion was wrong' })),
});

const NOTES = {
  summary: 'Done.',
  deviations_from_plan: [],
  tests_added: [],
  commands_run: [],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: 'https://git.example.test/acme/api/-/merge_requests/7', iid: 7 },
};

const REVIEW = (confirmed: readonly string[]) => ({
  verdict: 'approve',
  findings: [],
  summary: 'Reviewed.',
  protected_path_changes_confirmed: [...confirmed],
});

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
      // WP-105 (backlog 280): the row names what the tamper check found.
      outcome: 'protected_paths_clean',
      headSha: HEAD_SHA,
      passed: false,
      // The failure's stable identity, for product/04 S4's convergence on this path too (WP-60).
      ciSignature: `ci:failed:test:e2e,test:unit@${HEAD_SHA}`,
      // WP-81: the first failing job's log was asked for; this provider has none, and says so.
      detail:
        'pipeline pipeline-1 failed: test:unit, test:e2e\n' +
        'No job log is included: the provider refused the log (not_found) (job test:unit).',
    });
  });

  it('settles a canceled pipeline as not passed', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('canceled', [job('test:unit', 'canceled')]),
    });
    // No job reports `failed`, so there are no names to give and no log to read: said, not blank.
    expect(result).toEqual({
      kind: 'settled',
      // WP-105 (backlog 280): the row names what the tamper check found.
      outcome: 'protected_paths_clean',
      headSha: HEAD_SHA,
      passed: false,
      // The failure's stable identity, for product/04 S4's convergence on this path too (WP-60).
      ciSignature: `ci:canceled:@${HEAD_SHA}`,
      detail:
        'pipeline pipeline-1 canceled\n' +
        'No job log is included: no failing job was named, so no log was read.',
    });
  });

  it('settles a skipped pipeline as not passed rather than as "nothing to check"', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('skipped'),
    });
    // A skipped pipeline is not evidence: "the project has no CI" is `null`, and that is the only
    // shape product/04 S4 lets pass without a run.
    expect(result).toMatchObject({
      kind: 'settled',
      headSha: HEAD_SHA,
      passed: false,
      // The failure's stable identity, for product/04 S4's convergence on this path too (WP-60).
      ciSignature: `ci:skipped:@${HEAD_SHA}`,
      detail: expect.stringMatching(/^pipeline pipeline-1 skipped\n/),
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
    expect(result).toMatchObject({
      kind: 'settled',
      headSha: HEAD_SHA,
      passed: false,
      // The failure's stable identity, for product/04 S4's convergence on this path too (WP-60).
      ciSignature: `ci:failed:test:unit@${HEAD_SHA}`,
      detail: expect.stringMatching(
        /^pipeline pipeline-1 failed: test:unit\n.*\(job test:unit\)\.$/,
      ),
    });
  });

  /**
   * **The Q55 cut, inverted by name at WP-81.** Until then this case was *"reports the failing job
   * names, not the error block (the Q55 cut)"* and asserted that no log was read at all, because a
   * minted run credential had no redactor on the pipeline's path. WP-76 and WP-80 gave it one, so the
   * gate now reads the first failing job's log — and the case asserts the three halves of doing it
   * right: the body arrives, the binding's own token does not (redacted **before** the cut, so no
   * leading bytes survive either), and the cut is reported for the marker rather than written in.
   */
  it('hands back the failing job’s log, redacted and bounded, beside the job names (the Q55 cut, inverted)', async () => {
    const logReads: string[] = [];
    // The token straddles the head bound: a cut made before the redaction would keep its first
    // half, which no exact-match rule could find again.
    const noise = 'x'.repeat(CI_LOG_HEAD_CHARS - 10);
    const middle = 'progress '.repeat(2_000);
    const log = `${noise}${BINDING_TOKEN}\n${middle}\nFAIL src/totals.test.ts\n  expected 3, received 2 ${BINDING_TOKEN}\n`;
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('failed', [job('test:unit', 'failed')]),
      getJobLog: async (_project, logRef) => {
        logReads.push(logRef);
        return log;
      },
    });
    if (result.kind !== 'settled') {
      throw new Error(`expected a settlement, got ${result.kind}`);
    }
    expect(logReads).toEqual(['log:test:unit']);
    expect(result.detail).toContain('test:unit');
    // The error block is the tail, and it is there.
    expect(result.detail).toContain('FAIL src/totals.test.ts');
    expect(result.detail).toContain('expected 3, received 2');
    // Nothing of the token survives, whole or cut.
    expect(result.detail).not.toContain(BINDING_TOKEN);
    expect(result.detail).not.toContain(BINDING_TOKEN.slice(0, 10));
    expect(result.detail).toContain('[REDACTED:integration:fake_git_token]');
    // The progress noise in the middle is gone, and the cut is reported for the marker: the detail
    // is shorter than the length it states, and it carries no line saying it was cut.
    expect(result.detail.length).toBeLessThan(CI_LOG_HEAD_CHARS + CI_LOG_TAIL_CHARS + 200);
    expect(result.detailOriginalChars).toBeGreaterThan(result.detail.length);
    expect(result.detail).not.toMatch(/truncat|\bcut\b|…/i);
    // The opaque handle is never printed.
    expect(result.detail).not.toContain('log:test:unit');
  });

  it('keeps a short log whole and reports no cut', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('failed', [job('test:unit', 'failed')]),
      getJobLog: async () => 'FAIL src/totals.test.ts\n  expected 3, received 2',
    });
    expect(result).toMatchObject({
      kind: 'settled',
      passed: false,
      detail:
        'pipeline pipeline-1 failed: test:unit\nLog of the failing job test:unit, redacted:\n' +
        'FAIL src/totals.test.ts\n  expected 3, received 2',
    });
    expect(result).not.toHaveProperty('detailOriginalChars');
  });

  it('settles a failed pipeline whose only failing job may fail as not passed, with no names', async () => {
    // The `failed.length === 0` arm reached from a `failed` status (WP-69, backlog 4), not only
    // from `canceled`/`skipped`. Moot against GitLab, which reports such a pipeline `success`;
    // pinned so that a provider that does not is judged by the status rather than by the list.
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () =>
        pipelineStatus('failed', [job('flaky:browser', 'failed', true), job('lint', 'success')]),
    });
    expect(result).toMatchObject({
      kind: 'settled',
      headSha: HEAD_SHA,
      passed: false,
      ciSignature: `ci:failed:@${HEAD_SHA}`,
      detail: expect.stringMatching(/^pipeline pipeline-1 failed\n/),
    });
  });

  it('passes a successful pipeline', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('success', [job('test:unit', 'success')]),
    });
    expect(result).toEqual({
      kind: 'settled',
      // WP-105 (backlog 280): the row names what the tamper check found.
      outcome: 'protected_paths_clean',
      headSha: HEAD_SHA,
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
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getMergeRequest: async () =>
        ({
          ...liveMergeRequest(HEAD_SHA),
          ref: { ...liveMergeRequest(HEAD_SHA).ref, head_sha: null },
        }) as never,
      getPipelineStatus: async () => pipelineStatus('success'),
    });
    expect(result).toEqual({ kind: 'pending', detail: 'the merge request has no head commit yet' });
  });

  /**
   * WP-60 review round 2: the poll path asks the pipeline status of the merge request's **live**
   * head, never the recorded one. The recorded head is `b…` — what a pushing stage reported, or a
   * late `mr.updated` left — and a human has pushed `c…` since; `b…`'s pipeline is green, `c…`'s is
   * still running. Before, the gate passed on `b…`.
   */
  it('judges the live head, not the recorded one, so a stale green pipeline does not pass', async () => {
    const asked: string[] = [];
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getMergeRequest: async () => liveMergeRequest('c'.repeat(40)),
      getPipelineStatus: async (_project, sha) => {
        asked.push(sha);
        return sha === HEAD_SHA ? pipelineStatus('success') : pipelineStatus('running');
      },
    });
    expect(asked).toEqual(['c'.repeat(40)]);
    expect(result).toEqual({ kind: 'pending', detail: 'pipeline pipeline-1 is running' });
  });
});

/**
 * **BD-024's tamper check, as part of the CI gate's read** (WP-81). Every branch of `tamper.ts`'s
 * judgement reached through the evaluator, on a green pipeline unless the case says otherwise — so
 * what fails the gate is the check and nothing else.
 */
describe('the tamper check in the CI gate (WP-81)', () => {
  const green = { getPipelineStatus: async () => pipelineStatus('success') };
  const withDiff = (files: readonly FileDiff[], extra: Partial<GitProviderPort> = {}) => ({
    ...green,
    getMergeRequestDiff: async () => [...files],
    ...extra,
  });

  it('fails the gate on a protected path the plan did not declare, naming it', async () => {
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([ORDINARY_FILE, changed('src/totals.test.ts')]),
      {
        artifacts: [
          artifact('ImplementationPlan', PLAN([])),
          artifact('ImplementationNotes', NOTES),
        ],
      },
    );
    expect(result).toMatchObject({
      kind: 'settled',
      passed: false,
      headSha: HEAD_SHA,
      outcome: 'protected_paths_changed',
    });
    // Not a CI failure: the convergence rule does not count it.
    expect(result).not.toHaveProperty('ciSignature');
    const detail = result.kind === 'settled' ? result.detail : '';
    expect(detail).toContain('does not declare in protected_path_changes: src/totals.test.ts');
    expect(detail).not.toContain('src/totals.ts,');
    // The pipeline's own verdict is still said.
    expect(detail).toContain('pipeline pipeline-1 succeeded');
  });

  it('passes a protected path the plan declared and the code review confirmed', async () => {
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([changed('src/totals.test.ts')]),
      {
        artifacts: [
          artifact('ImplementationPlan', PLAN(['src/totals.test.ts'])),
          artifact('ImplementationNotes', NOTES),
          artifact('ReviewVerdict', REVIEW(['src/*.test.ts'])),
        ],
      },
    );
    expect(result).toEqual({
      kind: 'settled',
      // WP-105 (backlog 280): the row names what the tamper check found.
      outcome: 'protected_paths_clean',
      passed: true,
      headSha: HEAD_SHA,
      detail: 'pipeline pipeline-1 succeeded',
    });
  });

  it('fails a declared path the code review judged and did not confirm', async () => {
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([changed('src/totals.test.ts')]),
      {
        artifacts: [
          artifact('ImplementationPlan', PLAN(['src/totals.test.ts'])),
          artifact('ImplementationNotes', NOTES),
          artifact('ReviewVerdict', REVIEW([])),
        ],
      },
    );
    expect(result).toMatchObject({
      kind: 'settled',
      passed: false,
      outcome: 'protected_paths_changed',
    });
    expect(result.kind === 'settled' ? result.detail : '').toContain(
      'the Code review did not confirm in protected_path_changes_confirmed: src/totals.test.ts',
    );
  });

  it('excuses a declared path provisionally while no review has judged the change, with its head and the excused paths (WP-102)', async () => {
    // The review is **older** than the Developer's latest notes, so it judged an earlier push.
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([changed('src/totals.test.ts')]),
      {
        artifacts: [
          artifact('ImplementationPlan', PLAN(['src/totals.test.ts'])),
          artifact('ReviewVerdict', REVIEW(['src/totals.test.ts'])),
          artifact('ImplementationNotes', NOTES),
        ],
      },
    );
    expect(result).toMatchObject({
      kind: 'settled',
      passed: true,
      outcome: 'protected_paths_awaiting_review',
      // WP-102 (Q109 (b)): the head like any pass, so the rebase gate agrees with CI instead of
      // re-entering it, and the excused paths, which the rebase settlement compares with the
      // latest Review Verdict before Ready.
      headSha: HEAD_SHA,
      excusedPaths: ['src/totals.test.ts'],
    });
    expect(result.kind === 'settled' ? result.detail : '').toContain('src/totals.test.ts');
    expect(result.kind === 'settled' ? result.detail : '').toContain(
      'the rebase gate checks the confirmation before Ready',
    );
  });

  it('flags a deletion and a rename’s old name, and not an added file (WP-81 round 1 ruling)', async () => {
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([
        changed('tests/renamed.test.ts', { old_path: 'tests/totals.test.ts', renamed_file: true }),
        changed('.github/workflows/release.yml', { new_file: true }),
        changed('e2e/checkout.spec.ts', { deleted_file: true }),
      ]),
    );
    const detail = result.kind === 'settled' ? result.detail : '';
    expect(result).toMatchObject({ passed: false, outcome: 'protected_paths_changed' });
    expect(detail).toContain('e2e/checkout.spec.ts');
    expect(detail).toContain('tests/totals.test.ts');
    // The rename's new name and the new workflow are additions: BD-024 §2 flags existing files.
    expect(detail).not.toContain('tests/renamed.test.ts');
    expect(detail).not.toContain('.github/workflows/release.yml');
  });

  it('passes a change that only adds a test file', async () => {
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([ORDINARY_FILE, changed('src/totals.test.ts', { new_file: true })]),
    );
    expect(result).toEqual({
      kind: 'settled',
      // WP-105 (backlog 280): the row names what the tamper check found.
      outcome: 'protected_paths_clean',
      passed: true,
      headSha: HEAD_SHA,
      detail: 'pipeline pipeline-1 succeeded',
    });
  });

  it('reads the project’s own protected paths, not only the default', async () => {
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([changed('src/totals.test.ts'), changed('infra/main.tf')]),
      { protectedPaths: ['infra/**'] },
    );
    const detail = result.kind === 'settled' ? result.detail : '';
    expect(detail).toContain('infra/main.tf');
    // The project's list **replaces** the default (technical/12: arrays replace).
    expect(detail).not.toContain('src/totals.test.ts');
  });

  /**
   * WP-106 (backlog 354): a stored configuration this release cannot read stands in the defaults
   * for the protected paths, so a pass here could carry a change to Ready with no run left to
   * refuse it. The gate is **not evaluated** and says why, by the refusal's own sentence; a green
   * pipeline and a diff that touches nothing the defaults protect does not make it pass.
   */
  it('refuses to judge, by name, while the project’s stored configuration cannot be read', async () => {
    const refusal =
      'the stored settings of project p (projects.config) do not parse under this release’s schema: policies.protected_paths: "infra/**"';
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([changed('infra/main.tf')]),
      { configRefusal: refusal },
    );
    expect(result).toEqual({ kind: 'unsupported', detail: refusal });
  });

  it('runs on a project with no pipeline for the commit: the CI half is skipped, the check is not', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => null,
      getMergeRequestDiff: async () => [changed('CLAUDE.md')],
    });
    expect(result).toMatchObject({ passed: false, outcome: 'protected_paths_changed' });
    expect(result.kind === 'settled' ? result.detail : '').toContain(
      'the project has no pipeline for this commit',
    );
  });

  it('names the pipeline’s failure and its log beside the paths when both failed', async () => {
    const result = await evaluate(
      templateStage('ci_gate'),
      storedTask(MR),
      withDiff([changed('.gitlab-ci.yml')], {
        getPipelineStatus: async () => pipelineStatus('failed', [job('test:unit', 'failed')]),
        getJobLog: async () => 'FAIL src/totals.test.ts',
      }),
    );
    expect(result).toMatchObject({ passed: false, outcome: 'protected_paths_changed' });
    const detail = result.kind === 'settled' ? result.detail : '';
    expect(detail).toContain('.gitlab-ci.yml');
    expect(detail).toContain('pipeline pipeline-1 failed: test:unit');
    expect(detail).toContain('FAIL src/totals.test.ts');
  });

  it('waits — never reads "no tamper" — while the provider lists no changed file', async () => {
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), withDiff([]));
    expect(result).toMatchObject({ kind: 'pending' });
    expect(result.detail).toContain('tamper check');
  });

  it('refuses a diff at the read’s bound, whose remaining files it cannot see', async () => {
    const many = Array.from({ length: MAX_CONFLICT_FILES }, (_, index) =>
      changed(`src/file-${index}.ts`),
    );
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), withDiff(many));
    expect(result).toMatchObject({ kind: 'unsupported' });
    expect(result.detail).toContain(String(MAX_CONFLICT_FILES));
  });

  it('does not read the diff while the pipeline is still running', async () => {
    const reads: string[] = [];
    const result = await evaluate(templateStage('ci_gate'), storedTask(MR), {
      getPipelineStatus: async () => pipelineStatus('running'),
      getMergeRequestDiff: async () => {
        reads.push('diff');
        return [ORDINARY_FILE];
      },
    });
    expect(result.kind).toBe('pending');
    expect(reads).toEqual([]);
  });
});

/**
 * WP-79 (backlog 267): the rebase gate names the head its merge-request read carried, because a
 * settlement that enters `ready_for_merge` records it as `tasks.ready_head_sha` — the head a later
 * resume or hand-back into Ready is compared with. Both verdicts carry it: a conflict is a judgement
 * of that head too.
 */
describe('the head the rebase gate judged (WP-79)', () => {
  it('carries the live head on a clean and on a conflicted merge request', async () => {
    const moved = 'c'.repeat(40);
    const clean = await evaluate(templateStage('rebase_gate'), storedTask(MR), {
      getMergeRequest: async () => liveMergeRequest(moved, false),
    });
    expect(clean).toMatchObject({ kind: 'settled', passed: true, headSha: moved });
    const conflicted = await evaluate(templateStage('rebase_gate'), storedTask(MR), {
      getMergeRequest: async () => liveMergeRequest(moved, true),
    });
    expect(conflicted).toMatchObject({ kind: 'settled', passed: false, headSha: moved });
  });
});

/** WP-79 review round 2 (backlog 275): Ready only for the head CI passed. */
describe('rebaseAgainstCi', () => {
  const feature = compilePipeline('feature', FEATURE_TEMPLATE, null);
  const pushed = 'c'.repeat(40);

  it('agrees for exactly the head CI passed', () => {
    expect(rebaseAgainstCi(feature, HEAD_SHA, HEAD_SHA)).toEqual({ kind: 'agree' });
  });

  it('sends a different head, no CI-passed head, or no rebase head back to CI', () => {
    expect(rebaseAgainstCi(feature, HEAD_SHA, pushed)).toMatchObject({
      kind: 'reenter_ci',
      reason: expect.stringContaining('moved since CI passed'),
    });
    expect(rebaseAgainstCi(feature, null, HEAD_SHA)).toMatchObject({ kind: 'reenter_ci' });
    expect(rebaseAgainstCi(feature, HEAD_SHA, undefined)).toMatchObject({ kind: 'reenter_ci' });
  });

  it('agrees on a template that does not run the CI gate, which has nothing to agree with', () => {
    const noCi = compilePipeline(
      'feature',
      {
        ...FEATURE_TEMPLATE,
        stages: FEATURE_TEMPLATE.stages.map((stage) =>
          stage.id === 'ci_gate' ? { ...stage, enabled: false } : stage,
        ),
      },
      null,
    );
    expect(rebaseAgainstCi(noCi, null, pushed)).toEqual({ kind: 'agree' });
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

  /**
   * The two halves of one condition, and the reason they are two `it`s rather than a loop.
   *
   * The CI half was **fail-open** until WP-15a's review: `gitReads` answers `null` for an unbound
   * project and `getPipelineStatus` answers `null` for a commit with no pipeline, and product/04 S4
   * makes the second of those *pass* — so a project with no bindings walked through `ci_gate` on
   * `passed: true`. `rebase_gate` had it right, and the asymmetry between two branches of one file
   * is what a reviewer saw.
   *
   * **Only the CI case pins the outer guard, and that is measured rather than assumed.** Reverting
   * the `bindings.git === null` refusal in `gates.ts` fails the CI test with the fail-open in the
   * message (`{kind:'settled', passed:true}`) and leaves the rebase test **green**, because
   * `git.mergeRequest` answers `null` for an unbound project and the branch below it returns the
   * same `unsupported`. That is standing rule 41 — one condition, two guards — and rule 22's
   * remedy is applied at the inner one, which is declared unreachable and names the outer guard.
   * Read this pair as: the CI case is the guard's test, the rebase case is the *behaviour's*.
   *
   * They share `refusesWithoutABinding` so neither can drift, and they are written out because a
   * name built in a `for` loop cannot be cited (`scripts/citations.ts`: "a name built from a
   * template literal or a variable is not collected"), and a guard nobody can name in a docblock is
   * a guard the next author will not find. The *set* is not left to whoever remembers to add one:
   * the test below derives it from `BUILTIN_GATE_STAGE_IDS` and fails when a fourth builtin gate
   * appears without a case here (standing rule 68).
   */
  const PROVIDER_DEPENDENT_GATES = ['ci_gate', 'rebase_gate'] as const;

  const refusesWithoutABinding = async (stage: (typeof PROVIDER_DEPENDENT_GATES)[number]) => {
    const result = await evaluate(templateStage(stage), storedTask(MR), null);
    expect(result).toEqual({
      kind: 'unsupported',
      detail: `gate "${stage}" needs a git provider and the project has no git binding`,
    });
    // Said twice on purpose: the defect this replaces was `settled`/`passed: true`, and a test that
    // only asserted `kind` would have passed against `{kind:'unsupported'}` either way.
    expect(result).not.toMatchObject({ passed: true });
  };

  it('refuses the CI gate when the project has no git binding, instead of passing it', async () => {
    await refusesWithoutABinding('ci_gate');
  });

  it('refuses the rebase gate when the project has no git binding, instead of passing it', async () => {
    await refusesWithoutABinding('rebase_gate');
  });

  it('covers every builtin gate that asks a provider anything', () => {
    // `merged_gate` is settled by the event that got the task there and reads nothing, which is why
    // it is the one exclusion — asserted here rather than assumed, so a fourth gate is a failure.
    expect([...BUILTIN_GATE_STAGE_IDS].filter((id) => id !== 'merged_gate').sort()).toEqual(
      [...PROVIDER_DEPENDENT_GATES].sort(),
    );
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
