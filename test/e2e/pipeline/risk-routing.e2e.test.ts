/**
 * **WP-37's acceptance, through a real `apps/server` instance**: the risk classes on the task row
 * come from the merge request's own diff, and the reviewers come from the repository's
 * `CODEOWNERS` (product/19 §14 and product/19:138, BD-030).
 *
 * What this tier adds to `risk-routing.test.ts`'s branches is the **composition**: the classes are
 * written by the instance's own `pipeline.outbound` worker through the production
 * `PostgresPipelineStore`, and the assignment goes out through the production
 * `IntegrationActionExecutor` — so the assertions are on `tasks.risk_classes` and on the
 * `integration_actions` rows the production audit adapter wrote, never on a double the test passed
 * in.
 *
 * **The plan and the diff disagree on purpose** (standing rule 82, and rule 10's shape). The fake
 * runner's Implementation Plan names `src/totals.ts`, which falls into no class; the merge request's
 * diff carries `db/migrations/…`, which falls into `data`. So a build that classified from the plan
 * — which is what WP-30's gate does, correctly, at a different moment — produces an **empty** row
 * here, and the assertion below fails by name. That is the whole point of this work package:
 * product/19 §14 names the diff as the authoritative source, and until now nothing read it.
 *
 * **The branch under review carries its own `CODEOWNERS`** (round 2). Routing reads the file at the
 * default branch because a merge request may edit it and its author must not be able to appoint
 * their own reviewer (BD-022), and the fake honours `ref` since divergence 12 — so the planted file
 * is a real alternative answer here, not a comment about one, and both the assignment and the
 * production audit row's `ref` are asserted against it.
 *
 * Every wait is on the last row the platform writes and the provider's record is asserted as what
 * that row implies (standing rule 87).
 */
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

/** The project's classes, as an operator accepts them through `PUT …/config`. */
const CONFIG = {
  version: 1,
  policies: {
    risk_classes: {
      data: { paths: ['**/migrations/**', '**/*.sql'], require: ['plan_approval'] },
      auth: { paths: ['src/auth/**'], require: ['plan_approval', 'reviewer:@security'] },
    },
  },
};

const CODEOWNERS = '# who owns what\ndb/ @dana\nsrc/auth/ @security\n';

/**
 * The same file, rewritten **inside the change** to appoint its own author.
 *
 * `FakeGitProvider` keeps `CODEOWNERS` per ref since WP-37 round 2 (its divergence 12), so this is
 * the state a real fork contributor can put a repository in: the branch under review carries an
 * owner file the default branch does not. Routing reads the default branch precisely so that it
 * cannot be honoured (BD-022), and `@mallory` resolves to a real account below, so a build that
 * read the file from the branch assigns `6666` here and fails by name.
 */
const PLANTED_CODEOWNERS = '# planted by the change itself\ndb/ @mallory\n';

const riskClassesOf = async (pipeline: PipelineE2E): Promise<readonly string[]> => {
  const rows = await pipeline.query<{ risk_classes: string[] }>(
    'select risk_classes from tasks where project_id = $1 limit 1',
    [pipeline.projectId],
  );
  return rows[0]?.risk_classes ?? [];
};

const reviewerActions = async (pipeline: PipelineE2E) =>
  (await pipeline.auditRows()).filter((row) => row.action === 'set_reviewers');

describe('risk classes and reviewer routing at the rebase gate', () => {
  it('writes the classes the diff falls into and assigns the CODEOWNERS match', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'risk-routing',
      tickets: TICKETS,
      config: CONFIG,
      codeowners: CODEOWNERS,
      // `@dana` owns `db/` on the default branch and `@mallory` owns it on the branch under
      // review: both resolve, so the assignment below says which file was read rather than which
      // handle happened to be known. `@security` resolves to nobody, which is the ordinary state
      // of a real `CODEOWNERS` and is the thing that happens *quietly and by name*.
      gitUsers: { '@dana': '4242', '@mallory': '6666' },
    });
    harness = pipeline;

    pipeline.git.seedFile({
      project: GIT_PROJECT,
      branch: pipeline.world.branch,
      path: 'CODEOWNERS',
      content: PLANTED_CODEOWNERS,
    });

    // The implementation touched a migration the plan never mentioned — the case product/19 §14
    // exists for, and the one a plan-derived classification cannot see.
    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: [{ path: 'src/totals.ts' }, { path: 'db/migrations/0007_add_totals.sql' }],
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // **The row is written before the provider call**, so it is waited on first and separately.
    await pipeline.waitFor(
      'the task’s risk classes to be written',
      async () => (await riskClassesOf(pipeline)).length > 0,
    );
    expect(await riskClassesOf(pipeline)).toEqual(['data']);

    // The assignment's own last write is the audit row the executor records **after** the call
    // returns, which is the line this wait binds to (standing rule 87).
    await pipeline.waitFor(
      'the reviewer assignment to be recorded',
      async () => (await reviewerActions(pipeline)).length >= 1,
    );
    const assignment = (await reviewerActions(pipeline))[0];
    expect(assignment?.status).toBe('ok');
    // `@dana` owns `db/` on the **default branch**; `@mallory` owns it on the branch under review.
    expect(assignment?.payload).toMatchObject({ iid: pipeline.world.mr.iid, reviewers: ['4242'] });

    // …and the read itself says which ref it was made at, which is the production audit row rather
    // than a double the test passed in: the whole security property is the value of `ref` here.
    const reads = (await pipeline.auditRows()).filter((row) => row.action === 'read_codeowners');
    expect(reads.length).toBeGreaterThan(0);
    expect(
      [...new Set(reads.map((row) => row.payload.ref))],
      'CODEOWNERS is read at the default branch and at no other ref',
    ).toEqual(['main']);

    // …and the provider's own record says the same thing, which is what the row implies.
    const mr = await pipeline.git.getMergeRequest({
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
    });
    expect(mr.reviewers.map((identity) => identity.external_id)).toEqual(['4242']);
  }, 180_000);

  it('classes nothing and assigns nobody on a project that configured neither', async () => {
    /**
     * The shipped default, both ways (standing rule 42). The platform *proposes* its classes and
     * **ships none**, and a repository with no `CODEOWNERS` routes to nobody — so the ordinary
     * project gets an empty column and no assignment, rather than a class somebody's deploy chose
     * or a reviewer the platform guessed. What it pays for that is the three reads
     * `risk-routing.ts` states and no write at all, which is the second assertion below.
     */
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'risk-routing-none',
      tickets: TICKETS,
    });
    harness = pipeline;

    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: [{ path: 'db/migrations/0007_add_totals.sql' }],
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    /**
     * **The duty ran**, which is what makes the two empty assertions below a measurement rather
     * than a description of a job that never fired (standing rule 4). The `CODEOWNERS` read is the
     * one only this duty makes at the gate — the conflict warning reads a *diff* per peer and this
     * project has no peer task — so it is the line the wait binds to.
     */
    await pipeline.waitFor('the gate’s CODEOWNERS read to be recorded', async () =>
      (await pipeline.auditRows()).some((row) => row.action === 'read_codeowners'),
    );
    expect(await riskClassesOf(pipeline)).toEqual([]);
    expect(await reviewerActions(pipeline)).toEqual([]);
  }, 180_000);
});
