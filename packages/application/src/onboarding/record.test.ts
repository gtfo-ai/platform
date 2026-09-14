/**
 * Recording what a discovery run found — WP-21.
 *
 * What is asserted here: which event asks for a recording, that the evaluation and the proposals
 * land in one transaction, that **nothing** a discovery run drafts can be auto-applied, and that
 * the redactor runs before anything is stored. What is **not** asserted here is whether the queue's
 * policy collapses two wake-ups — `recordingJobs` applies no policy at all (the split
 * `librarian.test.ts` states) — which belongs to the jobs adapter and to pg-boss.
 */
import type { DiscoveryDraftData, DomainEvent, Id } from '@platform/contracts';
import { MAX_PROPOSAL_DELTA_BYTES } from '@platform/contracts';
import { fixedClock, MAX_PROPOSALS_PER_RUN, sequentialIds } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../events/handler.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { memoryReadinessStore } from '../testing/memory-readiness.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import type { PlatformReadinessSignals } from './ports.js';
import {
  type DiscoveryRecordData,
  type DiscoveryRecordOptions,
  discoveryTriggerHandlers,
  MAX_DISCOVERY_DOCUMENTS,
  recordDiscoveryFindings,
} from './record.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000b2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000b3' as Id;
const ARTIFACT = '00000000-0000-4000-8000-0000000000b4' as Id;

/** Obviously fake, and planted so the redaction assertion has something to look for (rule 45). */
const PLANTED_SECRET = 'FAKE-repository-credential-not-a-real-secret';

const page = (overrides: Partial<DiscoveryDraftData['documents'][number]> = {}) => ({
  path: 'technical/overview.md',
  title: 'How the API is laid out',
  markdown: '# Overview\n\nThree services and one database.\n',
  confidence: 'medium' as const,
  ...overrides,
});

const draft = (overrides: Partial<DiscoveryDraftData> = {}): DiscoveryDraftData => ({
  documents: [page()],
  commands: [],
  linked_documents: [],
  questions: [],
  ...overrides,
});

interface Harness {
  readonly options: DiscoveryRecordOptions;
  readonly readiness: ReturnType<typeof memoryReadinessStore>;
  readonly proposals: ReturnType<typeof memoryProposalStore>;
  readonly jobs: ReturnType<typeof recordingJobs>;
  readonly eventing: MemoryEventing;
}

const harness = (
  options: {
    readonly data?: unknown;
    readonly signals?: Partial<PlatformReadinessSignals>;
    readonly indexedPaths?: readonly string[];
    readonly knowledgeDir?: string;
    readonly project?: { readonly knowledgeDir: string } | null;
    readonly artifact?: { readonly data: unknown; readonly runId: Id | null } | null;
  } = {},
): Harness => {
  const readiness = memoryReadinessStore();
  const proposals = memoryProposalStore();
  const jobs = recordingJobs();
  const eventing = new MemoryEventing();
  const knowledge = memoryKnowledgeStore();
  return {
    readiness,
    proposals,
    jobs,
    eventing,
    options: {
      unitOfWork: eventing,
      eventStore: eventing.store,
      readiness,
      proposals,
      knowledge: {
        ...knowledge,
        readIndexedBlobs: async () =>
          new Map((options.indexedPaths ?? []).map((path) => [path, 'blob'])),
      },
      signals: {
        read: async () => ({
          defaultBranchProtected: null,
          boundIntegrationTypes: [],
          indexedKnowledgePaths: [],
          ...options.signals,
        }),
      },
      clock: fixedClock('2026-09-13T04:00:00.000Z'),
      ids: sequentialIds(900),
      redactor: exactSecretRedactor([{ name: 'repo_key', value: PLANTED_SECRET }]),
      project: async () =>
        options.project === undefined
          ? { knowledgeDir: options.knowledgeDir ?? '.agentic/knowledge' }
          : options.project,
      artifact: async () =>
        options.artifact === undefined
          ? { data: (options.data ?? draft()) as never, runId: RUN }
          : (options.artifact as never),
      logger: silentLogger,
    },
  };
};

const job: DiscoveryRecordData = {
  project_id: PROJECT,
  task_id: TASK,
  artifact_id: ARTIFACT,
};

describe('the artifact trigger', () => {
  const dispatch = async (event: DomainEvent, jobs: ReturnType<typeof recordingJobs>) => {
    const callbacks: (() => Promise<void> | void)[] = [];
    const context = {
      scope: {} as HandlerContext['scope'],
      event: { position: 1, causeEventPosition: null, event },
      emit: async () => [],
      stop: () => {},
      afterCommit: (callback: () => Promise<void> | void) => {
        callbacks.push(callback);
      },
    } satisfies HandlerContext;
    for (const handler of discoveryTriggerHandlers({ jobs })) {
      if (handler.eventTypes === 'all' || handler.eventTypes.includes(event.type)) {
        await handler.handle(context);
      }
    }
    for (const callback of callbacks) await callback();
  };

  const artifactCreated = (artifactType: string): DomainEvent =>
    ({
      id: '00000000-0000-4000-8000-0000000000bf',
      stream_type: 'task',
      stream_id: TASK,
      stream_seq: 4,
      correlation_id: null,
      cause_event_id: null,
      actor: { kind: 'system', component: 'pipeline' },
      occurred_at: '2026-09-13T04:00:00.000Z',
      type: 'artifact.created',
      payload: {
        project_id: PROJECT,
        task_id: TASK,
        artifact: {
          id: ARTIFACT,
          artifact_type: artifactType,
          version: 1,
          stage: 'discovery',
          run_id: RUN,
        },
      },
    }) as unknown as DomainEvent;

  it('enqueues a recording for a DiscoveryDraft', async () => {
    const { jobs } = harness();
    await dispatch(artifactCreated('DiscoveryDraft'), jobs);
    expect(jobs.enqueued.map((entry) => entry.queue)).toEqual([JOB_QUEUES.discoveryRecord]);
    expect(jobs.enqueued[0]?.data).toEqual(job);
  });

  it('ignores every other artifact type', async () => {
    // The other direction (rule 10): a handler that enqueued for everything would pass the case
    // above. `LibrarianProposals` is the artifact that reaches the same event on the same bus.
    const { jobs } = harness();
    await dispatch(artifactCreated('LibrarianProposals'), jobs);
    await dispatch(artifactCreated('RefinedSpec'), jobs);
    expect(jobs.enqueued).toEqual([]);
  });
});

describe('recordDiscoveryFindings', () => {
  it('writes the readiness evaluation the endpoint has never had a producer for', async () => {
    const { options, readiness } = harness({
      data: draft({ readiness: [{ id: 'R1', passed: true, evidence: 'ran the suite: green' }] }),
      signals: { defaultBranchProtected: true },
    });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.status).toBe('recorded');
    expect(readiness.rows).toHaveLength(1);
    expect(readiness.rows[0]?.projectId).toBe(PROJECT);
    expect(readiness.rows[0]?.source).toBe('discovery');
    expect(readiness.rows[0]?.criteria).toHaveLength(14);
    // R1 alone is not level 1 — R3 is missing — so this also asserts the level came from the
    // ladder and not from a count of passing criteria.
    expect(report.level).toBe(0);
    expect(readiness.levels.get(PROJECT)).toBe(0);
  });

  it('queues every drafted page and auto-applies none', async () => {
    // product/06: "Nothing is committed without acceptance." The thresholds are forced here, so a
    // project with `auto_apply: true` still gets a queue — which is the assertion that fails if
    // `DISCOVERY_PROPOSAL_THRESHOLDS` is ever replaced by the project's own policy.
    const { options, proposals } = harness({
      data: draft({
        documents: [
          page({ path: 'technical/overview.md', confidence: 'high' }),
          page({ path: 'technical/how-to-run.md', confidence: 'low' }),
        ],
      }),
    });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.queued).toBe(2);
    expect(report.discarded).toBe(0);
    expect(proposals.rows.map((row) => row.status)).toEqual(['queued', 'queued']);
    expect(proposals.rows.every((row) => row.source === 'bootstrap')).toBe(true);
    expect(proposals.rows.map((row) => row.targetPath)).toEqual([
      '.agentic/knowledge/technical/overview.md',
      '.agentic/knowledge/technical/how-to-run.md',
    ]);
    expect(proposals.rows.map((row) => row.significance)).toEqual([0.9, 0.3]);
    expect(proposals.rows.every((row) => row.taskId === TASK && row.runId === RUN)).toBe(true);
  });

  it('publishes one knowledge.proposal.created per queued page', async () => {
    const { options, eventing } = harness();
    await recordDiscoveryFindings(options, job);
    const stream = await eventing.store.readStream('project', PROJECT);
    expect(stream.map((entry) => entry.event.type)).toEqual(['knowledge.proposal.created']);
  });

  it('refuses a path that would climb out of the knowledge directory', async () => {
    // The curator's rule (BD-025), reached through this module: a discovery draft is model output
    // about a repository the platform does not control, so the path is as untrusted as the page.
    const { options, proposals } = harness({
      data: draft({ documents: [page({ path: '../../etc/passwd.md' })] }),
    });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.queued).toBe(0);
    expect(report.discarded).toBe(1);
    expect(proposals.rows[0]?.status).toBe('discarded');
  });

  it('redacts the page and its path before anything is stored', async () => {
    const { options, proposals } = harness({
      data: draft({
        documents: [page({ markdown: `# Overview\n\ntoken: ${PLANTED_SECRET}\n` })],
        readiness: [{ id: 'R1', passed: true, evidence: `saw ${PLANTED_SECRET} in the CI log` }],
      }),
    });
    const report = await recordDiscoveryFindings(options, job);
    expect(proposals.rows[0]?.delta).not.toContain(PLANTED_SECRET);
    expect(proposals.rows[0]?.delta).toContain('[REDACTED');
    // Both sinks are counted: the page and the readiness evidence.
    expect(report.redactions).toBe(2);
  });

  it('states a page budget the constants produce', () => {
    // The docblock quotes `MAX_DISCOVERY_DOCUMENTS × MAX_PROPOSAL_DELTA_BYTES` as 1.25 MiB; this is
    // that product, computed rather than restated (PROGRESS backlog 22: a figure beside a constant
    // drifts, and this docblock said 2.5 MiB while the constant said 20).
    expect(MAX_DISCOVERY_DOCUMENTS).toBe(MAX_PROPOSALS_PER_RUN);
    expect(MAX_DISCOVERY_DOCUMENTS * MAX_PROPOSAL_DELTA_BYTES).toBe(1.25 * 1024 * 1024);
  });

  it('curates at most the document cap and records the rest as refusals', async () => {
    const documents = Array.from({ length: MAX_DISCOVERY_DOCUMENTS + 5 }, (_, index) =>
      page({ path: `technical/page-${index}.md` }),
    );
    const { options, proposals } = harness({ data: draft({ documents }) });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.queued).toBe(MAX_DISCOVERY_DOCUMENTS);
    expect(proposals.rows).toHaveLength(MAX_DISCOVERY_DOCUMENTS);
  });

  it('turns a page the index already holds into an update rather than a second add', async () => {
    const { options, proposals } = harness({
      indexedPaths: ['.agentic/knowledge/technical/overview.md'],
    });
    await recordDiscoveryFindings(options, job);
    expect(proposals.rows[0]?.status).toBe('queued');
    expect(proposals.rows[0]?.targetPath).toBe('.agentic/knowledge/technical/overview.md');
  });

  it('records a proposal for an artifact whose run is gone', async () => {
    // `artifacts.produced_by_run_id` is `on delete set null`, so a proposal's provenance can be a
    // task and no run. The row is still written — provenance that is partly missing is not a reason
    // to drop a page a human is waiting to review.
    const { options, proposals, readiness } = harness({
      artifact: { data: draft() as never, runId: null },
    });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.status).toBe('recorded');
    expect(proposals.rows[0]?.runId).toBeNull();
    expect(proposals.rows[0]?.taskId).toBe(TASK);
    expect(readiness.rows).toHaveLength(1);
  });

  describe('the risk classes a draft proposes (product/18:52, WP-37)', () => {
    it('stores them on the project, config-shaped, and applies nothing', async () => {
      const started = harness({
        data: draft({
          risk_classes: [
            { name: 'auth', paths: ['src/auth/**'], evidence: 'src/auth/session.ts exists' },
          ],
        }),
      });
      const report = await recordDiscoveryFindings(started.options, job);

      expect(report.riskClasses).toBe(1);
      // It is a **proposal**: the map is on the project row, ready to be sent back through the
      // configuration write, and `policies.risk_classes` is not touched by this job at all.
      expect(started.readiness.proposals.get(PROJECT)).toEqual({
        auth: {
          paths: ['src/auth/**'],
          // The requirement is the **platform's**, never the model's (the rule `unlocks` follows).
          require: ['plan_approval', 'reviewer:@security'],
        },
      });
    });

    it('drops a class name the platform does not have, rather than creating one', async () => {
      const started = harness({
        data: draft({
          risk_classes: [
            { name: 'nothing_special', paths: ['src/**'], evidence: 'the README asked for it' },
            { name: 'Agent-Config', paths: ['.agentic/**'], evidence: '.agentic exists' },
          ],
        }),
      });
      const report = await recordDiscoveryFindings(started.options, job);

      // One survives — case and dashes folded, because a model writes `agent-config` for the key an
      // operator writes as `agent_config` — and the invented one does not.
      expect(report.riskClasses).toBe(1);
      expect(Object.keys(started.readiness.proposals.get(PROJECT) ?? {})).toEqual(['agent_config']);
    });

    it('writes nothing at all when the draft proposed nothing, so silence is not "none"', async () => {
      const started = harness({ data: draft() });
      const report = await recordDiscoveryFindings(started.options, job);

      expect(report.riskClasses).toBe(0);
      expect(started.readiness.proposals.has(PROJECT)).toBe(false);
    });

    it('redacts a path before it is stored', async () => {
      const started = harness({
        data: draft({
          risk_classes: [
            { name: 'data', paths: [`db/${PLANTED_SECRET}/**`], evidence: 'migrations live here' },
          ],
        }),
      });
      await recordDiscoveryFindings(started.options, job);

      const stored = JSON.stringify(started.readiness.proposals.get(PROJECT));
      expect(stored).not.toContain(PLANTED_SECRET);
      expect(stored).toContain('[REDACTED:integration:repo_key]');
    });
  });

  it('records nothing when the project has gone', async () => {
    const { options, readiness, proposals } = harness({ project: null });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('project');
    expect(readiness.rows).toEqual([]);
    expect(proposals.rows).toEqual([]);
  });

  it('records nothing when the artifact has gone', async () => {
    const { options, readiness } = harness({ artifact: null });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('artifact');
    expect(readiness.rows).toEqual([]);
  });

  it('refuses a stored artifact that is not a DiscoveryDraft', async () => {
    const { options, readiness } = harness({ data: { nonsense: true } });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('DiscoveryDraft');
    expect(readiness.rows).toEqual([]);
  });

  it('still writes an evaluation for a draft that reported no readiness at all', async () => {
    // The field is optional, so an older draft parses — and "reported nothing" must produce a
    // level-0 evaluation rather than no evaluation, or the endpoint keeps answering 409.
    const { options, readiness } = harness({ data: draft({ documents: [] }) });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.status).toBe('recorded');
    expect(report.level).toBe(0);
    expect(readiness.rows).toHaveLength(1);
  });
});
