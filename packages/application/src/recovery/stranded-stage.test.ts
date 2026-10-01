/**
 * The stranded-stage row of the lost-wake-up table — WP-108, PROGRESS backlog 320.
 *
 * Driven over the pipeline harness with the motivating case: a discovery task whose `stage.execute`
 * enqueue was lost (the harness's recording queue drops it, as a process dying after the commit
 * does). The store here is a fake **over the harness's own state** — the open stage row, the
 * recording queue's pending `stage.execute` jobs — because the predicate's SQL is the integration
 * tier's (`test/integration/recovery/stranded-stage-store.integration.test.ts`); what is asserted
 * here is what the pass does with what the store answers: one marked re-enqueue per stage entry,
 * then an escalation with a brief, and nothing at all for a row the live path reached first.
 */
import type { DiscoveryDraftData, Id, IsoDateTime, Slug } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { startProjectDiscovery } from '../onboarding/discovery.js';
import { staticProjectSettings } from '../pipeline/settings.js';
import type { StoredTask } from '../pipeline/store.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { silentLogger } from '../ports/logger.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { runStrandedRecovery, STRANDED_ENDING_AFTER_MS } from './stranded.js';
import {
  isDrivenStage,
  STRANDED_STAGE_COMPONENT,
  type StrandedStage,
  type StrandedStageRecoveryStore,
} from './stranded-stage.js';

const USER = '00000000-0000-4000-8000-0000000000c2' as Id;
const GRACE_MS = 60_000;

const DRAFT: DiscoveryDraftData = {
  documents: [],
  commands: [],
  linked_documents: [],
  questions: [],
  readiness: [{ id: 'R1', passed: true, evidence: 'ran the suite: green' }],
};

const none = async () => [];

/** A fake store over the harness: what the SQL asks, answered from the harness's own rows. */
const harnessStore = (
  harness: PipelineHarness,
  options: {
    readonly markRefused?: boolean;
    readonly stillStranded?: boolean;
    /** The attempt's ended run, as the SQL's lateral read answers it (WP-108 review round 1). */
    readonly endedRun?: StrandedStage['endedRun'];
  } = {},
) => {
  const marks = new Map<Id, IsoDateTime>();
  const entered = new Map<Id, IsoDateTime>();
  const calls: string[] = [];
  const stranded = (stored: StoredTask): StrandedStage | null => {
    const { task } = stored;
    const stage = task.currentStage;
    if (stage === null) return null;
    const attempt = task.stageAttempts[stage] ?? 1;
    const open = harness.store.stageRows.some(
      (row) =>
        row.taskId === task.id &&
        row.stage === stage &&
        row.attempt === attempt &&
        row.state === 'running' &&
        row.exitedAt === null,
    );
    const queued = harness.jobs.enqueued.some(
      (request) =>
        request.queue === JOB_QUEUES.stageExecute &&
        (request.data as { task_id?: string } | undefined)?.task_id === task.id,
    );
    if (!open || queued) return null;
    const enteredAt = entered.get(task.id) ?? stored.createdAt;
    const mark = marks.get(task.id) ?? null;
    return {
      taskId: task.id,
      projectId: task.projectId,
      stage,
      attempt,
      enteredAt,
      recoveryAttemptedAt: mark !== null && mark >= enteredAt ? mark : null,
      endedRun: options.endedRun ?? null,
    };
  };
  const store: StrandedStageRecoveryStore = {
    strandedStages: async (_tx, query) =>
      harness.store
        .snapshot()
        .map(stranded)
        .filter((row): row is StrandedStage => row !== null)
        .filter((row) =>
          row.recoveryAttemptedAt === null
            ? row.enteredAt < query.olderThan
            : row.recoveryAttemptedAt < query.endingBefore,
        )
        .slice(0, query.limit),
    markStageAttempt: async (_tx, input) => {
      calls.push(`mark:${input.row.taskId}`);
      if (options.markRefused === true) return false;
      marks.set(input.row.taskId, input.at);
      return true;
    },
    isStillStranded: async (_tx, row) =>
      options.stillStranded ?? stranded(await loaded(harness, row.taskId)) !== null,
  };
  return { store, calls, marks };
};

const loaded = async (harness: PipelineHarness, taskId: Id): Promise<StoredTask> => {
  const stored = await harness.store.tasks.load({} as never, taskId);
  expect(stored, `task ${taskId} exists`).not.toBeNull();
  return stored as StoredTask;
};

const setup = () => {
  const harness = createPipelineHarness({
    settings: { templates: SHIPPED_TEMPLATES },
    runs: {
      discovery: {
        status: 'completed',
        terminalReason: 'success',
        structuredOutput: DRAFT as never,
      },
    },
  });
  return { harness };
};

/**
 * Starts discovery and drops its stage wake-up — the commit landed, the enqueue did not.
 *
 * The discovery task enters its agent stage from the saga's `afterCommit` once intake's
 * `task.stage.completed` is dispatched, so the dispatch has to run; the `stage.execute` worker is
 * unsubscribed meanwhile so the wake-up waits in the recording queue to be dropped, and subscribed
 * again afterwards, as a process that restarts subscribes it.
 */
const lostDiscovery = async (harness: PipelineHarness): Promise<Id> => {
  await harness.drain();
  const worker = harness.jobs.handlers.get(JOB_QUEUES.stageExecute);
  expect(worker, 'the runtime subscribed stage.execute').toBeDefined();
  // The recording queue's map is the one `work` wrote; the type is read-only to every other caller.
  const handlers = harness.jobs.handlers as Map<string, NonNullable<typeof worker>>;
  handlers.delete(JOB_QUEUES.stageExecute);
  const started = await startProjectDiscovery(
    {
      unitOfWork: harness.memory,
      store: harness.store,
      settings: staticProjectSettings(() => harness.settings),
      jobs: harness.jobs,
      ids: harness.ids,
      clock: { now: () => harness.clock.now() },
      baseUrl: 'https://agentic.example.test',
      logger: silentLogger,
    },
    { projectId: harness.projectId, requestedByUserId: USER },
  );
  expect(started.status).toBe('started');
  await harness.drain();
  expect(harness.jobs.take(JOB_QUEUES.stageExecute), 'the one wake-up, dropped').toHaveLength(1);
  handlers.set(JOB_QUEUES.stageExecute, worker as NonNullable<typeof worker>);
  return (started as { readonly taskId: Id }).taskId;
};

const pass = (harness: PipelineHarness, store: StrandedStageRecoveryStore) =>
  runStrandedRecovery({
    store: {
      strandedBootstraps: none,
      markBootstrapAttempt: async () => {},
      endBootstrap: async () => {},
      strandedAsks: none,
      markAskAttempt: async () => {},
      endAsk: async () => {},
      strandedHistoryRecords: none,
      markHistoryRecordAttempt: async () => {},
      endHistoryRecord: async () => {},
      strandedCurations: none,
      markCurationAttempt: async () => {},
      endCuration: async () => {},
      asksWithEndedRun: none,
    },
    unitOfWork: harness.memory,
    jobs: harness.jobs,
    clock: harness.clock,
    graceMs: GRACE_MS,
    stages: {
      store,
      pipeline: harness.store,
      context: (correlationId) => ({
        ids: harness.ids,
        actor: { kind: 'system', component: STRANDED_STAGE_COMPONENT },
        clock: harness.clock,
        correlationId,
        causeEventId: null,
      }),
    },
  });

const siteOf = (report: Awaited<ReturnType<typeof pass>>) =>
  report.find((site) => site.site === 'stranded_stage');

describe('the stranded-stage row (WP-108, PROGRESS backlog 320)', () => {
  it('re-enqueues a discovery stage whose wake-up was lost, once, marked first — and the task then runs once', async () => {
    const { harness } = setup();
    const taskId = await lostDiscovery(harness);
    const { store, calls } = harnessStore(harness);

    // Inside the grace: the enqueue may still be on its way.
    harness.clock.advance(GRACE_MS - 1);
    expect(siteOf(await pass(harness, store))).toEqual({
      site: 'stranded_stage',
      found: 0,
      reEnqueued: 0,
      ended: 0,
    });

    harness.clock.advance(2);
    expect(siteOf(await pass(harness, store))).toEqual({
      site: 'stranded_stage',
      found: 1,
      reEnqueued: 1,
      ended: 0,
    });
    expect(calls).toEqual([`mark:${taskId}`]);
    const woken = harness.jobs.enqueued.filter((r) => r.queue === JOB_QUEUES.stageExecute);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      singletonKey: `task:${taskId}`,
      data: { task_id: taskId, project_id: harness.projectId, stage: 'discovery', attempt: 1 },
    });

    await harness.drain();
    expect(
      harness.specs.map((spec) => [spec.taskId, spec.stage]),
      'the discovery stage ran once after the recovery re-enqueued it',
    ).toEqual([[taskId, 'discovery']]);
    expect((await loaded(harness, taskId)).task.state).toBe('done');

    // Nothing left: the stage moved on.
    harness.clock.advance(STRANDED_ENDING_AFTER_MS + 1);
    expect(siteOf(await pass(harness, store))).toMatchObject({ found: 0, reEnqueued: 0 });
    expect(harness.specs).toHaveLength(1);
  });

  it('escalates with a brief when its one attempt did not take, and never re-enqueues the same entry twice', async () => {
    const { harness } = setup();
    const taskId = await lostDiscovery(harness);
    const { store } = harnessStore(harness);
    harness.clock.advance(GRACE_MS + 1);
    expect(siteOf(await pass(harness, store))).toMatchObject({ reEnqueued: 1 });
    // The re-enqueued wake-up is lost too.
    expect(harness.jobs.take(JOB_QUEUES.stageExecute)).toHaveLength(1);

    // A pass inside the ending window waits: the attempt is spent, the ending is not due.
    harness.clock.advance(GRACE_MS + 1);
    expect(siteOf(await pass(harness, store))).toMatchObject({ found: 0, reEnqueued: 0, ended: 0 });
    expect(harness.jobs.enqueued.filter((r) => r.queue === JOB_QUEUES.stageExecute)).toEqual([]);

    harness.clock.advance(STRANDED_ENDING_AFTER_MS);
    expect(siteOf(await pass(harness, store))).toEqual({
      site: 'stranded_stage',
      found: 1,
      reEnqueued: 0,
      ended: 1,
    });
    const task = (await loaded(harness, taskId)).task;
    expect(task.state, 'the stage nothing ran was escalated (backlog 320)').toBe('needs_human');
    const escalated = harness.events().filter((event) => event.type === 'task.escalated');
    expect(escalated).toHaveLength(1);
    const payload = (
      escalated[0] as Extract<(typeof escalated)[number], { type: 'task.escalated' }>
    ).payload;
    expect(payload.reason).toContain('"discovery" stage (attempt 1)');
    expect(payload.reason).toContain('re-enqueued it once');
    expect(payload.blocker_brief).toContain('hand the task back');
    expect(payload.blocker_brief).toContain('cancel it');
    expect(escalated[0]?.actor).toEqual({ kind: 'system', component: STRANDED_STAGE_COMPONENT });
    // The parked stage's row is closed with the escalation, as every escalation closes it.
    expect(
      harness.store.stageRows.find((row) => row.taskId === taskId && row.stage === 'discovery'),
    ).toMatchObject({ state: 'failed', outcome: 'escalated' });
    expect(harness.specs).toEqual([]);

    // And once: an escalated task is not at a stage anything drives.
    harness.clock.advance(STRANDED_ENDING_AFTER_MS + 1);
    expect(siteOf(await pass(harness, store))).toMatchObject({ found: 0, ended: 0 });
  });

  it.each([
    [
      { status: 'cancelled', terminalReason: 'cancelled' },
      'a person cancelled the run of this attempt',
    ],
    [
      { status: 'failed', terminalReason: 'lease_expired' },
      'the run of this attempt ended “failed”',
    ],
  ] as const)(
    'never re-enqueues an attempt whose run already ended (%o); it escalates at once, naming the ending (WP-108 review round 1)',
    async (endedRun, phrase) => {
      const { harness } = setup();
      const taskId = await lostDiscovery(harness);
      const { store, calls } = harnessStore(harness, { endedRun });
      harness.clock.advance(GRACE_MS + 1);
      expect(siteOf(await pass(harness, store))).toEqual({
        site: 'stranded_stage',
        found: 1,
        reEnqueued: 0,
        ended: 1,
      });
      expect(calls, 'no mark: an ended attempt is never attempted').toEqual([]);
      expect(
        harness.jobs.enqueued.filter((r) => r.queue === JOB_QUEUES.stageExecute),
        'a fresh paid run of a stage whose run ended (backlog 320, review round 1)',
      ).toEqual([]);
      expect(harness.specs).toEqual([]);
      expect((await loaded(harness, taskId)).task.state).toBe('needs_human');
      const escalated = harness.events().filter((event) => event.type === 'task.escalated');
      const payload = (
        escalated[0] as Extract<(typeof escalated)[number], { type: 'task.escalated' }>
      ).payload;
      expect(payload.blocker_brief).toContain(phrase);
      expect(payload.reason).toContain(
        `its run ended “${endedRun.status}” (${endedRun.terminalReason})`,
      );
    },
  );

  it('enqueues nothing when the mark finds the live path got there first (standing rule 9)', async () => {
    const { harness } = setup();
    await lostDiscovery(harness);
    const { store } = harnessStore(harness, { markRefused: true });
    harness.clock.advance(GRACE_MS + 1);
    expect(siteOf(await pass(harness, store))).toEqual({
      site: 'stranded_stage',
      found: 1,
      reEnqueued: 0,
      ended: 0,
    });
    expect(harness.jobs.enqueued.filter((r) => r.queue === JOB_QUEUES.stageExecute)).toEqual([]);
  });

  it('ends nothing when the stage started between the read and the ending', async () => {
    const { harness } = setup();
    const taskId = await lostDiscovery(harness);
    const { store } = harnessStore(harness, { stillStranded: false });
    harness.clock.advance(GRACE_MS + 1);
    await pass(harness, store);
    harness.jobs.take(JOB_QUEUES.stageExecute);
    harness.clock.advance(STRANDED_ENDING_AFTER_MS + GRACE_MS);
    expect(siteOf(await pass(harness, store))).toMatchObject({ found: 1, ended: 0 });
    expect((await loaded(harness, taskId)).task.state).toBe('active');
  });

  it('is absent from a pass whose composition did not opt in', async () => {
    const { harness } = setup();
    await lostDiscovery(harness);
    harness.clock.advance(GRACE_MS + 1);
    const report = await runStrandedRecovery({
      store: {
        strandedBootstraps: none,
        markBootstrapAttempt: async () => {},
        endBootstrap: async () => {},
        strandedAsks: none,
        markAskAttempt: async () => {},
        endAsk: async () => {},
        strandedHistoryRecords: none,
        markHistoryRecordAttempt: async () => {},
        endHistoryRecord: async () => {},
        strandedCurations: none,
        markCurationAttempt: async () => {},
        endCuration: async () => {},
        asksWithEndedRun: none,
      },
      unitOfWork: harness.memory,
      jobs: harness.jobs,
      clock: harness.clock,
      graceMs: GRACE_MS,
    });
    expect(report.find((site) => site.site === 'stranded_stage')).toBeUndefined();
  });
});

describe('isDrivenStage: the stage kinds stage.execute drives', () => {
  const row = (stage: string, attempt = 1): StrandedStage => ({
    taskId: 'task' as Id,
    projectId: 'project' as Id,
    stage: stage as Slug,
    attempt,
    enteredAt: '2026-09-20T10:00:00.000Z' as IsoDateTime,
    recoveryAttemptedAt: null,
    endedRun: null,
  });
  const at = async (stage: string, state: StoredTask['task']['state'] = 'active') => {
    const { harness } = setup();
    const taskId = await lostDiscovery(harness);
    const stored = await loaded(harness, taskId);
    return {
      ...stored,
      template: SHIPPED_TEMPLATES.feature ?? null,
      task: {
        ...stored.task,
        template: 'feature',
        state,
        currentStage: stage as Slug,
        stageAttempts: { [stage]: 1 },
      },
    } as StoredTask;
  };

  it.each([
    ['implementation', 'an agent stage'],
    ['rebase_gate', 'a gate'],
  ])('drives %s (%s)', async (stage) => {
    expect(isDrivenStage(await at(stage), row(stage))).toBe(true);
  });

  it('leaves a human stage and a system stage alone, whatever their state says', async () => {
    expect(isDrivenStage(await at('ready_for_merge'), row('ready_for_merge'))).toBe(false);
    expect(isDrivenStage(await at('done'), row('done'))).toBe(false);
  });

  it('leaves a task that moved: another stage, another attempt, or a stop a human owns', async () => {
    expect(isDrivenStage(await at('implementation'), row('review'))).toBe(false);
    expect(isDrivenStage(await at('implementation'), row('implementation', 2))).toBe(false);
    expect(isDrivenStage(await at('implementation', 'paused'), row('implementation'))).toBe(false);
    expect(isDrivenStage(null, row('implementation'))).toBe(false);
  });
});

describe('stage.execute refuses an attempt whose stage row is closed (WP-108 review round 1, backlog 365)', () => {
  const fire = async (harness: PipelineHarness, taskId: Id) => {
    const handler = harness.jobs.handlers.get(JOB_QUEUES.stageExecute);
    expect(handler, 'the runtime subscribed stage.execute').toBeDefined();
    await handler?.({
      id: 'late-wake-up',
      queue: JOB_QUEUES.stageExecute,
      data: { task_id: taskId, project_id: harness.projectId, stage: 'discovery', attempt: 1 },
      signal: AbortSignal.abort(),
    });
  };

  it('starts the run while the row is open (the control)', async () => {
    const { harness } = setup();
    const taskId = await lostDiscovery(harness);
    await fire(harness, taskId);
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['discovery']);
  });

  it('starts no second run for a late wake-up once the attempt’s row is closed', async () => {
    const { harness } = setup();
    const taskId = await lostDiscovery(harness);
    // What a completed run's transaction 2 leaves before the saga moves the task on: the task at
    // the same stage on the same attempt, its row closed.
    await harness.store.tasks.recordStageExited({} as never, {
      taskId,
      stage: 'discovery' as Slug,
      attempt: 1,
      state: 'completed',
      outcome: 'pass',
      returnReason: null,
      returnedTo: null,
    });
    await fire(harness, taskId);
    expect(harness.specs, 'a late stage.execute started a second run of an ended attempt').toEqual(
      [],
    );
    expect((await loaded(harness, taskId)).task.state).toBe('active');
  });
});
