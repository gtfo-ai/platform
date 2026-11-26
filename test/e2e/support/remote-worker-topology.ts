/**
 * **The topology the remote-worker e2e files share** — WP-283 (4)'s core (a `ROLE=all` pipeline
 * process and a `ROLE=api` process the workers talk to) and the helpers its cases read it with.
 *
 * Moved here from `remote-worker.e2e.test.ts` when that file was split in three (it ran 309 s, a
 * third of one CI part on its own): `remote-worker-claims.e2e.test.ts` (criteria 1 and 3–5),
 * `remote-worker.e2e.test.ts` (2 and 6–11) and `remote-worker-reoffer.e2e.test.ts` (WP-285, WP-286). The
 * cases are unchanged; only where their setup lives moved.
 *
 * {@link remoteWorkerSuite} is a factory because the cleanups are **per file**: it registers the
 * file's `afterEach` and returns that file's own `cleanups` list with `core` and `worker` bound to it.
 */
import { createPublicKey, verify } from 'node:crypto';
import { FAKE_DEPLOY_KEY } from '@platform/application';
import type { JsonObject, RunPackage } from '@platform/contracts';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { afterEach, expect } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from './instance.js';
import {
  APP_SECRET_KEY,
  GIT_INTEGRATION_ID,
  inboundEvent,
  type PipelineE2E,
  type ScenarioSpec,
  startPipeline,
} from './pipeline.js';
import type { CapturedCoreRequest, WorkerUnderTest } from './remote-worker.js';
import { CORE_DIGESTS_ENV, startWorkerUnderTest } from './remote-worker.js';
import { featureScenarios, TICKETS } from './scenarios.js';

/** Obviously fake (rule 93): a hyphen after FAKE, and no provider's real token pattern. */
export const STATIC_RUN_TOKEN = 'FAKE-wp283-static-operator-run-token-0001';
export const QUESTION = 'which module sums the footer?';
export const ANSWER = 'the invoice renderer sums the model';

export const ticketMatched = (pipeline: PipelineE2E, key = 'ACME-1') =>
  inboundEvent('ticket.matched', {
    project_id: pipeline.projectId,
    ticket: {
      provider: 'fake-task-management',
      key,
      url: `https://tickets.example.test/browse/${key}`,
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

export const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

export const send = async (client: Client, path: string, body: unknown, key?: string) =>
  client.json<Record<string, unknown>>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  });

/** The harness's scenario for a claimed run: its stage's, or the ask's answer. */
export const scenarioFor =
  (pipeline: PipelineE2E, overrides: Readonly<Record<string, Partial<ScenarioSpec>>> = {}) =>
  (pkg: RunPackage): ScenarioSpec => {
    if (pkg.run.stage === null) {
      return {
        costUsd: 0.05,
        structuredOutput: { answer: ANSWER, citations: [], unanswered: [], confidence: 'high' },
      };
    }
    const stage = pkg.run.stage;
    const base = (featureScenarios(pipeline.world) as Record<string, ScenarioSpec>)[stage];
    if (base === undefined) throw new Error(`no scenario for stage ${stage}`);
    return { ...base, ...(overrides[stage] ?? {}) };
  };

export interface Topology {
  readonly pipeline: PipelineE2E;
  readonly api: { readonly baseUrl: string; stop(): Promise<void> };
  readonly captured: CapturedCoreRequest[];
}

/**
 * One test file's `core` and `worker`, and the `afterEach` that stops what they started.
 *
 * `core` is the pipeline's process and a `ROLE=api` process the workers talk to; no launcher on
 * either, so neither composes a server claimant. The pipeline's process is `ROLE=all` rather than
 * `worker` because the bootstrap administrator is created only by a process that serves the API and
 * only while `users` is empty — and the harness seeds its own user right after the first process
 * starts (CI's first run of `remote-worker.e2e.test.ts`: every sign-in `401`). `worker` starts a
 * `remote-worker` against it.
 */
export const remoteWorkerSuite = () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  const core = async (
    label: string,
    options: {
      readonly gitRunCredentials?: boolean;
      readonly beforeReport?: Parameters<typeof startPipeline>[0]['beforeReport'];
      /** The `ROLE=api` process's own environment beyond the harness's. */
      readonly apiEnv?: Readonly<Record<string, string>>;
      /** The pipeline process's own environment beyond the harness's (WP-286: a fast sweep). */
      readonly pipelineEnv?: Readonly<Record<string, string>>;
    } = {},
  ): Promise<Topology> => {
    const pipeline = await startPipeline({
      scenarios: featureScenarios,
      label,
      tickets: TICKETS,
      role: 'all',
      agent: 'none',
      env: { APP_WORKER_IMAGE_DIGESTS: CORE_DIGESTS_ENV, ...options.pipelineEnv },
      ...(options.gitRunCredentials === true ? { gitRunCredentials: true } : {}),
      ...(options.beforeReport === undefined ? {} : { beforeReport: options.beforeReport }),
    });
    cleanups.push(() => pipeline.stop());
    const api = await pipeline.addProcess({
      name: 'api',
      role: 'api',
      agent: 'none',
      ...(options.apiEnv === undefined ? {} : { env: options.apiEnv }),
    });
    return { pipeline, api, captured: [] };
  };

  const worker = async (
    topology: Topology,
    options: Omit<
      Parameters<typeof startWorkerUnderTest>[1],
      'captured' | 'coreUrl' | 'scenario'
    > & {
      readonly coreUrl?: string;
      readonly scenario?: (pkg: RunPackage) => ScenarioSpec;
    },
  ): Promise<WorkerUnderTest> => {
    const started = await startWorkerUnderTest(topology.pipeline, {
      ...options,
      coreUrl: options.coreUrl ?? topology.api.baseUrl,
      scenario: options.scenario ?? scenarioFor(topology.pipeline),
      captured: topology.captured,
    });
    cleanups.push(() => started.stop());
    return started;
  };

  return { cleanups, core, worker };
};

export const adminId = async (pipeline: PipelineE2E): Promise<string> => {
  const [row] = await pipeline.query<{ id: string }>('select id from users where email = $1', [
    BOOTSTRAP_EMAIL,
  ]);
  if (row === undefined) throw new Error('the bootstrap administrator has no row yet');
  return row.id;
};

export const setExecution = (
  pipeline: PipelineE2E,
  settings: {
    readonly mode: 'hybrid' | 'workers_only' | 'server_only';
    readonly prefer: 'server' | 'workers';
    readonly fallbackAfterSeconds?: number | null;
    readonly assigneeWindowSeconds?: number;
  },
) =>
  pipeline.query(
    `insert into project_execution_settings
       (project_id, mode, prefer, fallback_after_seconds, assignee_window_seconds)
     values ($1, $2, $3, $4, $5)
     on conflict (project_id) do update
       set mode = excluded.mode, prefer = excluded.prefer,
           fallback_after_seconds = excluded.fallback_after_seconds,
           assignee_window_seconds = excluded.assignee_window_seconds`,
    [
      pipeline.projectId,
      settings.mode,
      settings.prefer,
      settings.fallbackAfterSeconds ?? null,
      settings.assigneeWindowSeconds ?? 120,
    ],
  );

/** Switches the seeded git integration to a static token or a deploy key, sealed as the API would. */
export const switchRunCredential = async (
  pipeline: PipelineE2E,
  shape: 'static' | 'deploy_key',
  remote: 'allow' | 'deny',
): Promise<void> => {
  const key = secretAdapters.deriveSecretKey(APP_SECRET_KEY);
  const [field, value] =
    shape === 'static'
      ? ['run_token', STATIC_RUN_TOKEN]
      : ['run_ssh_private_key', FAKE_DEPLOY_KEY.privateKey];
  const secretId = crypto.randomUUID();
  await pipeline.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    secretId,
    secretAdapters.sealSecret(key, secretAdapters.secretDocument(field, value), secretId),
    key.keyId,
  ]);
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const config: JsonObject =
    shape === 'static'
      ? {
          run_credential: 'static',
          run_token_owner: 'operator',
          run_token_username: 'agentic-runner',
          run_token_expires_at: expires,
          remote_run_credential: remote,
        }
      : {
          run_credential: 'deploy_key',
          run_ssh_public_key: FAKE_DEPLOY_KEY.publicKey,
          remote_run_credential: remote,
        };
  await pipeline.query(
    `update integrations
        set config = config || $2::jsonb, secret_ids = secret_ids || array[$3::uuid]
      where id = $1`,
    [GIT_INTEGRATION_ID, JSON.stringify(config), secretId],
  );
};

export const ready = (pipeline: PipelineE2E) =>
  pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

/** Every stage run of the task, with who executed it. */
export const stageRuns = (pipeline: PipelineE2E) =>
  pipeline.query<{
    id: string;
    stage: string | null;
    status: string;
    worker_id: string | null;
    claimant_kind: string | null;
    lease_epoch: number | null;
    ssh_signatures: number | null;
  }>(
    `select r.id, o.stage, r.status::text as status, r.worker_id, o.claimant_kind::text,
            o.lease_epoch, o.ssh_signatures
       from runs r left join run_offers o on o.run_id = r.id
      order by r.created_at`,
  );

export const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const verifiesWithDeployKey = (data: Buffer, signatureBlob: Buffer): boolean => {
  const raw = Buffer.from(FAKE_DEPLOY_KEY.publicKey.split(' ')[1] ?? '', 'base64').subarray(19);
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, data, key, signatureBlob.subarray(19));
};
