/**
 * **A run that ended before the model took a single turn is re-planned, not escalated** — BD-034
 * (the product owner's rule of 2026-11-26: anything the platform can recover from by itself must not
 * reach a person). Measured on fontai's GO-705: `refinement` ended four times `error_during_execution`
 * with zero turns while the worker was not ready, and every one of them parked the task.
 *
 * These cases script that outcome and drive the real stage executor, the real `settleRun` and the
 * real `stage.execute` handler through the pipeline harness: the run's row, the task, the
 * re-enqueued job and its delay, the spend, and the bound with its brief.
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
import { isTurnlessFailure, MAX_TURNLESS_REPLANS, turnlessReplanDelayMs } from './settle.js';

const PROJECT = '00000000-0000-4000-8000-0000000002b6';
const MINUTE = 60_000;

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000705',
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
        key: 'ACME-705',
        url: 'https://jira.example.test/browse/ACME-705',
      },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** What the runner reports for a CLI that gave up before the model answered: zero turns. */
const TURNLESS = {
  status: 'failed',
  terminalReason: 'error_during_execution',
  costUsd: 0,
  numTurns: 0,
  error: 'API Error: Connection error (no route to the model)',
} as const;

const harnessWith = (options: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({ projectId: PROJECT, runs: { refinement: TURNLESS }, ...options });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) throw new Error('no task was created');
  return stored;
};

const refinementRunIds = (harness: PipelineHarness): Id[] =>
  harness.specs.filter((spec) => spec.stage === 'refinement').map((spec) => spec.runId as Id);

const runOf = async (harness: PipelineHarness, runId: Id) =>
  harness.memory.transaction(async (scope) => harness.store.runs.load(scope.tx, runId));

const stageJobs = (harness: PipelineHarness) =>
  harness.jobs.enqueued.filter((request) => request.queue === 'stage.execute');

/** The script every run from the `after`-th on plays (the harness scripts a stage, not a run). */
const scriptFrom = (
  harness: PipelineHarness,
  after: number,
  next: Parameters<PipelineHarness['script']>[1],
) => {
  const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
  const real = repository.insert.bind(harness.store.runs);
  let inserted = 0;
  repository.insert = async (tx, run) => {
    await real(tx, run);
    inserted += 1;
    if (inserted === after) harness.script('refinement', next);
  };
};

/** Moves the clock to the next queued stage job and fires it; answers the delay it waited. */
const nextWake = async (harness: PipelineHarness): Promise<number> => {
  const due = stageJobs(harness)
    .map((request) => request.startAfter?.getTime() ?? harness.clock.epochMs)
    .sort((a, b) => a - b)[0];
  if (due === undefined) throw new Error('no stage job is queued');
  const waited = due - harness.clock.epochMs;
  harness.clock.advance(Math.max(0, waited));
  await harness.drain();
  return waited;
};

describe('a run that ended before the model took a turn (BD-034)', () => {
  it('reads only a zero-turn failure, crash or stall that is not a start failure as turnless', () => {
    const outcome = {
      runId: 'r' as Id,
      status: 'failed',
      terminalReason: 'error_during_execution',
      sessionId: null,
      numTurns: 0,
      usage: null,
      modelUsage: null,
      cost: { usd: 0, is_estimate: false, price_list_id: null },
      wallMs: 1,
      structuredOutput: null,
      error: null,
      redactionCount: 0,
    } as unknown as Parameters<typeof isTurnlessFailure>[0];
    expect(isTurnlessFailure(outcome)).toBe(true);
    expect(isTurnlessFailure({ ...outcome, terminalReason: 'crash' })).toBe(true);
    expect(isTurnlessFailure({ ...outcome, status: 'stalled', terminalReason: 'stalled' })).toBe(
      true,
    );
    // The model took a turn: its failure is the model's, and escalates as before.
    expect(isTurnlessFailure({ ...outcome, numTurns: 1 })).toBe(false);
    // Limits, permissions, the wall clock and a cancel are other endings.
    for (const terminalReason of [
      'error_max_turns',
      'permission_denied',
      'timed_out',
      'cancelled',
    ]) {
      expect(
        isTurnlessFailure({ ...outcome, terminalReason } as typeof outcome),
        terminalReason,
      ).toBe(false);
    }
    expect(isTurnlessFailure({ ...outcome, status: 'completed' } as typeof outcome)).toBe(false);
    expect(isTurnlessFailure({ ...outcome, startFailure: {} } as unknown as typeof outcome)).toBe(
      false,
    );
    expect([1, 2, 3, 4, 5, 6, 9].map(turnlessReplanDelayMs)).toEqual(
      [1, 2, 4, 8, 16, 16, 16].map((minutes) => minutes * MINUTE),
    );
  });

  it('re-plans the entry after a delay, the task untouched, and completes the stage when the next run works (GO-705)', async () => {
    const harness = harnessWith();
    // Four turnless runs, as GO-705's refinement had, then a run that answers.
    scriptFrom(harness, 5, {
      status: 'completed',
      terminalReason: 'success',
      structuredOutput: askingRefinedSpec(),
      costUsd: 0.2,
    });
    await harness.publish([ticketMatched()]);

    const [first] = refinementRunIds(harness);
    const run = await runOf(harness, first as Id);
    expect(run?.status).toBe('failed');
    expect(run?.terminalReason).toBe('error_during_execution');
    expect(taskOf(harness).task.state).toBe('active');
    expect(taskOf(harness).task.currentStage).toBe('refinement');
    expect(harness.types()).not.toContain('task.escalated');

    const delays: number[] = [];
    while (taskOf(harness).task.state === 'active') {
      delays.push(await nextWake(harness));
    }
    expect(delays).toEqual([1, 2, 4, 8].map((minutes) => minutes * MINUTE));
    // Every run on the same entry: no new attempt, no person asked.
    expect(
      harness.specs.filter((spec) => spec.stage === 'refinement').map((spec) => spec.attempt),
    ).toEqual([1, 1, 1, 1, 1]);
    expect(taskOf(harness).task.state).toBe('waiting_answers');
    expect(harness.types()).not.toContain('task.escalated');
    expect(taskOf(harness).costActualUsd).toBeCloseTo(0.2, 6);
  });

  it('escalates the turnless run past the bound with a brief naming what was tried, and queues nothing more', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    while (taskOf(harness).task.state === 'active') {
      await nextWake(harness);
    }

    expect(MAX_TURNLESS_REPLANS).toBe(6);
    expect(refinementRunIds(harness)).toHaveLength(MAX_TURNLESS_REPLANS + 1);
    expect(taskOf(harness).task.state).toBe('needs_human');
    const escalated = harness.events().find((entry) => entry.type === 'task.escalated') as Extract<
      DomainEvent,
      { type: 'task.escalated' }
    >;
    expect(escalated.payload.reason).toContain(
      `runs ended ${String(MAX_TURNLESS_REPLANS + 1)} times before the model took a turn`,
    );
    expect(escalated.payload.blocker_brief).toContain(
      `started ${String(MAX_TURNLESS_REPLANS + 1)} runs`,
    );
    expect(escalated.payload.blocker_brief).toContain(
      `The first ${String(MAX_TURNLESS_REPLANS)} were offered again automatically`,
    );
    expect(escalated.payload.blocker_brief).toContain('no route to the model');
    for (const runId of refinementRunIds(harness)) {
      expect((await runOf(harness, runId))?.terminalReason).toBe('error_during_execution');
    }
    expect(stageJobs(harness)).toEqual([]);
  });

  it('escalates a failed run the model took a turn in at once, as before', async () => {
    const harness = createPipelineHarness({
      projectId: PROJECT,
      runs: { refinement: { ...TURNLESS, numTurns: 3, costUsd: 0.05 } },
    });
    await harness.publish([ticketMatched()]);
    expect(refinementRunIds(harness)).toHaveLength(1);
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(stageJobs(harness)).toEqual([]);
  });

  it('counts per stage entry, from the runs: a new attempt of the stage starts a new count', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    const task = taskOf(harness);
    const counted = async (attempt: number) =>
      harness.memory.transaction(async (scope) =>
        harness.store.runs.turnlessFailures(scope.tx, {
          taskId: task.task.id,
          stage: 'refinement',
          attempt,
        }),
      );
    expect(await counted(1)).toBe(1);
    expect(await counted(2)).toBe(0);
  });
});
