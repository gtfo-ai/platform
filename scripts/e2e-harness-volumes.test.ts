/**
 * The decision the e2e fixture's start sweep makes about the harness's own resources — the volumes
 * since WP-96 (PROGRESS backlog 7 bullet 8), the repository container and the network since WP-116
 * (backlog 329) — pure, so it runs in the unit tier; the sweep against a real daemon is
 * `test/e2e/workspace/harness-volumes.e2e.test.ts`.
 *
 * It runs on a developer's daemon, where most containers, networks and volumes are somebody
 * else's, so it is held against one list of **lookalikes**, asked of every kind: each kind must take
 * exactly its own shape out of the same list. What the decision cannot see is stated in the
 * module's docblock (`test/e2e/support/harness-volumes.ts`): a daemon shared with another host or
 * reached from a separate pid namespace sees a live creator as dead; a volume still mounted
 * survives because the `rm` fails, and a network something is still attached to survives because
 * the daemon refuses it.
 */
import { describe, expect, it } from 'vitest';
import {
  HARNESS_KINDS,
  HARNESS_LABEL,
  HARNESS_PID_LABEL,
  type HarnessKind,
  harnessLabels,
  type ListedResource,
  staleHarnessResources,
  sweepStaleHarnessResources,
} from '../test/e2e/support/harness-volumes.js';

const DEAD = 4_000_001;
const LIVE = 4_000_002;
const isAlive = (pid: number): boolean => pid === LIVE;
const marked = (name: string, pid: string | number = DEAD): ListedResource => ({
  name,
  labels: { [HARNESS_LABEL]: 'true', [HARNESS_PID_LABEL]: String(pid) },
});

/** The same list for every kind: the four real shapes beside everything that only looks like one. */
const LISTED: readonly ListedResource[] = [
  // The four a killed fixture leaves, marked, creator dead.
  marked('agentic-e2e-ctl-k3j9x2'),
  marked('agentic-e2e-cache-k3j9x2'),
  marked('agentic-e2e-repo-k3j9x2'),
  marked('agentic-e2e-k3j9x2'),
  // Alive: a parallel file's fixture, mid-run — one of each kind.
  marked('agentic-e2e-ctl-a1b2c3', LIVE),
  marked('agentic-e2e-repo-a1b2c3', LIVE),
  marked('agentic-e2e-a1b2c3', LIVE),
  // Our shapes, no marker: made by hand, or by a run older than the kind's labelling.
  { name: 'agentic-e2e-ctl-zzzzzz', labels: {} },
  { name: 'agentic-e2e-cache-zzzzzz', labels: { [HARNESS_PID_LABEL]: String(DEAD) } },
  {
    name: 'agentic-e2e-ctl-yyyyyy',
    labels: { [HARNESS_LABEL]: 'false', [HARNESS_PID_LABEL]: `${DEAD}` },
  },
  { name: 'agentic-e2e-repo-zzzzzz', labels: {} },
  // WP-116 review round 1 (orchestrator): a creator pid but no marker — the case that tells the
  // marker filter apart from the pid test for a container.
  { name: 'agentic-e2e-repo-yyyyyy', labels: { [HARNESS_PID_LABEL]: String(DEAD) } },
  { name: 'agentic-e2e-zzzzzz', labels: { [HARNESS_PID_LABEL]: String(DEAD) } },
  // Marked and dead, but not an exact name of ours: prefixes, suffixes, other roles, other case.
  marked('my-agentic-e2e-ctl-k3j9x2'),
  marked('agentic-e2e-ctl-k3j9x2-backup'),
  marked('agentic-e2e-ctl-k3j9x2.old'),
  marked('my-agentic-e2e-repo-k3j9x2'),
  marked('agentic-e2e-repo-k3j9x2-backup'),
  marked('agentic-e2e-repo-K3J9X2'),
  marked('agentic-e2e-http-k3j9x2'),
  marked('agentic-e2e-k3j9x2_default'),
  marked('agentic-e2e-K3J9X2'),
  marked('agentic-e2e-'),
  marked('agentic-e2e-ctl-'),
  marked('agentic-e2e-repo-'),
  marked('agentic-e2e-ctl-K3J9X2'),
  marked('agentic-e2e-ctl-toolongsuffix'),
  marked('agentic-e2e-toolongsuffix'),
  marked('ws-00000000-0000-4000-8000-000000000001'),
  marked('run-00000000-0000-4000-8000-000000000001'),
  marked('postgres_data'),
  // Marked, our name, but no usable pid.
  marked('agentic-e2e-ctl-p1d000', ''),
  marked('agentic-e2e-ctl-p1d001', 'abc'),
  marked('agentic-e2e-ctl-p1d002', '0'),
  marked('agentic-e2e-ctl-p1d003', '-1'),
  marked('agentic-e2e-repo-p1d004', ''),
  marked('agentic-e2e-p1d005', 'abc'),
];

describe('which resources the sweep may remove', () => {
  it.each<[HarnessKind, string[]]>([
    ['volume', ['agentic-e2e-cache-k3j9x2', 'agentic-e2e-ctl-k3j9x2']],
    ['container', ['agentic-e2e-repo-k3j9x2']],
    ['network', ['agentic-e2e-k3j9x2']],
  ])(
    '%s: removes this repository’s own shape, marked, whose creator is dead — and nothing that only looks like it',
    (kind, expected) => {
      expect(staleHarnessResources(kind, LISTED, isAlive)).toEqual(expected);
    },
  );

  it('admits any one-to-eight character base-36 tail as a network suffix, so the marker and the pid carry that kind', () => {
    // Stated at the module: `agentic-e2e-data` is a suffix the network's name test cannot refuse.
    expect(staleHarnessResources('network', [marked('agentic-e2e-data')], isAlive)).toEqual([
      'agentic-e2e-data',
    ]);
    expect(
      staleHarnessResources('network', [{ name: 'agentic-e2e-data', labels: {} }], isAlive),
    ).toEqual([]);
  });

  it('labels a resource with the marker and the creating pid, which is what the decision reads', () => {
    expect(harnessLabels(1234)).toEqual([
      '--label',
      `${HARNESS_LABEL}=true`,
      '--label',
      `${HARNESS_PID_LABEL}=1234`,
    ]);
  });
});

describe('the sweep, against a daemon double', () => {
  /**
   * A daemon holding one stale resource of each kind and a live one beside it, which records every
   * call in order. Like the real daemon (and no kinder, standing rule 1), it refuses to remove a
   * network a container is still attached to.
   */
  const daemon = () => {
    const calls: string[] = [];
    const containers = new Map<string, number>([
      ['agentic-e2e-repo-k3j9x2', DEAD],
      ['agentic-e2e-repo-a1b2c3', LIVE],
    ]);
    const attached = new Map<string, string>([
      ['agentic-e2e-repo-k3j9x2', 'agentic-e2e-k3j9x2'],
      ['agentic-e2e-repo-a1b2c3', 'agentic-e2e-a1b2c3'],
    ]);
    const networks = new Map<string, number>([
      ['agentic-e2e-k3j9x2', DEAD],
      ['agentic-e2e-a1b2c3', LIVE],
    ]);
    const volumes = new Map<string, number>([
      ['agentic-e2e-ctl-k3j9x2', DEAD],
      ['agentic-e2e-ctl-a1b2c3', LIVE],
    ]);
    const labelsOf = (pid: number) =>
      JSON.stringify({ [HARNESS_LABEL]: 'true', [HARNESS_PID_LABEL]: String(pid) });
    const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
    const refused = (stderr: string) => ({ ok: false, stdout: '', stderr });
    const docker = async (args: readonly string[]) => {
      calls.push(args.join(' '));
      const [kind, verb] = args;
      const name = args.at(-1) as string;
      const store = kind === 'container' ? containers : kind === 'network' ? networks : volumes;
      if (verb === 'ls') return ok([...store.keys()].join('\n'));
      if (verb === 'inspect') {
        const pid = store.get(name);
        return pid === undefined ? refused('no such object') : ok(labelsOf(pid));
      }
      if (verb === 'rm') {
        if (kind === 'network' && [...attached.values()].includes(name)) {
          return refused(`error while removing network: network ${name} has active endpoints`);
        }
        if (kind === 'container') attached.delete(name);
        store.delete(name);
        return ok(name);
      }
      return refused(`unexpected: ${args.join(' ')}`);
    };
    return { calls, docker, containers, networks, volumes };
  };

  it('removes the stale container before its network, and the network before the volumes', async () => {
    const world = daemon();
    const swept = await sweepStaleHarnessResources(world.docker, isAlive);

    expect(swept).toEqual({
      container: ['agentic-e2e-repo-k3j9x2'],
      network: ['agentic-e2e-k3j9x2'],
      volume: ['agentic-e2e-ctl-k3j9x2'],
    });
    const removals = world.calls.filter((call) => / rm /.test(call));
    expect(removals).toEqual([
      'container rm -f -v agentic-e2e-repo-k3j9x2',
      'network rm agentic-e2e-k3j9x2',
      'volume rm agentic-e2e-ctl-k3j9x2',
    ]);
    // The live run's three are untouched.
    expect([...world.containers.keys()]).toEqual(['agentic-e2e-repo-a1b2c3']);
    expect([...world.networks.keys()]).toEqual(['agentic-e2e-a1b2c3']);
    expect([...world.volumes.keys()]).toEqual(['agentic-e2e-ctl-a1b2c3']);
  });

  it('lists each kind with the marker filter, and every kind it removes', async () => {
    const world = daemon();
    await sweepStaleHarnessResources(world.docker, isAlive);
    const listings = world.calls.filter((call) => / ls /.test(call));
    expect(listings).toHaveLength(HARNESS_KINDS.length);
    for (const listing of listings) {
      expect(listing).toContain(`--filter label=${HARNESS_LABEL}`);
    }
    expect(listings.map((call) => call.split(' ')[0])).toEqual([...HARNESS_KINDS]);
  });
});
