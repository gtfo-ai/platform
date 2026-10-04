/**
 * **A run its own process stopped is handed back** — WP-144, PROGRESS backlog 432.
 *
 * The runner's stop (`LiveRuns.stopAll({ reason: 'shutdown' })`, `live-runs.test.ts`) interrupts the
 * session, and the real runner then ends the outcome `failed` with the terminal reason `shutdown`
 * (`claude-runner.ts`' `STOP_STATUS`/`STOP_REASON`). These cases script that outcome and drive the
 * real stage executor and the real `stage.execute` handler through the pipeline harness, so what is
 * asserted is the ending: the run's row, the task, the re-enqueued job, the ledger, and the bound.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { askingRefinedSpec } from '../testing/artifact-fixtures.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import { SHUTDOWN_HAND_BACK_DELAY_MS } from './jobs.js';
import { MAX_SHUTDOWN_HAND_BACKS } from './stage-executor.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: {
        provider: 'fake-jira',
        key: 'ACME-1',
        url: 'https://jira.example.test/browse/ACME-1',
      },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** What the runner's `shutdown` stop reports when the interrupted turn's result was read. */
const HANDED_BACK = {
  status: 'failed',
  terminalReason: 'shutdown',
  costUsd: 0.3,
  error: 'the platform stopped the run: shutdown',
  stopReason: 'shutdown',
} as const;

const harnessWith = (options: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    runs: { refinement: HANDED_BACK },
    ...options,
  });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const stageJobs = (harness: PipelineHarness) =>
  harness.jobs.enqueued.filter((request) => request.queue === 'stage.execute');

const runOf = async (harness: PipelineHarness, runId: Id) =>
  harness.memory.transaction(async (scope) => harness.store.runs.load(scope.tx, runId));

const refinementRunIds = (harness: PipelineHarness): Id[] =>
  harness.specs.filter((spec) => spec.stage === 'refinement').map((spec) => spec.runId as Id);

describe('a stage run handed back by its runner’s stop (WP-144)', () => {
  it('ends the run failed/shutdown, leaves the task at its stage, and re-enqueues the same entry 30 s later', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);

    const task = taskOf(harness);
    expect(task.task.state).toBe('active');
    expect(task.task.currentStage).toBe('refinement');
    expect(harness.types()).not.toContain('task.escalated');

    const [runId] = refinementRunIds(harness);
    const run = await runOf(harness, runId as Id);
    expect(run?.status).toBe('failed');
    expect(run?.terminalReason).toBe('shutdown');
    const failed = harness.events().find((entry) => entry.type === 'run.failed') as Extract<
      DomainEvent,
      { type: 'run.failed' }
    >;
    expect(failed.payload.terminal_reason).toBe('shutdown');

    const queued = stageJobs(harness);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toEqual({
      task_id: task.task.id,
      project_id: PROJECT,
      stage: 'refinement',
      attempt: task.task.stageAttempts.refinement,
    });
    expect(queued[0]?.startAfter?.getTime()).toBe(
      harness.clock.epochMs + SHUTDOWN_HAND_BACK_DELAY_MS,
    );
  });

  it('starts a new run of the same stage when the job fires, and the task never needs a human', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    harness.script('refinement', {
      status: 'completed',
      terminalReason: 'success',
      structuredOutput: askingRefinedSpec(),
      costUsd: 0.2,
    });

    // Not before its time: a drain at the same instant runs nothing.
    await harness.drain();
    expect(refinementRunIds(harness)).toHaveLength(1);

    harness.clock.advance(SHUTDOWN_HAND_BACK_DELAY_MS);
    await harness.drain();

    const runs = refinementRunIds(harness);
    expect(runs).toHaveLength(2);
    expect(
      harness.specs.filter((spec) => spec.stage === 'refinement').map((s) => s.attempt),
    ).toEqual([1, 1]);
    expect(taskOf(harness).task.state).toBe('waiting_answers');
    expect(harness.types()).not.toContain('task.escalated');
    // The spend of both runs, each once.
    expect(taskOf(harness).costActualUsd).toBeCloseTo(0.5, 6);
  });

  it('escalates the third stop, with a brief naming the stops, and queues nothing more', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);

    const states: string[] = [taskOf(harness).task.state];
    for (let round = 0; round < MAX_SHUTDOWN_HAND_BACKS; round += 1) {
      harness.clock.advance(SHUTDOWN_HAND_BACK_DELAY_MS);
      await harness.drain();
      states.push(taskOf(harness).task.state);
    }

    expect(states).toEqual(['active', 'active', 'needs_human']);
    const escalated = harness.events().find((entry) => entry.type === 'task.escalated') as Extract<
      DomainEvent,
      { type: 'task.escalated' }
    >;
    expect(escalated.payload.reason).toContain('stopped during this stage 3 times');
    expect(escalated.payload.blocker_brief).toContain('interrupted 3 times');
    expect(escalated.payload.blocker_brief).toContain('The first 2 were started again');
    // Every one of the three runs reads `shutdown`; the third is the one that escalated.
    for (const runId of refinementRunIds(harness)) {
      expect((await runOf(harness, runId))?.terminalReason).toBe('shutdown');
    }
    expect(refinementRunIds(harness)).toHaveLength(3);
    expect(harness.jobs.history.filter((r) => r.queue === 'stage.execute')).toHaveLength(3);
    expect(stageJobs(harness)).toHaveLength(0);
  });

  it('counts per stage entry: a new attempt of the stage starts a new count', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);
    const counted = async (attempt: number) =>
      harness.memory.transaction(async (scope) =>
        harness.store.runs.shutdownEndings(scope.tx, {
          taskId: task.task.id,
          stage: 'refinement',
          attempt,
        }),
      );
    expect(await counted(1)).toBe(1);
    expect(await counted(2)).toBe(0);
  });

  it('does not re-run a stage whose task a person paused during the stop (a cancel stands)', async () => {
    const harness = harnessWith();
    const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
    const real = repository.insert.bind(harness.store.runs);
    repository.insert = async (tx, run) => {
      await real(tx, run);
      const [stored] = harness.store.snapshot();
      if (stored !== undefined && stored.task.state === 'active') {
        // What a person's cancel writes beside a live lease: the task is paused (WP-101).
        await harness.store.tasks.save(tx, {
          ...stored,
          task: { ...stored.task, state: 'paused' },
        });
      }
    };
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('paused');
    expect(stageJobs(harness)).toHaveLength(0);
    const [runId] = refinementRunIds(harness);
    expect((await runOf(harness, runId as Id))?.terminalReason).toBe('shutdown');
    harness.clock.advance(SHUTDOWN_HAND_BACK_DELAY_MS);
    await harness.drain();
    expect(refinementRunIds(harness)).toHaveLength(1);
  });

  it('starts no second run when the entry ended before the handed-back job fires (TD-004)', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    // The stage entry is closed by something else before the timer: a person cancels the task.
    const stored = taskOf(harness);
    await harness.memory.transaction(async (scope) =>
      harness.store.tasks.save(scope.tx, {
        ...stored,
        task: { ...stored.task, state: 'cancelled' },
      }),
    );
    harness.clock.advance(SHUTDOWN_HAND_BACK_DELAY_MS);
    await harness.drain();
    expect(refinementRunIds(harness)).toHaveLength(1);
  });
});

/**
 * WP-144 canaries (4): the money of a handed-back run is counted once, and its first run is over
 * before a second exists.
 */
describe('the canaries of a hand-back (WP-144)', () => {
  it('charges a handed-back run once, not late, and the next run separately', async () => {
    const harness = harnessWith({ cost: true });
    await harness.publish([ticketMatched()]);
    const ledger = harness.cost;
    if (ledger === null) {
      throw new Error('the harness was asked for the ledger and composed none');
    }
    const [first] = refinementRunIds(harness);
    const firstEntries = ledger.entries.filter((entry) => entry.runId === first);
    expect(firstEntries.reduce((sum, entry) => sum + entry.usd, 0)).toBeCloseTo(0.3, 6);
    expect(firstEntries.every((entry) => !entry.late)).toBe(true);

    harness.script('refinement', {
      status: 'completed',
      terminalReason: 'success',
      structuredOutput: askingRefinedSpec(),
      costUsd: 0.2,
    });
    harness.clock.advance(SHUTDOWN_HAND_BACK_DELAY_MS);
    await harness.drain();

    // Still once: the second run's ending did not charge the first again.
    expect(
      ledger.entries
        .filter((entry) => entry.runId === first)
        .reduce((sum, entry) => sum + entry.usd, 0),
    ).toBeCloseTo(0.3, 6);
    expect(ledger.entries.reduce((sum, entry) => sum + entry.usd, 0)).toBeCloseTo(0.5, 6);
  });

  it('writes no figure and no ledger row for a hand-back whose stop measured nothing (rule 16)', async () => {
    const harness = harnessWith({
      cost: true,
      runs: { refinement: { ...HANDED_BACK, costUnmeasured: true } },
    });
    await harness.publish([ticketMatched()]);
    const [runId] = refinementRunIds(harness);
    const run = await runOf(harness, runId as Id);
    expect(run?.terminalReason).toBe('shutdown');
    expect(run?.cost).toBeNull();
    expect(harness.cost?.entries).toEqual([]);
    expect(taskOf(harness).costActualUsd).toBe(0);
    // Still handed back: a run nobody measured is retried like one somebody did.
    expect(stageJobs(harness)).toHaveLength(1);
  });

  it('ends the first run before the second exists: the re-enqueued job finds no live run', async () => {
    const harness = harnessWith();
    let liveAtSecondStart: string | null = null;
    const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
    const real = repository.insert.bind(harness.store.runs);
    repository.insert = async (tx, run) => {
      const [earlier] = refinementRunIds(harness);
      if (earlier !== undefined) {
        liveAtSecondStart = (await harness.store.runs.load(tx, earlier))?.status ?? null;
      }
      await real(tx, run);
    };
    await harness.publish([ticketMatched()]);
    harness.clock.advance(SHUTDOWN_HAND_BACK_DELAY_MS);
    await harness.drain();

    expect(refinementRunIds(harness)).toHaveLength(2);
    expect(liveAtSecondStart).toBe('failed');
  });
});
