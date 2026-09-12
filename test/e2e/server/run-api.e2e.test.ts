/**
 * **WP-15h's first acceptance criterion: the endpoint returns the rows this repository's own
 * pipeline wrote.**
 *
 * The plan row says it in as many words — *"asserted in the e2e tier by driving a run through a
 * real `apps/server` instance and then reading the endpoint, **never against a seeded table**"* —
 * and the choice of harness is the part that makes it true rather than nearly true.
 * `FakeClaudeRunner` is composed with `sink: { append: async () => {} }`
 * (`test/e2e/support/pipeline.ts`), so a run driven through it **writes no `run_messages` row at
 * all**: an assertion about a transcript in that mode would be an assertion about an empty table.
 * So this file uses `agent: 'real-over-fake-cli'` — the production `createClaudeRunner`, the
 * production `createPostgresTranscriptSink` and the production per-run redactor, with only the CLI
 * process doubled (standing rules 4 and 82: ask what the fake does with the value you assert on).
 *
 * What is asserted here and nowhere else:
 *
 *  - the transcript that comes back over HTTP is the one the run produced, cursor-paginated,
 *    including `seq: 0`;
 *  - the run's own `ANTHROPIC_API_KEY` is absent from the response **and** its placeholder present
 *    — both directions, because a reader that redacted nothing and a reader that had nothing to
 *    redact look identical from one side (standing rules 35, 42);
 *  - the same two directions on the **SSE frame**, which travels a different path entirely (the
 *    broadcast hint, a read-back and `SseHub.publish`) and is the half backlog 29 named as missing;
 *  - every one of the five endpoints refuses an anonymous caller, per route.
 */
import type { RunMessagesResponse, RunRecord, TaskDetailResponse } from '@platform/contracts';
import { runMessagesResponseSchema, runRecordSchema } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PLANTED_MODEL_KEY,
  PLANTED_MODEL_KEY_PLACEHOLDER,
  TRANSCRIPT_CONTROL_TEXT,
} from '../support/agent-workspace.js';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';
import { isEvent, SseStream } from '../support/sse-client.js';

let harness: PipelineE2E | undefined;
let stream: SseStream | undefined;

afterEach(async () => {
  await stream?.disconnect();
  stream = undefined;
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

/** A promise the test resolves, for holding a run at its workspace. */
const gate = () => {
  let open = (): void => undefined;
  const opened = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { opened, open: () => open() };
};

describe('the run read API, over a transcript this pipeline wrote', () => {
  it('serves the run, its transcript, its task — and the live frames — without the run’s secret', async () => {
    const held = gate();
    const started = gate();
    let firstRunId: string | null = null;

    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label: 'run-api',
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      onAgentSpec: async (spec) => {
        if (firstRunId !== null) {
          return;
        }
        firstRunId = spec.runId;
        started.open();
        // The first run waits here until the stream below is open, so the frames it produces
        // cannot be missed by a subscription that arrived late.
        await held.opened;
      },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    await pipeline.publish([ticketMatched(pipeline)]);
    await started.opened;
    const runId = firstRunId as unknown as string;

    // ── the live half: the `run:<id>` topic nothing published before WP-15h ──
    stream = await SseStream.open(`${pipeline.instance.baseUrl}/events?topics=run:${runId}`, {
      headers: { cookie: client.cookieHeader },
    });
    await stream.waitFor(() => stream?.received.length !== 0, 'the stream to open');
    held.open();

    await stream.waitFor(
      () => stream?.events().some((event) => event.event === 'assistant') === true,
      'a transcript frame on the run topic',
      30_000,
    );
    const frame = stream.events().find((event) => event.event === 'assistant');
    // The frame's id is `<topic>:<seq>` with the **row's** seq, so a reconnecting client resumes
    // positionally and `?after=` on the REST endpoint means the same number.
    expect(frame?.id).toMatch(new RegExp(`^run:${runId}:\\d+$`));
    const framed = JSON.parse(frame?.data ?? '{}') as { frame: string; seq: number; data: unknown };
    expect(framed.frame).toBe('transcript');
    expect(`run:${runId}:${framed.seq}`).toBe(frame?.id);
    // Both directions on the *frame*, which never touches the HTTP projection.
    expect(frame?.data).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);
    expect(frame?.data).not.toContain(PLANTED_MODEL_KEY);

    // ── the stored half ──
    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.current_stage).toBe('ready_for_merge');

    const run = await client.json<RunRecord>(`/api/runs/${runId}`);
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    // Parsed by the published schema rather than spot-checked: the DTO is strict, so this is also
    // the assertion that the projection invents no key and omits none.
    const parsed = runRecordSchema.parse(run.body);
    expect(parsed.stage).toBe('refinement');
    expect(parsed.status).toBe('completed');
    expect(parsed.project_id).toBe(pipeline.projectId);
    expect(parsed.redaction_count).toBeGreaterThanOrEqual(0);

    const messages = await client.json<RunMessagesResponse>(`/api/runs/${runId}/messages`);
    expect(messages.status, JSON.stringify(messages.body)).toBe(200);
    const page = runMessagesResponseSchema.parse(messages.body);
    // The rows the pipeline wrote, in order, starting at zero (migration 0016).
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((item) => item.seq)).toEqual(
      [...page.items.map((item) => item.seq)].sort((a, b) => a - b),
    );
    expect(page.items[0]?.seq).toBe(0);
    expect(page.next_seq).toBeNull();

    const body = JSON.stringify(page);
    expect(body).toContain(TRANSCRIPT_CONTROL_TEXT);
    expect(body).toContain(PLANTED_MODEL_KEY_PLACEHOLDER);
    expect(body).not.toContain(PLANTED_MODEL_KEY);

    // The cursor, from both ends: a page of one starting at the first entry, then the rest.
    const firstOnly = await client.json<RunMessagesResponse>(`/api/runs/${runId}/messages?limit=1`);
    expect(firstOnly.body.items.map((item) => item.seq)).toEqual([0]);
    expect(firstOnly.body.next_seq).toBe(0);
    const rest = await client.json<RunMessagesResponse>(`/api/runs/${runId}/messages?after=0`);
    expect(rest.body.items.map((item) => item.seq)).toEqual(
      page.items.slice(1).map((item) => item.seq),
    );

    // ── the two refusals, which are the honest answer while nothing writes the columns ──
    const prompt = await client.json<{ error: { code: string; message: string } }>(
      `/api/runs/${runId}/prompt`,
    );
    expect(prompt.status).toBe(409);
    expect(prompt.body.error.code).toBe('prompt_not_recorded');
    expect(prompt.body.error.message).toContain('runs.system_prompt');

    const pack = await client.json<{ error: { code: string; message: string } }>(
      `/api/runs/${runId}/context-pack`,
    );
    expect(pack.status).toBe(409);
    expect(pack.body.error.code).toBe('context_pack_not_recorded');
    // The message names the schema gap rather than only the missing rows, because rows alone would
    // not make this endpoint answerable.
    expect(pack.body.error.message).toContain('budget_tokens');

    // ── the task screen's read ──
    const task = await client.json<TaskDetailResponse>(`/api/tasks/${waiting.id}`);
    expect(task.status, JSON.stringify(task.body)).toBe(200);
    expect(task.body.task.ticket.key).toBe('ACME-1');
    expect(task.body.runs.map((entry) => entry.stage)).toEqual([
      'refinement',
      'architecture',
      'implementation',
      'code_review',
      'business_review',
    ]);
    expect(task.body.artifacts.length).toBeGreaterThan(0);
    expect(JSON.stringify(task.body)).not.toContain(PLANTED_MODEL_KEY);

    // ── unknown ids are 404, not 500 or an empty document ──
    const unknown = '00000000-0000-4000-8000-0000000000ff';
    expect((await client.json(`/api/runs/${unknown}`)).status).toBe(404);
    expect((await client.json(`/api/tasks/${unknown}`)).status).toBe(404);

    // ── and every new route refuses an anonymous caller, per route ──
    const anonymous = new Client(pipeline.instance.baseUrl);
    for (const path of [
      `/api/runs/${runId}`,
      `/api/runs/${runId}/messages`,
      `/api/runs/${runId}/prompt`,
      `/api/runs/${runId}/context-pack`,
      `/api/tasks/${waiting.id}`,
      // An id that does not exist must answer 401 too: a 404 here would tell an anonymous caller
      // which uuids name a run (standing rule 18 — the absent case must not be the informative one).
      `/api/runs/${unknown}`,
    ]) {
      const refused = await anonymous.json<{ error: { code: string } }>(path);
      expect(refused.status, path).toBe(401);
      expect(refused.body.error.code, path).toBe('unauthenticated');
    }

    // The bridge published only what somebody was watching: the stream carries this run's frames
    // and no other run's, even though four more ran on the same instance.
    const topics = new Set(
      stream.received
        .filter(isEvent)
        .map((event) => event.id?.slice(0, event.id.lastIndexOf(':')))
        .filter((topic): topic is string => topic !== undefined),
    );
    expect([...topics]).toEqual([`run:${runId}`]);
  }, 240_000);
});
