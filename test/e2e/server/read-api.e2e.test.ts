/**
 * **WP-15h part 2's third criterion: the seven remaining reads, over rows this pipeline wrote.**
 *
 * Part 1 proved the run endpoints that way and this file does the same for the rest of the read
 * surface — the running-agents list, the inbox, the integrations list, the setup guide, the project
 * list, the readiness refusal, the task page, and the `kb/health` reader the client census cannot
 * see. Every assertion below is against a real `apps/server` instance driven by a real ticket.
 *
 * ## The harness, and why it is the real runner again (standing rules 4 and 82)
 *
 * `agent: 'real-over-fake-cli'` — the production `createClaudeRunner` over a scripted CLI process.
 * Two things this file asserts exist only in that mode. **`onAgentSpec`** is awaited inside the
 * workspace provisioner, which is composed only there, and it is the only way to read
 * `/api/org/agents` while a run is still running rather than after every run has ended. And the
 * **cost**: the scripted `result` reports `total_cost_usd: 0.4` per run across two models
 * (`agent-workspace.ts`), so `ProjectSummary.spent_usd_30d` has something real to sum — WP-19's
 * ledger writes `cost_rollup_daily` on `run.finished`, and the figure asserted below is the
 * difference between two reads rather than a constant, so it cannot be satisfied by a reader that
 * returns the same number twice.
 *
 * ## What the shipped scenarios do **not** produce, checked before it was asserted on
 *
 * No shipped scenario asks a question or requests an approval: `REFINED_SPEC.questions` is `[]` and
 * its `decision` is `'proceed'`, so a ticket driven through `featureScenarios` leaves
 * `GET /api/org/inbox` empty — an assertion about it in that composition would be an assertion about
 * an empty table. The second case therefore drives a **refinement that asks**, which is one stage
 * rather than seven and parks the task at `waiting_answers` with a `questions` row the pipeline
 * wrote.
 *
 * ## `integrations` is the one table with no writer anywhere in this build
 *
 * There is no `POST /api/integrations`; a row arrives by provisioning, which is what `seedWorld`
 * does and what an operator does. So "rows the pipeline wrote" cannot apply to it, and the case
 * below says so rather than pretending: it asserts the projection over the two rows this instance
 * was configured with, including the fail-closed branch for a provider the build does not ship —
 * which both of them are.
 */
import { JOB_QUEUES } from '@platform/application';
import type {
  AgentsResponse,
  InboxResponse,
  IntegrationsResponse,
  KbHealthResponse,
  ProjectsResponse,
  TaskDetailResponse,
  TasksResponse,
} from '@platform/contracts';
import {
  agentsResponseSchema,
  inboxResponseSchema,
  integrationsResponseSchema,
  kbHealthResponseSchema,
  projectsResponseSchema,
  tasksResponseSchema,
} from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_BINDING_TOKEN,
  GIT_INTEGRATION_ID,
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  type SeededWorld,
  startPipeline,
  TICKET_BINDING_TOKEN,
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
    merge_commit_sha: 'd'.repeat(40),
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

/** A promise the test resolves, for holding a run at its workspace. */
const gate = () => {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { opened, open: () => open() };
};

describe('the project, agent and integration reads, over a pipeline that ran', () => {
  it('serves the six remaining screens from rows this instance produced', async () => {
    const held = gate();
    const started = gate();
    let firstRunId: string | null = null;

    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'read-api-2',
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

    // ── /api/org/agents, while an agent is actually running ─────────────────
    // The run is held at its workspace, so this is the one moment a "who is working right now"
    // list has anything in it. Reading it after the walk would assert the empty branch twice.
    const live = await client.json<AgentsResponse>('/api/org/agents');
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    const running = agentsResponseSchema.parse(live.body);
    expect(running.items.map((item) => item.run.id)).toEqual([runId]);
    expect(running.items[0]?.run.stage).toBe('refinement');
    expect(running.items[0]?.project_id).toBe(pipeline.projectId);
    expect(running.items[0]?.run.status).not.toBe('completed');

    held.open();
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );

    // ── /api/projects, with the work and the spend the runs produced ────────
    const first = projectsResponseSchema.parse(
      (await client.json<ProjectsResponse>('/api/projects')).body,
    );
    const beforeMerge = first.items.find((item) => item.id === pipeline.projectId);
    expect(beforeMerge?.key).toBe('api');
    // One task, and it is not finished: `ready_for_merge` is open work.
    expect(beforeMerge?.open_tasks).toBe(1);
    // Five stages have run at 0.40 USD each (`agent-workspace.ts`'s scripted result), charged by
    // WP-19's ledger into `cost_rollup_daily`. The exact figure is that ledger's own e2e to
    // reconcile; what this asserts is that the projection reads a real one.
    expect(beforeMerge?.spent_usd_30d).toBeGreaterThan(0);

    // ── /api/projects/:id/tasks, paged ──────────────────────────────────────
    const page = tasksResponseSchema.parse(
      (await client.json<TasksResponse>(`/api/projects/${pipeline.projectId}/tasks`)).body,
    );
    expect(page.items.map((task) => task.ticket.key)).toEqual(['ACME-1']);
    expect(page.items[0]?.state).toBe('ready_for_merge');
    expect(page.next_cursor).toBeNull();

    // A filter that matches, and one that does not — so "the filter is ignored" fails here.
    const filtered = tasksResponseSchema.parse(
      (
        await client.json<TasksResponse>(
          `/api/projects/${pipeline.projectId}/tasks?state=ready_for_merge`,
        )
      ).body,
    );
    expect(filtered.items).toHaveLength(1);
    const none = tasksResponseSchema.parse(
      (
        await client.json<TasksResponse>(
          `/api/projects/${pipeline.projectId}/tasks?state=cancelled`,
        )
      ).body,
    );
    expect(none.items).toEqual([]);

    // A cursor the endpoint never issued is a client error, not a query with half a keyset in it.
    const badCursor = await client.json<{ error: { code: string } }>(
      `/api/projects/${pipeline.projectId}/tasks?cursor=nope`,
    );
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe('invalid_cursor');

    // And a project that does not exist is a 404 here exactly as it is on `/readiness`: sibling
    // routes must not give one question two answers.
    expect(
      (await client.json('/api/projects/00000000-0000-4000-8000-0000000000ff/tasks')).status,
    ).toBe(404);

    // ── /api/projects/:id/readiness — the refusal, which is the honest answer ─
    const readiness = await client.json<{ error: { code: string; message: string } }>(
      `/api/projects/${pipeline.projectId}/readiness`,
    );
    expect(readiness.status).toBe(409);
    expect(readiness.body.error.code).toBe('readiness_not_evaluated');
    expect(readiness.body.error.message).toContain('readiness_evaluations');

    // ── /api/integrations, and the setup guide ──────────────────────────────
    const integrations = integrationsResponseSchema.parse(
      (await client.json<IntegrationsResponse>('/api/integrations')).body,
    );
    expect(integrations.items.map((item) => item.provider).sort()).toEqual([
      'fake-git',
      'fake-task-management',
    ]);
    const git = integrations.items.find((item) => item.provider === 'fake-git');
    // Direction 1: neither binding's credential is anywhere in the response — and neither is the
    // `project` key the git binding's config carries, because this build ships no `fake-git`
    // provider and therefore cannot tell that key from a credential (fail closed).
    const body = JSON.stringify(integrations);
    expect(body).not.toContain(GIT_BINDING_TOKEN);
    expect(body).not.toContain(TICKET_BINDING_TOKEN);
    expect(git?.config).toEqual({});
    // Direction 2: the row is still described, so this is not a reader that publishes nothing.
    expect(git?.name).toBe('acme fake git');
    expect(git?.type).toBe('git');
    // Nothing writes `integrations.health`, and `unknown` is the published spelling for that.
    expect(git?.health).toEqual({ status: 'unknown', checked_at: null, detail: null });

    const guide = await client.json<{ error: { code: string; message: string } }>(
      `/api/integrations/${GIT_INTEGRATION_ID}/setup-guide`,
    );
    expect(guide.status).toBe(409);
    expect(guide.body.error.code).toBe('provider_not_shipped');
    expect(guide.body.error.message).toContain('fake-git');
    // An integration that does not exist is a 404, not a 409: a wrong id and a provider with no
    // guide are different facts.
    expect(
      (await client.json(`/api/integrations/00000000-0000-4000-8000-0000000000ff/setup-guide`))
        .status,
    ).toBe(404);

    // ── /api/projects/:id/kb/health, after the pass that writes it ──────────
    // Before the pass there is no report, and the 404 says which of the two it is.
    const missing = await client.json<{ error: { code: string; message: string } }>(
      `/api/projects/${pipeline.projectId}/kb/health`,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.message).toContain('hygiene');

    // The nightly pass, fired now rather than waited for: the handler is the production one this
    // instance registered, so the row it writes is a row the platform wrote.
    await pipeline.instance.runtime.jobs?.enqueue({
      queue: JOB_QUEUES.knowledgeHygiene,
      data: {},
    });
    await pipeline.waitFor('the hygiene pass to write a health report', async () => {
      const probe = await client.json(`/api/projects/${pipeline.projectId}/kb/health`);
      return probe.status === 200;
    });
    const health = kbHealthResponseSchema.parse(
      (await client.json<KbHealthResponse>(`/api/projects/${pipeline.projectId}/kb/health`)).body,
    );
    expect(health.project_id).toBe(pipeline.projectId);
    expect(health.source).toBe('hygiene');
    expect(health.documents).toBeGreaterThanOrEqual(0);

    // ── the other direction of "open work", over the same rows ──────────────
    await pipeline.publish([merged(pipeline)]);
    await pipeline.settle('done', (task) => task.state === 'done');

    const after = projectsResponseSchema.parse(
      (await client.json<ProjectsResponse>('/api/projects')).body,
    );
    const afterMerge = after.items.find((item) => item.id === pipeline.projectId);
    // A finished task is not open work…
    expect(afterMerge?.open_tasks).toBe(0);
    // …and the two stages that ran after the merge cost money, so the window moved. Asserting the
    // *difference* is what a reader returning a constant cannot satisfy (standing rule 79).
    expect(afterMerge?.spent_usd_30d).toBeGreaterThan(beforeMerge?.spent_usd_30d ?? 0);

    // Every run has ended, so the agents list is empty — the branch the live read above could not
    // reach, and the pair is what makes either of them mean anything (standing rule 42).
    const idle = agentsResponseSchema.parse(
      (await client.json<AgentsResponse>('/api/org/agents')).body,
    );
    expect(idle.items).toEqual([]);

    // The task read still agrees about the task these lists are about.
    const detail = await client.json<TaskDetailResponse>(`/api/tasks/${waiting.id}`);
    expect(detail.body.task.state).toBe('done');

    // ── and every new route refuses an anonymous caller, per route ──────────
    const anonymous = new Client(pipeline.instance.baseUrl);
    for (const path of [
      '/api/org/agents',
      '/api/org/inbox',
      '/api/integrations',
      `/api/integrations/${GIT_INTEGRATION_ID}/setup-guide`,
      '/api/projects',
      `/api/projects/${pipeline.projectId}/readiness`,
      `/api/projects/${pipeline.projectId}/tasks`,
      `/api/projects/${pipeline.projectId}/kb/health`,
      // An id that does not exist answers 401 too: a 404 here would tell an anonymous caller which
      // uuids name a project (standing rule 18 — the absent case must not be the informative one).
      '/api/projects/00000000-0000-4000-8000-0000000000ff/readiness',
    ]) {
      const refused = await anonymous.json<{ error: { code: string } }>(path);
      expect(refused.status, path).toBe(401);
      expect(refused.body.error.code, path).toBe('unauthenticated');
    }
  }, 300_000);
});

/** The question text the refinement asks; long enough to be unmistakable in a response body. */
const QUESTION_TEXT = 'Which payment provider should the invoice footer total?';

/**
 * `featureScenarios` with a refinement that **asks** instead of proceeding.
 *
 * `stageVerdict` maps `RefinedSpec.decision: 'ask'` onto the `questions` verdict, which is what
 * makes the executor insert the blocking questions and park the task — so this is the shipped
 * mechanism rather than a row the test wrote.
 */
const askingScenarios = (world: SeededWorld) => {
  const base = featureScenarios(world);
  return {
    ...base,
    refinement: {
      structuredOutput: {
        ...(base.refinement.structuredOutput as Record<string, unknown>),
        decision: 'ask',
        questions: [{ id: 'q1', text: QUESTION_TEXT, blocking: true }],
      },
    },
  };
};

describe('the inbox, over a question the pipeline asked', () => {
  it('serves the blocking question a parked task is waiting on', async () => {
    const pipeline = await startPipeline({
      scenarios: askingScenarios,
      label: 'read-api-inbox',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    const parked = await pipeline.settle(
      'waiting_answers',
      (task) => task.state === 'waiting_answers',
    );

    const inbox = inboxResponseSchema.parse(
      (await client.json<InboxResponse>('/api/org/inbox')).body,
    );
    expect(inbox.questions).toHaveLength(1);
    const question = inbox.questions[0];
    expect(question?.text).toBe(QUESTION_TEXT);
    expect(question?.task_id).toBe(parked.id);
    expect(question?.stage).toBe('refinement');
    expect(question?.blocking).toBe(true);
    expect(question?.status).toBe('open');
    // Nothing asks for an approval in this build's templates, so the other half of the inbox is
    // empty here — stated rather than asserted as if it were a result (standing rule 82). The
    // populated approval branch is covered in `test/integration/server/read-api.integration.test.ts`.
    expect(inbox.approvals).toEqual([]);

    // The task page agrees about the state the inbox implies.
    const page = tasksResponseSchema.parse(
      (await client.json<TasksResponse>(`/api/projects/${pipeline.projectId}/tasks`)).body,
    );
    expect(page.items[0]?.state).toBe('waiting_answers');
  }, 180_000);
});
