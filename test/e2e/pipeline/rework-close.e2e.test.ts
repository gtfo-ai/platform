/**
 * product/04:86's *"human rejection = reset, not patching: the old MR is closed, a fresh branch is
 * created"* against a whole `apps/server` instance on PostgreSQL (WP-59, PROGRESS backlog 51,
 * **Q92**).
 *
 * The unit tier (`human-commands.test.ts`) drives the command and the duty over the in-memory
 * doubles; this tier is where the three things that only exist in production meet: the real
 * `POST /api/tasks/:id/rework` route, the real `pipeline.outbound` queue on pg-boss, and the real
 * `FakeGitProvider` reached through the production binding loader and `IntegrationActionExecutor`.
 * What it asserts is what a team would see on the provider: the rejected merge request **closed**,
 * a comment on it naming the new branch, the next Developer run checked out on that branch, and the
 * task carrying the merge request opened from it — with one audit row per provider write.
 */
import type { RunSpec } from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const PROJECT_PATH = 'acme/api';
/** `taskBranchName('ACME-1')` plus the attempt the first rework starts (Q92). */
const REWORK_BRANCH = 'agentic/ACME-1-r2';

const ticketMatched = (pipeline: PipelineE2E) =>
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
  });

describe('rework closes the rejected merge request and moves to a new branch (Q92)', () => {
  it('closes the old merge request with a comment naming the new branch, from the outbound duty', async () => {
    // The merge request the Developer run after the rework "opens" from the new branch. The fake
    // runner does not call tools (its divergence 6), so the harness opens it — as it does the first.
    let reworked: { iid: number; url: string; headSha: string } | null = null;
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'rework-close',
      tickets: TICKETS,
      scenarioFor: (spec: RunSpec, world) => {
        // Only the Developer run that checked out the **new** branch reports the new merge request;
        // every other run takes the stage map. Keyed on the checkout, so the case also fails if the
        // next run is not on the new branch.
        if (spec.stage !== 'implementation' || spec.checkoutRef !== REWORK_BRANCH) {
          return undefined;
        }
        if (reworked === null) {
          throw new Error('the rework merge request was not opened before the Developer ran');
        }
        const base = featureScenarios(world).implementation;
        return {
          ...base,
          structuredOutput: {
            ...(base?.structuredOutput as Record<string, unknown>),
            mr: {
              url: reworked.url,
              iid: reworked.iid,
              head_sha: reworked.headSha,
              branch: REWORK_BRANCH,
            },
          },
        } as never;
      },
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready for merge', (snapshot) => snapshot.state === 'ready_for_merge');
    const before = await pipeline.task();
    const mrRefOf = async () =>
      (
        await pipeline.query<{ branch: string | null; mr_ref: { iid: number } | null }>(
          'select branch, mr_ref from tasks where id = $1',
          [before.id],
        )
      )[0];
    expect((await mrRefOf())?.mr_ref?.iid).toBe(pipeline.world.mr.iid);

    const opened = await pipeline.git.openMergeRequest({
      project: PROJECT_PATH,
      branch: REWORK_BRANCH,
      target: 'main',
      title: 'Draft: sum the invoice footer, again',
      description: 'Opened by the developer stage after a rework.',
      draft: true,
      labels: ['agentic'],
      reviewers: [],
      remove_source_branch: true,
    });
    reworked = { iid: opened.ref.iid, url: opened.web_url, headSha: opened.head_sha };
    pipeline.git.setPipeline({
      project: PROJECT_PATH,
      headSha: opened.head_sha,
      status: 'success',
      jobs: [{ name: 'test:unit', status: 'success' }],
    });

    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const response = await client.json(`/api/tasks/${before.id}/rework`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'rework-close-1' },
      body: JSON.stringify({ stage: 'architecture', instructions: 'sum the model, not the view' }),
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);

    // The provider half: the rejected merge request closed by the duty, and said why. Waited on the
    // audit row of the close, which is the last thing the duty writes about it (rule 87).
    await pipeline.waitFor('the close of the rejected merge request', async () =>
      (await pipeline.auditRows()).some(
        (row) => row.action === 'close_merge_request' && row.status === 'ok',
      ),
    );
    const old = await pipeline.git.getMergeRequest({
      provider: null,
      project_path: PROJECT_PATH,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: null,
      head_sha: null,
    });
    expect(old.state).toBe('closed');
    const threads = await pipeline.git.listDiscussions(old.ref);
    const note = threads
      .flatMap((thread) => thread.notes)
      .find((entry) => entry.body.includes(`<!-- agentic:superseded:${before.id} -->`));
    expect(note?.body).toContain(REWORK_BRANCH);

    // The task half: back through the pipeline on the new branch, adopting the new merge request.
    await pipeline.settle(
      'ready for merge again, after the reworked architecture',
      (snapshot) =>
        snapshot.state === 'ready_for_merge' && snapshot.stage_attempts.architecture === 2,
    );
    const after = await mrRefOf();
    expect(after?.branch).toBe(REWORK_BRANCH);
    expect(after?.mr_ref?.iid).toBe(opened.ref.iid);
    expect(pipeline.specs.some((spec) => spec.checkoutRef === REWORK_BRANCH)).toBe(true);
    // The new merge request is open; exactly one close was performed, through the executor.
    expect((await pipeline.git.getMergeRequest(opened.ref)).state).toBe('opened');
    const closes = (await pipeline.auditRows()).filter(
      (row) => row.action === 'close_merge_request',
    );
    expect(closes.map((row) => row.status)).toEqual(['ok']);
    expect(closes[0]?.payload).toMatchObject({ iid: pipeline.world.mr.iid });
    // The rework's row (migration 0043, backlog 178) is settled by the duty, so the recovery pass
    // has nothing to re-drive.
    const rows = await pipeline.query<{ iid: number; outcome: string | null; new_branch: string }>(
      'select iid, outcome, new_branch from superseded_merge_requests where task_id = $1',
      [before.id],
    );
    expect(rows).toEqual([
      { iid: pipeline.world.mr.iid, outcome: 'closed', new_branch: REWORK_BRANCH },
    ]);
  });
});
