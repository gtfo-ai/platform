/**
 * The realtime client against a fake SSE backend (WP-20's acceptance criterion).
 *
 * The four things the hub's contract obliges a client to do, each proved rather than assumed:
 *
 *  1. a live `transcript` frame reaches the run screen and renders;
 *  2. an `event: reset` makes the client **refetch** — proved by changing what the next fetch
 *     returns and watching the screen change;
 *  3. an `event: shutdown` is surfaced and followed by a reconnect;
 *  4. the reconnect carries the cursor of every topic it holds, in `?last_event_id=`.
 *
 * **The harness is canaried before any of it is believed** (standing rule 21): every publication
 * goes through `publishFrame`, which returns the number of streams the frame reached, and the
 * first assertion of each test is that the number is greater than zero. A fake SSE backend that
 * delivered to nobody would otherwise make every "the screen did not change" assertion pass.
 */
import type { SseFrame } from '@platform/contracts';
import { expect, test } from '@playwright/test';
import { IDS, liveTranscriptEvent, PROJECT_KEY } from './support/fixtures.js';
import {
  addTask,
  publishFrame,
  resetBackend,
  sendControl,
  signIn,
  streamState,
  waitForStreamCarrying,
} from './support/harness.js';

const runTopic = `run:${IDS.run}`;
const projectTopic = `project:${IDS.project}`;

const transcriptFrame = (seq: number): SseFrame => ({
  frame: 'transcript',
  topic: runTopic,
  seq,
  data: { ...liveTranscriptEvent, seq },
});

/** A frame the UI ignores, used only to prove a stream exists and is subscribed to a topic. */
const pingProbe = (topic: string): SseFrame => ({
  frame: 'control',
  topic,
  type: 'ping',
  detail: null,
});

test.beforeEach(async ({ page, request }) => {
  await resetBackend(request);
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Organisation' })).toBeVisible();
});

test('a live transcript frame renders on the run screen', async ({ page, request }) => {
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByRole('heading', { name: 'implementation · developer' })).toBeVisible();
  // The REST page rendered first: this line is in `runMessages`, not in the stream.
  await expect(page.getByText('Reading the retry helper.')).toBeVisible();

  await waitForStreamCarrying(request, runTopic, pingProbe(runTopic), 'ping');

  const delivered = await publishFrame(request, runTopic, 'assistant', transcriptFrame(6));
  expect(delivered, 'the frame reached no stream, so the assertion below proves nothing').toBe(1);

  await expect(page.getByText('Streamed after the page was fetched.')).toBeVisible();
});

test('a duplicate frame does not render twice', async ({ page, request }) => {
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByText('Reading the retry helper.')).toBeVisible();
  await waitForStreamCarrying(request, runTopic, pingProbe(runTopic), 'ping');

  expect(await publishFrame(request, runTopic, 'assistant', transcriptFrame(7))).toBe(1);
  await expect(page.getByText('Streamed after the page was fetched.')).toHaveCount(1);

  // The same `seq` again: a reconnect replays positionally, so this happens in production.
  expect(await publishFrame(request, runTopic, 'assistant', transcriptFrame(7))).toBe(1);
  await expect(page.getByText('Streamed after the page was fetched.')).toHaveCount(1);
});

test('a reset makes the client refetch rather than sit on a stale cache', async ({
  page,
  request,
}) => {
  await page.goto(`/projects/${PROJECT_KEY}`);
  await expect(page.getByRole('link', { name: 'DEMO-1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'DEMO-3' })).toHaveCount(0);

  await waitForStreamCarrying(request, projectTopic, pingProbe(projectTopic), 'ping');

  // The server now answers differently. Nothing has told the client, so the board is stale.
  await addTask(request);
  await expect(page.getByRole('link', { name: 'DEMO-3' })).toHaveCount(0);

  const delivered = await sendControl(request, 'reset', projectTopic);
  expect(delivered, 'the reset reached no stream').toBeGreaterThan(0);

  // Only a refetch can produce this card, so its appearance *is* the refetch.
  await expect(page.getByRole('link', { name: 'DEMO-3' })).toBeVisible();
});

test('a shutdown is surfaced and the client reconnects carrying its cursors', async ({
  page,
  request,
}) => {
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByRole('heading', { name: 'implementation · developer' })).toBeVisible();
  await waitForStreamCarrying(request, runTopic, pingProbe(runTopic), 'ping');

  // A frame with an `id:` — this is what gives the client a cursor to send back.
  expect(await publishFrame(request, runTopic, 'assistant', transcriptFrame(9))).toBe(1);
  await expect(page.getByTestId('connection-status')).toHaveText('Live');

  const before = await streamState(request);
  const delivered = await sendControl(request, 'shutdown', null);
  expect(delivered, 'the shutdown reached no stream').toBeGreaterThan(0);

  await expect(page.getByTestId('connection-status')).toHaveText('Server restarting');

  // The reconnect is the client's own (see realtime/client.ts): a new `GET /events`, carrying the
  // complete cursor set rather than the browser's single `Last-Event-ID`.
  await expect
    .poll(async () => (await streamState(request)).connects.length, {
      message: 'the client never reopened the stream after the shutdown frame',
    })
    .toBeGreaterThan(before.connects.length);

  const after = await streamState(request);
  const reconnect = after.connects[after.connects.length - 1] ?? '';
  expect(reconnect).toContain(`last_event_id=${encodeURIComponent(`${runTopic}:9`)}`);
  await expect(page.getByTestId('connection-status')).toHaveText('Live');
});

test('a reset drops the cursor, so the next reconnect asks for the live stream', async ({
  page,
  request,
}) => {
  await page.goto(`/runs/${IDS.run}`);
  await expect(page.getByRole('heading', { name: 'implementation · developer' })).toBeVisible();
  await waitForStreamCarrying(request, runTopic, pingProbe(runTopic), 'ping');

  expect(await publishFrame(request, runTopic, 'assistant', transcriptFrame(11))).toBe(1);
  expect(await sendControl(request, 'reset', runTopic)).toBeGreaterThan(0);

  const before = await streamState(request);
  expect(await sendControl(request, 'shutdown', null)).toBeGreaterThan(0);

  await expect
    .poll(async () => (await streamState(request)).connects.length)
    .toBeGreaterThan(before.connects.length);

  const after = await streamState(request);
  const reconnect = after.connects[after.connects.length - 1] ?? '';
  // Reconnecting with a cursor the server has already called unplaceable earns another `reset`.
  expect(reconnect).not.toContain('last_event_id');
  expect(reconnect).toContain(encodeURIComponent(runTopic));
});
