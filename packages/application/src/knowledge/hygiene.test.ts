/**
 * The nightly hygiene pass — WP-18b.
 *
 * Two halves, and the second is the one worth having: **what the pass refuses to do**. A pass that
 * deleted an expired page, or committed a fix for a dangling link, would look like diligence and
 * would be the one thing product/05 forbids ("Deprecated pages are kept, never deleted";
 * contradictions "flagged for humans, never auto-resolved"). The line is structural — the module
 * holds no `PipelineIntegrationsPort` and no `KnowledgeStore` write — and these cases assert its
 * observable consequence.
 */
import type { Id } from '@platform/contracts';
import { fixedClock, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { type KnowledgeHygieneOptions, runKnowledgeHygiene } from './hygiene.js';
import type { StoredKnowledgeProposal } from './ports.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const OTHER = '00000000-0000-4000-8000-0000000000e2' as Id;
const AT = '2026-09-12T03:15:00.000Z';

const harness = (projects: readonly Id[] = [PROJECT]) => {
  const proposals = memoryProposalStore();
  const jobs = recordingJobs();
  const eventing = new MemoryEventing();
  const options: KnowledgeHygieneOptions = {
    unitOfWork: eventing,
    proposals,
    jobs,
    clock: fixedClock(AT),
    ids: sequentialIds(900),
    projects: async (limit) => projects.slice(0, limit),
    logger: silentLogger,
  };
  return { options, proposals, jobs };
};

const waiting = (id: string, projectId: Id): StoredKnowledgeProposal => ({
  id: id as Id,
  projectId,
  taskId: null,
  runId: null,
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
});

describe('the nightly pass', () => {
  it('writes a health report naming what it found', async () => {
    const { options, proposals } = harness();
    proposals.seedHealthInputs(PROJECT, {
      commitSha: 'c0ffee1',
      documents: [
        {
          path: '.agentic/knowledge/lessons/L-old.md',
          expires: '2025-01-01',
          frontmatterId: 'L-1',
          tokens: 100,
        },
        {
          path: '.agentic/knowledge/lessons/L-copy.md',
          expires: null,
          frontmatterId: 'L-1',
          tokens: 100,
        },
      ],
      danglingLinks: [
        { fromPath: '.agentic/knowledge/lessons/L-copy.md', toPath: 'lessons/gone.md' },
      ],
    });

    const report = await runKnowledgeHygiene(options);

    expect(report.projects).toBe(1);
    expect(proposals.reports).toHaveLength(1);
    const written = proposals.reports[0];
    expect(written?.projectId).toBe(PROJECT);
    expect(written?.commitSha).toBe('c0ffee1');
    expect(written?.documents).toBe(2);
    expect(written?.source).toBe('hygiene');
    expect(written?.findings.map((finding) => finding.kind).sort()).toEqual([
      'dangling',
      'duplicate',
      'duplicate',
      'expired',
    ]);
  });

  it('writes a report for a project with nothing indexed, rather than skipping it', async () => {
    // Rule 18's shape at a read: "no findings over no documents" and "a clean vault" are different
    // facts, and the row carries the count that tells them apart.
    const { options, proposals } = harness();
    const report = await runKnowledgeHygiene(options);
    expect(report.findings).toBe(0);
    expect(proposals.reports[0]?.documents).toBe(0);
  });

  it('re-asks for an apply pass for every project with a decided proposal', async () => {
    const { options, proposals, jobs } = harness([PROJECT]);
    await proposals.insert({} as never, [
      waiting('00000000-0000-4000-8000-00000000ba01', PROJECT),
      // …including a project the pass did not report on: the recovery is over the proposals, not
      // over the reported projects.
      waiting('00000000-0000-4000-8000-00000000ba02', OTHER),
    ]);
    const report = await runKnowledgeHygiene(options);
    expect(report.reapplied).toBe(2);
    const enqueued = jobs.take(JOB_QUEUES.knowledgeApply);
    expect(enqueued.map((request) => request.data?.project_id).sort()).toEqual(
      [PROJECT, OTHER].sort(),
    );
  });

  it('asks for nothing when every proposal is already applied or rejected', async () => {
    const { options, proposals, jobs } = harness();
    await proposals.insert({} as never, [
      { ...waiting('00000000-0000-4000-8000-00000000ba03', PROJECT), status: 'applied' },
      { ...waiting('00000000-0000-4000-8000-00000000ba04', PROJECT), status: 'rejected' },
    ]);
    const report = await runKnowledgeHygiene(options);
    expect(report.reapplied).toBe(0);
    expect(jobs.enqueued).toEqual([]);
  });

  /**
   * The refusal, stated as a test rather than as a sentence: an expired page a human wrote is
   * reported and **still indexed**, and nothing about the pass can reach a git provider.
   */
  it('never removes a document and never writes to the repository', async () => {
    const { options, proposals } = harness();
    proposals.seedHealthInputs(PROJECT, {
      commitSha: 'c0ffee1',
      documents: [
        {
          path: '.agentic/knowledge/handbook.md',
          expires: '2020-01-01',
          frontmatterId: null,
          tokens: 10,
        },
      ],
      danglingLinks: [],
    });
    await runKnowledgeHygiene(options);

    // The document is still there to be read: the pass wrote a report about it and nothing else.
    const after = await proposals.readHealthInputs(PROJECT);
    expect(after.documents.map((document) => document.path)).toEqual([
      '.agentic/knowledge/handbook.md',
    ]);
    expect(proposals.reports[0]?.findings[0]?.kind).toBe('expired');
    // And the options this pass is composed with carry no provider at all — the structural half.
    expect(Object.keys(options)).not.toContain('integrations');
  });
});
