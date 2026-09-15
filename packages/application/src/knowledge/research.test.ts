/**
 * The spike's research page — product/04:117's *"stored in the KB under `research/`"* (WP-40).
 *
 * What is asserted here: which artifact type asks for a page, where the page is filed, that the
 * redactor runs before anything is stored, and that **nothing is ever auto-applied** whatever the
 * project's own `policies.knowledge_apply` says — which is the criterion's *"never applied
 * silently"* and the one branch a project could otherwise configure away.
 */
import type { DomainEvent, Id, ResearchReportData } from '@platform/contracts';
import { fixedClock, knowledgeApplyThresholds, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../events/handler.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import type { LibrarianArtifact, LibrarianJobOptions } from './librarian.js';
import { recordResearchPage, researchPageJobHandler, researchTriggerHandlers } from './research.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000e2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000e3' as Id;
const ARTIFACT = '00000000-0000-4000-8000-0000000000e4' as Id;

/** Obviously fake, and planted so the redaction assertion has something to look for (rule 45). */
const PLANTED = 'FAKE-model-credential-not-a-real-secret-0002';

const REPORT: ResearchReportData = {
  question: `Can the ledger reuse the outbox? Read with ${PLANTED}.`,
  summary: 'The outbox already carries an ordering key.',
  findings: [
    {
      statement: 'The writer takes the same advisory lock.',
      evidence: ['src/outbox/writer.ts:88'],
      confidence: 'high',
    },
  ],
  options: [],
  recommendation: `Reuse the outbox. The run was given ${PLANTED}.`,
  open_questions: [],
  kb_citations: [],
};

const harness = (
  options: {
    readonly data?: unknown;
    readonly autoApply?: boolean;
    readonly ticketKey?: string;
    readonly indexedPaths?: readonly string[];
    readonly artifact?: LibrarianArtifact | null;
  } = {},
) => {
  const proposals = memoryProposalStore();
  const jobs = recordingJobs();
  const eventing = new MemoryEventing();
  const knowledge = memoryKnowledgeStore();
  return {
    proposals,
    jobs,
    eventing,
    options: {
      unitOfWork: eventing,
      eventStore: eventing.store,
      proposals,
      knowledge: {
        ...knowledge,
        readIndexedBlobs: async () =>
          new Map((options.indexedPaths ?? []).map((path) => [path, 'blob'])),
      },
      jobs,
      clock: fixedClock('2026-09-15T09:00:00.000Z'),
      ids: sequentialIds(900),
      redactor: exactSecretRedactor([{ name: 'model_key', value: PLANTED }]),
      project: async () => ({
        knowledgeDir: '.agentic/knowledge',
        // The project's own policy, turned **on**, so the forced thresholds are what is under test
        // rather than a default that happened to agree with them (standing rule 10).
        thresholds: knowledgeApplyThresholds({ auto_apply: options.autoApply ?? true }),
      }),
      artifact: async () =>
        options.artifact === undefined
          ? {
              data: (options.data ?? REPORT) as never,
              runId: RUN,
              taskMode: 'normal' as const,
              ticketKey: options.ticketKey ?? 'ACME-7',
            }
          : options.artifact,
      logger: silentLogger,
    } satisfies LibrarianJobOptions,
  };
};

const DATA = { project_id: PROJECT, task_id: TASK, artifact_id: ARTIFACT };

describe('recordResearchPage', () => {
  it('queues the report under research/, with the task’s own ticket key', async () => {
    const built = harness();
    const report = await recordResearchPage(built.options, DATA);
    expect(report.status).toBe('recorded');
    expect(report.path).toBe('.agentic/knowledge/research/ACME-7.md');
    expect(report.queued).toBe(1);

    const [row] = built.proposals.rows;
    expect(row?.source).toBe('task');
    expect(row?.type).toBe('doc-update');
    expect(row?.targetPath).toBe('.agentic/knowledge/research/ACME-7.md');
    expect(row?.delta).toContain('# Spike: ACME-7');
    expect(row?.evidence[0]).toContain(TASK);
  });

  it('never auto-applies, even for a project whose policy says it may', async () => {
    // The criterion: *stored as a proposal, never applied silently*. `auto_apply: true` above is
    // what makes this a statement about the forced thresholds rather than about a default.
    const built = harness({ autoApply: true });
    await recordResearchPage(built.options, DATA);
    expect(built.proposals.rows.map((row) => row.status)).toEqual(['queued']);
  });

  it('redacts every string it stores (TD-012)', async () => {
    const built = harness();
    const report = await recordResearchPage(built.options, DATA);
    const [row] = built.proposals.rows;
    expect(row?.delta).not.toContain(PLANTED);
    expect(row?.delta).toContain('[REDACTED:integration:model_key]');
    // **Three** redactions, not one, and the value is asserted rather than `> 0` (standing rule
    // 43): two occurrences inside the rendered page — the fixture plants the credential in both the
    // `question` and the `recommendation`, and both are in the report — plus the `reason` the
    // curator is given, which is the model's own question again. `kb_proposals` has no `reason`
    // column, so the count is the only place that third one is visible at all.
    expect(report.redactions).toBe(3);
  });

  it('answers a reason rather than throwing when there is nothing to record', async () => {
    expect((await recordResearchPage(harness({ artifact: null }).options, DATA)).reason).toContain(
      'no longer exists',
    );
    // A row an older build wrote, or an artifact of the wrong shape: a named skip, not a throw —
    // a throw would spend two pg-boss retries on a state the platform can legitimately be in.
    const wrong = await recordResearchPage(harness({ data: { question: 'x' } }).options, DATA);
    expect(wrong.status).toBe('skipped');
    expect(wrong.reason).toContain('does not match the ResearchReport schema');
  });

  it('answers a reason when the project has gone, rather than writing a row for nobody', async () => {
    const built = harness();
    const report = await recordResearchPage({ ...built.options, project: async () => null }, DATA);
    expect(report).toMatchObject({ status: 'skipped', reason: 'the project no longer has a row' });
    expect(built.proposals.rows).toEqual([]);
  });

  it('answers a reason when the curator refuses the page', async () => {
    // Reachable only through a knowledge directory the join cannot produce a vault path under —
    // the curator's own containment (BD-025). The page is then *named* in the report rather than
    // written, because a refusal nobody can read is a page that silently vanished.
    const built = harness();
    const report = await recordResearchPage(
      {
        ...built.options,
        project: async () => ({ knowledgeDir: '', thresholds: knowledgeApplyThresholds({}) }),
      },
      DATA,
    );
    expect(report.status).toBe('skipped');
    expect(report.path).toBe('research/ACME-7.md');
    // The curator's own words, carried through rather than replaced by this module's.
    expect(report.reason).toContain('not a page inside');
    expect(built.proposals.rows).toEqual([]);
  });

  it('turns a second spike on the same ticket into an update rather than a duplicate', async () => {
    const built = harness({ indexedPaths: ['.agentic/knowledge/research/ACME-7.md'] });
    await recordResearchPage(built.options, DATA);
    // The curator's own dedupe, reached because the path is the platform's and therefore stable.
    expect(built.proposals.rows[0]?.status).toBe('queued');
    expect(built.proposals.rows[0]?.targetPath).toBe('.agentic/knowledge/research/ACME-7.md');
  });
});

describe('researchPageJobHandler', () => {
  it('logs and returns rather than throwing on a skip, so pg-boss does not retry it', async () => {
    // A throw would spend two retries on a state the platform can legitimately be in (the argument
    // `librarianProposalsHandler` makes). Both branches are driven, because the handler's own job
    // is to tell the two apart.
    const recorded = harness();
    await expect(researchPageJobHandler(recorded.options)({ data: DATA })).resolves.toBeUndefined();
    expect(recorded.proposals.rows).toHaveLength(1);

    const skipped = harness({ artifact: null });
    await expect(researchPageJobHandler(skipped.options)({ data: DATA })).resolves.toBeUndefined();
    expect(skipped.proposals.rows).toEqual([]);
  });
});

describe('researchTriggerHandlers', () => {
  const artifactCreated = (type: string): DomainEvent =>
    ({
      id: '00000000-0000-4000-9000-0000000000e9',
      type: 'artifact.created',
      payload: {
        project_id: PROJECT,
        task_id: TASK,
        artifact: { id: ARTIFACT, artifact_type: type, version: 1, url: null },
      },
    }) as unknown as DomainEvent;

  const fire = async (type: string) => {
    const jobs = recordingJobs();
    const [handler] = researchTriggerHandlers({ jobs, logger: silentLogger });
    const after: (() => Promise<void>)[] = [];
    await handler?.handle({
      event: { event: artifactCreated(type) },
      afterCommit: (callback: () => Promise<void>) => after.push(callback),
    } as unknown as HandlerContext);
    for (const callback of after) {
      await callback();
    }
    return jobs.take(JOB_QUEUES.knowledgeProposals);
  };

  it('asks for a page when a ResearchReport lands, naming the artifact type', async () => {
    const enqueued = await fire('ResearchReport');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.data).toMatchObject({
      project_id: PROJECT,
      task_id: TASK,
      artifact_id: ARTIFACT,
      artifact_type: 'ResearchReport',
    });
  });

  it('asks for nothing when another artifact lands (both directions, standing rule 42)', async () => {
    expect(await fire('LibrarianProposals')).toEqual([]);
    expect(await fire('ImplementationPlan')).toEqual([]);
  });
});
