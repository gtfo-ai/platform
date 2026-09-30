/**
 * **A credential sealed by `POST /api/integrations` is opened by the binding loader** (WP-96, PROGRESS
 * backlog 7 bullet 1).
 *
 * The two halves were each exercised and never joined: the wizard e2e creates a Sentry integration
 * through the route (which seals the token) and then only reads it back as a redaction assertion,
 * while every integration the pipeline actually calls is seeded by `seedWorld`, which seals with the
 * real envelope under the instance's `APP_SECRET_KEY` itself. So the route's envelope and the
 * loader's were never compared end to end — nothing known to be wrong, and nothing that would
 * notice if one side's key derivation or envelope version moved.
 *
 * This joins them with one provider call. The **production** Sentry registration is composed over a
 * recording transport (the far side of the HTTP call is the only double); the integration is created
 * through the route, bound through `PUT …/bindings`, and a bug ticket linking one of its issues walks
 * to the Investigator, whose pre-fetch builds the adapter through `createPipelineIntegrationsLoader`
 * — the rows, the decryption, the strict config parse and the redactor are production code. The
 * transport records the `Authorization` header it was sent: the route's value, opened by the loader.
 */
import type { Id } from '@platform/contracts';
import type { SentryFetch } from '@platform/integrations';
import { afterAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_INTEGRATION_ID,
  inboundEvent,
  type PipelineE2E,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { bugScenarios } from '../support/scenarios.js';

const TOKEN_ENV = 'WP96_SENTRY_TOKEN';
const TOKEN = 'FAKE-sentry-route-sealed-token-00';
const HOST = 'sentry.example.test';
const ISSUE_URL = `https://${HOST}/organizations/acme/issues/7/`;

let harness: PipelineE2E | undefined;
afterAll(async () => {
  await harness?.stop();
  harness = undefined;
  delete process.env[TOKEN_ENV];
});

describe('a credential the route sealed, opened by the binding loader (backlog 7)', () => {
  it('reaches the provider as the bearer the route was given', async () => {
    const requests: { url: string; authorization: string | undefined }[] = [];
    const transport: SentryFetch = async (url, init) => {
      requests.push({
        url,
        authorization: init.headers.authorization ?? init.headers.Authorization,
      });
      // No issue: the pre-fetch states an unreadable excerpt and the walk goes on. What is under
      // test is the request, not the answer.
      return new Response(JSON.stringify({ detail: 'The requested resource does not exist' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    };
    const pipeline = await startPipeline({
      label: 'route-sealed',
      scenarios: bugScenarios,
      tickets: [
        {
          key: 'ACME-9',
          title: 'The invoice footer sums the wrong rows',
          issueType: 'Bug',
          description: `Customers see the wrong total. Sentry: ${ISSUE_URL}`,
        },
      ],
      env: { APP_INTEGRATION_SECRET_ENV: TOKEN_ENV, APP_INTEGRATION_HOSTS: HOST },
      sentry: { fetch: transport },
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
        config: { organization: 'acme', base_url: `https://${HOST}` },
        secret_refs: { auth_token: TOKEN_ENV },
      },
      'wp96-route-sealed',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bound = await send(`/api/projects/${pipeline.projectId}/bindings`, 'PUT', {
      items: [
        { integration_id: GIT_INTEGRATION_ID },
        { integration_id: TICKETS_INTEGRATION_ID },
        { integration_id: created.body.id },
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

    // The one provider call, with the bearer the route read out of the environment and sealed.
    const issueReads = requests.filter((request) =>
      request.url.startsWith(`https://${HOST}/api/0/organizations/acme/issues/7/`),
    );
    expect(issueReads.length, JSON.stringify(requests)).toBeGreaterThan(0);
    expect(issueReads.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // …audited to the integration the route created, which is the binding the loader built.
    const audited = await pipeline.query<{ integration_id: string }>(
      `select integration_id::text from integration_actions where action = 'get_issue'`,
    );
    expect(audited).toEqual([{ integration_id: created.body.id }]);
  });
});
