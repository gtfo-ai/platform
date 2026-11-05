/**
 * **One signature cap per run, not one per API replica** — WP-282 criterion (5), TD-031's
 * 2026-11-04 amendment (backlog 693): `ssh-sign` counts every signature against
 * `MAX_DEPLOY_KEY_SIGNATURES` in `run_offers.ssh_signatures`, incremented in the statement that
 * checks the epoch, so two `ROLE=api` processes answering one worker's requests share the cap.
 *
 * Two whole `apps/server` instances (`ROLE=api`, no launcher) on one database; a deploy-key project
 * with `remote_run_credential: allow`, its key sealed through the production create; a run claimed
 * by a remote worker at epoch 1, its run token stored hashed on the offer. The worker's requests
 * alternate between the two processes — more than the cap — and exactly the cap is signed, every
 * signature the deploy key's public key verifies, and the column holds the cap. Then the run ends
 * and a sign is refused `lease_lost`. The deterministic race of the statement itself is the
 * integration tier's (`remote-claim.integration.test.ts`, "one cap per run however many connections
 * race for it"); this is the same property through the processes.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { allowAnyIntegrationHost, FAKE_DEPLOY_KEY, sshString } from '@platform/application';
import {
  type IntegrationType,
  WORKER_API_PREFIX,
  WORKER_PROTOCOL_VERSION,
  workerSshSignResponseSchema,
} from '@platform/contracts';
import { launcher as launcherAdapters, secrets as secretAdapters } from '@platform/infrastructure';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { loadServerConfig, requiredPoolConnections } from '@platform/server';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  createIntegration,
  environmentSecretSource,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import { createTestPool } from '../../integration/support/postgres.js';
import { type Instance, startInstance } from '../support/instance.js';

/** `startInstance`'s own secret key: the seal below must open in both processes. */
const SECRET_KEY = 'e2e-test-secret-key-not-a-real-secret-0000';
/** Obviously fake (BD-002). */
const API_TOKEN = 'glpat-FAKE-wp282-binding-api-token-000000';
const RUN_TOKEN = 'FAKE-wp282-run-token-aaaaaaaaaaaaaaaaaaaaaaa';
const MAX = launcherAdapters.MAX_DEPLOY_KEY_SIGNATURES;

const floorOf = (role: string): number =>
  requiredPoolConnections(
    loadServerConfig({
      ROLE: role,
      DATABASE_URL: 'postgres://127.0.0.1:5432/floor',
      APP_SECRET_KEY: 'e2e-pool-floor-probe-not-a-real-secret-000',
      APP_DB_POOL_MAX: '1000',
    }),
  );

const instances: Instance[] = [];

afterEach(async () => {
  // The second process does not own the database; the first drops it, last.
  for (const instance of instances.splice(0).reverse()) {
    await instance.stop();
  }
});

const keyBlob = (): Buffer => Buffer.from(FAKE_DEPLOY_KEY.publicKey.split(' ')[1] ?? '', 'base64');

/** A synthetic RFC 4252 §7 user-authentication request for user `git` with the deploy key. */
const userauth = (session: number): Buffer =>
  Buffer.concat([
    sshString(Buffer.alloc(32, session)),
    Buffer.from([50]),
    sshString('git'),
    sshString('ssh-connection'),
    sshString('publickey'),
    Buffer.from([1]),
    sshString('ssh-ed25519'),
    sshString(keyBlob()),
  ]);

describe('ssh-sign through two ROLE=api processes (WP-282, backlog 693)', () => {
  it('signs exactly MAX_DEPLOY_KEY_SIGNATURES for one run, whichever process answers, and nothing after its end', async () => {
    const env = {
      APP_DB_POOL_MAX: String(floorOf('api')),
      APP_INTEGRATION_HOSTS: 'gitlab.com',
    };
    const first = await startInstance({ role: 'api', label: 'ssh-sign-cap', env });
    instances.push(first);
    const second = await startInstance({ role: 'api', database: first.database, env });
    instances.push(second);

    const pool = createTestPool(first.database.connectionString, { max: 2 });
    let runId: string;
    try {
      const one = async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
        (await pool.query<R>(text, values)).rows[0] as R;
      const { id: orgId } = await one<{ id: string }>(
        "insert into organizations (name) values ('wp282') returning id",
      );
      const { id: projectId } = await one<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, 'autix', 'Autix', 'https://gitlab.com/acme/autix.git') returning id`,
        [orgId],
      );
      const gitlab = SHIPPED_PROVIDERS.find((entry) => entry.id === 'gitlab');
      if (gitlab === undefined) throw new Error('this build ships a gitlab provider');
      const created = await createIntegration(drizzle(pool) as unknown as Database, {
        orgId,
        integration: {
          type: 'git' as IntegrationType,
          provider: 'gitlab',
          name: 'gitlab-deploy-key',
          config: {
            base_url: 'https://gitlab.com',
            project: 'acme/autix',
            run_credential: 'deploy_key',
            run_ssh_public_key: FAKE_DEPLOY_KEY.publicKey,
            remote_run_credential: 'allow',
          },
          secretRefs: { token: 'API_TOKEN', run_ssh_private_key: 'DEPLOY_KEY' },
        },
        provider: gitlab,
        egress: allowAnyIntegrationHost(),
        secretSource: environmentSecretSource(
          { API_TOKEN, DEPLOY_KEY: FAKE_DEPLOY_KEY.privateKey },
          async () => '',
          ['API_TOKEN', 'DEPLOY_KEY'],
        ),
        secretKey: secretAdapters.deriveSecretKey(SECRET_KEY),
        newId: () => crypto.randomUUID(),
      });
      await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
        projectId,
        created.integration.id,
      ]);
      const { id: userId } = await one<{ id: string }>(
        "insert into users (email, name) values ('dev@example.test', 'Dev') returning id",
      );
      await pool.query(
        "insert into project_members (project_id, user_id, role) values ($1, $2, 'member')",
        [projectId, userId],
      );
      const workerId = crypto.randomUUID();
      await pool.query(
        `insert into workers (id, user_id, name, credential_hash, last_seen_at)
         values ($1, $2, 'laptop', $3, now())`,
        [workerId, userId, 'e'.repeat(64)],
      );
      const { id: taskId } = await one<{ id: string }>(
        `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template)
         values ($1, 'jira', 'AUT-1', 'https://jira.example.test/browse/AUT-1', 'feature')
         returning id`,
        [projectId],
      );
      ({ id: runId } = await one<{ id: string }>(
        `insert into runs (task_id, project_id, role, model, prompt_version, status, lease_owner,
                           lease_expires_at, lease_epoch, worker_id, credential_source,
                           credential_integration_id)
         values ($1, $2, 'developer', 'claude-opus-5', 'developer@1', 'starting', $3,
                 now() + interval '10 minutes', 1, $4, 'deploy_key', $5)
         returning id`,
        [taskId, projectId, `worker:${workerId}`, workerId, created.integration.id],
      ));
      await pool.query(
        `insert into run_offers (id, run_id, task_id, project_id, stage, attempt, kind, state,
                                 lease_epoch, claimant_kind, claimed_at, worker_id,
                                 run_token_hash, run_token_epoch, offered_at)
         values ($1, $2, $3, $4, 'implementation', 1, 'stage', 'claimed', 1, 'worker', now(), $5,
                 $6, 1, now())`,
        [
          crypto.randomUUID(),
          runId,
          taskId,
          projectId,
          workerId,
          createHash('sha256').update(RUN_TOKEN).digest('hex'),
        ],
      );
    } finally {
      await pool.end();
    }

    const sign = async (instance: Instance, session: number) => {
      const response = await fetch(
        `${instance.baseUrl}${WORKER_API_PREFIX}/runs/${runId}/ssh-sign`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${RUN_TOKEN}`,
            'x-worker-protocol': String(WORKER_PROTOCOL_VERSION),
          },
          body: JSON.stringify({
            epoch: 1,
            key_blob: keyBlob().toString('base64'),
            data: userauth(session).toString('base64'),
            flags: 0,
          }),
        },
      );
      return { status: response.status, body: (await response.json()) as unknown };
    };

    const raw = keyBlob().subarray(keyBlob().length - 32);
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der',
      type: 'spki',
    });
    let signed = 0;
    let refused = 0;
    // Alternating, sequentially per pair, so both processes serve requests throughout.
    for (let index = 0; index < MAX + 10; index += 1) {
      const answer = await sign(index % 2 === 0 ? first : second, index % 256);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      const { signature } = workerSshSignResponseSchema.parse(answer.body);
      if (signature === null) {
        refused += 1;
        continue;
      }
      signed += 1;
      const blob = Buffer.from(signature, 'base64');
      expect(verify(null, userauth(index % 256), publicKey, blob.subarray(blob.length - 64))).toBe(
        true,
      );
    }
    expect({ signed, refused }).toEqual({ signed: MAX, refused: 10 });

    const check = createTestPool(first.database.connectionString, { max: 1 });
    try {
      const { rows } = await check.query<{ ssh_signatures: number }>(
        'select ssh_signatures from run_offers where run_id = $1',
        [runId],
      );
      expect(rows[0]?.ssh_signatures).toBe(MAX);
      // The run's terminal writer closes the offer; a sign after it is refused, through either process.
      await check.query(
        `update runs set status = 'failed', terminal_reason = 'crash', ended_at = now()
          where id = $1`,
        [runId],
      );
      await check.query(
        "update run_offers set state = 'settled', settled_at = now() where run_id = $1",
        [runId],
      );
    } finally {
      await check.end();
    }
    for (const instance of [first, second]) {
      const late = await sign(instance, 1);
      expect(`${late.status} ${(late.body as { error?: { code?: string } }).error?.code}`).toBe(
        '409 lease_lost',
      );
    }
  }, 300_000);
});
