/**
 * **An integration is re-sealed and retired through the real router** (WP-114, PROGRESS backlog
 * 331).
 *
 * A whole `apps/server` instance, signed in as the bootstrap administrator, with the **production**
 * Sentry registration composed over a recording transport (WP-96's seam) — so the connection test
 * after a re-seal builds the adapter through the binding loader from the rows the route wrote, and
 * the transport records the bearer it was sent: the proof the new value is the one in use.
 *
 * Re-seal: an anonymous caller is 401, a maintainer 403, a name off `APP_INTEGRATION_SECRET_ENV`
 * 403 `secret_name_not_permitted`, a missing key 400; the re-seal answers 200, a replay under its key
 * `performed: false` with nothing sealed again, and the probe then sends the new token.
 *
 * Retire: refused `integration_bound` while a project binds it and
 * `integration_has_live_credential` while a minted credential of it is unexpired and unconfirmed,
 * then 200 — the `secrets` rows gone, the audit rows still naming the integration, `GET
 * /api/integrations` marking it retired, and a bindings `PUT` naming it refused.
 */
import type { Id } from '@platform/contracts';
import type { SentryFetch } from '@platform/integrations';
import { afterAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_INTEGRATION_ID,
  type PipelineE2E,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { bugScenarios } from '../support/scenarios.js';

const OLD_ENV = 'WP114_SENTRY_TOKEN_OLD';
const NEW_ENV = 'WP114_SENTRY_TOKEN_NEW';
/** Obviously fake (BD-002); Sentry's real tokens start `sntrys_`, these do not (rule 93). */
const OLD_TOKEN = 'FAKE-wp114-sentry-token-before-rotation';
const NEW_TOKEN = 'FAKE-wp114-sentry-token-after-rotation-';
const HOST = 'sentry.example.test';
const MAINTAINER_PASSWORD = 'not-a-real-password-wp114-0000';

let harness: PipelineE2E | undefined;
afterAll(async () => {
  await harness?.stop();
  harness = undefined;
  delete process.env[OLD_ENV];
  delete process.env[NEW_ENV];
});

interface Answer<T> {
  readonly status: number;
  readonly body: T & { readonly error?: { readonly code: string; readonly message: string } };
}

describe('re-sealing and retiring an integration over HTTP (WP-114)', () => {
  it('re-seals under the allow-list with a replay, probes with the new value, and retires', async () => {
    const authorizations: (string | undefined)[] = [];
    const transport: SentryFetch = async (_url, init) => {
      authorizations.push(init.headers.authorization ?? init.headers.Authorization);
      return new Response(JSON.stringify({ slug: 'acme', name: 'ACME' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const pipeline = await startPipeline({
      label: 'integration-lifecycle',
      scenarios: bugScenarios,
      env: {
        APP_INTEGRATION_SECRET_ENV: `${OLD_ENV},${NEW_ENV}`,
        APP_INTEGRATION_HOSTS: HOST,
      },
      sentry: { fetch: transport },
    });
    harness = pipeline;
    process.env[OLD_ENV] = OLD_TOKEN;
    process.env[NEW_ENV] = NEW_TOKEN;

    const admin = new Client(pipeline.instance.baseUrl);
    const signedIn = await admin.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    const send = <T>(
      client: Client,
      path: string,
      method: 'POST' | 'PUT' | 'DELETE',
      body: unknown,
      key?: string,
    ): Promise<Answer<T>> =>
      client.json<T>(path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify(body),
      }) as Promise<Answer<T>>;

    const created = await send<{ id: Id }>(
      admin,
      '/api/integrations',
      'POST',
      {
        type: 'errors',
        provider: 'sentry',
        name: 'acme sentry wp114',
        config: { organization: 'acme', base_url: `https://${HOST}` },
        secret_refs: { auth_token: OLD_ENV },
      },
      'wp114-create',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id;
    const secretsPath = `/api/integrations/${id}/secrets`;
    const sealedIds = async (): Promise<string[]> =>
      (
        await pipeline.query<{ secret_ids: string[] }>(
          'select secret_ids::text[] as secret_ids from integrations where id = $1',
          [id],
        )
      )[0]?.secret_ids ?? [];
    const before = await sealedIds();
    expect(before).toHaveLength(1);

    // ── re-seal: who may, and which names ─────────────────────────────────────────────────
    const anonymous = new Client(pipeline.instance.baseUrl);
    expect(
      (await send(anonymous, secretsPath, 'POST', { secret_refs: { auth_token: NEW_ENV } }, 'k1'))
        .status,
    ).toBe(401);
    const maintainerCreated = await admin.post('/api/auth/admin/create-user', {
      email: 'maintainer-wp114@example.test',
      password: MAINTAINER_PASSWORD,
      name: 'maintainer',
      role: 'maintainer',
    });
    expect(maintainerCreated.status, JSON.stringify(maintainerCreated.body)).toBe(200);
    const maintainer = new Client(pipeline.instance.baseUrl);
    expect(
      (
        await maintainer.post('/api/auth/sign-in/email', {
          email: 'maintainer-wp114@example.test',
          password: MAINTAINER_PASSWORD,
        })
      ).status,
    ).toBe(200);
    expect(
      (await send(maintainer, secretsPath, 'POST', { secret_refs: { auth_token: NEW_ENV } }, 'k2'))
        .status,
    ).toBe(403);
    const offList = await send(
      admin,
      secretsPath,
      'POST',
      { secret_refs: { auth_token: 'APP_SECRET_KEY' } },
      'wp114-off-list',
    );
    expect(offList.status).toBe(403);
    expect(offList.body.error?.code).toBe('secret_name_not_permitted');
    const unkeyed = await send(admin, secretsPath, 'POST', {
      secret_refs: { auth_token: NEW_ENV },
    });
    expect(unkeyed.status).toBe(400);
    expect(unkeyed.body.error?.code).toBe('idempotency_key_required');
    expect(await sealedIds()).toEqual(before);

    // ── re-seal, then a replay, then a different body under the used key ──────────────────
    const resealed = await send<{ performed: boolean; sealed_fields: string[] }>(
      admin,
      secretsPath,
      'POST',
      { secret_refs: { auth_token: NEW_ENV } },
      'wp114-reseal',
    );
    expect(resealed.status, JSON.stringify(resealed.body)).toBe(200);
    expect(resealed.body).toMatchObject({ performed: true, sealed_fields: ['auth_token'] });
    const after = await sealedIds();
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
    const replay = await send<{ performed: boolean }>(
      admin,
      secretsPath,
      'POST',
      { secret_refs: { auth_token: NEW_ENV } },
      'wp114-reseal',
    );
    expect(replay.status).toBe(200);
    expect(replay.body.performed).toBe(false);
    expect(await sealedIds()).toEqual(after);
    const reused = await send(
      admin,
      secretsPath,
      'POST',
      { secret_refs: { auth_token: OLD_ENV } },
      'wp114-reseal',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error?.code).toBe('idempotency_key_reused');
    expect(
      await pipeline.query(
        "select 1 from human_actions where action = 'integration.secrets.write'",
      ),
    ).toHaveLength(1);
    // The old sealed row is gone from the database, not only from the integration.
    expect(
      await pipeline.query('select 1 from secrets where id = any($1::uuid[])', [before]),
    ).toHaveLength(0);

    // ── the probe now sends the new value ─────────────────────────────────────────────────
    const probe = await send<{ ok: boolean }>(admin, `/api/integrations/${id}/test`, 'POST', {});
    expect(probe.status, JSON.stringify(probe.body)).toBe(200);
    expect(probe.body.ok).toBe(true);
    expect(authorizations).toEqual([`Bearer ${NEW_TOKEN}`]);

    // ── retire: refused while bound ───────────────────────────────────────────────────────
    const bindingsPath = `/api/projects/${pipeline.projectId}/bindings`;
    const pipelineBindings = [
      { integration_id: GIT_INTEGRATION_ID },
      { integration_id: TICKETS_INTEGRATION_ID },
    ];
    expect(
      (
        await send(admin, bindingsPath, 'PUT', {
          items: [...pipelineBindings, { integration_id: id }],
        })
      ).status,
    ).toBe(200);
    const integrationPath = `/api/integrations/${id}`;
    const bound = await send(admin, integrationPath, 'DELETE', {});
    expect(bound.status).toBe(409);
    expect(bound.body.error?.code).toBe('integration_bound');
    expect(
      (await send(anonymous, integrationPath, 'DELETE', {})).status,
      'an anonymous retire',
    ).toBe(401);
    expect((await send(maintainer, integrationPath, 'DELETE', {})).status).toBe(403);
    expect((await send(admin, bindingsPath, 'PUT', { items: pipelineBindings })).status).toBe(200);

    // ── refused while a minted credential of it is live ──────────────────────────────────
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await pipeline.query(
      `insert into integration_actions
         (integration_id, direction, action, payload, result, status, attempts, redaction_count)
       values ($1, 'out', 'mint_credential', '{}'::jsonb, $2::jsonb, 'ok', 1, 0)`,
      [id, JSON.stringify({ revoke_id: 'acme#7', expires_at: tomorrow })],
    );
    const live = await send(admin, integrationPath, 'DELETE', {});
    expect(live.status).toBe(409);
    expect(live.body.error?.code).toBe('integration_has_live_credential');
    await pipeline.query(
      `insert into integration_actions
         (integration_id, direction, action, payload, result, status, attempts, redaction_count)
       values ($1, 'out', 'revoke_credential', $2::jsonb, '{"revoked": true}'::jsonb, 'ok', 1, 0)`,
      [id, JSON.stringify({ revoke_id: 'acme#7' })],
    );

    // ── retired ───────────────────────────────────────────────────────────────────────────
    const retired = await send<{
      performed: boolean;
      destroyed_secrets: number;
      integration: { retired_at: string | null };
    }>(admin, integrationPath, 'DELETE', {});
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body).toMatchObject({ performed: true, destroyed_secrets: 1 });
    expect(retired.body.integration.retired_at).not.toBeNull();
    expect(
      await pipeline.query('select 1 from secrets where id = any($1::uuid[])', [after]),
    ).toHaveLength(0);
    // Every audit row of it still names it: the row is kept for exactly that (the probe, the mint
    // and the revoke).
    expect(
      await pipeline.query<{ actions: number; named: number }>(
        `select count(*)::int as actions, count(i.id)::int as named
           from integration_actions a left join integrations i on i.id = a.integration_id
          where a.integration_id = $1`,
        [id],
      ),
    ).toEqual([{ actions: 3, named: 3 }]);
    const again = await send<{ performed: boolean }>(admin, integrationPath, 'DELETE', {});
    expect(again.status).toBe(200);
    expect(again.body.performed).toBe(false);

    // ── listed as retired, and refuses every write ────────────────────────────────────────
    const listed = await admin.json<{ items: { id: string; retired_at: string | null }[] }>(
      '/api/integrations',
    );
    expect(listed.body.items.find((item) => item.id === id)?.retired_at).not.toBeNull();
    const rebind = await send(admin, bindingsPath, 'PUT', {
      items: [...pipelineBindings, { integration_id: id }],
    });
    expect(rebind.status).toBe(409);
    expect(rebind.body.error?.code).toBe('integration_retired');
    const reprobe = await send(admin, `/api/integrations/${id}/test`, 'POST', {});
    expect(reprobe.status).toBe(409);
    expect(reprobe.body.error?.code).toBe('integration_retired');
    const resealRetired = await send(
      admin,
      secretsPath,
      'POST',
      { secret_refs: { auth_token: NEW_ENV } },
      'wp114-after-retire',
    );
    expect(resealRetired.status).toBe(409);
    expect(resealRetired.body.error?.code).toBe('integration_retired');
    expect(authorizations).toHaveLength(1);
  });
});
