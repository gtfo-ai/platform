/**
 * WP-06's other two acceptance criteria: **SSE replay after reconnect** and **shutdown drains SSE**
 * (docs/technical/13-implementation-plan.md), against a listening socket.
 *
 * Both are properties of the wire, not of an object graph: replay is about what a *second* HTTP
 * request receives after the first one was cut, and draining is about a frame reaching the socket
 * before it closes. `app.inject()` cannot show either, so these run through `fetch` and parse the
 * `text/event-stream` bytes.
 */
import type { SseFrame, SseTopic } from '@platform/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_PASSWORD,
  Client,
  type Instance,
  type SeededProject,
  seedProject,
  startInstance,
} from '../support/instance.js';
import { SseStream } from '../support/sse-client.js';

let instance: Instance;
let client: Client;
let seeded: SeededProject;
let RUN_ID: string;
let TOPIC: SseTopic;

/** A well-formed transcript frame; `seq` is the publisher's, exactly as TD-014 specifies. */
const frame = (seq: number, message: string): SseFrame => ({
  frame: 'transcript',
  topic: TOPIC,
  seq,
  data: {
    run_id: RUN_ID,
    seq,
    created_at: '2026-09-09T10:15:30Z',
    parent_tool_use_id: null,
    redaction_count: 0,
    kind: 'steer',
    message,
    author_user_id: '0199aa11-2b3c-7d4e-8f90-000000000002',
  },
});

const openStream = async (query: string): Promise<SseStream> =>
  SseStream.open(`${instance.baseUrl}/events?${query}`, { headers: client.headers() });

beforeEach(async () => {
  instance = await startInstance();
  seeded = await seedProject(instance);
  RUN_ID = seeded.runId;
  // The bootstrap account is an `admin`, so `transcript.read` (member and above) is satisfied.
  TOPIC = `run:${RUN_ID}` as SseTopic;
  client = new Client(instance.baseUrl);
  const signIn = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(signIn.status).toBe(200);
}, 180_000);

afterEach(async () => {
  await instance?.stop();
});

describe('GET /events', () => {
  it('needs a session', async () => {
    const anonymous = await SseStream.open(`${instance.baseUrl}/events?topics=org`);
    expect(anonymous.response.status).toBe(401);
  });

  it('rejects a topic outside the documented set', async () => {
    const stream = await openStream('topics=whatever');
    expect(stream.response.status).toBe(400);
  });

  it('rejects a well-formed topic whose subject does not exist', async () => {
    // A viewer used to be able to name any uuid and get 200. Now the topic is resolved to the
    // project it belongs to before `can()` is asked, so an invented id is a 404.
    const stream = await openStream('topics=run:0199aa11-2b3c-7d4e-8f90-0000000000ff');
    expect(stream.response.status).toBe(404);
  });

  it('refuses a viewer the run topic, because it carries the transcript', async () => {
    const admin = client;
    const created = await admin.post<{ user: { id: string } }>('/api/auth/admin/create-user', {
      email: 'viewer@example.test',
      password: 'a-fake-viewer-password-9876',
      name: 'Viewer',
      role: 'viewer',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const viewer = new Client(instance.baseUrl);
    const signIn = await viewer.post('/api/auth/sign-in/email', {
      email: 'viewer@example.test',
      password: 'a-fake-viewer-password-9876',
    });
    expect(signIn.status).toBe(200);

    // `transcript.read` is member-and-above (technical/08), so the run topic is refused…
    const refused = await SseStream.open(`${instance.baseUrl}/events?topics=${TOPIC}`, {
      headers: viewer.headers(),
    });
    expect(refused.response.status).toBe(403);

    // …while the project's own topic, at `project.read`, is not.
    const allowed = await SseStream.open(
      `${instance.baseUrl}/events?topics=project:${seeded.projectId}`,
      { headers: viewer.headers() },
    );
    expect(allowed.response.status).toBe(200);
    await allowed.disconnect();
  });

  it('sends the reconnect interval once, then live frames with a per-topic id', async () => {
    const stream = await openStream(`topics=${TOPIC}&connection_id=c1`);
    expect(stream.response.status).toBe(200);
    expect(stream.response.headers.get('content-type')).toContain('text/event-stream');

    // technical/08: `retry: 1000`.
    await stream.waitFor(() => stream.events().length >= 1, 'the opening frame');
    expect(stream.events()[0]?.retry).toBe(1_000);

    instance.runtime.hub.publish(frame(1, 'first'));
    instance.runtime.hub.publish(frame(2, 'second'));
    await stream.waitFor(() => stream.events().length >= 3, 'two live frames');

    const live = stream.events().slice(1);
    expect(live.map((event) => event.id)).toEqual([`${TOPIC}:1`, `${TOPIC}:2`]);
    // `event:` is the transcript kind (technical/08: "from the domain/transcript catalogue").
    expect(live.map((event) => event.event)).toEqual(['steer', 'steer']);
    expect(JSON.parse(live[0]?.data ?? '{}')).toMatchObject({ frame: 'transcript', seq: 1 });

    await stream.disconnect();
  });

  it('sends `: ping` comments to keep the connection warm', async () => {
    // The harness runs the instance with APP_SSE_PING_INTERVAL_MS=1000.
    const stream = await openStream(`topics=${TOPIC}&connection_id=ping`);
    await stream.waitFor(() => stream.comments().includes('ping'), 'a ping comment');
    await stream.disconnect();
  });
});

describe('replay after reconnect (TD-014)', () => {
  it('delivers exactly the frames published while the client was away', async () => {
    const first = await openStream(`topics=${TOPIC}&connection_id=c1`);
    instance.runtime.hub.publish(frame(1, 'before'));
    await first.waitFor(() => first.events().length >= 2, 'the first frame');

    const lastEventId = first.events().at(-1)?.id;
    expect(lastEventId).toBe(`${TOPIC}:1`);

    // The tab goes away…
    await first.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // …and the world keeps moving.
    instance.runtime.hub.publish(frame(2, 'missed one'));
    instance.runtime.hub.publish(frame(3, 'missed two'));

    // The browser reconnects with the id of the last frame it saw.
    const second = await SseStream.open(
      `${instance.baseUrl}/events?topics=${TOPIC}&connection_id=c2`,
      { headers: client.headers({ 'last-event-id': lastEventId as string }) },
    );
    await second.waitFor(() => second.events().length >= 2, 'the replayed frames');

    const replayed = second.events();
    expect(replayed.map((event) => event.id)).toEqual([`${TOPIC}:2`, `${TOPIC}:3`]);
    // The frame the client already had is not sent again…
    expect(replayed.map((event) => JSON.parse(event.data).data.message)).toEqual([
      'missed one',
      'missed two',
    ]);
    // …and no `reset` was needed, because the cursor was inside the buffer.
    expect(replayed.map((event) => event.event)).not.toContain('reset');

    await second.disconnect();
  });

  it('accepts the cursor in the query string, which is all an EventSource can do', async () => {
    const first = await openStream(`topics=${TOPIC}&connection_id=q1`);
    instance.runtime.hub.publish(frame(10, 'seen'));
    await first.waitFor(() => first.events().length >= 2, 'the first frame');
    await first.disconnect();

    instance.runtime.hub.publish(frame(11, 'unseen'));

    const second = await openStream(
      `topics=${TOPIC}&connection_id=q2&last_event_id=${encodeURIComponent(`${TOPIC}:10`)}`,
    );
    await second.waitFor(() => second.events().length >= 1, 'the replayed frame');
    expect(second.events()[0]?.id).toBe(`${TOPIC}:11`);
    await second.disconnect();
  });

  it('answers `reset` when the cursor is outside the buffer', async () => {
    instance.runtime.hub.publish(frame(1, 'only'));

    const stream = await openStream(
      `topics=${TOPIC}&connection_id=r1&last_event_id=${encodeURIComponent(`${TOPIC}:999`)}`,
    );
    await stream.waitFor(() => stream.events().length >= 1, 'the reset frame');

    const reset = stream.events()[0];
    expect(reset?.event).toBe('reset');
    // A control frame must not carry an id: it would overwrite the client's cursor.
    expect(reset?.id).toBeNull();
    expect(JSON.parse(reset?.data ?? '{}')).toMatchObject({ frame: 'control', topic: TOPIC });

    await stream.disconnect();
  });
});

describe('POST /events/subscriptions', () => {
  it('adds a topic to an open stream and refuses somebody else’s connection id', async () => {
    const stream = await openStream('topics=org&connection_id=sub1');
    await stream.waitFor(() => stream.events().length >= 1, 'the opening frame');

    // Not subscribed yet, so this frame must not arrive.
    instance.runtime.hub.publish(frame(1, 'not yet'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stream.events()).toHaveLength(1);

    const added = await client.post<{ topics: string[] }>('/events/subscriptions', {
      connection_id: 'sub1',
      add: [TOPIC],
    });
    expect(added.status).toBe(200);
    expect(added.body.topics).toContain(TOPIC);

    instance.runtime.hub.publish(frame(2, 'now'));
    await stream.waitFor(() => stream.events().length >= 2, 'the frame on the new topic');
    expect(stream.events().at(-1)?.id).toBe(`${TOPIC}:2`);

    const unknown = await client.post<{ error: { code: string } }>('/events/subscriptions', {
      connection_id: 'someone-elses-connection',
      add: ['org'],
    });
    expect(unknown.status).toBe(404);

    await stream.disconnect();
  });
});

describe('graceful shutdown drains the stream (TD-002)', () => {
  it('sends `event: shutdown` and then ends the response', async () => {
    const stream = await openStream(`topics=${TOPIC}&connection_id=s1`);
    await stream.waitFor(() => stream.events().length >= 1, 'the opening frame');

    const stopped = instance.runtime.stop();
    await stream.waitFor(
      () => stream.events().some((event) => event.event === 'shutdown'),
      'the shutdown frame',
    );
    await stream.waitForEnd();
    await stopped;

    const shutdown = stream.events().find((event) => event.event === 'shutdown');
    expect(JSON.parse(shutdown?.data ?? '{}')).toEqual({ frame: 'control', type: 'shutdown' });
    // The frame is the *last* thing on the wire: the stream is drained, not cut.
    expect(stream.events().at(-1)?.event).toBe('shutdown');
    expect(stream.ended).toBe(true);

    // …and the instance stopped taking traffic before the socket closed.
    await instance.database.drop();
  });

  it('reports 503 from /readyz from the first instant of shutdown', async () => {
    const before = await client.request('/readyz');
    expect(before.status).toBe(200);

    // `stop()` sets the flag synchronously, before its first `await`, so a request that starts
    // after the call has been *made* — and before it has been awaited — must already see 503. That
    // ordering is what takes the instance out of a load balancer before its connections go, and it
    // is checked through `inject` rather than over the socket because a closing server stops
    // accepting new connections: over the wire the probe would fail to connect either way, and a
    // test that cannot tell 503 from "connection refused" cannot tell this behaviour from its
    // absence. Moving `shuttingDown = true` after `app.close()` fails here.
    const stopping = instance.runtime.stop();
    const during = await instance.runtime.app.inject({ method: 'GET', url: '/readyz' });
    expect(during.statusCode).toBe(503);
    expect(during.json()).toEqual({ status: 'down', checks: { shutdown: 'down' } });

    await stopping;
    await instance.database.drop();
  });
});
