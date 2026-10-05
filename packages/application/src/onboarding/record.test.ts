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
import { StreamConflictError } from '../errors.js';
import type { HandlerContext } from '../events/handler.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { StoredKnowledgeProposal } from '../knowledge/ports.js';
import { PROJECT_STREAM_APPEND_ATTEMPTS } from '../pipeline/project-stream.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryKnowledgeStore } from '../testing/memory-knowledge.js';
import { memoryProposalStore } from '../testing/memory-proposals.js';
import { memoryReadinessStore } from '../testing/memory-readiness.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { racingProjectStream } from '../testing/project-stream-race.js';
import { DISCOVERY_TICKET_KEY } from './discovery.js';
import type { PlatformReadinessSignals } from './ports.js';
import {
  type DiscoveryRecordData,
  type DiscoveryRecordOptions,
  discoveryTriggerHandlers,
  isBusinessDraftPath,
  MAX_DISCOVERY_DOCUMENTS,
  recordDiscoveryFindings,
  supersededDraftReason,
} from './record.js';
import { REDISCOVERY_SOURCE, rediscoveryTicketKeyFor } from './rediscovery.js';

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
  /** How many times the platform's readiness signals were read — the git-provider half (R9). */
  readonly signalReads: () => number;
}

const harness = (
  options: {
    readonly data?: unknown;
    readonly signals?: Partial<PlatformReadinessSignals>;
    readonly indexedPaths?: readonly string[];
    readonly knowledgeDir?: string;
    readonly project?: { readonly knowledgeDir: string } | null;
    readonly artifact?: {
      readonly data: unknown;
      readonly runId: Id | null;
      readonly ticketKey: string;
    } | null;
    readonly ticketKey?: string;
    /**
     * WP-109: how many project-stream races a rival wins. Set (even to 0), the stores roll back
     * with the fake, which a re-run transaction and two concurrent recorders both need.
     */
    readonly losses?: number;
  } = {},
): Harness => {
  const eventing = new MemoryEventing();
  const rollback =
    options.losses === undefined
      ? {}
      : { rollback: (tx: Transaction, undo: () => void) => eventing.onRollback(tx, undo) };
  const readiness = memoryReadinessStore(rollback);
  const proposals = memoryProposalStore(rollback);
  const race = racingProjectStream(eventing, options.losses ?? 0);
  const jobs = recordingJobs();
  const knowledge = memoryKnowledgeStore();
  let signalReads = 0;
  return {
    readiness,
    proposals,
    jobs,
    eventing,
    signalReads: () => signalReads,
    options: {
      unitOfWork: eventing,
      eventStore: { ...eventing.store, nextStreamSequence: race.eventStore.nextStreamSequence },
      readiness,
      proposals,
      knowledge: {
        ...knowledge,
        readIndexedBlobs: async () =>
          new Map((options.indexedPaths ?? []).map((path) => [path, 'blob'])),
      },
      signals: {
        read: async () => {
          signalReads += 1;
          return {
            defaultBranchProtected: null,
            boundIntegrationTypes: [],
            indexedKnowledgePaths: [],
            ...options.signals,
          };
        },
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
          ? {
              data: (options.data ?? draft()) as never,
              runId: RUN,
              ticketKey: options.ticketKey ?? DISCOVERY_TICKET_KEY,
            }
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
    expect(stream.map((entry) => entry.event.type)).toEqual([
      'readiness.evaluated',
      'knowledge.proposal.created',
    ]);
  });

  it('publishes one readiness.evaluated for the row it records, in its transaction (backlog 228)', async () => {
    const { options, eventing, readiness } = harness();
    await recordDiscoveryFindings(options, job);
    const stream = await eventing.store.readStream('project', PROJECT);
    const evaluated = stream.filter((entry) => entry.event.type === 'readiness.evaluated');
    expect(evaluated).toHaveLength(1);
    const row = readiness.rows[0];
    expect(evaluated[0]?.event.payload).toEqual({
      project_id: PROJECT,
      level: row?.level,
      criteria: row?.criteria.map(({ id, passed, evidence }) => ({ id, passed, evidence })),
      source: 'discovery',
    });
    // The stream stays gap-free with the proposals behind it.
    expect(stream.map((entry) => entry.event.stream_seq)).toEqual(
      stream.map((_, index) => index + 1),
    );
  });

  it('refuses a drafted business page and counts it, storing no row (backlog 229)', async () => {
    const { options, proposals, eventing } = harness({
      data: draft({
        documents: [page({ path: 'business/overview.md', title: 'What the business is' }), page()],
      }),
    });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.businessRefused).toBe(1);
    // Refused, not relabelled and not discarded: the interview is the business producer.
    expect(proposals.rows.map((row) => row.targetPath)).toEqual([
      '.agentic/knowledge/technical/overview.md',
    ]);
    expect(proposals.rows.every((row) => row.kind === 'technical')).toBe(true);
    const created = (await eventing.store.readStream('project', PROJECT)).filter(
      (entry) => entry.event.type === 'knowledge.proposal.created',
    );
    expect(created).toHaveLength(1);
  });

  it('keeps a technical page, and refuses none, when no path is a business one', async () => {
    const { options, proposals } = harness();
    const report = await recordDiscoveryFindings(options, job);
    expect(report.businessRefused).toBe(0);
    expect(proposals.rows).toHaveLength(1);
  });

  it('reads a business path by its first segment, whatever its spelling', () => {
    for (const path of [
      'business/overview.md',
      './business/x.md',
      'Business/x.md',
      '/business/x',
    ]) {
      expect(isBusinessDraftPath(path), path).toBe(true);
    }
    for (const path of ['technical/business.md', 'businesses/x.md', '../business/x.md', 'x.md']) {
      expect(isBusinessDraftPath(path), path).toBe(false);
    }
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

  it('curates at most the document cap and counts the pages it drops (backlog 271)', async () => {
    const documents = Array.from({ length: MAX_DISCOVERY_DOCUMENTS + 5 }, (_, index) =>
      page({ path: `technical/page-${index}.md` }),
    );
    const { options, proposals } = harness({ data: draft({ documents }) });
    const report = await recordDiscoveryFindings(options, job);
    expect(report.queued).toBe(MAX_DISCOVERY_DOCUMENTS);
    expect(proposals.rows).toHaveLength(MAX_DISCOVERY_DOCUMENTS);
    // The five past the cap are dropped — no row, not even a discarded one — and counted.
    expect(report.overCap).toBe(5);
    expect(report.discarded).toBe(0);
    expect(proposals.rows.map((row) => row.targetPath)).not.toContain(
      `.agentic/knowledge/technical/page-${MAX_DISCOVERY_DOCUMENTS}.md`,
    );
    // …and a draft at the cap drops none (rule 42: both sides of the bound).
    const atCap = harness({
      data: draft({ documents: documents.slice(0, MAX_DISCOVERY_DOCUMENTS) }),
    });
    expect((await recordDiscoveryFindings(atCap.options, job)).overCap).toBe(0);
  });

  it('labels R1’s evidence read-not-run when the producing run was planned with verification on CI (backlog 460)', async () => {
    const data = draft({
      readiness: [{ id: 'R1', passed: true, evidence: '.gitlab-ci.yml: codeception job' }],
    });
    const recordFor = async (verificationMode: 'ci' | 'local' | null) => {
      const { options, readiness } = harness({
        artifact: { data, runId: RUN, ticketKey: DISCOVERY_TICKET_KEY, verificationMode } as never,
      });
      await recordDiscoveryFindings(options, job);
      return readiness.rows[0]?.criteria.find((entry) => entry.id === 'R1')?.evidence ?? '';
    };
    expect(await recordFor('ci')).toMatch(/^read, not run \(verification\.mode: ci\)/);
    expect(await recordFor('local')).toBe('.gitlab-ci.yml: codeception job');
    // A run with no snapshot (before WP-91) reads as the mode every such run had.
    expect(await recordFor(null)).toBe('.gitlab-ci.yml: codeception job');
  });

  it('records a re-evaluation’s evaluation as a rediscovery, and the first as discovery (WP-94)', async () => {
    const first = harness();
    await recordDiscoveryFindings(first.options, job);
    expect(first.readiness.rows.map((row) => row.source)).toEqual(['discovery']);
    const again = harness({ ticketKey: rediscoveryTicketKeyFor(null, 1) });
    await recordDiscoveryFindings(again.options, job);
    expect(again.readiness.rows.map((row) => row.source)).toEqual([REDISCOVERY_SOURCE]);
    const stream = await again.eventing.store.readStream('project', PROJECT);
    expect(stream[0]?.event.payload).toMatchObject({ source: 'rediscovery' });
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
      artifact: { data: draft() as never, runId: null, ticketKey: DISCOVERY_TICKET_KEY },
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

const TASK_B = '00000000-0000-4000-8000-0000000000b5' as Id;
const ARTIFACT_B = '00000000-0000-4000-8000-0000000000b6' as Id;
const OVERVIEW = '.agentic/knowledge/technical/overview.md';
const jobB: DiscoveryRecordData = { project_id: PROJECT, task_id: TASK_B, artifact_id: ARTIFACT_B };

/**
 * The invariant backlog 319 asks for, as a check that **names** what it found: at most one
 * undecided `queued` proposal per page. Throwing rather than returning a boolean so the canary below
 * can assert the failure by its words (standing rule 3).
 */
const assertOnePendingPerPath = (rows: readonly StoredKnowledgeProposal[]): void => {
  const pending = new Map<string, number>();
  for (const row of rows) {
    if (row.status === 'queued' && row.decidedAt === null) {
      pending.set(row.targetPath, (pending.get(row.targetPath) ?? 0) + 1);
    }
  }
  for (const [path, count] of pending) {
    if (count > 1) throw new Error(`${count} pending proposals for ${path}`);
  }
};

/**
 * WP-109, PROGRESS backlog **357**: the recorder read the sequence outside its transaction and
 * never retried, so a lost race failed the job and pg-boss's retry asked the git provider again.
 */
describe('a discovery record that loses the project stream’s sequence', () => {
  it('records through three lost races, reading the signals once', async () => {
    const built = harness({ losses: PROJECT_STREAM_APPEND_ATTEMPTS - 1 });
    const report = await recordDiscoveryFindings(built.options, job);
    expect(report.status).toBe('recorded');
    expect(built.signalReads()).toBe(1);
    expect(built.readiness.rows).toHaveLength(1);
    expect(built.proposals.rows).toHaveLength(1);
    const own = (await built.eventing.store.readStream('project', PROJECT)).filter(
      (entry) => entry.event.type !== 'knowledge.index.rebuilt',
    );
    expect(own.map((entry) => entry.event.type)).toEqual([
      'readiness.evaluated',
      'knowledge.proposal.created',
    ]);
  });

  it('throws on the fourth with nothing recorded, still with one signal read', async () => {
    const built = harness({ losses: PROJECT_STREAM_APPEND_ATTEMPTS });
    await expect(recordDiscoveryFindings(built.options, job)).rejects.toBeInstanceOf(
      StreamConflictError,
    );
    expect(built.signalReads()).toBe(1);
    expect(built.readiness.rows).toEqual([]);
    expect(built.proposals.rows).toEqual([]);
  });

  it('records two discoveries of one project at once, both — and leaves one draft pending', async () => {
    const built = harness({ losses: 0 });
    const reports = await Promise.all([
      recordDiscoveryFindings(built.options, job),
      recordDiscoveryFindings(built.options, jobB),
    ]);
    expect(reports.map((report) => report.status)).toEqual(['recorded', 'recorded']);
    expect(built.readiness.rows).toHaveLength(2);
    const overview = built.proposals.rows.filter((row) => row.targetPath === OVERVIEW);
    expect(overview.map((row) => row.status).sort()).toEqual(['discarded', 'queued']);
    assertOnePendingPerPath(built.proposals.rows);
  });
});

/**
 * WP-109, PROGRESS backlog **319**, option (a) as ruled: a re-evaluation that drafts a page still
 * queued from an earlier discovery discards the older, undecided draft with a platform reason that
 * names the newer row's task.
 */
describe('a re-evaluation that drafts a page still in the queue', () => {
  it('leaves one pending proposal and one discarded with its reason', async () => {
    const { options, proposals } = harness();
    await recordDiscoveryFindings(options, job);
    const report = await recordDiscoveryFindings(options, jobB);

    expect(report.superseded).toBe(1);
    const [older, newer] = proposals.rows.filter((row) => row.targetPath === OVERVIEW);
    expect(newer?.taskId).toBe(TASK_B);
    expect(newer?.status).toBe('queued');
    expect(older?.taskId).toBe(TASK);
    expect(older?.status).toBe('discarded');
    expect(older?.evidence[0]).toBe(supersededDraftReason(TASK_B));
    expect(older?.evidence[0]).toContain(TASK_B);
    // The draft's own evidence is kept behind the reason, not replaced by it.
    expect(older?.evidence.slice(1)).toEqual(newer?.evidence);
    assertOnePendingPerPath(proposals.rows);
  });

  it('leaves a draft a maintainer already approved alone', async () => {
    const { options, proposals } = harness();
    await recordDiscoveryFindings(options, job);
    const approved = proposals.rows[0] as StoredKnowledgeProposal;
    await proposals.decide({} as never, {
      id: approved.id,
      status: 'queued',
      decidedByUserId: '00000000-0000-4000-8000-0000000000b7' as Id,
      decidedAt: '2026-09-13T05:00:00.000Z' as StoredKnowledgeProposal['createdAt'],
    });
    const report = await recordDiscoveryFindings(options, jobB);
    // A human's decision on its way to a commit is not overruled by a model's re-draft.
    expect(report.superseded).toBe(0);
    const after = proposals.rows.find((row) => row.id === approved.id);
    expect(after?.status).toBe('queued');
    expect(after?.decidedAt).not.toBeNull();
    expect(after?.evidence).toEqual(approved.evidence);
  });

  it('leaves another author’s proposal for the same page alone', async () => {
    const { options, proposals } = harness();
    await proposals.insert({} as never, [
      {
        id: '00000000-0000-4000-8000-0000000000b8' as Id,
        projectId: PROJECT,
        taskId: null,
        runId: null,
        source: 'task',
        kind: 'technical',
        type: 'doc-update',
        targetPath: OVERVIEW,
        delta: '# a Librarian page\n',
        evidence: ['from a retrospective'],
        significance: 0.5,
        status: 'queued',
        decidedByUserId: null,
        decidedAt: null,
        appliedCommitSha: null,
        createdAt: '2026-09-12T04:00:00.000Z' as StoredKnowledgeProposal['createdAt'],
      },
    ]);
    const report = await recordDiscoveryFindings(options, job);
    expect(report.superseded).toBe(0);
    expect(proposals.rows[0]?.status).toBe('queued');
  });

  /**
   * The canary (standing rule 3): with the queue read disarmed — `supersedeQueued` answering
   * nothing and touching nothing, which is what the recorder did before WP-109 — the same two
   * records leave two pending drafts of one page, and the check says so by name.
   */
  it('fails by name when the queue read is disarmed', async () => {
    const { options, proposals } = harness();
    const disarmed: DiscoveryRecordOptions = {
      ...options,
      proposals: { ...proposals, supersedeQueued: async () => [] },
    };
    await recordDiscoveryFindings(disarmed, job);
    const report = await recordDiscoveryFindings(disarmed, jobB);
    expect(report.superseded).toBe(0);
    expect(() => assertOnePendingPerPath(proposals.rows)).toThrow(
      `2 pending proposals for ${OVERVIEW}`,
    );
  });
});
