/**
 * **A row the write check never saw, refused at the call** — WP-51's criterion 2, second half
 * (PROGRESS backlog 48; technical/10 integration tier).
 *
 * `POST /api/integrations` refuses a host nobody declared, and that refusal is worth exactly as
 * much as the set of rows it saw. `integrations.config` outlives the list that admitted it: a row
 * inserted before `APP_INTEGRATION_HOSTS` existed, a list an operator narrowed afterwards, a row
 * written with `psql`, or a future `PATCH /api/integrations/:id` all produce a binding the write
 * check never judged. So the same question is asked again inside `IntegrationActionExecutor`, and
 * this file is where that is shown against a real database rather than against a hand-built ref.
 *
 * Everything here is production composition except the network: a real `integrations` row, the real
 * `PostgresBindingRepository` and `PostgresSecretStore`, the real GitLab registration through the
 * pipeline's own registry, the real prober (the path `POST /api/integrations/:id/test` takes) and
 * the real `PostgresIntegrationAuditLog`. The GitLab adapter is given a `fetch` that **records and
 * refuses**, so "did anything reach the network" is a count rather than an inference — and the
 * count is the assertion that matters: a refusal that happened after the credential left the
 * process would be no refusal at all.
 *
 * The three negatives are rule 43's: `evil.example.com` is refused by any implementation and proves
 * nothing, while `evil-gitlab.example.com` and `gitlab.example.com.evil.test` separate exact
 * matching from substring matching — the same three `renderEgressConfig`'s pattern tests use for
 * the run container's sidecar.
 */
import { randomUUID } from 'node:crypto';
import {
  createIntegrationActionExecutor,
  createIntegrationEgressPolicy,
  createVirtualTimer,
  IntegrationEgressRefusedError,
  noSecretsRedactor,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import {
  eventing as eventingAdapters,
  integrations as integrationAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import {
  createGitLabProvider,
  createIntegrationProber,
  createIntegrationRegistry,
  gitlabConfigSchema,
  gitlabProviderRegistration,
} from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Obviously fake (BD-002), and long enough to clear `MIN_SECRET_LENGTH`. */
const TOKEN = 'glpat-FAKE-egress-binding-token-0123456789';
const KEY = secretAdapters.deriveSecretKey('not-a-real-app-secret-key-000000000000');
const DECLARED = 'gitlab.example.com';

let database: MigratedDatabase;
let pool: pg.Pool;
let eventing: ReturnType<typeof eventingAdapters.createEventing>;
let orgId: string;

/** Every URL the adapter's client was asked for. Nothing is ever answered. */
let attempted: string[];

beforeAll(async () => {
  database = await createMigratedDatabase('egress');
  pool = createTestPool(database.connectionString, { max: 4 });
  eventing = eventingAdapters.createEventing({
    pool,
    connectionString: database.connectionString,
    config: { maxConcurrency: 1 },
  });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('egress') returning id",
  );
  orgId = org.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await eventing?.stop();
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  attempted = [];
  await pool.query('truncate integration_actions, events, event_dispatch, event_streams cascade');
  await pool.query('delete from bindings');
  await pool.query('delete from integrations');
});

/** Writes the row straight to the table — which is exactly the case this file is about. */
const insertIntegration = async (baseUrl: string): Promise<Id> => {
  const secretId = randomUUID();
  await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    secretId,
    secretAdapters.sealSecret(KEY, secretAdapters.secretDocument('token', TOKEN), secretId),
    KEY.keyId,
  ]);
  const { rows } = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
       values ($1, 'git'::integration_type, 'gitlab', 'acme gitlab', $2::jsonb, $3::uuid[])
     returning id`,
    [orgId, JSON.stringify({ base_url: baseUrl, project: 'acme/api' }), [secretId]],
  );
  return rows[0]?.id as Id;
};

/**
 * The prober, composed the way `apps/server` composes it, with the operator's list as a parameter.
 *
 * The GitLab registration is built with a `fetch` that records and throws: a probe that got past
 * the guard must be *visible* as a recorded URL, not merely as a different exception.
 */
const proberFor = (hosts: readonly string[]) =>
  createIntegrationProber({
    repository: secretAdapters.createPostgresBindingRepository(pool),
    secrets: secretAdapters.createPostgresSecretStore({ sql: pool, key: KEY }),
    registry: createIntegrationRegistry([
      {
        // The shipped registration with **one** thing replaced: the fetch. Everything the guard
        // could plausibly be circumvented by — the config parse, the redactor, the ref — is the
        // real one; only the socket is not.
        ...gitlabProviderRegistration,
        create: (input) =>
          createGitLabProvider({
            integrationId: input.integrationId,
            config: gitlabConfigSchema.parse(input.config),
            secrets: input.secrets,
            redactor: input.redactor,
            clock: { now: () => new Date().toISOString() as never },
            fetchImpl: (url) => {
              attempted.push(String(url));
              throw new Error('the network is not available to this test');
            },
          }),
      },
    ]),
    executor: createIntegrationActionExecutor({
      auditLog: integrationAdapters.createPostgresIntegrationAuditLog({
        unitOfWork: eventing.unitOfWork,
        eventStore: eventing.store,
        ids: { next: () => randomUUID() as Id },
      }),
      egress: createIntegrationEgressPolicy(hosts),
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => new Date().toISOString() as never },
      rateLimits: { capacity: 10, refillPerSecond: 10, maxConcurrent: 2 },
    }),
  });

const auditRowCount = async (): Promise<number> => {
  const { rows } = await pool.query<{ count: string }>('select count(*) from integration_actions');
  return Number(rows[0]?.count ?? '-1');
};

describe('the call-time egress allow-list, against a real integrations row', () => {
  it.each([
    ['a hyphen-prefixed neighbour', 'evil-gitlab.example.com'],
    ['a suffixed neighbour', 'gitlab.example.com.evil.test'],
    ['an unrelated host', 'evil.example.com'],
  ])(
    'refuses a row pointing at %s, reaches no network and writes no audit row',
    async (_name, host) => {
      const integrationId = await insertIntegration(`https://${host}`);

      const refusal = await proberFor([DECLARED])
        .test(integrationId)
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(IntegrationEgressRefusedError);
      expect((refusal as IntegrationEgressRefusedError).host).toBe(host);
      expect((refusal as IntegrationEgressRefusedError).setting).toBe('APP_INTEGRATION_HOSTS');
      // The measurement, not the inference: the adapter was built with the binding's decrypted
      // token, and nothing was asked of the network with it.
      expect(attempted).toEqual([]);
      // Nothing provider-facing happened, so there is nothing to audit (the answer the executor's
      // other three request guards give). The row would also be misleading: no action was taken.
      expect(await auditRowCount()).toBe(0);
    },
  );

  it('refuses the same row when the list is empty, which is the shipped default', async () => {
    const integrationId = await insertIntegration(`https://${DECLARED}`);

    await expect(proberFor([]).test(integrationId)).rejects.toBeInstanceOf(
      IntegrationEgressRefusedError,
    );
    expect(attempted).toEqual([]);
  });

  it('lets the declared host through to the adapter, which is where the network would be', async () => {
    // The other side of rule 42, and the case that stops "refuse everything" from passing: the
    // guard is behind us, the adapter built the request, and the only thing missing is a network.
    const integrationId = await insertIntegration(`https://${DECLARED}`);

    const outcome = await proberFor([DECLARED])
      .test(integrationId)
      .catch((error: unknown) => error);

    // The request was made, to the declared host and to nothing else.
    expect(attempted.length).toBeGreaterThan(0);
    expect(attempted.every((url) => new URL(url).hostname === DECLARED)).toBe(true);
    // It failed because this test has no network — **not** because the guard refused it. The two
    // are different facts and a test that only asserted "it threw" would not tell them apart.
    expect(outcome).not.toBeInstanceOf(IntegrationEgressRefusedError);
    expect((outcome as Error).message).toContain('could not be reached');
    // …and the executor audited the attempt, which is the half a refusal deliberately does not do.
    expect(await auditRowCount()).toBe(1);
  });

  it('refuses a row whose config carries a scheme no provider schema would have accepted', async () => {
    // `httpUrlSchema` stops this at the five config schemas, and the binding loader parses config
    // before `create` — so this row is refused *before* the executor by the loader. Measured rather
    // than assumed (rule 47): the refusal is real, and it is not this guard's.
    const integrationId = await insertIntegration('file:///etc/passwd');

    const refusal = await proberFor([DECLARED])
      .test(integrationId)
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).not.toBeInstanceOf(IntegrationEgressRefusedError);
    expect((refusal as Error).message).toContain('base_url');
    expect(attempted).toEqual([]);
  });
});
