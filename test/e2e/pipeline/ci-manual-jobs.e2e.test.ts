/**
 * **S-27.2 criterion 6, end to end: a manual job nobody started is not a check, unless it is a
 * test** (BD-024's 2026-11-07 amendment, TD-036).
 *
 * A whole `apps/server` instance on PostgreSQL with the fake Claude runner and the fake git
 * provider reached through its registration. The merge request's only pipeline is AUT-6655's
 * shape — GitLab pipeline 3038234623, held at `sentry-release-commit` in a release stage, its build
 * and its tests green — and before S-27.2 the CI gate waited on it until its checks ran out, while
 * `mr_pipeline` asked for a second pipeline on the head. Now:
 *
 *  - the task reaches **Ready** without the gate's wait running out (no escalation, one `ci_gate`
 *    attempt, closed `completed`), and its attempt records what the pass left unstarted
 *    (`task_stages.ci_manual_not_run`) — which the task read serves as `ci_manual_not_run`;
 *  - the head keeps **one** pipeline: no `create_merge_request_pipeline` call was made;
 *  - and a pipeline held at a manual **test** job still waits as before — at `ci_gate`, its read
 *    recorded as held at that job — with one fresh pipeline asked for, once.
 *
 * Every wait is on the last row the platform writes for what is asserted (standing rule 87).
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

const ciRows = (pipeline: PipelineE2E) =>
  pipeline.query<{
    attempt: number;
    state: string;
    outcome: string | null;
    ci_manual_not_run: {
      pipeline_status: string;
      jobs: { name: string; stage: string | null }[];
    } | null;
    ci_pending_read: { status: string; held_job: string | null } | null;
  }>(
    `select s.attempt, s.state, s.outcome, s.ci_manual_not_run, s.ci_pending_read
       from task_stages s join tasks t on t.id = s.task_id
      where t.project_id = $1 and s.stage = 'ci_gate' order by s.attempt`,
    [pipeline.projectId],
  );

const pipelinesRequested = async (pipeline: PipelineE2E): Promise<number> =>
  (await pipeline.auditRows()).filter((row) => row.action === 'create_merge_request_pipeline')
    .length;

describe('a pipeline held at a manual job (S-27.2, TD-036)', () => {
  it('reaches Ready over a release step nobody started, with one pipeline per head and no timeout', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 's27-2-release-step',
      tickets: TICKETS,
    });
    harness = pipeline;
    // AUT-6655's shape, replacing the harness's green seed for the same revision.
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: pipeline.world.mr.headSha,
      status: 'manual',
      jobs: [
        { name: 'build_composer', status: 'success', stage: 'build' },
        { name: 'phpstan', status: 'success', stage: 'test' },
        { name: 'sentry-release-commit', status: 'manual', stage: 'release' },
      ],
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

    const rows = await ciRows(pipeline);
    expect(rows.map((row) => [row.attempt, row.state, row.outcome])).toEqual([
      [1, 'completed', 'protected_paths_clean'],
    ]);
    expect(rows[0]?.ci_manual_not_run).toMatchObject({
      pipeline_status: 'manual',
      jobs: [{ name: 'sentry-release-commit', stage: 'release' }],
    });
    const escalations = await pipeline.query<{ count: string }>(
      `select count(*)::text as count from events
        where type = 'task.escalated' and payload ->> 'project_id' = $1`,
      [pipeline.projectId],
    );
    expect(escalations[0]?.count, 'the gate did not wait its checks out').toBe('0');
    expect(await pipelinesRequested(pipeline), 'one pipeline per head').toBe(0);

    // The task read serves what the pass left unstarted.
    const client = new Client(pipeline.instance.baseUrl);
    expect(
      (
        await client.post('/api/auth/sign-in/email', {
          email: BOOTSTRAP_EMAIL,
          password: BOOTSTRAP_PASSWORD,
        })
      ).status,
    ).toBe(200);
    const taskId = (
      await pipeline.query<{ id: string }>('select id from tasks where project_id = $1', [
        pipeline.projectId,
      ])
    )[0]?.id;
    const detail = await client.json<{
      ci_manual_not_run: { pipeline_status: string; jobs: { name: string }[] } | null;
    }>(`/api/tasks/${String(taskId)}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.ci_manual_not_run?.pipeline_status).toBe('manual');
    expect(detail.body.ci_manual_not_run?.jobs.map((job) => job.name)).toEqual([
      'sentry-release-commit',
    ]);
  });

  it('keeps waiting on a pipeline held at a manual test job, and asks for one fresh pipeline', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 's27-2-test-job',
      tickets: TICKETS,
    });
    harness = pipeline;
    pipeline.git.setPipeline({
      project: GIT_PROJECT,
      headSha: pipeline.world.mr.headSha,
      status: 'manual',
      jobs: [
        { name: 'build_composer', status: 'success', stage: 'build' },
        { name: 'codeception', status: 'manual', stage: 'test' },
      ],
    });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    // `mr_pipeline` asked for a fresh pipeline (the fake records it `pending`, divergence 23), and
    // the gate is still waiting on the head.
    await pipeline.waitFor(
      'the fresh merge-request pipeline to be requested',
      async () => (await pipelinesRequested(pipeline)) > 0,
    );
    await pipeline.settle('ci_gate', (task) => task.current_stage === 'ci_gate');
    await pipeline.waitFor(
      'the CI gate to record a pending read',
      async () => (await ciRows(pipeline))[0]?.ci_pending_read !== null,
    );
    const rows = await ciRows(pipeline);
    expect(rows.map((row) => [row.attempt, row.state])).toEqual([[1, 'running']]);
    expect(rows[0]?.ci_manual_not_run).toBeNull();
    expect(await pipelinesRequested(pipeline), 'once per head').toBe(1);
    const task = await pipeline.query<{ state: string; current_stage: string }>(
      'select state, current_stage from tasks where project_id = $1',
      [pipeline.projectId],
    );
    expect(task).toEqual([{ state: 'active', current_stage: 'ci_gate' }]);
  });
});
