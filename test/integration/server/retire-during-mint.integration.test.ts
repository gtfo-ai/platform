/**
 * **A retire that lands while a mint's provider call is open** — PROGRESS backlog **386**, the
 * defect WP-114's retire introduced, closed in its pre-review round.
 *
 * The interleaving is ordered deliberately, against a real PostgreSQL 18. A project binds a git
 * integration. A run's mint starts through the production minter (`createRunGitCredentialMinter`),
 * so the production executor writes the real `integration_actions` row. The fake provider's
 * `mintCredential` is held open on a gate. While it is open the project is unbound and the
 * integration retired through the product's own writes (`replaceProjectBindings`,
 * `retireIntegration`). The retire succeeds, because no mint is recorded yet, and its `secrets` rows
 * go. Then the call returns.
 *
 * Before the fix the run was handed the token, and teardown and recovery could only report it. Now
 * the mint records its audit row, reads `retired_at` after it (the order
 * `MintingIntegrationLiveness` argues is sound), revokes through the adapter it holds, and refuses
 * the run start. The fake provider's own count of revocations goes 0 → 1, a `revoke_credential` row
 * is `ok` with `revoked: true`, and nothing reaches the run-secret registry. Without the registry,
 * `LauncherProvisioner.provision` never reaches `createRun`, so no workspace is created.
 */
import { randomUUID } from 'node:crypto';
import type { PipelineIntegrations, PipelineIntegrationsPort } from '@platform/application';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createRunScopedSecrets,
  createVirtualTimer,
  noSecretsRedactor,
  RunCredentialMintRetiredError,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { eventing, integrations as integrationAdapters } from '@platform/infrastructure';
import { createFakeGitProvider, type FakeGitProvider } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  replaceProjectBindings,
  retireIntegration,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import { createRunGitCredentialMinter } from '../../../apps/server/src/workspaces.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const PROJECT_PATH = 'acme/api';

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let projectId: Id;
let userId: string;

const iso = (): IsoDateTime => new Date().toISOString() as IsoDateTime;

beforeAll(async () => {
  database = await createMigratedDatabase('retire-during-mint');
  pool = createTestPool(database.connectionString, { max: 6 });
  db = drizzle(pool) as unknown as Database;
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('wp114-386') returning id",
  );
  userId =
    (
      await pool.query<{ id: string }>(
        "insert into users (email, name) values ('admin-386@example.test', 'Admin') returning id",
      )
    ).rows[0]?.id ?? '';
  projectId = (
    await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'acme', 'Acme', 'https://git.example.test/acme/api.git') returning id`,
      [org.rows[0]?.id],
    )
  ).rows[0]?.id as Id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/** A git integration row, bound to the project, with one sealed-credential row to destroy. */
const boundGitIntegration = async (): Promise<Id> => {
  const secret = await pool.query<{ id: string }>(
    "insert into secrets (ciphertext, key_id) values ('\\x00'::bytea, 'v1:fake') returning id",
  );
  const integration = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, secret_ids)
     select org_id, 'git', 'fake-git', 'acme fake git', array[$2::uuid] from projects where id = $1
     returning id`,
    [projectId, secret.rows[0]?.id],
  );
  const id = integration.rows[0]?.id as Id;
  await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
    projectId,
    id,
  ]);
  return id;
};

const seedTask = async (): Promise<Id> =>
  (
    await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          current_stage, template_snapshot, mode)
       values ($1, 'fake-jira', 'ACME-386', 'https://jira.example.test/browse/ACME-386', 'feature',
               'active', 'implementation', $2::jsonb, 'normal') returning id`,
      [projectId, JSON.stringify(FEATURE_TEMPLATE)],
    )
  ).rows[0]?.id as Id;

/** The production executor over the real audit table, for the project's one fake git binding. */
const portOver = (git: FakeGitProvider): PipelineIntegrationsPort => {
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: integrationAdapters.createPostgresIntegrationAuditLog({
      unitOfWork: new eventing.PostgresUnitOfWork({ pool }),
      eventStore: new eventing.PostgresEventStore(pool),
      ids: { next: () => randomUUID() as Id },
    }),
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: iso } as never,
  });
  const bound: PipelineIntegrations = {
    executor,
    git: { port: git, ref: git.ref, project: PROJECT_PATH, redactor: noSecretsRedactor() },
    taskManagement: null,
    communication: null,
  };
  return {
    // What the loader built for the run **before** the retire: the adapter, credential in hand.
    forProject: async () => bound,
    forMintingIntegration: async () => null,
    forObservability: async () => null,
  };
};

describe('a retire that commits while a mint’s call is open (backlog 386)', () => {
  it('ends with the token revoked through the adapter in hand and the run start refused', async () => {
    const integrationId = await boundGitIntegration();
    const taskId = await seedTask();
    const fake = createFakeGitProvider({
      integrationId,
      projects: [{ path: PROJECT_PATH }],
      clockStart: iso(),
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let callStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    // The provider call held open on a gate: the window backlog 386 is about.
    const git = new Proxy(fake, {
      get: (target, property, receiver) =>
        property === 'mintCredential'
          ? async (...args: Parameters<FakeGitProvider['mintCredential']>) => {
              callStarted();
              await gate;
              return target.mintCredential(...args);
            }
          : (Reflect.get(target, property, receiver) as unknown),
    });
    const runSecrets = createRunScopedSecrets({ now: () => Date.now() });
    const minter = createRunGitCredentialMinter({
      pool,
      integrations: portOver(git),
      runSecrets,
    });
    const runId = randomUUID() as Id;

    const minting = minter
      .mint({
        spec: { runId, taskId, projectId } as never,
        project: { branchPatterns: ['agentic/*'] } as never,
        scope: 'push',
        ttlSeconds: 86_400,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await started;

    // ── the call is open: unbind, then retire. No mint is recorded, so the retire succeeds. ──
    await replaceProjectBindings(db, projectId, [], { egress: allowAnyIntegrationHost() });
    expect(
      await retireIntegration(db, {
        integrationId,
        audit: { userId, action: 'integration.retire', params: { integration_id: integrationId } },
      }),
    ).toEqual({ status: 'retired', destroyedSecrets: 1 });

    // ── the call returns ──────────────────────────────────────────────────────────────────
    open();
    const error = await minting;
    expect(error).toBeInstanceOf(RunCredentialMintRetiredError);
    expect((error as Error).message).toMatch(/was retired while run .* it was revoked$/);

    // Revoked at the provider: its own count, not a record of intent (standing rule 1).
    expect(fake.credentials).toHaveLength(1);
    expect(fake.credentials[0]).toMatchObject({ revoked: true, revocations: 1 });
    const audited = await pool.query<{ action: string; status: string; revoked: string | null }>(
      `select action, status, result ->> 'revoked' as revoked from integration_actions
        where integration_id = $1 order by created_at`,
      [integrationId],
    );
    expect(audited.rows).toEqual([
      { action: 'mint_credential', status: 'ok', revoked: null },
      { action: 'revoke_credential', status: 'ok', revoked: 'true' },
    ]);
    // Nothing reached the run: the value is in no registry, so no workspace carried it.
    expect(runSecrets.secretsFor(runId)).toEqual([]);
  });
});
