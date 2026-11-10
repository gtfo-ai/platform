/**
 * **The `ci_play_manual` duty** (S-28.7, the M28 ruling): it starts a manual job the project set to
 * `run` — and only after re-validating on fire that the task is still at this `ci_gate` attempt,
 * the live head is the one judged, that head's latest pipeline is the one named, the job is still
 * `manual` and not a trigger job, and the settings still say `run`. One play per job id across
 * replays (the executor's idempotency key), a `403` recorded as `refused` (the job falls back to a
 * person), a binding without the capability recorded as `unsupported`. Through the real executor
 * and the real memory store; the git double records what it was asked.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { GitProviderPort, PipelineStatus } from '../ports/integrations/git-provider.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
} from '../testing/memory-integrations.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { withCiManualStartedEntry } from './ci-manual-started.js';
import { ciPlayIdempotencyKey, enqueueCiPlays, runCiPlayManual } from './ci-play.js';
import { staticPipelineIntegrations } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import { defaultProjectSettings, staticProjectSettings } from './settings.js';
import type { StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const HEAD = 'b'.repeat(40);
const MR = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: 'https://git.example.test/acme/api/-/merge_requests/7',
  branch: 'agentic/ACME-1',
  head_sha: HEAD,
};

type Job = PipelineStatus['jobs'][number];
const job = (id: string, name: string, status: Job['status'], extra: Partial<Job> = {}): Job => ({
  id,
  name,
  status,
  stage: 'test',
  allow_failure: false,
  web_url: `https://git.example.test/acme/api/-/jobs/${id}`,
  ...extra,
});

const world = async (
  options: {
    readonly mode?: 'normal' | 'shadow';
    readonly manualJobs?: Readonly<Record<string, 'run' | 'wait' | 'ignore'>>;
    readonly jobs?: readonly Job[];
    readonly play?: 'ok' | 'forbidden' | 'invalid_request' | 'unavailable';
    readonly capable?: boolean;
    readonly liveHead?: string;
    readonly configRefusal?: string;
    /** The provider keeps reporting a played job `manual` (it is slow to say). */
    readonly sticky?: boolean;
  } = {},
) => {
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  await memory.transaction(async (scope) => {
    await store.tasks.insert(scope.tx, {
      task: {
        id: TASK,
        projectId: PROJECT,
        ticket: { provider: 'fake-jira', key: 'ACME-1', url: 'https://jira.example.test/ACME-1' },
        template: 'feature',
        mode: options.mode ?? 'normal',
        state: 'active',
        currentStage: 'ci_gate',
        stageAttempts: { implementation: 1, ci_gate: 2 },
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
      branch: 'agentic/ACME-1',
      mr: MR,
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
      qaStage: false,
      ticketSnapshotAt: null,
      ticketSignalAt: null,
      version: 1,
    } as unknown as StoredTask);
    for (const attempt of [1, 2]) {
      await store.tasks.recordStageEntered(scope.tx, {
        taskId: TASK,
        stage: 'ci_gate',
        attempt,
        causedByEventId: null,
      });
    }
  });
  const jobs = [
    ...(options.jobs ?? [
      job('9071', 'build_composer', 'manual', { stage: 'build-deps' }),
      job('9072', 'codeception', 'pending'),
    ]),
  ];
  const played: string[] = [];
  const port = {
    ref: {
      integrationId: '00000000-0000-4000-8000-00000000a001',
      provider: 'fake-git',
      type: 'git',
    },
    capabilities: () => ({ manualJobPlay: options.capable ?? true }),
    getMergeRequest: async () => ({
      ref: { ...MR, head_sha: options.liveHead ?? HEAD },
      state: 'opened',
      draft: true,
      title: 'Draft: Sum the footer',
      description: '',
      source_branch: MR.branch,
      target_branch: 'develop',
      head_sha: options.liveHead ?? HEAD,
      labels: [],
      reviewers: [],
      web_url: MR.url,
    }),
    getPipelineStatus: async () => ({
      id: '907',
      head_sha: HEAD,
      status: 'manual',
      url: null,
      jobs: jobs.map((each) => ({ ...each })),
      coverage_pct: null,
      finished_at: null,
    }),
    playJob: async (_project: string, jobId: string) => {
      played.push(jobId);
      const play = options.play ?? 'ok';
      if (play !== 'ok') {
        throw new IntegrationError(play, 'fake-git', `the provider answered ${play}`, {
          action: 'play_job',
        });
      }
      const index = jobs.findIndex((each) => each.id === jobId);
      const found = jobs[index];
      if (found !== undefined && options.sticky !== true) {
        jobs[index] = { ...found, status: 'pending' };
      }
      return { id: jobId, status: 'pending' };
    },
  } as unknown as GitProviderPort;
  const auditLog = createMemoryAuditLog();
  const enqueued: { queue: string; data: PipelineOutboundData }[] = [];
  const options_ = {
    unitOfWork: memory,
    store,
    jobs: {
      enqueue: async (request: { queue: string; data: PipelineOutboundData }) => {
        enqueued.push(request);
        return { status: 'created', id: String(enqueued.length) };
      },
    },
    clock: { now: () => '2026-11-10T09:00:00.000Z' },
    settings: staticProjectSettings((projectId) => ({
      ...defaultProjectSettings(projectId, {
        ...(options.manualJobs === undefined
          ? {}
          : { config: { pipeline: { ci: { manual_jobs: { ...options.manualJobs } } } } }),
      }),
      ...(options.configRefusal === undefined ? {} : { configRefusal: options.configRefusal }),
    })),
    integrations: staticPipelineIntegrations({
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog,
        idempotencyStore: createMemoryIdempotencyStore(),
        redactor: exactSecretRedactor([]),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: { now: () => '2026-11-10T09:00:00.000Z' as IsoDateTime },
      }),
      git: { port, ref: port.ref, project: 'acme/api', redactor: exactSecretRedactor([]) },
      taskManagement: null,
      communication: null,
    }),
  } as unknown as Parameters<typeof runCiPlayManual>[0];
  const data = (overrides: Partial<PipelineOutboundData> = {}): PipelineOutboundData => ({
    duty: 'ci_play_manual',
    project_id: PROJECT,
    task_id: TASK,
    cause_event_id: 'ci_gate:test',
    stage: 'ci_gate',
    ci_attempt: 2,
    head_sha: HEAD,
    ci_pipeline_id: '907',
    ci_job_id: '9071',
    ...overrides,
  });
  const recorded = () =>
    memory.transaction(async (scope) =>
      store.tasks.ciManualStartedOf(scope.tx, TASK, 'ci_gate', 2),
    );
  return {
    run: (overrides?: Partial<PipelineOutboundData>) => runCiPlayManual(options_, data(overrides)),
    options: options_,
    played,
    auditLog,
    enqueued,
    recorded,
    store,
    memory,
  };
};

const RUN_BUILD = { build_composer: 'run' } as const;

describe('the ci_play_manual duty (S-28.7)', () => {
  it('starts a job the project set to run and records it started on the attempt', async () => {
    const { run, played, recorded, auditLog } = await world({ manualJobs: RUN_BUILD });
    expect(await run()).toBe('started');
    expect(played).toEqual(['9071']);
    expect(await recorded()).toEqual([
      {
        job_id: '9071',
        pipeline_id: '907',
        name: 'build_composer',
        url: 'https://git.example.test/acme/api/-/jobs/9071',
        at: '2026-11-10T09:00:00.000Z',
        outcome: 'started',
      },
    ]);
    // Through the executor, as every mutation is.
    expect(auditLog.entriesFor('play_job').map((entry) => entry.status)).toEqual(['ok']);
  });

  it('plays a job at most once per job id across replays: the executor replays its first answer', async () => {
    // The provider is slow to say the job started, so a repeated wake-up still reads it manual.
    const w = await world({ manualJobs: RUN_BUILD, sticky: true });
    expect(await w.run()).toBe('started');
    expect(await w.run()).toBe('started');
    expect(await w.run()).toBe('started');
    expect(w.played, 'one play per job id').toEqual(['9071']);
    expect(w.auditLog.entriesFor('play_job').map((entry) => entry.status)).toEqual([
      'ok',
      'replayed',
      'replayed',
    ]);
    expect(ciPlayIdempotencyKey(TASK, '907', '9071')).toBe(`ci_play:${TASK}:907:9071`);
  });

  it('a job the provider already shows started is not played again', async () => {
    const w = await world({ manualJobs: RUN_BUILD });
    expect(await w.run()).toBe('started');
    expect(await w.run()).toBe('not_manual');
    expect(w.played).toEqual(['9071']);
  });

  it('re-validates on fire: another attempt, another head, another pipeline, a job no longer run', async () => {
    const base = await world({ manualJobs: RUN_BUILD });
    expect(await base.run({ ci_attempt: 1 }), 'an attempt the task left').toBe('moved_on');
    expect(await base.run({ stage: 'rebase_gate' }), 'another stage').toBe('invalid_payload');
    expect(await base.run({ ci_pipeline_id: '908' }), 'not the head’s latest').toBe(
      'pipeline_moved',
    );
    expect(await base.run({ ci_job_id: '9072' }), 'a job that is not manual').toBe('not_manual');
    expect(base.played).toEqual([]);
    const moved = await world({ manualJobs: RUN_BUILD, liveHead: 'c'.repeat(40) });
    expect(await moved.run()).toBe('head_moved');
    const wait = await world({ manualJobs: { build_composer: 'wait' } });
    expect(await wait.run(), 'the settings no longer say run').toBe('not_run');
    const none = await world();
    expect(await none.run(), 'no choice at all: never played').toBe('not_run');
    const refused = await world({ manualJobs: RUN_BUILD, configRefusal: 'cannot parse' });
    expect(await refused.run(), 'a configuration that cannot be read').toBe('not_run');
    for (const each of [moved, wait, none, refused]) expect(each.played).toEqual([]);
  });

  it('refuses a payload whose ids are not digits — no provider text reaches the key', async () => {
    const { run, played } = await world({ manualJobs: RUN_BUILD });
    expect(await run({ ci_job_id: 'build_composer' })).toBe('invalid_payload');
    expect(await run({ ci_pipeline_id: 'p-1' })).toBe('invalid_payload');
    expect(played).toEqual([]);
  });

  it('never plays a trigger job', async () => {
    const { run, played } = await world({
      manualJobs: { 'deploy:tenants:hetzner': 'run' },
      jobs: [job('9071', 'deploy:tenants:hetzner', 'manual', { trigger: true })],
    });
    expect(await run()).toBe('not_manual');
    expect(played).toEqual([]);
  });

  it('records refused on a 403: the job falls back to a person', async () => {
    const { run, played, recorded } = await world({ manualJobs: RUN_BUILD, play: 'forbidden' });
    expect(await run()).toBe('refused');
    expect(played).toEqual(['9071']);
    expect((await recorded())?.map((entry) => entry.outcome)).toEqual(['refused']);
  });

  it('records unsupported, and calls nothing, on a binding that cannot start a manual job', async () => {
    const { run, played, recorded } = await world({ manualJobs: RUN_BUILD, capable: false });
    expect(await run()).toBe('unsupported');
    expect(played).toEqual([]);
    expect((await recorded())?.map((entry) => entry.outcome)).toEqual(['unsupported']);
  });

  it('records nothing for a job the provider will not play any more, and rethrows an outage', async () => {
    const gone = await world({ manualJobs: RUN_BUILD, play: 'invalid_request' });
    expect(await gone.run()).toBe('not_playable');
    expect(await gone.recorded()).toBeNull();
    const outage = await world({ manualJobs: RUN_BUILD, play: 'unavailable' });
    await expect(outage.run()).rejects.toThrow(IntegrationError);
    expect(await outage.recorded()).toBeNull();
  });

  it('asks nothing of the provider for a shadow task', async () => {
    const { run, played, recorded } = await world({ manualJobs: RUN_BUILD, mode: 'shadow' });
    expect(await run()).toBe('shadow');
    expect(played).toEqual([]);
    expect(await recorded()).toBeNull();
  });
});

describe('enqueueCiPlays (S-28.7)', () => {
  const request = {
    taskId: TASK,
    projectId: PROJECT,
    attempt: 2,
    mode: 'normal' as const,
    headSha: HEAD,
    pipelineId: '907',
    jobs: [
      { id: '9071', name: 'build_composer' },
      { id: 'x-1', name: 'codeception' },
    ],
  };

  it('enqueues one wake-up per job this attempt has not recorded, and none for a non-digit id', async () => {
    const w = await world({ manualJobs: RUN_BUILD });
    const first = await enqueueCiPlays(w.options, request, 'cause');
    expect([...first.owed]).toEqual(['9071']);
    expect(first.recorded).toBeNull();
    expect(w.enqueued).toHaveLength(1);
    expect(w.enqueued[0]?.queue).toBe(JOB_QUEUES.pipelineOutbound);
    expect(w.enqueued[0]?.data).toMatchObject({
      duty: 'ci_play_manual',
      ci_attempt: 2,
      ci_pipeline_id: '907',
      ci_job_id: '9071',
      head_sha: HEAD,
    });
    // Once the attempt records the job (started, refused or unsupported) it is not offered again,
    // and the record comes back for the wait's words.
    expect(await w.run()).toBe('started');
    const again = await enqueueCiPlays(w.options, request, 'cause');
    expect([...again.owed]).toEqual([]);
    expect(again.recorded?.map((entry) => entry.outcome)).toEqual(['started']);
    expect(w.enqueued).toHaveLength(1);
    expect([
      ...(await enqueueCiPlays(w.options, { ...request, pipelineId: 'p-1' }, 'cause')).owed,
    ]).toEqual([]);
  });

  it('offers a trial task nothing: its play would record nothing, so every poll would offer it again', async () => {
    const w = await world({ manualJobs: RUN_BUILD, mode: 'shadow' });
    const answer = await enqueueCiPlays(w.options, { ...request, mode: 'shadow' }, 'cause');
    expect([...answer.owed]).toEqual([]);
    expect(w.enqueued).toEqual([]);
  });
});

describe('the record’s bound (S-28.7)', () => {
  it('drops the oldest started entry at 50, keeps every refusal, and skips a write with no room', async () => {
    const entry = (id: number, outcome: 'started' | 'refused') => ({
      job_id: String(id),
      pipeline_id: '907',
      name: `job-${String(id)}`,
      url: null,
      at: '2026-11-10T09:00:00.000Z',
      outcome,
    });
    const full = Array.from({ length: 50 }, (_, index) =>
      entry(index + 1, index === 0 ? 'started' : 'refused'),
    );
    const next = withCiManualStartedEntry(full, entry(51, 'started'));
    expect(next).toHaveLength(50);
    expect(
      next?.some((each) => each.job_id === '1'),
      'the oldest played entry went',
    ).toBe(false);
    expect(next?.filter((each) => each.outcome === 'refused')).toHaveLength(49);
    const refusals = Array.from({ length: 50 }, (_, index) => entry(index + 1, 'refused'));
    expect(withCiManualStartedEntry(refusals, entry(51, 'started'))).toBeNull();
    // Replacing an existing id needs no room.
    expect(withCiManualStartedEntry(refusals, entry(1, 'started'))).toHaveLength(50);
  });
});
