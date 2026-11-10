/**
 * **A budget pause in numbers, a raise that must suffice, a resume that continues — and the merge
 * request left alone until the run is admitted** (S-28.1, BD-010's 2026-11-10 amendment, M28
 * rulings 1–6), on a real `apps/server` instance over PostgreSQL with the fake runner.
 *
 * ## AUT-6655, replayed with its own figures
 *
 * Autix reserves **40 USD** per implementation run under the default **50 USD** task cap, and the
 * task had spent **10.99** when it reached implementation: `10.99 + 0 + 40 = 50.99 > 50`, so it
 * paused. Here refinement charges 1.99 and architecture 9.00 (its run budget raised to 10 so the fake
 * runner may spend it), so the same sum is reached through the ledger's own rows — `numeric` in the
 * database, a float on the way back — not seeded. The case then asserts what the amendment decides:
 * the pause's figures on the task read; a raise below 50.99 refused naming 50.99, with nothing
 * recorded; a raise to exactly 50.99 accepted; the resume admitting the run **on the same attempt**
 * (one `task_stages` row for implementation, not a second empty one).
 *
 * At these figures any of the owner's 51–54 would now be accepted and admitted on the first try —
 * the minimum is 50.99, which the page and the refusal both name. (What made each of AUT-6655's
 * raises pause again is not reproduced by the reported figures alone; the refusal is what makes such
 * a loop impossible from now on, whatever the hold.)
 *
 * ## The merge request on a return (ruling 6)
 *
 * The task then reaches Ready (the merge request marked ready) and a person returns it to
 * implementation, where `spent + 40` no longer fits: it pauses at admission. The merge request must
 * still be ready — `mr_draft` waits for the run's claim, which never happened. Raising and resuming
 * admits the run, and only then is the merge request put back to draft.
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
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

interface CommandReply {
  readonly status: number;
  readonly body: Record<string, unknown> & {
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly details?: readonly { readonly path: string; readonly message: string }[];
    };
  };
}

const send = async (
  client: Client,
  path: string,
  body: unknown,
  key: string,
): Promise<CommandReply> =>
  client.json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  }) as Promise<CommandReply>;

/** What each stage charges, each under its own run budget. */
const STAGE_USD: Readonly<Record<string, number>> = {
  refinement: 1.99,
  architecture: 9,
  implementation: 0.01,
  code_review: 0.4,
  business_review: 0.4,
};

const implementationRows = async (pipeline: PipelineE2E, taskId: string) =>
  pipeline.query<{ attempt: number; state: string }>(
    `select attempt, state from task_stages where task_id = $1 and stage = 'implementation'
      order by attempt`,
    [taskId],
  );

const implementationRuns = async (pipeline: PipelineE2E, taskId: string) =>
  pipeline.query<{ attempt: number }>(
    `select ts.attempt from runs r join task_stages ts on ts.id = r.task_stage_id
      where r.task_id = $1 and ts.stage = 'implementation' order by r.created_at`,
    [taskId],
  );

const draftWrites = async (pipeline: PipelineE2E): Promise<number> =>
  (await pipeline.auditRows()).filter((row) => row.action === 'mark_merge_request_draft').length;

describe('a budget pause, end to end (S-28.1)', () => {
  it('replays AUT-6655: names 50.99, refuses less, admits 50.99 on the same attempt, and drafts the MR only once a returned run is admitted', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      scenarioFor: (spec, world) => {
        const scenario =
          featureScenarios(world)[spec.stage as keyof ReturnType<typeof featureScenarios>];
        if (scenario === undefined) return undefined;
        return { ...scenario, costUsd: STAGE_USD[spec.stage ?? ''] ?? 0.4 };
      },
      label: 'budget-pause',
      tickets: TICKETS,
      config: {
        version: 1,
        stages: { architecture: { budget_usd: 10 }, implementation: { budget_usd: 40 } },
      },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    // ── 1. AUT-6655's pause: 10.99 spent, a 40 reserve, a 50 cap ─────────────────────────────
    await pipeline.publish([ticketMatched(pipeline)]);
    const paused = await pipeline.settle(
      'the implementation pause',
      (task) => task.state === 'paused',
    );
    expect(paused.current_stage).toBe('implementation');
    expect(Number(paused.cost_actual)).toBeCloseTo(10.99, 6);
    const taskId = paused.id;

    const read = await client.json<TaskDetailResponse>(`/api/tasks/${taskId}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.task.paused_reason).toBe('budget');
    expect(read.body.task.paused_budget_scope).toBe('task');
    expect(read.body.task.paused_budget_figures).toEqual({
      stage: 'implementation',
      spent_usd: 10.99,
      held_usd: 0,
      held_runs: 0,
      reserve_usd: 40,
      cap_usd: 50,
      required_cap_usd: 50.99,
    });

    // ── 2. Raises below the minimum are refused, naming it, and record nothing ─────────────────
    for (const [index, cap] of [50.5, 50.98].entries()) {
      const refused = await send(
        client,
        `/api/tasks/${taskId}/budget`,
        { cap_usd: cap },
        `raise-low-${index}`,
      );
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error?.code).toBe('budget_raise_insufficient');
      expect(
        refused.body.error?.details?.find((detail) => detail.path === 'required_cap_usd')?.message,
      ).toBe('50.99');
    }
    expect(
      await pipeline.query(
        `select 1 from human_actions where task_id = $1 and action = 'task.budget.raise'`,
        [taskId],
      ),
    ).toHaveLength(0);
    expect(
      (
        await pipeline.query<{ cap: string | null }>(
          'select budget_cap_usd::text as cap from tasks where id = $1',
          [taskId],
        )
      )[0]?.cap,
    ).toBeNull();

    // ── 3. Exactly the minimum, then the resume: the same attempt, and the run admitted ────────
    const raised = await send(
      client,
      `/api/tasks/${taskId}/budget`,
      { cap_usd: 50.99 },
      'raise-ok',
    );
    expect(raised.status, JSON.stringify(raised.body)).toBe(200);
    const resumed = await send(client, `/api/tasks/${taskId}/resume`, {}, 'resume-1');
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    const atReady = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(atReady.stage_attempts.implementation).toBe(1);
    expect(await implementationRows(pipeline, taskId)).toEqual([
      expect.objectContaining({ attempt: 1 }),
    ]);
    expect((await implementationRuns(pipeline, taskId)).map((row) => row.attempt)).toEqual([1]);

    // The merge request is marked ready at Ready; nothing has drafted it since.
    await pipeline.waitFor('the merge request marked ready', async () =>
      (await pipeline.auditRows()).some((row) => row.action === 'mark_merge_request_ready'),
    );
    await pipeline.waitFor('the workpad to show Ready', async () =>
      (pipeline.tickets.peek('ACME-1')?.comments[0]?.body ?? '').includes('— ready_for_merge'),
    );
    const draftsBefore = await draftWrites(pipeline);

    // ── 4. A return that pauses at admission leaves the merge request as it was (ruling 6) ─────
    const returned = await send(
      client,
      `/api/tasks/${taskId}/return-to-stage`,
      { stage: 'implementation', reason: 'the footer still rounds twice' },
      'return-1',
    );
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    const pausedAgain = await pipeline.settle(
      'the returned implementation paused',
      (task) => task.state === 'paused' && task.current_stage === 'implementation',
    );
    expect(pausedAgain.stage_attempts.implementation).toBe(2);
    // The outbound queue runs in enqueue order: the workpad's render of the pause comes after any
    // duty the return's entry enqueued, so once it shows the pause, a draft write would be there.
    await pipeline.waitFor('the workpad to show the pause', async () =>
      (pipeline.tickets.peek('ACME-1')?.comments[0]?.body ?? '').includes(
        '— paused (implementation)',
      ),
    );
    // …and every outbound duty enqueued so far has run, so an absent draft write is an answer.
    await pipeline.waitFor('the outbound queue to drain', async () => {
      const rows = await pipeline.query<{ count: string }>(
        `select count(*)::text as count from pgboss.job
          where name = 'pipeline.outbound' and state in ('created', 'retry', 'active')`,
      );
      return rows[0]?.count === '0';
    });
    expect(await draftWrites(pipeline)).toBe(draftsBefore);

    // ── 5. Raised and resumed: the run is admitted on attempt 2, and only now the MR is drafted ─
    const figures = (await client.json<TaskDetailResponse>(`/api/tasks/${taskId}`)).body.task
      .paused_budget_figures;
    expect(figures?.reserve_usd).toBe(40);
    const minimum = Math.ceil(figures?.required_cap_usd ?? 0);
    expect(
      (await send(client, `/api/tasks/${taskId}/budget`, { cap_usd: minimum }, 'raise-2')).status,
    ).toBe(200);
    expect((await send(client, `/api/tasks/${taskId}/resume`, {}, 'resume-2')).status).toBe(200);
    await pipeline.waitFor(
      'the merge request put back to draft',
      async () => (await draftWrites(pipeline)) > draftsBefore,
    );
    expect((await pipeline.task()).stage_attempts.implementation).toBe(2);
    expect((await implementationRuns(pipeline, taskId)).map((row) => row.attempt)).toEqual([1, 2]);
  });
});
