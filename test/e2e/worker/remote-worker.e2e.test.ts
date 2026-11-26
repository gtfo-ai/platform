/**
 * **The first usable worker** — WP-283 criterion (4), its hybrid case and its cases from the
 * take-over on, with WP-293's pick only and S-26.4's version-5 worker. The topology (two `apps/server` processes, the
 * `remote-worker`s beside them) is `../support/remote-worker-topology.ts`; criteria 1 and 3–5 are
 * `remote-worker-claims.e2e.test.ts` and the re-offers `remote-worker-reoffer.e2e.test.ts`.
 *
 *  2. **Hybrid**: with the server's claimant full, the next run goes to the worker.
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
 * 11. **A version-5 worker still claims** (S-26.4's case, moved one version on again when protocol
 *     6 accepted `[5, 6]`, S-29.1): a worker that announces protocol 5 on every request runs a stage
 *     to completion through the core's version-5 shapes (a handshake without the instance name).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FAKE_DEPLOY_KEY } from '@platform/application';
import type { Id, JsonObject } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { GIT_INTEGRATION_ID } from '../support/pipeline.js';
import { E2E_UI_PUBLISHED_PORT } from '../support/remote-worker.js';
import {
  ready,
  remoteWorkerSuite,
  STATIC_RUN_TOKEN,
  scenarioFor,
  send,
  setExecution,
  signIn,
  switchRunCredential,
  ticketMatched,
  verifiesWithDeployKey,
} from '../support/remote-worker-topology.js';

const { cleanups, core, worker } = remoteWorkerSuite();

describe('the first usable worker (WP-283)', () => {
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
    // S-26.4: the page in this build still says *pick only* as `[]`. The worker sends the core the
    // policy — `pick_only` over every project, never the `[]` a protocol-4 core refuses — and the
    // page reads it back as its own `[]`.
    const scope = await page('POST', '/api/local/claim-scope', { claim_project_ids: [] });
    expect(scope.status, scope.body).toBe(200);
    expect(JSON.parse(scope.body)).toMatchObject({
      claim_project_ids: [],
      claim_policy: 'pick_only',
    });
    const [stored] = await pipeline.query<{ claim_policy: string; claim_project_ids: unknown }>(
      'select claim_policy, claim_project_ids from workers where id = $1',
      [laptop.workerId],
    );
    expect(stored).toEqual({ claim_policy: 'pick_only', claim_project_ids: null });
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
 * **A version-5 worker still claims** (S-26.4, criterion 6, moved on by protocols 5 and 6): protocol
 * 6 is accepted beside 5, so a worker one release behind — every request it sends announcing
 * `X-Worker-Protocol: 5` — handshakes,
 * claims the first stage by itself (its row has no policy, which reads `everything`) and settles it.
 * The core records the protocol it spoke.
 */
describe('a worker one protocol behind (S-26.4)', () => {
  it('claims and settles a run at protocol 5', async () => {
    const topology = await core('worker-protocol-5');
    const { pipeline } = topology;
    const laptop = await worker(topology, { name: 'v5-laptop', protocol: 5 });
    await pipeline.publish([ticketMatched(pipeline)]);
    await pipeline.waitFor('the v5 worker to settle a run it claimed', async () => {
      const rows = await pipeline.query<{ status: string }>(
        `select r.status::text as status from run_offers o join runs r on r.id = o.run_id
          where o.worker_id = $1 and r.status = 'completed'`,
        [laptop.workerId],
      );
      return rows.length > 0;
    });
    const sent = topology.captured.filter((request) => request.worker === 'v5-laptop');
    expect(sent.map((request) => request.verb)).toEqual(
      expect.arrayContaining(['handshake', 'claims']),
    );
    expect(sent.every((request) => request.headers['x-worker-protocol'] === '5')).toBe(true);
    const [row] = await pipeline.query<{ protocol_version: number }>(
      'select protocol_version from workers where id = $1',
      [laptop.workerId],
    );
    expect(row?.protocol_version).toBe(5);
  }, 300_000);
});
