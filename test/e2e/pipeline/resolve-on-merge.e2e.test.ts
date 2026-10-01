/**
 * WP-111 (PROGRESS backlog 302, option (b)): **a bug task's merge resolves the issues its ticket
 * links — on an errors binding that sets `resolve_on_merge`, and nowhere else** — through a whole
 * `apps/server` instance, with the errors binding read from `integrations`/`bindings` rows by the
 * production loader and the flag set on the **binding** row, as an operator sets it.
 *
 * Every wait binds the last row the platform writes for the merge (standing rule 87): the
 * `pipeline.outbound` job of duty `resolve_on_merge` reaching `completed` in pg-boss, which happens
 * after every resolve it made was audited. The negative cases wait on the same row, so "nothing was
 * resolved" is read after the duty ran rather than before it could have.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ERRORS_INTEGRATION_ID,
  GIT_PROJECT,
  inboundEvent,
  type ObservabilitySeed,
  type PipelineE2E,
  startPipeline,
} from '../support/pipeline.js';
import { bugScenarios } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ISSUE_7 = 'https://errors.example.test/issues/issue-7';
const ISSUE_8 = 'https://errors.example.test/issues/issue-8';

const ISSUES: ObservabilitySeed['errors'] = [
  { id: 'issue-7', project: 'api', title: 'TypeError: cannot read totals of undefined' },
  { id: 'issue-8', project: 'api', title: 'RangeError: page two is empty' },
];

const ticketMatched = (pipeline: PipelineE2E) =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key: 'ACME-9',
      url: 'https://tickets.example.test/browse/ACME-9',
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Bug',
    epic: null,
    links: [],
  });

const merged = (pipeline: PipelineE2E) =>
  inboundEvent('mr.merged', {
    project_id: pipeline.projectId,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: pipeline.world.branch,
      head_sha: pipeline.world.mr.headSha,
    },
    draft: false,
    head_sha: pipeline.world.mr.headSha,
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

/** A bug ticket linking both issues, driven to `done` through one merge. */
const mergeABug = async (observability: ObservabilitySeed | undefined): Promise<PipelineE2E> => {
  const pipeline = await startPipeline({
    scenarios: bugScenarios,
    label: 'resolve-on-merge',
    tickets: [
      {
        key: 'ACME-9',
        title: 'The invoice footer sums the wrong rows',
        issueType: 'Bug',
        description: `Customers see the wrong total. Sentry: ${ISSUE_7} and ${ISSUE_8}`,
      },
    ],
    ...(observability === undefined ? {} : { observability }),
  });
  harness = pipeline;
  await pipeline.publish([ticketMatched(pipeline)]);
  await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
  await pipeline.publish([merged(pipeline)]);
  await pipeline.settle('done', (task) => task.state === 'done');
  await dutiesCompleted(pipeline, 1);
  return pipeline;
};

/** The last row the platform writes for a merge: the duty's job, completed (rule 87). */
const dutiesCompleted = async (pipeline: PipelineE2E, count: number): Promise<void> => {
  await pipeline.waitFor(`${count} resolve_on_merge job(s) completed`, async () => {
    const rows = await pipeline.query<{ n: string }>(
      `select count(*)::text as n from pgboss.job
        where name = 'pipeline.outbound' and state = 'completed'
          and data->>'duty' = 'resolve_on_merge'`,
    );
    return Number(rows[0]?.n) >= count;
  });
};

const resolveRows = (pipeline: PipelineE2E) =>
  pipeline.query<{ status: string; issue_id: string; integration_id: string; task: boolean }>(
    `select status, payload->>'issue_id' as issue_id, integration_id::text,
            task_id is not null as task
       from integration_actions where action = 'resolve_issue'
      order by created_at, id`,
  );

const providerResolves = (pipeline: PipelineE2E): number =>
  pipeline.errors.core.calls.filter((call) => call.action === 'resolve').length;

describe('resolve on merge (WP-111)', () => {
  it('resolves each linked issue once on a flagged binding, and a replayed merge resolves nothing twice', async () => {
    const pipeline = await mergeABug({ errors: ISSUES, resolveOnMerge: true });

    expect(await resolveRows(pipeline), 'one audited resolve per linked issue').toEqual([
      { status: 'ok', issue_id: 'issue-7', integration_id: ERRORS_INTEGRATION_ID, task: true },
      { status: 'ok', issue_id: 'issue-8', integration_id: ERRORS_INTEGRATION_ID, task: true },
    ]);
    expect(pipeline.errors.peek('issue-7')?.status).toBe('resolved');
    expect(pipeline.errors.peek('issue-8')?.status).toBe('resolved');
    expect(providerResolves(pipeline)).toBe(2);
    // Q43: the merge comments on nothing and links nothing in the error tracker.
    expect(pipeline.errors.peek('issue-7')?.comments).toEqual([]);
    expect(pipeline.errors.peek('issue-7')?.linked_mrs).toEqual([]);

    // A second `mr.merged` for the same task — a distinct event, standing in for any repeat that
    // got past the inbox and the log's lifecycle dedup (WP-110), so what is held here is the
    // duty's own idempotency.
    await pipeline.publish([merged(pipeline)]);
    await dutiesCompleted(pipeline, 2);

    expect(
      (await resolveRows(pipeline)).map((row) => `${row.issue_id}:${row.status}`),
      'the second wake-up replayed both resolves',
    ).toEqual(['issue-7:ok', 'issue-8:ok', 'issue-7:replayed', 'issue-8:replayed']);
    expect(providerResolves(pipeline), 'and the provider was asked nothing more').toBe(2);
  });

  it('resolves nothing on a binding that does not set the flag', async () => {
    const pipeline = await mergeABug({ errors: ISSUES });

    expect(await resolveRows(pipeline)).toEqual([]);
    expect(providerResolves(pipeline)).toBe(0);
    expect(pipeline.errors.peek('issue-7')?.status).toBe('unresolved');
  });

  it('resolves nothing for a project with no errors binding', async () => {
    const pipeline = await mergeABug(undefined);

    expect(await resolveRows(pipeline)).toEqual([]);
    expect(providerResolves(pipeline)).toBe(0);
  });
});
