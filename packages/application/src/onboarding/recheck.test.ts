/**
 * The readiness re-check job — WP-64 (PROGRESS backlog 46).
 *
 * What is asserted here is the job's **reads and write**: which evaluation it re-checks, which
 * commit the files are read at, what the CI window is, and that the row and the level land through
 * `ReadinessStore.record`. The fold's rules are `evaluate-readiness.test.ts`'s; that a *merged task*
 * produces a row is `test/e2e/onboarding/readiness-loop.e2e.test.ts`'s, because criterion 1 says the
 * trigger is asserted through the pipeline and never by calling this directly.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  fixedClock,
  READINESS_CI_WINDOW_DAYS,
  READINESS_TREE_PATHS,
  sequentialIds,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { RepositoryFileRequest, RepositoryFilesResult } from '../config/repository-config.js';
import { noSecretsRedactor } from '../integrations/redaction.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { memoryReadinessStore } from '../testing/memory-readiness.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { evaluateReadiness } from './evaluate-readiness.js';
import type { PlatformReadinessSignals } from './ports.js';
import {
  enqueueReadinessRecheck,
  type ReadinessRecheckData,
  type ReadinessRecheckOptions,
  recheckProjectReadiness,
  runReadinessRecheck,
  shouldRecheckAfterIndex,
} from './recheck.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const COMMIT = 'c'.repeat(40);
const NOW = '2026-09-27T04:00:00.000Z';

const data: ReadinessRecheckData = {
  kind: 'readiness_recheck',
  project_id: PROJECT,
  commit_sha: COMMIT,
};

const signals: PlatformReadinessSignals = {
  defaultBranchProtected: true,
  boundIntegrationTypes: [],
  indexedKnowledgePaths: [],
};

const harness = (
  options: {
    readonly files?: RepositoryFilesResult;
    readonly pipelines?: number;
    readonly project?: { readonly knowledgeDir: string } | null;
  } = {},
) => {
  const readiness = memoryReadinessStore();
  const reads: RepositoryFileRequest[] = [];
  const windows: IsoDateTime[] = [];
  const eventing = new MemoryEventing();
  const recheck: ReadinessRecheckOptions = {
    unitOfWork: eventing,
    eventStore: eventing.store,
    readiness,
    signals: { read: async () => signals },
    files: {
      read: async (request) => {
        reads.push(request);
        return (
          options.files ?? {
            status: 'ok',
            commitSha: COMMIT,
            files: {
              'CLAUDE.md': {
                kind: 'file',
                text: 'Read .agentic/knowledge/index.md first.\n',
                blobSha: 'b'.repeat(40),
              },
              'AGENTS.md': { kind: 'absent' },
            },
          }
        );
      },
    },
    ciEvents: {
      mergeRequestPipelinesSince: async (_projectId, since) => {
        windows.push(since);
        return options.pipelines ?? 0;
      },
    },
    clock: fixedClock(NOW),
    ids: sequentialIds(700),
    project: async () =>
      options.project === undefined ? { knowledgeDir: '.agentic/knowledge' } : options.project,
    logger: silentLogger,
  };
  return { readiness, reads, windows, recheck, eventing };
};

/** The discovery evaluation a re-check starts from: nothing but R1 and R3 claimed. */
const seedDiscovery = async (readiness: ReturnType<typeof memoryReadinessStore>) => {
  const { evaluation } = evaluateReadiness({
    id: '00000000-0000-4000-8000-0000000000e2' as Id,
    projectId: PROJECT,
    evaluatedAt: '2026-09-13T04:00:00.000Z' as IsoDateTime,
    source: 'discovery',
    agentClaims: [
      { id: 'R1', passed: true, evidence: 'ran npm test' },
      { id: 'R3', passed: false, evidence: 'no pipeline on merge requests' },
    ],
    signals,
    redactor: noSecretsRedactor(),
  });
  await readiness.record({} as never, evaluation);
  return evaluation;
};

describe('recheckProjectReadiness', () => {
  it('re-checks the latest evaluation at the merged commit and records a recheck row', async () => {
    const { readiness, reads, windows, recheck } = harness({ pipelines: 2 });
    const previous = await seedDiscovery(readiness);
    const report = await recheckProjectReadiness(recheck, data);

    expect(report).toMatchObject({ status: 'recorded', previousLevel: previous.level });
    expect(readiness.rows).toHaveLength(2);
    const row = readiness.rows[1];
    expect(row?.source).toBe('recheck');
    expect(row?.evaluatedAt).toBe(NOW);
    // The pair lands together: the projection moved with the row.
    expect(readiness.levels.get(PROJECT)).toBe(row?.level);
    // The files were read at the commit the index run read: R8's two, then R10's and R13's named
    // paths (WP-94) — one read, every path exact.
    expect(reads).toEqual([
      {
        projectId: PROJECT,
        paths: ['CLAUDE.md', 'AGENTS.md', ...READINESS_TREE_PATHS],
        commitSha: COMMIT,
      },
    ]);
    const r8 = row?.criteria.find((criterion) => criterion.id === 'R8');
    expect(r8?.passed).toBe(true);
    expect(r8?.evidence).toContain(`CLAUDE.md at ${COMMIT.slice(0, 12)}`);
    // R3 was failing, and the observed events pass it.
    expect(row?.criteria.find((criterion) => criterion.id === 'R3')?.passed).toBe(true);
    // The window is R4's thirty days back from the clock.
    expect(windows).toEqual([
      new Date(Date.parse(NOW) - READINESS_CI_WINDOW_DAYS * 24 * 60 * 60 * 1_000).toISOString(),
    ]);
  });

  it('appends one readiness.evaluated per recorded row, and none for a skip (backlog 228)', async () => {
    const { readiness, recheck, eventing } = harness({ pipelines: 2 });
    // A skip records nothing, so it says nothing.
    await recheckProjectReadiness(recheck, data);
    expect(await eventing.store.readStream('project', PROJECT)).toEqual([]);

    await seedDiscovery(readiness);
    await recheckProjectReadiness(recheck, data);
    const stream = await eventing.store.readStream('project', PROJECT);
    expect(stream.map((entry) => entry.event.type)).toEqual(['readiness.evaluated']);
    const row = readiness.rows[1];
    expect(stream[0]?.event.payload).toEqual({
      project_id: PROJECT,
      level: row?.level,
      criteria: row?.criteria.map(({ id, passed, evidence }) => ({ id, passed, evidence })),
      source: 'recheck',
    });
  });

  it('appends no event when the row does not commit', async () => {
    const { readiness, recheck, eventing } = harness();
    await seedDiscovery(readiness);
    const failing: ReadinessRecheckOptions = {
      ...recheck,
      readiness: {
        ...readiness,
        record: async () => {
          throw new Error('the row could not be written');
        },
      },
    };
    await expect(recheckProjectReadiness(failing, data)).rejects.toThrow('could not be written');
    expect(await eventing.store.readStream('project', PROJECT)).toEqual([]);
  });

  it('passes R10 and R13 from the files at the merged commit, and carries them when absent (WP-94)', async () => {
    const file = (text: string) => ({ kind: 'file' as const, text, blobSha: 'c'.repeat(40) });
    const withFiles = harness({
      files: {
        status: 'ok',
        commitSha: COMMIT,
        files: {
          'CLAUDE.md': { kind: 'absent' },
          'AGENTS.md': { kind: 'absent' },
          '.github/pull_request_template.md': file('## Summary\n'),
          '.commitlintrc.yml': file('extends: ["@commitlint/config-conventional"]\n'),
          '.pre-commit-config.yaml': file('repos:\n  - hooks:\n      - id: detect-secrets\n'),
        },
      },
    });
    await seedDiscovery(withFiles.readiness);
    await recheckProjectReadiness(withFiles.recheck, data);
    const passed = withFiles.readiness.rows[1]?.criteria;
    expect(passed?.find((criterion) => criterion.id === 'R10')).toMatchObject({
      passed: true,
      detectedBy: 'platform',
      evidence: `at ${COMMIT.slice(0, 12)}: the merge request template .github/pull_request_template.md and the commit convention .commitlintrc.yml are present`,
    });
    expect(passed?.find((criterion) => criterion.id === 'R13')?.evidence).toBe(
      `at ${COMMIT.slice(0, 12)}: .pre-commit-config.yaml runs detect-secrets`,
    );

    // The other way: the default harness's tree has neither, and the discovery answer (unreported,
    // so failing) is carried rather than re-decided.
    const without = harness();
    await seedDiscovery(without.readiness);
    await recheckProjectReadiness(without.recheck, data);
    for (const id of ['R10', 'R13']) {
      const row = without.readiness.rows[1]?.criteria.find((criterion) => criterion.id === id);
      expect(row?.passed, id).toBe(false);
      expect(row?.evidence, id).toContain('carried from the discovery evaluation');
    }
  });

  it('carries R8 when the mirror cannot be read, rather than failing it', async () => {
    const { readiness, recheck } = harness({
      files: { status: 'unavailable', reason: 'APP_KNOWLEDGE_MIRROR_ROOT is not set' },
    });
    await seedDiscovery(readiness);
    await recheckProjectReadiness(recheck, data);
    const r8 = readiness.rows[1]?.criteria.find((criterion) => criterion.id === 'R8');
    expect(r8?.passed).toBe(false);
    expect(r8?.evidence).toContain('carried from the discovery evaluation');
  });

  it('skips a project nobody has evaluated, so the 409 stays honest', async () => {
    const { readiness, recheck } = harness();
    const report = await recheckProjectReadiness(recheck, data);
    expect(report.status).toBe('skipped');
    expect(report.reason).toContain('never been evaluated');
    expect(readiness.rows).toHaveLength(0);
  });

  it('skips a project that no longer has a row', async () => {
    const { readiness, recheck } = harness({ project: null });
    await seedDiscovery(readiness);
    expect((await recheckProjectReadiness(recheck, data)).status).toBe('skipped');
    expect(readiness.rows).toHaveLength(1);
  });

  it('logs rather than throws on a skip, so pg-boss spends no retry on it', async () => {
    const { recheck } = harness();
    await expect(runReadinessRecheck(recheck, data)).resolves.toBeUndefined();
  });
});

describe('the trigger', () => {
  it('asks on the onboarding queue with a kind of its own', async () => {
    const jobs = recordingJobs();
    await enqueueReadinessRecheck(jobs, { projectId: PROJECT, commitSha: COMMIT });
    expect(jobs.enqueued).toEqual([
      expect.objectContaining({ queue: JOB_QUEUES.discoveryRecord, data }),
    ]);
  });

  it('follows an index run that read a new commit, whatever woke it', () => {
    // A merge collapsed into a queued task-start run is still a new commit, so it still re-checks;
    // a merge into another branch reads the same commit and re-checks nothing.
    expect(shouldRecheckAfterIndex({ status: 'indexed' })).toBe(true);
    expect(shouldRecheckAfterIndex({ status: 'unchanged' })).toBe(false);
    expect(shouldRecheckAfterIndex({ status: 'vault_unavailable' })).toBe(false);
  });
});
