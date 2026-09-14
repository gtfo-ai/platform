/**
 * **Steer, take over and hand back, against a run that is really running** (WP-27).
 *
 * The three commands of product/18's *"Steer"* and *"Take over / hand back"* rows, driven through a
 * whole `apps/server` instance over a task the real saga created — never a seeded row.
 *
 * ## Which harness knob, and why each one is load-bearing
 *
 * `agent: 'real-over-fake-cli'` for the reason `command-api.e2e.test.ts` gives and one more. All
 * three commands are only meaningful **while a session is open**: a steer pushes a user turn into
 * the run's input queue, and a take-over interrupts it and tells its workspace what to do on the way
 * out. In `fake-runner` mode a run is over before any HTTP request could reach it, so every one of
 * these would be asserting against a run that had already finished (standing rule 82).
 *
 * `awaitSteers: 1` on the refinement scenario is the other half: the scripted CLI stops after its
 * assistant message and waits for another user turn, which is what keeps the session open for the
 * length of an HTTP request. Without it the run would be gone before the steer arrived and the test
 * would be green on a refusal.
 *
 * ## What this tier proves about the take-over, and what it deliberately does not
 *
 * It proves the platform's half: the task is paused, the run is interrupted, the response carries
 * the branch and the resume command, the workpad on the ticket says the same thing, and the
 * **workspace is asked** for a `wip: hand-over to <user>` commit, a push of `agentic/<ticket>`, a
 * tarball and fourteen days of retention. It proves nothing about the commit, the push or the
 * volume: there is no container and no git host in this tier. Those meet each other in
 * `apps/launcher/src/service.test.ts` (the order and the failure paths) and in
 * `test/e2e/workspace/docker-workspace.e2e.test.ts` (a real daemon, through the shared contract
 * suite).
 */
import type { RunRecord, TaskDetailResponse } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLANTED_MODEL_KEY,
  PLANTED_MODEL_KEY_PLACEHOLDER,
  TRANSCRIPT_CONTROL_TEXT,
} from '../support/agent-workspace.js';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/**
 * An obviously fake credential a person types into a steer box, and the leak it stands for.
 *
 * A steer is the one piece of untrusted text this build sends **into a model's session**, so the
 * redaction has to hold in both directions: gone from the row and from the frame the CLI received,
 * and the rest of the sentence still there (standing rule 42).
 */
const PLANTED_STEER_SECRET = 'glpat-FAKE-wp27-planted-in-a-steer-000';
/** The same shape, in the one field whose only home is the audit row (WP-27's fix round). */
const PLANTED_REASON_SECRET = 'glpat-FAKE-wp27-planted-in-a-reason-00';

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

const signIn = async (baseUrl: string) => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> & { readonly error?: { readonly code: string } };
}

const send = async (client: Client, path: string, body: unknown, key?: string): Promise<Reply> =>
  client.json(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  }) as Promise<Reply>;

const started = async (label: string, holdRefinement: boolean) => {
  const pipeline = await startPipeline({
    scenarios: (world) => ({
      ...featureScenarios(world),
      // The one stage that waits, and only when a case needs a session held open: everything after
      // it runs to completion as usual, so a hand-back still walks the rest of the template.
      refinement: {
        ...featureScenarios(world).refinement,
        ...(holdRefinement ? { awaitSteers: 1 } : {}),
      },
    }),
    label,
    tickets: TICKETS,
    agent: 'real-over-fake-cli',
  });
  harness = pipeline;
  const client = await signIn(pipeline.instance.baseUrl);
  await pipeline.publish([ticketMatched(pipeline)]);
  return { pipeline, client };
};

/** A task whose **refinement** run is open and waiting for one more user turn. */
const runningTask = async (label: string) => {
  const { pipeline, client } = await started(label, true);

  // The run has to be **running** before either command means anything, and the row is what the
  // command reads: waiting on the task's state would be waiting on something written earlier.
  await pipeline.waitFor('the refinement run to be running', async () => {
    const rows = await pipeline.query<{ id: string; status: string }>(
      "select id, status from runs where status = 'running'",
    );
    return rows.length === 1;
  });
  const [run] = await pipeline.query<{ id: string }>(
    "select id from runs where status = 'running'",
  );
  const task = await pipeline.task();
  return { pipeline, client, runId: run?.id as string, taskId: task.id };
};

describe('steering a run that is really running', () => {
  it('puts the human’s turn in front of the model, in the transcript and in the audit', async () => {
    const { pipeline, client, runId, taskId } = await runningTask('steer');

    const reply = await send(
      client,
      `/api/runs/${runId}/steer`,
      { message: `sum the model, not the view (${PLANTED_STEER_SECRET})` },
      'steer-1',
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.run_id).toBe(runId);
    expect(reply.body.task_id).toBe(taskId);
    expect(reply.body.performed).toBe(true);

    // ── the bytes the CLI received (standing rule 82) ──────────────────────
    //
    // The push crosses the SDK's own transport after the request has answered, so this is the one
    // assertion in the file that waits — and it waits on the frame it then reads, not on a nearer
    // consequence (standing rule 87's shape, one layer out from a provider).
    await pipeline.waitFor('the steer to reach the CLI', async () =>
      pipeline.agentRuns.some((run) =>
        run.cli.stdin.some(
          (frame) => frame.type === 'user' && JSON.stringify(frame).includes('sum the model'),
        ),
      ),
    );
    const refinement = pipeline.agentRuns.find((run) => run.stage === 'refinement');
    const userFrames = (refinement?.cli.stdin ?? []).filter((frame) => frame.type === 'user');
    // Two user turns: the prompt the platform assembled, and the steer. The steer is the second.
    expect(userFrames.length).toBeGreaterThanOrEqual(2);
    const steerFrame = JSON.stringify(userFrames.at(-1));
    expect(steerFrame).toContain('sum the model, not the view');
    // …and the credential the operator pasted never reached the model.
    expect(steerFrame).not.toContain(PLANTED_STEER_SECRET);

    // ── the transcript row, redacted both ways ────────────────────────────
    const rows = await pipeline.transcript();
    const steer = rows.filter((row) => row.kind === 'steer');
    expect(steer).toHaveLength(1);
    const payload = JSON.stringify(steer[0]?.payload);
    expect(payload).toContain('sum the model, not the view');
    expect(payload).not.toContain(PLANTED_STEER_SECRET);
    // The **person who pressed the button**, which is the signed-in administrator rather than the
    // seeded project's owner: the transcript row and the audit row must name the same user, and
    // asserting them against each other is what makes that a property rather than a constant.
    const steerActor = (
      await pipeline.query<{ user_id: string }>(
        "select user_id from human_actions where action = 'run.steer'",
      )
    )[0]?.user_id;
    expect(steer[0]?.payload.author_user_id).toBe(steerActor);
    // The whole transcript, both ways: the run's own model credential is redacted by TD-012 step 1
    // and the control text around it survived, which is what tells a redacting sink from an empty
    // one (standing rule 42).
    const whole = JSON.stringify(rows);
    expect(whole).not.toContain(PLANTED_MODEL_KEY);
    expect(whole).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);
    expect(whole).toContain(TRANSCRIPT_CONTROL_TEXT);

    // ── the event, the audit row, and the key ─────────────────────────────
    const events = await pipeline.events();
    expect(events.filter((event) => event.type === 'run.steered')).toHaveLength(1);
    const actions = await pipeline.query<{
      action: string;
      user_id: string;
      task_id: string | null;
      params: Record<string, unknown>;
    }>('select action, user_id, task_id, params from human_actions order by created_at');
    const steered = actions.filter((action) => action.action === 'run.steer');
    expect(steered).toHaveLength(1);
    expect(steered[0]?.task_id).toBe(taskId);
    expect(steered[0]?.params.idempotency_key).toBe('steer-1');
    // The audit records the shape of the request, never a second copy of the operator's sentence.
    expect(JSON.stringify(steered)).not.toContain('sum the model');
    expect(JSON.stringify(steered)).not.toContain(PLANTED_STEER_SECRET);

    // A replay under the same key performs nothing twice: one event, one row, one turn.
    const replay = await send(
      client,
      `/api/runs/${runId}/steer`,
      { message: `sum the model, not the view (${PLANTED_STEER_SECRET})` },
      'steer-1',
    );
    expect(replay.status).toBe(200);
    expect(replay.body.performed).toBe(false);
    expect((await pipeline.events()).filter((event) => event.type === 'run.steered')).toHaveLength(
      1,
    );

    // The run carries on and ends by itself: steering is a turn in a conversation, not a stop.
    await pipeline.waitFor('the steered run to finish', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status from runs where id = $1',
        [runId],
      );
      return row !== undefined && row.status !== 'running';
    });
    const [finished] = await pipeline.query<{
      status: string;
      terminal_reason: string | null;
      exit_detail: unknown;
    }>('select status::text, terminal_reason::text, exit_detail from runs where id = $1', [runId]);
    expect(`${finished?.status} ${finished?.terminal_reason}`).toBe('completed success');
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
  }, 300_000);

  it('refuses a steer on a run that has ended, naming its status', async () => {
    // No held session in this case: the task walks the whole template and every run ends by
    // itself, which is the state the refusal is about. Releasing a *held* run with a first steer
    // would put both requests inside technical/08's five-second window and the second would be
    // refused `429` — a true answer to a different question.
    const { pipeline, client } = await started('steer-refusal', false);
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    const [run] = await pipeline.query<{ id: string }>(
      "select id from runs where status = 'completed' order by created_at limit 1",
    );

    const reply = await send(
      client,
      `/api/runs/${run?.id}/steer`,
      { message: 'too late' },
      'late-1',
    );
    expect(reply.status, JSON.stringify(reply.body)).toBe(409);
    expect(reply.body.error?.code).toBe('run_not_live');
  }, 300_000);
});

describe('taking a task over and handing it back', () => {
  it('pauses the pipeline, interrupts the run, and hands the human the branch and the resume command', async () => {
    const { pipeline, client, runId, taskId } = await runningTask('take-over');

    const reply = await send(client, `/api/tasks/${taskId}/take-over`, {
      tarball: true,
      reason: `finishing this by hand, ${PLANTED_REASON_SECRET} needs rotating`,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.state).toBe('paused');
    expect(reply.body.branch).toBe('agentic/ACME-1');
    expect(reply.body.workspace_export).toBe('requested');
    expect(reply.body.session_id).toBe('fake-session-e2e');
    expect(reply.body.resume_commands).toEqual([
      'git fetch && git checkout agentic/ACME-1',
      'claude --resume fake-session-e2e',
    ]);

    // ── the run really ends, and its workspace is told what the human needs ──
    await pipeline.waitFor('the interrupted run to be recorded', async () => {
      const run = await client.json<RunRecord>(`/api/runs/${runId}`);
      return run.status === 200 && run.body.status !== 'running';
    });
    const run = await client.json<RunRecord>(`/api/runs/${runId}`);
    expect(run.body.status).toBe('cancelled');

    await pipeline.waitFor('the workspace to be released', async () =>
      pipeline.workspaceReleases.some((release) => release.stage === 'refinement'),
    );
    const release = pipeline.workspaceReleases.find((entry) => entry.stage === 'refinement');
    expect(release?.takeOver).toMatchObject({
      branch: 'agentic/ACME-1',
      commitMessage: 'wip: hand-over to Administrator',
      tarball: true,
    });
    // Fourteen days, not three: technical/05 §5's second window, measured against the run's own
    // creation rather than against a constant this test repeats.
    const keptDays =
      (Date.parse(release?.takeOver?.keepUntil ?? '') - Date.now()) / (24 * 60 * 60 * 1000);
    expect(keptDays).toBeGreaterThan(13);
    expect(keptDays).toBeLessThanOrEqual(14);

    // ── the task stays where the human put it ─────────────────────────────
    const settled = await pipeline.task();
    expect(settled.state).toBe('paused');
    expect(settled.current_stage).toBe('refinement');
    const events = await pipeline.events();
    expect(events.filter((event) => event.type === 'task.taken_over')).toHaveLength(1);

    // ── the operator's own words, in the one place that keeps them ────────
    //
    // `task.taken_over` has no field for a sentence, so the `human_actions` row is the whole of the
    // record — which is what the endpoint's description says and what WP-27 shipped without
    // (the request's `reason` reached a strict schema and was dropped). Both directions, against
    // the **production** redactor and the real table: the credential is gone and the sentence
    // around it survived (standing rule 42).
    const takeOverActions = await pipeline.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'task.take_over'",
    );
    expect(takeOverActions).toHaveLength(1);
    const auditedReason = String(takeOverActions[0]?.params.reason ?? '');
    expect(auditedReason).toContain('finishing this by hand');
    expect(auditedReason).not.toContain(PLANTED_REASON_SECRET);
    expect(JSON.stringify(events)).not.toContain('finishing this by hand');

    // ── the task read model carries it too, for whoever opens the page next ──
    //
    // product/18's *"posts the branch and a `claude --resume <session>` command to the ticket **and
    // UI**"*. No screen renders it yet — the buttons are a UI row of their own — which is why
    // `apps/server/src/routes/client-census.test.ts` names the two routes by hand.
    const taken = await client.json<TaskDetailResponse>(`/api/tasks/${taskId}`);
    expect(taken.body.taken_over).toMatchObject({
      branch: 'agentic/ACME-1',
      session_id: 'fake-session-e2e',
      stage: 'refinement',
      resume_commands: [
        'git fetch && git checkout agentic/ACME-1',
        'claude --resume fake-session-e2e',
      ],
    });

    // ── and the ticket says the same thing the response did ───────────────
    //
    // The workpad is the surface product/19 §19 names, and it is written by an outbound job after
    // the command's own transaction, so this waits for the comment and then reads it (rule 87).
    await pipeline.waitFor('the workpad to carry the resume instructions', async () =>
      (pipeline.tickets.peek('ACME-1')?.comments ?? []).some((comment) =>
        comment.body.includes('Taken over'),
      ),
    );
    const workpad = (pipeline.tickets.peek('ACME-1')?.comments ?? [])
      .map((comment) => comment.body)
      .join('\n');
    expect(workpad).toContain('git fetch && git checkout agentic/ACME-1');
    expect(workpad).toContain('claude --resume fake-session-e2e');
    expect(workpad).toContain('choose a stage on the task page');

    // ── hand it back, at a stage the human chose ──────────────────────────
    const refused = await send(
      client,
      `/api/tasks/${taskId}/hand-back`,
      { stage: 'deployment', summary: 'done' },
      'hand-back-bad',
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('stage_not_in_template');

    // **Implementation, not the stage the task was taken over at and not the next one.** The task
    // was held at `refinement`, so `architecture` is what resuming would have chosen and
    // `code_review` is product/19 §19's default — this case picks neither, because "any stage the
    // template names" is the clause under test and only a *third* choice discriminates. (Handing
    // back to `code_review` here would also be a legitimate escalation rather than a walk: the task
    // has no merge request yet, so the rebase gate downstream would have nothing to read.)
    const handed = await send(
      client,
      `/api/tasks/${taskId}/hand-back`,
      { stage: 'implementation', summary: 'rounded the footer by hand' },
      'hand-back-1',
    );
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);

    // The pipeline resumes **from that stage**: the countable effect is a run of it that did not
    // exist before, and the task walking on to the end from there.
    await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
    const detail = await client.json<TaskDetailResponse>(`/api/tasks/${taskId}`);
    const stages = detail.body.runs.map((entry) => entry.stage);
    expect(stages).toContain('implementation');
    expect(stages).toContain('code_review');
    // Architecture was **not** run: the human chose where to come back to, and the pipeline did not
    // walk there from the stage it was taken over at.
    expect(stages).not.toContain('architecture');

    // …and the take-over is **withdrawn** by the hand-back: the projection reads the newest of the
    // two events, so the task page stops offering a resume command for work that came back.
    expect(detail.body.taken_over).toBeNull();

    const afterEvents = await pipeline.events();
    expect(afterEvents.filter((event) => event.type === 'task.handed_back')).toHaveLength(1);
    // The human's summary is on the event and is not a second copy in the audit row.
    const handedBack = afterEvents.find((event) => event.type === 'task.handed_back');
    expect(JSON.stringify(handedBack?.payload)).toContain('rounded the footer by hand');
  }, 300_000);
});
