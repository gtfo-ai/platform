/**
 * **A transition that leaves a stage closes its offer** (WP-276 criterion 3, TD-031 decision 3), and
 * the two things that replaced the job singleton for a run's duration (criterion 2): a duplicate
 * wake-up for an entry with a live run starts nothing, and a new entry waits for the previous one's.
 *
 * Over the memory store. The interleaving of the withdrawal's conditional update with a concurrent
 * claim — the case only row locks decide — is `test/integration/pipeline/offer-withdrawal.integration
 * .test.ts`'s, against PostgreSQL in both orders; here the two orders are sequential, which is what a
 * single-threaded store can show (its divergence 9).
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { JOB_QUEUES } from '../ports/jobs.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { pauseTaskCommand, retryStageCommand } from './commands.js';
import { claimRunOffer } from './offers.js';
import { STAGE_WAIT_FOR_PREVIOUS_RUN_MS } from './stage-enqueue.js';

const PROJECT = '00000000-0000-4000-8000-0000000003b1';
const USER = '00000000-0000-4000-8000-0000000003c1' as Id;

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000301',
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

/** A task at its first agent stage, its run offered and claimed by nobody (no claimant composed). */
const offered = async (): Promise<{ harness: PipelineHarness; taskId: Id; runId: Id }> => {
  const harness = createPipelineHarness({ projectId: PROJECT, runsAgents: false });
  await harness.publish([ticketMatched()]);
  const [offer] = harness.store.offerRows();
  if (offer === undefined) throw new Error('the job offered no run');
  return { harness, taskId: offer.taskId, runId: offer.runId };
};

const claim = async (harness: PipelineHarness, runId: Id) =>
  harness.memory.transaction(async (scope) =>
    claimRunOffer(harness.store.offers, scope.tx, {
      eligibility: { runId },
      claimantKind: 'server',
      owner: 'server:holder',
      expiresAt: new Date(Date.parse(harness.clock.now()) + 300_000).toISOString() as never,
      now: harness.clock.now() as never,
    }),
  );

const runStatus = async (harness: PipelineHarness, runId: Id) =>
  harness.memory.transaction(
    async (scope) => (await harness.store.runs.load(scope.tx, runId))?.status,
  );

describe('a transition that leaves the stage closes its offer (WP-276 criterion 3)', () => {
  it('withdraws an open offer and ends its run created → cancelled, in the pause’s own transaction', async () => {
    const { harness, taskId, runId } = await offered();
    expect(await runStatus(harness, runId)).toBe('created');

    await pauseTaskCommand(harness.humanCommands, { taskId, userId: USER });

    expect(harness.store.offerRows()[0]).toMatchObject({ state: 'withdrawn' });
    expect(await runStatus(harness, runId)).toBe('cancelled');
    const types = harness.types();
    expect(types.slice(types.indexOf('run.offer.withdrawn'))).toEqual([
      'run.offer.withdrawn',
      'run.finished',
      'task.paused',
    ]);
    // Nothing left to claim, and no cancel recorded for a run nobody holds.
    expect(await claim(harness, runId)).toBeNull();
    expect(harness.store.runCommandRows()).toEqual([]);
  });

  it('records a cancel for the holder when a claim won the row first, and leaves the offer claimed', async () => {
    const { harness, taskId, runId } = await offered();
    expect(await claim(harness, runId)).not.toBeNull();

    await pauseTaskCommand(harness.humanCommands, { taskId, userId: USER });

    expect(harness.store.offerRows()[0]).toMatchObject({ state: 'claimed' });
    expect(harness.types()).not.toContain('run.offer.withdrawn');
    expect(harness.store.runCommandRows().map((row) => row.instruction.kind)).toEqual(['cancel']);
  });

  it('records one cancel, not two, when a second transition leaves the same entry', async () => {
    const { harness, taskId, runId } = await offered();
    await claim(harness, runId);
    await retryStageCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: harness.store.offerRows()[0]?.stage as never,
    });
    await pauseTaskCommand(harness.humanCommands, { taskId, userId: USER });
    expect(harness.store.runCommandRows().map((row) => row.instruction.kind)).toEqual(['cancel']);
  });
});

describe('what replaces the job singleton for a run’s duration (WP-276 criterion 2)', () => {
  const fire = async (harness: PipelineHarness, taskId: Id, stage: string, attempt: number) => {
    const handler = harness.jobs.handlers.get(JOB_QUEUES.stageExecute);
    await handler?.({
      id: 'duplicate',
      queue: JOB_QUEUES.stageExecute,
      data: { task_id: taskId, project_id: PROJECT, stage, attempt },
      signal: AbortSignal.abort(),
    });
  };

  it('a duplicate stage.execute for an entry with a live run starts nothing and offers nothing', async () => {
    const { harness, taskId, runId } = await offered();
    const offer = harness.store.offerRows()[0];
    await claim(harness, runId);
    const before = harness.store.offerRows().length;
    // The executor's own answer: `skipped` (a duplicate), never `waiting` (another entry's run).
    const outcome = await harness.runtime.executor.execute({
      taskId,
      projectId: PROJECT as Id,
      stage: offer?.stage as string,
      attempt: offer?.attempt as number,
    });
    expect(outcome.kind).toBe('skipped');
    await fire(harness, taskId, offer?.stage as string, offer?.attempt as number);
    expect(harness.store.offerRows()).toHaveLength(before);
    expect(harness.types().filter((type) => type === 'run.created')).toHaveLength(1);
  });

  it('a new entry whose previous run is still claimed waits, and is fired again later', async () => {
    const { harness, taskId, runId } = await offered();
    const offer = harness.store.offerRows()[0];
    await claim(harness, runId);
    // A retry enters attempt 2 and records the cancel for attempt 1's holder.
    await retryStageCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: offer?.stage as never,
    });
    harness.jobs.take(JOB_QUEUES.stageExecute);
    await fire(harness, taskId, offer?.stage as string, 2);
    expect(harness.store.offerRows()).toHaveLength(1);
    const again = harness.jobs.take(JOB_QUEUES.stageExecute);
    expect(again).toHaveLength(1);
    expect(again[0]?.startAfter?.getTime()).toBe(
      Date.parse(harness.clock.now()) + STAGE_WAIT_FOR_PREVIOUS_RUN_MS,
    );
  });
});
