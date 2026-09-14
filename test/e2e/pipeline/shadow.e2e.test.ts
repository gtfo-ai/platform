/**
 * **WP-34's acceptance, through a real `apps/server` instance**: a shadow batch on closed tickets
 * runs the whole pipeline, writes nothing outside the platform, and produces the comparison
 * product/19 §13 specifies.
 *
 * What this tier adds to `shadow/batch.test.ts` and `shadow/report.test.ts` is the **composition**:
 * the batch is started over HTTP through the real router, the real RBAC guard and the real
 * `Idempotency-Key` guard; the tasks are created by the production `PostgresPipelineStore`; the
 * provider reads and refusals go through the production `IntegrationActionExecutor`; and the report
 * is written by the production `PostgresShadowStore` from a `pipeline.outbound` job the instance's
 * own worker ran. Every assertion is on a row — `tasks`, `runs`, `integration_actions`,
 * `shadow_reports`, `cost_entries` — never on a return value (standing rule 79).
 *
 * **The fake runner picks its scenario from the spec** (standing rule 82): `scenarioFor` reads
 * `spec.mode`, so a build that lost `tasks.mode` on the way into `RunSpec` would script no scenario
 * at all and the run would fail by name rather than passing on a stage-keyed table.
 *
 * Every wait is on the last row the platform writes and the rest is asserted as what that row
 * implies (standing rule 87): the report row is written in the same transaction as
 * `shadow.report.created`, so waiting on the row bounds the event too, and the provider reads all
 * happen before it.
 */
import type { RunSpec } from '@platform/application';
import type { ShadowBatchResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { GIT_PROJECT, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** Two closed tickets the fake board knows, plus one whose human merge request has no base. */
const TICKETS = [
  {
    key: 'ACME-11',
    title: 'Sum the invoice footer',
    issueType: 'Story',
    description: 'Finance cannot read the invoice without a calculator.',
  },
  {
    key: 'ACME-12',
    title: 'Round the totals once',
    issueType: 'Story',
    description: 'Rounding happens twice and the figures disagree.',
  },
  {
    key: 'ACME-13',
    title: 'Rename the footer label',
    issueType: 'Story',
    description: 'The label says Sum and the design says Total.',
  },
];

const patch = (path: string, added: number): string =>
  [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,4 +1,5 @@',
    ...Array.from({ length: added }, (_, index) => `+line ${index}`),
  ].join('\n');

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post<{ user?: { id: string } }>('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const startBatch = async (
  client: Client,
  projectId: string,
  ticketKeys: readonly string[],
  key: string,
) =>
  client.json<{
    batch_id: string;
    started: number;
    refused: number;
    tickets: { ticket_key: string; task_id: string | null; refused_reason: string | null }[];
  }>(`/api/projects/${projectId}/shadow-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ ticket_keys: ticketKeys }),
  });

/**
 * A project at **Observe** with shadow mode on — the only dial position where `shadowMode` is true.
 *
 * `autonomy_policies` is written directly rather than through `PUT …/autonomy`, because the dial is
 * WP-30's surface and what this file is about is what the *batch* does once a project is there.
 */
const materialiseObserve = async (pipeline: PipelineE2E): Promise<void> => {
  await pipeline.query(
    `update projects
        set autonomy_level = 'observe',
            autonomy_policies = jsonb_build_object(
              'level', 'observe',
              'preset_version', 1,
              'applied_at', now(),
              'applied_by', null,
              'policies', $2::jsonb
            )
      where id = $1`,
    [
      pipeline.projectId,
      JSON.stringify({
        picks_up_new_tickets: false,
        stop_after_stage: null,
        plan_approval: 'always',
        plan_approval_size_threshold: null,
        plan_approval_for_risk_classes: true,
        probation: true,
        probation_tasks: 5,
        business_review: false,
        question_timeout: '1 working day',
        human_mr_rounds: 3,
        knowledge_auto_apply: false,
        budget_approval_threshold_usd: null,
        review_only: true,
        shadow_mode: true,
        suggested_readiness_min: 0,
      }),
    ],
  );
};

const start = async (options: { readonly budgetUsd?: number } = {}): Promise<PipelineE2E> => {
  const pipeline = await startPipeline({
    label: 'shadow',
    tickets: TICKETS,
    config: {
      version: 1,
      features: {
        shadow_mode: {
          enabled: true,
          ...(options.budgetUsd === undefined ? {} : { budget_usd: options.budgetUsd }),
        },
      },
    },
    scenarios: featureScenarios,
    /**
     * Standing rule 82: the scenario is chosen from the **spec**, not from a stage-keyed table.
     *
     * `spec.mode` is the field this work package exists to make reachable (`runModeFor` maps
     * `tasks.mode` onto it and nothing had ever driven the shadow branch). Returning `undefined`
     * falls through to the stage map, so the *normal* tasks in this file are unaffected — and a
     * build that lost the mode would script no shadow scenario at all and fail by name.
     */
    scenarioFor: (spec: RunSpec, world) => {
      if (spec.mode !== 'shadow') {
        return undefined;
      }
      const scenarios: Readonly<Record<string, { structuredOutput: unknown }>> =
        featureScenarios(world);
      return scenarios[spec.stage ?? ''];
    },
  });
  await materialiseObserve(pipeline);
  return pipeline;
};

/** Seeds the human history the comparison is made against. */
const seedHistory = (pipeline: PipelineE2E): void => {
  for (const [key, base] of [
    ['ACME-11', 'b'.repeat(40)],
    ['ACME-12', 'c'.repeat(40)],
    // Q82 (a)'s refusal: a merged merge request whose `diff_refs` the provider has not populated.
    ['ACME-13', null],
  ] as const) {
    pipeline.git.seedMergedMergeRequest({
      project: GIT_PROJECT,
      title: `Fix it (${key})`,
      branch: `feature/${key.toLowerCase()}`,
      mergedAt: '2026-08-01T09:00:00.000Z',
      baseSha: base,
      files: [{ path: 'src/totals.ts', diff: patch('src/totals.ts', 30) }],
    });
  }
};

describe('a shadow batch on closed tickets', () => {
  it('runs the pipeline, writes nothing outside the platform, and reports the comparison', async () => {
    const pipeline = await start();
    harness = pipeline;
    seedHistory(pipeline);
    // The diff the shadow runs' own merge request answers with, so both sides of the comparison
    // exist. `world.mr` is the merge request every `ImplementationNotes` claims.
    pipeline.git.setDiff({
      project: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      files: [
        { path: 'src/totals.ts', diff: patch('src/totals.ts', 20) },
        { path: 'src/totals.test.ts', diff: patch('src/totals.test.ts', 10) },
      ],
    });

    const client = await signIn(pipeline.instance.baseUrl);

    // The header is required on a POST that creates (technical/08 § Principles), and a header that
    // is optional is a header production omits — so the refusal is asserted first.
    const unkeyed = await client.json<{ error: { code: string } }>(
      `/api/projects/${pipeline.projectId}/shadow-batches`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket_keys: ['ACME-11'] }),
      },
    );
    expect(unkeyed.status).toBe(400);
    expect(unkeyed.body.error.code).toBe('idempotency_key_required');

    const created = await startBatch(
      client,
      pipeline.projectId,
      ['ACME-11', 'ACME-12', 'ACME-13'],
      'shadow-batch-1',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    expect(created.body.started).toBe(2);
    expect(created.body.refused).toBe(1);
    expect(
      created.body.tickets.find((entry) => entry.ticket_key === 'ACME-13')?.refused_reason,
    ).toContain('no merge base');

    // ── the countable effects ────────────────────────────────────────────────

    await pipeline.waitFor('both shadow tasks have a report', async () => {
      const rows = await pipeline.query<{ count: string }>(
        `select count(*)::text as count from shadow_reports r
           join tasks t on t.id = r.task_id where t.project_id = $1`,
        [pipeline.projectId],
      );
      return Number(rows[0]?.count ?? 0) === 2;
    });

    const tasks = await pipeline.query<{ mode: string; ticket_key: string }>(
      'select mode, ticket_key from tasks where project_id = $1 order by ticket_key',
      [pipeline.projectId],
    );
    expect(tasks.map((task) => task.ticket_key)).toEqual(['ACME-11', 'ACME-12']);
    expect(tasks.every((task) => task.mode === 'shadow')).toBe(true);

    // `runs.mode` — the planner maps it and, until this work package, no tier had driven it.
    const runs = await pipeline.query<{ mode: string }>(
      'select distinct mode from runs where project_id = $1',
      [pipeline.projectId],
    );
    expect(runs.map((run) => run.mode)).toEqual(['shadow']);

    /**
     * **Nothing external happened**, read from `integration_actions` rather than from a port's
     * return value.
     *
     * The positive half first (standing rules 10 and 29): the walk really did reach mutating
     * writes, so "none was performed" is a statement about a path that was taken.
     */
    const audit = await pipeline.auditRows();
    const mutating = audit.filter((row) => MUTATING.has(row.action));
    expect(mutating.length).toBeGreaterThan(0);
    expect(mutating.filter((row) => row.status !== 'would_have')).toEqual([]);
    // …and the board itself has no comment on either ticket: the workpad the platform would have
    // written is the `would_have` row above, and `peek` is the fake's own record of what it holds.
    for (const key of ['ACME-11', 'ACME-12']) {
      expect(pipeline.tickets.peek(key)?.comments ?? [], key).toEqual([]);
    }

    // ── the report, read back through the API ────────────────────────────────

    const listed = await client.json<{ items: { id: string }[]; can_start: boolean }>(
      `/api/projects/${pipeline.projectId}/shadow-batches`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.can_start).toBe(true);
    const batchId = listed.body.items[0]?.id as string;

    const detail = await client.json<ShadowBatchResponse>(`/api/shadow-batches/${batchId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.batch.tickets).toBe(3);
    expect(detail.body.batch.refused).toBe(1);
    expect(detail.body.aggregate.reported).toBe(2);
    expect(detail.body.aggregate.compared).toBe(2);

    const reported = detail.body.tickets.find((entry) => entry.ticket_key === 'ACME-11');
    expect(reported?.human_mr).not.toBeNull();
    expect(reported?.base_sha).toBe('b'.repeat(40));
    expect(reported?.human_mr_source).toBe('title_scan');
    // Both diffs were read through the production executor. The agent touched `src/totals.ts` and
    // `src/totals.test.ts`, the human only `src/totals.ts`: one shared file, two in the union.
    expect(reported?.similarity).toBeCloseTo(0.5, 10);
    expect(reported?.report?.agent_diff_stats?.files_changed).toBe(2);
    expect(reported?.report?.overlap?.human_test_files).toBe(0);

    // The refused ticket is on the batch with its reason and **no** task.
    const refused = detail.body.tickets.find((entry) => entry.ticket_key === 'ACME-13');
    expect(refused?.task_id).toBeNull();
    expect(refused?.refused_reason).toContain('no merge base');

    // `shadow.report.created`'s first consumer: the batch is marked complete once every one of its
    // tasks has a report.
    await pipeline.waitFor('the batch is complete', async () => {
      const rows = await pipeline.query<{ completed_at: Date | null }>(
        'select completed_at from shadow_batches where id = $1',
        [batchId],
      );
      return rows[0]?.completed_at != null;
    });

    // One event per report, and no more: the duty is at-least-once and the event is not.
    const events = await pipeline.events();
    expect(events.filter((event) => event.type === 'shadow.report.created')).toHaveLength(2);
  }, 180_000);

  it('stops a batch when the project’s separate shadow budget is spent', async () => {
    /**
     * **2.50 USD, chosen so the cap bites on the *second* admission** rather than the first.
     *
     * The guard adds what this stage *may* spend to what shadow tasks *have* spent
     * (`taskBudgetExhausted`'s rule, and for its reason: a budget checked only against past spend is
     * a budget discovered one run too late). `refinement` may spend 2 and `architecture` 5, and the
     * scripted runs cost 0.40 each — so 2.50 admits the first run (0 + 2 ≤ 2.5) and refuses the
     * second (0.40 + 5 > 2.5), which leaves a **ledger row** for the assertion to read. A cap below
     * 2 would refuse the first run and prove only that a number was compared with zero.
     */
    const pipeline = await start({ budgetUsd: 2.5 });
    harness = pipeline;
    seedHistory(pipeline);
    const client = await signIn(pipeline.instance.baseUrl);

    const created = await startBatch(client, pipeline.projectId, ['ACME-11'], 'shadow-budget-1');
    expect(created.status, JSON.stringify(created.body)).toBe(202);

    await pipeline.settle(
      'the shadow task pauses on its budget',
      (task) => task.state === 'paused',
    );

    /**
     * Read from the **ledger**, never from a status code (standing rule 79, criterion 7).
     *
     * `cost_entries` is what the guard sums, so a build whose guard read something else — the task
     * column, a rollup, nothing at all — would fail here rather than pass on a task it paused for a
     * different reason.
     */
    const spend = await pipeline.query<{ usd: string }>(
      `select coalesce(sum(c.usd), 0)::text as usd
         from cost_entries c join tasks t on t.id = c.task_id
        where c.project_id = $1 and t.mode = 'shadow'`,
      [pipeline.projectId],
    );
    expect(Number(spend[0]?.usd ?? 0)).toBeGreaterThan(0);
    // …and below the cap, which is what makes this the *admission* guard rather than a run that
    // overspent: BD-010's rule is that a budget prevents **new** runs and running runs finish.
    expect(Number(spend[0]?.usd ?? 0)).toBeLessThan(2.5);

    // Exactly one run started: the second admission was refused before a `runs` row existed.
    const runs = await pipeline.query<{ count: string }>(
      'select count(*)::text as count from runs where project_id = $1',
      [pipeline.projectId],
    );
    expect(Number(runs[0]?.count ?? 0)).toBe(1);
  }, 180_000);
});

/**
 * The mutating actions a ticket task's walk reaches, by name.
 *
 * A list rather than a flag on the row, because `integration_actions` carries no `mutating` column:
 * a read and a mutation both record `ok`, so a test that asserted `status === 'ok'` over every row
 * would be green on a walk that made only reads.
 */
const MUTATING = new Set([
  'upsert_workpad',
  'transition',
  'create_discussion',
  'open_merge_request',
  'set_reviewers',
  'update_merge_request',
]);
