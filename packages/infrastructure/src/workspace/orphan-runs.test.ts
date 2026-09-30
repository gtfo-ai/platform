/**
 * TD-028 decision 12 at the Docker provider (WP-103, PROGRESS backlog 286): the listing the
 * launcher's read verb answers, and `destroyRun` for a run no handle names.
 *
 * Against the fake daemon, because the questions are about **which requests** go to the daemon and
 * what the provider concludes from its answers: that the listing filters by this instance's label
 * (criterion 5), that a run whose create was interrupted is listed by its helper container, and that
 * a destroy by id removes every labelled container, the sidecar's configuration volume, the network
 * and the control directory — after which WP-86's `run_alive` count for that run drops to nothing
 * (criterion 3). What a real daemon does with the same requests is
 * `scripts/launcher-control-plane-check.mjs`'s, which lists and destroys the orphans it measured.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_LABELS } from '@platform/application';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerEngine } from './engine.js';
import { SKILL_CATALOGUE_FIXTURE, shortTempDir, workspaceSpecFixture } from './fixtures.js';
import { DockerWorkspaceProvider } from './provider.js';
import { type FakeContainer, FakeDockerDaemon } from './testing.js';

const RUN_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const RUN_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const CONTROL_VOLUME = 'ctl';
const NOW = new Date('2026-09-30T12:00:00.000Z');

let daemon: FakeDockerDaemon;
let provider: DockerWorkspaceProvider;
let workDir: string;
/** What the `ctlls-*` helper prints — the control directories `find` would have listed. */
let controlListing: string;

beforeEach(async () => {
  controlListing = '';
  workDir = await shortTempDir('agentic-wp103-');
  const controlRoot = path.join(workDir, 'ctl');
  await mkdir(controlRoot, { recursive: true });
  daemon = new FakeDockerDaemon({
    now: () => NOW.getTime(),
    script: (container) =>
      container.name.startsWith('ctlls-')
        ? { exitCode: 0, logs: controlListing }
        : { exitCode: 0, logs: '' },
  });
  const socketPath = await daemon.start();
  daemon.seedSubpath('repo-cache', 'acme.git');
  daemon.networks.set('net-platform', { name: 'platform', internal: false });
  provider = new DockerWorkspaceProvider({
    engine: new DockerEngine({ socketPath }),
    images: {
      runtime: 'platform-runtime:test',
      egress: 'tinyproxy:test',
      git: 'git:test',
      runtimeSourceDir: null,
    },
    controlVolume: CONTROL_VOLUME,
    controlRoot,
    cacheVolume: 'repo-cache',
    helperNetwork: 'platform',
    egressNetwork: 'platform',
    runnerUid: 1000,
    skills: SKILL_CATALOGUE_FIXTURE,
    now: () => NOW,
  });
});

afterEach(async () => {
  await daemon.stop();
  await rm(workDir, { recursive: true, force: true });
});

/** A container the daemon holds for a run, as another launcher (or an older build) left it. */
const plant = (
  id: string,
  name: string,
  labels: Record<string, string>,
  state: FakeContainer['state'] = 'running',
  created = Math.floor(NOW.getTime() / 1000) - 7_200,
): void => {
  daemon.containers.set(id, {
    id,
    name,
    body: { Labels: labels },
    state,
    exitCode: 0,
    logs: '',
    networks: [],
    created,
  });
};

const runLabels = (runId: string, role: string, instance: string | null = CONTROL_VOLUME) => ({
  [WORKSPACE_LABELS.run]: runId,
  [WORKSPACE_LABELS.role]: role,
  ...(instance === null ? {} : { [WORKSPACE_LABELS.instance]: instance }),
});

describe('the listing verb reads the daemon (WP-103)', () => {
  it('labels every object a create makes with this instance, and lists the run from them', async () => {
    await provider.create(workspaceSpecFixture({ runId: RUN_A }));
    const labelled = daemon.history.filter(
      (container) => container.body.Labels?.[WORKSPACE_LABELS.run] === RUN_A,
    );
    expect(labelled.length).toBeGreaterThan(0);
    // Criterion 5: the instance is on every container the create labelled for the run.
    expect(
      labelled.every(
        (container) => container.body.Labels?.[WORKSPACE_LABELS.instance] === CONTROL_VOLUME,
      ),
    ).toBe(true);
    const listed = await provider.listLabelledRuns();
    expect(listed).toEqual([{ runId: RUN_A, createdAt: NOW.toISOString(), running: true }]);
  });

  it('lists a run whose create was interrupted by the helper it left, stopped or not', async () => {
    // Backlog 286 (a), measured: a launcher stopped during a create left `clone-<run-id>` running,
    // one killed left `prep-<run-id>` created — and no run container either time.
    plant('c1', `clone-${RUN_A}`, runLabels(RUN_A, 'clone'), 'running');
    plant('c2', `prep-${RUN_B}`, runLabels(RUN_B, 'prepare'), 'created');
    const listed = await provider.listLabelledRuns();
    expect(listed.map((run) => [run.runId, run.running])).toEqual([
      [RUN_A, true],
      [RUN_B, false],
    ]);
    // Dated by the daemon's `Created`, not by this process' clock.
    expect(listed[0]?.createdAt).toBe(new Date(NOW.getTime() - 7_200_000).toISOString());
  });

  it('never lists another instance’s run, or a container from before the instance label', async () => {
    // Criterion 5's negative: a second instance on the same daemon, and an older build's orphan.
    plant('other', `ws-${RUN_A}`, runLabels(RUN_A, 'workspace', 'agentic-staging-ctl'));
    plant('older', `ws-${RUN_B}`, runLabels(RUN_B, 'workspace', null));
    expect(await provider.listLabelledRuns()).toEqual([]);
    await expect(provider.destroyRun(RUN_A)).resolves.toEqual({ found: false });
    // Nothing of the other instance's was stopped or removed.
    expect(daemon.containers.has('other')).toBe(true);
    expect(daemon.containers.get('other')?.state).toBe('running');
  });

  it('asks the daemon with both labels, so the filter is the daemon’s and not a loop here', async () => {
    await provider.listLabelledRuns();
    const listing = daemon.requests.find(
      (request) => request.method === 'GET' && request.path === '/containers/json',
    );
    const filters = JSON.parse(
      decodeURIComponent(new URLSearchParams(listing?.query ?? '').get('filters') ?? '{}'),
    ) as { label?: string[] };
    expect(filters.label).toEqual([
      WORKSPACE_LABELS.run,
      `${WORKSPACE_LABELS.instance}=${CONTROL_VOLUME}`,
    ]);
  });
});

describe('destroy by run id (WP-103)', () => {
  it('removes a created run with no handle: container, sidecar, network, egress volume, control directory', async () => {
    const handle = await provider.create(workspaceSpecFixture({ runId: RUN_A }));
    expect(handle.sidecarContainerId).not.toBeNull();
    await expect(provider.destroyRun(RUN_A)).resolves.toEqual({ found: true });
    const left = [...daemon.containers.values()].filter(
      (container) => container.body.Labels?.[WORKSPACE_LABELS.run] === RUN_A,
    );
    expect(left.map((container) => container.name)).toEqual([]);
    expect([...daemon.networks.values()].map((network) => network.name)).not.toContain(
      `run-${RUN_A}`,
    );
    expect(daemon.volumes.has(`egress-${RUN_A}`)).toBe(false);
    // The workspace volume is retention's, exactly as `destroy` leaves it.
    expect(daemon.volumes.has(`ws-${RUN_A}`)).toBe(true);
    const helpers = daemon.history.map((container) => container.name);
    expect(helpers).toContain(`ctlempty-${RUN_A}`);
    expect(helpers).toContain(`ctlrm-${RUN_A}`);
    // Stop before remove for the run container, as `destroy` orders it.
    const container = handle.containerId;
    const ops = daemon.requests
      .filter((request) => request.path.includes(`/containers/${container}`))
      .map((request) => request.method);
    expect(ops.indexOf('POST')).toBeLessThan(ops.indexOf('DELETE'));
  });

  it('removes the helper an interrupted create left, and answers a repeat as found: false', async () => {
    plant('c1', `clone-${RUN_A}`, runLabels(RUN_A, 'clone'));
    await expect(provider.destroyRun(RUN_A)).resolves.toEqual({ found: true });
    expect(daemon.containers.has('c1')).toBe(false);
    await expect(provider.destroyRun(RUN_A)).resolves.toEqual({ found: false });
  });

  it('refuses a run id that is not a uuid before it asks the daemon anything', async () => {
    const before = daemon.requests.length;
    await expect(provider.destroyRun('../ctl')).rejects.toMatchObject({ code: 'invalid_spec' });
    expect(daemon.requests.length).toBe(before);
  });

  it('moves WP-86’s run_alive count: kept while the orphan runs, gone after it is destroyed (criterion 3)', async () => {
    await provider.create(workspaceSpecFixture({ runId: RUN_A }));
    controlListing = `${RUN_A}\n`;
    const aliveCount = async (): Promise<number> =>
      (await provider.purgeExpired(new Date('2026-10-01T12:00:00.000Z'))).controlDirectories.filter(
        (entry) => entry.keptReason === 'run_alive',
      ).length;
    expect(await aliveCount()).toBe(1);
    await provider.destroyRun(RUN_A);
    // The directory itself went with the destroy (`ctlrm-<run-id>` above); a listing that still
    // named it would now find no container holding it, so it is never `run_alive` again.
    expect(await aliveCount()).toBe(0);
  });
});

/**
 * WP-118 pre-review round (orchestrator), measured on the daemon: a launcher **killed** after the
 * create's first object — the run's network — and before its first container left the network, the
 * workspace volume and the control directory and **no labelled container**, so a listing of
 * containers alone never named the run and the reaper never removed it.
 */
describe('a run a killed create left with only its network', () => {
  /** A `run-<id>` network as `create` labels it, planted with nothing attached. */
  const plantNetwork = (runId: string, instance: string | null, created: string): void => {
    const id = `net-${runId}`;
    daemon.networks.set(id, { name: `run-${runId}`, internal: true });
    daemon.networkMeta.set(id, {
      labels: runLabels(runId, 'network', instance),
      created,
    });
  };

  it('labels the network a create makes with the run and this instance', async () => {
    await provider.create(workspaceSpecFixture({ runId: RUN_A }));
    const id = [...daemon.networks.entries()].find(([, n]) => n.name === `run-${RUN_A}`)?.[0];
    expect(daemon.networkMeta.get(id ?? '')?.labels).toMatchObject({
      [WORKSPACE_LABELS.run]: RUN_A,
      [WORKSPACE_LABELS.instance]: CONTROL_VOLUME,
      [WORKSPACE_LABELS.role]: 'network',
    });
  });

  it('is listed, not running, dated by the network’s Created', async () => {
    plantNetwork(RUN_A, CONTROL_VOLUME, new Date(NOW.getTime() - 3_600_000).toISOString());
    expect(await provider.listLabelledRuns()).toEqual([
      {
        runId: RUN_A,
        createdAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
        running: false,
      },
    ]);
  });

  it('is not listed when the network is another instance’s, or from before the instance label', async () => {
    plantNetwork(RUN_A, 'agentic-staging-ctl', NOW.toISOString());
    plantNetwork(RUN_B, null, NOW.toISOString());
    expect(await provider.listLabelledRuns()).toEqual([]);
  });

  it('is destroyed by id with no container: the network and the control directory go, found: true', async () => {
    plantNetwork(RUN_A, CONTROL_VOLUME, NOW.toISOString());
    await expect(provider.destroyRun(RUN_A)).resolves.toEqual({ found: true });
    expect([...daemon.networks.values()].map((network) => network.name)).not.toContain(
      `run-${RUN_A}`,
    );
    const helpers = daemon.history.map((container) => container.name);
    expect(helpers).toContain(`ctlrm-${RUN_A}`);
    expect(await provider.listLabelledRuns()).toEqual([]);
  });
});
