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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * The daemon and the provider over it. WP-157 review round 1's live-helper case builds a second one
 * whose daemon stamps containers two hours early and holds `wait` open, so a helper is live and old.
 */
const startWorld = async (
  extra: {
    readonly daemonNow?: () => number;
    readonly waitDelayFor?: (container: FakeContainer) => number | undefined;
    readonly fail?: Map<string, { status: number; message: string }>;
  } = {},
): Promise<void> => {
  const controlRoot = path.join(workDir, 'ctl');
  await mkdir(controlRoot, { recursive: true });
  daemon = new FakeDockerDaemon({
    now: extra.daemonNow ?? (() => NOW.getTime()),
    ...(extra.waitDelayFor === undefined ? {} : { waitDelayFor: extra.waitDelayFor }),
    ...(extra.fail === undefined ? {} : { fail: extra.fail }),
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
};

beforeEach(async () => {
  controlListing = '';
  workDir = await shortTempDir('agentic-wp103-');
  await startWorld();
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

/**
 * WP-157 (c), PROGRESS backlog 431: retention lists **this instance's** volumes, as the listing verb
 * lists this instance's runs — another instance's expired workspace and its hold are never touched.
 */
describe('retention on a daemon two instances share (WP-157 (c))', () => {
  const EXPIRED = '2026-09-01T00:00:00.000Z';
  const volumeLabels = (runId: string, role: string, instance: string | null) => ({
    ...runLabels(runId, role, instance),
    [WORKSPACE_LABELS.keepUntil]: EXPIRED,
  });

  it('removes this instance’s expired volume and never another instance’s', async () => {
    daemon.volumes.set(`ws-${RUN_A}`, volumeLabels(RUN_A, 'workspace', CONTROL_VOLUME));
    daemon.volumes.set(`ws-${RUN_B}`, volumeLabels(RUN_B, 'workspace', 'agentic-staging-ctl'));
    daemon.volumes.set(
      `hold-${RUN_B}`,
      volumeLabels(RUN_B, 'retention_hold', 'agentic-staging-ctl'),
    );
    const report = await provider.purgeExpired(NOW);
    expect(report.volumes.map((volume) => [volume.volumeName, volume.removed])).toEqual([
      [`ws-${RUN_A}`, true],
    ]);
    expect(daemon.volumes.has(`ws-${RUN_A}`)).toBe(false);
    // The other instance's workspace and its hold survive, and neither was examined.
    expect(daemon.volumes.has(`ws-${RUN_B}`)).toBe(true);
    expect(daemon.volumes.has(`hold-${RUN_B}`)).toBe(true);
  });

  /**
   * Review round 1: a workspace carries the instance label since WP-103, a hold only since WP-132.
   * An unlabelled hold beside a labelled workspace must still keep it — and is never removed here.
   */
  it('keeps a workspace its unlabelled pre-WP-132 hold still holds, and removes only its own holds', async () => {
    daemon.volumes.set(`ws-${RUN_A}`, volumeLabels(RUN_A, 'workspace', CONTROL_VOLUME));
    daemon.volumes.set(`hold-${RUN_A}`, {
      ...volumeLabels(RUN_A, 'retention_hold', null),
      [WORKSPACE_LABELS.keepUntil]: '2026-10-14T00:00:00.000Z',
    });
    // An expired workspace of this instance whose hold is its own: both go.
    daemon.volumes.set(`ws-${RUN_B}`, volumeLabels(RUN_B, 'workspace', CONTROL_VOLUME));
    daemon.volumes.set(`hold-${RUN_B}`, volumeLabels(RUN_B, 'retention_hold', CONTROL_VOLUME));
    // Another instance's expired hold: never removed by this sweep.
    const RUN_C = 'cccccccc-3333-4333-8333-333333333333';
    daemon.volumes.set(
      `hold-${RUN_C}`,
      volumeLabels(RUN_C, 'retention_hold', 'agentic-staging-ctl'),
    );
    await provider.purgeExpired(NOW);
    expect(daemon.volumes.has(`ws-${RUN_A}`)).toBe(true);
    expect(daemon.volumes.has(`hold-${RUN_A}`)).toBe(true);
    expect(daemon.volumes.has(`ws-${RUN_B}`)).toBe(false);
    expect(daemon.volumes.has(`hold-${RUN_B}`)).toBe(false);
    expect(daemon.volumes.has(`hold-${RUN_C}`)).toBe(true);
  });

  it('asks the daemon for this instance’s workspaces and for every hold', async () => {
    await provider.purgeExpired(NOW);
    const listings = daemon.requests
      .filter((request) => request.method === 'GET' && request.path === '/volumes')
      .map(
        (request) =>
          (
            JSON.parse(
              decodeURIComponent(new URLSearchParams(request.query ?? '').get('filters') ?? '{}'),
            ) as { label?: string[] }
          ).label,
      );
    const instance = `${WORKSPACE_LABELS.instance}=${CONTROL_VOLUME}`;
    // The holds by role only (review round 1): the decision must see a pre-WP-132 hold.
    expect(listings).toEqual([
      [`${WORKSPACE_LABELS.role}=workspace`, instance],
      [`${WORKSPACE_LABELS.role}=retention_hold`],
    ]);
  });
});

/**
 * WP-157 (d), PROGRESS backlog 430: a helper that belongs to no run (`cli-check`, `mirror`,
 * `control-sweep`) carries the instance label and no run label, so the run-keyed orphan pass never
 * lists it. The retention pass removes this instance's such helpers once they are over an hour old.
 */
describe('a helper that belongs to no run (WP-157 (d))', () => {
  const helperLabels = (role: string, instance: string | null = CONTROL_VOLUME) => ({
    [WORKSPACE_LABELS.role]: role,
    ...(instance === null ? {} : { [WORKSPACE_LABELS.instance]: instance }),
  });
  const secondsAgo = (seconds: number): number => Math.floor(NOW.getTime() / 1000) - seconds;

  it('removes this instance’s run-less helpers older than an hour, and keeps everything else', async () => {
    plant('old-check', 'clicheck-abc', helperLabels('cli-check'), 'exited', secondsAgo(3_700));
    plant('old-sweep', 'ctlls-abc', helperLabels('control-sweep'), 'running', secondsAgo(7_200));
    plant('old-mirror', 'mirror-x', helperLabels('mirror'), 'created', secondsAgo(86_400));
    // The age bound: a helper younger than an hour may be a live launcher call.
    plant('young', 'clicheck-new', helperLabels('cli-check'), 'running', secondsAgo(3_500));
    // Another instance's helper, and one from before the instance label.
    plant(
      'other',
      'clicheck-o',
      helperLabels('cli-check', 'agentic-staging-ctl'),
      'exited',
      secondsAgo(86_400),
    );
    plant('older', 'clicheck-p', helperLabels('cli-check', null), 'exited', secondsAgo(86_400));
    // A run's own container, however old, is the run-keyed pass's, never this one's.
    plant('run', `ws-${RUN_A}`, runLabels(RUN_A, 'workspace'), 'running', secondsAgo(86_400));
    await provider.purgeExpired(NOW);
    expect([...daemon.containers.keys()].sort()).toEqual(['older', 'other', 'run', 'young']);
  });

  /**
   * Review round 1: `#helper` has no timeout, so a first mirror clone of a large repository can be
   * live past the hour. The pass skips a helper a live call of this process is waiting on, and
   * still reaps an orphan of the same age.
   */
  it('keeps a live helper older than an hour, and reaps an orphan of the same age', async () => {
    await daemon.stop();
    await startWorld({
      daemonNow: () => NOW.getTime() - 7_200_000,
      // The mirror clone is long; the pass's own control-sweep helper answers at once.
      waitDelayFor: (container) =>
        container.body.Labels?.[WORKSPACE_LABELS.role] === 'mirror' ? 1_500 : undefined,
    });
    plant('orphan', 'clicheck-orphan', helperLabels('cli-check'), 'exited', secondsAgo(7_200));
    const mirror = provider.updateMirror({
      projectId: '00000000-0000-4000-8000-000000000157',
      repo: {
        ...workspaceSpecFixture().repo,
        url: 'https://git.example.test/acme/big.git',
        cacheKey: 'big',
      },
      credential: null,
    });
    await vi.waitFor(() => {
      expect(
        [...daemon.containers.values()].some(
          (container) => container.body.Labels?.[WORKSPACE_LABELS.role] === 'mirror',
        ),
      ).toBe(true);
    });
    const live = [...daemon.containers.values()].find(
      (container) => container.body.Labels?.[WORKSPACE_LABELS.role] === 'mirror',
    );
    await provider.purgeExpired(NOW);
    expect(daemon.containers.has('orphan')).toBe(false);
    // The live mirror helper finished its own call: one removal, its own, after its wait.
    await expect(mirror).resolves.toMatchObject({ updated: true });
    const removals = daemon.requests.filter(
      (request) => request.method === 'DELETE' && request.path === `/containers/${live?.id}`,
    );
    expect(removals).toHaveLength(1);
  });

  it('forgets a helper whose create failed, so a later orphan of its name is reaped', async () => {
    // WP-157 review round 2: a create that throws must clear the live mark, or every later orphan
    // of the same `mirror-<key>` name would be kept as "live" for the life of the launcher.
    await daemon.stop();
    const fail = new Map([['POST /containers/create', { status: 500, message: 'create refused' }]]);
    await startWorld({ fail });
    await expect(
      provider.updateMirror({
        projectId: '00000000-0000-4000-8000-000000000157',
        repo: {
          ...workspaceSpecFixture().repo,
          url: 'https://git.example.test/acme/big.git',
          cacheKey: 'big',
        },
        credential: null,
      }),
    ).rejects.toThrow();
    const create = daemon.requests.find(
      (request) => request.method === 'POST' && request.path === '/containers/create',
    );
    const name = new URLSearchParams(create?.query ?? '').get('name') ?? '';
    expect(name).toMatch(/^mirror-/);
    fail.delete('POST /containers/create');
    plant('stale-mirror', name, helperLabels('mirror'), 'exited', secondsAgo(7_200));
    await provider.purgeExpired(NOW);
    expect(daemon.containers.has('stale-mirror')).toBe(false);
  });

  it('keeps a helper the daemon gives no creation instant', async () => {
    daemon.containers.set('undated', {
      id: 'undated',
      name: 'clicheck-undated',
      body: { Labels: helperLabels('cli-check') },
      state: 'exited',
      exitCode: 0,
      logs: '',
      networks: [],
    });
    await provider.purgeExpired(NOW);
    expect(daemon.containers.has('undated')).toBe(true);
  });
});
