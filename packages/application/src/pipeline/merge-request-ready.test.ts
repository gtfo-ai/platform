/**
 * WP-138 ruling (g), **ready before CI**: the `mr_ready` duty marks the developer's merge request
 * ready and — only when its head has no pipeline and the default branch has (or may have) a CI file — asks the
 * provider for a merge-request pipeline, keyed per head. Through the real executor and the real
 * memory store; the git double records what it was asked.
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
import { runMergeRequestReady } from './merge-request-ready.js';
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
        state: 'active',
        currentStage: 'code_review',
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
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      version: 1,
    } as unknown as StoredTask);
  });
  const updates: MergeRequestUpdate[] = [];
  const pipelines: number[] = [];
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({}),
    repositorySettings: async () => ({ defaultBranch: 'develop', ciConfig }),
    updateMergeRequest: async (ref: typeof MR, update: MergeRequestUpdate) => {
      updates.push(update);
      return {
        ref,
        state: 'opened',
        draft: false,
        title: 'Sum the footer',
        description: '',
        source_branch: ref.branch,
        target_branch: 'develop',
        head_sha: HEAD,
        labels: [],
        reviewers: [],
        web_url: ref.url,
      };
    },
    getPipelineStatus: async () =>
      options.pipeline === true
        ? {
            id: 'p-1',
            head_sha: HEAD,
            status: 'running',
            url: null,
            jobs: [],
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
  const data: PipelineOutboundData = {
    duty: 'mr_ready',
    project_id: PROJECT,
    task_id: TASK,
    cause_event_id: '00000000-0000-4000-9000-000000000001',
  };
  return {
    run: () => runMergeRequestReady(options_, data),
    updates,
    pipelines,
    auditLog,
    mirrorReads,
  };
};

describe('the mr_ready duty (WP-138 ruling (g))', () => {
  it('marks the merge request ready and asks for a pipeline when the head has none and the default branch has a CI file', async () => {
    const { run, updates, pipelines } = await world();
    expect(await run()).toEqual({ outcome: 'marked_ready', pipeline: true });
    expect(updates).toEqual([
      { draft: false, title: null, description: null, labels: null, reviewers: null },
    ]);
    expect(pipelines).toEqual([7]);
  });

  it('asks for a pipeline when it cannot read whether the default branch has a CI file (review round 1)', async () => {
    const { run, pipelines } = await world({ ci: 'unknown' });
    expect(await run()).toEqual({ outcome: 'marked_ready', pipeline: true });
    expect(pipelines).toEqual([7]);
  });

  it('asks for no pipeline when the head has one, or when the default branch has no CI file', async () => {
    for (const setting of [{ pipeline: true }, { ci: 'absent' as const }]) {
      const { run, updates, pipelines } = await world(setting);
      expect(await run(), JSON.stringify(setting)).toEqual({
        outcome: 'marked_ready',
        pipeline: false,
      });
      expect(updates).toHaveLength(1);
      expect(pipelines).toEqual([]);
    }
  });

  it('asks once per head: a redelivered wake-up replays rather than starting a second pipeline', async () => {
    const { run, pipelines } = await world();
    await run();
    await run();
    expect(pipelines).toEqual([7]);
  });

  it('records would_have for a shadow task and changes nothing on the provider', async () => {
    const { run, updates, pipelines, auditLog } = await world({ mode: 'shadow' });
    expect(await run()).toEqual({ outcome: 'shadow', pipeline: false });
    expect(updates).toEqual([]);
    expect(pipelines).toEqual([]);
    expect(auditLog.entriesFor('mark_merge_request_ready').map((entry) => entry.status)).toEqual([
      'would_have',
    ]);
  });

  it('looks for the CI file at the path the provider names, by presence, and counts an external configuration as CI (WP-139)', async () => {
    const custom = { kind: 'repository', path: 'deploy/.gitlab-ci.yml' } as const;
    // GoParking: the file is at deploy/.gitlab-ci.yml, so a head with no pipeline gets one.
    const present = await world({ ciConfig: custom });
    expect(await present.run()).toEqual({ outcome: 'marked_ready', pipeline: true });
    expect(present.mirrorReads).toEqual([{ paths: [], presence: ['deploy/.gitlab-ci.yml'] }]);
    // The provider names a path the default branch does not have: no CI, no pipeline asked for.
    const absent = await world({ ciConfig: custom, ci: 'absent' });
    expect(await absent.run()).toEqual({ outcome: 'marked_ready', pipeline: false });
    // Another project's file: present without a mirror read, so a pipeline is asked for.
    const external = await world({
      ciConfig: { kind: 'external', location: '.gitlab-ci.yml@acme/ci-templates' },
      ci: 'absent',
    });
    expect(await external.run()).toEqual({ outcome: 'marked_ready', pipeline: true });
    expect(external.mirrorReads).toEqual([]);
    // The provider would not say: never "no CI", so a pipeline is asked for.
    const unknown = await world({
      ciConfig: { kind: 'unknown', reason: 'GitLab did not report ci_config_path' },
      ci: 'absent',
    });
    expect(await unknown.run()).toEqual({ outcome: 'marked_ready', pipeline: true });
  });

  it('leaves a provider refusal of the pipeline to the CI gate’s wait rather than failing the job', async () => {
    const { run } = await world({ refusePipeline: true });
    expect(await run()).toEqual({ outcome: 'marked_ready', pipeline: false });
  });
});
