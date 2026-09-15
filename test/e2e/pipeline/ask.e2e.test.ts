/**
 * **WP-31's headline criterion: a human asks a running task a question and gets an answer.**
 *
 * Everything from the HTTP request in is production code — `routes/asks.ts` with its
 * `Idempotency-Key` and its `human_actions` row, `askTaskCommand`, the `task.ask` queue, the ask
 * executor with the same admission guard, cost ledger and transcript sink every other run gets,
 * `createAskRunPlanner`'s prompt, the `AskAnswer` artifact, `task_asks`, and the `pipeline.outbound`
 * duty that mirrors the answer into the ticket thread. Only the model is a double.
 *
 * Three things this file is written to be able to fail on.
 *
 *  - **The fake picks its scenario from the prompt, not from `spec.stage`** (standing rule 82,
 *    criterion 8). An ask *has* no stage, so a stage-dispatching fake cannot express this case at
 *    all — which is exactly the instrument failure that rule records. `askScenarioKey` reads the
 *    question out of the assembled prompt's `ask_question` block, so a planner that produced an
 *    empty prompt, forgot the block or put a different question in it fails here by name.
 *  - **Every assertion is on a row** (standing rule 79): `task_asks`, `runs`, `artifacts`,
 *    `human_actions`, `cost_entries` and the messages the fake ticket provider actually holds.
 *  - **The wait is on the last row the platform writes** (standing rule 87). `task_asks.status`
 *    moves to `answered` in the executor's transaction 2, *before* the mirror job posts anything,
 *    so the mirror's own assertion waits on `mirrored_at` — which is written after the provider
 *    call returns — rather than on the comment.
 */
import { JOB_QUEUES, type Jobs } from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const QUESTION = 'why did you choose a column instead of a table?';
const ANSWER = 'The Implementation Plan says a join on every read of the task page would be worse.';
/**
 * The question the two **sentinel** asks of the recovery case carry.
 *
 * A sentinel is a genuinely stranded ask — `pending`, old enough, no run — seeded straight into the
 * table, so the pass picks it up and answers it. It is how that case waits for *"the recovery pass
 * has run"* without waiting for a duration (standing rule 2): the row it moves is the evidence.
 */
const SENTINEL = 'what is the status of this task?';
const SENTINEL_ANSWER = 'It is waiting for a human to merge the branch.';

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

interface AskRow extends Record<string, unknown> {
  id: string;
  status: string;
  source: string;
  question: string;
  answer: string | null;
  run_id: string | null;
  answer_artifact_id: string | null;
  dropped_citations: number;
  mirrored_at: Date | null;
}

const asks = (pipeline: PipelineE2E) =>
  pipeline.query<AskRow>(
    `select id, status, source, question, answer, run_id, answer_artifact_id, dropped_citations,
            mirrored_at
       from task_asks order by created_at`,
  );

/**
 * The scenarios for the ticket's stages, plus the one for the ask — keyed by the **question**.
 *
 * The key is what `askScenarioKey` reads out of the prompt the planner produced, so this table is
 * the whole of criterion 8 in one line: a run with no stage has no stage id to be keyed by, and
 * this one is keyed by the bytes the ask agent was actually given.
 */
const scenarios = (world: Parameters<typeof featureScenarios>[0]) => ({
  ...featureScenarios(world),
  [`ask:${QUESTION}`]: {
    costUsd: 0.2,
    structuredOutput: {
      answer: ANSWER,
      citations: [
        // Deliberately a run this task does not have: the citation scope check must drop it and
        // count the drop, and the answer must survive (product/11:30, standing rule 20).
        {
          kind: 'run',
          run_id: '00000000-0000-4000-8000-0000000000ff',
          detail: 'a run of another task',
        },
        {
          kind: 'artifact',
          artifact_type: 'ImplementationPlan',
          version: 1,
          detail: 'the approach it states',
        },
      ],
      unanswered: [],
      confidence: 'high' as const,
    },
  },
  [`ask:${SENTINEL}`]: {
    costUsd: 0.05,
    structuredOutput: {
      answer: SENTINEL_ANSWER,
      citations: [],
      unanswered: [],
      confidence: 'high' as const,
    },
  },
});

/**
 * Swallows the **first** `task.ask` wake-up: exactly what a crash between the command's commit and
 * its `Jobs.enqueue` would cost (PROGRESS backlog **84**, WP-36's criterion 10).
 *
 * The first only, because the recovery's own re-enqueue is the second — a seam that swallowed every
 * one would be testing that an ask cannot work rather than that the recovery does (the reasoning
 * `intake-recovery.e2e.test.ts` states for entry 20 and `history-bootstrap.e2e.test.ts` for 101).
 */
const dropFirstAskWakeUp = (dropped: string[]) => (jobs: Jobs) => ({
  ...jobs,
  enqueue: async <TData extends Record<string, unknown>>(request: {
    queue: string;
    data?: TData;
  }) => {
    if (request.queue === JOB_QUEUES.taskAsk && dropped.length === 0) {
      dropped.push(String((request.data as { ask_id?: string } | undefined)?.ask_id));
      return { status: 'enqueued' as const, jobId: 'dropped-on-the-floor' };
    }
    return jobs.enqueue(request as never);
  },
});

describe('ask-the-task, through a composed instance', () => {
  it('answers a question from the task’s own record, and charges it like any other run', async () => {
    const pipeline = await startPipeline({
      scenarios,
      label: 'ask',
      tickets: TICKETS,
      // Q72 (d): the mirror is off by default, so this project turns it on — which is what makes
      // the ticket comment below an assertion about the setting rather than about the default.
      config: { features: { ask: { mirror_to_ticket: true } } },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    const spentBefore = Number(waiting.cost_actual);
    expect(spentBefore).toBeGreaterThan(0);

    // ── The ask, over HTTP, through the route the SPA calls ───────────────────────────────────
    const asked = await client.json<{ ask_id: string; performed: boolean; status: string }>(
      `/api/tasks/${waiting.id}/ask`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'ask-1' },
        body: JSON.stringify({ question: QUESTION }),
      },
    );
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    expect(asked.body.performed).toBe(true);
    expect(asked.body.status).toBe('pending');

    await pipeline.waitFor('the ask to be answered', async () =>
      (await asks(pipeline)).some((row) => row.status === 'answered'),
    );

    const [ask] = await asks(pipeline);
    expect(ask?.source).toBe('ui');
    expect(ask?.question).toBe(QUESTION);
    expect(ask?.answer).toBe(ANSWER);
    // Criterion 6: the citation that named another task's run is gone and the drop is counted, and
    // the answer the project paid for survived.
    expect(ask?.dropped_citations).toBe(1);
    expect(ask?.answer_artifact_id).not.toBeNull();

    // ── Criterion 1: a run with this task and **no stage** ────────────────────────────────────
    const runs = await pipeline.query<{
      id: string;
      task_stage_id: string | null;
      role: string;
      mode: string;
      status: string;
    }>(`select id, task_stage_id, role, mode, status from runs where id = $1`, [ask?.run_id ?? '']);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      task_stage_id: null,
      role: 'ask',
      mode: 'ask',
      status: 'completed',
    });

    // ── Criterion 9: an ordinary ledger entry, distinguishable from stage spend ───────────────
    //
    // **A second wait, and it is standing rule 87's whole lesson.** `task_asks.status` and
    // `tasks.cost_actual` are both written in the executor's transaction 2, so the wait above binds
    // them — but `cost_entries` is written by the **cost ledger's handler on `run.finished`**, which
    // is a different dispatch in a different transaction that commits afterwards. The first draft
    // asserted the ledger behind the answer's wait; it passed on one run of `verify:e2e` and failed
    // on the next, which is what running it twice is for.
    await pipeline.waitFor('the ask’s cost to reach the ledger', async () => {
      const rows = await pipeline.query('select 1 from cost_entries where run_id = $1', [
        ask?.run_id ?? '',
      ]);
      return rows.length > 0;
    });
    const entries = await pipeline.query<{ run_id: string; stage: string; usd: string }>(
      'select run_id, stage, usd from cost_entries where run_id = $1',
      [ask?.run_id ?? ''],
    );
    expect(entries.length).toBeGreaterThan(0);
    // Distinguishable from stage spend without a second column: the ledger's `stage` for a run that
    // belongs to none is `(none)`, which is `ledgerEntriesForRun`'s own answer rather than a word
    // this test taught it.
    expect(entries.every((entry) => entry.stage === '(none)')).toBe(true);
    expect(entries.reduce((sum, entry) => sum + Number(entry.usd), 0)).toBeCloseTo(0.2, 6);
    // …and it is on the task's own spend, which is what the per-question cap is compared against.
    const after = await pipeline.task();
    expect(Number(after.cost_actual)).toBeCloseTo(spentBefore + 0.2, 6);

    // ── Criterion 7: one `human_actions` row, and the words are not in it ─────────────────────
    const actions = await pipeline.query<{ action: string; params: Record<string, unknown> }>(
      "select action, params from human_actions where task_id = $1 and action = 'task.ask'",
      [waiting.id],
    );
    expect(actions).toHaveLength(1);
    expect(JSON.stringify(actions[0]?.params)).not.toContain('why did you choose');
    expect(actions[0]?.params.ask_id).toBe(ask?.id);

    // ── Criterion 10: the task-scoped audit read serves that row ──────────────────────────────
    const audit = await client.json<{ items: { action: string }[] }>(
      `/api/tasks/${waiting.id}/audit`,
    );
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    expect(audit.body.items.map((item) => item.action)).toContain('task.ask');

    // ── The thread the SPA renders ────────────────────────────────────────────────────────────
    const thread = await client.json<{ items: { answer: string | null; status: string }[] }>(
      `/api/tasks/${waiting.id}/asks`,
    );
    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    expect(thread.body.items[0]?.answer).toBe(ANSWER);

    // ── Criterion 4: the mirror is a `pipeline.outbound` duty, not a handler ──────────────────
    //
    // `mirrored_at` is the last row the platform writes for it, in its own transaction after the
    // provider answered — so waiting on it is what makes the comment assertion safe (rule 87).
    await pipeline.waitFor('the answer to be mirrored into the ticket thread', async () =>
      (await asks(pipeline)).some((row) => row.mirrored_at !== null),
    );
    const comments = pipeline.tickets.peek('ACME-1')?.comments ?? [];
    expect(comments.some((comment) => comment.body.includes(ANSWER))).toBe(true);
    const chatActions = (await pipeline.auditRows()).filter((row) => row.action === 'add_comment');
    expect(chatActions.some((row) => row.status === 'ok')).toBe(true);

    // ── Criterion 7: a replayed key performs nothing twice, on a countable effect ─────────────
    const replay = await client.json<{ ask_id: string; performed: boolean }>(
      `/api/tasks/${waiting.id}/ask`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'ask-1' },
        body: JSON.stringify({ question: QUESTION }),
      },
    );
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body.performed).toBe(false);
    expect(replay.body.ask_id).toBe(ask?.id);
    expect(await asks(pipeline)).toHaveLength(1);
    expect(
      await pipeline.query(
        "select 1 from human_actions where task_id = $1 and action = 'task.ask'",
        [waiting.id],
      ),
    ).toHaveLength(1);
  });

  /**
   * **PROGRESS backlog 84 and 105**, the ask row of the lost-wake-up table, in the two directions
   * that matter — and both are read back from the rows themselves (standing rule 79).
   *
   * 1. *The recovery works.* The wake-up the command asked for is **dropped** — killing a process
   *    at that microsecond boundary is not a test — and the question is answered anyway, by the
   *    pass that rides the intake reconciler's timer.
   * 2. *It costs exactly one run.* An ask left `pending` by a run **another writer ended** (the
   *    measured case of `ask-pipeline.test.ts`' *"an ask whose run somebody else ended first"*) was
   *    found by the first version of the query, which asked only *"pending and old"* — and was
   *    re-enqueued into a **second paid run**, once a minute, with no `cost_entries` row from the
   *    dead run to make any budget notice. `run_id is null` is the fix; this case is its
   *    reproduction.
   *
   * The waiting is on the pass's **own effect on another row** rather than on a duration: a
   * sentinel ask is seeded stranded, and its answer is the proof that a pass ran. Two sentinels,
   * one after the other, are two passes.
   */
  it('recovers a question whose wake-up was lost, and pays for no second run of one that had one', async () => {
    const dropped: string[] = [];
    const pipeline = await startPipeline({
      scenarios,
      label: 'ask-recovery',
      tickets: TICKETS,
      jobs: dropFirstAskWakeUp(dropped),
      env: {
        // A one-second recovery interval: the same number is the gap between passes **and** the age
        // a stranded row must reach (`intake-reconcile.ts`'s one knob). The default 60 s is longer
        // than this suite may wait.
        APP_INTAKE_RECONCILE_INTERVAL_MS: '1000',
      },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1')]);
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );

    const asked = await client.json<{ ask_id: string }>(`/api/tasks/${waiting.id}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'ask-lost' },
      body: JSON.stringify({ question: QUESTION }),
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const askId = asked.body.ask_id;
    expect(dropped, 'the wake-up the command asked for was swallowed').toEqual([askId]);

    // The loss, as an operator meets it: a question in the thread with no run behind it and — until
    // this pass existed — nothing that would ever pick it up.
    const [lost] = await asks(pipeline);
    expect(lost).toMatchObject({ id: askId, status: 'pending', run_id: null });

    await pipeline.waitFor('the stranded question to be answered after all', async () =>
      (await asks(pipeline)).some((row) => row.id === askId && row.status === 'answered'),
    );
    const recovered = (await asks(pipeline)).find((row) => row.id === askId);
    expect(recovered?.answer).toBe(ANSWER);
    const runId = recovered?.run_id ?? '';
    expect(runId).not.toBe('');

    // The bound the recovery wrote for itself (backlog 105, migration 0032): one attempt, recorded
    // on the row, which is what stops the next pass re-enqueueing the same question for ever.
    const [marked] = await pipeline.query<{ recovery_attempted_at: Date | null }>(
      'select recovery_attempted_at from task_asks where id = $1',
      [askId],
    );
    expect(marked?.recovery_attempted_at).not.toBeNull();

    await pipeline.waitFor(
      'the recovered run’s cost to reach the ledger',
      async () =>
        (await pipeline.query('select 1 from cost_entries where run_id = $1', [runId])).length > 0,
    );

    /**
     * Now the second direction. The row is put back into the measured state — `pending`, with the
     * run it already had — and its recovery mark is **cleared deliberately**, so what is under test
     * is the query's `run_id is null` rather than the bound that would also have hidden it.
     */
    await pipeline.query(
      `update task_asks
          set status = 'pending', answer = null, answered_at = null, recovery_attempted_at = null
        where id = $1`,
      [askId],
    );

    const seedSentinel = async (): Promise<string> => {
      const [row] = await pipeline.query<{ id: string }>(
        `insert into task_asks
           (task_id, project_id, source, asked_by_user_id, question, status, created_at)
         values ($1, $2, 'ui', $3, $4, 'pending', now() - interval '10 seconds')
         returning id`,
        [waiting.id, pipeline.projectId, pipeline.userId, SENTINEL],
      );
      return row?.id as string;
    };
    const answered = async (id: string): Promise<boolean> =>
      (await asks(pipeline)).some((row) => row.id === id && row.status === 'answered');

    const first = await seedSentinel();
    await pipeline.waitFor('one recovery pass after the question was poisoned', async () =>
      answered(first),
    );
    const second = await seedSentinel();
    await pipeline.waitFor('a second recovery pass', async () => answered(second));

    // Two passes have run over a `pending` ask older than the grace, and it is untouched: no new
    // run, no second answer, and not even the mark — the query never returned it.
    const [poisoned] = await pipeline.query<{
      status: string;
      run_id: string | null;
      recovery_attempted_at: Date | null;
    }>('select status, run_id, recovery_attempted_at from task_asks where id = $1', [askId]);
    expect(poisoned).toMatchObject({ status: 'pending', run_id: runId });
    expect(poisoned?.recovery_attempted_at).toBeNull();

    // The counts, which is what "a second paid run" would move: three ask runs on this task — the
    // recovered one and the two sentinels — and one ledger row for the recovered run. Before the
    // fix this grew by one run and one ledger row per pass.
    const askRuns = await pipeline.query<{ id: string }>(
      "select id from runs where task_id = $1 and role = 'ask'",
      [waiting.id],
    );
    expect(askRuns).toHaveLength(3);
    expect(pipeline.specs.filter((spec) => spec.role === 'ask')).toHaveLength(3);
    const entries = await pipeline.query<{ count: string }>(
      'select count(*)::text as count from cost_entries where run_id = $1',
      [runId],
    );
    expect(Number(entries[0]?.count)).toBe(1);
  }, 180_000);
});
