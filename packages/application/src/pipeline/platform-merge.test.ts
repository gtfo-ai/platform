/**
 * **The platform may merge** (S-28.15, TD-038 and its amendment A) — the `platform_merge` duty
 * through the real executor, the real memory store and a git double that holds GitLab's semantics:
 * the merge is refused for any head but the expected one (409), and nothing merges unless the
 * double was made mergeable. Every dangerous negative asserts **no merge call** and the named
 * reason; removing its guard makes the double merge and the test fail.
 */
import type { DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import {
  AUTONOMY_PRESETS,
  FEATURE_TEMPLATE,
  ticketStatusPolicyOf,
  toWireAutonomyPolicies,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import type { InboxStore } from '../integrations/inbound.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import {
  type FileDiff,
  type GitProviderPort,
  MergeRefusedError,
  type MergeRequest,
  RebaseRefusedError,
} from '../ports/integrations/git-provider.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { reviewWrites, staticPipelineIntegrations } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import {
  LOST_MERGE_SIGNAL_PASSES,
  MAX_REBASES_PER_READY_ENTRY,
  type PlatformMergeOptions,
  platformMergeKey,
  recoverLostMergeSignal,
  runPlatformMerge,
} from './platform-merge.js';
import { runReadyMergeCheck } from './ready-merge-check.js';
import { defaultProjectSettings, staticProjectSettings } from './settings.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000019a1' as Id;
const TASK = '00000000-0000-4000-8000-0000000019b1' as Id;
const PERSON = '00000000-0000-4000-8000-0000000019c1' as Id;
const HEAD = 'b'.repeat(40);
const NOW = '2026-11-10T14:00:00.000Z';
const MR = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'agentic/ACME-1',
  head_sha: HEAD,
};
const PATCH = '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;';

interface Live {
  state: 'opened' | 'merged' | 'closed' | 'locked';
  draft: boolean;
  mergeable: boolean | null;
  blocker: { reason: string; provider_status: string } | null;
  head: string;
  mergeOptions: { squash: boolean; remove_source_branch: boolean } | null;
  files: FileDiff[];
  commits: number;
  mergeCommit: string | null;
  rebaseFailed: boolean;
}

interface World {
  readonly setting?: 'person' | 'platform';
  readonly mode?: 'normal' | 'shadow';
  readonly shadowDial?: boolean;
  readonly live?: Partial<Live>;
  readonly readyHead?: string | null;
  readonly ciHead?: string | null;
  readonly verdicts?: readonly ('approve' | 'request_changes')[];
  readonly plan?: { readonly status: 'approved' | 'pending'; readonly auto?: boolean } | null;
  /** S-28.8's dial: probation still running; a risk class matched — neither holds the merge. */
  readonly probation?: boolean;
  readonly windowOpen?: boolean;
  readonly personNoteAt?: string;
  readonly ticket?: { readonly status: string; readonly category?: 'done' | 'in_progress' };
  readonly capabilities?: { readonly merge?: boolean; readonly rebase?: boolean };
  readonly mergeAnswer?: 'ok' | 'refuse' | 'transport';
  readonly rebaseAnswer?: 'clean' | 'changed' | 'conflict' | 'refuse';
  readonly pipeline?: 'success' | 'failed' | 'running' | null;
  readonly portless?: boolean;
}

const storedTask = (world: World): StoredTask =>
  ({
    task: {
      id: TASK,
      projectId: PROJECT,
      ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
      template: 'feature',
      mode: world.mode ?? 'normal',
      state: 'ready_for_merge',
      currentStage: 'ready_for_merge',
      stageAttempts: { ready_for_merge: 1 },
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
    mr: MR,
    workpad: null,
    costActualUsd: 0,
    estimateUsd: null,
    estimateBasis: null,
    estimateSamples: null,
    ticketSnapshot: null,
    reviewSubject: null,
    historySample: null,
    riskClasses: world.probation === true ? ['payments'] : [],
    coverage: null,
    dependencies: null,
    requiredReviewers: null,
    reviewThreads: null,
    readyHeadSha: world.readyHead === undefined ? HEAD : world.readyHead,
    ciHeadSha: world.ciHead === undefined ? HEAD : world.ciHead,
    ciExcusedPaths: [],
    requestedByUserId: null,
    pipelineDial: null,
    qaStage: false,
    ticketSnapshotAt: null,
    ticketSignalAt: null,
    version: 1,
  }) as unknown as StoredTask;

const setup = async (world: World = {}) => {
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  const live: Live = {
    state: 'opened',
    draft: false,
    mergeable: true,
    blocker: null,
    head: HEAD,
    mergeOptions: { squash: true, remove_source_branch: false },
    files: [
      {
        new_path: 'src/a.ts',
        old_path: 'src/a.ts',
        diff: PATCH,
        new_file: false,
        renamed_file: false,
        deleted_file: false,
        omitted: false,
      },
    ],
    commits: 2,
    mergeCommit: null,
    rebaseFailed: false,
    ...world.live,
  };
  const merges: { expected: string; squash: boolean; remove: boolean }[] = [];
  const rebases: number[] = [];
  let counter = 0x100;
  const toMr = (): MergeRequest =>
    ({
      ref: { ...MR, head_sha: live.head },
      state: live.state,
      draft: live.draft,
      title: 'fix',
      description: '',
      source_branch: MR.branch,
      target_branch: 'main',
      head_sha: live.head,
      mergeable: live.mergeable,
      has_conflicts: false,
      merge_blocker: live.blocker,
      merge_options: live.mergeOptions,
      merge_commit_sha: live.mergeCommit,
      labels: [],
      reviewers: [],
      web_url: MR.url,
    }) as unknown as MergeRequest;
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({ merge: true, rebase: true, ...world.capabilities }),
    getMergeRequest: async () => toMr(),
    listDiscussions: async () =>
      world.personNoteAt === undefined
        ? []
        : [
            {
              id: 'd1',
              resolvable: false,
              resolved: false,
              notes: [
                {
                  id: 'n1',
                  body: 'one more thing',
                  author: { provider: 'fake-git', external_id: '9' },
                  created_at: world.personNoteAt,
                  system: false,
                },
              ],
            },
          ],
    getMergeRequestDiff: async () => live.files,
    countMergeRequestCommits: async () => live.commits,
    getMergeRequestRebase: async () => ({ in_progress: false, failed: live.rebaseFailed }),
    getPipelineStatus: async (_project: string, sha: string) =>
      world.pipeline === null || world.pipeline === undefined
        ? null
        : {
            id: 'p-9',
            head_sha: sha,
            status: world.pipeline,
            url: null,
            jobs: [],
            coverage_pct: null,
            finished_at: null,
          },
    rebaseMergeRequest: async () => {
      rebases.push(MR.iid);
      if (world.rebaseAnswer === 'refuse') {
        throw new RebaseRefusedError('fake-git', 'cannot_push', 'no push');
      }
      if (world.rebaseAnswer === 'conflict') {
        live.rebaseFailed = true;
        return;
      }
      counter += 1;
      live.head = counter.toString(16).padStart(40, 'c');
      live.blocker = null;
      live.mergeable = true;
      if (world.rebaseAnswer === 'changed') {
        live.files = [{ ...(live.files[0] as FileDiff), diff: `${PATCH}\n+const c = 4;` }];
      }
    },
    mergeMergeRequest: async (
      _ref: unknown,
      request: { expected_head_sha: string; squash: boolean; remove_source_branch: boolean },
    ) => {
      merges.push({
        expected: request.expected_head_sha,
        squash: request.squash,
        remove: request.remove_source_branch,
      });
      if (world.mergeAnswer === 'transport') {
        throw new IntegrationError('unavailable', 'fake-git', 'gateway timeout');
      }
      // GitLab's own refusal: `sha` must match the head (409), and a merge request that cannot be
      // merged is refused (405/422). The double never merges what a seed did not make mergeable.
      if (world.mergeAnswer === 'refuse' || request.expected_head_sha !== live.head) {
        throw new MergeRefusedError('fake-git', 'head_moved', 'sha mismatch', { httpStatus: 409 });
      }
      if (live.state !== 'opened' || live.mergeable !== true || live.blocker !== null) {
        throw new MergeRefusedError('fake-git', 'not_mergeable', 'cannot merge', {
          httpStatus: 422,
        });
      }
      live.state = 'merged';
      live.mergeCommit = 'd'.repeat(40);
      return toMr();
    },
  } as unknown as GitProviderPort;
  const ticketStatus = world.ticket;
  const taskManagement =
    ticketStatus === undefined
      ? null
      : ({
          port: {
            capabilities: () => ({}),
            readTicket: async () => ({
              ref: {
                provider: 'fake-jira',
                key: 'ACME-1',
                url: 'https://jira.example.test/ACME-1',
              },
              title: 'Fix',
              description: '',
              status: ticketStatus.status,
              status_category: ticketStatus.category ?? null,
              comments: [],
              comment_total: 0,
              labels: [],
              assignee: null,
              reporter: null,
            }),
          },
          ref: {
            integrationId: '00000000-0000-4000-8000-00000000a002',
            provider: 'fake-jira',
            type: 'task_management',
          },
          redactor: exactSecretRedactor([]),
        } as never);
  const auditLog = createMemoryAuditLog();
  const jobs = recordingJobs();
  const inboxRows = new Map<string, unknown>();
  const inbox: InboxStore = {
    find: async (provider, deliveryId) =>
      (inboxRows.get(`${provider}\0${deliveryId}`) ?? null) as never,
    record: async (_tx, delivery) => {
      const key = `${delivery.provider}\0${delivery.deliveryId}`;
      if (inboxRows.has(key)) return false;
      inboxRows.set(key, delivery);
      return true;
    },
  } as InboxStore;
  let ids = 0;
  const nextId = (): Id => {
    ids += 1;
    return `00000000-0000-4000-8000-${(0x1a0000000000 + ids).toString(16).padStart(12, '0')}` as Id;
  };
  const clock = { now: () => NOW };
  const options = {
    unitOfWork: memory,
    store,
    jobs,
    ids: { next: nextId },
    clock,
    eventStore: memory.store,
    calendar: undefined as never,
    settings: staticProjectSettings((projectId) =>
      defaultProjectSettings(projectId, {
        config: world.setting === undefined ? {} : { policies: { merge: { by: world.setting } } },
        ...(world.shadowDial === true
          ? {
              autonomy: {
                level: 'observe',
                preset_version: 1,
                applied_at: NOW,
                applied_by: null,
                policies: toWireAutonomyPolicies(AUTONOMY_PRESETS.observe),
              } as never,
            }
          : {}),
        ...(ticketStatus === undefined
          ? {}
          : { ticketStatusPolicy: ticketStatusPolicyOf(null, { closed: ['Done'] } as never) }),
      }),
    ),
    integrations: staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog,
        idempotencyStore: createMemoryIdempotencyStore(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => NOW as IsoDateTime },
      }),
      git: { port, ref: port.ref, project: 'acme/api', redactor: exactSecretRedactor([]) },
      taskManagement,
      communication: null,
    }),
    ...(world.portless === true
      ? {}
      : {
          platformMerge: {
            reviewWindowOpen: async () => world.windowOpen === true,
            recorder: {
              inbox,
              unitOfWork: memory,
              mergeRequests: { latest: async () => null },
              ids: { next: nextId },
              clock: { now: () => NOW as IsoDateTime },
            },
          },
        }),
  } as unknown as PlatformMergeOptions;
  await memory.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, storedTask(world));
    let version = 0;
    for (const verdict of world.verdicts ?? ['approve']) {
      version += 1;
      await store.artifacts.insert(scope.tx, {
        id: nextId(),
        taskId: TASK,
        type: 'ReviewVerdict',
        version,
        markdown: null,
        data: {
          verdict,
          findings: [],
          summary: 'reviewed',
          protected_path_changes_confirmed: [],
        },
        schemaVersion: '1',
        producedByRunId: null,
        createdAt: NOW,
        redactionCount: 0,
      } as never);
    }
    if (world.plan !== undefined && world.plan !== null) {
      await store.approvals.insert(scope.tx, {
        approval: {
          id: nextId(),
          taskId: TASK,
          projectId: PROJECT,
          kind: 'plan',
          status: world.plan.status,
          requestedAt: NOW,
          deadlineAt: null,
          decidedByUserId:
            world.plan.status === 'approved' && world.plan.auto !== true ? PERSON : null,
          decidedAt: world.plan.status === 'approved' ? NOW : null,
          reason: null,
          remindersSent: 0,
          sequence: 1,
        },
        stage: 'architecture',
        attempt: 1,
        autoDecided: world.plan.auto === true,
      } as never);
    }
  });
  const run = (retries?: { count: number; limit: number }) =>
    runPlatformMerge(
      options,
      { task_id: TASK, cause_event_id: TASK },
      retries === undefined ? undefined : { retries },
    );
  const attempts = () => memory.transaction(async (scope) => store.tasks.mergesOf(scope.tx, TASK));
  const attempted = () =>
    memory.log
      .map((entry) => entry.event)
      .filter(
        (event): event is Extract<DomainEvent, { type: 'task.merge.attempted' }> =>
          event.type === 'task.merge.attempted',
      );
  return {
    options,
    memory,
    store,
    live,
    merges,
    rebases,
    jobs,
    auditLog,
    inboxRows,
    run,
    attempts,
    attempted,
  };
};

const reload = async (w: Awaited<ReturnType<typeof setup>>) =>
  w.memory.transaction(async (scope) => w.store.tasks.load(scope.tx, TASK));

describe('the dangerous negatives — no merge call, and the named reason (TD-038 decision 3)', () => {
  it.each<[string, World, string]>([
    [
      'the MR head moved since the review',
      { setting: 'platform', plan: null, live: { head: 'e'.repeat(40) } },
      'waiting',
    ],
    [
      'the reviewed head is not the CI-gated one',
      { setting: 'platform', plan: null, ciHead: 'f'.repeat(40) },
      'waiting',
    ],
    [
      'the provider says not mergeable',
      { setting: 'platform', live: { mergeable: false } },
      'waiting',
    ],
    ['mergeable not decided', { setting: 'platform', live: { mergeable: null } }, 'waiting'],
    ['a draft', { setting: 'platform', live: { draft: true } }, 'waiting'],
    [
      'a provider blocker (unresolved threads)',
      {
        setting: 'platform',
        live: {
          blocker: { reason: 'unresolved_threads', provider_status: 'discussions_not_resolved' },
        },
      },
      'waiting',
    ],
    ['the MR is closed', { setting: 'platform', live: { state: 'closed' } }, 'waiting'],
    [
      'the latest verdict asks for changes',
      { setting: 'platform', verdicts: ['approve', 'request_changes'] },
      'waiting',
    ],
    ['no verdict at all', { setting: 'platform', verdicts: [] }, 'waiting'],
    ['a human-return window is open', { setting: 'platform', windowOpen: true }, 'waiting'],
    [
      'a person wrote younger than the window',
      { setting: 'platform', personNoteAt: '2026-11-10T13:59:30.000Z' },
      'waiting',
    ],
    [
      'the ticket is closed on a fresh read',
      { setting: 'platform', ticket: { status: 'Done' } },
      'waiting',
    ],
    [
      'the ticket was taken by a person (hands-off)',
      { setting: 'platform', ticket: { status: 'Doing', category: 'in_progress' } },
      'waiting',
    ],
    [
      'the repository’s merge settings unknown',
      { setting: 'platform', live: { mergeOptions: null } },
      'waiting',
    ],
    [
      'a plan approval still pending',
      { setting: 'platform', plan: { status: 'pending' } },
      'waiting',
    ],
    ['the setting is person', { setting: 'person' }, 'person'],
    ['the setting is absent (the default)', {}, 'person'],
    ['capability merge false', { setting: 'platform', capabilities: { merge: false } }, 'person'],
    ['a shadow task', { setting: 'platform', mode: 'shadow' }, 'person'],
    ['a project in shadow mode', { setting: 'platform', shadowDial: true }, 'person'],
  ])('%s', async (_name, world, outcome) => {
    const w = await setup(world);
    expect(await w.run()).toBe(outcome);
    expect(w.merges).toEqual([]);
    expect(await w.attempts()).toEqual([]);
    expect(w.attempted()).toEqual([]);
    expect(w.auditLog.entries.filter((entry) => entry.action === 'merge_merge_request')).toEqual(
      [],
    );
  });

  it('a merge that waited is due again for the recovery pass; a person’s merge is not', async () => {
    const due = async (world: World) => {
      const w = await setup(world);
      await w.memory.transaction(async (scope) =>
        w.store.tasks.recordReadyMergeCheck(scope.tx, TASK, {
          checkedAt: '2026-01-01T00:00:00.000Z' as IsoDateTime,
          mergeable: true,
          reason: null,
          providerStatus: null,
          unresolvedThreads: null,
        }),
      );
      await w.run();
      return (
        await w.memory.transaction(async (scope) =>
          w.store.tasks.readyMergeCheckDue(scope.tx, {
            staleBefore: '2099-01-01T00:00:00.000Z' as IsoDateTime,
            limit: 10,
          }),
        )
      ).length;
    };
    // `task_merge_checks` claimed long ago and mergeable: only the platform's wait brings it back.
    expect(await due({ setting: 'platform', live: { head: 'e'.repeat(40) } })).toBe(1);
    expect(await due({ setting: 'person' })).toBe(0);
  });
});

describe('who merges — the plan decision is the human checkpoint (TD-038 decision 2)', () => {
  it('merges during probation after a person approved the plan, pinned to the reviewed head', async () => {
    const w = await setup({ setting: 'platform', probation: true, plan: { status: 'approved' } });
    expect(await w.run()).toBe('merged');
    expect(w.merges).toEqual([{ expected: HEAD, squash: true, remove: false }]);
    const [attempt] = await w.attempts();
    expect(attempt?.outcome).toBe('merged');
    expect(attempt?.planDecision).toBe('approved_by_person');
    expect(attempt?.planApprovalId).not.toBeNull();
    const [event] = w.attempted();
    expect(event?.payload.plan_decision).toBe('approved_by_person');
    expect(event?.actor).toEqual({ kind: 'system', component: 'pipeline' });
    // One path to merged_gate: the duty never moves the task.
    expect((await reload(w))?.task.state).toBe('ready_for_merge');
  });

  it('merges a risk-class task after its plan was approved', async () => {
    const w = await setup({ setting: 'platform', probation: true, plan: { status: 'approved' } });
    expect(await w.run()).toBe('merged');
    expect(w.merges).toHaveLength(1);
  });

  it('merges a plan the platform approved as low-risk, and one that needed no approval', async () => {
    const auto = await setup({ setting: 'platform', plan: { status: 'approved', auto: true } });
    expect(await auto.run()).toBe('merged');
    expect((await auto.attempts())[0]?.planDecision).toBe('approved_by_platform');
    const none = await setup({ setting: 'platform', plan: null });
    expect(await none.run()).toBe('merged');
    expect((await none.attempts())[0]?.planDecision).toBe('not_required');
  });

  it('merges nothing in a process that composed no merge ports, and says so', async () => {
    const w = await setup({ setting: 'platform', portless: true });
    expect(await w.run()).toBe('not_composed');
    expect(w.merges).toEqual([]);
  });
});

describe('one decisive call per task and reviewed head (TD-038 decision 5)', () => {
  it('a replayed duty merges once', async () => {
    const w = await setup({ setting: 'platform' });
    expect(await w.run()).toBe('merged');
    expect(await w.run()).toBe('already_attempted');
    expect(w.merges).toHaveLength(1);
    expect(w.attempted()).toHaveLength(1);
  });

  it('the executor replays the merge for the same (task, head) key: a second call reaches no provider', async () => {
    const w = await setup({ setting: 'platform' });
    const integrations = await w.options.integrations.forProject(PROJECT);
    const call = () =>
      reviewWrites(integrations).merge(
        {
          ref: MR,
          request: { expected_head_sha: HEAD, squash: true, remove_source_branch: false },
          idempotencyKey: platformMergeKey(TASK, HEAD),
        },
        { projectId: PROJECT, taskId: TASK, mode: 'normal' },
      );
    expect((await call())?.state).toBe('merged');
    expect((await call())?.state).toBe('merged');
    expect(w.merges).toHaveLength(1);
  });

  it('a refusal is recorded once, announced, and no further call is made for that head', async () => {
    const w = await setup({ setting: 'platform', mergeAnswer: 'refuse' });
    expect(await w.run()).toBe('refused');
    expect(await w.run()).toBe('already_attempted');
    expect(w.merges).toHaveLength(1);
    const [attempt] = await w.attempts();
    expect(attempt?.outcome).toBe('refused');
    expect(attempt?.providerStatus).toBe('head_moved');
    expect(w.attempted().map((event) => event.payload.outcome)).toEqual(['refused']);
  });

  it('a transport failure is tried by the job, each try re-reading first; the last records failed and tells the people once', async () => {
    const w = await setup({ setting: 'platform', mergeAnswer: 'transport' });
    await expect(w.run({ count: 0, limit: 2 })).rejects.toThrow('gateway timeout');
    await expect(w.run({ count: 1, limit: 2 })).rejects.toThrow('gateway timeout');
    expect(await w.run({ count: 2, limit: 2 })).toBe('failed');
    // One executor attempt per try: the job's three tries are the bound.
    expect(w.merges).toHaveLength(3);
    expect((await w.attempts())[0]?.outcome).toBe('failed');
    expect(w.attempted().map((event) => event.payload.outcome)).toEqual(['failed']);
    expect((await reload(w))?.task.state).toBe('ready_for_merge');
  });

  it('a retry that finds the merge request merged records the lost answer as the merge, with no call', async () => {
    const w = await setup({
      setting: 'platform',
      live: { state: 'merged', mergeCommit: 'd'.repeat(40) },
    });
    expect(await w.run({ count: 1, limit: 2 })).toBe('merged');
    expect(w.merges).toEqual([]);
    expect((await w.attempts())[0]?.mergeCommitSha).toBe('d'.repeat(40));
  });
});

describe('need_rebase (TD-038 amendment A)', () => {
  const rebaseOnly = {
    mergeable: false,
    blocker: { reason: 'rebase', provider_status: 'need_rebase' },
  } as const;

  it('rebase then merge: one rebase, the pipeline on H′ passes, digest and commits equal, then a merge with sha = H′', async () => {
    const w = await setup({ setting: 'platform', live: rebaseOnly, pipeline: 'success' });
    expect(await w.run()).toBe('rebase_asked');
    expect(w.rebases).toEqual([7]);
    expect(w.merges).toEqual([]);
    expect(await w.run()).toBe('rebase_accepted');
    const moved = await reload(w);
    expect(moved?.readyHeadSha).toBe(w.live.head);
    expect(moved?.ciHeadSha).toBe(w.live.head);
    expect(moved?.readyHeadSha).not.toBe(HEAD);
    expect(await w.run()).toBe('merged');
    expect(w.merges).toEqual([{ expected: w.live.head, squash: true, remove: false }]);
    expect(w.rebases).toHaveLength(1);
  });

  it('a diff changed by the rebase is not merged, and the reason is recorded', async () => {
    const w = await setup({
      setting: 'platform',
      live: rebaseOnly,
      pipeline: 'success',
      rebaseAnswer: 'changed',
    });
    expect(await w.run()).toBe('rebase_asked');
    expect(await w.run()).toBe('rebase_changed');
    expect(w.merges).toEqual([]);
    const [rebase] = await w.attempts();
    expect(rebase?.outcome).toBe('rebase_changed');
    expect(rebase?.providerStatus).toBe('digest_changed');
    expect((await reload(w))?.readyHeadSha).toBe(HEAD);
  });

  it('a red pipeline on the rebased commit is not merged', async () => {
    const w = await setup({ setting: 'platform', live: rebaseOnly, pipeline: 'failed' });
    await w.run();
    expect(await w.run()).toBe('rebase_changed');
    expect((await w.attempts())[0]?.providerStatus).toBe('pipeline_failed');
    expect(w.merges).toEqual([]);
  });

  it('a pipeline still running waits, and merges nothing', async () => {
    const w = await setup({ setting: 'platform', live: rebaseOnly, pipeline: 'running' });
    await w.run();
    expect(await w.run()).toBe('waiting');
    expect(w.merges).toEqual([]);
  });

  it('a refused rebase is recorded and left to a person', async () => {
    const w = await setup({ setting: 'platform', live: rebaseOnly, rebaseAnswer: 'refuse' });
    expect(await w.run()).toBe('rebase_refused');
    expect(await w.run()).toBe('already_attempted');
    expect(w.rebases).toHaveLength(1);
  });

  it('a conflict returns the task to the rebase gate', async () => {
    const w = await setup({ setting: 'platform', live: rebaseOnly, rebaseAnswer: 'conflict' });
    expect(await w.run()).toBe('rebase_asked');
    expect(await w.run()).toBe('rebase_conflict');
    expect((await reload(w))?.task.currentStage).toBe('rebase_gate');
    expect(w.jobs.history.some((request) => request.queue === JOB_QUEUES.stageExecute)).toBe(true);
    expect(w.merges).toEqual([]);
  });

  it('a fourth need_rebase in one Ready entry makes no call and says the sentence', async () => {
    const w = await setup({ setting: 'platform', live: rebaseOnly });
    await w.memory.transaction(async (scope) => {
      for (let n = 0; n < MAX_REBASES_PER_READY_ENTRY; n += 1) {
        await w.store.tasks.recordMerge(scope.tx, {
          taskId: TASK,
          headSha: String(n).repeat(40),
          outcome: 'rebased',
          providerStatus: null,
          mergeCommitSha: null,
          planDecision: 'not_required',
          planApprovalId: null,
          changeDigest: 'a'.repeat(64),
          commitCount: 2,
          rebasedTo: null,
          attemptedAt: NOW as IsoDateTime,
          signalPasses: 0,
        });
      }
    });
    expect(await w.run()).toBe('waiting');
    expect(w.rebases).toEqual([]);
    expect(w.merges).toEqual([]);
  });

  it('with the setting at person nothing rebases or merges', async () => {
    const w = await setup({ setting: 'person', live: rebaseOnly });
    expect(await w.run()).toBe('person');
    expect(w.rebases).toEqual([]);
  });
});

describe('the merge check at Ready decides who merges (S-28.13’s read, TD-038)', () => {
  const merges = (w: Awaited<ReturnType<typeof setup>>) =>
    w.jobs.history
      .filter((request) => request.queue === JOB_QUEUES.pipelineOutbound)
      .map((request) => request.data as unknown as PipelineOutboundData)
      .filter((data) => data.duty === 'platform_merge');

  it('enqueues no platform merge at all with the setting at person', async () => {
    const w = await setup({ setting: 'person' });
    expect(await runReadyMergeCheck(w.options as never, { task_id: TASK }, w.options)).toBe(
      'mergeable',
    );
    expect(merges(w)).toEqual([]);
  });

  it('enqueues the platform merge once the provider reads mergeable, with the setting at platform', async () => {
    const w = await setup({ setting: 'platform' });
    expect(await runReadyMergeCheck(w.options as never, { task_id: TASK }, w.options)).toBe(
      'mergeable',
    );
    expect(merges(w).map((data) => data.task_id)).toEqual([TASK]);
  });

  it('enqueues nothing while the provider blocks it', async () => {
    const w = await setup({
      setting: 'platform',
      live: {
        mergeable: false,
        blocker: { reason: 'pipeline', provider_status: 'ci_still_running' },
      },
    });
    expect(await runReadyMergeCheck(w.options as never, { task_id: TASK }, w.options)).toBe(
      'blocked',
    );
    expect(merges(w)).toEqual([]);
  });
});

describe('a lost mr.merged (TD-038 decision 6)', () => {
  it('records mr.merged through the recorder for the first passes, then escalates', async () => {
    const w = await setup({ setting: 'platform' });
    expect(await w.run()).toBe('merged');
    const stored = (await reload(w)) as StoredTask;
    const integrations = await w.options.integrations.forProject(PROJECT);
    const live = await (integrations.git?.port.getMergeRequest(MR) as Promise<MergeRequest>);
    const pass = () =>
      recoverLostMergeSignal(w.options, {
        stored,
        live,
        integrations,
        staleBefore: Date.parse(NOW) + 1,
      });
    // Not yet stale: nothing.
    expect(
      await recoverLostMergeSignal(w.options, {
        stored,
        live,
        integrations,
        staleBefore: Date.parse(NOW),
      }),
    ).toBe('none');
    for (let n = 0; n < LOST_MERGE_SIGNAL_PASSES; n += 1) {
      expect(await pass()).toBe('recorded');
    }
    const merged = w.memory.log.filter((entry) => entry.event.type === 'mr.merged');
    // The inbox key collapses the repeats: one `mr.merged`, however many passes recorded it.
    expect(merged).toHaveLength(1);
    expect(w.inboxRows.size).toBe(1);
    expect(await pass()).toBe('escalated');
    expect((await reload(w))?.task.state).toBe('needs_human');
  });
});

/** Held to the queue's payload type, so a renamed duty fails here rather than in a job. */
const _duty: PipelineOutboundData['duty'] = 'platform_merge';
void _duty;
