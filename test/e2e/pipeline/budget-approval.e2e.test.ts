/**
 * **The budget-approval gate, on a real `apps/server` instance** — WP-28, product/09's
 * *"Estimate before spend"*.
 *
 * The unit tier drives every branch of `budgetApprovalGate` against in-memory doubles. What only
 * this tier can make is the whole chain: a task that really finishes and whose spend really becomes
 * the project's history, an estimate written by the real `costEstimateHandler` from a real
 * `RefinedSpec` artifact, a threshold **materialised over HTTP** into `projects.autonomy_policies`
 * by WP-30's route, and a maintainer deciding the approval through WP-15i's decide endpoint with a
 * session cookie. Nothing here seeds a `tasks.estimate_usd`, an `approvals` row or a budget.
 *
 * ## Why this file needs `scenarioFor` (standing rule 82)
 *
 * Every other pipeline e2e picks its scripted run from `spec.stage`, which gives **every task in
 * the instance** the same cost for a given stage. This case cannot live with that: it needs one
 * task whose recorded spend becomes the history, and later tasks whose recorded spend **differs**
 * from the estimate made out of it — otherwise `estimate_accuracy` is 1.00 by construction and the
 * assertion would pass on a projection that returned a constant. `scenarioFor` reads the whole
 * `RunSpec`, so the fake can charge the history task 4.00 a stage and the rest 1.00.
 *
 * ## The arithmetic, stated once so the thresholds below are readable
 *
 * `featureScenarios` produces an **M** spec and an M plan. `SIZE_COST_WEIGHTS.M` is 2, so one
 * finished M task costing `c` gives the next M task an estimate of exactly `c`. ACME-1 walks all
 * seven agent stages, each charged a little under that stage's own per-run cap, and finishes at
 * **27.00** — which is above *Assist*'s budget-approval threshold of 20 and below *Supervised*'s of
 * 50. One number, two verdicts, and the dial is the only thing that differs (standing rule 42).
 *
 * **Why the costs are per stage rather than one flat figure, measured rather than chosen.** A first
 * draft charged 4.00 a stage and the history task escalated to `needs_human` at refinement:
 * `FakeClaudeRunner`'s divergence **5** throws when a scenario's cost exceeds
 * `RunSpec.limits.maxBudgetUsd` without ending in `budget_exceeded`, and `refinement`'s cap is 2.00
 * (`DEFAULT_STAGE_RUN_BUDGET_USD`). The fake is right and the fixture was wrong — a run that spends
 * twice its cap is a run production stops. Every figure in {@link HISTORY_STAGE_USD} is therefore
 * under its stage's cap, and the running total stays under BD-010's per-task cap of 50 at every
 * admission (the tightest is `implementation`, checked at 5.50 + 15.00).
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { AUTONOMY_PRESETS } from '@platform/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  type ScenarioSpec,
  startPipeline,
} from '../support/pipeline.js';
import { featureScenarios } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * What each of the history task's seven stages costs — each under that stage's own per-run cap.
 *
 * `DEFAULT_STAGE_RUN_BUDGET_USD` for reference: refinement 2, architecture 5, implementation 15,
 * code_review 5, business_review 3, retrospective 2, librarian 2.
 */
const HISTORY_STAGE_USD: Readonly<Record<string, number>> = {
  refinement: 1.5,
  architecture: 4,
  implementation: 12,
  code_review: 4,
  business_review: 2.5,
  retrospective: 1.5,
  librarian: 1.5,
};
/** Every later task's stages, flat and cheap: under the tightest cap of the seven. */
const LATER_STAGE_USD = 0.5;
/** Produced rather than quoted (standing rule 39): what {@link HISTORY_STAGE_USD} sums to. */
const HISTORY_TOTAL_USD = Object.values(HISTORY_STAGE_USD).reduce((sum, usd) => sum + usd, 0);

const TICKETS = [
  { key: 'ACME-1', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  { key: 'ACME-2', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  { key: 'ACME-3', title: 'Show the totals in the invoice footer', issueType: 'Story' },
  { key: 'ACME-4', title: 'Show the totals in the invoice footer', issueType: 'Story' },
];

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

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

interface TaskRow extends Record<string, unknown> {
  id: string;
  state: string;
  current_stage: string | null;
  cost_actual: string;
  estimate_usd: string | null;
  estimate_basis: string | null;
  estimate_samples: number | null;
}

const taskOf = async (pipeline: PipelineE2E, key: string): Promise<TaskRow | undefined> => {
  const rows = await pipeline.query<TaskRow>(
    `select id, state, current_stage, cost_actual, estimate_usd, estimate_basis, estimate_samples
       from tasks where ticket_key = $1`,
    [key],
  );
  return rows[0];
};

/** Waits for a ticket's task to be in one of the given states, and answers the row. */
const settleTicket = async (
  pipeline: PipelineE2E,
  key: string,
  states: readonly string[],
): Promise<TaskRow> => {
  await pipeline.waitFor(`${key} to reach ${states.join(' or ')}`, async () => {
    const row = await taskOf(pipeline, key);
    return row !== undefined && states.includes(row.state);
  });
  const row = await taskOf(pipeline, key);
  if (row === undefined) {
    throw new Error(`no task for ${key}`);
  }
  return row;
};

const approvalsOf = async (
  pipeline: PipelineE2E,
  taskId: string,
): Promise<readonly { id: string; kind: string; status: string }[]> =>
  pipeline.query<{ id: string; kind: string; status: string }>(
    'select id, kind, status from approvals where task_id = $1 order by requested_at',
    [taskId],
  );

const stagesRun = async (pipeline: PipelineE2E, taskId: string): Promise<readonly string[]> => {
  const rows = await pipeline.query<{ stage: string }>(
    `select ts.stage from runs r join task_stages ts on ts.id = r.task_stage_id
      where r.task_id = $1 order by r.created_at`,
    [taskId],
  );
  return rows.map((row) => row.stage);
};

const decide = async (
  client: Client,
  taskId: string,
  approvalId: string,
  decision: 'approve' | 'reject',
  key: string,
  reason?: string,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  client.json(`/api/tasks/${taskId}/approvals/${approvalId}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ decision, ...(reason === undefined ? {} : { reason }) }),
  }) as Promise<{ status: number; body: Record<string, unknown> }>;

describe('the budget-approval gate, end to end', () => {
  it('gates the expensive task, lets the same estimate through under a higher threshold, and ends both decisions', async () => {
    // The history task is the **first** task the instance runs — ACME-1 is published alone and is
    // driven to `done` before anything else is published — so the first `taskId` the fake is asked
    // about is its. Keyed off the id rather than off a run counter, because the pipeline decides how
    // many runs a task makes and a counter would silently re-key if it made one more.
    let historyTaskId: string | null = null;
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      scenarioFor: (spec, world) => {
        if (historyTaskId === null) {
          historyTaskId = spec.taskId;
        }
        const byStage: Readonly<Record<string, ScenarioSpec>> = featureScenarios(world);
        const scenario = byStage[spec.stage ?? ''];
        if (scenario === undefined) {
          return undefined;
        }
        const history = HISTORY_STAGE_USD[spec.stage ?? ''] ?? LATER_STAGE_USD;
        return {
          ...scenario,
          costUsd: spec.taskId === historyTaskId ? history : LATER_STAGE_USD,
        };
      },
      label: 'budget-gate',
      tickets: TICKETS,
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);
    const dial = `/api/projects/${pipeline.projectId}/autonomy`;

    // The two thresholds this case straddles, read off the shipped table rather than restated: a
    // release that edits product/19 §11's numbers should fail here loudly rather than quietly stop
    // exercising both sides of the gate (standing rule 39).
    expect(AUTONOMY_PRESETS.assist.budgetApprovalThresholdUsd).toBeLessThan(HISTORY_TOTAL_USD);
    expect(AUTONOMY_PRESETS.supervised.budgetApprovalThresholdUsd).toBeGreaterThan(
      HISTORY_TOTAL_USD,
    );

    // ── 1. The history: one task that really finishes, and really spends ─────────────────────
    //
    // The project's dial has **not** been materialised yet, which is the shape `planApprovalGate`
    // treats as pre-WP-30 — no probation — so this task walks through without any approval and the
    // history is built by the pipeline rather than by an insert (standing rule 82).
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const waiting = await settleTicket(pipeline, 'ACME-1', ['ready_for_merge']);
    expect(historyTaskId).toBe(waiting.id);
    await pipeline.publish([merged(pipeline)]);
    const finished = await settleTicket(pipeline, 'ACME-1', ['done']);
    expect(Number(finished.cost_actual)).toBeCloseTo(HISTORY_TOTAL_USD, 6);
    // The project's first task has no history of its own: the estimator **refused** rather than
    // inventing a number, and recorded the refusal (Q71 (b), standing rule 16).
    expect(finished.estimate_usd).toBeNull();
    expect(finished.estimate_basis).toBe('unknown');
    expect(finished.estimate_samples).toBe(0);

    // ── 2. Supervised: the estimate is under the threshold, so the budget gate does not fire ──
    const supervised = await client.json<{ level: string }>(dial, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'dial-supervised' },
      body: JSON.stringify({ autonomy: 'supervised' }),
    });
    expect(supervised.status, JSON.stringify(supervised.body)).toBe(200);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-2')]);
    // Supervised turns probation on, so this task parks at a **plan** approval — which is the
    // point: the task stopped, and not because of the spend. Asserting only "it did not stop"
    // would be satisfied by a gate that never ran at all (standing rule 10).
    const underThreshold = await settleTicket(pipeline, 'ACME-2', ['waiting_approval']);
    expect(Number(underThreshold.estimate_usd)).toBeCloseTo(HISTORY_TOTAL_USD, 6);
    expect(underThreshold.estimate_basis).toBe('project_history');
    expect(underThreshold.estimate_samples).toBe(1);
    expect((await approvalsOf(pipeline, underThreshold.id)).map((row) => row.kind)).toEqual([
      'plan',
    ]);
    // It got past refinement, which is where a budget gate would have stopped it.
    expect(await stagesRun(pipeline, underThreshold.id)).toEqual(['refinement', 'architecture']);

    // ── 3. Assist: the same estimate, a lower threshold, and the task waits for the spend ─────
    const assist = await client.json<{ level: string }>(dial, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'dial-assist' },
      body: JSON.stringify({ autonomy: 'assist' }),
    });
    expect(assist.status, JSON.stringify(assist.body)).toBe(200);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-3')]);
    const gated = await settleTicket(pipeline, 'ACME-3', ['waiting_approval']);
    expect(Number(gated.estimate_usd)).toBeCloseTo(HISTORY_TOTAL_USD, 6);
    const gatedApprovals = await approvalsOf(pipeline, gated.id);
    expect(gatedApprovals.map((row) => row.kind)).toEqual(['budget']);
    // product/09's *"before Implementation"*: refinement ran, and nothing after it did.
    expect(await stagesRun(pipeline, gated.id)).toEqual(['refinement']);

    // The workpad says so on the ticket a human reads (product/18:31). Waited on the row the
    // assertion reads — the comment the outbound job writes — rather than on the task's state,
    // which the pipeline commits first (standing rule 87).
    //
    // **Waited on the exact line asserted, not on a nearer one.** The first draft waited for the
    // body to contain `'Estimate:'` and then asserted the figure — and the render caused by
    // `task.stage.entered refinement` already satisfies that wait, with
    // `Estimate: not yet — a task is estimated when refinement completes`, because the estimator
    // runs on the `artifact.created` the stage has not produced yet. Measured, every run: standing
    // rules 76 and 87 in one line.
    const ESTIMATE_LINE = `Estimate: ${HISTORY_TOTAL_USD.toFixed(2)} USD (from 1 finished task in this project)`;
    const WORKPAD_HEADER = '**ACME-3** — waiting_approval (refinement)';
    await pipeline.waitFor(
      'the workpad for ACME-3 to render the estimate it waits on',
      async () => {
        const body = pipeline.tickets.peek('ACME-3')?.comments[0]?.body ?? '';
        return body.includes(ESTIMATE_LINE) && body.startsWith(WORKPAD_HEADER);
      },
    );
    const workpad = pipeline.tickets.peek('ACME-3')?.comments[0]?.body ?? '';
    expect(workpad).toContain(ESTIMATE_LINE);
    // The header, so the assertion is about the render the *gate* caused rather than any render
    // that happens to carry the line (standing rule 10).
    expect(workpad.split('\n')[0]).toBe(WORKPAD_HEADER);
    // One sticky comment, however many times the task moved (BD-023).
    expect(pipeline.tickets.peek('ACME-3')?.comments).toHaveLength(1);

    // …and the task page serves the same three fields plus the accuracy (product/19 §10).
    const detail = await client.json<TaskDetailResponse>(`/api/tasks/${gated.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.task.estimate_usd).toBeCloseTo(HISTORY_TOTAL_USD, 6);
    expect(detail.body.task.estimate_basis).toBe('project_history');
    expect(detail.body.task.estimate_samples).toBe(1);
    // One cheap run against a 27.00 estimate — a ratio a projection returning a constant
    // could not produce, which is why the fake charges the two tasks differently.
    expect(detail.body.task.cost_actual_usd).toBeCloseTo(LATER_STAGE_USD, 6);
    expect(detail.body.task.estimate_accuracy).toBeCloseTo(LATER_STAGE_USD / HISTORY_TOTAL_USD, 6);
    expect(detail.body.approvals.map((approval) => approval.kind)).toEqual(['budget']);

    // ── 4. Approved: the task carries on, and the replay performs nothing twice ───────────────
    const approvalId = gatedApprovals[0]?.id as string;
    const approved = await decide(client, gated.id, approvalId, 'approve', 'budget-approve-1');
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);

    await pipeline.waitFor('ACME-3 to run the stage the approval released', async () =>
      (await stagesRun(pipeline, gated.id)).includes('architecture'),
    );
    // Countable effects, not status codes (standing rule 79): one approval row, one decision, one
    // audit row — and the same key again leaves none extra.
    const replay = await decide(client, gated.id, approvalId, 'approve', 'budget-approve-1');
    expect(replay.status).toBe(200);
    // Scoped to the **budget** approval: at *Assist* the plan gate asks for one of its own the
    // moment architecture finishes, and counting every approval of the task would make this
    // assertion a race against a different gate.
    expect(
      (await approvalsOf(pipeline, gated.id)).filter((row) => row.kind === 'budget'),
    ).toHaveLength(1);
    expect(
      await pipeline.query(
        "select 1 from human_actions where action = 'task.approval.decide' and task_id = $1",
        [gated.id],
      ),
    ).toHaveLength(1);
    const decidedEvents = (await pipeline.events()).filter(
      (event) =>
        event.type === 'task.approval.decided' &&
        (event.payload as { task_id?: string }).task_id === gated.id,
    );
    expect(decidedEvents).toHaveLength(1);

    // ── 5. Rejected: the task stops for a human, and nothing of the spend was made ────────────
    await pipeline.publish([ticketMatched(pipeline, 'ACME-4')]);
    const refused = await settleTicket(pipeline, 'ACME-4', ['waiting_approval']);
    const refusedApprovals = await approvalsOf(pipeline, refused.id);
    expect(refusedApprovals.map((row) => row.kind)).toEqual(['budget']);

    const rejected = await decide(
      client,
      refused.id,
      refusedApprovals[0]?.id as string,
      'reject',
      'budget-reject-1',
      'not worth it this quarter',
    );
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);

    const parked = await settleTicket(pipeline, 'ACME-4', ['needs_human']);
    // A rejected *budget* is not a rejected *plan*: the task does not walk back into its own gate.
    expect(await stagesRun(pipeline, parked.id)).toEqual(['refinement']);
    expect(await approvalsOf(pipeline, parked.id)).toHaveLength(1);
    expect((await approvalsOf(pipeline, parked.id))[0]?.status).toBe('rejected');
    expect(Number(parked.cost_actual)).toBeCloseTo(LATER_STAGE_USD, 6);
    const escalations = (await pipeline.events()).filter(
      (event) =>
        event.type === 'task.escalated' &&
        (event.payload as { task_id?: string }).task_id === parked.id,
    );
    expect(escalations).toHaveLength(1);
    const brief = (escalations[0]?.payload as { blocker_brief?: string } | undefined)
      ?.blocker_brief;
    expect(brief).toContain('not worth it this quarter');
    // The reason a maintainer typed reaches the ticket through the workpad's blocker block, so it
    // is the same redacted text `decideTaskApproval` stored (WP-15i's nine fields).
    expect(brief).toContain('threshold');
  }, 300_000);
});
