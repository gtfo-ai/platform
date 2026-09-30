/**
 * The decision the e2e fixture's start sweep makes about the harness's own volumes (WP-96, PROGRESS
 * backlog 7 bullet 8) — pure, so it runs in the unit tier; the sweep against a real daemon is
 * `test/e2e/workspace/harness-volumes.e2e.test.ts`.
 *
 * It runs on a developer's daemon, where most volumes are somebody else's, so it is held against
 * a list of **lookalikes**. What the decision cannot see is stated in the module's docblock
 * (`test/e2e/support/harness-volumes.ts`): a daemon shared with another host or reached from a
 * separate pid namespace sees a live creator as dead; a volume still mounted survives because the
 * `rm` fails.
 */
import { describe, expect, it } from 'vitest';
import {
  HARNESS_LABEL,
  HARNESS_PID_LABEL,
  harnessVolumeLabels,
  type ListedVolume,
  staleHarnessVolumes,
} from '../test/e2e/support/harness-volumes.js';

const DEAD = 4_000_001;
const LIVE = 4_000_002;
const isAlive = (pid: number): boolean => pid === LIVE;
const marked = (name: string, pid: string | number = DEAD): ListedVolume => ({
  name,
  labels: { [HARNESS_LABEL]: 'true', [HARNESS_PID_LABEL]: String(pid) },
});

describe('which volumes the sweep may remove', () => {
  it('removes this repository’s two shapes, marked, whose creator is dead — and nothing that only looks like them', () => {
    const listed: ListedVolume[] = [
      marked('agentic-e2e-ctl-k3j9x2'),
      marked('agentic-e2e-cache-k3j9x2'),
      // Alive: a parallel file's fixture, mid-run.
      marked('agentic-e2e-ctl-a1b2c3', LIVE),
      // Our shape, no marker: made by hand, or by a run older than WP-96.
      { name: 'agentic-e2e-ctl-zzzzzz', labels: {} },
      { name: 'agentic-e2e-cache-zzzzzz', labels: { [HARNESS_PID_LABEL]: String(DEAD) } },
      {
        name: 'agentic-e2e-ctl-yyyyyy',
        labels: { [HARNESS_LABEL]: 'false', [HARNESS_PID_LABEL]: `${DEAD}` },
      },
      // Marked and dead, but not our exact name: prefixes, suffixes, other roles, other case.
      marked('my-agentic-e2e-ctl-k3j9x2'),
      marked('agentic-e2e-ctl-k3j9x2-backup'),
      marked('agentic-e2e-ctl-k3j9x2.old'),
      marked('agentic-e2e-repo-k3j9x2'),
      marked('agentic-e2e-data'),
      marked('agentic-e2e-'),
      marked('agentic-e2e-ctl-'),
      marked('agentic-e2e-ctl-K3J9X2'),
      marked('agentic-e2e-ctl-toolongsuffix'),
      marked('ws-00000000-0000-4000-8000-000000000001'),
      marked('postgres_data'),
      // Marked, our name, but no usable pid.
      marked('agentic-e2e-ctl-p1d000', ''),
      marked('agentic-e2e-ctl-p1d001', 'abc'),
      marked('agentic-e2e-ctl-p1d002', '0'),
      marked('agentic-e2e-ctl-p1d003', '-1'),
    ];
    expect(staleHarnessVolumes(listed, isAlive)).toEqual([
      'agentic-e2e-cache-k3j9x2',
      'agentic-e2e-ctl-k3j9x2',
    ]);
  });

  it('labels a volume with the marker and the creating pid, which is what the decision reads', () => {
    expect(harnessVolumeLabels(1234)).toEqual([
      '--label',
      `${HARNESS_LABEL}=true`,
      '--label',
      `${HARNESS_PID_LABEL}=1234`,
    ]);
  });
});
