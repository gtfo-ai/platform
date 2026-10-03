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
 *  - the `mr_ready` duty marked it ready when the Developer stage completed (ruling (g));
 *  - the CI gate reads **that** merge request's head: until its pipeline exists it waits (this
 *    instance has no mirror, so it cannot tell whether `develop` has a CI file — ruling (f)'s
 *    fail-closed answer), and it passes once the pipeline succeeds;
 *  - the merge-request poll matches the merge to the task, which finishes.
 */
import { FAKE_EPOCH } from '@platform/integrations';
import { afterEach, describe, expect, it } from 'vitest';
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
      seedMergeRequest: false,
      // No pipeline for the seeded (unused) merge request; the opened one gets its own below.
      ciStatus: null,
      env: { APP_POLL_SWEEP_INTERVAL_MS: '500' },
    });
    harness = pipeline;

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
    expect(opened.description).toContain('Opened by the agentic platform for ACME-1');

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

    // Ruling (g): the Developer stage's completion marked it ready (the `mr_ready` duty's row).
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
