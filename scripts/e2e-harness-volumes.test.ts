/**
 * The decision the e2e fixture's start sweep makes about the harness's own resources — the volumes
 * since WP-96 (PROGRESS backlog 7 bullet 8), the repository container and the network since WP-116
 * (backlog 329), the two HTTP servers, a stale network's attached containers and a dead fixture's
 * own run objects since WP-128 (backlogs 394, 395, 398) — pure, so it runs in the unit tier; the
 * sweep against a real daemon is `test/e2e/workspace/harness-volumes.e2e.test.ts`.
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
  INSTANCE_LABEL,
  type ListedResource,
  RUN_LABEL,
  removeInstanceRunObjects,
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
  // …and the two servers a killed case leaves on its network (WP-128, backlog 394). The first row
  // **flipped**: until WP-128 it sat with the lookalikes below, unmarked in production and refused
  // by the container shape, so a killed file's HTTP target was never swept.
  marked('agentic-e2e-http-k3j9x2'),
  marked('agentic-e2e-githttp-k3j9x2'),
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
  marked('agentic-e2e-https-k3j9x2'),
  marked('agentic-e2e-http-k3j9x2-backup'),
  marked('my-agentic-e2e-githttp-k3j9x2'),
  marked('agentic-e2e-http-'),
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
    [
      'container',
      ['agentic-e2e-githttp-k3j9x2', 'agentic-e2e-http-k3j9x2', 'agentic-e2e-repo-k3j9x2'],
    ],
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
  type Kind = 'container' | 'network' | 'volume';
  interface DoubleObject {
    readonly labels: Readonly<Record<string, string>>;
    /** A container's network. */
    readonly network?: string;
    /** A container's volumes. */
    readonly mounts?: readonly string[];
  }
  const harness = (pid: number) => ({ [HARNESS_LABEL]: 'true', [HARNESS_PID_LABEL]: String(pid) });
  const runOf = (instance: string) => ({
    [RUN_LABEL]: '00000000-0000-4000-8000-0000000000aa',
    [INSTANCE_LABEL]: instance,
  });
  const DEAD_INSTANCE = 'agentic-e2e-ctl-k3j9x2';
  const LIVE_INSTANCE = 'agentic-e2e-ctl-a1b2c3';
  /** A product instance's control volume — another consumer of the same daemon (backlog 398). */
  const PRODUCT_INSTANCE = 'agentic-ctl';
  const DEAD_RUN = 'run-00000000-0000-4000-8000-0000000000d1';
  const ATTACHED = 'run-00000000-0000-4000-8000-0000000000c1';
  /** Somebody's own container on a second dead harness network: neither label, so never ours. */
  const FOREIGN_ATTACHED = 'someones-debug-shell';
  const EXPORT = `export-${DEAD_RUN.slice(4)}`;

  /**
   * A daemon holding one stale resource of each kind and a live one beside it, which records every
   * call in order. Like the real daemon (and no kinder, standing rule 1), it refuses to remove a
   * network a container is still attached to; its `ls` answers the `name=` (substring), `label=k`,
   * `label=k=v` and `network=` filters the way the daemon does.
   *
   * Since WP-128 it also holds what a killed fixture's **provider** left: a sidecar-shaped
   * `run-<id>` container attached to the dead fixture's network, a run container, network and
   * volume labelled with the dead fixture's instance — and the same three of a product instance and
   * of a live fixture, which must survive.
   */
  const daemon = () => {
    const calls: string[] = [];
    const store: Record<Kind, Map<string, DoubleObject>> = {
      container: new Map<string, DoubleObject>([
        ['agentic-e2e-repo-k3j9x2', { labels: harness(DEAD), network: 'agentic-e2e-k3j9x2' }],
        ['agentic-e2e-repo-a1b2c3', { labels: harness(LIVE), network: 'agentic-e2e-a1b2c3' }],
        // Attached to the dead network, no marker (backlog 395): a run-shaped container with the run
        // label and no instance to join on — what only the attached-container step can name.
        [ATTACHED, { labels: { [RUN_LABEL]: ATTACHED.slice(4) }, network: 'agentic-e2e-k3j9x2' }],
        [FOREIGN_ATTACHED, { labels: {}, network: 'agentic-e2e-q9w8e7' }],
        // Attached too, and labelled with the dead instance: the sidecar of a run, which the
        // instance join names first.
        [
          `egress-${DEAD_RUN.slice(4)}`,
          { labels: runOf(DEAD_INSTANCE), network: 'agentic-e2e-k3j9x2' },
        ],
        // A kept `export` helper: the run label and no instance label, mounting the dead fixture's
        // cache volume — measured on the first `verify:e2e` over WP-128. Only the mount step names it.
        [
          EXPORT,
          { labels: { [RUN_LABEL]: DEAD_RUN.slice(4) }, mounts: ['agentic-e2e-cache-k3j9x2'] },
        ],
        // On its own run network only: removed by the instance join, never by the network.
        [DEAD_RUN, { labels: runOf(DEAD_INSTANCE), network: DEAD_RUN }],
        ['run-00000000-0000-4000-8000-0000000000e1', { labels: runOf(LIVE_INSTANCE) }],
        ['run-00000000-0000-4000-8000-0000000000f1', { labels: runOf(PRODUCT_INSTANCE) }],
      ]),
      network: new Map<string, DoubleObject>([
        ['agentic-e2e-k3j9x2', { labels: harness(DEAD) }],
        ['agentic-e2e-a1b2c3', { labels: harness(LIVE) }],
        ['agentic-e2e-q9w8e7', { labels: harness(DEAD) }],
        [DEAD_RUN, { labels: runOf(DEAD_INSTANCE) }],
        ['run-00000000-0000-4000-8000-0000000000f1', { labels: runOf(PRODUCT_INSTANCE) }],
      ]),
      volume: new Map<string, DoubleObject>([
        [DEAD_INSTANCE, { labels: harness(DEAD) }],
        ['agentic-e2e-cache-k3j9x2', { labels: harness(DEAD) }],
        [LIVE_INSTANCE, { labels: harness(LIVE) }],
        ['ws-00000000-0000-4000-8000-0000000000d1', { labels: runOf(DEAD_INSTANCE) }],
        ['ws-00000000-0000-4000-8000-0000000000f1', { labels: runOf(PRODUCT_INSTANCE) }],
      ]),
    };
    const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
    const refused = (stderr: string) => ({ ok: false, stdout: '', stderr });
    const matches = (name: string, object: DoubleObject, filter: string): boolean => {
      const [key, ...rest] = filter.split('=');
      const value = rest.join('=');
      if (key === 'name') return name.includes(value);
      if (key === 'network') return object.network === value;
      if (key === 'volume') return (object.mounts ?? []).includes(value);
      if (key === 'label') {
        const [label, ...expected] = value.split('=');
        const actual = object.labels[label as string];
        return expected.length === 0 ? actual !== undefined : actual === expected.join('=');
      }
      throw new Error(`the double does not know the filter ${filter}`);
    };
    const docker = async (args: readonly string[]) => {
      calls.push(args.join(' '));
      const [kind, verb] = args as [Kind, string];
      const objects = store[kind];
      const name = args.at(-1) as string;
      if (verb === 'ls') {
        const filters = args.flatMap((arg, index) => (args[index - 1] === '--filter' ? [arg] : []));
        const names = [...objects].filter(([n, object]) =>
          filters.every((filter) => matches(n, object, filter)),
        );
        return ok(names.map(([n]) => n).join('\n'));
      }
      if (verb === 'inspect') {
        const object = objects.get(name);
        return object === undefined ? refused('no such object') : ok(JSON.stringify(object.labels));
      }
      if (verb === 'rm') {
        if (!objects.has(name)) return refused(`no such ${kind}: ${name}`);
        if (kind === 'network' && [...store.container.values()].some((c) => c.network === name)) {
          return refused(`error while removing network: network ${name} has active endpoints`);
        }
        if (
          kind === 'volume' &&
          [...store.container.values()].some((c) => c.mounts?.includes(name))
        ) {
          return refused(`remove ${name}: volume is in use`);
        }
        objects.delete(name);
        return ok(name);
      }
      return refused(`unexpected: ${args.join(' ')}`);
    };
    return { calls, docker, store };
  };

  it('removes the stale container before its network, and the network before the volumes', async () => {
    const world = daemon();
    const swept = await sweepStaleHarnessResources(world.docker, isAlive);

    expect(swept).toEqual({
      instanceRuns: [
        `egress-${DEAD_RUN.slice(4)}`,
        DEAD_RUN,
        DEAD_RUN,
        'ws-00000000-0000-4000-8000-0000000000d1',
      ],
      container: ['agentic-e2e-repo-k3j9x2'],
      attached: [ATTACHED, EXPORT],
      network: ['agentic-e2e-k3j9x2'],
      volume: ['agentic-e2e-cache-k3j9x2', DEAD_INSTANCE],
    });
    const removals = world.calls.filter((call) => / rm /.test(call));
    expect(removals).toEqual([
      `container rm -f -v egress-${DEAD_RUN.slice(4)}`,
      `container rm -f -v ${DEAD_RUN}`,
      `network rm ${DEAD_RUN}`,
      'volume rm -f ws-00000000-0000-4000-8000-0000000000d1',
      'container rm -f -v agentic-e2e-repo-k3j9x2',
      `container rm -f -v ${ATTACHED}`,
      'network rm agentic-e2e-k3j9x2',
      'network rm agentic-e2e-q9w8e7',
      `container rm -f -v ${EXPORT}`,
      'volume rm agentic-e2e-cache-k3j9x2',
      `volume rm ${DEAD_INSTANCE}`,
    ]);
    // A live fixture's and a product instance's are untouched, of every kind.
    // An attached container with neither the run label nor the marker is left — and so, refused by
    // the daemon, is the dead network it holds.
    expect([...world.store.container.keys()]).toEqual([
      'agentic-e2e-repo-a1b2c3',
      FOREIGN_ATTACHED,
      'run-00000000-0000-4000-8000-0000000000e1',
      'run-00000000-0000-4000-8000-0000000000f1',
    ]);
    expect([...world.store.network.keys()]).toEqual([
      'agentic-e2e-a1b2c3',
      'agentic-e2e-q9w8e7',
      'run-00000000-0000-4000-8000-0000000000f1',
    ]);
    expect([...world.store.volume.keys()]).toEqual([
      LIVE_INSTANCE,
      'ws-00000000-0000-4000-8000-0000000000f1',
    ]);
  });

  it('refuses a network with a container attached, as the daemon does — the attached step’s reason (backlog 395)', async () => {
    // Calibrates the double: without this refusal the ordering case above would prove nothing.
    const world = daemon();
    const refusal = await world.docker(['network', 'rm', 'agentic-e2e-k3j9x2']);
    expect(refusal.ok).toBe(false);
    expect(refusal.stderr).toContain('active endpoints');
  });

  it('lists each kind with the marker filter, and one instance’s run objects with its exact label', async () => {
    const world = daemon();
    await sweepStaleHarnessResources(world.docker, isAlive);
    const kindListings = world.calls.filter(
      (call) => / ls /.test(call) && call.includes(`--filter label=${HARNESS_LABEL}`),
    );
    expect(kindListings.map((call) => call.split(' ')[0])).toEqual(['volume', ...HARNESS_KINDS]);
    const instanceListings = world.calls.filter((call) =>
      call.includes(`label=${INSTANCE_LABEL}=`),
    );
    expect(instanceListings).toHaveLength(3);
    for (const listing of instanceListings) {
      expect(listing).toContain(
        `--filter label=${RUN_LABEL} --filter label=${INSTANCE_LABEL}=${DEAD_INSTANCE}`,
      );
    }
    // Every listing is one of the three shapes: nothing on the daemon is listed unfiltered.
    for (const listing of world.calls.filter((call) => / ls /.test(call))) {
      expect(listing).toMatch(
        /--filter (label=com\.agentic\.e2e\.harness|label=com\.agentic\.run|network=agentic-e2e-(?:k3j9x2|q9w8e7)|volume=agentic-e2e-(?:ctl|cache)-k3j9x2)/,
      );
    }
  });

  it('removes exactly one instance’s run objects for a fixture’s cleanup (backlog 398)', async () => {
    const world = daemon();
    const removed = await removeInstanceRunObjects(world.docker, PRODUCT_INSTANCE);
    expect(removed).toEqual([
      'run-00000000-0000-4000-8000-0000000000f1',
      'run-00000000-0000-4000-8000-0000000000f1',
      'ws-00000000-0000-4000-8000-0000000000f1',
    ]);
    // The dead fixture's and the live fixture's are still there.
    expect(world.store.container.has(DEAD_RUN)).toBe(true);
    expect(world.store.container.has('run-00000000-0000-4000-8000-0000000000e1')).toBe(true);
    expect(world.store.volume.has('ws-00000000-0000-4000-8000-0000000000d1')).toBe(true);
  });
});
