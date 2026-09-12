/**
 * **WP-19's acceptance criteria, on a real `apps/server` instance and a real PostgreSQL.**
 *
 * The plan row's words: *"reconciliation test: sum of entries = rollups; budget pause behaviour;
 * … a finished multi-model run's per-model usage is readable through `GET /api/runs/:run_id`
 * rather than `[]`, **from rows the ledger wrote rather than a seeded table**"*. So nothing here
 * inserts a `cost_entries`, a `cost_rollup_daily`, a `run_model_usage` or a `budget_windows` row:
 * a ticket is published, the instance's own workers run it, and the ledger's own handler is what
 * fills every table asserted below.
 *
 * The one row a test does seed is a **`budgets` row**, which is configuration rather than ledger
 * output — an operator sets a cap, and the question is whether the projection the ledger writes
 * stops the next run (BD-010: "no new runs for that project; running runs finish").
 *
 * ## Which composition, and why it matters here (standing rule 82)
 *
 * `FakeClaudeRunner` — the default harness — reports `usage`, a `cost.usd` of 0.40 and
 * **`modelUsage: []`** (`test/e2e/support/pipeline.ts`). That is enough to reconcile entries against
 * rollups, and it is *structurally incapable* of showing a per-model row, because there are no
 * per-model numbers in it. The per-model case therefore uses `agent: 'real-over-fake-cli'`, where
 * the production runner reads a real `result` line off a scripted CLI that reports two models — the
 * run's own and a sub-agent's — through the production `normaliseModelUsage`.
 */
import type { RunRecord } from '@platform/contracts';
import { budgetsResponseSchema } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { SUBAGENT_COST_USD, SUBAGENT_MODEL } from '../support/agent-workspace.js';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
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

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const sum = (values: readonly number[]): number =>
  Math.round(values.reduce((total, value) => total + value, 0) * 1_000_000) / 1_000_000;

describe('the cost ledger, over runs this pipeline made', () => {
  it('reconciles: the entries sum to the rollups and to the task’s own recorded spend', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'cost-ledger',
      tickets: TICKETS,
    });
    harness = pipeline;

    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    const spent = Number(waiting.cost_actual);
    expect(spent).toBeGreaterThan(0);

    // The ledger is a handler, so it commits with the event rather than with the task row: wait for
    // the rows themselves rather than inferring them from a state (standing rule 76).
    await pipeline.waitFor(
      'one ledger entry per finished run',
      async () => (await pipeline.costRows()).entries.length >= pipeline.specs.length,
    );

    const rows = await pipeline.costRows();
    expect(rows.entries.length).toBe(pipeline.specs.length);
    // **The reconciliation.** Three totals derived by three different writers on three tables.
    expect(sum(rows.entries.map((entry) => entry.usd))).toBeCloseTo(spent, 6);
    expect(sum(rows.rollups.map((row) => row.usd))).toBeCloseTo(spent, 6);

    // One run per rollup row, and the wall time counted once each: a two-model run must not count
    // as two runs (the reason `rollupDeltasFor` puts the counters on one entry).
    expect(rows.rollups.reduce((total, row) => total + row.runs, 0)).toBe(pipeline.specs.length);
    expect(rows.rollups.every((row) => row.mode === 'actual')).toBe(true);
    expect(rows.rollups.every((row) => row.template === 'feature')).toBe(true);

    // Every stage the pipeline ran has a ledger row naming it, which is what makes "cost per stage"
    // a query rather than a reconstruction.
    expect([...new Set(rows.entries.map((entry) => entry.stage))].sort()).toEqual(
      [...new Set(pipeline.specs.map((spec) => spec.stage))].sort(),
    );
    // The ledger stores numbers and identifiers (TD-012): nothing it wrote carries the ticket's
    // words, the agent's answer, or the model credential the transcript had to redact.
    const written = JSON.stringify(rows);
    expect(written).not.toContain('invoice footer');
    expect(written).not.toContain('ANTHROPIC_API_KEY');

    // **The estimate** (product/09, Q65): the refined spec's size is on the task, and the estimate
    // is `null` rather than a number — this is the project's first task, so there is no history to
    // estimate from and the platform records none (standing rule 16).
    expect(waiting.size).toBe('M');
    expect(waiting.estimate_usd).toBeNull();
  });

  it('pauses the task when the project’s budget is exhausted, and runs nothing', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'cost-budget-blocked',
      tickets: TICKETS,
    });
    harness = pipeline;
    // Configuration, not ledger output: the cap is set and already spent.
    await pipeline.seedBudget({ scope: 'project', window: 'month', limitUsd: 5, spentUsd: 5 });

    await pipeline.publish([ticketMatched(pipeline)]);
    const paused = await pipeline.settle('paused', (task) => task.state === 'paused');
    expect(Number(paused.cost_actual)).toBe(0);
    expect(pipeline.specs).toEqual([]);
    expect((await pipeline.costRows()).entries).toEqual([]);
  });

  it('runs and charges the same budget when it has room, and serves the window over HTTP', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'cost-budget-open',
      tickets: TICKETS,
    });
    harness = pipeline;
    const budgetId = await pipeline.seedBudget({
      scope: 'project',
      window: 'month',
      limitUsd: 1000,
    });
    /**
     * A **stale** window of the same budget, carrying a number nothing in this run can produce.
     *
     * It is the other half of the read's assertion (standing rule 42): `GET …/budgets` picks the
     * row for the window the request falls in, and a reader that joined on the budget alone — or
     * whose key comparison did not match — would answer either this 999 or a plausible 0. Both are
     * numbers a dashboard would render without complaint.
     */
    await pipeline.seedBudgetWindow({
      budgetId,
      windowStart: '2020-01-01T00:00:00.000Z',
      spentUsd: 999,
    });
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    await pipeline.waitFor('the budget window to carry the run’s spend', async () =>
      (await pipeline.costRows()).windows.some(
        (row) => row.budget_id === budgetId && row.spent_usd > 0,
      ),
    );

    const rows = await pipeline.costRows();
    const charged = rows.windows.filter(
      (row) => row.budget_id === budgetId && row.spent_usd !== 999,
    );
    expect(charged).toHaveLength(1);
    expect(charged[0]?.spent_usd).toBeCloseTo(Number(waiting.cost_actual), 6);
    expect(pipeline.specs.length).toBeGreaterThan(0);

    /**
     * A budget an operator adds **after** the spend, with an old window row of its own.
     *
     * This is the other side, and it is the half that a `Map` keyed on the budget alone passes
     * without it (measured: that mutation survived the first version of this test, because a map
     * built from two rows of one budget keeps the last and the last happened to be the right one).
     * Its current window has no row at all, so the only correct answer is **0** — while a reader
     * that ignored the window would answer 999.
     */
    // A *day* budget: `budgets_scope_scope_id_window_key` admits one row per
    // (scope, scope_id, window), so the second budget of this project differs in its window.
    const uncharged = await pipeline.seedBudget({
      scope: 'project',
      window: 'day',
      limitUsd: 500,
    });
    await pipeline.seedBudgetWindow({
      budgetId: uncharged,
      windowStart: '2020-02-01T00:00:00.000Z',
      spentUsd: 999,
    });

    // ── the read API over the same projection (WP-19's `/budgets`) ──
    const response = await client.json<unknown>(`/api/projects/${pipeline.projectId}/budgets`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // Parsed by the published schema rather than spot-checked, so this also asserts that the
    // projection invents no key and omits none.
    const body = budgetsResponseSchema.parse(response.body);
    const served = body.items.find((item) => item.id === budgetId);
    expect(served).toBeDefined();
    expect(served?.limit_usd).toBe(1000);
    // The number the ledger wrote for the window the request falls in — not 999, and not 0.
    expect(served?.spent_usd).toBeCloseTo(charged[0]?.spent_usd as number, 6);
    expect(served?.spent_usd).toBeGreaterThan(0);
    expect(served?.window_start).toBe(charged[0]?.window_start);

    const empty = body.items.find((item) => item.id === uncharged);
    expect(empty).toBeDefined();
    expect(empty?.spent_usd).toBe(0);
    expect(empty?.window_start).not.toBe('2020-02-01T00:00:00.000Z');

    // A project that does not exist is a 404, not an empty list: "this project has no budgets" and
    // "there is no such project" are different answers, and the timezone read is what tells them
    // apart (`findProjectTimezone` returns `undefined` for the second).
    const unknown = await client.json('/api/projects/00000000-0000-4000-8000-0000000000ff/budgets');
    expect(unknown.status).toBe(404);

    // Per route, like WP-15h's five: a new endpoint that forgot `requirePermission` is the failure
    // this catches, and it is invisible to every authenticated assertion above.
    const anonymous = await new Client(pipeline.instance.baseUrl).json(
      `/api/projects/${pipeline.projectId}/budgets`,
    );
    expect(anonymous.status).toBe(401);

    /**
     * The organisation's zone set to something `assertTimeZone` refuses.
     *
     * The ledger fails open to UTC for this state (it warns and charges anyway), and a read that
     * threw would answer **500** in exactly the case the fallback exists for — the dashboard dying
     * on the misconfiguration it is there to show. Both halves are asserted: still 200, and the
     * window it reports is the UTC one the ledger charged in.
     */
    await pipeline.setOrganisationTimezone('+02:00');
    const substituted = await client.json<unknown>(`/api/projects/${pipeline.projectId}/budgets`);
    expect(substituted.status, JSON.stringify(substituted.body)).toBe(200);
    const fallback = budgetsResponseSchema
      .parse(substituted.body)
      .items.find((item) => item.id === budgetId);
    expect(fallback?.spent_usd).toBeCloseTo(charged[0]?.spent_usd as number, 6);
    expect(fallback?.window_start).toBe(charged[0]?.window_start);
  });
});

describe('the per-model usage of a multi-model run', () => {
  it('is readable through GET /api/runs/:run_id, from rows the ledger wrote', async () => {
    let firstRunId: string | null = null;
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'cost-model-usage',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      onAgentSpec: async (spec) => {
        firstRunId ??= spec.runId;
      },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    const runId = firstRunId as unknown as string;

    await pipeline.waitFor(
      'the ledger to write this run’s per-model usage',
      async () =>
        (await pipeline.costRows()).modelUsage.filter((row) => row.run_id === runId).length >= 2,
    );

    const response = await client.json<RunRecord>(`/api/runs/${runId}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const run = response.body;
    // Not `[]` — which is what every run answered before this work package, because nothing had
    // ever inserted a `run_model_usage` row.
    expect(run.model_usage.length).toBe(2);
    expect(run.model_usage.map((usage) => usage.model).sort()).toEqual(
      [SUBAGENT_MODEL, run.model].sort(),
    );
    const subagent = run.model_usage.find((usage) => usage.model === SUBAGENT_MODEL);
    expect(subagent?.usd).toBeCloseTo(SUBAGENT_COST_USD, 6);
    expect(subagent?.input_tokens).toBe(200);
    // The per-model numbers sum to what the run reported, which is the ledger's own invariant.
    expect(sum(run.model_usage.map((usage) => usage.usd))).toBeCloseTo(run.cost.usd, 6);

    // And the ledger charged both models, with the split totalling the invoice.
    const entries = (await pipeline.costRows()).entries.filter((entry) => entry.run_id === runId);
    expect(entries).toHaveLength(2);
    expect(sum(entries.map((entry) => entry.usd))).toBeCloseTo(run.cost.usd, 6);
  });
});
