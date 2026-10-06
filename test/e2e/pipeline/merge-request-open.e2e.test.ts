/**
 * **WP-138 criterion 6, end to end: the Developer opens its merge request, into the project's
 * default branch, and the rest of the pipeline reads it.**
 *
 * A whole `apps/server` instance on PostgreSQL, the fake git provider reached through its
 * registration, and the production `PlatformToolPort`: the Developer run calls `open_mr` through it
 * (the fake Claude runner calls no tool itself — its divergence 6 — so the harness makes the call
 * the model would, with the title and description only). The project's `default_branch` is
 * `develop`, as the product owner's Autix is, and the harness seeds **no** merge request, so the
 * tool opens the first one. Then:
 *
 *  - the merge request is on the provider from the task's own branch (`agentic/ACME-1`) into
 *    `develop`, and `tasks.mr_ref` is the platform's record of it — not the iid the Developer's
 *    artifact reports, which names another merge request on purpose (the canary of ruling (e));
 *  - the CI gate reads **that** merge request's head: until its pipeline exists it waits (this
 *    instance has no mirror, so it cannot tell whether `develop` has a CI file — ruling (f)'s
 *    fail-closed answer), and it passes once the pipeline succeeds;
 *  - the merge request is still a **draft** while the CI gate waits, and the `mr_ready` duty marks
 *    it ready only once the task reaches `ready_for_merge` (backlog 486, the product owner's
 *    2026-10-06 reversal of ruling (g), which marked it ready at the Developer stage's completion);
 *  - the merge-request poll matches the merge to the task, which finishes.
 *
 * **WP-139: the branch arrives through the API, not the seed.** The project row starts at `main` —
 * every project before WP-139, whatever its repository's default — while the provider's project is
 * on `develop`. The settings read shows the difference, a maintainer's `PUT …/default-branch`
 * changes it (one `human_actions` row), and only then is the ticket matched; the change is refused
 * while the task is live. Everything above then follows from the stored `develop`.
 */
import { FAKE_EPOCH } from '@platform/integrations';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_INTEGRATION_ID,
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const recordedMergeRequest = async (pipeline: PipelineE2E) => {
  const rows = await pipeline.query<{ mr_ref: { iid: number; branch: string } | null }>(
    "select mr_ref from tasks where project_id = $1 and ticket_key = 'ACME-1'",
    [pipeline.projectId],
  );
  return rows[0]?.mr_ref ?? null;
};

describe('the Developer’s merge request (WP-138)', () => {
  it('opens it into the default branch, records it, marks it ready, and the CI gate and the poll read it', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'wp138-open-mr',
      tickets: TICKETS,
      defaultBranch: 'develop',
      // WP-139: the row says `main` until the API changes it.
      storedDefaultBranch: 'main',
      seedMergeRequest: false,
      // No pipeline for the seeded (unused) merge request; the opened one gets its own below.
      ciStatus: null,
      env: { APP_POLL_SWEEP_INTERVAL_MS: '500' },
    });
    harness = pipeline;

    // ── WP-139: the stored branch, read beside the provider's and changed through the API ──
    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status).toBe(200);
    const repository = await client.json<{
      default_branch: string;
      provider: { default_branch: string | null; ci_config: { kind: string } } | null;
      live_tasks: number;
    }>(`/api/projects/${pipeline.projectId}/repository`);
    expect(repository.status, JSON.stringify(repository.body)).toBe(200);
    expect(repository.body).toMatchObject({
      default_branch: 'main',
      provider: { default_branch: 'develop', ci_config: { kind: 'repository' } },
      live_tasks: 0,
    });
    const setBranch = (branch: string, key: string) =>
      client.json<{ project?: { default_branch: string }; error?: { code: string } }>(
        `/api/projects/${pipeline.projectId}/default-branch`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          body: JSON.stringify({ default_branch: branch }),
        },
      );
    const changed = await setBranch('develop', 'wp139-develop');
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.project?.default_branch).toBe('develop');
    expect(
      await pipeline.query<{ before: string; after: string }>(
        `select params ->> 'before' as before, params ->> 'after' as after from human_actions
          where action = 'project.default_branch.write' and params ->> 'project_id' = $1`,
        [pipeline.projectId],
      ),
    ).toEqual([{ before: 'main', after: 'develop' }]);

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

    // The record the tool wrote — the last row the platform writes for the open (rule 87).
    await pipeline.waitFor(
      'the task to record its merge request',
      async () => (await recordedMergeRequest(pipeline)) !== null,
    );
    // Review round 1: the first Developer run was provisioned on the task's own branch — the one
    // its push allow-list admits and `open_mr` opens from — not on `develop`, where it could
    // neither switch branches nor push. Every stage before it ran on the default branch.
    const developer = pipeline.specs.find((spec) => spec.stage === 'implementation');
    expect(developer?.checkoutRef).toBe('agentic/ACME-1');
    expect(pipeline.specs.find((spec) => spec.stage === 'refinement')?.checkoutRef).toBeNull();
    const recorded = await recordedMergeRequest(pipeline);
    expect(recorded?.branch).toBe('agentic/ACME-1');
    // The harness's seeded merge request is !1 on another branch; the tool opened a new one.
    expect(recorded?.iid).not.toBe(pipeline.world.mr.iid);
    const iid = recorded?.iid as number;
    const opened = await pipeline.git.getMergeRequest({
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid,
      url: `https://git.example.test/${GIT_PROJECT}/-/merge_requests/${iid}`,
    });
    expect(opened.source_branch).toBe('agentic/ACME-1');
    expect(opened.target_branch).toBe('develop');

    // WP-139: a live task refuses a change of the branch its merge request targets.
    const refused = await setBranch('main', 'wp139-main');
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error?.code).toBe('project_has_live_tasks');
    expect(opened.description).toContain('Opened by the agentic platform for ACME-1');

    // Backlog 486: past the Developer stage the merge request is still a draft while the CI gate
    // waits on its pipeline — nothing marked it ready.
    await pipeline.settle('ci_gate', (task) => task.current_stage === 'ci_gate');
    const whileCi = await pipeline.git.getMergeRequest({
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid,
      url: opened.web_url,
    });
    expect(whileCi.draft).toBe(true);
    expect(
      (await pipeline.auditRows()).filter((row) => row.action === 'mark_merge_request_ready'),
    ).toEqual([]);

    // The merge request's change and its pipeline: the gate waits for the pipeline, then reads it.
    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid,
      files: [{ path: 'src/totals.ts', diff: '@@ -1 +1 @@\n-a\n+b' }],
    });
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: opened.head_sha,
      status: 'success',
      jobs: [{ name: 'test:unit', status: 'success' }],
    });
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // Backlog 486: the entry into `ready_for_merge` marked it ready (the `mr_ready` duty's row).
    await pipeline.waitFor('the merge request marked ready', async () =>
      (await pipeline.auditRows()).some(
        (row) => row.action === 'mark_merge_request_ready' && row.status === 'ok',
      ),
    );
    const ready = await pipeline.git.getMergeRequest({
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid,
      url: opened.web_url,
    });
    expect(ready.draft).toBe(false);

    // The CI gate read this merge request's head (the pipeline set on it above).
    const ciReads = (await pipeline.auditRows()).filter(
      (row) =>
        row.action === 'get_pipeline_status' &&
        JSON.stringify(row.payload).includes(opened.head_sha),
    );
    expect(ciReads.length).toBeGreaterThan(0);

    // Ruling (e)'s canary: the artifact reported the harness's !1; the record and the stored
    // artifact name the merge request the tool opened, and the artifact says so.
    const notes = await pipeline.query<{ data: { mr: { iid: number }; known_gaps: string[] } }>(
      `select a.data from artifacts a join tasks t on t.id = a.task_id
        where t.project_id = $1 and a.type = 'ImplementationNotes'
        order by a.created_at desc limit 1`,
      [pipeline.projectId],
    );
    expect(notes[0]?.data.mr.iid).toBe(iid);
    expect(notes[0]?.data.known_gaps.join('\n')).toContain(
      `the run reported !${pipeline.world.mr.iid}`,
    );
    expect(pipeline.openMrAnswers()).toEqual([
      expect.objectContaining({
        stage: 'implementation',
        answer: expect.objectContaining({ status: 'opened', iid, target_branch: 'develop' }),
      }),
    ]);

    // A human merges on the provider; the binding polls (no webhook), and the poll matches it.
    pipeline.git.emitMergeRequestEvent({ event: 'mr.merged', project: GIT_PROJECT, iid });
    await pipeline.query(
      `update bindings
          set config = config || '{"poll_enabled": true, "poll_interval_seconds": 30}'::jsonb,
              mr_poll_cursor = $3::timestamptz
        where project_id = $1 and integration_id = $2`,
      [pipeline.projectId, GIT_INTEGRATION_ID, FAKE_EPOCH],
    );
    const finished = await pipeline.settle('done', (task) => task.state === 'done');
    expect(finished.template).toBe('feature');
  }, 240_000);
});
