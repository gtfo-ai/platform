/**
 * The curation half of the Librarian pipeline — WP-18b.
 *
 * What is asserted here: which event asks for a curation, what the job writes, that the thresholds
 * decide the status, and that the redactor runs before anything is stored. What is **not** asserted
 * here is whether the queue's policy really collapses two wake-ups — `recordingJobs` applies no
 * policy at all (the same split `index-job.test.ts` states), so that question belongs to the
 * in-memory jobs adapter and to pg-boss.
 */
import type { DomainEvent, Id, LibrarianProposalsData } from '@platform/contracts';
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
import {
  type KnowledgeProposalsData,
  type LibrarianArtifact,
  type LibrarianJobOptions,
  librarianTriggerHandlers,
  recordLibrarianProposals,
} from './librarian.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000c3' as Id;
const ARTIFACT = '00000000-0000-4000-8000-0000000000c4' as Id;

/** Obviously fake, and planted so the redaction assertion has something to look for (rule 45). */
const PLANTED_SECRET = 'FAKE-model-credential-not-a-real-secret-0001';

const proposal = (overrides: Partial<LibrarianProposalsData['proposals'][number]> = {}) => ({
  action: 'add' as const,
  kind: 'technical' as const,
  type: 'lesson' as const,
  target_path: 'lessons/L-2026-09-12-locks.md',
  delta: '# take the lock inside the transaction\n',
  evidence: ['https://git.example.test/acme/api/-/merge_requests/7'],
  significance: 0.4,
  reason: 'nothing in the vault covers it',
  ...overrides,
});

const artifactData = (
  proposals: readonly ReturnType<typeof proposal>[],
): LibrarianProposalsData => ({
  proposals: [...proposals],
  health: [],
  summary: 'one page',
});

interface Harness {
  readonly options: LibrarianJobOptions;
  readonly proposals: ReturnType<typeof memoryProposalStore>;
  readonly jobs: ReturnType<typeof recordingJobs>;
  readonly eventing: MemoryEventing;
}

const harness = (
  options: {
    readonly data?: unknown;
    readonly autoApply?: boolean;
    readonly taskMode?: LibrarianArtifact['taskMode'];
    readonly indexedPaths?: readonly string[];
    readonly artifact?: LibrarianArtifact | null;
    readonly knowledgeDir?: string;
  } = {},
): Harness => {
  const proposalsStore = memoryProposalStore();
  const jobs = recordingJobs();
  const eventing = new MemoryEventing();
  const knowledge = memoryKnowledgeStore();
  return {
    proposals: proposalsStore,
    jobs,
    eventing,
    options: {
      unitOfWork: eventing,
      eventStore: eventing.store,
      proposals: proposalsStore,
      knowledge: {
        ...knowledge,
        readIndexedBlobs: async () =>
          new Map((options.indexedPaths ?? []).map((path) => [path, 'blob'])),
      },
      jobs,
      clock: fixedClock('2026-09-12T09:00:00.000Z'),
      ids: sequentialIds(700),
      redactor: exactSecretRedactor([{ name: 'model_key', value: PLANTED_SECRET }]),
      project: async () => ({
        knowledgeDir: options.knowledgeDir ?? '.agentic/knowledge',
        thresholds: knowledgeApplyThresholds({ auto_apply: options.autoApply ?? false }),
      }),
      artifact: async () =>
        options.artifact === undefined
          ? {
              data: (options.data ?? artifactData([proposal()])) as never,
              runId: RUN,
              taskMode: options.taskMode ?? 'normal',
            }
          : options.artifact,
      logger: silentLogger,
    },
  };
};

const job: KnowledgeProposalsData = {
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
    for (const handler of librarianTriggerHandlers({ jobs })) {
      if (handler.eventTypes === 'all' || handler.eventTypes.includes(event.type)) {
        await handler.handle(context);
      }
    }
    for (const callback of callbacks) await callback();
  };

  const artifactCreated = (artifactType: string): DomainEvent =>
    ({
      id: '00000000-0000-4000-8000-0000000000ff',
      stream_type: 'task',
      stream_id: TASK,
      stream_seq: 1,
      actor: { kind: 'system', component: 'test' },
      occurred_at: '2026-09-12T09:00:00.000Z',
      type: 'artifact.created',
      payload: {
        project_id: PROJECT,
        task_id: TASK,
        artifact: { id: ARTIFACT, artifact_type: artifactType, version: 1, url: null },
        produced_by_run_id: RUN,
      },
    }) as unknown as DomainEvent;

  it('asks for a curation when a LibrarianProposals artifact is stored', async () => {
    const jobs = recordingJobs();
    await dispatch(artifactCreated('LibrarianProposals'), jobs);
    const enqueued = jobs.take(JOB_QUEUES.knowledgeProposals);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.data).toEqual(job);
  });

  it('ignores every other artifact type', async () => {
    const jobs = recordingJobs();
    await dispatch(artifactCreated('RetroReport'), jobs);
    expect(jobs.enqueued).toEqual([]);
  });
});

describe('recording a librarian artifact', () => {
  it('writes a row per proposal and emits knowledge.proposal.created', async () => {
    const { options, proposals, eventing } = harness();
    const report = await recordLibrarianProposals(options, job);

    expect(report.status).toBe('recorded');
    expect(report.queued).toBe(1);
    expect(proposals.rows).toHaveLength(1);
    const row = proposals.rows[0];
    expect(row?.projectId).toBe(PROJECT);
    expect(row?.taskId).toBe(TASK);
    expect(row?.runId).toBe(RUN);
    expect(row?.source).toBe('task');
    // The **repository** path, joined onto the project's knowledge directory (BD-025).
    expect(row?.targetPath).toBe('.agentic/knowledge/lessons/L-2026-09-12-locks.md');
    expect(row?.status).toBe('queued');

    const stream = await eventing.store.readStream('project', PROJECT);
    expect(stream.map((entry) => entry.event.type)).toEqual(['knowledge.proposal.created']);
  });

  it('auto-applies inside the band when the project asked for it, and asks for a commit', async () => {
    const { options, proposals, jobs } = harness({ autoApply: true });
    const report = await recordLibrarianProposals(options, job);
    expect(report.autoApplied).toBe(1);
    expect(proposals.rows[0]?.status).toBe('auto_applied');
    expect(jobs.take(JOB_QUEUES.knowledgeApply)).toHaveLength(1);
  });

  it('does not ask for a commit when nothing was auto-applied', async () => {
    const { options, jobs } = harness();
    await recordLibrarianProposals(options, job);
    expect(jobs.enqueued).toEqual([]);
  });

  it('records a proposal below the discard threshold and applies nothing', async () => {
    const { options, proposals, jobs } = harness({
      autoApply: true,
      data: artifactData([proposal({ significance: 0.05 })]),
    });
    const report = await recordLibrarianProposals(options, job);
    expect(report.discarded).toBe(1);
    expect(proposals.rows[0]?.status).toBe('discarded');
    expect(jobs.enqueued).toEqual([]);
  });

  it('queues a shadow task’s proposal instead of applying it', async () => {
    const { options, proposals, jobs } = harness({ autoApply: true, taskMode: 'shadow' });
    await recordLibrarianProposals(options, job);
    expect(proposals.rows[0]?.status).toBe('queued');
    expect(jobs.enqueued).toEqual([]);
  });

  /**
   * TD-012 over the two sinks this text reaches, asserted in **both** directions: a recorder that
   * stored nothing and one that redacted everything look identical from one side (standing rule 42).
   */
  it('redacts the proposal text before it is stored', async () => {
    const { options, proposals } = harness({
      data: artifactData([
        proposal({
          delta: `# a page\n\nthe key is ${PLANTED_SECRET}\n`,
          evidence: [`seen in ${PLANTED_SECRET}`],
          reason: `because ${PLANTED_SECRET}`,
        }),
      ]),
    });
    const report = await recordLibrarianProposals(options, job);
    const stored = JSON.stringify(proposals.rows);
    expect(stored).not.toContain(PLANTED_SECRET);
    expect(stored).toContain('[REDACTED:integration:model_key]');
    expect(report.redactions).toBeGreaterThanOrEqual(3);
  });

  it('refuses a target path outside the vault and records the refusal', async () => {
    const { options, proposals, jobs } = harness({
      autoApply: true,
      data: artifactData([proposal({ target_path: '../../.github/workflows/ci.yml' })]),
    });
    await recordLibrarianProposals(options, job);
    expect(proposals.rows[0]?.status).toBe('discarded');
    expect(proposals.rows[0]?.targetPath).toBe('../../.github/workflows/ci.yml');
    expect(jobs.enqueued).toEqual([]);
  });

  it('turns an add into an update when the index already holds the page', async () => {
    const { options, proposals } = harness({
      autoApply: true,
      indexedPaths: ['.agentic/knowledge/lessons/L-2026-09-12-locks.md'],
    });
    await recordLibrarianProposals(options, job);
    // The action is not stored — the apply job re-derives it from the index — so what this asserts
    // is that a page the index has is still applied rather than refused as a duplicate.
    expect(proposals.rows[0]?.status).toBe('auto_applied');
  });

  it.each([
    ['the project has gone', { project: null }],
    ['the artifact has gone', { artifact: null }],
  ] as const)('records nothing when %s', async (_why, override) => {
    const { options, proposals } = harness('artifact' in override ? { artifact: null } : {});
    const withOverride: LibrarianJobOptions =
      'project' in override ? { ...options, project: async () => null } : options;
    const report = await recordLibrarianProposals(withOverride, job);
    expect(report.status).toBe('skipped');
    expect(report.reason).not.toBeNull();
    expect(proposals.rows).toEqual([]);
  });

  it('records nothing when the stored artifact does not match the schema', async () => {
    const { options, proposals } = harness({ data: { proposals: 'not an array' } });
    const report = await recordLibrarianProposals(options, job);
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('LibrarianProposals');
    expect(proposals.rows).toEqual([]);
  });
});
