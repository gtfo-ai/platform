/**
 * **The autonomy dial and BD-010's budgets, over HTTP, against a real instance** (WP-30).
 *
 * Three things this tier owns, and each is one the cheaper tiers cannot honestly make:
 *
 *  - **The dial is materialised by a real request and read back out of a real column.** Every other
 *    assertion about BD-027:14 is about a function; this one is about `jsonb` going in and coming
 *    back through its published schema.
 *  - **The dial changes what the pipeline does.** A project the harness inserted has no materialised
 *    preset — the state migration 0021 exists to remove — and its plan-approval gate behaves as it
 *    did before WP-30: an M plan walks straight through. Selecting *Supervised* over HTTP turns
 *    product/19 §11's probation on, and the same ticket parks at a human. That contrast is the whole
 *    criterion, and it is worth the minute it costs: fifteen policies were stored and none was read.
 *  - **A budget created over HTTP stops a run.** `insert into budgets` existed in exactly two files
 *    before this work package and both were tests, so an assertion against a seeded row would
 *    certify the harness rather than the product (standing rule 82). The cap here is written through
 *    `PUT /api/projects/:id/budgets` with a session cookie, the spend that exhausts it is a real
 *    run's, and the pause is `cost/guard.ts` refusing the next admission.
 */
import type { AutonomyResponse, BudgetsResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
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

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const write = async (
  client: Client,
  path: string,
  body: unknown,
  key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  client.json(path, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  }) as Promise<{ status: number; body: Record<string, unknown> }>;

describe('the autonomy dial over HTTP', () => {
  it('materialises a position, reads back the stored copy, and re-applies it', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'settings-dial',
      tickets: TICKETS,
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);
    const path = `/api/projects/${pipeline.projectId}/autonomy`;

    // The harness inserts the project row directly, so it is the one shape migration 0021 exists
    // to remove: a level with no materialised policies. The read says so rather than answering the
    // release's preset as though it had been chosen (standing rule 16).
    const before = await client.json<AutonomyResponse>(path);
    expect(before.status).toBe(200);
    expect(before.body.materialised).toBe(false);

    const applied = await write(client, path, { autonomy: 'autonomous' }, 'dial-1');
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toEqual({ level: 'autonomous', preset_version: 1, performed: true });

    const after = await client.json<AutonomyResponse>(path);
    expect(after.body.materialised).toBe(true);
    expect(after.body.level).toBe('autonomous');
    expect(after.body.applied_by).not.toBeNull();
    expect(after.body.policies.plan_approval).toBe('never');
    expect(after.body.preset_outdated).toBe(false);

    // One audit row, and it says what changed (product/18:5).
    const audited = await pipeline.query<{ action: string; params: Record<string, unknown> }>(
      "select action, params from human_actions where action = 'project.autonomy.write'",
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.params).toMatchObject({
      before_level: 'supervised',
      after_level: 'autonomous',
    });

    // A replay under the same key performs nothing and writes no second row.
    const replay = await write(client, path, { autonomy: 'autonomous' }, 'dial-1');
    expect(replay.status).toBe(200);
    expect(replay.body.performed).toBe(false);
    expect(
      await pipeline.query("select 1 from human_actions where action = 'project.autonomy.write'"),
    ).toHaveLength(1);

    /**
     * **BD-027:14 through the column.** The stored document is moved to a value this release's
     * table would not produce — which is the only observable difference an edited preset makes —
     * and the read answers the **stored** policies and marks the copy out of date. A reader that
     * re-derived from `autonomy_level` would answer `0` here.
     */
    await pipeline.query(
      `update projects
       set autonomy_policies = jsonb_set(autonomy_policies, '{policies,human_mr_rounds}', '9')
       where id = $1`,
      [pipeline.projectId],
    );
    const stale = await client.json<AutonomyResponse>(path);
    expect(stale.body.policies.human_mr_rounds).toBe(9);
    expect(stale.body.preset_outdated).toBe(true);
    // …and *Custom* is still false, because nobody overrode anything — only the release moved.
    expect(stale.body.is_custom).toBe(false);

    // "Re-apply preset" is the same command with the position already in force, and it is what
    // takes the new values (BD-027's own wording).
    const reapplied = await write(client, path, { autonomy: 'autonomous' }, 'dial-2');
    expect(reapplied.status).toBe(200);
    const fresh = await client.json<AutonomyResponse>(path);
    expect(fresh.body.policies.human_mr_rounds).toBe(5);
    expect(fresh.body.preset_outdated).toBe(false);
  });

  it('turns probation on for a project that selects Supervised, and off for one that does not', async () => {
    /**
     * The contrast that makes criterion 3 a measurement rather than a claim.
     *
     * `featureScenarios` produces an **M** plan, which `above_size` at `L` lets through — so the
     * only policy that can stop it is probation, which is exactly one of the fifteen that had no
     * reader. The unmaterialised half runs first, in its own instance, because it is the state the
     * pre-WP-30 gate is defined by.
     */
    const walked = await startPipeline({
      scenarios: featureScenarios,
      label: 'settings-no-dial',
      tickets: TICKETS,
    });
    harness = walked;
    await walked.publish([ticketMatched(walked, 'ACME-1')]);
    const finished = await walked.settle(
      'the task to reach ready_for_merge with no dial materialised',
      (task) => task.state === 'ready_for_merge',
    );
    expect(finished.state).toBe('ready_for_merge');
    expect(await walked.query("select 1 from approvals where kind = 'plan'")).toEqual([]);
    await walked.stop();
    harness = undefined;

    const gated = await startPipeline({
      scenarios: featureScenarios,
      label: 'settings-dial-gates',
      tickets: TICKETS,
    });
    harness = gated;
    const client = await signIn(gated.instance.baseUrl);
    const applied = await write(
      client,
      `/api/projects/${gated.projectId}/autonomy`,
      { autonomy: 'supervised' },
      'dial-gate',
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);

    await gated.publish([ticketMatched(gated, 'ACME-1')]);
    const parked = await gated.settle(
      'the task to wait for a plan approval it only needs because of the dial',
      (task) => task.state === 'waiting_approval',
    );
    expect(parked.state).toBe('waiting_approval');
    // The same M plan, the same template, the same scenarios — and an `approvals` row this time.
    const approvals = await gated.query<{ kind: string }>('select kind from approvals');
    expect(approvals.map((row) => row.kind)).toEqual(['plan']);
  }, 300_000);
});

describe('a budget created over HTTP', () => {
  it('stops the next run and pauses the task, through the admission guard', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'settings-budget',
      tickets: TICKETS,
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);
    const path = `/api/projects/${pipeline.projectId}/budgets`;

    // The cap: written through the route, with a session cookie, by a person. No seeded row.
    const set = await write(client, path, { window: 'month', limit_usd: 0.01 }, 'budget-1');
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toEqual({ outcome: 'created', performed: true });

    // …and it is a row the read surface serves, which is how an operator sees it.
    const listed = await client.json<BudgetsResponse>(path);
    expect(listed.status).toBe(200);
    expect(listed.body.items.map((item: { limit_usd: number }) => item.limit_usd)).toEqual([0.01]);
    expect(listed.body.items[0]?.spent_usd).toBe(0);

    // One audit row, naming what was set.
    const audited = await pipeline.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'budget.write'",
    );
    expect(audited).toHaveLength(1);
    expect(audited[0]?.params).toMatchObject({
      window: 'month',
      limit_usd: 0.01,
      scope: 'project',
    });

    // The first ticket runs and its spend charges the cap the route created. Waited on the **row
    // the assertion reads** (standing rule 87): the ledger writes `budget_windows` after the run's
    // own transaction, so a wait on the task's state would be a wait on something earlier.
    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    await pipeline.waitFor('the budget window to exceed the cap a person set', async () => {
      const rows = await pipeline.query<{ spent: string }>(
        'select spent_usd::text as spent from budget_windows',
      );
      return rows.some((row) => Number(row.spent) > 0.01);
    });

    // The second ticket: `cost/guard.ts` refuses its admission, the executor pauses the task, and
    // **no run is created** — BD-010's "prevents new runs".
    await pipeline.publish([ticketMatched(pipeline, 'ACME-2')]);
    await pipeline.waitFor('the second task to be paused by the budget', async () => {
      const rows = await pipeline.query<{ state: string }>(
        "select state from tasks where ticket_key = 'ACME-2'",
      );
      return rows[0]?.state === 'paused';
    });
    const second = await pipeline.query<{ id: string; cost_actual: string; state: string }>(
      "select id, cost_actual::text as cost_actual, state from tasks where ticket_key = 'ACME-2'",
    );
    expect(second[0]?.state).toBe('paused');
    expect(Number(second[0]?.cost_actual)).toBe(0);
    expect(await pipeline.query('select 1 from runs where task_id = $1', [second[0]?.id])).toEqual(
      [],
    );
    // The pause says *why*, which is what a person needs in order to raise the cap.
    const paused = await pipeline.query<{ payload: { reason?: string } }>(
      `select payload from events
        where type = 'task.paused' and stream_id = $1`,
      [second[0]?.id],
    );
    expect(paused.map((row) => row.payload.reason)).toContain('budget');

    // Raising the cap is the same route, and it is an **update** rather than a second row.
    const raised = await write(client, path, { window: 'month', limit_usd: 500 }, 'budget-2');
    expect(raised.body).toEqual({ outcome: 'updated', performed: true });
    expect(await pipeline.query('select 1 from budgets')).toHaveLength(1);
    // …and removing it leaves none, which is what `limit_usd: null` is for.
    const removed = await write(client, path, { window: 'month', limit_usd: null }, 'budget-3');
    expect(removed.body).toEqual({ outcome: 'removed', performed: true });
    expect(await pipeline.query('select 1 from budgets')).toEqual([]);
  }, 300_000);
});
