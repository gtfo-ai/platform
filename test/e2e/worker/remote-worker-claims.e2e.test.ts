/**
 * **The first usable worker** — WP-283 criterion (4), its cases 1 and 3–5: two `apps/server`
 * processes (`ROLE=all` for the pipeline, `ROLE=api` for the worker protocol — neither with a
 * launcher) and one or two `remote-worker`s (`../support/remote-worker.ts`: the production
 * composition over HTTP, its own `apps/launcher` control plane relaying over the fake workspace
 * provider, the scripted Claude CLI). The topology is `../support/remote-worker-topology.ts`; the
 * other cases of the criterion (2 and 6–11) are `remote-worker.e2e.test.ts`, the re-offers
 * `remote-worker-reoffer.e2e.test.ts` — one file of 309 s until the split, which bounded a CI part.
 *
 *  1. A task runs to **Ready** on remote workers alone; two workers never run one offer; the Claude
 *     token reaches no request, no transcript row and no log line; every export precedes `finish`;
 *     the run page names the worker (`seat`); and an **ask** is claimed by the asker's worker inside
 *     its window, never by the other.
 *  3. A **core restart** mid-run is survived — the run outlives the API process on its lease.
 *  4. **Revoke** mid-run fences: the worker's next call is `401`, it stops and finishes nothing.
 *  5. **Steer and cancel** arrive on the heartbeat and are acked applied.
 */
import { describe, expect, it } from 'vitest';
import { startCoreProxy, WORKER_CLAUDE_TOKEN } from '../support/remote-worker.js';
import {
  adminId,
  QUESTION,
  ready,
  remoteWorkerSuite,
  scenarioFor,
  send,
  setExecution,
  signIn,
  stageRuns,
  ticketMatched,
} from '../support/remote-worker-topology.js';

const { cleanups, core, worker } = remoteWorkerSuite();

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
});
