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
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import type { PipelineIntegrations } from '../pipeline/integrations.js';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import type { CommitFilesRequest, CommitRef } from '../ports/integrations/git-provider.js';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import {
  applyKnowledgeProposals,
  type KnowledgeApplyOptions,
  knowledgeBranchName,
  MAX_TRAILER_TOKEN_CHARS,
  provenanceTokenOf,
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
    readonly ticketKey?: string;
  } = {},
) => {
  const calls: Calls = { commits: [], mergeRequests: [] };
  const proposals = memoryProposalStore();
  const jobs = recordingJobs();
  const eventing = new MemoryEventing();
  const port = {
    commitFiles: async (request: CommitFilesRequest): Promise<CommitRef> => {
      options.onCommit?.();
      calls.commits.push(request);
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
            ref: { integrationId: PROJECT, provider: 'fake-git', type: 'git' as const },
            project: 'acme/api',
          }
        : null,
    taskManagement: null,
  };
  const applyOptions: KnowledgeApplyOptions = {
    unitOfWork: eventing,
    eventStore: eventing.store,
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
  return { calls, proposals, jobs, eventing, applyOptions };
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
