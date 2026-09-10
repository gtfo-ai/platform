/**
 * The Slack adapter driven **through** `IntegrationActionExecutor` (technical/06 § "Outbound:
 * actions").
 *
 * This file exists because of an obligation the executor's own docblock puts on the provider work
 * packages, verbatim:
 *
 * > a port method that changes provider state must be asserted to reach the executor as a
 * > `MutatingActionRequest`, by running it in shadow mode and asserting the provider was not
 * > entered.
 *
 * For a fake, "not entered" is a call log. For a real adapter it is stronger: **zero HTTP
 * requests**, observed on the transport the adapter was given. The 429 half proves the other
 * direction — that Slack's documented rate-limit answer (`429` with `Retry-After` in seconds)
 * arrives as an `IntegrationRateLimitedError` and is waited out on the executor's injected timer,
 * never on a wall clock.
 *
 * It is also where the *durable* half of `postTaskThread`'s idempotency is proved. The adapter's
 * own thread directory is in memory, so an assertion made against one adapter instance would
 * prove the map and not the platform. Here the second call is made by a **fresh adapter with a
 * fresh transport**, sharing only the executor's idempotency store — which is exactly what a
 * restarted process looks like.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
  exactSecretRedactor,
  type IntegrationActionRequest,
  type MemoryIdempotencyStore,
  type MemoryIntegrationAuditLog,
  type ThreadRef,
  type VirtualTimer,
} from '@platform/application';
import type { JsonObject, TaskMode } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL,
  CLOCK_AT,
  FAKE_BOT_TOKEN,
  THREAD_TS,
} from '../support/integrations/slack-fixtures.js';
import { SLACK_TASK_ID, slackReplayContext } from '../support/integrations/slack-harness.js';
import type { SlackInteraction } from '../support/integrations/slack-replay.js';

const PROJECT_ID = '00000000-0000-4000-8000-0000000000ba';

/**
 * Slack answers `429` with `Retry-After` in seconds
 * (<https://docs.slack.dev/apis/web-api/rate-limits>, retrieved 2026-09-10: "HTTP 429 Too Many
 * Requests", `Retry-After: 30`, "the number of seconds until you can retry"). The status and the
 * header are documented; no body is published, so the one here is illustrative and the adapter
 * never reads it.
 */
const rateLimited = (retryAfterSeconds: string): SlackInteraction => ({
  method: 'POST',
  path: '/chat.postMessage',
  match: { channel: CHANNEL, text: 'Picked up *TASK-1*' },
  status: 429,
  headers: { 'retry-after': retryAfterSeconds },
  body: { ok: false, error: 'ratelimited' },
  source: {
    url: 'https://docs.slack.dev/apis/web-api/rate-limits',
    retrieved: '2026-09-10',
    kind: 'documented-adapted',
    note: 'The 429 status and the Retry-After header are documented; the page publishes no body for a rate-limited response, so the body here is illustrative and only the status and the header are load-bearing.',
  },
});

describe('Slack through IntegrationActionExecutor', () => {
  let auditLog: MemoryIntegrationAuditLog;
  let timer: VirtualTimer;
  let idempotency: MemoryIdempotencyStore;

  beforeEach(() => {
    auditLog = createMemoryAuditLog();
    timer = createVirtualTimer({ autoAdvance: true });
    idempotency = createMemoryIdempotencyStore();
  });

  const executor = () =>
    createIntegrationActionExecutor({
      auditLog,
      // The binding's own secrets, as every `testConnection` and every audit row must be built
      // with (TD-012).
      redactor: exactSecretRedactor([{ name: 'slack.bot_token', value: FAKE_BOT_TOKEN }]),
      timer,
      clock: fixedClock(CLOCK_AT),
      idempotencyStore: idempotency,
      rateLimits: { capacity: 100, refillPerSecond: 100, maxConcurrent: 4 },
    });

  const threadRequest = (
    context: ReturnType<typeof slackReplayContext>,
    mode: TaskMode,
  ): IntegrationActionRequest<ThreadRef> => ({
    integration: context.port.ref,
    action: 'post_task_thread',
    mutating: true,
    mode,
    payload: { channel: CHANNEL, task_id: SLACK_TASK_ID },
    projectId: PROJECT_ID,
    taskId: SLACK_TASK_ID,
    // A `ThreadRef` is JSON, so the executor can replay it — which is what makes the adapter's
    // in-memory directory a convenience rather than the platform's promise.
    idempotency: {
      key: `slack:thread:${SLACK_TASK_ID}`,
      encode: (result) => result as unknown as JsonObject,
      decode: (stored) => stored as unknown as ThreadRef,
    },
    shadowResult: () => ({
      provider: 'slack',
      channel: CHANNEL,
      thread_id: 'shadow',
      url: null,
    }),
    describeResult: (result) => ({ channel: result.channel, thread_id: result.thread_id }),
    perform: async () =>
      context.port.postTaskThread({
        channel: CHANNEL,
        taskId: SLACK_TASK_ID,
        body: { markdown: 'Picked up **TASK-1**' },
      }),
  });

  it('performs the post and records it', async () => {
    const context = slackReplayContext();
    const outcome = await executor().execute(threadRequest(context, 'normal'));

    expect(outcome.status).toBe('ok');
    expect(outcome.result.thread_id).toBe(THREAD_TS);
    expect(context.replay.requests).toHaveLength(1);
    expect(auditLog.entries[0]).toMatchObject({ action: 'post_task_thread', status: 'ok' });
  });

  it('sends nothing at all in shadow mode, and records what it would have done', async () => {
    const context = slackReplayContext();
    const outcome = await executor().execute(threadRequest(context, 'shadow'));

    expect(outcome.status).toBe('would_have');
    expect(
      context.replay.requests,
      'a shadow task must not reach the provider: zero HTTP requests',
    ).toEqual([]);
    expect(auditLog.entries[0]).toMatchObject({
      action: 'post_task_thread',
      status: 'would_have',
    });
    // Row and event are not the same record: `would_have` writes a row and no event.
    expect(auditLog.events).toEqual([]);
  });

  it('replays a task thread for a *fresh* adapter, which no in-memory map could do', async () => {
    const first = slackReplayContext();
    const opened = await executor().execute(threadRequest(first, 'normal'));
    expect(opened.status).toBe('ok');

    // A new adapter with a new transport: the process restarted, and the only thing it shares with
    // the previous one is the executor's idempotency store.
    const restarted = slackReplayContext();
    const again = await executor().execute(threadRequest(restarted, 'normal'));

    expect(again.status).toBe('replayed');
    expect(again.result.thread_id, 'the same thread, out of the store').toBe(THREAD_TS);
    expect(
      restarted.replay.requests,
      'a replayed action issues no request, so no second thread is opened',
    ).toEqual([]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok', 'replayed']);
  });

  it('waits out a documented 429 on the executor timer and then succeeds', async () => {
    const context = slackReplayContext();
    const recorded = context.replay.requests;
    // A sequence: the 429, then the recorded 200 for the same key.
    context.replay.script([
      rateLimited('30'),
      {
        method: 'POST',
        path: '/chat.postMessage',
        match: { channel: CHANNEL, text: 'Picked up *TASK-1*' },
        status: 200,
        body: { ok: true, channel: CHANNEL, ts: THREAD_TS },
        source: {
          url: 'https://docs.slack.dev/reference/methods/chat.postMessage',
          retrieved: '2026-09-10',
          kind: 'documented-adapted',
          note: "The page's example success response reduced to the three members the adapter reads; scripted here as the answer after the 429.",
        },
      },
    ]);

    const outcome = await executor().execute(threadRequest(context, 'normal'));

    expect(outcome.status).toBe('ok');
    expect(outcome.attempts, 'the first attempt was rate limited').toBe(2);
    expect(recorded).toHaveLength(2);
    expect(
      timer.sleeps,
      "Slack's Retry-After of 30 seconds, waited on the injected timer rather than a wall clock",
    ).toContain(30_000);
  });

  it('never puts the bot token in an audit row', async () => {
    const context = slackReplayContext();
    await executor().execute({
      ...threadRequest(context, 'normal'),
      // A caller that put the token in the payload — the shape TD-012 exists for.
      payload: { channel: CHANNEL, note: `authenticated with ${FAKE_BOT_TOKEN}` },
    });
    const rendered = JSON.stringify(auditLog.entries);
    expect(rendered).not.toContain(FAKE_BOT_TOKEN);
    expect(rendered, 'and the redaction left its mark').toContain('REDACTED');
  });
});
