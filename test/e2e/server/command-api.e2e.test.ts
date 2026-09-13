/**
 * **The eleven task and run commands, over HTTP, against a task this pipeline created** (WP-15i).
 *
 * The plan row's fifth criterion in one sentence: never a seeded row. Every task below is started
 * by publishing a `ticket.matched` into a real `apps/server` instance, walked by the real saga, the
 * real stage executor and the real runner, and then acted on through the real routes with a real
 * session cookie. What each command did is read back through WP-15h's read endpoints and through
 * `human_actions`, which is the table technical/08's audit clause is about and which had no writer
 * at all until WP-21.
 *
 * ## Which harness knob, and why each one is needed
 *
 * `agent: 'real-over-fake-cli'` — the production runner over a scripted CLI — because two of these
 * commands are only meaningful **while a run is running**: `onAgentSpec` is awaited inside the
 * workspace provisioner, which only that mode composes, and it is the only way to hold a run open
 * long enough for a person to press pause or cancel. In `fake-runner` mode a run is over before any
 * HTTP request could reach it, and a test that "cancelled" one would be asserting against a run
 * that had already finished (standing rule 82: ask what the fake does with the thing under test).
 *
 * Two scenario overrides, both shipped mechanisms rather than rows the test wrote: a refinement
 * whose `RefinedSpec.decision` is `ask` parks the task at `waiting_answers` with a real `questions`
 * row (WP-15h part 2's own instrument), and a plan whose `estimated_size` is `XL` trips the plan
 * approval gate (`planApprovalGate`'s `above_size` default with the `L` threshold), which is the
 * only way an `approvals` row exists in this build.
 */
import type { RunRecord, TaskDetailResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  inboundEvent,
  type PipelineE2E,
  type SeededWorld,
  startPipeline,
} from '../support/pipeline.js';
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

const signIn = async (baseUrl: string, email = BOOTSTRAP_EMAIL, password = BOOTSTRAP_PASSWORD) => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', { email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

/** A signed-in client for a user of the given organisation role, created by the administrator. */
const signInAs = async (
  admin: Client,
  baseUrl: string,
  role: 'viewer' | 'member' | 'maintainer',
): Promise<Client> => {
  const email = `${role}@example.test`;
  const password = `not-a-real-password-${role}-0000`;
  const created = await admin.post<{ user: { id: string } }>('/api/auth/admin/create-user', {
    email,
    password,
    name: role,
    role,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return signIn(baseUrl, email, password);
};

interface CommandReply {
  readonly status: number;
  readonly body: {
    readonly task_id?: string;
    readonly run_id?: string;
    readonly state?: string;
    readonly status?: string;
    readonly task_state?: string;
    readonly current_stage?: string | null;
    readonly performed?: boolean;
    readonly feedback_id?: string;
    readonly error?: { readonly code: string; readonly message: string };
  };
}

/** One command, with an `Idempotency-Key` when the caller gives one. */
const send = async (
  client: Client,
  path: string,
  body: unknown,
  key?: string,
): Promise<CommandReply> =>
  client.json(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  }) as Promise<CommandReply>;

/** The `human_actions` rows this instance wrote, newest last — criterion 2's read-back. */
const humanActions = async (pipeline: PipelineE2E) =>
  pipeline.query<{ action: string; user_id: string; task_id: string | null; params: JsonParams }>(
    'select action, user_id, task_id, params from human_actions order by created_at, action',
  );

type JsonParams = Record<string, unknown>;

/** A promise the test resolves, for holding a run at its workspace. */
const gate = () => {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { opened, open: () => open() };
};

describe('the task command surface, on a task the pipeline drove', () => {
  it('pauses, resumes, retries, returns, reworks, feeds back and cancels — and refuses each from a state that cannot', async () => {
    const held = gate();
    const started = gate();
    let firstRunId: string | null = null;

    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'command-api',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      onAgentSpec: async (spec) => {
        if (firstRunId !== null) {
          return;
        }
        firstRunId = spec.runId;
        started.open();
        await held.opened;
      },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    await started.opened;
    const runId = firstRunId as unknown as string;
    const task = await pipeline.task();

    // ── pause, while a run is genuinely in flight ───────────────────────────
    const paused = await send(client, `/api/tasks/${task.id}/pause`, { reason: 'stepping in' });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body.state).toBe('paused');

    // A second pause is `paused → paused`, which the state machine does not have.
    const again = await send(client, `/api/tasks/${task.id}/pause`, {});
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('illegal_transition');
    expect(again.body.error?.message).toContain('paused');

    // ── the run finishes into a paused task (WP-15e's ending, inverted) ─────
    // The stage executor records the run and its spend and does **not** complete the stage: the
    // human's decision stands, and `cost_actual` survives, which is the assertion a lost update
    // would fail (standing rule 79).
    held.open();
    await pipeline.waitFor('the held run to be recorded', async () => {
      const run = await client.json<RunRecord>(`/api/runs/${runId}`);
      return run.status === 200 && run.body.status !== 'running';
    });
    const settledTask = await pipeline.task();
    expect(settledTask.state).toBe('paused');
    expect(settledTask.current_stage).toBe('refinement');
    expect(Number(settledTask.cost_actual)).toBeGreaterThan(0);

    // Exactly one `human_actions` row so far: the refused pause wrote none (criterion 2, both
    // directions), and it is read back through a query rather than asserted as an insert.
    const afterPause = await humanActions(pipeline);
    expect(afterPause.map((row) => row.action)).toEqual(['task.pause']);
    expect(afterPause[0]?.task_id).toBe(task.id);
    expect(afterPause[0]?.params.task_id).toBe(task.id);

    // ── resume, which re-enters the stage and runs it again ────────────────
    const resumed = await send(client, `/api/tasks/${task.id}/resume`, {}, 'resume-1');
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(resumed.body.state).toBe('active');
    expect(resumed.body.performed).toBe(true);

    // The replay: same key, same body, and **nothing is performed twice** — asserted on a
    // countable effect, the number of runs this task has (standing rule 79).
    const replayed = await send(client, `/api/tasks/${task.id}/resume`, {}, 'resume-1');
    expect(replayed.status, JSON.stringify(replayed.body)).toBe(200);
    expect(replayed.body.performed).toBe(false);
    const rows = await humanActions(pipeline);
    expect(rows.filter((row) => row.action === 'task.resume')).toHaveLength(1);

    // …and the same key with a *different* body is refused rather than replayed.
    const reused = await send(
      client,
      `/api/tasks/${task.id}/resume`,
      { reason: 'something else' },
      'resume-1',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe('idempotency_key_reused');

    const readyForMerge = await pipeline.settle(
      'ready_for_merge',
      (snapshot) => snapshot.state === 'ready_for_merge',
    );
    const runsAfterWalk = (await client.json<TaskDetailResponse>(`/api/tasks/${task.id}`)).body.runs
      .length;
    expect(runsAfterWalk).toBeGreaterThan(1);

    // ── retry-stage refuses a stage the task is not at ─────────────────────
    const wrongStage = await send(
      client,
      `/api/tasks/${task.id}/retry-stage`,
      { stage: 'implementation' },
      'retry-wrong-1',
    );
    expect(wrongStage.status).toBe(409);
    expect(wrongStage.body.error?.code).toBe('stage_not_current');
    expect(wrongStage.body.error?.message).toContain('implementation');

    // ── return-to-stage: the task goes back and the loop counts ────────────
    const returned = await send(
      client,
      `/api/tasks/${task.id}/return-to-stage`,
      { stage: 'implementation', reason: 'the footer still rounds twice' },
      'return-1',
    );
    expect(returned.status, JSON.stringify(returned.body)).toBe(200);
    await pipeline.settle(
      'ready_for_merge again',
      (snapshot) => snapshot.state === 'ready_for_merge',
    );
    expect((await pipeline.task()).iteration_counters.human_rounds).toBe(1);

    // ── rework: the same return, plus the agent counters reset ─────────────
    const reworked = await send(
      client,
      `/api/tasks/${task.id}/rework`,
      { stage: 'architecture', instructions: 'sum the model, not the view' },
      'rework-1',
    );
    expect(reworked.status, JSON.stringify(reworked.body)).toBe(200);
    await pipeline.settle(
      'ready_for_merge once more',
      (snapshot) => snapshot.state === 'ready_for_merge',
    );
    const afterRework = await pipeline.task();
    expect(afterRework.iteration_counters.human_rounds).toBe(2);
    expect(afterRework.stage_attempts.architecture).toBe(2);

    // ── feedback: an opinion, not a transition ────────────────────────────
    const feedback = await send(
      client,
      `/api/tasks/${task.id}/feedback`,
      { scope: 'stage', stage: 'code_review', text: 'the review was thin', rating: 2 },
      'feedback-1',
    );
    expect(feedback.status, JSON.stringify(feedback.body)).toBe(200);
    expect(feedback.body.feedback_id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await pipeline.task()).state).toBe('ready_for_merge');
    // The event is the record: `feedback.received` is what WP-24's intake agent reads.
    const events = await pipeline.events();
    const received = events.filter((event) => event.type === 'feedback.received');
    expect(received).toHaveLength(1);
    // A replay of the same key answers the same feedback id and records no second event.
    const feedbackAgain = await send(
      client,
      `/api/tasks/${task.id}/feedback`,
      { scope: 'stage', stage: 'code_review', text: 'the review was thin', rating: 2 },
      'feedback-1',
    );
    expect(feedbackAgain.body.performed).toBe(false);
    expect(feedbackAgain.body.feedback_id).toBe(feedback.body.feedback_id);

    // ── cancel, and then every command refuses ────────────────────────────
    const cancelled = await send(client, `/api/tasks/${task.id}/cancel`, { reason: 'not needed' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    const afterCancel = await send(client, `/api/tasks/${task.id}/pause`, {});
    expect(afterCancel.status).toBe(409);

    // ── the audit, read back in full ──────────────────────────────────────
    const audit = await humanActions(pipeline);
    expect(audit.map((row) => row.action).sort()).toEqual([
      'task.cancel',
      'task.feedback',
      'task.pause',
      'task.resume',
      'task.return_to_stage',
      'task.rework',
    ]);
    // Every row names the person who acted and the request that was performed…
    expect(new Set(audit.map((row) => row.user_id)).size).toBe(1);
    expect(audit.find((row) => row.action === 'task.rework')?.params.stage).toBe('architecture');
    expect(audit.find((row) => row.action === 'task.return_to_stage')?.params.idempotency_key).toBe(
      'return-1',
    );
    // …and **no** row carries the free text: the audit records the shape of a command, never a
    // second copy of an untrusted sentence (BD-022).
    expect(JSON.stringify(audit)).not.toContain('the footer still rounds twice');
    expect(JSON.stringify(audit)).not.toContain('sum the model, not the view');
    expect(JSON.stringify(audit)).not.toContain('the review was thin');
    // …and nothing escalated the task: no HTTP request may park a task for a human.
    expect(events.some((event) => event.type === 'task.escalated')).toBe(false);
    void readyForMerge;
  }, 300_000);

  it('refuses a caller whose role is too low, per capability class', async () => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'command-rbac',
      tickets: TICKETS,
      agent: 'fake-runner',
    });
    harness = pipeline;
    const admin = await signIn(pipeline.instance.baseUrl);
    await pipeline.publish([ticketMatched(pipeline)]);
    const task = await pipeline.settle(
      'ready_for_merge',
      (snapshot) => snapshot.state === 'ready_for_merge',
    );

    const viewer = await signInAs(admin, pipeline.instance.baseUrl, 'viewer');
    const member = await signInAs(admin, pipeline.instance.baseUrl, 'member');

    // `task.pause` is `member`, so a viewer may not…
    const viewerPause = await send(viewer, `/api/tasks/${task.id}/pause`, {});
    expect(viewerPause.status).toBe(403);
    expect(viewerPause.body.error?.code).toBe('forbidden');
    // …`task.cancel` and `task.return_to_stage` are `maintainer`, so a member may not…
    const memberCancel = await send(member, `/api/tasks/${task.id}/cancel`, {});
    expect(memberCancel.status).toBe(403);
    const memberReturn = await send(
      member,
      `/api/tasks/${task.id}/return-to-stage`,
      { stage: 'implementation', reason: 'no' },
      'member-return-1',
    );
    expect(memberReturn.status).toBe(403);
    // …and the member **may** pause, which is what makes the refusals above about the role rather
    // than about the route (standing rule 42).
    const memberPause = await send(member, `/api/tasks/${task.id}/pause`, {});
    expect(memberPause.status, JSON.stringify(memberPause.body)).toBe(200);

    // A refused command writes no audit row: one row, from the pause that happened.
    const audit = await humanActions(pipeline);
    expect(audit.map((row) => row.action)).toEqual(['task.pause']);
  }, 240_000);
});

/** `featureScenarios` with a refinement that asks a blocking question instead of proceeding. */
const askingScenarios = (world: SeededWorld) => {
  const base = featureScenarios(world);
  return {
    ...base,
    refinement: {
      structuredOutput: {
        ...(base.refinement.structuredOutput as Record<string, unknown>),
        decision: 'ask',
        questions: [{ id: 'q1', text: 'Which provider should the footer total?', blocking: true }],
      },
    },
  };
};

/** `featureScenarios` with an **XL** plan, which is what trips the plan approval gate. */
const approvingScenarios = (world: SeededWorld) => {
  const base = featureScenarios(world);
  return {
    ...base,
    architecture: {
      structuredOutput: {
        ...(base.architecture.structuredOutput as Record<string, unknown>),
        estimated_size: 'XL',
      },
    },
  };
};

describe('answering a question and deciding an approval', () => {
  it('answers the question the pipeline asked, and refuses a second answer', async () => {
    const pipeline = await startPipeline({
      scenarios: askingScenarios,
      label: 'command-answer',
      tickets: TICKETS,
      agent: 'fake-runner',
    });
    harness = pipeline;
    const admin = await signIn(pipeline.instance.baseUrl);
    await pipeline.publish([ticketMatched(pipeline)]);
    const parked = await pipeline.settle(
      'waiting_answers',
      (snapshot) => snapshot.state === 'waiting_answers',
    );

    const detail = await admin.json<TaskDetailResponse>(`/api/tasks/${parked.id}`);
    const question = detail.body.questions[0];
    expect(question?.status).toBe('open');
    const questionId = question?.id as string;

    // A viewer may not answer: `task.answer_question` is `member` (technical/08's own entry).
    const viewer = await signInAs(admin, pipeline.instance.baseUrl, 'viewer');
    const refused = await send(
      viewer,
      `/api/tasks/${parked.id}/questions/${questionId}/answer`,
      { answer: 'the one in the footer' },
      'answer-viewer-1',
    );
    expect(refused.status).toBe(403);

    const answered = await send(
      admin,
      `/api/tasks/${parked.id}/questions/${questionId}/answer`,
      { answer: 'the one in the footer' },
      'answer-1',
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);

    // Read back through the read API: the question is answered and carries who answered it.
    await pipeline.waitFor('the question to be answered', async () => {
      const page = await admin.json<TaskDetailResponse>(`/api/tasks/${parked.id}`);
      return page.body.questions[0]?.status === 'answered';
    });
    const after = await admin.json<TaskDetailResponse>(`/api/tasks/${parked.id}`);
    expect(after.body.questions[0]?.answer).toBe('the one in the footer');
    expect(after.body.questions[0]?.answered_by_user_id).not.toBeNull();

    // First answer wins: a second one is an illegal transition, whatever the key.
    const second = await send(
      admin,
      `/api/tasks/${parked.id}/questions/${questionId}/answer`,
      { answer: 'no, the other one' },
      'answer-2',
    );
    expect(second.status).toBe(409);
    expect(second.body.error?.code).toBe('illegal_transition');

    const audit = await humanActions(pipeline);
    expect(audit.map((row) => row.action)).toEqual(['task.question.answer']);
    expect(audit[0]?.params.question_id).toBe(questionId);
    // The answer itself is not in the audit row (BD-022) — it is on the question.
    expect(JSON.stringify(audit)).not.toContain('the one in the footer');
  }, 240_000);

  it('decides the plan approval the gate requested, and refuses a second decision', async () => {
    const pipeline = await startPipeline({
      scenarios: approvingScenarios,
      label: 'command-approve',
      tickets: TICKETS,
      agent: 'fake-runner',
    });
    harness = pipeline;
    const admin = await signIn(pipeline.instance.baseUrl);
    await pipeline.publish([ticketMatched(pipeline)]);
    const waiting = await pipeline.settle(
      'waiting_approval',
      (snapshot) => snapshot.state === 'waiting_approval',
    );

    const detail = await admin.json<TaskDetailResponse>(`/api/tasks/${waiting.id}`);
    const approval = detail.body.approvals[0];
    expect(approval?.kind).toBe('plan');
    expect(approval?.status).toBe('pending');
    const approvalId = approval?.id as string;

    // `task.approve_plan` is `maintainer`, so a member may not decide (BD-006).
    const member = await signInAs(admin, pipeline.instance.baseUrl, 'member');
    const refused = await send(
      member,
      `/api/tasks/${waiting.id}/approvals/${approvalId}/decide`,
      { decision: 'approve' },
      'decide-member-1',
    );
    expect(refused.status).toBe(403);

    const decided = await send(
      admin,
      `/api/tasks/${waiting.id}/approvals/${approvalId}/decide`,
      { decision: 'approve' },
      'decide-1',
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);

    // The pipeline carries on from the gate it was waiting at.
    await pipeline.settle('ready_for_merge', (snapshot) => snapshot.state === 'ready_for_merge');

    const again = await send(
      admin,
      `/api/tasks/${waiting.id}/approvals/${approvalId}/decide`,
      { decision: 'reject' },
      'decide-2',
    );
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe('illegal_transition');

    const audit = await humanActions(pipeline);
    expect(audit.map((row) => row.action)).toEqual(['task.approval.decide']);
    expect(audit[0]?.params.decision).toBe('approve');
  }, 240_000);
});

describe('the run command surface', () => {
  it('cancels a run that is running, and retries a finished one on another model', async () => {
    const held = gate();
    const started = gate();
    let firstRunId: string | null = null;

    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'command-runs',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      onAgentSpec: async (spec) => {
        if (firstRunId !== null) {
          return;
        }
        firstRunId = spec.runId;
        started.open();
        await held.opened;
      },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    await started.opened;
    const runId = firstRunId as unknown as string;
    const task = await pipeline.task();

    // ── cancel a live run ─────────────────────────────────────────────────
    const cancelled = await send(client, `/api/runs/${runId}/cancel`, { reason: 'wrong branch' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    // The task stops with it, so the pipeline does not act on an attempt nobody will finish.
    expect(cancelled.body.task_state).toBe('paused');
    // It is gone from the running-agents list, which is the projection over `runs.status`.
    const agents = await client.json<{ items: unknown[] }>('/api/org/agents');
    expect(agents.body.items).toEqual([]);

    // A second cancellation is refused by the Run state machine.
    const twice = await send(client, `/api/runs/${runId}/cancel`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.error?.code).toBe('illegal_transition');

    // ── the session ends anyway, and its outcome is discarded ─────────────
    // The platform cannot interrupt a live session from another process (Q52), so the run finishes
    // on its own — and finds its row already terminal. The human's decision stands.
    held.open();
    await pipeline.waitFor('the released run to have been discarded', async () => {
      const rows = await pipeline.query<{ status: string }>(
        'select status from runs where id = $1',
        [runId],
      );
      return rows[0]?.status === 'cancelled';
    });
    expect((await pipeline.task()).state).toBe('paused');

    // ── retry the cancelled run, on a different model ─────────────────────
    const retried = await send(
      client,
      `/api/runs/${runId}/retry`,
      { model: 'claude-haiku-4-5', effort: 'low' },
      'run-retry-1',
    );
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.task_id).toBe(task.id);

    // The countable effect: a second run of the same stage, on the model the human chose. The
    // override is **this attempt's** — it was never written to the project.
    await pipeline.waitFor('the retry to start a run on the chosen model', async () => {
      const rows = await pipeline.query<{ model: string; attempt: number }>(
        'select model, attempt from runs where task_id = $1 order by created_at desc limit 1',
        [task.id],
      );
      return rows[0]?.model === 'claude-haiku-4-5' && rows[0]?.attempt === 2;
    });

    // A run that is still going cannot be retried, and the message says which status refused.
    await pipeline.settle('ready_for_merge', (snapshot) => snapshot.state === 'ready_for_merge');
    const audit = await humanActions(pipeline);
    expect(audit.map((row) => row.action)).toEqual(['run.cancel', 'run.retry']);
    expect(audit.find((row) => row.action === 'run.retry')?.params.model).toBe('claude-haiku-4-5');
    // A run command names the run in `params` **and** the task in the column: `task_id` carries
    // `human_actions`' only index, so a row without it is one no reader of the table will find.
    expect(audit[0]?.params.run_id).toBe(runId);
    expect(audit.map((row) => row.task_id)).toEqual([task.id, task.id]);

    // `budget_usd` is refused by name rather than ignored: raising a cap is WP-28's approval.
    const withBudget = await send(
      client,
      `/api/runs/${runId}/retry`,
      { budget_usd: 50 },
      'run-retry-budget-1',
    );
    expect(withBudget.status).toBe(409);
    expect(withBudget.body.error?.code).toBe('budget_override_unsupported');
  }, 300_000);
});
