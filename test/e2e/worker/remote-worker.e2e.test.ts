/**
 * **The first usable worker** — WP-283 criterion (4): two `apps/server` processes (`ROLE=worker` for
 * the pipeline, `ROLE=api` for the worker protocol — neither with a launcher) and one or two
 * `remote-worker`s (`../support/remote-worker.ts`: the production composition over HTTP, its own
 * `apps/launcher` control plane relaying over the fake workspace provider, the scripted Claude CLI).
 *
 *  1. A task runs to **Ready** on remote workers alone; two workers never run one offer; the Claude
 *     token reaches no request, no transcript row and no log line; every export precedes `finish`;
 *     the run page names the worker (`seat`); and an **ask** is claimed by the asker's worker inside
 *     its window, never by the other.
 *  2. **Hybrid**: with the server's claimant full, the next run goes to the worker.
 *  3. A **core restart** mid-run is survived — the run outlives the API process on its lease.
 *  4. **Revoke** mid-run fences: the worker's next call is `401`, it stops and finishes nothing.
 *  5. **Steer and cancel** arrive on the heartbeat and are acked applied.
 *  6. A **take-over** of a remote deploy-key run pushes the branch **through the helper socket** and
 *     records no tarball (backlog 688); the run page names the worker.
 *  7. The **Autix shape** — a static operator token with `remote_run_credential: allow` — runs to
 *     Ready with the token in the package and in no transcript row, tool body or log line; with
 *     `deny` the worker claims nothing and the execution setting says why.
 *  8. A **deploy-key** project with `allow` runs to Ready with no private key in any package or
 *     create request, each mirror fetch signing once through the helper socket against the core's
 *     oracle — the signature verified, the count on the offer (backlog 693).
 *  9. **Cancel from the worker's local page** (WP-292 (5)): a user below `run.cancel` is `403` and
 *     the run continues; at `member` the run ends `cancelled` through the `run_commands` row the
 *     worker's heartbeat delivers, the task is `paused`, and one `human_actions` row `run.cancel`
 *     carries `via: worker_ui` and the worker's user.
 * 10. **Pick only and *Take this one*** (WP-293 (5)): the page sets the scope to pick only, lists
 *     the waiting offer, takes it, and the run settles on that worker; nothing is claimed by itself.
 *     Since S-26.4 *pick only* is the claim policy, and the take makes the worker's user the task's
 *     owner (`via: pick`).
 * 11. **A version-3 worker still claims** (S-26.4, protocol 4 accepted `[3, 4]`): a worker that
 *     announces protocol 3 on every request runs a stage to completion through the core's
 *     version-3 shapes.
 */
import { createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAKE_DEPLOY_KEY } from '@platform/application';
import type { Id, JsonObject, RunPackage } from '@platform/contracts';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  APP_SECRET_KEY,
  GIT_INTEGRATION_ID,
  inboundEvent,
  type PipelineE2E,
  type ScenarioSpec,
  startPipeline,
} from '../support/pipeline.js';
import type { CapturedCoreRequest, WorkerUnderTest } from '../support/remote-worker.js';
import {
  CORE_DIGESTS_ENV,
  E2E_UI_PUBLISHED_PORT,
  startCoreProxy,
  startWorkerUnderTest,
  WORKER_CLAUDE_TOKEN,
} from '../support/remote-worker.js';
import { featureScenarios, TICKETS } from '../support/scenarios.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Obviously fake (rule 93): a hyphen after FAKE, and no provider's real token pattern. */
const STATIC_RUN_TOKEN = 'FAKE-wp283-static-operator-run-token-0001';
const QUESTION = 'which module sums the footer?';
const ANSWER = 'the invoice renderer sums the model';

const ticketMatched = (pipeline: PipelineE2E, key = 'ACME-1') =>
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

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const send = async (client: Client, path: string, body: unknown, key?: string) =>
  client.json<Record<string, unknown>>(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    body: JSON.stringify(body),
  });

/** The harness's scenario for a claimed run: its stage's, or the ask's answer. */
const scenarioFor =
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

interface Topology {
  readonly pipeline: PipelineE2E;
  readonly api: { readonly baseUrl: string; stop(): Promise<void> };
  readonly captured: CapturedCoreRequest[];
}

/**
 * The core: the pipeline's process and a `ROLE=api` process the workers talk to; no launcher on
 * either, so neither composes a server claimant. The pipeline's process is `ROLE=all` rather than
 * `worker` because the bootstrap administrator is created only by a process that serves the API and
 * only while `users` is empty — and the harness seeds its own user right after the first process
 * starts (CI's first run of this file: every sign-in `401`).
 */
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
  options: Omit<Parameters<typeof startWorkerUnderTest>[1], 'captured' | 'coreUrl' | 'scenario'> & {
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

const adminId = async (pipeline: PipelineE2E): Promise<string> => {
  const [row] = await pipeline.query<{ id: string }>('select id from users where email = $1', [
    BOOTSTRAP_EMAIL,
  ]);
  if (row === undefined) throw new Error('the bootstrap administrator has no row yet');
  return row.id;
};

const setExecution = (
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
const switchRunCredential = async (
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

const ready = (pipeline: PipelineE2E) =>
  pipeline.settle('ready_for_merge', (task) => task.state === 'ready_for_merge');

/** Every stage run of the task, with who executed it. */
const stageRuns = (pipeline: PipelineE2E) =>
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

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const verifiesWithDeployKey = (data: Buffer, signatureBlob: Buffer): boolean => {
  const raw = Buffer.from(FAKE_DEPLOY_KEY.publicKey.split(' ')[1] ?? '', 'base64').subarray(19);
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return verify(null, data, key, signatureBlob.subarray(19));
};

describe('the first usable worker (WP-283)', () => {
  it('runs a task to Ready on remote workers, one claim per offer, the token nowhere, and the asker’s worker takes the ask', async () => {
    const topology = await core('worker-ready');
    const { pipeline } = topology;
    // Workers only, preferred: a stage offer (no assignee, backlog 730) is open to both at once,
    // and an ask is the asker's alone for the hour of its window (TD-031 §§8, 13).
    await setExecution(pipeline, {
      mode: 'workers_only',
      prefer: 'workers',
      assigneeWindowSeconds: 3_600,
    });
    const admin = await signIn(topology.api.baseUrl);
    const sequence: string[] = [];
    const logs: string[] = [];
    const asker = await worker(topology, {
      name: 'asker-laptop',
      userId: await adminId(pipeline),
      sequence,
      logs,
      echo: () => `my token is ${WORKER_CLAUDE_TOKEN}`,
    });
    const other = await worker(topology, {
      name: 'other-laptop',
      sequence,
      logs,
      echo: () => `my token is ${WORKER_CLAUDE_TOKEN}`,
    });

    await pipeline.publish([ticketMatched(pipeline)]);
    await ready(pipeline);

    const runs = await stageRuns(pipeline);
    expect(runs.length).toBeGreaterThan(3);
    for (const run of runs) {
      // Every run on a worker, under its first and only claim.
      expect(run, run.stage ?? 'ask').toMatchObject({
        status: 'completed',
        claimant_kind: 'worker',
        lease_epoch: 1,
      });
      expect([asker.workerId, other.workerId]).toContain(run.worker_id);
    }
    // Two workers never ran one offer: each run was claimed once and packaged to one worker.
    const claimed = await pipeline.query<{ run_id: string; claims: number }>(
      `select stream_id as run_id, count(*)::int as claims from events
        where type = 'run.claimed' group by stream_id`,
    );
    expect(claimed.every((row) => row.claims === 1)).toBe(true);
    const packaged = [...asker.packages, ...other.packages].map((pkg) => pkg.runId);
    expect(new Set(packaged).size).toBe(packaged.length);
    expect(packaged.sort()).toEqual(runs.map((run) => run.id).sort());

    // The Claude token: in no request, no stored transcript row, no log line — and redacted, not
    // absent, where the model said it (rule 42's positive half).
    expect(topology.captured.length).toBeGreaterThan(0);
    for (const request of topology.captured) {
      expect(`${request.verb} ${request.body}`).not.toContain(WORKER_CLAUDE_TOKEN);
      expect(JSON.stringify(request.headers)).not.toContain(WORKER_CLAUDE_TOKEN);
    }
    const transcript = await pipeline.transcript();
    expect(JSON.stringify(transcript)).not.toContain(WORKER_CLAUDE_TOKEN);
    expect(JSON.stringify(transcript)).toContain('[REDACTED:integration:claude_code_oauth_token]');
    expect(logs.join('\n')).not.toContain(WORKER_CLAUDE_TOKEN);

    // Every export (the workspace's end) before the run's finish (amendment §4).
    for (const run of runs) {
      const end = sequence.indexOf(`end:${run.id}`);
      expect(end, run.id).toBeGreaterThan(-1);
      expect(end).toBeLessThan(sequence.indexOf(`finish:${run.id}`));
    }

    // The run page names who executed the run (WP-283 (5)).
    const first = runs[0] as (typeof runs)[number];
    const page = await admin.json<{ seat: unknown }>(`/api/runs/${first.id}`);
    expect(page.status).toBe(200);
    expect(page.body.seat).toMatchObject({
      kind: 'worker',
      worker_id: first.worker_id,
      worker_name: first.worker_id === asker.workerId ? 'asker-laptop' : 'other-laptop',
    });

    // The ask: the administrator asks, so the administrator's worker has the window.
    const task = await pipeline.task();
    const asked = await send(admin, `/api/tasks/${task.id}/ask`, { question: QUESTION }, 'ask-1');
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    await pipeline.waitFor('the ask to be answered', async () => {
      const rows = await pipeline.query<{ status: string }>('select status from task_asks');
      return rows[0]?.status === 'answered';
    });
    const [askRun] = await pipeline.query<{ worker_id: string; kind: string }>(
      `select o.worker_id, o.kind::text as kind from run_offers o
         join task_asks a on a.run_id = o.run_id`,
    );
    expect(askRun).toEqual({ worker_id: asker.workerId, kind: 'ask' });
  }, 300_000);

  it('gives the worker the next run while the server’s claimant is full (hybrid)', async () => {
    let releaseServer: () => void = () => {};
    const serverHeld = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    const topology = await core('worker-hybrid', {
      // The server's one slot is held on its first run until the worker has taken the other.
      beforeReport: (spec) => (spec.stage === 'refinement' ? serverHeld : undefined),
    });
    const { pipeline } = topology;
    await setExecution(pipeline, { mode: 'hybrid', prefer: 'server', fallbackAfterSeconds: 1 });
    const runner = await pipeline.addProcess({
      name: 'runner',
      role: 'worker',
      agent: 'fake-runner',
      env: { APP_RUNNER_CONCURRENCY: '1' },
    });
    cleanups.push(() => runner.stop());
    // Run before the runner's stop (cleanups run in reverse): a held run would hold its stop too.
    cleanups.push(async () => releaseServer());
    const laptop = await worker(topology, { name: 'hybrid-laptop' });

    await pipeline.publish([ticketMatched(pipeline, 'ACME-1'), ticketMatched(pipeline, 'ACME-2')]);
    await pipeline.waitFor('one refinement on each side', async () => {
      const rows = await pipeline.query<{ claimant_kind: string | null }>(
        `select o.claimant_kind::text from run_offers o where o.stage = 'refinement'
            and o.state in ('claimed', 'settled')`,
      );
      return rows.length === 2;
    });
    releaseServer();
    const sides = await pipeline.query<{ claimant_kind: string; worker_id: string | null }>(
      `select o.claimant_kind::text, o.worker_id from run_offers o where o.stage = 'refinement'
        order by o.claimed_at`,
    );
    expect(sides.map((side) => side.claimant_kind).sort()).toEqual(['server', 'worker']);
    expect(sides.find((side) => side.claimant_kind === 'worker')?.worker_id).toBe(laptop.workerId);
  }, 300_000);

  it('survives a core restart mid-run: the run outlives the API process on its lease', async () => {
    const topology = await core('worker-restart');
    const { pipeline } = topology;
    const proxy = await startCoreProxy(topology.api.baseUrl);
    cleanups.push(() => proxy.close());
    let reachedRefinement: () => void = () => {};
    const atRefinement = new Promise<void>((resolve) => {
      reachedRefinement = resolve;
    });
    let releaseRun: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    await worker(topology, {
      name: 'restart-laptop',
      coreUrl: proxy.url,
      hold: async (pkg) => {
        if (pkg.run.stage !== 'refinement') return;
        reachedRefinement();
        await released;
      },
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await atRefinement;

    // The API process goes away mid-run; the worker's calls fail and are retried.
    proxy.retarget(null);
    await topology.api.stop();
    const replacement = await pipeline.addProcess({ name: 'api-2', role: 'api', agent: 'none' });
    proxy.retarget(replacement.baseUrl);
    releaseRun();

    await ready(pipeline);
    const [refinement] = await pipeline.query<{ status: string; lease_epoch: number }>(
      `select r.status::text as status, o.lease_epoch from runs r join run_offers o on o.run_id = r.id
        where o.stage = 'refinement'`,
    );
    // The same run under its first claim — never re-offered.
    expect(refinement).toEqual({ status: 'completed', lease_epoch: 1 });
  }, 300_000);

  it('fences a revoked worker mid-run: its next call is 401, it stops and finishes nothing', async () => {
    const topology = await core('worker-revoke');
    const { pipeline } = topology;
    const laptop = await worker(topology, {
      name: 'revoked-laptop',
      // The refinement waits for a user turn that never comes, so only the revoke can end it.
      scenario: scenarioFor(pipeline, { refinement: { awaitSteers: 1 } }),
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the refinement run to be running', async () => {
      const rows = await pipeline.query("select 1 from runs where status = 'running'");
      return rows.length === 1;
    });
    const [run] = await pipeline.query<{ id: string }>(
      "select id from runs where status = 'running'",
    );
    const admin = await signIn(topology.api.baseUrl);
    const revoked = await admin.json(`/api/workers/${laptop.workerId}`, { method: 'DELETE' });
    expect(revoked.status, JSON.stringify(revoked.body)).toBeLessThan(300);

    await pipeline.waitFor('the worker to stop the session', async () =>
      laptop.runtime.history.some((session) => session.state.ending === 'lease_lost'),
    );
    expect(
      topology.captured.some(
        (request) => request.verb === 'runs/:id/finish' && request.worker === laptop.name,
      ),
    ).toBe(false);
    // The workspace was given back (destroyed), and with no export.
    expect(laptop.launcherEnds.map((end) => end.runId)).toContain(run?.id);
    expect(laptop.launcherEnds.find((end) => end.runId === run?.id)?.body.export).toBeNull();
    // The revoke expired the lease in its own transaction (WP-280), for the sweep to end the row.
    const [lease] = await pipeline.query<{ expired: boolean }>(
      'select lease_expires_at <= now() as expired from runs where id = $1',
      [run?.id],
    );
    expect(lease?.expired).toBe(true);
  }, 300_000);

  it('delivers a steer and a cancel on the heartbeat, each acked applied', async () => {
    const topology = await core('worker-steer-cancel');
    const { pipeline } = topology;
    const laptop = await worker(topology, {
      name: 'steered-laptop',
      scenario: scenarioFor(pipeline, { refinement: { awaitSteers: 2 } }),
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the refinement run to be running', async () => {
      const rows = await pipeline.query("select 1 from runs where status = 'running'");
      return rows.length === 1;
    });
    const [run] = await pipeline.query<{ id: string }>(
      "select id from runs where status = 'running'",
    );
    const runId = run?.id as string;
    const admin = await signIn(topology.api.baseUrl);
    const steer = await send(
      admin,
      `/api/runs/${runId}/steer`,
      { message: 'mind the footer' },
      's1',
    );
    expect(steer.status, JSON.stringify(steer.body)).toBe(202);
    await pipeline.waitFor('the steer to be applied', async () => {
      const rows = await pipeline.query(
        "select 1 from run_commands where run_id = $1 and kind = 'steer' and applied_at is not null",
        [runId],
      );
      return rows.length === 1;
    });
    expect(JSON.stringify(laptop.clis.get(runId)?.stdin)).toContain('mind the footer');

    const cancel = await send(admin, `/api/runs/${runId}/cancel`, {}, 'c1');
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(202);
    await pipeline.waitFor('the run to end cancelled', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status::text as status from runs where id = $1',
        [runId],
      );
      return row?.status === 'cancelled';
    });
    const [command] = await pipeline.query<{ applied: boolean }>(
      "select applied_at is not null as applied from run_commands where run_id = $1 and kind = 'cancel'",
      [runId],
    );
    expect(command?.applied).toBe(true);
  }, 300_000);

  it('takes over a remote deploy-key run: the branch pushed through the helper socket, no tarball', async () => {
    // The API reads the shared export volume, so "no tarball" is the route's own answer (backlog 688).
    const exportDir = mkdtempSync(path.join(tmpdir(), 'worker-take-over-exports-'));
    cleanups.push(async () => rmSync(exportDir, { recursive: true, force: true }));
    const topology = await core('worker-take-over', {
      gitRunCredentials: true,
      apiEnv: { APP_WORKSPACE_EXPORT_DIR: exportDir },
    });
    const { pipeline } = topology;
    await switchRunCredential(pipeline, 'deploy_key', 'allow');
    const laptop = await worker(topology, {
      name: 'taken-laptop',
      scenario: scenarioFor(pipeline, { refinement: { awaitSteers: 1 } }),
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the refinement run to be running', async () => {
      const rows = await pipeline.query("select 1 from runs where status = 'running'");
      return rows.length === 1;
    });
    const [run] = await pipeline.query<{ id: string }>(
      "select id from runs where status = 'running'",
    );
    const runId = run?.id as string;
    const task = await pipeline.task();
    const admin = await signIn(topology.api.baseUrl);
    const taken = await send(admin, `/api/tasks/${task.id}/take-over`, { tarball: true }, 't1');
    expect(taken.status, JSON.stringify(taken.body)).toBeLessThan(300);
    await pipeline.waitFor('the run to end', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status::text as status from runs where id = $1',
        [runId],
      );
      return row?.status === 'cancelled';
    });

    // The stop was recorded with no tarball, and the worker's launcher was asked for none.
    const [command] = await pipeline.query<{ payload: JsonObject }>(
      "select payload from run_commands where run_id = $1 and kind = 'take_over'",
      [runId],
    );
    expect(command?.payload).toMatchObject({ tarball: false });
    const end = laptop.launcherEnds.find((entry) => entry.runId === runId);
    expect(end?.body.export).toMatchObject({ tarball: false });
    // The mirror fetch and the export's push each signed once, through the helper socket, by the
    // core's oracle — and the core counted both on the run's offer.
    const kinds = laptop.provider.relayedSignatures.map((signature) => signature.kind);
    expect(kinds).toEqual(['mirror', 'export']);
    for (const signature of laptop.provider.relayedSignatures) {
      expect(verifiesWithDeployKey(signature.data, signature.signature)).toBe(true);
    }
    const [offer] = await pipeline.query<{ ssh_signatures: number }>(
      'select ssh_signatures from run_offers where run_id = $1',
      [runId],
    );
    expect(offer?.ssh_signatures).toBe(2);
    // The run page names the worker that executed it, and the run's tarball read says there is none:
    // the branch is where a remote run's work went (TD-031 §14, backlog 688).
    const page = await admin.json<{ seat: unknown }>(`/api/runs/${runId}`);
    expect(page.body.seat).toMatchObject({
      kind: 'worker',
      worker_id: laptop.workerId,
      worker_name: 'taken-laptop',
      user_name: 'taken-laptop',
    });
    const tarball = await admin.json<{ error?: { code: string } }>(`/api/runs/${runId}/export.tar`);
    expect(`${tarball.status} ${tarball.body?.error?.code}`).toBe('404 export_not_found');
  }, 300_000);

  it('runs the Autix shape — a static operator token, allowed — to Ready with the token in no row; denied, the worker claims nothing and the setting says why', async () => {
    const topology = await core('worker-autix', { gitRunCredentials: true });
    const { pipeline } = topology;
    await setExecution(pipeline, { mode: 'workers_only', prefer: 'workers' });
    await switchRunCredential(pipeline, 'static', 'allow');
    const logs: string[] = [];
    const laptop = await worker(topology, {
      name: 'autix-laptop',
      logs,
      echo: () => `the push token is ${STATIC_RUN_TOKEN}`,
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await ready(pipeline);

    // In the package — the claim carried it to the worker…
    expect(laptop.packages.length).toBeGreaterThan(0);
    for (const pkg of laptop.packages) {
      if (pkg.workspace.repo === null) continue;
      expect(pkg.credential).toMatchObject({ source: 'static', password: STATIC_RUN_TOKEN });
    }
    // …and in no transcript row, tool call body or log line.
    const transcript = JSON.stringify(await pipeline.transcript());
    expect(transcript).not.toContain(STATIC_RUN_TOKEN);
    expect(transcript).toContain('REDACTED');
    for (const request of topology.captured) {
      if (request.verb.startsWith('runs/:id/tools/') || request.verb === 'runs/:id/transcript') {
        expect(request.body).not.toContain(STATIC_RUN_TOKEN);
      }
    }
    expect(logs.join('\n')).not.toContain(STATIC_RUN_TOKEN);

    // Denied: a second task's offer is never the worker's, and the setting says why.
    await pipeline.query(
      `update integrations set config = config || '{"remote_run_credential":"deny"}'::jsonb
        where id = $1`,
      [GIT_INTEGRATION_ID],
    );
    const before = laptop.packages.length;
    await pipeline.publish([ticketMatched(pipeline, 'ACME-2')]);
    await pipeline.waitFor('the second task’s offer to be open', async () => {
      const rows = await pipeline.query(
        "select 1 from run_offers o join tasks t on t.id = o.task_id where t.ticket_key = 'ACME-2' and o.state = 'open'",
      );
      return rows.length === 1;
    });
    // Several of the worker's held claims answer 204 meanwhile (each holds up to 25 s).
    const claimsBefore = topology.captured.filter((request) => request.verb === 'claims').length;
    await pipeline.waitFor(
      'two more claims to be answered',
      async () =>
        topology.captured.filter((request) => request.verb === 'claims').length >= claimsBefore + 2,
    );
    expect(laptop.packages.length).toBe(before);
    const admin = await signIn(topology.api.baseUrl);
    const execution = await admin.json<{ notice: string | null }>(
      `/api/projects/${pipeline.projectId}/execution`,
    );
    expect(execution.status).toBe(200);
    expect(execution.body.notice).toContain('remote_run_credential: allow');
  }, 300_000);

  it('runs a deploy-key project to Ready with no private key anywhere, each mirror signing once through the helper socket', async () => {
    const topology = await core('worker-deploy-key', { gitRunCredentials: true });
    const { pipeline } = topology;
    await switchRunCredential(pipeline, 'deploy_key', 'allow');
    const laptop = await worker(topology, { name: 'deploy-key-laptop' });
    await pipeline.publish([ticketMatched(pipeline)]);
    await ready(pipeline);

    const keyBody = FAKE_DEPLOY_KEY.privateKey
      .split('\n')
      .filter((line) => !line.startsWith('-----') && line.length > 20);
    const carried = JSON.stringify([laptop.packages, laptop.launcherCreates]);
    for (const fragment of keyBody) {
      expect(carried).not.toContain(fragment);
    }
    const repoRuns = laptop.packages.filter((pkg) => pkg.workspace.repo !== null);
    expect(repoRuns.length).toBeGreaterThan(0);
    for (const pkg of repoRuns) {
      expect(pkg.credential).toBeNull();
      expect(pkg.workspace.repo?.ssh?.connectHost).toBe('altssh.git.example.test');
    }
    for (const create of laptop.launcherCreates) {
      if ((create.spec as { repo: unknown }).repo === null) continue;
      expect(create).toMatchObject({ credential: null });
      expect(create.helperAgentSocket).toMatch(/^helper-[0-9a-f-]{36}\/agent\.sock$/);
    }
    // One signature per mirror fetch — one per run with a checkout — each the core's, verified.
    const mirrors = laptop.provider.relayedSignatures.filter(
      (signature) => signature.kind === 'mirror',
    );
    expect(mirrors).toHaveLength(repoRuns.length);
    for (const signature of mirrors) {
      expect(verifiesWithDeployKey(signature.data, signature.signature)).toBe(true);
    }
    const counted = await pipeline.query<{ run_id: Id; ssh_signatures: number }>(
      'select run_id, ssh_signatures from run_offers where run_id = any($1::uuid[])',
      [repoRuns.map((pkg) => pkg.runId)],
    );
    expect(counted.every((row) => row.ssh_signatures === 1)).toBe(true);
  }, 300_000);

  it('cancels from the worker’s local page: 403 below run.cancel, else cancelled through the heartbeat, the task paused, audited via worker_ui (WP-292)', async () => {
    const topology = await core('worker-local-cancel');
    const { pipeline } = topology;
    const laptop = await worker(topology, {
      name: 'local-page-laptop',
      ui: true,
      scenario: scenarioFor(pipeline, { refinement: { awaitSteers: 2 } }),
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the refinement run to be running', async () => {
      const rows = await pipeline.query("select 1 from runs where status = 'running'");
      return rows.length === 1;
    });
    const [run] = await pipeline.query<{ id: string; task_id: string }>(
      "select id, task_id from runs where status = 'running'",
    );
    const runId = run?.id as string;
    const token = readFileSync(path.join(laptop.stateDir, 'ui-token'), 'utf8').trim();
    const port = Number(new URL(laptop.runtime.uiAddress() ?? '').port);
    const host = `127.0.0.1:${E2E_UI_PUBLISHED_PORT}`;
    /** The page's own request: its Host, its Origin, its token, a key per press. */
    const cancel = (key: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: `/api/local/runs/${runId}/cancel`,
            headers: {
              host,
              origin: `http://${host}`,
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'idempotency-key': key,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify({ reason: 'leaving for the day' }));
      });

    // Below run.cancel — an organisation viewer with no project membership: 403, and nothing moves.
    await pipeline.query("update users set role = 'viewer' where id = $1", [laptop.userId]);
    const refused = await cancel('local-cancel-viewer');
    expect(refused.status, refused.body).toBe(403);
    expect(
      await pipeline.query("select 1 from run_commands where run_id = $1 and kind = 'cancel'", [
        runId,
      ]),
    ).toEqual([]);
    expect(
      await pipeline.query(
        "select 1 from human_actions where action = 'run.cancel' and params ->> 'run_id' = $1",
        [runId],
      ),
    ).toEqual([]);
    const [still] = await pipeline.query<{ status: string }>(
      'select status::text as status from runs where id = $1',
      [runId],
    );
    expect(still?.status).toBe('running');

    // At member: accepted, delivered on the heartbeat, the run cancelled and the task paused.
    await pipeline.query("update users set role = 'member' where id = $1", [laptop.userId]);
    const accepted = await cancel('local-cancel-member');
    expect(accepted.status, accepted.body).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({ run_id: runId, accepted: true });
    await pipeline.waitFor('the run to end cancelled', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status::text as status from runs where id = $1',
        [runId],
      );
      return row?.status === 'cancelled';
    });
    const [command] = await pipeline.query<{ applied: boolean }>(
      "select applied_at is not null as applied from run_commands where run_id = $1 and kind = 'cancel'",
      [runId],
    );
    expect(command?.applied).toBe(true);
    const [task] = await pipeline.query<{ state: string }>(
      'select state::text as state from tasks where id = $1',
      [run?.task_id],
    );
    expect(task?.state).toBe('paused');
    const audit = await pipeline.query<{ user_id: string; params: JsonObject }>(
      "select user_id, params from human_actions where action = 'run.cancel' and params ->> 'run_id' = $1",
      [runId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.user_id).toBe(laptop.userId);
    expect(audit[0]?.params).toMatchObject({ via: 'worker_ui', worker_id: laptop.workerId });
  }, 300_000);
});

/**
 * **What a worker picks up** (WP-293 (5)): a worker its owner set to *pick only* from its local page
 * claims nothing by itself; the page lists the waiting offer (not one the scope takes) and *Take this
 * one* claims it — one `worker.take_offer` row — and the run settles on that worker. The next
 * stage's offer is left open: pick only still takes nothing by itself.
 */
describe('a pick-only worker and take this one (WP-293)', () => {
  it('lists, takes one offer from the page and settles it; nothing is claimed by itself', async () => {
    const topology = await core('worker-pick-only');
    const { pipeline } = topology;
    const laptop = await worker(topology, { name: 'pick-laptop', ui: true });
    const token = readFileSync(path.join(laptop.stateDir, 'ui-token'), 'utf8').trim();
    const port = Number(new URL(laptop.runtime.uiAddress() ?? '').port);
    const host = `127.0.0.1:${E2E_UI_PUBLISHED_PORT}`;
    /** The page's own request: its Host, its Origin on a POST, its token. */
    const page = (method: 'GET' | 'POST', pathname: string, body?: unknown) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port,
            method,
            path: pathname,
            headers: {
              host,
              authorization: `Bearer ${token}`,
              ...(method === 'POST'
                ? { origin: `http://${host}`, 'content-type': 'application/json' }
                : {}),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              }),
            );
          },
        );
        request.on('error', reject);
        request.end(body === undefined ? undefined : JSON.stringify(body));
      });

    await pipeline.waitFor('the worker to be connected', async () => {
      return laptop.runtime.state().connection === 'connected';
    });
    // S-26.4: *pick only* is the claim policy, over every project (`[]` is refused at protocol 4).
    const refused = await page('POST', '/api/local/claim-scope', { claim_project_ids: [] });
    expect(refused.status, refused.body).toBe(422);
    expect(JSON.parse(refused.body).error.code).toBe('claim_scope_empty');
    const scope = await page('POST', '/api/local/claim-scope', {
      claim_project_ids: null,
      claim_policy: 'pick_only',
    });
    expect(scope.status, scope.body).toBe(200);
    expect(JSON.parse(scope.body)).toMatchObject({
      claim_project_ids: null,
      claim_policy: 'pick_only',
    });
    // The page's state carries the policy as the core last said it.
    const local = await page('GET', '/api/local/state');
    expect(JSON.parse(local.body)).toMatchObject({ claim_policy: 'pick_only' });

    await pipeline.publish([ticketMatched(pipeline)]);
    const offeredRun = async (): Promise<string | null> => {
      const [row] = await pipeline.query<{ run_id: string }>(
        "select run_id from run_offers where state = 'open' order by offered_at limit 1",
      );
      return row?.run_id ?? null;
    };
    await pipeline.waitFor(
      'the first stage to be offered',
      async () => (await offeredRun()) !== null,
    );
    const runId = (await offeredRun()) as string;
    // The page lists it, not as one the scope takes; the worker has not claimed it by itself.
    let listed: { run_id: string; automatic: boolean }[] = [];
    await pipeline.waitFor('the page to list the offer', async () => {
      const answer = await page('GET', '/api/local/offers');
      if (answer.status !== 200) return false;
      listed = (JSON.parse(answer.body) as { offers: typeof listed }).offers;
      return listed.some((offer) => offer.run_id === runId);
    });
    expect(listed.find((offer) => offer.run_id === runId)?.automatic).toBe(false);
    expect(await pipeline.query("select 1 from run_offers where state = 'claimed'")).toEqual([]);

    const taken = await page('POST', `/api/local/offers/${runId}/take`, {});
    expect(taken.status, taken.body).toBe(200);
    expect(JSON.parse(taken.body)).toEqual({ run_id: runId });
    await pipeline.waitFor('the taken run to settle', async () => {
      const [row] = await pipeline.query<{ status: string }>(
        'select status::text as status from runs where id = $1',
        [runId],
      );
      return row?.status === 'completed';
    });
    const [claimed] = await pipeline.query<{ worker_id: string; claimant_kind: string }>(
      'select worker_id, claimant_kind::text from run_offers where run_id = $1',
      [runId],
    );
    expect(claimed).toEqual({ worker_id: laptop.workerId, claimant_kind: 'worker' });
    const audits = await pipeline.query<{ action: string; user_id: string; params: JsonObject }>(
      `select action, user_id, params from human_actions
        where action in ('worker.take_offer', 'worker.claim_scope', 'worker.claim_policy',
                         'task.owner')
        order by created_at, action`,
    );
    expect(audits).toEqual([
      {
        action: 'worker.claim_policy',
        user_id: laptop.userId,
        params: {
          worker_id: laptop.workerId,
          claim_policy: 'pick_only',
          project_ids: null,
          via: 'worker_ui',
        },
      },
      // S-26.4: the unassigned task became the picker's, in the claim's transaction.
      {
        action: 'task.owner',
        user_id: laptop.userId,
        params: {
          user_id: laptop.userId,
          via: 'pick',
          worker_id: laptop.workerId,
          run_id: runId,
          changed: true,
          owner_user_id: laptop.userId,
        },
      },
      {
        action: 'worker.take_offer',
        user_id: laptop.userId,
        params: { worker_id: laptop.workerId, run_id: runId, via: 'worker_ui' },
      },
    ]);
    const [owned] = await pipeline.query<{ owner_user_id: string | null; owner_source: string }>(
      'select t.owner_user_id, t.owner_source from tasks t join runs r on r.task_id = t.id where r.id = $1',
      [runId],
    );
    expect(owned).toEqual({ owner_user_id: laptop.userId, owner_source: 'platform' });
    // The next stage is offered and stays open: pick only takes nothing by itself.
    await pipeline.waitFor('the next stage to be offered', async () => {
      const next = await offeredRun();
      return next !== null && next !== runId;
    });
    const next = (await offeredRun()) as string;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const [still] = await pipeline.query<{ state: string }>(
      'select state::text as state from run_offers where run_id = $1',
      [next],
    );
    expect(still?.state).toBe('open');
  }, 300_000);
});

/**
 * **A version-3 worker still claims** (S-26.4, criterion 6): protocol 4 is accepted beside 3, so a
 * worker one release behind — every request it sends announcing `X-Worker-Protocol: 3` — handshakes,
 * claims the first stage by itself (its row has no policy, which reads `everything`) and settles it.
 * The core records the protocol it spoke.
 */
describe('a worker one protocol behind (S-26.4)', () => {
  it('claims and settles a run at protocol 3', async () => {
    const topology = await core('worker-protocol-3');
    const { pipeline } = topology;
    const laptop = await worker(topology, { name: 'v3-laptop', protocol: 3 });
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the v3 worker to settle a run it claimed', async () => {
      const rows = await pipeline.query<{ status: string }>(
        `select r.status::text as status from run_offers o join runs r on r.id = o.run_id
          where o.worker_id = $1 and r.status = 'completed'`,
        [laptop.workerId],
      );
      return rows.length > 0;
    });
    const sent = topology.captured.filter((request) => request.worker === 'v3-laptop');
    expect(sent.map((request) => request.verb)).toEqual(
      expect.arrayContaining(['handshake', 'claims']),
    );
    expect(sent.every((request) => request.headers['x-worker-protocol'] === '3')).toBe(true);
    const [row] = await pipeline.query<{ protocol_version: number }>(
      'select protocol_version from workers where id = $1',
      [laptop.workerId],
    );
    expect(row?.protocol_version).toBe(3);
  }, 300_000);
});

/**
 * **A usage limit and a lost worker re-offer a stage once** (WP-285 (6), WP-286 (4); TD-031
 * decisions 11–12). Each case runs the stage on one worker, takes it away from that worker — its
 * subscription's limit, or the machine gone dark — and asserts that a **second** worker completes
 * the stage, the first excluded from the re-planned offer, and (for the loss) that a second loss of
 * the same stage entry goes to *Needs human* with both runs named.
 *
 * "The machine gone dark" is the worker's core behind a proxy that stops answering (`502`), so no
 * heartbeat lands; "the clock past the TTL" is the run's `lease_expires_at` moved into the past —
 * the write a revocation makes (WP-280) — with the sweep on a one-second pass and no skew grace.
 */
describe('a usage limit and a lost worker (WP-285, WP-286)', () => {
  const FAST_SWEEP = { APP_INTAKE_RECONCILE_INTERVAL_MS: '1000', APP_LEASE_SKEW_GRACE: '0' };

  const refinementRuns = (pipeline: PipelineE2E) =>
    pipeline.query<{
      id: string;
      status: string;
      terminal_reason: string | null;
      worker_id: string | null;
      excluded: string[];
    }>(
      `select r.id, r.status::text as status, r.terminal_reason::text as terminal_reason,
              r.worker_id, o.excluded_worker_ids as excluded
         from runs r join run_offers o on o.run_id = r.id
        where o.stage = 'refinement'
        order by r.created_at`,
    );

  const runningOn = (pipeline: PipelineE2E, workerId: string) =>
    pipeline.waitFor(`a run to be running on ${workerId}`, async () => {
      const rows = await pipeline.query(
        "select 1 from runs where status = 'running' and worker_id = $1",
        [workerId],
      );
      return rows.length === 1;
    });

  /** The clock past the lease: what a revocation writes (WP-280), and the sweep ends the row. */
  const expireLease = (pipeline: PipelineE2E, workerId: string) =>
    pipeline.query(
      `update runs set lease_expires_at = now() - interval '1 hour'
        where worker_id = $1 and status in ('starting', 'running')`,
      [workerId],
    );

  it('re-offers a stage a usage limit stopped once, taken by a second worker while the limited one pauses (WP-285 (6))', async () => {
    const topology = await core('worker-usage-limit');
    const { pipeline } = topology;
    await setExecution(pipeline, { mode: 'workers_only', prefer: 'workers' });
    const limited = await worker(topology, {
      name: 'limited-laptop',
      scenario: scenarioFor(pipeline, { refinement: { endsWith: 'usage_limit' } }),
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the limited worker to pause', async () => {
      const [row] = await pipeline.query<{ paused: boolean }>(
        'select paused_until > now() as paused from workers where id = $1',
        [limited.workerId],
      );
      return row?.paused === true;
    });
    const second = await worker(topology, { name: 'second-laptop' });
    await ready(pipeline);

    const runs = await refinementRuns(pipeline);
    expect(runs.map((run) => [run.status, run.terminal_reason, run.worker_id])).toEqual([
      ['failed', 'rate_limited', limited.workerId],
      ['completed', 'success', second.workerId],
    ]);
    // The re-planned offer excludes nobody (TD-031's 2026-11-05 amendment): the limited worker's own
    // pause kept it off; nobody was asked.
    expect(runs[1]?.excluded).toEqual([]);
    expect(await pipeline.query("select 1 from events where type = 'task.escalated'")).toEqual([]);
    const [entry] = await pipeline.query<{ usage_limited_runs: number }>(
      "select usage_limited_runs from task_stages where stage = 'refinement' and attempt = 1",
    );
    expect(entry?.usage_limited_runs).toBe(1);
    // The limited worker told the core when its limit resets, and took nothing after.
    const [paused] = await pipeline.query<{
      paused_reason: string;
      estimated: boolean;
      manual: boolean;
    }>(
      `select paused_reason, paused_until_estimated as estimated,
              manually_paused_at is not null as manual from workers where id = $1`,
      [limited.workerId],
    );
    expect(paused).toEqual({ paused_reason: 'usage_limited', estimated: false, manual: false });
    expect(limited.packages).toHaveLength(1);
    expect(limited.runtime.localState().usage_paused_until).not.toBeNull();
  }, 300_000);

  it('re-offers a stage a lost worker held once, to a second worker; a second loss of the entry needs a human (WP-286 (4))', async () => {
    const topology = await core('worker-lost', { pipelineEnv: FAST_SWEEP });
    const { pipeline } = topology;
    await setExecution(pipeline, { mode: 'workers_only', prefer: 'workers' });
    const hold = scenarioFor(pipeline, { refinement: { awaitSteers: 1 } });
    const firstLink = await startCoreProxy(topology.api.baseUrl);
    cleanups.push(() => firstLink.close());
    const first = await worker(topology, {
      name: 'closed-laptop',
      coreUrl: firstLink.url,
      scenario: hold,
    });
    await pipeline.publish([ticketMatched(pipeline)]);
    await runningOn(pipeline, first.workerId);

    // The laptop closes: nothing it sends reaches the core any more.
    firstLink.retarget(null);
    const secondLink = await startCoreProxy(topology.api.baseUrl);
    cleanups.push(() => secondLink.close());
    const second = await worker(topology, {
      name: 'second-laptop',
      coreUrl: secondLink.url,
      scenario: hold,
    });
    // Registered last, so it runs first: both machines reach the core again before they are
    // stopped, so each hand-back meets `lease_lost` at once instead of retrying a dark link until
    // self-termination (585 s) — what hung this case's teardown in CI.
    cleanups.push(async () => {
      firstLink.retarget(topology.api.baseUrl);
      secondLink.retarget(topology.api.baseUrl);
    });
    await expireLease(pipeline, first.workerId);
    // The sweep ends the run, re-plans the entry with the lost worker excluded; the second takes it.
    await runningOn(pipeline, second.workerId);
    let runs = await refinementRuns(pipeline);
    expect(runs.map((run) => [run.terminal_reason, run.worker_id])).toEqual([
      ['lease_expired', first.workerId],
      [null, second.workerId],
    ]);
    expect(runs[1]?.excluded).toEqual([first.workerId]);
    const [task] = await pipeline.query<{ state: string }>(
      'select state::text as state from tasks',
    );
    expect(task?.state).toBe('active');

    // The second machine goes dark too: the entry's second loss is a person's.
    secondLink.retarget(null);
    await expireLease(pipeline, second.workerId);
    await pipeline.waitFor('the task to need a human', async () => {
      const [row] = await pipeline.query<{ state: string }>(
        'select state::text as state from tasks',
      );
      return row?.state === 'needs_human';
    });
    runs = await refinementRuns(pipeline);
    expect(runs.map((run) => run.terminal_reason)).toEqual(['lease_expired', 'lease_expired']);
    const [brief] = await pipeline.query<{ brief: string }>(
      "select payload ->> 'blocker_brief' as brief from events where type = 'task.escalated'",
    );
    expect(brief?.brief).toContain(`run ${runs[0]?.id} (held by worker ${first.workerId})`);
    expect(brief?.brief).toContain(`run ${runs[1]?.id} (held by worker ${second.workerId})`);
  }, 300_000);
});
