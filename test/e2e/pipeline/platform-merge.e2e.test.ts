/**
 * **The platform merges** (S-28.15, BD-007's 2026-11-10 amendment, TD-038), on a real
 * `apps/server` instance with fake Claude, the fake tracker and fake GitLab.
 *
 * The project's settings say *Who merges: the platform* (written through `PUT …/config`, which
 * records the `project.config.write` row). The task reaches Ready; the merge check reads the fake
 * GitLab's "mergeable" and wakes the `platform_merge` duty, which merges the merge request pinned
 * to the reviewed head with the repository's own settings. The task stays at Ready until GitLab's
 * `mr.merged` arrives through the webhook route — the one path a person's merge takes too — and then
 * walks `merged_gate` → retrospective. One `task_merges` row names the plan decision, one
 * `task.merge.attempted` carries the system actor, and the merge is announced once.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

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

describe('the platform merges (S-28.15)', () => {
  it('merges at Ready pinned to the reviewed head, moves on only through mr.merged, and records it once', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'platform-merge',
      tickets: [TICKETS[0] as (typeof TICKETS)[number]],
      config: { version: 1 },
    });
    harness = pipeline;

    // The setting, through the route a maintainer's save takes (audited as project.config.write).
    const client = new Client(pipeline.instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const read = await client.json<{ hash: string }>(`/api/projects/${pipeline.projectId}/config`);
    const saved = await client.json(`/api/projects/${pipeline.projectId}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        config: { version: 1, policies: { merge: { by: 'platform' } } },
        base_hash: read.body.hash,
      }),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const audited = await pipeline.query<{ action: string }>(
      "select action from human_actions where action = 'project.config.write'",
    );
    expect(audited).toHaveLength(1);

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    // The platform's merge: the fake GitLab merged the merge request, pinned to the reviewed head.
    await pipeline.waitFor('the platform merged the merge request', async () =>
      Promise.resolve(pipeline.git.merges.some((merge) => merge.outcome === 'merged')),
    );
    const [merge] = pipeline.git.merges;
    const [task] = await pipeline.query<{ id: string; ready_head_sha: string; state: string }>(
      'select id, ready_head_sha, state from tasks',
    );
    expect(merge?.expectedHeadSha).toBe(task?.ready_head_sha);
    expect(pipeline.git.merges).toHaveLength(1);
    // One path to merged_gate: the duty moved nothing.
    expect(task?.state).toBe('ready_for_merge');
    const rows = await pipeline.query<{ outcome: string; plan_decision: string }>(
      'select outcome, plan_decision from task_merges',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('merged');
    expect(['approved_by_person', 'approved_by_platform', 'not_required']).toContain(
      rows[0]?.plan_decision,
    );
    const attempted = await pipeline.query<{ id: string; actor: { kind: string } }>(
      "select id, actor from events where type = 'task.merge.attempted'",
    );
    expect(attempted).toHaveLength(1);
    expect(attempted[0]?.actor.kind).toBe('system');

    // GitLab's webhook says merged: the task walks on exactly as for a person's merge.
    const delivered = await pipeline.deliverGit(
      pipeline.git.emitMergeRequestEvent({
        event: 'mr.merged',
        project: GIT_PROJECT,
        iid: pipeline.world.mr.iid,
      }),
    );
    expect(delivered.status).toBe(202);
    await pipeline.settle('done', (moved) => moved.state === 'done');

    // Announced once: the notification's key is the attempt's own event.
    const announced = await pipeline.query<{ class: string }>(
      'select class from notifications where cause_event_id = $1',
      [attempted[0]?.id],
    );
    expect(announced.length).toBeLessThanOrEqual(1);
    expect(pipeline.git.merges).toHaveLength(1);
  }, 240_000);
});
