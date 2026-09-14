/**
 * **WP-39's acceptance, through a real `apps/server` instance**: the coverage delta on the task row
 * comes from the project's own CI, against the default branch, and it arrives because a pipeline
 * finished — not because a test wrote a column (product/18:38, product/10:38, BD-030).
 *
 * What this tier adds to `coverage.test.ts`'s branches is the **composition**: the delivery goes
 * through the unauthenticated webhook route with a real signature, the event is normalised by the
 * real `FakeGitProvider`, the duty runs on the instance's own `pipeline.outbound` worker, both
 * provider reads go through the production `IntegrationActionExecutor`, and the record is written by
 * the production `PostgresPipelineStore`. So every assertion is on `tasks.coverage` and on the
 * `integration_actions` rows the production audit adapter wrote (standing rule 82).
 *
 * **The number is never taken off the delivery**, and that is the one design decision this tier
 * exists to hold. `FakeGitProvider` *does* publish a coverage on its pipeline hook (its divergence
 * 13) and GitLab publishes **none** on any delivery (`gitlab/inbound.ts:281-283`), so a build that
 * read the event's field would be green here and blank in production — standing rule 1's most
 * expensive shape. The duty reads `get_pipeline_status` for the head and for the base, and the
 * assertions below are on numbers that only that read can produce: the head pipeline is **replaced**
 * between deliveries, so a record that matched the first delivery's payload would be stale by name.
 *
 * Every wait is on the last row the platform writes and the provider's record is asserted as what
 * that row implies (standing rule 87): the duty reads the base **before** it writes, so a written
 * record bounds the read count the test then asserts.
 */
import type { TaskCoverage } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ticketMatched = (pipeline: PipelineE2E, key: string) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const coverageOf = async (pipeline: PipelineE2E): Promise<TaskCoverage | null> => {
  const rows = await pipeline.query<{ coverage: TaskCoverage | null }>(
    'select coverage from tasks where project_id = $1 limit 1',
    [pipeline.projectId],
  );
  return rows[0]?.coverage ?? null;
};

/** Every `get_pipeline_status` the production executor recorded for one revision. */
const statusReads = async (pipeline: PipelineE2E, headSha: string): Promise<number> =>
  (await pipeline.auditRows()).filter(
    (row) => row.action === 'get_pipeline_status' && row.payload.head_sha === headSha,
  ).length;

describe('the coverage delta from a real pipeline event', () => {
  it('measures head against the default branch, both ways, and reads the base once', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'coverage',
      tickets: TICKETS,
    });
    harness = pipeline;

    const base = await pipeline.git.getDefaultBranchHead(GIT_PROJECT);
    // The default branch has its own pipeline, which is what a delta is measured against and what
    // nothing in this platform stored before this work package.
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: base.sha,
      status: 'success',
      coveragePct: 79,
    });
    // …and the change's own, replacing the harness's coverage-less seed for the same revision.
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: pipeline.world.mr.headSha,
      status: 'success',
      coveragePct: 81.5,
      jobs: [{ name: 'test:unit', status: 'success' }],
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    // Nothing has measured coverage yet: the task page says "not measured" rather than zero, and
    // the base has not been read at all.
    expect(await coverageOf(pipeline)).toBeNull();
    expect(await statusReads(pipeline, base.sha)).toBe(0);

    // The door production has: a **signed delivery** on the unauthenticated webhook route.
    const delivered = await pipeline.deliverGit(
      pipeline.git.emitPipelineFinished({
        project: GIT_PROJECT,
        headSha: pipeline.world.mr.headSha,
      }),
    );
    expect(delivered.status).toBe(202);

    await pipeline.waitFor(
      'the coverage record to be written',
      async () => (await coverageOf(pipeline)) !== null,
    );
    const raised = await coverageOf(pipeline);
    expect(raised?.head_pct).toBe(81.5);
    expect(raised?.base_pct).toBe(79);
    expect(raised?.delta_pct).toBe(2.5);
    // The base is **named** on the row, which is what lets the panel say how stale it is.
    expect(raised?.base_branch).toBe('main');
    expect(raised?.base_sha).toBe(base.sha);
    expect(raised?.head_sha).toBe(pipeline.world.mr.headSha);
    // …and the row implies the reads: both numbers came off `get_pipeline_status`, through the
    // production executor, which is the audit's own record of what this feature costs.
    expect(await statusReads(pipeline, base.sha)).toBe(1);

    /**
     * **The other direction** (standing rule 42), from a re-run on the same revision. A build that
     * printed the head number, or that trusted the first delivery, shows a rise on a change that
     * dropped coverage by nine points — which is the one thing a merge-readiness panel must not do.
     */
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: pipeline.world.mr.headSha,
      status: 'success',
      coveragePct: 70,
      jobs: [{ name: 'test:unit', status: 'success' }],
    });
    expect(
      (
        await pipeline.deliverGit(
          pipeline.git.emitPipelineFinished({
            project: GIT_PROJECT,
            headSha: pipeline.world.mr.headSha,
          }),
        )
      ).status,
    ).toBe(202);

    await pipeline.waitFor(
      'the second measurement to replace the first',
      async () => (await coverageOf(pipeline))?.head_pct === 70,
    );
    const dropped = await coverageOf(pipeline);
    expect(dropped?.delta_pct).toBe(-9);
    expect(dropped?.base_pct).toBe(79);
    // **The cache**: the default branch has not moved, so the base was not read a second time. Key
    // `(task_id, base_sha)`, lifetime the task row, invalidated by the branch moving and by nothing
    // else — and the row this assertion follows was written after the read it counts.
    expect(await statusReads(pipeline, base.sha)).toBe(1);

    /**
     * **And a project whose CI stops reporting coverage says so rather than showing a zero**
     * (standing rule 16). `+0.0 pp` would read to a maintainer as *"the agent added no coverage"*,
     * which is a claim about the change rather than about the pipeline. The delivery carries
     * `coverage_pct: null` — as every GitLab delivery does — **and** the pipeline behind it reports
     * none, so neither source can be the thing that produced the answer.
     */
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: pipeline.world.mr.headSha,
      status: 'success',
      coveragePct: null,
      jobs: [{ name: 'test:unit', status: 'success' }],
    });
    expect(
      (
        await pipeline.deliverGit(
          pipeline.git.emitPipelineFinished({
            project: GIT_PROJECT,
            headSha: pipeline.world.mr.headSha,
          }),
        )
      ).status,
    ).toBe(202);

    await pipeline.waitFor(
      'the unreported measurement to replace the numbers',
      async () => (await coverageOf(pipeline))?.head_pct === null,
    );
    const unreported = await coverageOf(pipeline);
    expect(unreported?.delta_pct).toBeNull();
    expect(unreported?.base_pct).toBeNull();
    // …and it did not spend a read looking for a base it could not have used.
    expect(await statusReads(pipeline, base.sha)).toBe(1);
  }, 180_000);
});
