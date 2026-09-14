/**
 * **WP-29's acceptance criterion 8, on a real `apps/server` instance and a real PostgreSQL**:
 * *"driven from real events … never from a seeded `human_time_entries` table — the fake must
 * produce the MR and question events the projector folds, or the tier certifies nothing about the
 * fold"*.
 *
 * So nothing here inserts a `human_time_entries` row. Two kinds are driven end to end:
 *
 *  - **review**, from **signed merge-request deliveries** — the fake git provider's own webhook
 *    half, posted to the instance's `/webhooks/:provider/:integrationId` and through the real
 *    signature check, the real `inbox`, the real normaliser and the outbox;
 *  - **steer**, from a **real run** held open by a scripted CLI, steered through
 *    `POST /api/runs/:run_id/steer` — the same composition `take-over.e2e.test.ts` uses, because in
 *    `fake-runner` mode a run is over before any HTTP request could reach it (standing rule 82).
 *
 * The other two kinds — question and approval — are folded from events the **platform itself**
 * produces, so a tier that starts whole servers adds nothing to what
 * `test/integration/cost/human-time-backfill.integration.test.ts` already asserts against a real
 * database with real `handler_executions` rows; both are driven there, and the arithmetic of every
 * cap is the unit tier's (`packages/application/src/human-time/minutes.test.ts`).
 *
 * **What this tier cannot say about the minutes themselves**: every delivery it makes happens
 * within seconds, so a review window measured here is seconds long. The assertions are therefore
 * about *which rows exist and what they are attributed to* — one window per reviewer, the mapped
 * one carrying a platform user and the unmapped one carrying the provider account — and the numbers
 * are only bounded. product/19 §16's caps are asserted where a test can control the clock.
 */
import { taskDetailResponseSchema } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

interface EntryRow extends Record<string, unknown> {
  kind: string;
  user_id: string | null;
  external_author: string | null;
  minutes: string | null;
}

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

const entriesOf = (pipeline: PipelineE2E, taskId: string): Promise<readonly EntryRow[]> =>
  pipeline.query<EntryRow>(
    `select kind, user_id, external_author, minutes
       from human_time_entries where task_id = $1 order by kind, external_author nulls first`,
    [taskId],
  );

describe('human time, from events this instance really produced', () => {
  it('folds a steer and two reviewers’ comments into the minutes the task page publishes', async () => {
    const pipeline = await startPipeline({
      scenarios: (world) => ({
        ...featureScenarios(world),
        // The one stage that waits: the scripted CLI stops after its assistant message and holds
        // the session open for exactly one more user turn, which is what makes a steer reach a run
        // that is really running rather than one that has already finished.
        refinement: { ...featureScenarios(world).refinement, awaitSteers: 1 },
      }),
      label: 'human-time',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      // Not silent, which is the harness default: a **500** from a command this test depends on is
      // otherwise invisible — the client sees only `internal_error` and a request id, and the one
      // place the cause exists is the instance's own log (see the identity mapping below, which is
      // how WP-31's 500 was diagnosed).
      env: { LOG_LEVEL: 'error' },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);
    await pipeline.publish([ticketMatched(pipeline)]);

    // ── the steer: five flat minutes, from a run that is open ────────────────
    await pipeline.waitFor('the refinement run to be running', async () => {
      const rows = await pipeline.query<{ id: string }>(
        "select id from runs where status = 'running'",
      );
      return rows.length === 1;
    });
    const [running] = await pipeline.query<{ id: string }>(
      "select id from runs where status = 'running'",
    );
    const steer = await client.json(`/api/runs/${running?.id}/steer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'human-time-steer' },
      body: JSON.stringify({ message: 'sum the model, not the view' }),
    });
    expect(steer.status, JSON.stringify(steer.body)).toBe(200);
    const taskId = (steer.body as { task_id: string }).task_id;

    // The wait is on **the row the assertions read** — the projector is a handler at TD-005
    // priority 230 and commits after the command's response has been sent, so waiting on the
    // response would bind the wrong thing (standing rule 87).
    await pipeline.waitFor('the steer minutes to be recorded', async () => {
      const rows = await entriesOf(pipeline, taskId);
      return rows.some((row) => row.kind === 'steer');
    });
    expect((await entriesOf(pipeline, taskId)).filter((row) => row.kind === 'steer')).toEqual([
      {
        kind: 'steer',
        // A steer is authenticated, so the author is always a platform user — the same one the
        // audit row names.
        user_id: expect.any(String),
        external_author: null,
        minutes: '5.00',
      },
    ]);
    const [steerAction] = await pipeline.query<{ user_id: string }>(
      "select user_id from human_actions where action = 'run.steer'",
    );
    const operator = steerAction?.user_id as string;
    // The audit row and the entry name the same person, which is what makes "the steerer" a
    // property rather than a constant this test wrote down twice.
    expect((await entriesOf(pipeline, taskId)).find((row) => row.kind === 'steer')?.user_id).toBe(
      operator,
    );

    // ── the review: two reviewers, one mapped and one not ───────────────────
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.id).toBe(taskId);

    /**
     * The mapping is made **through the product's own command**, the way an operator makes it.
     *
     * It was a seeded `insert` for one round, because `POST /api/org/identities` answered **500**
     * against a real database — which is what this test found when it was first written against
     * the route (WP-31's defect: the query read `created_at` through drizzle's raw `execute`, which
     * hands a `timestamptz` back unparsed, and the route published the string). The seed is gone
     * with the defect: a test that works around one certifies it, and this call is now the only
     * thing in the e2e tier that exercises the identity command beside
     * `test/e2e/server/identity-api.e2e.test.ts`.
     *
     * What the mapping is *for* here is the projector's **mapped** branch — `resolveUser` finding a
     * platform user for a provider account — and that is what the entries below assert. It is an
     * operator's decision, in the sense `test/e2e/cost/ledger.e2e.test.ts` writes a budget: not
     * something the fold produces.
     */
    const mapped = await client.json('/api/org/identities', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'fake-git',
        external_id: 'ada',
        user_id: operator,
        display_name: 'Ada Lovelace',
      }),
    });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(200);

    for (const author of ['ada', 'grace']) {
      const delivery = pipeline.git.emitReviewComment({
        project: GIT_PROJECT,
        iid: pipeline.world.mr.iid,
        discussionId: `discussion-${author}`,
        authorId: author,
        text: `${author} would like a bound on the retry helper`,
        // Resolved, on purpose: an **unresolved** comment on a task at `ready_for_merge` wakes
        // BD-007's batcher and returns the task to Implementation, which is WP-15's behaviour and
        // would make this test about the pipeline's re-entry rather than about the fold. The
        // projector does not read the flag — a resolved comment is still a person reviewing.
        resolved: true,
      });
      expect((await pipeline.deliverGit(delivery)).status).toBe(202);
    }

    await pipeline.waitFor('both review windows to be recorded', async () => {
      const rows = await entriesOf(pipeline, taskId);
      return rows.filter((row) => row.kind === 'review').length === 2;
    });

    const reviews = (await entriesOf(pipeline, taskId)).filter((row) => row.kind === 'review');
    expect(reviews).toEqual([
      // The mapped account: attributed to the platform user, with the provider account kept beside
      // it so a mapping made later can be reconciled against rows written before it.
      {
        kind: 'review',
        user_id: operator,
        external_author: 'fake-git:ada',
        minutes: expect.any(String),
      },
      // And the unmapped one — which is **every** author on an instance where nobody has mapped an
      // account (BD-006, Q10). `user_id: null`, and the totals below still hold.
      {
        kind: 'review',
        user_id: null,
        external_author: 'fake-git:grace',
        minutes: expect.any(String),
      },
    ]);
    // Two comments, two windows, one each: a second comment from the same author would have
    // extended a window rather than opening one, which is the property the unit tier pins.
    expect(reviews.every((row) => Number(row.minutes) < 5)).toBe(true);

    // ── and the merge ends every window that is still inside the gap ────────
    await pipeline.deliverGit(
      pipeline.git.emitMergeRequestEvent({
        event: 'mr.merged',
        project: GIT_PROJECT,
        iid: pipeline.world.mr.iid,
      }),
    );
    await pipeline.settle('done', (task) => task.state === 'done');

    // ── what the task page publishes (WP-15h's read) ────────────────────────
    const detail = await client.json(`/api/tasks/${taskId}`, { method: 'GET' });
    expect(detail.status).toBe(200);
    const parsed = taskDetailResponseSchema.parse(detail.body);
    expect(parsed.human_time.entries).toBe(3);
    expect(parsed.human_time.by_kind.steer).toBe(5);
    expect(parsed.human_time.by_kind.question).toBe(0);
    // product/18:32: the per-user breakdown is **off by default**, so no name is published even
    // though the rows know two of them.
    expect(parsed.human_time.by_user).toBeNull();
    // **The two numbers of product/09:29, side by side and never added** (Q73): the task's spend is
    // real money from the cost ledger and the minutes are real minutes, and no field here is their
    // sum.
    expect(parsed.task.cost_actual_usd).toBeGreaterThan(0);
    expect(parsed.human_time.total_minutes).toBeGreaterThanOrEqual(5);
    expect(parsed.human_time.total_minutes).toBe(
      Number(
        (
          parsed.human_time.by_kind.review +
          parsed.human_time.by_kind.question +
          parsed.human_time.by_kind.approval +
          parsed.human_time.by_kind.steer
        ).toFixed(2),
      ),
    );
  }, 240_000);
});
