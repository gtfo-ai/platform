/**
 * **A gate whose provider does not answer re-asks, and never fails its job** — PROGRESS backlog
 * 490, end to end over the production composition, real pg-boss and the fake git provider.
 *
 * AUT-6820 (first local test, 2026-10-06) waited at `ci_gate` when the host's network to gitlab.com
 * dropped: the gate's read threw, `stage.execute` threw, pg-boss spent the queue's two retries and
 * failed the job, and the stranded-stage recovery escalated the task as a stage that had *"never
 * started"*. Here the provider is down for **twelve** pipeline reads made from `stage.execute` — four
 * evaluations of three executor attempts each, more than the nine a thrown job gets (three pg-boss
 * tries of three attempts) — and then answers. The task must reach Ready with no failed job and no
 * escalation.
 *
 * Two seams, both the harness's labelled ones. The outage is the fake's own script
 * (`failWhile`, divergence 30 of `packages/integrations/src/git/fake.ts`), scoped by an
 * `AsyncLocalStorage` to reads made **inside a `stage.execute` job**: the `mr_pipeline` duty reads
 * the same pipeline status from `pipeline.outbound` at the same moment, and an outage that took
 * its reads would race its own escalation against the gate. And the outage's re-checks are woken
 * at once rather than after their 30 s, 60 s, 2 min… (`PipelineComposition.jobs`): the delays are
 * the unit tier's assertion (`saga.test.ts`), the absence of a thrown job is this one's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  IntegrationError,
  JOB_QUEUES,
  type JobData,
  type Jobs,
  type WorkRequest,
} from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Whether the code running now is a `stage.execute` job's. */
const inStageJob = new AsyncLocalStorage<true>();

/**
 * Runs `stage.execute` inside {@link inStageJob}, and wakes an outage re-check at once — the job a
 * failed read enqueues carries `provider_failures`; nothing else's does.
 */
const scopedStageJobs = (jobs: Jobs): Jobs => ({
  ...jobs,
  enqueue: async (request) => {
    const outageRecheck =
      request.queue === JOB_QUEUES.stageExecute &&
      (request.data as { provider_failures?: number } | undefined)?.provider_failures !== undefined;
    if (!outageRecheck) {
      return jobs.enqueue(request);
    }
    const { startAfter: _later, ...now } = request;
    return jobs.enqueue(now);
  },
  work: async <TData extends JobData>(request: WorkRequest<TData>) =>
    request.queue !== JOB_QUEUES.stageExecute
      ? jobs.work(request)
      : jobs.work<TData>({
          ...request,
          handler: async (job) => inStageJob.run(true, () => request.handler(job)),
        }),
});

const DOWN_FOR_READS = 12;

describe('a CI gate whose provider does not answer (backlog 490)', () => {
  it('re-asks through the outage and reaches Ready, with no failed job and no escalation', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'gate-outage',
      tickets: TICKETS,
      jobs: scopedStageJobs,
    });
    harness = pipeline;
    let gateReads = 0;
    pipeline.git.core.script.failWhile('get_pipeline_status', () => {
      if (inStageJob.getStore() !== true || gateReads >= DOWN_FOR_READS) {
        return null;
      }
      gateReads += 1;
      return new IntegrationError(
        'unavailable',
        'fake-git',
        'GET /projects/acme%2Fapi/pipelines could not be reached',
        { action: 'get_pipeline_status' },
      );
    });

    await pipeline.publish([
      inboundEvent('ticket.matched', {
        project_id: pipeline.projectId,
        ticket: {
          provider: 'fake-task-management',
          key: 'ACME-1',
          url: 'https://tickets.example.test/browse/ACME-1',
        },
        rule: 'label:agentic',
        priority: 'High',
        issue_type: 'Story',
        epic: null,
        links: [],
      }),
    ]);

    const ready = await pipeline.settle(
      'ready_for_merge after the outage',
      (task) => task.state === 'ready_for_merge' || task.state === 'needs_human',
    );
    expect(ready.state).toBe('ready_for_merge');
    expect(gateReads, 'the outage was spent by the gate').toBe(DOWN_FOR_READS);

    const events = await pipeline.events();
    expect(events.filter((event) => event.type === 'task.escalated')).toEqual([]);
    const failed = await pipeline.query<{ count: number }>(
      `select count(*)::int as count from pgboss.job where name = $1 and state = 'failed'`,
      [JOB_QUEUES.stageExecute],
    );
    expect(failed[0]?.count, 'no stage.execute job spent its retries').toBe(0);
    // Every failed read is audited, as every provider call is: one row per evaluation, with the
    // executor's three attempts on it.
    const reads = (await pipeline.auditRows()).filter(
      (row) => row.action === 'get_pipeline_status' && row.status === 'failed',
    );
    expect(reads.map((row) => row.attempts)).toEqual([3, 3, 3, 3]);
  });
});
