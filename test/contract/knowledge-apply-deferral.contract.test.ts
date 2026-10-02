/**
 * **Two approved proposals for one page become one knowledge merge request, then an `update`** —
 * WP-125 criterion 3, PROGRESS backlog **369**, over the fake git provider (contract tier: this ring
 * may import `@platform/integrations`, the application unit tier may not).
 *
 * WP-109's probe measured the defect on this fake: an approved, unmerged discovery draft and a newer
 * approved draft of the same page gave two passes, two branches and two merge requests, **both**
 * `create`, each cut from a default branch without the file — an add/add conflict on a real provider
 * once the first merges. The ruling is deferral, never stacking: the second proposal waits, with a
 * reason naming the open merge request, and is applied as an `update` after that one merges.
 *
 * The fake has no merge (its divergence 9), so a merge is modelled as the three things the platform
 * would see: the provider's merge request reads `merged` (`emitMergeRequestEvent`), the default
 * branch carries the file (`seedFile`), and the index — which the platform rebuilds after a merge —
 * holds the page. The pass is driven directly, as the handler's self re-enqueue would drive it.
 *
 * The canary (recorded in PROGRESS under WP-125): with `planBatch`'s open-merge-request check in
 * `packages/application/src/knowledge/apply.ts` disarmed, the second pass opens a second merge
 * request that `create`s the same file, and the first case fails on the count of merge requests.
 */
import {
  applyKnowledgeProposals,
  exactSecretRedactor,
  type KnowledgeApplyOptions,
  MemoryEventing,
  memoryProposalStore,
  memoryTransaction,
  type PipelineIntegrations,
  type StoredKnowledgeProposal,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import {
  createFakeGitProvider,
  FAKE_GIT_PROVIDER_ID,
  type FakeGitProvider,
} from '@platform/integrations';
import { describe, expect, it } from 'vitest';

const PROJECT = '00000000-0000-4000-8000-0000000012d1' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000012d2' as Id;
const TASK = '00000000-0000-4000-8000-0000000012d3' as Id;
const REPO = 'acme/api';
const PAGE = '.agentic/knowledge/technical/overview.md';
const OTHER_PAGE = '.agentic/knowledge/technical/billing.md';
const AT = '2026-09-13T08:00:00.000Z' as StoredKnowledgeProposal['createdAt'];

/** Each proposal's id starts differently: a batch's branch is named from its earliest id's first eight. */
const approved = (id: string, path: string, delta: string): StoredKnowledgeProposal => ({
  id: id as Id,
  projectId: PROJECT,
  taskId: TASK,
  runId: null,
  source: 'bootstrap',
  kind: 'technical',
  type: 'doc-update',
  targetPath: path,
  delta,
  evidence: [],
  significance: 0.5,
  status: 'queued',
  decidedByUserId: '00000000-0000-4000-8000-0000000012d4' as Id,
  decidedAt: AT,
  appliedCommitSha: null,
  createdAt: AT,
});

interface Recorded {
  readonly actions: { readonly branch: string; readonly action: string; readonly path: string }[];
  readonly mergeRequests: number[];
}

const harness = async () => {
  const fake: FakeGitProvider = createFakeGitProvider({
    integrationId: INTEGRATION,
    projects: [{ path: REPO, defaultBranch: 'main' }],
  });
  const recorded: Recorded = { actions: [], mergeRequests: [] };
  // The fake's own port, observed: which actions each commit carried and which merge requests it
  // opened.
  const port = {
    ...fake,
    commitFiles: async (request: Parameters<FakeGitProvider['commitFiles']>[0]) => {
      for (const action of request.actions) {
        recorded.actions.push({ branch: request.branch, action: action.action, path: action.path });
      }
      return fake.commitFiles(request);
    },
    openMergeRequest: async (draft: Parameters<FakeGitProvider['openMergeRequest']>[0]) => {
      const opened = await fake.openMergeRequest(draft);
      recorded.mergeRequests.push(opened.ref.iid);
      return opened;
    },
  } as FakeGitProvider;
  const integrations: PipelineIntegrations = {
    executor: {
      execute: async (request: { perform: () => Promise<unknown> }) => ({
        status: 'ok' as const,
        result: await request.perform(),
      }),
    } as unknown as PipelineIntegrations['executor'],
    git: {
      port,
      ref: {
        integrationId: INTEGRATION,
        provider: FAKE_GIT_PROVIDER_ID,
        type: 'git',
        host: null,
      },
      project: REPO,
      redactor: exactSecretRedactor([]),
    },
    taskManagement: null,
    communication: null,
  };
  const eventing = new MemoryEventing();
  const proposals = memoryProposalStore();
  const indexed = new Map<string, string>();
  const applyOptions: KnowledgeApplyOptions = {
    unitOfWork: eventing,
    eventStore: eventing.store,
    proposals,
    knowledge: {
      readIndexedBlobs: async () => new Map(indexed),
    } as unknown as KnowledgeApplyOptions['knowledge'],
    integrations: staticPipelineIntegrations(integrations),
    jobs: {} as KnowledgeApplyOptions['jobs'],
    clock: fixedClock(AT),
    ids: sequentialIds(900),
    project: async () => ({ knowledgeDir: '.agentic/knowledge', defaultBranch: 'main' }),
    ticketKeys: async () => new Map([[TASK, 'ACME-12']]),
    logger: silentLogger,
  };
  const pass = () =>
    applyKnowledgeProposals(applyOptions, { project_id: PROJECT, reason: 'decision' });
  /** The merge, as the platform sees it: the provider says merged, main has it, the index holds it. */
  const merge = (iid: number, path: string, content: string): void => {
    fake.emitMergeRequestEvent({ event: 'mr.merged', project: REPO, iid });
    fake.seedFile({ project: REPO, branch: 'main', path, content });
    indexed.set(path, 'blob');
  };
  return { fake, recorded, proposals, pass, merge };
};

describe('two approved proposals for one page (backlog 369)', () => {
  it('gives one merge request, defers the second with a reason naming it, and updates the page once it merges', async () => {
    const built = await harness();
    const older = approved('a1000000-0000-4000-8000-0000000012a1', PAGE, '# overview v1\n');
    const newer = approved('a2000000-0000-4000-8000-0000000012a2', PAGE, '# overview v2\n');
    await built.proposals.insert(memoryTransaction, [older, newer]);

    // Pass 1: one action per path — the older one is created, the newer one is left for later.
    const first = await built.pass();
    expect(first).toMatchObject({ status: 'applied', applied: 1, remaining: 1, deferred: 0 });
    expect(built.recorded.mergeRequests).toHaveLength(1);
    const iid = built.recorded.mergeRequests[0] as number;
    const carried = await built.proposals.load(PROJECT, older.id);
    // Criterion 1's answer, now recorded: which merge request carries the page.
    expect(carried?.appliedMergeRequest?.iid).toBe(iid);

    // Pass 2 (the handler's re-enqueue): the page is on an open merge request, so the newer
    // proposal waits — no second branch, no second merge request, no `create`.
    const second = await built.pass();
    expect(second).toMatchObject({ status: 'nothing_to_apply', applied: 0, deferred: 1 });
    expect(built.recorded.mergeRequests).toHaveLength(1);
    const waiting = await built.proposals.load(PROJECT, newer.id);
    expect(waiting?.status).toBe('queued');
    expect(waiting?.applyDeferredReason).toContain(`knowledge merge request !${String(iid)}`);
    expect(waiting?.applyDeferredReason).toContain(PAGE);

    // The first merges; the next pass applies the newer page as an update on a branch of its own.
    built.merge(iid, PAGE, '# overview v1\n');
    const third = await built.pass();
    expect(third).toMatchObject({ status: 'applied', applied: 1, deferred: 0 });
    expect(built.recorded.mergeRequests).toHaveLength(2);
    expect(built.recorded.actions.map(({ action, path }) => ({ action, path }))).toEqual([
      { action: 'create', path: PAGE },
      { action: 'update', path: PAGE },
    ]);
    const landed = await built.proposals.load(PROJECT, newer.id);
    expect(landed?.status).toBe('applied');
    expect(landed?.applyDeferredReason).toBeUndefined();
    const branches = new Set(built.recorded.actions.map((entry) => entry.branch));
    expect(branches.size).toBe(2);
    expect(built.fake.fileAt(REPO, [...branches][1] as string, PAGE)).toBe('# overview v2\n');
  });

  it('holds back only the waiting page: another page in the same pass is still committed', async () => {
    const built = await harness();
    await built.proposals.insert(memoryTransaction, [
      approved('b1000000-0000-4000-8000-0000000012b1', PAGE, '# v1\n'),
    ]);
    await built.pass();
    await built.proposals.insert(memoryTransaction, [
      approved('b2000000-0000-4000-8000-0000000012b2', PAGE, '# v2\n'),
      approved('b3000000-0000-4000-8000-0000000012b3', OTHER_PAGE, '# billing\n'),
    ]);
    const report = await built.pass();
    expect(report).toMatchObject({ status: 'applied', applied: 1, deferred: 1, remaining: 0 });
    expect(built.recorded.actions.at(-1)).toMatchObject({ action: 'create', path: OTHER_PAGE });
  });

  it('creates the page when the earlier merge request was closed without merging (the other side)', async () => {
    const built = await harness();
    await built.proposals.insert(memoryTransaction, [
      approved('c1000000-0000-4000-8000-0000000012c1', PAGE, '# v1\n'),
    ]);
    await built.pass();
    const iid = built.recorded.mergeRequests[0] as number;
    built.fake.emitMergeRequestEvent({ event: 'mr.closed', project: REPO, iid });
    await built.proposals.insert(memoryTransaction, [
      approved('c2000000-0000-4000-8000-0000000012c2', PAGE, '# v2\n'),
    ]);
    const report = await built.pass();
    expect(report).toMatchObject({ status: 'applied', applied: 1, deferred: 0 });
    expect(built.recorded.actions.at(-1)).toMatchObject({ action: 'create', path: PAGE });
  });
});
