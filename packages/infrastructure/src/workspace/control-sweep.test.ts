/**
 * Two things the Docker provider gained at WP-53, both of which fail *silently* when they regress.
 *
 * 1. **PROGRESS backlog 0b** — the retention sweep now lists the `ctl` volume's own directories
 *    beside the volumes it already lists. A control directory is not a Docker object, so the label
 *    sweep cannot see one (standing rule **60**, one level down), and a `destroy` whose two-step
 *    removal did not finish leaves a **live run token** on a shared volume for ever.
 * 2. **PROGRESS backlog 34's diagnosis half** — `create` asks the run image whether it actually
 *    carries the CLI the platform will tell the shim to exec.
 *
 * ## Why both directions, in as many words
 *
 * *A sweep that found nothing and a sweep that looked at nothing are spelled the same* (standing
 * rules 18 and 42). So every case below pairs a removal with a keep, and the keeps carry their
 * **reason** — `run_alive`, `not_a_run_id`, `remove_failed` — because "kept" alone is what a sweep
 * that lists nothing also reports. The same distinction one level down: `remove_failed` and
 * `run_alive` are different facts (an orphaned token still there, against the sweep working) and
 * were spelled the same until WP-53's review; the case below is what stops that recurring.
 *
 * ## What this tier cannot see
 *
 * `find -mmin` runs on the **daemon's** side of the volume, so the grace window is exercised here
 * only as *"the listing helper was asked for it"*: the fake daemon does not run `find`. The
 * assertion that the window is `+60` is therefore on the **script the helper was sent**, which is
 * the byte the daemon would act on — and it is also why the report has no `too_young` reason: a
 * directory inside the window is never listed, so no row about it can exist, and the behaviour of busybox `find` with those flags was
 * measured directly against `alpine/git:v2.49.1` while writing this (`-mindepth`, `-maxdepth`,
 * `-type d` and `-mmin +N` are all supported; `-printf` is **not**, which is why the script ends in
 * a `sed`).
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_LABELS } from '@platform/application';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerEngine } from './engine.js';
import { SKILL_CATALOGUE_FIXTURE, shortTempDir, workspaceSpecFixture } from './fixtures.js';
import { DockerWorkspaceProvider } from './provider.js';
import { FakeDockerDaemon } from './testing.js';

const RUN_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const RUN_B = 'bbbbbbbb-2222-4222-8222-222222222222';

let daemon: FakeDockerDaemon;
let provider: DockerWorkspaceProvider;
let controlRoot: string;
let workDir: string;
/** What the `ctlls-*` helper prints — the directories `find` would have listed. */
let controlListing: string;
/** Whether `test -x <cli>` succeeds in the run image. */
let cliPresent: boolean;
/** Whether the two-helper control-directory removal fails, for the `remove_failed` case. */
let removalFails: boolean;

const build = async (): Promise<void> => {
  daemon = new FakeDockerDaemon({
    script: (container) => {
      if (container.name.startsWith('ctlls-')) {
        return { exitCode: 0, logs: controlListing };
      }
      if (container.name.startsWith('clicheck-')) {
        return cliPresent ? { exitCode: 0, logs: '' } : { exitCode: 1, logs: '' };
      }
      if (removalFails && container.name.startsWith('ctlempty-')) {
        return { exitCode: 1, logs: 'chmod: /ctl/…: Operation not permitted' };
      }
      return { exitCode: 0, logs: '' };
    },
  });
  const socketPath = await daemon.start();
  // The fixture project's mirror, as an earlier `updateMirror` left it (WP-75: the run container
  // mounts it by sub-path, and the double refuses a sub-path nobody made).
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
    controlVolume: 'ctl',
    controlRoot,
    cacheVolume: 'repo-cache',
    helperNetwork: 'platform',
    egressNetwork: 'platform',
    runnerUid: 1000,
    skills: SKILL_CATALOGUE_FIXTURE,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
};

/** A container carrying a run label, which is what "this run is still alive" looks like. */
const liveContainerFor = (runId: string): void => {
  daemon.containers.set(`live-${runId}`, {
    id: `live-${runId}`,
    name: `ws-${runId}`,
    body: { Labels: { [WORKSPACE_LABELS.run]: runId, [WORKSPACE_LABELS.role]: 'workspace' } },
    state: 'running',
    exitCode: 0,
    logs: '',
    networks: [],
  });
};

beforeEach(async () => {
  controlListing = '';
  cliPresent = true;
  removalFails = false;
  workDir = await shortTempDir('agentic-wp53-');
  controlRoot = path.join(workDir, 'ctl');
  await mkdir(controlRoot, { recursive: true });
  await build();
});

afterEach(async () => {
  await daemon.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe('backlog 0b — the retention sweep reclaims an orphaned control directory', () => {
  it('removes the directory of a run the daemon has no container for', async () => {
    controlListing = `${RUN_A}\n`;
    const report = await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    expect(report.controlDirectories).toEqual([{ runId: RUN_A, removed: true, keptReason: null }]);
    // The countable effect: the *existing* two-helper removal ran, which is what takes a directory
    // an agent may have `chmod 000`'d.
    const helpers = daemon.history.map((container) => container.name);
    expect(helpers).toContain(`ctlempty-${RUN_A}`);
    expect(helpers).toContain(`ctlrm-${RUN_A}`);
  });

  it('keeps the directory of a run whose container is still there, and says why', async () => {
    // The other direction (standing rule 42). Without this, a sweep that removed everything it
    // listed would pass the case above.
    controlListing = `${RUN_A}\n`;
    liveContainerFor(RUN_A);
    const report = await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    expect(report.controlDirectories).toEqual([
      { runId: RUN_A, removed: false, keptReason: 'run_alive' },
    ]);
    expect(daemon.history.map((container) => container.name)).not.toContain(`ctlempty-${RUN_A}`);
  });

  it('sweeps one run and keeps its neighbour in the same pass', async () => {
    // Standing rule 72: a single pass that stops at the first decision is not a sweep. Two entries
    // with two different verdicts is the smallest shape that shows the loop continues.
    controlListing = `${RUN_A}\n${RUN_B}\n`;
    liveContainerFor(RUN_B);
    const report = await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    expect(report.controlDirectories).toEqual([
      { runId: RUN_A, removed: true, keptReason: null },
      { runId: RUN_B, removed: false, keptReason: 'run_alive' },
    ]);
  });

  it('reports a reclaim it could not finish as `remove_failed`, never as a live run', async () => {
    // The two mean opposite things to an operator — an orphaned run token still readable, against
    // the sweep working — and they were the same value until WP-53's review. The failure is made by
    // refusing the removal helper, which is what an unreachable daemon or a locked directory does.
    controlListing = `${RUN_A}\n`;
    removalFails = true;
    const report = await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    expect(report.controlDirectories).toEqual([
      { runId: RUN_A, removed: false, keptReason: 'remove_failed' },
    ]);
  });

  it('leaves a directory whose name is not a run id alone, rather than removing what it does not recognise', async () => {
    controlListing = 'lost+found\n';
    const report = await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    expect(report.controlDirectories).toEqual([
      { runId: 'lost+found', removed: false, keptReason: 'not_a_run_id' },
    ]);
  });

  it('reports an empty list when the volume has nothing older than the grace window', async () => {
    // "Found nothing" — distinguishable from "looked at nothing" only because the listing helper
    // ran, which the next case asserts.
    controlListing = '';
    const report = await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    expect(report.controlDirectories).toEqual([]);
  });

  it('asks the daemon for directories older than the grace window, mounting the volume read-only', async () => {
    await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    const listing = daemon.history.find((container) => container.name.startsWith('ctlls-'));
    expect(listing, 'the sweep never listed the control volume').toBeDefined();
    const script = listing?.body.Cmd?.[0] ?? '';
    // The grace window is what stops the sweep deleting the control directory of a run that is
    // *being created*: `#prepare` writes the directory before the container exists.
    expect(script).toContain('-mmin +60');
    expect(script).toContain('-maxdepth 1');
    expect(listing?.body.HostConfig?.Mounts?.[0]).toMatchObject({
      Source: 'ctl',
      Target: '/ctl',
      ReadOnly: true,
    });
  });

  it('reports the volumes and the directories separately, so neither is counted as the other', async () => {
    controlListing = `${RUN_A}\n`;
    const report = await provider.purgeExpired(new Date('2026-09-20T12:00:00.000Z'));
    // `examined`/`removed` are a count of **volumes**; a control directory has a different
    // lifetime (it should not outlive its run at all) and an operator counting workspaces must not
    // count one.
    expect(report.examined).toBe(0);
    expect(report.removed).toBe(0);
    expect(report.controlDirectories).toHaveLength(1);
  });
});

describe('backlog 34 — a wrong CLI path fails by name, on the platform side', () => {
  it('refuses to create a run when the image has no executable there, naming the image and the path', async () => {
    cliPresent = false;
    await expect(provider.create(workspaceSpecFixture({ runId: RUN_A }))).rejects.toMatchObject({
      name: 'WorkspaceError',
      // Terminal, because the same image would refuse the same path again
      // (`classifyProvisionFailure`): retrying would hide a configuration mistake.
      code: 'invalid_spec',
    });
    await expect(provider.create(workspaceSpecFixture({ runId: RUN_A }))).rejects.toThrow(
      /platform-runtime:test has no executable at \/usr\/local\/bin\/claude/,
    );
  });

  it('creates nothing when the check fails, so a bad image does not leak a container per attempt', async () => {
    cliPresent = false;
    await expect(provider.create(workspaceSpecFixture({ runId: RUN_A }))).rejects.toThrow();
    const made = daemon.history.map((container) => container.name.split('-')[0]);
    expect(new Set(made)).toEqual(new Set(['clicheck']));
    expect(daemon.volumes.has(`ws-${RUN_A}`)).toBe(false);
  });

  it('asks the run image once per process, not once per run', async () => {
    // One helper container on the first create and none afterwards: the verdict is memoised,
    // because a `test -x` per run is a container per run for an answer that cannot change while the
    // image tag does not.
    await provider.create(workspaceSpecFixture({ runId: RUN_A }));
    await provider.create(workspaceSpecFixture({ runId: RUN_B }));
    expect(daemon.history.filter((c) => c.name.startsWith('clicheck-'))).toHaveLength(1);
  });

  it('does not cache a failure, so fixing the image needs no restart', async () => {
    cliPresent = false;
    await expect(provider.create(workspaceSpecFixture({ runId: RUN_A }))).rejects.toThrow();
    cliPresent = true;
    await expect(provider.create(workspaceSpecFixture({ runId: RUN_A }))).resolves.toBeDefined();
  });

  it('runs `test -x` in the run image, as uid 1000 and with no network', async () => {
    await provider.create(workspaceSpecFixture({ runId: RUN_A }));
    const check = daemon.history.find((container) => container.name.startsWith('clicheck-'));
    expect(check?.body.Image).toBe('platform-runtime:test');
    expect(check?.body.Cmd?.[0]).toBe('test -x /usr/local/bin/claude');
    expect(check?.body.User).toBe('1000:1000');
    expect(check?.body.HostConfig?.NetworkMode).toBe('none');
  });
});
