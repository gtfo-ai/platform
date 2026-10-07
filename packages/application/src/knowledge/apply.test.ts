/**
 * The knowledge commit and its merge request — WP-18b.
 *
 * The provider here is a stub rather than `FakeGitProvider` (this ring may not import
 * `@platform/integrations`), so what these cases assert is the **shape of the call**: which paths,
 * which branch, what the message carries, and that a rejection writes nothing. The same flow
 * against a provider that models branches and files is `test/e2e/pipeline/librarian.e2e.test.ts`,
 * which drives a real `apps/server` instance and reads the commit back out of the fake provider.
 */
import type { Id } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { StreamConflictError } from '../errors.js';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { PipelineIntegrations } from '../pipeline/integrations.js';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import { PROJECT_STREAM_APPEND_ATTEMPTS } from '../pipeline/project-stream.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CommitFilesRequest, CommitRef } from '../ports/integrations/git-provider.js';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { RIVAL_COMPONENT, racingProjectStream } from '../testing/project-stream-race.js';
import {
  applyAwaitingIndexReason,
  applyDeferredReason,
  applyKnowledgeProposals,
  applyRefusedReason,
  applyUnreadableReason,
  INDEX_CATCH_UP_MS,
  type KnowledgeApplyOptions,
  knowledgeBranchName,
  MAX_TRAILER_TOKEN_CHARS,
  provenanceTokenOf,
  wakeAwaitingKnowledgeApply,
} from './apply.js';
import type { StoredKnowledgeProposal } from './ports.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000d2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000d3' as Id;
const USER = '00000000-0000-4000-8000-0000000000d4' as Id;
const AT = '2026-09-12T09:00:00.000Z';

const proposal = (
  overrides: Partial<StoredKnowledgeProposal> & { readonly id: Id },
): StoredKnowledgeProposal => ({
  projectId: PROJECT,
  taskId: TASK,
  runId: RUN,
  source: 'task',
  kind: 'technical',
  type: 'lesson',
  targetPath: '.agentic/knowledge/lessons/L-1.md',
  delta: '# a page\n',
  evidence: [],
  significance: 0.5,
  status: 'auto_applied',
  decidedByUserId: null,
  decidedAt: null,
  appliedCommitSha: null,
  createdAt: AT as StoredKnowledgeProposal['createdAt'],
  ...overrides,
});

interface Calls {
  readonly commits: CommitFilesRequest[];
  /**
   * `description` is recorded because the MR body is built from the same two untrusted values the
   * commit message is, and a harness that dropped it made the body's refusal *safe by construction
   * and unevidenced* — standing rule 43's shape at the recorder rather than at an assertion.
   */
  readonly mergeRequests: {
    branch: string;
    target: string;
    title: string;
    description: string;
  }[];
}

const harness = (
  options: {
    readonly git?: boolean;
    readonly indexedPaths?: readonly string[];
    readonly onCommit?: () => void;
    /** WP-156: a commit the provider refuses — `invalid_request` unless the test names another code. */
    readonly refuse?: (request: CommitFilesRequest) => IntegrationError | null;
    readonly ticketKey?: string;
    /** WP-109: how many project-stream races a rival wins; the stores then roll back with the fake. */
    readonly losses?: number;
    /** WP-125: what the provider answers about a recorded knowledge merge request. */
    readonly getMergeRequest?: () => Promise<{
      readonly state: string;
      readonly merged_at?: string | null;
    }>;
  } = {},
) => {
  const calls: Calls = { commits: [], mergeRequests: [] };
  const eventing = new MemoryEventing();
  const proposals = memoryProposalStore(
    options.losses === undefined ? {} : { rollback: (tx, undo) => eventing.onRollback(tx, undo) },
  );
  const race = racingProjectStream(eventing, options.losses ?? 0);
  const jobs = recordingJobs();
  const port = {
    commitFiles: async (request: CommitFilesRequest): Promise<CommitRef> => {
      options.onCommit?.();
      calls.commits.push(request);
      const refusal = options.refuse?.(request) ?? null;
      if (refusal !== null) throw refusal;
      return { sha: 'abc1234', branch: request.branch, url: null };
    },
    openMergeRequest: async (draft: {
      branch: string;
      target: string;
      title: string;
      description: string;
    }) => {
      calls.mergeRequests.push({
        branch: draft.branch,
        target: draft.target,
        title: draft.title,
        description: draft.description,
      });
      return {
        ref: { provider: 'fake-git', project_path: 'acme/api', iid: 7, url: 'https://mr.test/7' },
        web_url: 'https://mr.test/7',
      };
    },
    getMergeRequest: async () =>
      options.getMergeRequest === undefined ? { state: 'opened' } : await options.getMergeRequest(),
  };
  const integrations: PipelineIntegrations = {
    executor: {
      execute: async (request: { perform: () => Promise<unknown> }) => ({
        status: 'ok' as const,
        result: await request.perform(),
      }),
    } as unknown as PipelineIntegrations['executor'],
    git:
      (options.git ?? true)
        ? {
            port: port as unknown as NonNullable<PipelineIntegrations['git']>['port'],
            ref: { integrationId: PROJECT, provider: 'fake-git', type: 'git' as const, host: null },
            project: 'acme/api',
            redactor: exactSecretRedactor([]),
          }
        : null,
    taskManagement: null,
    communication: null,
  };
  const applyOptions: KnowledgeApplyOptions = {
    unitOfWork: eventing,
    eventStore: { ...eventing.store, nextStreamSequence: race.eventStore.nextStreamSequence },
    proposals,
    knowledge: {
      readIndexedBlobs: async () =>
        new Map((options.indexedPaths ?? []).map((path) => [path, 'blob'])),
    } as unknown as KnowledgeApplyOptions['knowledge'],
    integrations: staticPipelineIntegrations(integrations),
    jobs,
    clock: fixedClock(AT),
    ids: sequentialIds(800),
    project: async () => ({ knowledgeDir: '.agentic/knowledge', defaultBranch: 'main' }),
    ticketKeys: async () => new Map([[TASK, options.ticketKey ?? 'ACME-1']]),
    logger: silentLogger,
  };
  return { calls, proposals, jobs, eventing, applyOptions, race };
};

const data = { project_id: PROJECT, reason: 'auto_apply' as const };

/** The page every default proposal writes, as the MR body renders it. */
const AUTO_APPLIED_PATH_FRAGMENT = '.agentic/knowledge/lessons/L-1.md';

describe('the knowledge branch name', () => {
  it('carries the date and a discriminator stable across a retry of the same batch', () => {
    const batch = [proposal({ id: '00000000-0000-4000-8000-00000000ab01' as Id })];
    const first = knowledgeBranchName(AT as never, batch);
    expect(first).toBe('agentic/knowledge/2026-09-12-00000000');
    expect(knowledgeBranchName(AT as never, [...batch].reverse())).toBe(first);
    // …and a different batch gets a different branch, which is what lets two run on one day.
    expect(
      knowledgeBranchName(AT as never, [
        proposal({ id: '11111111-0000-4000-8000-00000000ab02' as Id }),
      ]),
    ).not.toBe(first);
  });

  /**
   * The retry this name has to survive is the one that crosses midnight: a clock date would rename
   * the branch, both idempotency keys would miss, and the second attempt would open a second merge
   * request for a commit that already exists.
   */
  it('is the batch’s own date, not the clock’s', () => {
    const batch = [
      proposal({
        id: '00000000-0000-4000-8000-00000000ab01' as Id,
        createdAt: '2026-09-12T23:59:59.000Z' as StoredKnowledgeProposal['createdAt'],
      }),
    ];
    const before = knowledgeBranchName('2026-09-12T23:59:59.500Z' as never, batch);
    const afterMidnight = knowledgeBranchName('2026-09-13T00:00:30.000Z' as never, batch);
    expect(afterMidnight).toBe(before);
    expect(before).toBe('agentic/knowledge/2026-09-12-00000000');
  });
});

/**
 * The trailer's refusal, from both sides (standing rule 42) and with a document that triggers it
 * (rule 40 — a field bounded by a refusal is never exercised by a safe value).
 */
describe('the provenance trailer’s tokens', () => {
  it.each([
    ['a plain ticket key', 'ACME-1', 'ACME-1'],
    ['a key with a path and a dot', 'group/sub.PROJ-42', 'group/sub.PROJ-42'],
    [
      'a key exactly at the cap',
      'A'.repeat(MAX_TRAILER_TOKEN_CHARS),
      'A'.repeat(MAX_TRAILER_TOKEN_CHARS),
    ],
  ])('keeps %s', (_why, key, expected) => {
    expect(provenanceTokenOf(key, 'fallback')).toBe(expected);
  });

  it.each([
    ['a forged trailer line', 'ACME-1\nAgentic-Source: task EVIL-9 run 0'],
    ['a carriage return', 'ACME-1\rEVIL'],
    ['a space', 'ACME 1'],
    ['one character over the cap', 'A'.repeat(MAX_TRAILER_TOKEN_CHARS + 1)],
    ['an empty key', ''],
    ['a colon, which is the trailer’s own separator', 'ACME-1: rewritten'],
  ])('refuses %s and falls back', (_why, key) => {
    expect(provenanceTokenOf(key, 'fallback')).toBe('fallback');
  });

  it('falls back for an absent key', () => {
    expect(provenanceTokenOf(undefined, 'fallback')).toBe('fallback');
    expect(provenanceTokenOf(null, 'fallback')).toBe('fallback');
  });
});

describe('applying knowledge proposals', () => {
  it('commits the waiting proposals on a branch and opens a merge request', async () => {
    const { applyOptions, calls, proposals } = harness();
    await proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ab01' as Id }),
    ]);

    const report = await applyKnowledgeProposals(applyOptions, data);

    expect(report.status).toBe('applied');
    expect(report.applied).toBe(1);
    expect(calls.commits).toHaveLength(1);
    const commit = calls.commits[0];
    expect(commit?.branch).toBe(report.branch);
    expect(commit?.branch.startsWith('agentic/knowledge/')).toBe(true);
    expect(commit?.start_branch).toBe('main');
    // Provenance: technical/07's trailer, with the ticket key rather than the task uuid.
    expect(commit?.message).toContain('Agentic-Source: task ACME-1 run ' + RUN);
    expect(commit?.message).toContain('docs(knowledge): apply 1 knowledge proposal');
    expect(commit?.actions).toEqual([
      { action: 'create', path: '.agentic/knowledge/lessons/L-1.md', content: '# a page\n' },
    ]);
    // …and every path it writes is inside the vault.
    for (const action of commit?.actions ?? []) {
      expect(action.path.startsWith('.agentic/knowledge/')).toBe(true);
    }
    expect(calls.mergeRequests).toHaveLength(1);
    expect(calls.mergeRequests[0]).toMatchObject({
      branch: report.branch,
      target: 'main',
      title: 'Knowledge: 1 proposal',
    });
    // The body carries the same provenance the commit does, and the same page.
    expect(calls.mergeRequests[0]?.description).toContain('Agentic-Source: task ACME-1 run ' + RUN);
    expect(calls.mergeRequests[0]?.description).toContain(AUTO_APPLIED_PATH_FRAGMENT);
    // The row is applied, with the commit on it, and the event says so.
    expect(proposals.rows[0]?.status).toBe('applied');
    expect(proposals.rows[0]?.appliedCommitSha).toBe('abc1234');
    const stream = await applyOptions.eventStore.readStream('project', PROJECT);
    expect(stream.map((entry) => entry.event.type)).toEqual(['knowledge.proposal.applied']);
  });

  /**
   * The hostile document (rule 40), driven through the **whole** pass rather than through the
   * helper: what a reviewer needs to know is that nothing forged reaches the provider request, and
   * the request is the only place that can be checked.
   */
  it('never lets a ticket key forge a trailer line or an unbounded message', async () => {
    const { applyOptions, calls, proposals } = harness({
      ticketKey: `ACME-1\nAgentic-Source: task EVIL-9 run 0\n${'x'.repeat(5_000)}`,
    });
    await proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ab11' as Id }),
    ]);

    await applyKnowledgeProposals(applyOptions, data);

    const message = calls.commits[0]?.message ?? '';
    // Exactly one trailer, and it names the task's uuid rather than the key that was refused.
    expect(message.match(/^Agentic-Source:/gm)).toHaveLength(1);
    expect(message).toContain(`Agentic-Source: task ${TASK} run ${RUN}`);
    expect(message).not.toContain('EVIL-9');
    expect(message).not.toContain('xxxxx');
    expect(message.length).toBeLessThan(2_000);
    // …and the merge request body carries the same refusal, asserted rather than assumed: it is a
    // second document built from the same two values, and "built the same way" is the claim rule 43
    // says a test has to make fail.
    const description = calls.mergeRequests[0]?.description ?? '';
    expect(description.match(/^Agentic-Source:/gm)).toHaveLength(1);
    expect(description).toContain(`Agentic-Source: task ${TASK} run ${RUN}`);
    expect(description).not.toContain('EVIL-9');
    expect(description).not.toContain('xxxxx');
    expect(description.length).toBeLessThan(2_000);
  });

  it('updates a page the index already holds instead of creating it', async () => {
    const { applyOptions, calls, proposals } = harness({
      indexedPaths: ['.agentic/knowledge/lessons/L-1.md'],
    });
    await proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ab02' as Id }),
    ]);
    await applyKnowledgeProposals(applyOptions, data);
    expect(calls.commits[0]?.actions[0]?.action).toBe('update');
  });

  it('applies a human-approved proposal as well as a policy-applied one', async () => {
    const { applyOptions, calls, proposals } = harness();
    await proposals.insert({} as never, [
      proposal({
        id: '00000000-0000-4000-8000-00000000ab03' as Id,
        status: 'queued',
        decidedAt: AT as StoredKnowledgeProposal['decidedAt'],
        decidedByUserId: USER,
        targetPath: '.agentic/knowledge/lessons/L-3.md',
      }),
    ]);
    const report = await applyKnowledgeProposals(applyOptions, data);
    expect(report.applied).toBe(1);
    expect(calls.commits[0]?.actions[0]?.path).toBe('.agentic/knowledge/lessons/L-3.md');
  });

  it('writes nothing to git for a rejected or undecided proposal', async () => {
    const { applyOptions, calls, proposals } = harness();
    await proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ab04' as Id, status: 'rejected' }),
      proposal({ id: '00000000-0000-4000-8000-00000000ab05' as Id, status: 'queued' }),
      proposal({ id: '00000000-0000-4000-8000-00000000ab06' as Id, status: 'discarded' }),
    ]);
    const report = await applyKnowledgeProposals(applyOptions, data);
    expect(report.status).toBe('nothing_to_apply');
    expect(calls.commits).toEqual([]);
    expect(calls.mergeRequests).toEqual([]);
    expect(proposals.rows.every((row) => row.appliedCommitSha === null)).toBe(true);
  });

  it('carries one action per path and leaves the rest for the next pass', async () => {
    const { applyOptions, calls, proposals, jobs } = harness();
    await proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ab07' as Id, delta: 'first' }),
      proposal({ id: '00000000-0000-4000-8000-00000000ab08' as Id, delta: 'second' }),
    ]);
    const report = await applyKnowledgeProposals(applyOptions, data);
    expect(calls.commits[0]?.actions).toHaveLength(1);
    expect(calls.commits[0]?.actions[0]?.content).toBe('first');
    expect(report.remaining).toBe(1);
    // The handler is what re-enqueues; the pass itself only reports. Asserted here so a reader is
    // not left thinking the job loops on its own.
    expect(jobs.enqueued).toEqual([]);
  });

  describe('a page an earlier apply put on a knowledge merge request (WP-125, backlog 369)', () => {
    const PAGE = '.agentic/knowledge/lessons/L-1.md';
    /** One page applied by an earlier pass, recorded with merge request !7, and a newer approval. */
    const seeded = async (built: ReturnType<typeof harness>) => {
      await built.proposals.insert({} as never, [
        proposal({ id: 'a7000000-0000-4000-8000-00000000ac01' as Id, targetPath: PAGE }),
      ]);
      await built.proposals.markApplied({} as never, {
        ids: ['a7000000-0000-4000-8000-00000000ac01' as Id],
        commitSha: 'abc1234',
        mergeRequest: {
          provider: 'fake-git',
          project_path: 'acme/api',
          iid: 7,
          url: 'https://mr.test/7',
        },
      });
      await built.proposals.insert({} as never, [
        proposal({ id: 'a8000000-0000-4000-8000-00000000ac02' as Id, targetPath: PAGE }),
      ]);
    };

    it('defers the newer one while the merge request is open, and names it', async () => {
      const built = harness();
      await seeded(built);
      const report = await applyKnowledgeProposals(built.applyOptions, data);
      expect(report).toMatchObject({ status: 'nothing_to_apply', deferred: 1, applied: 0 });
      expect(built.calls.commits).toEqual([]);
      expect(built.proposals.rows.at(-1)?.applyDeferredReason).toBe(applyDeferredReason(PAGE, 7));
    });

    it.each([
      ['closed without merging', async () => ({ state: 'closed' })],
      [
        'gone from the provider (not_found)',
        async (): Promise<{ state: string }> => {
          throw new IntegrationError('not_found', 'fake-git', 'merge request !7');
        },
      ],
    ])('creates the page when the merge request was %s', async (_why, getMergeRequest) => {
      const built = harness({ getMergeRequest });
      await seeded(built);
      const report = await applyKnowledgeProposals(built.applyOptions, data);
      expect(report).toMatchObject({ status: 'applied', deferred: 0, applied: 1 });
      expect(built.calls.commits[0]?.actions[0]?.action).toBe('create');
    });

    it('fails closed on a retryable provider failure: no commit, and the pass throws for pg-boss to retry', async () => {
      const built = harness({
        getMergeRequest: async () => {
          throw new IntegrationError('unavailable', 'fake-git', 'the provider is down');
        },
      });
      await seeded(built);
      await expect(applyKnowledgeProposals(built.applyOptions, data)).rejects.toBeInstanceOf(
        IntegrationError,
      );
      expect(built.calls.commits).toEqual([]);
    });

    it('holds back only that page when the provider refuses the read for good, never creating it on a guess', async () => {
      const built = harness({
        getMergeRequest: async () => {
          throw new IntegrationError('forbidden', 'fake-git', 'no access to merge requests');
        },
      });
      await seeded(built);
      await built.proposals.insert({} as never, [
        proposal({
          id: 'a9000000-0000-4000-8000-00000000ac03' as Id,
          targetPath: '.agentic/knowledge/lessons/L-other.md',
        }),
      ]);
      const report = await applyKnowledgeProposals(built.applyOptions, data);
      expect(report).toMatchObject({ status: 'applied', applied: 1, deferred: 1 });
      expect(built.calls.commits[0]?.actions).toEqual([
        expect.objectContaining({
          action: 'create',
          path: '.agentic/knowledge/lessons/L-other.md',
        }),
      ]);
      const waiting = built.proposals.rows.find(
        (row) => row.id === ('a8000000-0000-4000-8000-00000000ac02' as Id),
      );
      expect(waiting?.applyDeferredReason).toBe(applyUnreadableReason(PAGE, 7));
    });

    it('keeps the newer one waiting while the merge request has merged and the index has not read it (review round 1)', async () => {
      const built = harness({
        getMergeRequest: async () => ({ state: 'merged', merged_at: '2026-09-12T08:00:00.000Z' }),
      });
      await seeded(built);
      const report = await applyKnowledgeProposals(built.applyOptions, data);
      expect(report).toMatchObject({ status: 'nothing_to_apply', deferred: 1, applied: 0 });
      expect(built.calls.commits).toEqual([]);
      expect(built.proposals.rows.at(-1)?.applyDeferredReason).toBe(
        applyAwaitingIndexReason(PAGE, 7),
      );
    });

    it('creates the page when the merge is older than the index could lag: it was removed since (the other side)', async () => {
      const longAgo = new Date(Date.parse(AT) - INDEX_CATCH_UP_MS - 60_000).toISOString();
      const built = harness({
        getMergeRequest: async () => ({ state: 'merged', merged_at: longAgo }),
      });
      await seeded(built);
      const report = await applyKnowledgeProposals(built.applyOptions, data);
      expect(report).toMatchObject({ status: 'applied', deferred: 0, applied: 1 });
      expect(built.calls.commits[0]?.actions[0]?.action).toBe('create');
    });

    it('clears an earlier deferral before the provider calls, so a pass that then fails leaves no stale reason (review round 1)', async () => {
      const built = harness({
        getMergeRequest: async () => ({ state: 'closed' }),
        onCommit: () => {
          throw new IntegrationError('unavailable', 'fake-git', 'the provider is down');
        },
      });
      await seeded(built);
      await built.proposals.deferApply({} as never, {
        deferrals: [
          {
            id: 'a8000000-0000-4000-8000-00000000ac02' as Id,
            reason: applyDeferredReason(PAGE, 7),
          },
        ],
      });
      await expect(applyKnowledgeProposals(built.applyOptions, data)).rejects.toBeInstanceOf(
        IntegrationError,
      );
      const row = built.proposals.rows.at(-1);
      expect(row?.appliedCommitSha).toBeNull();
      expect(row?.applyDeferredReason).toBeUndefined();
    });

    it('does not ask the provider about a page the index already holds', async () => {
      let asked = 0;
      const built = harness({
        indexedPaths: [PAGE],
        getMergeRequest: async () => {
          asked += 1;
          return { state: 'opened' };
        },
      });
      await seeded(built);
      const report = await applyKnowledgeProposals(built.applyOptions, data);
      expect(report).toMatchObject({ status: 'applied', deferred: 0 });
      expect(built.calls.commits[0]?.actions[0]?.action).toBe('update');
      expect(asked).toBe(0);
    });
  });

  /**
   * WP-156 ruling (d), PROGRESS backlog 420: GitLab refuses a commit whole and names no file, so a
   * refused batch of more than one is retried one proposal per commit, once, in the same pass.
   */
  describe('a batch the provider refuses whole (WP-156, backlog 420)', () => {
    const PAGES = [1, 2, 3].map((n) => `.agentic/knowledge/lessons/L-${String(n)}.md`);
    const three = () =>
      PAGES.map((targetPath, index) =>
        proposal({
          id: `00000000-0000-4000-8000-00000000ac0${String(index + 1)}` as Id,
          targetPath,
        }),
      );
    /** Refuses every commit that carries the second page — on every attempt. */
    const refuseSecond = (request: CommitFilesRequest): IntegrationError | null =>
      request.actions.some((action) => action.path === PAGES[1])
        ? new IntegrationError('invalid_request', 'fake-git', 'the provider refused the commit')
        : null;

    it('ends a batch of three with one page refused on every attempt as two applied and one apply_failed', async () => {
      const { applyOptions, calls, proposals, jobs } = harness({ refuse: refuseSecond });
      await proposals.insert({} as never, three());

      const report = await applyKnowledgeProposals(applyOptions, data);

      // One refused batch, then one commit per proposal, once.
      expect(calls.commits.map((commit) => commit.actions.map((action) => action.path))).toEqual([
        PAGES,
        [PAGES[0]],
        [PAGES[1]],
        [PAGES[2]],
      ]);
      // Each single on a branch of its own — never the refused batch's.
      const singles = calls.commits.slice(1).map((commit) => commit.branch);
      expect(new Set(singles).size).toBe(3);
      expect(singles).not.toContain(calls.commits[0]?.branch);
      // The whole id: these test ids share their first eight digits, the batch name's discriminator.
      expect(singles).toEqual(
        three().map((row) => `agentic/knowledge/2026-09-12-${row.id.replaceAll('-', '')}`),
      );
      expect(proposals.rows.map((row) => row.status)).toEqual([
        'applied',
        'apply_failed',
        'applied',
      ]);
      const refused = proposals.rows[1];
      expect(refused?.applyFailureReason).toBe(
        applyRefusedReason(PAGES[1] as string, 'invalid_request'),
      );
      expect(refused?.applyFailureReason).toContain('(invalid_request)');
      // Its siblings were committed, each with its own merge request.
      expect(calls.mergeRequests.map((request) => request.branch)).toEqual([
        singles[0],
        singles[2],
      ]);
      expect(report).toMatchObject({ status: 'applied', applied: 2, failed: 1, remaining: 0 });
      const stream = await applyOptions.eventStore.readStream('project', PROJECT);
      expect(stream.map((entry) => entry.event.type)).toEqual([
        'knowledge.proposal.applied',
        'knowledge.proposal.applied',
      ]);
      // Nothing is waiting, so the pass asks for no other.
      expect(jobs.take('knowledge.apply')).toEqual([]);
    });

    it('behaves as before for a batch of one: the refusal is thrown and nothing is split', async () => {
      const { applyOptions, calls, proposals } = harness({ refuse: refuseSecond });
      await proposals.insert({} as never, [three()[1] as StoredKnowledgeProposal]);

      await expect(applyKnowledgeProposals(applyOptions, data)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect(calls.commits).toHaveLength(1);
      expect(proposals.rows[0]?.status).toBe('auto_applied');
      expect(proposals.rows[0]?.applyFailureReason).toBeUndefined();
    });

    /**
     * Ruling (d) splits **only** on `invalid_request` (review round 1): a batch whose first commit
     * fails any other way is thrown as before — one commit call, nothing split, nothing failed.
     */
    const refusedOtherwise = async (code: 'unavailable' | 'forbidden'): Promise<void> => {
      const { applyOptions, calls, proposals } = harness({
        refuse: () => new IntegrationError(code, 'fake-git', `the provider answered ${code}`),
      });
      await proposals.insert({} as never, three());

      await expect(applyKnowledgeProposals(applyOptions, data)).rejects.toMatchObject({ code });
      expect(calls.commits).toHaveLength(1);
      expect(calls.mergeRequests).toEqual([]);
      expect(proposals.rows.map((row) => row.status)).toEqual([
        'auto_applied',
        'auto_applied',
        'auto_applied',
      ]);
    };

    it('does not split a batch whose commit fails with unavailable: the error is thrown, one commit, nothing moved', async () => {
      await refusedOtherwise('unavailable');
    });

    it('does not split a batch whose commit fails with forbidden: the error is thrown, one commit, nothing moved', async () => {
      await refusedOtherwise('forbidden');
    });

    it('throws any other failure of a single, with the pages decided before it recorded', async () => {
      let commits = 0;
      const { applyOptions, calls, proposals } = harness({
        refuse: () => {
          commits += 1;
          if (commits === 1)
            return new IntegrationError('invalid_request', 'fake-git', 'refused whole');
          return commits === 3
            ? new IntegrationError('unavailable', 'fake-git', 'the provider went away')
            : null;
        },
      });
      await proposals.insert({} as never, three());

      await expect(applyKnowledgeProposals(applyOptions, data)).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(calls.commits).toHaveLength(3);
      expect(proposals.rows.map((row) => row.status)).toEqual([
        'applied',
        'auto_applied',
        'auto_applied',
      ]);
    });
  });

  it('wakes the apply after an index run only when an approved proposal waits', async () => {
    const built = harness();
    expect(
      await wakeAwaitingKnowledgeApply({ proposals: built.proposals, jobs: built.jobs }, PROJECT),
    ).toBe(false);
    expect(built.jobs.enqueued).toEqual([]);
    await built.proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ad01' as Id }),
    ]);
    expect(
      await wakeAwaitingKnowledgeApply({ proposals: built.proposals, jobs: built.jobs }, PROJECT),
    ).toBe(true);
    expect(built.jobs.enqueued).toEqual([
      expect.objectContaining({
        singletonKey: `project:${PROJECT}`,
        data: { project_id: PROJECT, reason: 'indexed' },
      }),
    ]);
  });

  it('leaves the proposals alone when the project has no git binding', async () => {
    const { applyOptions, proposals } = harness({ git: false });
    await proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ab09' as Id }),
    ]);
    const report = await applyKnowledgeProposals(applyOptions, data);
    expect(report.status).toBe('unavailable');
    expect(proposals.rows[0]?.status).toBe('auto_applied');
  });

  /**
   * WP-109, PROGRESS backlog **333**: a lost project-stream race re-runs the transaction, never the
   * commit or the merge request. Before it the job failed and pg-boss re-ran the whole pass a minute
   * later, provider calls included. The bound from both sides (rule 42).
   */
  it('lands the pass through three lost races with one commit and one merge request', async () => {
    const { applyOptions, calls, proposals, eventing, race } = harness({
      losses: PROJECT_STREAM_APPEND_ATTEMPTS - 1,
    });
    await eventing.transaction(async (scope) => {
      await proposals.insert(scope.tx, [
        proposal({ id: '00000000-0000-4000-8000-00000000ab21' as Id }),
      ]);
    });
    const report = await applyKnowledgeProposals(applyOptions, data);
    expect(report.status).toBe('applied');
    expect(race.lost()).toBe(PROJECT_STREAM_APPEND_ATTEMPTS - 1);
    expect(calls.commits).toHaveLength(1);
    expect(calls.mergeRequests).toHaveLength(1);
    expect(proposals.rows[0]?.status).toBe('applied');
    const own = (await applyOptions.eventStore.readStream('project', PROJECT)).filter(
      (entry) =>
        entry.event.actor.kind === 'system' && entry.event.actor.component !== RIVAL_COMPONENT,
    );
    expect(own.map((entry) => entry.event.type)).toEqual(['knowledge.proposal.applied']);
  });

  it('throws the conflict on the fourth lost race, still with one commit, and applies nothing', async () => {
    const { applyOptions, calls, proposals, eventing } = harness({
      losses: PROJECT_STREAM_APPEND_ATTEMPTS,
    });
    await eventing.transaction(async (scope) => {
      await proposals.insert(scope.tx, [
        proposal({ id: '00000000-0000-4000-8000-00000000ab22' as Id }),
      ]);
    });
    await expect(applyKnowledgeProposals(applyOptions, data)).rejects.toBeInstanceOf(
      StreamConflictError,
    );
    expect(calls.commits).toHaveLength(1);
    expect(calls.mergeRequests).toHaveLength(1);
    // Rolled back with the transaction, so the job's pg-boss retry finds it still waiting.
    expect(proposals.rows[0]?.status).toBe('auto_applied');
  });

  /**
   * WP-15d's refusal, asserted on **this** path: the whole reason the apply is a job is that it
   * makes two provider calls, and a later change that moved it into a handler would hold a pooled
   * connection across somebody else's HTTP latency.
   */
  it('refuses to run inside a database transaction', async () => {
    const { applyOptions, proposals } = harness();
    await proposals.insert({} as never, [
      proposal({ id: '00000000-0000-4000-8000-00000000ab10' as Id }),
    ]);
    await expect(
      withOpenTransaction(async () => applyKnowledgeProposals(applyOptions, data)),
    ).rejects.toBeInstanceOf(TransactionOpenError);
  });
});
