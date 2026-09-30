/**
 * The start sweep of the harness's own volumes against the real daemon (WP-96, PROGRESS backlog 7
 * bullet 8): a volume it must remove beside a lookalike and a live run's. The decision itself is
 * pure and held against lookalikes in the unit tier, `scripts/e2e-harness-volumes.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { docker } from '../support/docker-workspace.js';
import { harnessVolumeLabels, sweepStaleHarnessVolumes } from '../support/harness-volumes.js';

describe('the sweep against the real daemon', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const stale = `agentic-e2e-ctl-${suffix}`;
  const lookalike = `agentic-e2e-ctl-${suffix}-keep`;
  const live = `agentic-e2e-cache-${suffix}`;
  // A pid that certainly belonged to a process which has exited: this one's own child.
  const deadPid = Number(
    execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']),
  );

  afterAll(async () => {
    await docker(['volume', 'rm', '-f', stale, lookalike, live], { allowFailure: true });
  });

  it('removes a dead run’s volume and leaves a lookalike and a live run’s volume', async () => {
    await docker(['volume', 'create', ...harnessVolumeLabels(deadPid), stale]);
    await docker(['volume', 'create', ...harnessVolumeLabels(deadPid), lookalike]);
    await docker(['volume', 'create', ...harnessVolumeLabels(process.pid), live]);

    const removed = await sweepStaleHarnessVolumes(docker);

    expect(removed).toContain(stale);
    const left = (await docker(['volume', 'ls', '-q', '--filter', `name=${suffix}`])).stdout
      .split('\n')
      .sort();
    expect(left).toEqual([live, lookalike].sort());
  });
});
