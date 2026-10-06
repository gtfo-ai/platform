/**
 * WP-151 (TD-025's M9 amendment, PROGRESS backlog 489): the launcher refuses a create whose run
 * image's shim does not speak the **requesting runner's** protocol, before anything exists.
 *
 * The image declares its shim's protocol as the label `com.agentic.runlet-protocol`
 * (`docker/runtime.Dockerfile` writes it from `RUNLET_PROTOCOL_VERSION`, held there by
 * `scripts/runlet-protocol.test.ts`); the runner sends its own on the spec. Against
 * `FakeDockerDaemon`, whose image inspect answers the labels a case gives it — the fake inspect the
 * criterion asks for. The daemon half is `scripts/launcher-control-plane-check.mjs`'s relabelled
 * image leg, and the shared suite's case holds the fake provider to the same refusal.
 */
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError } from '@platform/application';
import { RUNLET_PROTOCOL_IMAGE_LABEL, RUNLET_PROTOCOL_VERSION } from '@platform/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerEngine } from './engine.js';
import { SKILL_CATALOGUE_FIXTURE, shortTempDir, workspaceSpecFixture } from './fixtures.js';
import { DockerWorkspaceProvider } from './provider.js';
import { FakeDockerDaemon } from './testing.js';

const RUNTIME = 'platform-runtime:test';
const SECOND_RUN = 'aaaaaaaa-1111-4111-8111-111111111111';

let daemon: FakeDockerDaemon;
let workDir: string;
let controlRoot: string;

/** A provider over a daemon whose run image carries `labels`; the maps are read at every inspect. */
const providerOn = async (
  imageLabels: Map<string, Readonly<Record<string, string>> | null>,
  imageIds: Map<string, string> = new Map(),
): Promise<DockerWorkspaceProvider> => {
  daemon = new FakeDockerDaemon({ imageLabels, imageIds });
  const socketPath = await daemon.start();
  daemon.seedSubpath('repo-cache', 'acme.git');
  daemon.networks.set('net-platform', { name: 'platform', internal: false });
  return new DockerWorkspaceProvider({
    engine: new DockerEngine({ socketPath }),
    images: { runtime: RUNTIME, egress: 'tinyproxy:test', git: 'git:test', runtimeSourceDir: null },
    controlVolume: 'ctl',
    controlRoot,
    cacheVolume: 'repo-cache',
    helperNetwork: 'platform',
    egressNetwork: 'platform',
    runnerUid: 1000,
    skills: SKILL_CATALOGUE_FIXTURE,
    mintToken: () => 'a'.repeat(32),
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
};

const declaring = (value: string | null) =>
  new Map([[RUNTIME, value === null ? null : { [RUNLET_PROTOCOL_IMAGE_LABEL]: value }]]);

/** Nothing of the run exists on the daemon: no network, no volume, no container labelled for it. */
const nothingFor = (runId: string): boolean =>
  !daemon.volumes.has(`ws-${runId}`) &&
  ![...daemon.networks.values()].some((network) => network.name.includes(runId)) &&
  ![...daemon.containers.values()].some(
    (container) => container.body.Labels?.['com.agentic.run'] === runId,
  );

beforeEach(async () => {
  workDir = await shortTempDir('agentic-wp151-');
  controlRoot = path.join(workDir, 'ctl');
  await mkdir(controlRoot, { recursive: true });
});

afterEach(async () => {
  await daemon?.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe('the run image’s shim protocol (WP-151)', () => {
  it('creates the run when the image declares the runner’s protocol', async () => {
    const provider = await providerOn(declaring(String(RUNLET_PROTOCOL_VERSION)));
    const spec = workspaceSpecFixture();
    expect(spec.runletProtocol).toBe(RUNLET_PROTOCOL_VERSION);
    const handle = await provider.create(spec);
    expect(handle.runId).toBe(spec.runId);
    expect(daemon.volumes.has(`ws-${spec.runId}`)).toBe(true);
  });

  it('refuses an image that declares another protocol, as invalid_spec naming the image and both numbers, before anything exists', async () => {
    const provider = await providerOn(declaring('2'));
    const spec = workspaceSpecFixture();
    const refused = provider.create(spec);
    await expect(refused).rejects.toBeInstanceOf(WorkspaceError);
    await expect(refused).rejects.toMatchObject({
      code: 'invalid_spec',
      reason: 'runtime_image_protocol_mismatch',
      runId: spec.runId,
      // Round 1: the numbers as integers too, not only inside the launcher's words.
      protocols: { runner: RUNLET_PROTOCOL_VERSION, shim: 2 },
      message: `the run image ${RUNTIME} declares shim protocol 2, and the runner speaks protocol ${String(RUNLET_PROTOCOL_VERSION)}; rebuild and recreate the runner and the run image from one commit (WP-151)`,
    });
    expect(nothingFor(spec.runId)).toBe(true);
  });

  it('refuses an image with no protocol label, and one with a label that is not a number', async () => {
    for (const labels of [
      declaring(null),
      new Map([[RUNTIME, {}]]),
      declaring(''),
      declaring('three'),
      declaring('03'),
      declaring('3.0'),
      declaring(' 3'),
    ]) {
      const provider = await providerOn(labels);
      const spec = workspaceSpecFixture();
      await expect(provider.create(spec)).rejects.toMatchObject({
        code: 'invalid_spec',
        reason: 'runtime_image_protocol_missing',
        protocols: { runner: RUNLET_PROTOCOL_VERSION, shim: null },
        message: expect.stringContaining(
          `the run image ${RUNTIME} declares no shim protocol (no ${RUNLET_PROTOCOL_IMAGE_LABEL} label, or not a number), and the runner speaks protocol ${String(RUNLET_PROTOCOL_VERSION)}`,
        ),
      });
      expect(nothingFor(spec.runId)).toBe(true);
      await daemon.stop();
    }
  });

  it('compares the requesting runner’s protocol, not the launcher’s own', async () => {
    // The image matches this build — the launcher's — and the runner that asked is from another.
    const provider = await providerOn(declaring(String(RUNLET_PROTOCOL_VERSION)));
    const spec = workspaceSpecFixture({ runletProtocol: RUNLET_PROTOCOL_VERSION - 1 });
    await expect(provider.create(spec)).rejects.toMatchObject({
      code: 'invalid_spec',
      reason: 'runtime_image_protocol_mismatch',
      message: expect.stringContaining(
        `declares shim protocol ${String(RUNLET_PROTOCOL_VERSION)}, and the runner speaks protocol ${String(RUNLET_PROTOCOL_VERSION - 1)}`,
      ),
    });
    expect(nothingFor(spec.runId)).toBe(true);
  });

  /**
   * AUT-6820's deploy (backlog 489): `platform-runtime` was rebuilt while the launcher kept running.
   * A label memoised at the launcher's first create would answer for the image that is gone, so it is
   * read at every create — unlike the `PATH`, which stays one inspect per process.
   */
  it('reads the label at every create, so an image rebuilt under a running launcher is seen', async () => {
    const labels = declaring(String(RUNLET_PROTOCOL_VERSION));
    const provider = await providerOn(labels);
    await provider.create(workspaceSpecFixture());
    labels.set(RUNTIME, { [RUNLET_PROTOCOL_IMAGE_LABEL]: String(RUNLET_PROTOCOL_VERSION + 1) });
    await expect(
      provider.create(workspaceSpecFixture({ runId: SECOND_RUN })),
    ).rejects.toMatchObject({ reason: 'runtime_image_protocol_mismatch' });
    expect(nothingFor(SECOND_RUN)).toBe(true);
  });

  /**
   * WP-151 review round 1: the label is read off the tag, and the clone takes as long as it takes.
   * A create by tag afterwards would start whatever the tag points at then — an image rebuilt during
   * the clone, whose label nobody read — so the run container is created from the id the check read.
   */
  it('creates the run container from the image it inspected, even when the tag moved meanwhile', async () => {
    const ids = new Map([[RUNTIME, 'sha256:checked-image']]);
    const labels = declaring(String(RUNLET_PROTOCOL_VERSION));
    const provider = await providerOn(labels, ids);
    // The daemon's request log is the seam: the first request after the second inspect (the CLI
    // check's `PATH` read is the first, the per-create label read the second) moves the tag to an
    // image declaring another protocol — the image rebuilt while the run is being created.
    let inspects = 0;
    let moved = false;
    const record = daemon.requests.push.bind(daemon.requests);
    daemon.requests.push = (...requests) => {
      for (const request of requests) {
        if (request.method === 'GET' && request.path.startsWith('/images/')) {
          inspects += 1;
        } else if (inspects === 2 && !moved) {
          moved = true;
          ids.set(RUNTIME, 'sha256:rebuilt-image');
          labels.set(RUNTIME, { [RUNLET_PROTOCOL_IMAGE_LABEL]: '1' });
        }
      }
      return record(...requests);
    };
    const handle = await provider.create(workspaceSpecFixture());
    // Which branch ran (rule 10): the tag really moved before the run container was created.
    expect(moved).toBe(true);
    expect(ids.get(RUNTIME)).toBe('sha256:rebuilt-image');
    expect(daemon.containers.get(handle.containerId)?.body.Image).toBe('sha256:checked-image');
  });

  it('is refused by the daemon for an image id it never had, so the double is no kinder than Docker', async () => {
    await providerOn(declaring(String(RUNLET_PROTOCOL_VERSION)));
    const engine = new DockerEngine({ socketPath: daemon.socketPath });
    await expect(
      engine.createContainer('never-inspected', { Image: 'sha256:never-inspected' }),
    ).rejects.toThrow(/No such image/);
    expect([...daemon.containers.values()].some((c) => c.name === 'never-inspected')).toBe(false);
  });
});
