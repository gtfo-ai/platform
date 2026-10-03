/**
 * **A ticket no rule matches, started from the board's form, reaches refinement** — product/04
 * S0's manual "Start" on a real `apps/server` instance (WP-122, PROGRESS backlog 379, criterion 2).
 *
 * The request is the one the board's form sends: the SPA's own endpoint function
 * (`apps/web/src/api/endpoints.ts`'s `startTask`) over the SPA's own HTTP client, given a `fetch`
 * that carries a signed-in member's session cookie — so the body, the CSRF header and the
 * `Idempotency-Key` are the client's, not this file's. Nothing is published: the fake tracker holds
 * a ticket with no label, and only the manual start can make it a task.
 *
 * The refinement scenario asks one blocking question, so the task **parks at refinement**
 * (`waiting_answers`) rather than walking on — the place the criterion names, held still for the
 * assertions. The wait binds the `tasks` row the assertions read (standing rule 87).
 */
import type { DomainEvent } from '@platform/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createEndpoints } from '../../../apps/web/src/api/endpoints.js';
import { ApiError, createApiClient } from '../../../apps/web/src/api/http.js';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { type PipelineE2E, startPipeline, TICKETS_INTEGRATION_ID } from '../support/pipeline.js';
import { askingScenarios } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const UNMATCHED = {
  key: 'ACME-31',
  title: 'Round the invoice total to the currency’s minor unit',
  issueType: 'Story',
  // No label and no status the binding picks up: no rule matches this ticket.
  labels: [],
};

/** A ticket of another tracker project, for the binding's declared scope (pre-review round). */
const OTHER_PROJECT = {
  key: 'OPS-4',
  title: 'Another team’s ticket',
  issueType: 'Story',
  labels: [],
};

const signIn = async (baseUrl: string, email: string, password: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', { email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const signInAs = async (
  admin: Client,
  baseUrl: string,
  role: 'viewer' | 'member',
): Promise<Client> => {
  const email = `${role}@example.test`;
  const password = `not-a-real-password-${role}-0000`;
  const created = await admin.post('/api/auth/admin/create-user', {
    email,
    password,
    name: role,
    role,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return signIn(baseUrl, email, password);
};

/** The SPA's endpoints, sending through a signed-in session — what the board's form calls. */
const spaEndpoints = (client: Client, keys: string[]) =>
  createEndpoints(
    createApiClient({
      // The SPA's headers, lower-cased so they replace the test client's own rather than being
      // sent beside them — `X-Requested-With` twice is one header with two values, which the CSRF
      // check rightly refuses.
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) =>
        client.request(String(input), {
          ...init,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        })) as typeof fetch,
      newIdempotencyKey: () => {
        const key = `manual-start-${keys.length + 1}`;
        keys.push(key);
        return key;
      },
    }),
  );

describe('the manual start (WP-122)', () => {
  it('starts a ticket no rule matches from the board’s request, and the task reaches refinement', async () => {
    const pipeline = await startPipeline({
      scenarios: askingScenarios(),
      label: 'manual-start',
      tickets: [UNMATCHED, OTHER_PROJECT],
    });
    harness = pipeline;
    const baseUrl = pipeline.instance.baseUrl;
    const admin = await signIn(baseUrl, BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const member = await signInAs(admin, baseUrl, 'member');
    const viewer = await signInAs(admin, baseUrl, 'viewer');
    const keys: string[] = [];
    const memberApi = spaEndpoints(member, keys);
    const viewerApi = spaEndpoints(viewer, []);

    // The board's read says who is offered the form, in both directions.
    expect((await memberApi.projectTasks(pipeline.projectId, {})).can_start_task).toBe(true);
    expect((await viewerApi.projectTasks(pipeline.projectId, {})).can_start_task).toBe(false);
    const refused = await viewerApi
      .startTask(pipeline.projectId, { ticket_key: UNMATCHED.key }, 'viewer-1')
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(403);

    const started = await memberApi.startTask(
      pipeline.projectId,
      { ticket_key: UNMATCHED.key },
      'start-acme-31',
    );
    expect(started.performed).toBe(true);
    expect(started.ticket.key).toBe(UNMATCHED.key);

    await pipeline.waitFor('the started ticket to park at refinement', async () => {
      const rows = await pipeline.query<{ state: string; current_stage: string | null }>(
        'select state, current_stage from tasks where ticket_key = $1',
        [UNMATCHED.key],
      );
      return rows[0]?.state === 'waiting_answers';
    });
    const [task] = await pipeline.query<{
      id: string;
      state: string;
      current_stage: string | null;
      template: string;
    }>('select id, state, current_stage, template from tasks where ticket_key = $1', [
      UNMATCHED.key,
    ]);
    expect(task?.current_stage).toBe('refinement');
    // Classified as a rule match is: a `Story` gets the feature template.
    expect(task?.template).toBe('feature');

    // The match is the one intake consumes, marked manual and attributed to the member.
    const matches = (await pipeline.events()).filter(
      (event): event is Extract<DomainEvent, { type: 'ticket.matched' }> =>
        event.type === 'ticket.matched',
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe(started.event_id);
    expect(matches[0]?.payload.rule).toBe('manual');
    expect(matches[0]?.actor.kind).toBe('user');

    // One audit row, written with the match, completing the key.
    const audit = await pipeline.query<{ action: string; params: Record<string, unknown> }>(
      "select action, params from human_actions where action = 'task.start'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.params).toMatchObject({
      project_id: pipeline.projectId,
      event_id: started.event_id,
      idempotency_key: 'start-acme-31',
    });

    // WP-134 (backlog 416, criterion 1): the task's own *Who did what* lists the person who
    // started it, though the row was written before the task existed and still has no task id.
    const adminApi = spaEndpoints(admin, []);
    const whoDidWhat = await adminApi.taskAudit(task?.id as string);
    const startRows = whoDidWhat.items.filter((row) => row.action === 'task.start');
    expect(startRows).toHaveLength(1);
    const [memberId] = await pipeline.query<{ id: string }>(
      "select id from users where email = 'member@example.test'",
    );
    expect(startRows[0]?.user_id).toBe(memberId?.id);
    expect(startRows[0]?.params).toMatchObject({ event_id: started.event_id });

    // A replay of the same intent performs nothing twice: no second match, no second row.
    const replayed = await memberApi.startTask(
      pipeline.projectId,
      { ticket_key: UNMATCHED.key },
      'start-acme-31',
    );
    expect(replayed).toEqual({ ...started, performed: false });
    // A new intent for the same ticket meets one task per ticket, typed.
    const again = await memberApi
      .startTask(pipeline.projectId, { ticket_key: UNMATCHED.key }, 'start-acme-31-again')
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((again as ApiError).status).toBe(409);
    expect((again as ApiError).code).toBe('ticket_has_task');
    // And a key the tracker does not know is a 404.
    const unknown = await memberApi
      .startTask(pipeline.projectId, { ticket_key: 'ACME-404' }, 'start-acme-404')
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((unknown as ApiError).status).toBe(404);
    expect((unknown as ApiError).code).toBe('ticket_not_found');

    // The binding's declared scope is not the pick-up rule (WP-122 pre-review round): with
    // `project_keys` set on the binding — as an operator sets it — a ticket of another tracker
    // project is refused by name, and one of a declared project is still admitted (above).
    await pipeline.query(
      `update bindings set config = config || '{"project_keys": ["ACME"]}'::jsonb
        where project_id = $1 and integration_id = $2`,
      [pipeline.projectId, TICKETS_INTEGRATION_ID],
    );
    const outside = await memberApi
      .startTask(pipeline.projectId, { ticket_key: OTHER_PROJECT.key }, 'start-ops-4')
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect((outside as ApiError).status).toBe(409);
    expect((outside as ApiError).code).toBe('ticket_outside_binding_scope');
    expect((outside as ApiError).message).toContain('ACME');
    expect((outside as ApiError).message).not.toContain(OTHER_PROJECT.title);
    expect(
      await pipeline.query('select 1 from tasks where ticket_key = $1', [OTHER_PROJECT.key]),
    ).toHaveLength(0);

    const after = await pipeline.query<{ n: string }>(
      "select count(*)::text as n from events where type = 'ticket.matched'",
    );
    expect(after[0]?.n).toBe('1');
    expect(
      await pipeline.query("select 1 from human_actions where action = 'task.start'"),
    ).toHaveLength(1);
  });
});
