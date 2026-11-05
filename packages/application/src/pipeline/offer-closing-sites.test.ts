/**
 * **The four escalation sites close the stage offer before they park the task** (WP-276 criterion
 * 3, review of PR #7). The claimant claims open offers without re-reading the task, so an offer
 * left open by an escalation would run a whole session on a `needs_human` task. Each case escalates
 * a task whose run is offered and claimed by nobody (a harness with no claimant), through one site,
 * and asserts the offer withdrawn, its run `cancelled` and `run.offer.withdrawn` in the log.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../ports/event-store.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { escalateForConfigRefusal } from './config-refusal.js';
import { createDeadLetterEscalation } from './dead-letter.js';
import { escalateExhaustedJob } from './job-escalation.js';
import { escalateTaskAfterConflict, TaskConflictExhaustedError } from './task-conflict.js';

const PROJECT = '00000000-0000-4000-8000-0000000004b1';

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000401',
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

const offered = async (): Promise<{ harness: PipelineHarness; taskId: Id; runId: Id }> => {
  const harness = createPipelineHarness({ projectId: PROJECT, runsAgents: false });
  await harness.publish([ticketMatched()]);
  const [offer] = harness.store.offerRows();
  if (offer === undefined || offer.state !== 'open') throw new Error('the job offered no run');
  return { harness, taskId: offer.taskId, runId: offer.runId };
};

const expectWithdrawn = async (harness: PipelineHarness, runId: Id) => {
  expect(harness.store.offerRows()[0]).toMatchObject({ state: 'withdrawn' });
  const run = await harness.memory.transaction(async (scope) =>
    harness.store.runs.load(scope.tx, runId),
  );
  expect(run?.status).toBe('cancelled');
  expect(harness.types()).toContain('run.offer.withdrawn');
  expect(harness.store.snapshot()[0]?.task.state).toBe('needs_human');
};

const context = (harness: PipelineHarness) => (taskId: Id) => ({
  ids: harness.ids,
  actor: { kind: 'system' as const, component: 'test' },
  clock: { now: () => harness.clock.now() },
  correlationId: taskId,
  causeEventId: null,
});

describe('every escalation site closes the stage offer first (WP-276 criterion 3)', () => {
  it('dead-letter.ts: a dead-lettered event parks the task and withdraws its open offer', async () => {
    const { harness, taskId, runId } = await offered();
    const sink = createDeadLetterEscalation({
      store: harness.store,
      eventStore: harness.memory.store,
      context: (correlationId, causeEventId) => ({
        ...context(harness)(correlationId),
        causeEventId,
      }),
    });
    const event = harness.memory.log.find((row) => row.event.stream_id === taskId) as StoredEvent;
    await harness.memory.transaction(async (scope) =>
      sink(scope, { event, handler: 'test.handler', attempts: 5, error: 'boom' }),
    );
    await expectWithdrawn(harness, runId);
  });

  it('job-escalation.ts: an exhausted job parks the task and withdraws its open offer', async () => {
    const { harness, taskId, runId } = await offered();
    expect(
      await escalateExhaustedJob(
        {
          unitOfWork: harness.memory,
          store: harness.store,
          eventStore: harness.memory.store,
          jobs: harness.jobs,
          ids: harness.ids,
          clock: harness.clock,
        },
        {
          taskId,
          projectId: PROJECT as Id,
          queue: 'pipeline.outbound',
          duty: 'workpad',
          tries: 3,
          causeEventId: null,
          what: 'render the workpad',
          remedy: 'Render it yourself.',
        },
      ),
    ).toBe('escalated');
    await expectWithdrawn(harness, runId);
  });

  it('task-conflict.ts: a write that lost every race parks the task and withdraws its open offer', async () => {
    const { harness, taskId, runId } = await offered();
    await escalateTaskAfterConflict(
      {
        unitOfWork: harness.memory,
        store: harness.store,
        context: context(harness),
      },
      new TaskConflictExhaustedError(taskId, 3, 'recording something'),
    );
    await expectWithdrawn(harness, runId);
  });

  it('config-refusal.ts: an unreadable configuration parks the task and withdraws its open offer', async () => {
    const { harness, taskId, runId } = await offered();
    await escalateForConfigRefusal(
      {
        unitOfWork: harness.memory,
        store: harness.store,
        context: context(harness),
      },
      { taskId, refusal: 'the stored settings do not parse', what: 'the next stage' },
    );
    await expectWithdrawn(harness, runId);
  });
});
