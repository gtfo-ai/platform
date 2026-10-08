/**
 * **The merge request stays a draft until Ready** (backlog 486, reversing WP-138 ruling (g)): the
 * `mr_pipeline` duty asks for a merge-request pipeline after the Developer stage — only when its head
 * has none, or one held at a manual job, and the default branch has (or may have) a CI file — and
 * marks nothing ready; `mr_ready` marks it ready at `ready_for_merge`; `mr_draft` puts it back when
 * an agent stage follows Ready. Through the real executor and the real memory store; the git double
 * records what it was asked.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { RepositoryFileSource } from '../config/repository-config.js';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  CiConfigLocation,
  GitProviderPort,
  MergeRequestUpdate,
} from '../ports/integrations/git-provider.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { staticPipelineIntegrations } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import {
  runMergeRequestDraft,
  runMergeRequestPipeline,
  runMergeRequestReady,
} from './merge-request-ready.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const HEAD = 'b'.repeat(40);
const MR = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'agentic/ACME-1',
  head_sha: HEAD,
};

/**
 * The mirror's answer: a CI file at `at` (`present`), none (`absent`), or no reading (`unknown`).
 * Since WP-139 a path outside the exact list is asked by **presence**; `reads` records each request.
 */
const files = (
  ci: 'present' | 'absent' | 'unknown',
  at = '.gitlab-ci.yml',
  reads: { paths: readonly string[]; presence: readonly string[] }[] = [],
): RepositoryFileSource => ({
  read: async (request) => {
    reads.push({ paths: request.paths, presence: request.presence ?? [] });
    return ci === 'unknown'
      ? { status: 'unavailable', reason: 'no mirror' }
      : {
          status: 'ok',
          commitSha: 'c'.repeat(40),
          files: Object.fromEntries(
            request.paths.map((path) => [
              path,
              ci === 'present' && path === at
                ? { kind: 'file', text: 'test: {}', blobSha: 'e'.repeat(40) }
                : { kind: 'absent' },
            ]),
          ),
          ...(request.presence === undefined
            ? {}
            : {
                presence: Object.fromEntries(
                  request.presence.map((path) => [
                    path,
                    ci === 'present' && path === at ? 'present' : 'absent',
                  ]),
                ),
              }),
        };
  },
});

const world = async (
  options: {
    readonly mode?: 'normal' | 'shadow';
    readonly pipeline?: boolean;
    readonly ci?: 'present' | 'absent' | 'unknown';
    readonly refusePipeline?: boolean;
    /** WP-139: where the provider says the CI configuration lives. @default GitLab's default file. */
    readonly ciConfig?: CiConfigLocation;
    /** The head pipeline's status and its jobs' statuses, when `pipeline` is true. */
    readonly pipelineStatus?: string;
    readonly jobStatuses?: readonly string[];
    /** The task's state when the duty fires. @default `active` at `code_review`. */
    readonly state?: 'active' | 'ready_for_merge' | 'done' | 'paused';
    /** The live merge request on the provider. @default an open draft. */
    readonly live?: { readonly draft: boolean; readonly state?: 'opened' | 'merged' | 'closed' };
  } = {},
) => {
  const mirrorReads: { paths: readonly string[]; presence: readonly string[] }[] = [];
  const ciConfig = options.ciConfig ?? { kind: 'repository', path: '.gitlab-ci.yml' };
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  await memory.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, {
      task: {
        id: TASK,
        projectId: PROJECT,
        ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
        template: 'feature',
        mode: options.mode ?? 'normal',
        state: options.state ?? 'active',
        currentStage: options.state === 'ready_for_merge' ? 'ready_for_merge' : 'code_review',
        stageAttempts: { implementation: 1, code_review: 1 },
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
      branch: 'agentic/ACME-1',
      mr: MR,
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
    } as unknown as StoredTask);
  });
  const updates: MergeRequestUpdate[] = [];
  const live = options.live ?? { draft: true };
  const liveMergeRequest = (ref: typeof MR, draft: boolean) => ({
    ref,
    state: live.state ?? 'opened',
    draft,
    title: draft ? 'Draft: Sum the footer' : 'Sum the footer',
    description: '',
    source_branch: ref.branch,
    target_branch: 'develop',
    head_sha: HEAD,
    labels: [],
    reviewers: [],
    web_url: ref.url,
  });
  const pipelines: number[] = [];
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({}),
    repositorySettings: async () => ({ defaultBranch: 'develop', ciConfig }),
    getMergeRequest: async (ref: typeof MR) => liveMergeRequest(ref, live.draft),
    updateMergeRequest: async (ref: typeof MR, update: MergeRequestUpdate) => {
      updates.push(update);
      return liveMergeRequest(ref, update.draft ?? live.draft);
    },
    getPipelineStatus: async () =>
      options.pipeline === true
        ? {
            id: 'p-1',
            head_sha: HEAD,
            status: options.pipelineStatus ?? 'running',
            url: null,
            // `manual?` is a manual job with `allow_failure: true` — an optional one.
            jobs: (options.jobStatuses ?? []).map((status, index) => ({
              id: String(index + 1),
              name: `job-${String(index + 1)}`,
              status: status.replace(/\?$/, ''),
              allow_failure: status.endsWith('?'),
            })),
            coverage_pct: null,
            finished_at: null,
          }
        : null,
    createMergeRequestPipeline: async (ref: typeof MR) => {
      if (options.refusePipeline === true) {
        throw new IntegrationError('invalid_request', 'fake-git', 'no job for this pipeline');
      }
      pipelines.push(ref.iid);
      return { id: 'p-2', head_sha: HEAD, status: 'pending', url: null };
    },
  } as unknown as GitProviderPort;
  const auditLog = createMemoryAuditLog();
  const options_ = {
    unitOfWork: memory,
    store,
    repositoryFiles: files(
      options.ci ?? 'present',
      ciConfig.kind === 'repository' ? ciConfig.path : '.gitlab-ci.yml',
      mirrorReads,
    ),
    integrations: staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog,
        idempotencyStore: createMemoryIdempotencyStore(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
      }),
      git: { port, ref: port.ref, project: 'acme/api', redactor: exactSecretRedactor([]) },
      taskManagement: null,
      communication: null,
    }),
  } as unknown as Parameters<typeof runMergeRequestReady>[0];
  const data = (
    duty: PipelineOutboundData['duty'],
    cause = '00000000-0000-4000-9000-000000000001',
  ): PipelineOutboundData => ({
    duty,
    project_id: PROJECT,
    task_id: TASK,
    cause_event_id: cause,
  });
  return {
    run: () => runMergeRequestPipeline(options_, data('mr_pipeline')),
    ready: (cause?: string) => runMergeRequestReady(options_, data('mr_ready', cause)),
    draft: (cause?: string) => runMergeRequestDraft(options_, data('mr_draft', cause)),
    updates,
    pipelines,
    auditLog,
    mirrorReads,
  };
};

const READY = { draft: false, title: null, description: null, labels: null, reviewers: null };
const DRAFT = { draft: true, title: null, description: null, labels: null, reviewers: null };

describe('the mr_pipeline duty, after the Developer stage (backlog 486)', () => {
  it('asks for a pipeline when the head has none and the default branch has a CI file, and marks nothing ready', async () => {
    const { run, updates, pipelines } = await world();
    expect(await run()).toBe('requested');
    // The product owner's decision: the merge request stays a draft while CI and the reviews run.
    expect(updates).toEqual([]);
    expect(pipelines).toEqual([7]);
  });

  it('asks for a pipeline when it cannot read whether the default branch has a CI file (review round 1)', async () => {
    const { run, pipelines } = await world({ ci: 'unknown' });
    expect(await run()).toBe('requested');
    expect(pipelines).toEqual([7]);
  });

  it('asks for no pipeline when the head has one, or when the default branch has no CI file', async () => {
    for (const setting of [{ pipeline: true }, { ci: 'absent' as const }]) {
      const { run, updates, pipelines } = await world(setting);
      expect(await run(), JSON.stringify(setting)).toBe('not_needed');
      expect(updates).toEqual([]);
      expect(pipelines).toEqual([]);
    }
  });

  it('asks for a pipeline when the head’s pipeline is held at a manual job (first local test, backlog 459)', async () => {
    // Autix: the draft's pipeline ends `manual` (its `Draft:` rule held `build_composer`). A job
    // waiting at `manual` inside a still-running pipeline is the same evidence.
    for (const setting of [
      { pipeline: true, pipelineStatus: 'manual' },
      { pipeline: true, pipelineStatus: 'running', jobStatuses: ['success', 'manual'] },
    ]) {
      const { run, pipelines, updates } = await world(setting);
      expect(await run(), JSON.stringify(setting)).toBe('requested');
      expect(pipelines).toEqual([7]);
      expect(updates).toEqual([]);
    }
  });

  it('asks for nothing when the only manual job is an optional one (allow_failure), as in every Autix pipeline', async () => {
    // Autix's image builds are `when: manual, allow_failure: true` in every merge-request
    // pipeline; counting them asked for a second pipeline on every Developer completion.
    const { run, pipelines } = await world({
      pipeline: true,
      pipelineStatus: 'running',
      jobStatuses: ['success', 'running', 'manual?'],
    });
    expect(await run()).toBe('not_needed');
    expect(pipelines).toEqual([]);
  });

  it('asks once per head: a redelivered wake-up replays rather than starting a second pipeline', async () => {
    const { run, pipelines } = await world();
    await run();
    await run();
    expect(pipelines).toEqual([7]);
  });

  it('records would_have for a shadow task and changes nothing on the provider', async () => {
    const { run, updates, pipelines, auditLog } = await world({ mode: 'shadow' });
    expect(await run()).toBe('shadow');
    expect(updates).toEqual([]);
    expect(pipelines).toEqual([]);
    expect(
      auditLog.entriesFor('create_merge_request_pipeline').map((entry) => entry.status),
    ).toEqual(['would_have']);
    expect(auditLog.entriesFor('mark_merge_request_ready')).toEqual([]);
  });

  it('looks for the CI file at the path the provider names, by presence, and counts an external configuration as CI (WP-139)', async () => {
    const custom = { kind: 'repository', path: 'deploy/.gitlab-ci.yml' } as const;
    // GoParking: the file is at deploy/.gitlab-ci.yml, so a head with no pipeline gets one.
    const present = await world({ ciConfig: custom });
    expect(await present.run()).toBe('requested');
    expect(present.mirrorReads).toEqual([{ paths: [], presence: ['deploy/.gitlab-ci.yml'] }]);
    // The provider names a path the default branch does not have: no CI, no pipeline asked for.
    const absent = await world({ ciConfig: custom, ci: 'absent' });
    expect(await absent.run()).toBe('not_needed');
    // Another project's file: present without a mirror read, so a pipeline is asked for.
    const external = await world({
      ciConfig: { kind: 'external', location: '.gitlab-ci.yml@acme/ci-templates' },
      ci: 'absent',
    });
    expect(await external.run()).toBe('requested');
    expect(external.mirrorReads).toEqual([]);
    // The provider would not say: never "no CI", so a pipeline is asked for.
    const unknown = await world({
      ciConfig: { kind: 'unknown', reason: 'GitLab did not report ci_config_path' },
      ci: 'absent',
    });
    expect(await unknown.run()).toBe('requested');
  });

  it('leaves a provider refusal of the pipeline to the CI gate’s wait rather than failing the job', async () => {
    const { run } = await world({ refusePipeline: true });
    expect(await run()).toBe('refused');
  });

  it('asks nothing for a merge request that is no longer open, or for a task that ended', async () => {
    const merged = await world({ live: { draft: false, state: 'merged' } });
    expect(await merged.run()).toBe('not_open');
    expect(merged.pipelines).toEqual([]);
    const done = await world({ state: 'done' });
    expect(await done.run()).toBe('no_task');
  });
});

describe('the mr_ready duty, at ready_for_merge (backlog 486)', () => {
  it('marks the merge request ready once the task is at ready_for_merge, and asks for no pipeline', async () => {
    const { ready, updates, pipelines } = await world({ state: 'ready_for_merge' });
    expect(await ready()).toBe('marked_ready');
    expect(updates).toEqual([READY]);
    expect(pipelines).toEqual([]);
  });

  it('marks it once per entry: a redelivered wake-up replays, a later entry marks again', async () => {
    const { ready, updates } = await world({ state: 'ready_for_merge' });
    await ready();
    await ready();
    expect(updates).toEqual([READY]);
    // A second entry into Ready (after a return) is a new cause, so a new mark.
    await ready('00000000-0000-4000-9000-000000000002');
    expect(updates).toEqual([READY, READY]);
  });

  it('writes nothing when the merge request is already ready, merged or closed (a re-entry nothing drafted)', async () => {
    for (const live of [
      { draft: false },
      { draft: true, state: 'merged' as const },
      { draft: true, state: 'closed' as const },
    ]) {
      const { ready, updates } = await world({ state: 'ready_for_merge', live });
      expect(await ready(), JSON.stringify(live)).toBe('unchanged');
      expect(updates).toEqual([]);
    }
  });

  it('leaves a task that is no longer at ready_for_merge alone', async () => {
    for (const state of ['active', 'paused', 'done'] as const) {
      const { ready, updates } = await world({ state });
      expect(await ready(), state).toBe('no_task');
      expect(updates).toEqual([]);
    }
  });

  it('records would_have for a shadow task and changes nothing on the provider', async () => {
    const { ready, updates, auditLog } = await world({ mode: 'shadow', state: 'ready_for_merge' });
    expect(await ready()).toBe('shadow');
    expect(updates).toEqual([]);
    expect(auditLog.entriesFor('mark_merge_request_ready').map((entry) => entry.status)).toEqual([
      'would_have',
    ]);
  });
});

describe('the mr_draft duty, an agent stage after Ready (backlog 486)', () => {
  it('puts a ready merge request back to draft while an agent changes it again', async () => {
    const { draft, updates } = await world({ live: { draft: false } });
    expect(await draft()).toBe('marked_draft');
    expect(updates).toEqual([DRAFT]);
  });

  it('writes nothing when the merge request is already a draft, merged or closed', async () => {
    for (const live of [
      { draft: true },
      { draft: false, state: 'merged' as const },
      { draft: false, state: 'closed' as const },
    ]) {
      const { draft, updates } = await world({ live });
      expect(await draft(), JSON.stringify(live)).toBe('unchanged');
      expect(updates).toEqual([]);
    }
  });

  it('leaves a task that is back at ready_for_merge (or ended) alone, so a late job never re-drafts a ready merge request', async () => {
    for (const state of ['ready_for_merge', 'done'] as const) {
      const { draft, updates } = await world({ state, live: { draft: false } });
      expect(await draft(), state).toBe('no_task');
      expect(updates).toEqual([]);
    }
  });

  it('records would_have for a shadow task and changes nothing on the provider', async () => {
    const { draft, updates, auditLog } = await world({ mode: 'shadow', live: { draft: false } });
    expect(await draft()).toBe('shadow');
    expect(updates).toEqual([]);
    expect(auditLog.entriesFor('mark_merge_request_draft').map((entry) => entry.status)).toEqual([
      'would_have',
    ]);
  });
});
