/**
 * The start sweep of the harness's own resources against the real daemon — the volumes since WP-96
 * (PROGRESS backlog 7 bullet 8), the repository container and the network since WP-116 (backlog
 * 329), a labelled HTTP server and a run-shaped container attached to the stale network since
 * WP-128 (backlogs 394, 395): a resource of each kind it must remove beside a lookalike and a live
 * run's. The decision itself is pure and held against lookalikes in the unit tier,
 * `scripts/e2e-harness-volumes.test.ts`.
 *
 * And the fixture's **cleanup** against the real daemon (WP-128, backlog 398): it removes its own
 * instance's run objects and the unlabelled `ws-<uuid>` volume, and leaves another instance's.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALPINE_IMAGE,
  type DockerFixture,
  docker,
  startDockerFixture,
} from '../support/docker-workspace.js';
import {
  harnessLabels,
  INSTANCE_LABEL,
  RUN_LABEL,
  sweepStaleHarnessResources,
} from '../support/harness-volumes.js';

describe('the sweep against the real daemon', () => {
  // Six characters always (the fixture's own suffix can be shorter), so the name filters below
  // cannot match somebody else's resource by a one-letter accident.
  const suffix = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  const stale = `agentic-e2e-ctl-${suffix}`;
  const lookalike = `agentic-e2e-ctl-${suffix}-keep`;
  const live = `agentic-e2e-cache-${suffix}`;
  // A dead run's network with its repository container still **running** on it — the state a
  // killed file leaves, since the container's process never exits — beside a live run's pair and a
  // lookalike of each. The live run's suffix differs only in its last character.
  const liveSuffix = `${suffix.slice(0, -1)}${suffix.endsWith('z') ? 'y' : 'z'}`;
  const staleNetwork = `agentic-e2e-${suffix}`;
  const staleContainer = `agentic-e2e-repo-${suffix}`;
  const liveNetwork = `agentic-e2e-${liveSuffix}`;
  const liveContainer = `agentic-e2e-repo-${liveSuffix}`;
  const lookalikeNetwork = `agentic-e2e-${suffix}-keep`;
  const lookalikeContainer = `agentic-e2e-repo-${suffix}-keep`;
  // WP-128: a killed case's HTTP server, marked like the repository container (backlog 394), and a
  // run-shaped container with only the run label — nothing the instance join can name, so only the
  // attached-container step reaches it (backlog 395). Both on the dead run's network.
  const staleServer = `agentic-e2e-http-${suffix}`;
  const attachedRunId = randomUUID();
  const attachedRun = `run-${attachedRunId}`;
  /**
   * The "dead run" is a real child process that is **alive while the resources are made** and is
   * killed just before the sweep — the killed-file case itself. A pid that was dead from the start
   * lets a parallel file's fixture (every fixture sweeps at start) remove the stale network between
   * its `network create` and the `docker run` that attaches the container, which is how the first
   * `verify:e2e` over this case failed (*network … not found*). The child ends itself after two
   * minutes, so a test process killed mid-case leaves no process behind (standing rule 25).
   */
  let creator: ChildProcess | undefined;
  const spawnCreator = (): ChildProcess =>
    spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120_000)'], { stdio: 'ignore' });
  const killCreator = async (): Promise<void> => {
    const child = creator;
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;
  };

  afterAll(async () => {
    await killCreator();
    await docker(
      [
        'rm',
        '-f',
        '-v',
        staleContainer,
        liveContainer,
        lookalikeContainer,
        staleServer,
        attachedRun,
      ],
      { allowFailure: true },
    );
    for (const network of [staleNetwork, liveNetwork, lookalikeNetwork]) {
      await docker(['network', 'rm', network], { allowFailure: true });
    }
    await docker(['volume', 'rm', '-f', stale, lookalike, live], { allowFailure: true });
  });

  const runOn = async (name: string, network: string, pid: number): Promise<void> => {
    await docker([
      'run',
      '-d',
      '--name',
      name,
      ...harnessLabels(pid),
      '--network',
      network,
      ALPINE_IMAGE,
      'sleep',
      '600',
    ]);
  };

  it('removes a dead run’s container, then its network, then its volume, and leaves lookalikes and a live run’s', async () => {
    creator = spawnCreator();
    const deadPid = creator.pid as number;
    expect(deadPid).toBeGreaterThan(0);
    await docker(['volume', 'create', ...harnessLabels(deadPid), stale]);
    await docker(['volume', 'create', ...harnessLabels(deadPid), lookalike]);
    await docker(['volume', 'create', ...harnessLabels(process.pid), live]);
    await docker(['network', 'create', ...harnessLabels(deadPid), staleNetwork]);
    await docker(['network', 'create', ...harnessLabels(process.pid), liveNetwork]);
    await docker(['network', 'create', ...harnessLabels(deadPid), lookalikeNetwork]);
    await runOn(staleContainer, staleNetwork, deadPid);
    await runOn(liveContainer, liveNetwork, process.pid);
    await runOn(lookalikeContainer, lookalikeNetwork, deadPid);
    await runOn(staleServer, staleNetwork, deadPid);
    await docker([
      'run',
      '-d',
      '--name',
      attachedRun,
      '--label',
      `${RUN_LABEL}=${attachedRunId}`,
      '--network',
      staleNetwork,
      ALPINE_IMAGE,
      'sleep',
      '600',
    ]);

    // The run is killed: from here on its resources are stale to every sweep, ours or a parallel
    // file's.
    await killCreator();
    const swept = await sweepStaleHarnessResources(docker);

    // What it named, it may name: never a live run's resource or a lookalike. Whether *this* call or
    // a parallel file's fixture removed the stale three is a race this test does not own (every
    // fixture sweeps at start), so the removal is asserted on the daemon's end state below.
    const named = [
      ...swept.instanceRuns,
      ...swept.container,
      ...swept.attached,
      ...swept.network,
      ...swept.volume,
    ];
    for (const kept of [
      live,
      lookalike,
      liveNetwork,
      liveContainer,
      lookalikeNetwork,
      lookalikeContainer,
    ]) {
      expect(named).not.toContain(kept);
    }
    // The daemon refuses to remove a network a container is still attached to, and the stale
    // container was running on it: the network being gone is the evidence the container went first.
    const names = async (args: readonly string[]) =>
      (await docker(args)).stdout
        .split('\n')
        .filter(
          (line) =>
            line.includes(suffix) || line.includes(liveSuffix) || line.includes(attachedRunId),
        )
        .sort();
    expect(await names(['volume', 'ls', '--format', '{{.Name}}'])).toEqual(
      [live, lookalike].sort(),
    );
    expect(await names(['container', 'ls', '-a', '--format', '{{.Names}}'])).toEqual(
      [liveContainer, lookalikeContainer].sort(),
    );
    expect(await names(['network', 'ls', '--format', '{{.Name}}'])).toEqual(
      [liveNetwork, lookalikeNetwork].sort(),
    );
  });
});

/**
 * The fixture's cleanup removes **its own** instance's run objects and no other's (WP-128, PROGRESS
 * backlog 398). Until WP-128 it removed every `com.agentic.run` container, network and volume on
 * the daemon, and every `ws-<uuid>` volume by name — measured beside a disposable product
 * instance's held run, which it removed.
 *
 * Planted here: one container, network and workspace volume labelled as **another** instance's
 * launcher labels them, the same three labelled with this fixture's instance, and one unlabelled
 * `ws-<uuid>` volume (the shape the cleanup's name sweep exists for). This test's own `afterAll`
 * removes what the cleanup must leave, so nothing outlives the file on any exit path that reaches
 * it.
 */
describe('the fixture’s cleanup against the real daemon', () => {
  const other = `agentic-wp128-other-${Math.random().toString(36).slice(2, 8)}-ctl`;
  const foreignRun = randomUUID();
  const ownRun = randomUUID();
  const unlabelledRun = randomUUID();
  let fixture: DockerFixture | undefined;

  afterAll(async () => {
    await fixture?.cleanup();
    await docker(['rm', '-f', '-v', `run-${foreignRun}`, `run-${ownRun}`], { allowFailure: true });
    await docker(['network', 'rm', `run-${foreignRun}`], { allowFailure: true });
    await docker(['network', 'rm', `run-${ownRun}`], { allowFailure: true });
    await docker(
      ['volume', 'rm', '-f', `ws-${foreignRun}`, `ws-${ownRun}`, `ws-${unlabelledRun}`],
      { allowFailure: true },
    );
  }, 180_000);

  /** One run's container, network and workspace volume, labelled as `instance`'s launcher would. */
  const plantRun = async (runId: string, instance: string): Promise<void> => {
    const labels = ['--label', `${RUN_LABEL}=${runId}`, '--label', `${INSTANCE_LABEL}=${instance}`];
    await docker(['network', 'create', ...labels, `run-${runId}`]);
    await docker(['volume', 'create', ...labels, `ws-${runId}`]);
    await docker([
      'run',
      '-d',
      '--name',
      `run-${runId}`,
      ...labels,
      '--network',
      `run-${runId}`,
      '-v',
      `ws-${runId}:/work`,
      ALPINE_IMAGE,
      'sleep',
      '600',
    ]);
  };

  it('leaves another instance’s run container, network and volume, and removes its own and the unlabelled ws-<uuid>', async () => {
    fixture = await startDockerFixture({ controlVolumeBind: false });
    await plantRun(foreignRun, other);
    await plantRun(ownRun, fixture.controlVolume);
    await docker(['volume', 'create', `ws-${unlabelledRun}`]);

    await fixture.cleanup();

    const present = async (args: readonly string[]) =>
      (await docker([...args, '--format', '{{.Name}}'])).stdout.split('\n').filter(Boolean);
    const containers = (await docker(['container', 'ls', '-a', '--format', '{{.Names}}'])).stdout
      .split('\n')
      .filter(Boolean);
    const networks = await present(['network', 'ls']);
    const volumes = await present(['volume', 'ls']);

    // Another instance's — a neighbouring product instance's held run — survives, every kind.
    expect(containers).toContain(`run-${foreignRun}`);
    expect(networks).toContain(`run-${foreignRun}`);
    expect(volumes).toContain(`ws-${foreignRun}`);
    expect(
      (
        await docker([
          'container',
          'inspect',
          '--format',
          '{{.State.Running}}',
          `run-${foreignRun}`,
        ])
      ).stdout,
    ).toBe('true');
    // Its own, and the unlabelled workspace volume, are gone.
    expect(containers).not.toContain(`run-${ownRun}`);
    expect(networks).not.toContain(`run-${ownRun}`);
    expect(volumes).not.toContain(`ws-${ownRun}`);
    expect(volumes).not.toContain(`ws-${unlabelledRun}`);
  }, 300_000);
});
