/**
 * **A stage re-offered once** — WP-285 (6) and WP-286 (4), split out of `remote-worker.e2e.test.ts`
 * with the topology it shares (`../support/remote-worker-topology.ts`). The describe block's own
 * docblock has the cases.
 */
import { describe, expect, it } from 'vitest';
import type { PipelineE2E } from '../support/pipeline.js';
import { startCoreProxy } from '../support/remote-worker.js';
import {
  ready,
  remoteWorkerSuite,
  scenarioFor,
  setExecution,
  ticketMatched,
} from '../support/remote-worker-topology.js';

const { cleanups, core, worker } = remoteWorkerSuite();

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
