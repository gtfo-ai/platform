/**
 * The developer's `open_mr` and `update_mr_description` (WP-138), through the real executor, the
 * real memory store and a git double that keeps the provider's one rule that matters here: one open
 * merge request per source branch, a second refused with `conflict`.
 *
 * The criteria, each a case below: the branch and the target are the task's and the project's,
 * never the model's (2); two calls, and a call after a lost idempotency record, leave one merge
 * request and one record (3); a shadow task records `would_have` and nothing else (4); a planted
 * secret is in neither the provider request nor the audit row (5); and a person's merge request on
 * the branch is refused by name rather than adopted (ruling (c)).
 */
import type { ExternalIdentity, Id, IsoDateTime, MergeRequestRef } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  GitProviderPort,
  MergeRequest,
  MergeRequestDraft,
  MergeRequestUpdate,
} from '../ports/integrations/git-provider.js';
import { MAX_MERGE_REQUEST_DESCRIPTION_CHARS } from '../ports/integrations/git-provider.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { MergeRequestNotAdoptedError, staticPipelineIntegrations } from './integrations.js';
import {
  createMergeRequestTools,
  MAX_MERGE_REQUEST_TITLE_CHARS,
  MergeRequestToolRefusedError,
  type MergeRequestToolTask,
} from './merge-request-tool.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const BINDING_TOKEN = 'fake-binding-token-000000000000000000000001';
const RUN_SECRET = 'fake-run-secret-0000000000000000000000000002';
const BOT: ExternalIdentity = {
  provider: 'fake-git',
  external_id: 'agentic-bot',
  email: null,
  display_name: 'agentic-bot',
  verified: true,
};

/** A provider with one rule: one open merge request per source branch. */
const createGitDouble = () => {
  const drafts: MergeRequestDraft[] = [];
  const updates: MergeRequestUpdate[] = [];
  const open: MergeRequest[] = [];
  let nextIid = 7;
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({}),
    openMergeRequest: async (draft: MergeRequestDraft) => {
      drafts.push(draft);
      if (open.some((mr) => mr.source_branch === draft.branch)) {
        throw new IntegrationError('conflict', 'fake-git', 'another open merge request exists');
      }
      const iid = nextIid;
      nextIid += 1;
      const mr = mergeRequestOf(iid, draft.branch, draft.target, BOT);
      open.push(mr);
      return { ...mr, draft: draft.draft, title: draft.title, description: draft.description };
    },
    findOpenMergeRequest: async (_project: string, branch: string) =>
      open.find((mr) => mr.source_branch === branch) ?? null,
    authenticatedUser: async () => BOT,
    updateMergeRequest: async (ref: { readonly iid: number }, update: MergeRequestUpdate) => {
      updates.push(update);
      const mr = open.find((candidate) => candidate.ref.iid === ref.iid);
      if (mr === undefined) {
        throw new IntegrationError('not_found', 'fake-git', `no merge request !${ref.iid}`);
      }
      return { ...mr, description: update.description ?? mr.description };
    },
  } as unknown as GitProviderPort;
  return { port, drafts, updates, open };
};

const mergeRequestOf = (
  iid: number,
  branch: string,
  target: string,
  author: ExternalIdentity,
): MergeRequest => ({
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid,
    url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
    branch,
    head_sha: 'b'.repeat(40),
  },
  state: 'opened',
  draft: true,
  title: 'Draft: x',
  description: '',
  source_branch: branch,
  target_branch: target,
  head_sha: 'b'.repeat(40),
  labels: [],
  reviewers: [],
  author,
  web_url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
});

const storedTask = (overrides: Partial<StoredTask> & { mode?: 'normal' | 'shadow' } = {}) => {
  const { mode, ...rest } = overrides;
  return {
    task: {
      id: TASK,
      projectId: PROJECT,
      ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
      template: 'feature',
      mode: mode ?? 'normal',
      state: 'active',
      currentStage: 'implementation',
      stageAttempts: { implementation: 1 },
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
    branch: null,
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
    ciHeadSha: null,
    ciExcusedPaths: [],
    requestedByUserId: null,
    pipelineDial: null,
    ticketSnapshotAt: null,
    ticketSignalAt: null,
    version: 1,
    ...rest,
  } as unknown as StoredTask;
};

/** One world: a task, a project on `develop`, a git double, an executor, the tools. */
const world = async (
  options: {
    readonly task?: Partial<StoredTask> & { mode?: 'normal' | 'shadow' };
    readonly git?: ReturnType<typeof createGitDouble>;
    readonly requestedBy?: string | null;
  } = {},
) => {
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  await memory.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, storedTask(options.task));
  });
  const git = options.git ?? createGitDouble();
  const auditLog = createMemoryAuditLog();
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog,
    // The production executor has one (`integration_idempotency`); a world without it replays nothing.
    idempotencyStore: createMemoryIdempotencyStore(),
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
  });
  const tools = createMergeRequestTools({
    unitOfWork: memory,
    reader: {
      read: async (tx, taskId) => {
        const loaded = await store.tasks.load(tx, taskId);
        if (loaded === null) {
          return null;
        }
        const view: MergeRequestToolTask = {
          taskId: loaded.task.id,
          projectId: loaded.task.projectId,
          mode: loaded.task.mode,
          ticketKey: loaded.task.ticket.key,
          branch: loaded.branch,
          mr: loaded.mr,
          defaultBranch: 'develop',
          requestedBy: options.requestedBy === undefined ? 'Dana Reviewer' : options.requestedBy,
        };
        return view;
      },
    },
    tasks: store.tasks,
    integrations: staticPipelineIntegrations({
      executor,
      git: {
        port: git.port,
        ref: git.port.ref,
        project: 'acme/api',
        redactor: exactSecretRedactor([{ name: 'fake_git_token', value: BINDING_TOKEN }]),
      },
      taskManagement: null,
      communication: null,
    }),
    runScopedSecrets: () => [],
  });
  const recorded = async (): Promise<MergeRequestRef | null> =>
    memory.transaction(async (scope) => (await store.tasks.load(scope.tx, TASK))?.mr ?? null);
  return { tools, git, auditLog, recorded, memory, store };
};

const CONTEXT = {
  taskId: TASK,
  projectId: PROJECT,
  redactor: exactSecretRedactor([{ name: 'run_secret', value: RUN_SECRET }]),
};

describe('open_mr (WP-138)', () => {
  it("opens from the task's own branch into the project's default branch, whatever the model named", async () => {
    const { tools, git, recorded } = await world();
    const answer = await tools.open({ title: 'Sum the footer', description: 'Adds it.' }, CONTEXT);

    expect(git.drafts).toHaveLength(1);
    expect(git.drafts[0]).toMatchObject({
      branch: 'agentic/ACME-1',
      target: 'develop',
      draft: true,
    });
    expect(answer).toMatchObject({
      status: 'opened',
      iid: 7,
      source_branch: 'agentic/ACME-1',
      target_branch: 'develop',
    });
    expect(await recorded()).toMatchObject({ iid: 7, branch: 'agentic/ACME-1' });
  });

  it('opens one merge request for two calls, and adopts it after a lost idempotency record', async () => {
    const first = await world();
    await first.tools.open({ title: 'One', description: 'a' }, CONTEXT);
    await first.tools.open({ title: 'One again', description: 'b' }, CONTEXT);
    // The executor replayed the second call: the provider saw one create.
    expect(first.git.drafts).toHaveLength(1);

    // A resumed run in a process whose executor never saw the first call (a crash): the provider
    // refuses the duplicate, and the platform adopts its own merge request.
    const resumed = await world({
      git: first.git,
      task: { mr: await first.recorded(), branch: null },
    });
    const answer = await resumed.tools.open({ title: 'One more', description: 'c' }, CONTEXT);

    expect(answer).toMatchObject({ status: 'adopted', iid: 7 });
    expect(first.git.open).toHaveLength(1);
    expect(await resumed.recorded()).toMatchObject({ iid: 7 });
  });

  it("refuses by name to adopt a person's merge request on the task's branch, and records nothing", async () => {
    const git = createGitDouble();
    git.open.push(mergeRequestOf(41, 'agentic/ACME-1', 'develop', { ...BOT, external_id: 'dana' }));
    const { tools, recorded } = await world({ git });
    await expect(tools.open({ title: 'x', description: 'y' }, CONTEXT)).rejects.toThrow(
      MergeRequestNotAdoptedError,
    );
    expect(await recorded()).toBeNull();
  });

  it('refuses to adopt one of its own merge requests that targets another branch', async () => {
    const git = createGitDouble();
    git.open.push(mergeRequestOf(42, 'agentic/ACME-1', 'main', BOT));
    const { tools, recorded } = await world({ git });
    await expect(tools.open({ title: 'x', description: 'y' }, CONTEXT)).rejects.toThrow(
      'targets another branch',
    );
    expect(await recorded()).toBeNull();
  });

  it('records would_have for a shadow task, calls no provider and writes no mr_ref', async () => {
    const { tools, git, auditLog, recorded } = await world({ task: { mode: 'shadow' } });
    const answer = await tools.open({ title: 'x', description: 'y' }, CONTEXT);

    expect(answer).toMatchObject({ status: 'shadow' });
    expect(git.drafts).toEqual([]);
    expect(auditLog.entriesFor('open_merge_request').map((entry) => entry.status)).toEqual([
      'would_have',
    ]);
    expect(await recorded()).toBeNull();
  });

  it('keeps a planted secret out of the provider request and the audit row', async () => {
    const { tools, git, auditLog } = await world();
    await tools.open(
      {
        title: `Fix ${RUN_SECRET}`,
        description: `token ${BINDING_TOKEN} and ${RUN_SECRET}`,
      },
      CONTEXT,
    );
    const sent = JSON.stringify(git.drafts);
    expect(sent).not.toContain(RUN_SECRET);
    expect(sent).not.toContain(BINDING_TOKEN);
    const audited = JSON.stringify(auditLog.entries);
    expect(audited).not.toContain(RUN_SECRET);
    expect(audited).not.toContain(BINDING_TOKEN);
  });

  it('bounds the title and the description, announces the cut, and appends the Requested-by footer', async () => {
    const { tools, git } = await world();
    await tools.open(
      {
        title: `${'t'.repeat(400)}\nsecond line`,
        description: 'd'.repeat(MAX_MERGE_REQUEST_DESCRIPTION_CHARS + 10),
      },
      CONTEXT,
    );
    const draft = git.drafts[0] as MergeRequestDraft;
    // A draft: the provider's `Draft: ` prefix must still fit the provider's bound (review round 1).
    expect(`Draft: ${draft.title}`.length).toBeLessThanOrEqual(MAX_MERGE_REQUEST_TITLE_CHARS);
    expect(draft.title.length).toBeGreaterThan(MAX_MERGE_REQUEST_TITLE_CHARS - 10);
    expect(draft.title).not.toContain('\n');
    expect(draft.description.length).toBeLessThanOrEqual(MAX_MERGE_REQUEST_DESCRIPTION_CHARS);
    expect(draft.description).toContain('The platform cut this description');
    expect(draft.description.endsWith('ACME-1. Requested by Dana Reviewer.')).toBe(true);
  });

  it('refuses a task branch outside agentic/, and a call without the run redactor', async () => {
    const outside = await world({ task: { branch: 'feature/x' } });
    await expect(outside.tools.open({ title: 'x', description: 'y' }, CONTEXT)).rejects.toThrow(
      'agentic/',
    );
    expect(outside.git.drafts).toEqual([]);

    const bare = await world();
    await expect(
      bare.tools.open({ title: 'x', description: 'y' }, { taskId: TASK, projectId: PROJECT }),
    ).rejects.toThrow(MergeRequestToolRefusedError);
    expect(bare.git.drafts).toEqual([]);
  });
});

describe('a provider refusal of the open (review round 1)', () => {
  it('names both branches and the provider’s words, and does not guess the cause', async () => {
    const git = createGitDouble();
    (git.port as { openMergeRequest: unknown }).openMergeRequest = async () => {
      throw new IntegrationError('invalid_request', 'fake-git', 'Title is too long');
    };
    const { tools } = await world({ git });
    const refused = (await tools
      .open({ title: 'x', description: 'y' }, CONTEXT)
      .catch((error: unknown) => error)) as Error;
    expect(refused).toBeInstanceOf(MergeRequestToolRefusedError);
    expect(refused.message).toContain('Title is too long');
    expect(refused.message).toContain('agentic/ACME-1 into develop');
    expect(refused.message).not.toMatch(/push your commits/i);
  });
});

describe('update_mr_description (WP-138)', () => {
  it("replaces only the task's own merge request's description, once per text", async () => {
    const { tools, git } = await world();
    await tools.open({ title: 'x', description: 'first' }, CONTEXT);
    await tools.updateDescription({ description: 'second' }, CONTEXT);
    await tools.updateDescription({ description: 'second' }, CONTEXT);

    expect(git.updates).toHaveLength(1);
    expect(git.updates[0]?.description).toContain('second');
    expect(git.updates[0]).toMatchObject({ title: null, draft: null, reviewers: null });
  });

  it('refuses when the task has no merge request yet, naming open_mr', async () => {
    const { tools, git } = await world();
    await expect(tools.updateDescription({ description: 'x' }, CONTEXT)).rejects.toThrow(
      'call open_mr first',
    );
    expect(git.updates).toEqual([]);
  });
});
