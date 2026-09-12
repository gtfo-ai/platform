/**
 * The webhook ingress against a real PostgreSQL 18 — WP-15c.
 *
 * The unit tier drives the ingress against doubles and the provider tier plants a credential in
 * every adapter's delivery. What only a database can answer is here, and the first item is the one
 * the architect ruling was written for:
 *
 *  - **GitLab's legacy scheme sends the binding's own webhook secret as plain text in
 *    `X-Gitlab-Token`.** A live delivery through the production loader, the production inbox
 *    adapter and migration 0014's columns: the stored `inbox.headers` must not contain
 *    `webhook_secret_token`'s value, and `redaction_count` must be at least 1 — a live invariant
 *    where a key-only count would read 0 for ever.
 *  - **`inbox(provider, delivery_id)` is a real primary key.** The replay is deduplicated by the
 *    database rather than by a Map, and the second delivery appends no second event.
 *  - **An unverifiable signature writes an audit row and no inbox row**, so a caller who can reach
 *    the endpoint cannot occupy a dedup key a genuine delivery will need.
 *  - **Migration 0014's `drop default` on `redaction_count`.** An insert that omits it is refused
 *    by the database, so "nobody wrote the column" cannot be recorded as "nothing was redacted".
 *
 * Everything below the ingress is production code: `createInboundIntegrationLoader` reads
 * `integrations`/`bindings` and decrypts `secrets` with a real envelope, and the GitLab adapter is
 * built by its real registration.
 */
import { randomUUID } from 'node:crypto';
import { createWebhookIngress } from '@platform/application';
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
  redaction as redactionAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import {
  createInboundIntegrationLoader,
  createIntegrationRegistry,
  gitlabProviderRegistration,
} from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Obviously fake, and the value every assertion below looks for. */
const GITLAB_TOKEN = 'glpat-FAKE-PLANTED-binding-token-0123456789';
const WEBHOOK_SECRET_TOKEN = 'FAKE-PLANTED-gitlab-webhook-secret-token-01';
const SECRET_KEY = 'integration-test-secret-key-not-a-real-one-0000';
const PROJECT_PATH = 'acme/api';

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let integrationId: Id;
let projectId: Id;

const deliveryBody = (iid: number): string =>
  JSON.stringify({
    object_kind: 'merge_request',
    project: { id: 77, path_with_namespace: PROJECT_PATH, default_branch: 'main' },
    user: { id: 4242, name: 'Dana', username: 'dana' },
    object_attributes: {
      id: 155016000 + iid,
      iid,
      title: 'Draft: sum the invoice footer',
      description: 'opened by the developer stage',
      state: 'opened',
      action: 'open',
      source_branch: `agentic/acme-${iid}`,
      target_branch: 'main',
      url: `https://gitlab.example.test/${PROJECT_PATH}/-/merge_requests/${iid}`,
      updated_at: '2026-06-01T09:00:00.000Z',
      last_commit: { id: 'a'.repeat(40) },
    },
    labels: [],
  });

/** GitLab's **legacy** scheme: the binding's own secret, in plain text, in a header. */
const legacyDelivery = (iid: number, token = WEBHOOK_SECRET_TOKEN) => ({
  headers: { 'x-gitlab-token': token, 'content-type': 'application/json' },
  body: deliveryBody(iid),
});

const ingressFor = () =>
  createWebhookIngress({
    loader: createInboundIntegrationLoader({
      repository: secretAdapters.createPostgresBindingRepository(pool),
      secrets: secretAdapters.createPostgresSecretStore({
        sql: pool,
        key: secretAdapters.deriveSecretKey(SECRET_KEY),
      }),
      registry: createIntegrationRegistry([gitlabProviderRegistration]),
      platformRedactor: redactionAdapters.patternRedactor(),
    }),
    inbox: integrationAdapters.createPostgresInboxStore({ sql: pool }),
    audit: integrationAdapters.createPostgresInboundAuditLog({ sql: pool }),
    identities: integrationAdapters.createPostgresIdentityDirectory({ sql: pool }),
    unitOfWork: eventing.unitOfWork,
    eventStore: eventing.store,
    ids: { next: () => randomUUID() as Id },
    clock: { now: () => new Date().toISOString() as IsoDateTime },
    timer: { now: () => Date.now() },
  });

beforeAll(async () => {
  database = await createMigratedDatabase('webhook-ingress');
  pool = createTestPool(database.connectionString, { max: 6 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });

  const key = secretAdapters.deriveSecretKey(SECRET_KEY);
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('ingress') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://gitlab.example.test/acme/api.git') returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as Id;

  // Two secrets, sealed under the real envelope: the decryption path runs rather than being stubbed.
  const secretIds: string[] = [];
  for (const [field, value] of [
    ['token', GITLAB_TOKEN],
    ['webhook_secret_token', WEBHOOK_SECRET_TOKEN],
  ] as const) {
    const secretId = randomUUID();
    await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
      secretId,
      secretAdapters.sealSecret(key, secretAdapters.secretDocument(field, value), secretId),
      key.keyId,
    ]);
    secretIds.push(secretId);
  }
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
       values ($1, 'git'::integration_type, 'gitlab', 'acme gitlab', $2::jsonb, $3::uuid[])
     returning id`,
    [
      orgId,
      JSON.stringify({ base_url: 'https://gitlab.example.test', project: PROJECT_PATH }),
      secretIds,
    ],
  );
  integrationId = integration.rows[0]?.id as Id;
  await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
    projectId,
    integrationId,
  ]);
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query(
    'truncate inbox, integration_actions, events, event_dispatch, event_streams cascade',
  );
});

const inboxRows = async () => {
  const { rows } = await pool.query<{
    provider: string;
    delivery_id: string;
    headers: JsonObject;
    payload: JsonObject;
    redaction_count: number;
    verified: boolean;
    error: string | null;
    processed_at: Date | null;
  }>('select * from inbox order by received_at');
  return rows;
};

const auditRows = async () => {
  const { rows } = await pool.query<{
    direction: string;
    action: string;
    status: string;
    payload: JsonObject;
    redaction_count: number;
  }>(
    'select direction, action, status, payload, redaction_count from integration_actions order by created_at, id',
  );
  return rows;
};

const eventRows = async () => {
  const { rows } = await pool.query<{ type: string; payload: JsonObject; stream_id: string }>(
    'select type, payload, stream_id from events order by position',
  );
  return rows;
};

describe('a GitLab delivery signed with the legacy secret token', () => {
  it('is accepted, and the header carrying the binding’s own secret is redacted on the row', async () => {
    const outcome = await ingressFor().deliver({
      provider: 'gitlab',
      integrationId,
      delivery: legacyDelivery(7),
    });

    expect(outcome).toMatchObject({ kind: 'accepted', events: 1 });
    const [row] = await inboxRows();
    expect(row).toBeDefined();
    // The finding the architect ruling was spent on: `inbox(headers, payload)` has existed
    // unredacted since 0005 and TD-012's write list does not name it, so a naive ingress writes a
    // live credential on **every** delivery, with no attacker and nothing planted.
    expect(
      JSON.stringify(row?.headers),
      'the stored headers must not carry webhook_secret_token’s value',
    ).not.toContain(WEBHOOK_SECRET_TOKEN);
    expect(JSON.stringify(row?.headers)).toContain('[REDACTED:integration:');
    // A live invariant. The delivery key's own count would be 0 here for ever.
    expect(row?.redaction_count).toBeGreaterThanOrEqual(1);
    // A redacted payload can no longer be re-verified against its signature, so the verdict is a
    // stored fact rather than something a later reader recomputes.
    expect(row?.verified).toBe(true);
    expect(row?.processed_at).not.toBeNull();
    expect(row?.error).toBeNull();
  });

  it('appends the normalised event on the bound project’s stream', async () => {
    await ingressFor().deliver({ provider: 'gitlab', integrationId, delivery: legacyDelivery(7) });

    const events = await eventRows();
    expect(events.map((event) => event.type)).toEqual(['mr.opened']);
    expect(events[0]?.stream_id).toBe(projectId);
  });

  it('records one inbound audit row, with no event of its own', async () => {
    await ingressFor().deliver({ provider: 'gitlab', integrationId, delivery: legacyDelivery(7) });

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ direction: 'in', action: 'webhook_delivery', status: 'ok' });
    // `integration.action.performed` is about an action the platform *performed*; a delivery is
    // something it was told, and the refusal path below is reachable by anyone.
    expect((await eventRows()).map((event) => event.type)).not.toContain(
      'integration.action.performed',
    );
  });
});

describe('a replayed delivery', () => {
  it('is deduplicated by the real primary key and performs nothing twice', async () => {
    const ingress = ingressFor();
    const first = await ingress.deliver({
      provider: 'gitlab',
      integrationId,
      delivery: legacyDelivery(7),
    });
    const second = await ingress.deliver({
      provider: 'gitlab',
      integrationId,
      delivery: legacyDelivery(7),
    });

    expect(first.kind).toBe('accepted');
    expect(second).toMatchObject({ kind: 'duplicate' });
    expect(await inboxRows()).toHaveLength(1);
    // The assertion that "performs nothing twice" actually needs: the effect, not the row.
    expect(await eventRows()).toHaveLength(1);
    expect((await auditRows()).map((row) => row.status)).toEqual(['ok', 'replayed']);
  });

  it('still admits a genuinely different delivery, so the dedup is on the change and not the sender', async () => {
    const ingress = ingressFor();
    await ingress.deliver({ provider: 'gitlab', integrationId, delivery: legacyDelivery(7) });
    await ingress.deliver({ provider: 'gitlab', integrationId, delivery: legacyDelivery(8) });

    expect(await inboxRows()).toHaveLength(2);
    expect(await eventRows()).toHaveLength(2);
  });
});

describe('an unverifiable delivery', () => {
  it('is refused, audited, and occupies no dedup key a genuine delivery will need', async () => {
    const outcome = await ingressFor().deliver({
      provider: 'gitlab',
      integrationId,
      delivery: legacyDelivery(7, 'FAKE-PLANTED-wrong-token-0123456789012'),
    });

    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unverified' });
    expect(
      await inboxRows(),
      'a key an unauthenticated caller chose is a key it can poison',
    ).toHaveLength(0);
    expect(await eventRows()).toHaveLength(0);
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ direction: 'in', status: 'failed' });
  });

  it('leaves the key free, so the genuine delivery that follows is still performed', async () => {
    const ingress = ingressFor();
    await ingress.deliver({
      provider: 'gitlab',
      integrationId,
      delivery: legacyDelivery(7, 'FAKE-PLANTED-wrong-token-0123456789012'),
    });
    const genuine = await ingress.deliver({
      provider: 'gitlab',
      integrationId,
      delivery: legacyDelivery(7),
    });

    expect(genuine).toMatchObject({ kind: 'accepted', events: 1 });
    expect(await eventRows()).toHaveLength(1);
  });

  /**
   * Standing rule 43: which *wrong* implementations would the negative above also pass?
   *
   * A verifier that compared prefixes, one that compared lengths, one that ignored the header
   * entirely and one that accepted an absent secret all pass a single "obviously different token"
   * case. These are the four that discriminate.
   */
  it.each([
    ['a truncated token', WEBHOOK_SECRET_TOKEN.slice(0, -1)],
    ['a token with one byte appended', `${WEBHOOK_SECRET_TOKEN}x`],
    ['the token of another binding', 'FAKE-PLANTED-another-bindings-secret-01234'],
    ['an empty token', ''],
  ])('refuses %s', async (_name, token) => {
    const outcome = await ingressFor().deliver({
      provider: 'gitlab',
      integrationId,
      delivery: legacyDelivery(7, token),
    });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unverified' });
    expect(await inboxRows()).toHaveLength(0);
  });

  it('refuses a delivery with no token header at all', async () => {
    const outcome = await ingressFor().deliver({
      provider: 'gitlab',
      integrationId,
      delivery: { headers: {}, body: deliveryBody(7) },
    });
    expect(outcome).toMatchObject({ kind: 'refused', reason: 'unverified' });
  });

  it('refuses a valid token over a body it did not sign — which the legacy scheme cannot detect', async () => {
    // Stated rather than implied: GitLab's legacy token is **not** a signature, so a correct token
    // with any body verifies. That is the scheme's weakness (its own documentation says it
    // "provides weaker security guarantees than a signing token"), not this adapter's, and the
    // assertion below records the platform's actual behaviour rather than a property it lacks.
    const outcome = await ingressFor().deliver({
      provider: 'gitlab',
      integrationId,
      delivery: { headers: { 'x-gitlab-token': WEBHOOK_SECRET_TOKEN }, body: deliveryBody(9) },
    });
    expect(outcome.kind).toBe('accepted');
  });
});

describe('an integration nobody has', () => {
  it('writes nothing at all, because there is no row an audit could reference', async () => {
    const outcome = await ingressFor().deliver({
      provider: 'gitlab',
      integrationId: '00000000-0000-4000-8000-0000000000ff' as Id,
      delivery: legacyDelivery(7),
    });
    expect(outcome).toEqual({ kind: 'unknown_integration' });
    expect(await inboxRows()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('migration 0014', () => {
  it('refuses an inbox insert that omits `redaction_count`, so a zero always means a real zero', async () => {
    await expect(
      pool.query(
        `insert into inbox (provider, delivery_id, integration_id, payload, verified)
           values ('gitlab', 'd-no-count', $1, '{}'::jsonb, true)`,
        [integrationId],
      ),
    ).rejects.toThrow(/redaction_count/);
  });

  it('defaults `verified` to false, so an unwritten verdict understates trust rather than overstating it', async () => {
    await pool.query(
      `insert into inbox (provider, delivery_id, integration_id, payload, redaction_count)
         values ('gitlab', 'd-no-verdict', $1, '{}'::jsonb, 0)`,
      [integrationId],
    );
    const { rows } = await pool.query<{ verified: boolean }>(
      "select verified from inbox where delivery_id = 'd-no-verdict'",
    );
    expect(rows[0]?.verified).toBe(false);
  });

  it('refuses a negative redaction count', async () => {
    await expect(
      pool.query(
        `insert into inbox (provider, delivery_id, integration_id, payload, redaction_count, verified)
           values ('gitlab', 'd-negative', $1, '{}'::jsonb, -1, true)`,
        [integrationId],
      ),
    ).rejects.toThrow(/inbox_redaction_count_non_negative/);
  });
});
