/**
 * **A run a usage limit ended is re-planned once** — WP-285, TD-031 decision 11, BD-032 decision 7.
 *
 * The runner ends such a run `failed` / `rate_limited` (`claude-runner.ts`, its golden fixtures);
 * these cases script that outcome and drive the real stage executor, the real `settleRun` and the
 * real `stage.execute` handler through the pipeline harness, so what is asserted is the ending: the
 * run's row, the stage entry's counter, the task, the re-enqueued job, the spend, and the bound.
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
import { MAX_USAGE_LIMITED_REPLANS } from './settle.js';

const PROJECT = '00000000-0000-4000-8000-0000000002b5';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000285',
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
        key: 'ACME-285',
        url: 'https://jira.example.test/browse/ACME-285',
      },
      rule: 'label:agentic',
      priority: null,
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

/** What the runner reports for a session its usage limit ended: measured, `rate_limited`. */
const LIMITED = {
  status: 'failed',
  terminalReason: 'rate_limited',
  costUsd: 0.18,
  error: "the claimant's usage limit was reached (rate_limit_rejected)",
  usageLimit: { signal: 'rate_limit_rejected', resetsAt: '2026-06-01T14:00:00.000Z' as never },
} as const;

const harnessWith = (options: HarnessOptions = {}): PipelineHarness =>
  createPipelineHarness({ projectId: PROJECT, runs: { refinement: LIMITED }, ...options });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) throw new Error('no task was created');
  return stored;
};

const refinementRunIds = (harness: PipelineHarness): Id[] =>
  harness.specs.filter((spec) => spec.stage === 'refinement').map((spec) => spec.runId as Id);

const runOf = async (harness: PipelineHarness, runId: Id) =>
  harness.memory.transaction(async (scope) => harness.store.runs.load(scope.tx, runId));

/** The script every run after the entry's first plays (the harness scripts a stage, not a run). */
const thenScript = (harness: PipelineHarness, next: Parameters<PipelineHarness['script']>[1]) => {
  const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
  const real = repository.insert.bind(harness.store.runs);
  let inserted = 0;
  repository.insert = async (tx, run) => {
    await real(tx, run);
    inserted += 1;
    if (inserted === 2) harness.script('refinement', next);
  };
};

const entryRow = (harness: PipelineHarness) =>
  harness.store.stageRows.find((row) => row.stage === 'refinement' && row.attempt === 1);

describe('a stage run a usage limit ended (WP-285)', () => {
  it('ends it failed/rate_limited, charges it, leaves the task at its stage and re-plans the entry at once', async () => {
    const harness = harnessWith();
    thenScript(harness, {
      status: 'completed',
      terminalReason: 'success',
      structuredOutput: askingRefinedSpec(),
      costUsd: 0.2,
    });
    await harness.publish([ticketMatched()]);

    const [first, second] = refinementRunIds(harness);
    const run = await runOf(harness, first as Id);
    expect(run?.status).toBe('failed');
    expect(run?.terminalReason).toBe('rate_limited');
    // Charged as measured — never an unmeasured hold, never a zero.
    expect(run?.cost?.usd).toBe(0.18);
    const failed = harness.events().find((entry) => entry.type === 'run.failed') as Extract<
      DomainEvent,
      { type: 'run.failed' }
    >;
    expect(failed.payload.terminal_reason).toBe('rate_limited');

    // The same entry's wake-up, enqueued by `settleRun` after its commit and due at once — and the
    // stage ran again on the same attempt, which completed it: no human was asked.
    const requeued = harness.jobs.history.filter(
      (request) => request.queue === 'stage.execute' && request.startAfter !== undefined,
    );
    expect(requeued).toHaveLength(1);
    expect(requeued[0]?.data).toMatchObject({ stage: 'refinement', attempt: 1 });
    expect(requeued[0]?.startAfter?.getTime()).toBe(harness.clock.epochMs);
    expect(second).toBeDefined();
    expect(
      harness.specs.filter((spec) => spec.stage === 'refinement').map((spec) => spec.attempt),
    ).toEqual([1, 1]);
    expect(entryRow(harness)).toMatchObject({ usageLimitedRuns: 1 });
    expect(taskOf(harness).task.state).toBe('waiting_answers');
    expect(harness.types()).not.toContain('task.escalated');
    // Both runs charged, each once.
    expect(taskOf(harness).costActualUsd).toBeCloseTo(0.38, 6);
  });

  it('escalates the second limit of the entry with the brief TD-031 names, and queues nothing more', async () => {
    const harness = harnessWith();
    await harness.publish([ticketMatched()]);
    await harness.drain();

    expect(refinementRunIds(harness)).toHaveLength(1 + MAX_USAGE_LIMITED_REPLANS);
    expect(taskOf(harness).task.state).toBe('needs_human');
    const escalated = harness.events().find((entry) => entry.type === 'task.escalated') as Extract<
      DomainEvent,
      { type: 'task.escalated' }
    >;
    expect(escalated.payload.reason).toContain('usage limits ended this stage twice');
    expect(escalated.payload.blocker_brief).toContain('stopped by a usage limit 2 times');
    expect(entryRow(harness)).toMatchObject({ usageLimitedRuns: 2 });
    expect(entryRow(harness)?.exitedAt).not.toBeNull();
    for (const runId of refinementRunIds(harness)) {
      expect((await runOf(harness, runId))?.terminalReason).toBe('rate_limited');
    }
    expect(harness.jobs.enqueued.filter((request) => request.queue === 'stage.execute')).toEqual(
      [],
    );
    // Both runs charged, each once.
    expect(taskOf(harness).costActualUsd).toBeCloseTo(0.36, 6);
  });

  it('does not re-run a stage whose task a person paused during the run (the pause stands)', async () => {
    const harness = harnessWith();
    const repository = harness.store.runs as { insert: typeof harness.store.runs.insert };
    const real = repository.insert.bind(harness.store.runs);
    repository.insert = async (tx, run) => {
      await real(tx, run);
      const [stored] = harness.store.snapshot();
      if (stored !== undefined && stored.task.state === 'active') {
        await harness.store.tasks.save(tx, {
          ...stored,
          task: { ...stored.task, state: 'paused' },
        });
      }
    };
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('paused');
    expect(harness.jobs.enqueued.filter((request) => request.queue === 'stage.execute')).toEqual(
      [],
    );
    // Recorded onto the stopped task: the entry is not counted.
    expect(entryRow(harness)?.usageLimitedRuns ?? 0).toBe(0);
  });
});
