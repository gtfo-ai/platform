/**
 * **WP-123 criterion 3 (PROGRESS backlog 378): the real Sentry `resolve`, through the
 * `resolve_on_merge` duty.** WP-111's e2e drives the errors **fake**, which resolves any seeded
 * issue; the Sentry replay runs only the port suite. Nothing joined the four things this file joins:
 * the production loader's overlay of `bindings.config.resolve_on_merge` onto Sentry's strict schema,
 * `linkedIssues` parsing a real Sentry URL out of the stored ticket snapshot, the issue id the
 * idempotency key `resolve_on_merge:<task>:<issue>` is built from, and Sentry's error mapping, which
 * the duty reads to choose between "log and go on" (`not_found`) and "fail the job" (`rate_limited`).
 *
 * Shaped like WP-96's `test/e2e/onboarding/route-sealed-credential.e2e.test.ts`: the **production**
 * Sentry registration over a stub `SentryFetch` on a `*.example.test` host (the far side of the HTTP
 * call is the only double), the integration created through `POST /api/integrations` and bound
 * through `PUT …/bindings` with `resolve_on_merge: true` on the **binding** row, and a bug task whose
 * ticket links two issues walked to `done` by one merge.
 *
 * Every wait binds the `resolve_on_merge` duty's `pgboss.job` row (rule 87): a job reaches
 * `completed` (or `retry`) after every resolve it made was audited, so the rows and the stub's
 * record are read after the duty, never beside it. The 429 case nudges the retry's `start_after`
 * rather than waiting the queue's thirty-second backoff.
 */
import { readFileSync } from 'node:fs';
import type { Id } from '@platform/contracts';
import type { SentryFetch } from '@platform/integrations';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_INTEGRATION_ID,
  GIT_PROJECT,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { bugScenarios } from '../support/scenarios.js';

const TOKEN_ENV = 'WP123_SENTRY_TOKEN';
/** Obviously fake, and shaped past any Sentry token pattern (rule 93). */
const TOKEN = 'FAKE-sentry-resolve-on-merge-token-00';
const HOST = 'sentry.example.test';
const ORG = 'acme';
const ISSUE_PATH = (id: string) => `/api/0/organizations/${ORG}/issues/${id}/`;
const issueUrl = (id: string) => `https://${HOST}/organizations/${ORG}/issues/${id}/`;

/**
 * The documented "Retrieve an Issue" example the Sentry corpus already carries
 * (`test/fixtures/http/sentry/issues.json`, `documented-adapted`), re-pointed at this file's issue.
 */
const DOCUMENTED_ISSUE = (
  JSON.parse(
    readFileSync(new URL('../../fixtures/http/sentry/issues.json', import.meta.url), 'utf8'),
  ) as { interactions: { body: Record<string, unknown> }[] }
).interactions[0]?.body as Record<string, unknown>;

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** The stub's script for one issue's `PUT`: a status per call, the last one repeating. */
type PutScript = readonly number[];

const sentryStub = (scripts: Readonly<Record<string, PutScript>>) => {
  const requests: Recorded[] = [];
  const resolved = new Set<string>();
  const puts = new Map<string, number>();
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(body === null ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  const fetch: SentryFetch = async (url, init) => {
    const parsed = new URL(url);
    const body = init.body === undefined ? null : (JSON.parse(init.body) as unknown);
    requests.push({ method: init.method, path: parsed.pathname, body });
    const issue = /^\/api\/0\/organizations\/acme\/issues\/(\d+)\/$/.exec(parsed.pathname)?.[1];
    if (issue === undefined) {
      // The pre-fetch's latest-event read and anything else: Sentry's documented 404.
      return json(404, { detail: 'The requested resource does not exist' });
    }
    if (init.method === 'PUT') {
      const call = puts.get(issue) ?? 0;
      puts.set(issue, call + 1);
      const script = scripts[issue] ?? [200];
      const status = script[Math.min(call, script.length - 1)] ?? 200;
      if (status === 429) {
        return json(429, { detail: 'Request was throttled.' }, { 'retry-after': '0' });
      }
      if (status !== 200) {
        return json(status, { detail: 'The requested resource does not exist' });
      }
      resolved.add(issue);
      // Divergence 4: the documented PUT publishes no response body the adapter reads.
      return json(200, { status: 'resolved', statusDetails: {} });
    }
    return json(200, {
      ...DOCUMENTED_ISSUE,
      id: issue,
      permalink: issueUrl(issue),
      status: resolved.has(issue) ? 'resolved' : 'unresolved',
    });
  };
  return { fetch, requests };
};

let harness: PipelineE2E | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
  delete process.env[TOKEN_ENV];
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
    merge_commit_sha: 'c'.repeat(40),
  });

/** The duty's jobs in `state`, counted — the last row the duty writes (rule 87). */
const duties = async (pipeline: PipelineE2E, state: string): Promise<number> => {
  const rows = await pipeline.query<{ n: string }>(
    `select count(*)::text as n from pgboss.job
      where name = 'pipeline.outbound' and state = $1 and data->>'duty' = 'resolve_on_merge'`,
    [state],
  );
  return Number(rows[0]?.n);
};

const resolveRows = (pipeline: PipelineE2E) =>
  pipeline.query<{ status: string; issue_id: string; integration_id: string }>(
    `select status, payload->>'issue_id' as issue_id, integration_id::text
       from integration_actions where action = 'resolve_issue'
      order by created_at, id`,
  );

/**
 * A Sentry account created through the route, bound with `resolve_on_merge` on the binding row, and
 * a bug ticket linking issues 7 and 8 walked to Ready.
 */
const bugAtReady = async (
  stub: ReturnType<typeof sentryStub>,
): Promise<{ pipeline: PipelineE2E; sentryId: Id }> => {
  const pipeline = await startPipeline({
    label: 'resolve-on-merge-sentry',
    scenarios: bugScenarios,
    tickets: [
      {
        key: 'ACME-9',
        title: 'The invoice footer sums the wrong rows',
        issueType: 'Bug',
        description: `Customers see the wrong total. Sentry: ${issueUrl('7')} and ${issueUrl('8')}`,
      },
    ],
    env: { APP_INTEGRATION_SECRET_ENV: TOKEN_ENV, APP_INTEGRATION_HOSTS: HOST },
    sentry: { fetch: stub.fetch },
  });
  harness = pipeline;
  process.env[TOKEN_ENV] = TOKEN;

  const client = new Client(pipeline.instance.baseUrl);
  const signedIn = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
  const send = <T>(path: string, method: 'POST' | 'PUT', body: unknown, key?: string) =>
    client.json<T>(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    });
  const created = await send<{ id: Id }>(
    '/api/integrations',
    'POST',
    {
      type: 'errors',
      provider: 'sentry',
      name: 'acme sentry',
      config: { organization: ORG, base_url: `https://${HOST}` },
      secret_refs: { auth_token: TOKEN_ENV },
    },
    'wp123-resolve-on-merge',
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bound = await send(`/api/projects/${pipeline.projectId}/bindings`, 'PUT', {
    items: [
      { integration_id: GIT_INTEGRATION_ID },
      { integration_id: TICKETS_INTEGRATION_ID },
      // On the **binding**, as an operator sets it: the account carries nothing.
      { integration_id: created.body.id, config: { resolve_on_merge: true } },
    ],
  });
  expect(bound.status, JSON.stringify(bound.body)).toBe(200);

  await pipeline.publish([
    inboundEvent('ticket.matched', {
      project_id: pipeline.projectId,
      ticket: {
        provider: 'fake-task-management',
        key: 'ACME-9',
        url: 'https://tickets.example.test/browse/ACME-9',
      },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Bug',
      epic: null,
      links: [],
    }),
  ]);
  await pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');
  return { pipeline, sentryId: created.body.id };
};

/** The requests the duty made: from the first `PUT` on, every `PUT` and the `GET` after each. */
const resolveTraffic = (requests: readonly Recorded[]) => {
  const first = requests.findIndex((request) => request.method === 'PUT');
  return first === -1 ? [] : requests.slice(first);
};

describe('resolve on merge through the production Sentry registration (WP-123, backlog 378)', () => {
  it('resolves both linked issues with one PUT and one re-read each, and a second merge replays both', async () => {
    const stub = sentryStub({});
    const { pipeline, sentryId } = await bugAtReady(stub);

    await pipeline.publish([merged(pipeline)]);
    await pipeline.settle('done', (task) => task.state === 'done');
    await pipeline.waitFor('the resolve_on_merge duty completed', async () => {
      return (await duties(pipeline, 'completed')) >= 1;
    });

    const traffic = resolveTraffic(stub.requests);
    expect(traffic.map((request) => `${request.method} ${request.path}`)).toEqual([
      `PUT ${ISSUE_PATH('7')}`,
      `GET ${ISSUE_PATH('7')}`,
      `PUT ${ISSUE_PATH('8')}`,
      `GET ${ISSUE_PATH('8')}`,
    ]);
    // `status: "resolved"` and **no** `statusDetails`: the platform does not know which release
    // carries the merge (WP-111), so it resolves plainly.
    for (const put of traffic.filter((request) => request.method === 'PUT')) {
      expect(put.body).toEqual({ status: 'resolved' });
    }
    expect(await resolveRows(pipeline)).toEqual([
      { status: 'ok', issue_id: '7', integration_id: sentryId },
      { status: 'ok', issue_id: '8', integration_id: sentryId },
    ]);

    // A second `mr.merged` for the same task: the idempotency key is the task and the issue id
    // `linkedIssues` parsed, so both resolves are replayed and Sentry is asked nothing more.
    const before = stub.requests.length;
    await pipeline.publish([merged(pipeline)]);
    await pipeline.waitFor('the second resolve_on_merge duty completed', async () => {
      return (await duties(pipeline, 'completed')) >= 2;
    });
    expect((await resolveRows(pipeline)).map((row) => `${row.issue_id}:${row.status}`)).toEqual([
      '7:ok',
      '8:ok',
      '7:replayed',
      '8:replayed',
    ]);
    expect(stub.requests.slice(before)).toEqual([]);
  });

  it('leaves the other issue resolved and a failed row when Sentry answers 404 for one', async () => {
    const stub = sentryStub({ '7': [404] });
    const { pipeline } = await bugAtReady(stub);

    await pipeline.publish([merged(pipeline)]);
    await pipeline.waitFor('the resolve_on_merge duty completed', async () => {
      return (await duties(pipeline, 'completed')) >= 1;
    });

    expect((await resolveRows(pipeline)).map((row) => `${row.issue_id}:${row.status}`)).toEqual([
      '7:failed',
      '8:ok',
    ]);
    // `not_found` is a refusal Sentry will repeat: logged, recorded, and never a retry.
    expect(await duties(pipeline, 'retry')).toBe(0);
    expect(
      resolveTraffic(stub.requests).filter(
        (request) => request.method === 'PUT' && request.path === ISSUE_PATH('7'),
      ),
    ).toHaveLength(1);
  });

  it('fails the job on a 429 after the other issue is resolved, and its retry replays that success', async () => {
    // Every attempt of the executor's three on issue 8 is throttled (`Retry-After: 0`), then the
    // retry of the job is answered.
    const stub = sentryStub({ '8': [429, 429, 429, 200] });
    const { pipeline } = await bugAtReady(stub);

    await pipeline.publish([merged(pipeline)]);
    await pipeline.waitFor('the resolve_on_merge duty failed once and waits to retry', async () => {
      return (await duties(pipeline, 'retry')) >= 1;
    });
    expect((await resolveRows(pipeline)).map((row) => `${row.issue_id}:${row.status}`)).toEqual([
      '7:ok',
      '8:failed',
    ]);
    const putsOf = (id: string) =>
      stub.requests.filter(
        (request) => request.method === 'PUT' && request.path === ISSUE_PATH(id),
      );
    expect(putsOf('7')).toHaveLength(1);
    expect(putsOf('8')).toHaveLength(3);

    await pipeline.waitFor('the retried resolve_on_merge duty completed', async () => {
      await pipeline.query(
        `update pgboss.job set start_after = now()
          where name = 'pipeline.outbound' and state = 'retry' and data->>'duty' = 'resolve_on_merge'`,
      );
      return (await duties(pipeline, 'completed')) >= 1;
    });
    expect((await resolveRows(pipeline)).map((row) => `${row.issue_id}:${row.status}`)).toEqual([
      '7:ok',
      '8:failed',
      '7:replayed',
      '8:ok',
    ]);
    // The replay asked Sentry nothing for issue 7; issue 8 got its fourth PUT and its re-read.
    expect(putsOf('7')).toHaveLength(1);
    expect(putsOf('8')).toHaveLength(4);
  });
});
