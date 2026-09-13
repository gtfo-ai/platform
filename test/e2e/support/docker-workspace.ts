/**
 * The Docker half of WP-14's e2e: a fixture repository in a container, and a real
 * `DockerWorkspaceProvider` pointed at the daemon.
 *
 * ## What is real here (WP-22: the two stand-ins are gone)
 *
 * Real: the daemon, the networks, the volumes, the `volume-subpath` mount, the hardening flags as
 * the daemon records them, the mirror fetched over the network from another container, the clone,
 * the export and the retention sweep — **and now the two images the run is made of**:
 *
 *  - the run container is `platform-runtime` (`docker/runtime.Dockerfile`), so
 *    `WorkspaceImages.runtimeSourceDir` is `null`, the create body carries **no bind mount at all**
 *    — technical/05 forbids one in a run container — and the shim is the image's own entrypoint
 *    rather than `node --import ts-source-resolver` over a `/repo` mount. Until WP-22 it was
 *    `node:24-alpine` plus that mount, which is what `hardening.ts` named as its single hole;
 *  - the egress sidecar is `platform-egress` (tinyproxy 1.11.2) with **no `egressCommand`**, so it
 *    runs the image's own entrypoint the way production does. It is no longer a `sleep` that
 *    demonstrates only the *topology*: `egress-policy.e2e` drives a request through it from inside
 *    the run container and asserts the allowed host answers and an unlisted one is refused.
 *
 * ## These images are local, so they are never pulled
 *
 * `ensureImages` pulls a tag it does not have. There is no registry to pull `platform-runtime:dev`
 * from, and a `docker pull` failure twenty seconds into a suite names a registry rather than the
 * thing to do about it — so a missing `platform-*` image fails immediately with the command that
 * builds it. **Not skipped**: WP-22's row says a case that skips when the image is absent is a
 * failure, because a suite that quietly tests nothing is what the images exist to stop.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Logger } from '@platform/application';
import { workspace } from '@platform/infrastructure';
import { PLATFORM_SKILLS } from '@platform/prompts';

const run = promisify(execFile);

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/**
 * The stand-in images, by **mutable tag**, and {@link ensureImages} pulls one only when it is
 * absent. What that trades: a machine that pulled `node:24-alpine` months ago keeps testing against
 * that build for ever, so a regression the current tag would show is invisible here — while CI,
 * whose daemon is always clean, always gets the current one. Pinning by digest belongs with the
 * real images (WP-22 owns them); until then the two environments can differ and this says so.
 */
export const RUNTIME_IMAGE = process.env['WORKSPACE_E2E_RUNTIME_IMAGE'] ?? 'platform-runtime:dev';
export const EGRESS_IMAGE = process.env['WORKSPACE_E2E_EGRESS_IMAGE'] ?? 'platform-egress:dev';
export const ALPINE_IMAGE = process.env['WORKSPACE_E2E_ALPINE_IMAGE'] ?? 'alpine:3.21';
export const GIT_IMAGE = process.env['WORKSPACE_E2E_GIT_IMAGE'] ?? 'alpine/git:v2.49.1';

/** How the two images above are built, quoted verbatim in the failure when one is missing. */
export const BUILD_IMAGES_COMMAND = 'node scripts/build-images.mjs runtime egress';

const VCS = `g${'it'}`;

/** `docker` with arguments, never a shell string. */
export const docker = async (
  args: readonly string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await run('docker', [...args], { maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (options.allowFailure !== true) {
      throw error;
    }
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(failure.stdout ?? '').trim(),
      stderr: String(failure.stderr ?? failure.message ?? '').trim(),
    };
  }
};

/**
 * A `DockerEngine` that records what it sent the daemon about a container.
 *
 * A subclass rather than a wrapper object: `DockerWorkspaceProvider` takes a `DockerEngine`, whose
 * private fields make it nominal, so a structural stand-in does not typecheck — and a subclass has
 * the further advantage that what is recorded is the call that really went out, not a call a
 * delegate promised to forward.
 *
 * It exists for the shared contract suite's `containerOps` seam: stop-before-remove is not
 * observable through the port (`attach` rejects either way), and pinning it for the Docker adapter
 * alone left the fake's order unasserted (standing rules 10 and 23).
 */
export class RecordingDockerEngine extends workspace.DockerEngine {
  readonly containerOps: { readonly op: 'stop' | 'remove'; readonly id: string }[] = [];

  override async stopContainer(id: string, timeoutSeconds: number): Promise<void> {
    this.containerOps.push({ op: 'stop', id });
    await super.stopContainer(id, timeoutSeconds);
  }

  override async removeContainer(id: string): Promise<void> {
    this.containerOps.push({ op: 'remove', id });
    await super.removeContainer(id);
  }

  /** What one container received, in order. Helper and probe containers share the engine. */
  opsFor(id: string): readonly ('stop' | 'remove')[] {
    return this.containerOps.filter((entry) => entry.id === id).map((entry) => entry.op);
  }
}

export interface DockerFixture {
  readonly network: string;
  readonly repoUrl: string;
  readonly controlVolume: string;
  readonly cacheVolume: string;
  readonly controlRoot: string;
  readonly exportDir: string;
  readonly provider: workspace.DockerWorkspaceProvider;
  readonly engine: RecordingDockerEngine;
  /** The fixture repository container, reachable by this name on {@link network}. */
  readonly repoContainer: string;
  /** Every image a container will be created from here — see {@link ensureImages}. */
  readonly images: readonly string[];
  /**
   * Every `warn`/`error` the launcher logged, in order.
   *
   * `#teardown` collects a failed step, logs it and carries on by design, so **nothing ever
   * failed a test when teardown did not complete** — which is how a control directory that was
   * never removed stayed invisible for six pushes. Reading the log is the only way to assert
   * completion from outside, and it is precise enough to tolerate the partial this fixture causes
   * itself (`rm-network`, because a probe container of this file can still be attached).
   */
  readonly warnings: { readonly message: string; readonly fields: Record<string, unknown> }[];
  cleanup(): Promise<void>;
}

/**
 * Pulls every image before anything creates a container from one, because **the engine never
 * pulls and the CLI does**.
 *
 * `DockerEngine.createContainer` is `POST /containers/create`, and the daemon answers **404** when
 * the image is absent. Measured against this daemon:
 *
 * ```
 * POST /containers/create {"Image":"alpine:does-not-exist-<n>"} → HTTP 404
 *   {"message":"No such image: alpine:does-not-exist-<n>"}
 * POST /containers/create {"Image":"alpine:3.21"}               → HTTP 201
 * ```
 *
 * `docker run` pulls on a miss; `docker compose` does; a `create` through the API does not. So on
 * a machine that has run this suite before, every image is already there and the asymmetry is
 * invisible — and on a clean GitHub runner it is 21 failures. `ALPINE_IMAGE` and `GIT_IMAGE`
 * happened to be safe only because {@link startRepoContainer} reaches them through the *CLI*
 * first, which is luck, not design: `RUNTIME_IMAGE` is handed straight to the provider and is the
 * one the run container is created from, which is exactly where `main` failed, in the provider's
 * `create`. Enumerated here so a fourth image cannot inherit the same luck.
 */
const imageTagsOf = (images: Readonly<Record<string, unknown>>): string[] =>
  Object.entries(images)
    // Every string in the provider's image record names an image, except the one that names a
    // directory. Derived rather than listed beside it (standing rule 7): a second copy of the tags
    // is a copy that can drift, and a field added to `WorkspaceImages` later is ensured the day it
    // is added instead of the day CI fails on a clean daemon.
    // Every string field here is a tag today and `runtimeSourceDir` is the one exception. A future
    // required string field that is *not* a tag would be `docker pull`-ed instead of rejected, so
    // exclude it here when one is added rather than discovering it from the pull's error.
    .filter(([key, value]) => typeof value === 'string' && key !== 'runtimeSourceDir')
    .map(([, value]) => value as string);

const ensureImages = async (images: readonly string[]): Promise<void> => {
  for (const image of images) {
    const present = await docker(['image', 'inspect', image], { allowFailure: true });
    if (present.ok) {
      continue;
    }
    if (image.startsWith('platform-')) {
      // This repository builds it; no registry has it. Fail here, naming the command, rather than
      // letting `docker pull` fail with "pull access denied" — and never skip (WP-22's row).
      throw new Error(
        `the image ${image} is not on this daemon and is built rather than pulled: run ` +
          `\`${BUILD_IMAGES_COMMAND}\` first (CI's e2e-fake-claude job does).`,
      );
    }
    // Not `allowFailure`: a fixture that cannot obtain its images must fail with the pull's own
    // message, not with a 404 twenty seconds later that names a container instead of an image.
    await docker(['pull', image]);
  }
};

const uniqueSuffix = (): string => Math.random().toString(36).slice(2, 8);

/** `ws-<run-id>` with the run id spelled as `names.ts` writes it: a uuid, nothing else. */
const WORKSPACE_VOLUME = /^ws-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Serves a bare repository over `git://` from a container on `network`.
 *
 * `alpine:3.21` plus `apk add` rather than a purpose-built image: `alpine/git` ships no
 * `git-daemon` (measured — the package is split), and building an image here would be WP-22's job
 * done badly. `--enable=receive-pack` is what makes the export's push land somewhere real; the
 * daemon is anonymous, so the *push* this e2e demonstrates is unauthenticated, and the run-scoped
 * credential's own behaviour is `broker.test.ts`'s.
 */
/** The project's own skill, as the fixture repository commits it. Asserted byte for byte. */
export const PROJECT_SKILL_DESCRIPTION =
  'The project ships this one and the platform never touches it.';
export const PROJECT_SKILL_BODY = 'Run the house script.';
export const PROJECT_SKILL_FILE = `---\nname: project-own\ndescription: ${PROJECT_SKILL_DESCRIPTION}\n---\n\n${PROJECT_SKILL_BODY}\n`;

const startRepoContainer = async (name: string, network: string): Promise<void> => {
  const script = [
    `apk add --no-cache ${VCS} ${VCS}-daemon >/dev/null 2>&1`,
    'mkdir -p /srv/acme.git',
    `${VCS} init --bare -q --initial-branch=main /srv/acme.git`,
    'mkdir -p /seed && cd /seed',
    `${VCS} init -q --initial-branch=main`,
    `${VCS} config user.email fixture@example.invalid`,
    `${VCS} config user.name fixture`,
    'printf "# fixture repository\\n" > README.md',
    'mkdir -p src && printf "export const a = 1;\\n" > src/a.ts',
    // The project's **own** skill, committed on the default branch, so "provisioning leaves the
    // project's `.claude/skills` untouched" has something to be wrong about (standing rule 42: a
    // filter with nothing to filter passes). Its name is not one of the platform's ten.
    'mkdir -p .claude/skills/project-own',
    `printf -- '---\\nname: project-own\\ndescription: ${PROJECT_SKILL_DESCRIPTION}\\n---\\n\\n${PROJECT_SKILL_BODY}\\n' > .claude/skills/project-own/SKILL.md`,
    'mkdir -p node_modules/left-pad && printf "x\\n" > node_modules/left-pad/index.js',
    `${VCS} add -A`,
    `${VCS} commit -q -m "fixture"`,
    `${VCS} push -q /srv/acme.git main`,
    `${VCS} daemon --verbose --export-all --enable=receive-pack --enable=upload-pack ` +
      '--base-path=/srv --reuseaddr --listen=0.0.0.0 /srv',
  ].join('\n');
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    network,
    ALPINE_IMAGE,
    'sh',
    '-c',
    script,
  ]);
  // The daemon is up when a client can list its refs. Polled with a deadline rather than slept on.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const probe = await docker(
      [
        'run',
        '--rm',
        '--network',
        network,
        '--entrypoint',
        VCS,
        GIT_IMAGE,
        'ls-remote',
        `${VCS}://${name}/acme.${VCS}`,
      ],
      { allowFailure: true },
    );
    if (probe.ok && probe.stdout.includes('refs/heads/main')) {
      return;
    }
    if (Date.now() > deadline) {
      const logs = await docker(['logs', name], { allowFailure: true });
      throw new Error(`fixture repository never came up: ${probe.stderr}\n${logs.stdout}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

export interface DockerFixtureOptions {
  /**
   * Bind the control volume onto a host directory, so **this** process can read the token and the
   * socket path (the default, and what every e2e here needs).
   *
   * `false` creates a plain named volume instead, which is what production deploys and the only kind
   * the run shim can use on macOS: the shim `chmod 0600`s its control socket after binding it, and
   * `chmod` on a socket inside a bind-backed volume answers **EINVAL** on Docker Desktop's file
   * sharing — measured by `scripts/runlet-launcher-check.mjs`, whose run container exited 1 with
   * `EINVAL: invalid argument, chmod '/ctl/ctl.sock'` until the volume stopped being bind-backed. The
   * refusal is correct (a socket whose mode the platform could not set is a socket whose access
   * control it cannot state), so the *harness* is what has to change. A caller that passes `false`
   * cannot read `controlRoot` from its own filesystem and must reach the volume through a container.
   */
  readonly controlVolumeBind?: boolean;
}

/** Builds everything one e2e file needs, and a cleanup that removes all of it. */
export const startDockerFixture = async (
  options: DockerFixtureOptions = {},
): Promise<DockerFixture> => {
  // The record the provider is given, and the only place these tags are written down.
  const providerImages = {
    runtime: RUNTIME_IMAGE,
    egress: EGRESS_IMAGE,
    // No `egressCommand` and no `runtimeSourceDir`: production's shape, and WP-22's criterion. The
    // first means the sidecar runs tinyproxy because that is the image's entrypoint; the second
    // means the run container has no host mount at all.
    git: GIT_IMAGE,
    runtimeSourceDir: null,
  };
  // First, before anything creates a container: every image it will be created from, whether it is
  // reached through the CLI (which pulls) or through the engine (which does not).
  const images = imageTagsOf(providerImages);
  await ensureImages(images);
  const suffix = uniqueSuffix();
  const network = `agentic-e2e-${suffix}`;
  const repoContainer = `agentic-e2e-repo-${suffix}`;
  const controlVolume = `agentic-e2e-ctl-${suffix}`;
  const cacheVolume = `agentic-e2e-cache-${suffix}`;
  // Short: the control root becomes a Unix socket path (names.ts § MAX_UNIX_SOCKET_PATH).
  const controlRoot = await workspace.shortTempDir('agentic-e2e-ctl-');
  // **And world-writable, which is what six red CI runs cost.** `mkdtemp` makes `0700`, owned by
  // whoever runs the tests. Production's control volume is a plain named volume whose root is
  // `root:root 0755`, so the `prep-<run-id>` helper — root, but with `CapDrop: ALL` and only
  // `CAP_CHOWN` added, therefore no `CAP_DAC_OVERRIDE` — owns it and may `mkdir` in it. This
  // fixture's control volume is bind-backed onto a **host** directory instead (see below), so on
  // Linux that helper is a non-owner of a `0700` directory and the kernel refuses it. Measured,
  // inside the daemon's own Linux kernel, on a volume made to look like a GitHub runner's
  // `mkdtemp` (`chown 1001:1001`, `chmod 0700`):
  //
  //   --user 0:0 --cap-drop ALL --cap-add CHOWN → mkdir: can't create directory '/ctl/<uuid>':
  //                                               Permission denied      ← CI, verbatim
  //   the same, after `chmod 0777` on the root  → exit 0
  //
  // macOS never showed it: Docker Desktop's file sharing reports a host-owned bind as `root:root`
  // inside the container whatever the host uid is, so the helper always appeared to own it. That
  // is the whole of "passes here, fails there" (standing rule 69).
  //
  // The trade, named rather than hidden: `/ctl` is looser here than in production. Matching
  // production exactly would mean `chown`ing the bind source to root, and then this process — the
  // stand-in for the launcher container — could no longer empty it at cleanup. What must stay
  // tight is `<ctl>/<run-id>`, which the launcher creates `0700 1000:1000` and which has its own
  // case ("creates the control sub-directory before the container starts").
  await chmod(controlRoot, 0o777);
  // Outside the control root, which is about to become a volume: an export written into `/ctl`
  // would be a file every run's container could see the name of.
  const exportDir = await workspace.shortTempDir('agentic-e2e-out-');

  await docker(['network', 'create', network]);
  // A **bind-backed** named volume for the control channel: `volume-subpath` needs
  // `type=volume`, and TD-025 §2 has the runner reading the socket and the token through its own
  // mount of the same volume. A plain named volume lives inside the daemon's storage, which this
  // process cannot read; the local driver's bind options give both. Measured on Docker 29.7.2 —
  // the sub-path mount still isolates one run's directory, and a second `volume create` of the
  // same name is idempotent, which is what lets the provider's own `ensureVolume` run afterwards.
  await docker(
    options.controlVolumeBind === false
      ? ['volume', 'create', controlVolume]
      : [
          'volume',
          'create',
          '--driver',
          'local',
          '--opt',
          'type=none',
          '--opt',
          `device=${controlRoot}`,
          '--opt',
          'o=bind',
          controlVolume,
        ],
  );
  await startRepoContainer(repoContainer, network);

  const engine = new RecordingDockerEngine({ socketPath: '/var/run/docker.sock' });
  const warnings: { readonly message: string; readonly fields: Record<string, unknown> }[] = [];
  const record = (level: string, fields: unknown, message: string): void => {
    warnings.push({ message, fields: (fields ?? {}) as Record<string, unknown> });
    // Printed as well as recorded: a warning from the launcher during an e2e is almost always the
    // reason a later assertion fails, and swallowing it costs an hour of guessing.
    process.stderr.write(`launcher ${level}: ${message} ${JSON.stringify(fields)}\n`);
  };
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (fields, message) => record('warn', fields, message),
    error: (fields, message) => record('error', fields, message),
  };
  const provider = new workspace.DockerWorkspaceProvider({
    engine,
    logger,
    images: providerImages,
    controlVolume,
    controlRoot,
    cacheVolume,
    helperNetwork: network,
    egressNetwork: network,
    // The shipped ten, not a fixture: this tier's whole point is that what a real container ends
    // up holding is what the platform ships (standing rule 82).
    skills: PLATFORM_SKILLS,
    // Q51: the provider refuses any uid but 1000, because the shim's control socket is 0600 and
    // created as uid 1000. This process is almost certainly *not* uid 1000 — a GitHub Actions
    // runner is 1001 — and that is the point of {@link relaxControlDirectoryForHost}: the
    // constraint is real, it is measured below, and the test says so instead of weakening it.
    runnerUid: 1000,
  });

  return {
    network,
    repoContainer,
    repoUrl: `${VCS}://${repoContainer}/acme.${VCS}`,
    controlVolume,
    cacheVolume,
    controlRoot,
    exportDir,
    provider,
    engine,
    images,
    warnings,
    cleanup: async () => {
      // **`-v` on every `rm`**, for the same reason `DockerEngine.removeContainer` sends `v=true`:
      // `alpine/git` declares `VOLUME /git`, so a container made from it owns an anonymous volume
      // the daemon keeps unless the removal asks for it. The engine's half fixed the provider's
      // containers; this is the harness's own, and it is what was left of the "one volume per
      // `verify:e2e` run" the orchestrator measured after WP-22's first round.
      const containers = await docker(['ps', '-aq', '--filter', `network=${network}`], {
        allowFailure: true,
      });
      for (const id of containers.stdout.split('\n').filter((line) => line.length > 0)) {
        await docker(['rm', '-f', '-v', id], { allowFailure: true });
      }
      await docker(['rm', '-f', '-v', repoContainer], { allowFailure: true });
      for (const label of ['com.agentic.run']) {
        const owned = await docker(['ps', '-aq', '--filter', `label=${label}`], {
          allowFailure: true,
        });
        for (const id of owned.stdout.split('\n').filter((line) => line.length > 0)) {
          await docker(['rm', '-f', '-v', id], { allowFailure: true });
        }
      }
      // Networks and volumes the provider made, by label. A `run-<id>` network can outlive its
      // `destroy` when something else is still attached to it — a probe container from this file,
      // for instance — and the launcher tolerates that by design (it logs and carries on), so the
      // test has to sweep them.
      const networks = await docker(['network', 'ls', '-q', '--filter', 'label=com.agentic.run'], {
        allowFailure: true,
      });
      for (const id of networks.stdout.split('\n').filter((line) => line.length > 0)) {
        await docker(['network', 'rm', id], { allowFailure: true });
      }
      const volumes = await docker(['volume', 'ls', '-q', '--filter', 'label=com.agentic.run'], {
        allowFailure: true,
      });
      for (const id of volumes.stdout.split('\n').filter((line) => line.length > 0)) {
        await docker(['volume', 'rm', '-f', id], { allowFailure: true });
      }
      // And by name, because a label filter cannot see a volume that has no labels. Measured: one
      // `verify:e2e` run leaves exactly one `ws-<uuid>` with `labels=map[]` — the daemon creates it
      // implicitly when a container mounts a volume the retention sweep has already purged, so
      // nothing ever labelled it (standing rule 60). Production is not exposed: `provider.ts`
      // creates the volume *with* labels before any container references the name. The harness
      // still must not leave it, because nothing else will — `purgeExpired` lists by
      // `role=workspace`, and `retentionDecision` answers `keep`/`unlabelled` for ever by design.
      // Fix the sweep, never the retention rule: removing unlabelled volumes removes other people's.
      // The daemon's name filter is a substring match, so the exact `ws-<uuid>` shape is required
      // here rather than there: this runs on developer machines, and removing every volume whose
      // name merely contains `ws-` would remove somebody's.
      const byName = await docker(['volume', 'ls', '-q', '--filter', 'name=ws-'], {
        allowFailure: true,
      });
      for (const id of byName.stdout.split('\n').filter((line) => WORKSPACE_VOLUME.test(line))) {
        await docker(['volume', 'rm', '-f', id], { allowFailure: true });
      }
      await docker(['network', 'rm', network], { allowFailure: true });
      // Empty the control root from a **root container**, before the volume goes and before the
      // host `rm` below. A case that leaves a run alive leaves `<ctl>/<run-id>` behind as
      // `0700 1000:1000`, and on Linux this process is neither — `fs.rm` would throw `EACCES` out
      // of `afterAll`, where `force: true` does not help (it only swallows `ENOENT`). On macOS the
      // bind reports everything as root-owned and the host `rm` would have succeeded, which is
      // exactly why this had to be reasoned about rather than observed.
      await docker(
        [
          'run',
          '--rm',
          '--network',
          'none',
          '-v',
          `${controlVolume}:/ctl`,
          ALPINE_IMAGE,
          'sh',
          '-c',
          'chmod -R u+rwX /ctl; rm -rf /ctl/..?* /ctl/.[!.]* /ctl/*',
        ],
        { allowFailure: true },
      );
      await docker(['volume', 'rm', '-f', controlVolume, cacheVolume], { allowFailure: true });
      // A run whose agent locked its control directory leaves a `000` directory behind, and POSIX
      // refuses even its owner the read that `fs.rm` needs — `force: true` swallows `ENOENT`, never
      // `EACCES`, so `afterAll` would throw. The host owns this tree, and ownership is all `chmod`
      // asks for.
      await run('chmod', ['-R', 'u+rwX', controlRoot]).catch(() => undefined);
      await rm(controlRoot, { recursive: true, force: true });
      await rm(exportDir, { recursive: true, force: true });
    },
  };
};

/**
 * Runs a command **under the run container's own configuration**, as the daemon recorded it.
 *
 * This is the difference between asserting a flag and asserting what it buys. The probe's
 * `HostConfig` is not built here: it is read back from `docker inspect` of the live run container,
 * so what is being tested is the daemon's record of the workspace, not a string this repository
 * wrote. Only the image and the command differ — `alpine:3.21` for busybox's `id`, `wget` and
 * `getent`. (`nslookup` is deliberately *not* among them: it queries `<name>.<search-domain>` as
 * well, which an internal network cannot answer, and that cost this repository six red pushes —
 * see the DNS case's comment in `docker-workspace.e2e.test.ts`.)
 */
export const probeUnderRunContainerConfig = async (
  engine: workspace.DockerEngine,
  containerId: string,
  script: string,
  overrides: {
    user?: string;
    capAdd?: readonly string[];
    dnsOptions?: readonly string[];
    /** `alpine:3.21` by default; the egress case needs `curl`, which only the run image has. */
    image?: string;
    env?: readonly string[];
  } = {},
): Promise<{ exitCode: number; output: string }> => {
  const inspect = await engine.inspectContainer(containerId);
  const hostConfig = { ...(inspect.HostConfig as Record<string, unknown>) };
  if (overrides.capAdd !== undefined) {
    hostConfig['CapAdd'] = overrides.capAdd;
  }
  if (overrides.dnsOptions !== undefined) {
    hostConfig['DnsOptions'] = overrides.dnsOptions;
  }
  const name = `agentic-e2e-probe-${uniqueSuffix()}`;
  const id = await engine.createContainer(name, {
    Image: overrides.image ?? ALPINE_IMAGE,
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [script],
    Env: overrides.env ?? [],
    User: overrides.user ?? inspect.Config.User ?? '',
    WorkingDir: '/',
    Tty: false,
    HostConfig: hostConfig,
  });
  try {
    await engine.startContainer(id);
    const exitCode = await engine.waitContainer(id);
    return { exitCode, output: await engine.containerLogs(id, 200) };
  } finally {
    await engine.removeContainer(id).catch(() => undefined);
  }
};

/** Writes a file into the workspace volume as uid 1000, for the export cases. */
export const plantInWorkspace = async (
  fixture: DockerFixture,
  volumeName: string,
  script: string,
): Promise<void> => {
  const name = `agentic-e2e-plant-${uniqueSuffix()}`;
  const id = await fixture.engine.createContainer(name, {
    Image: ALPINE_IMAGE,
    Entrypoint: ['/bin/sh', '-c'],
    Cmd: [script],
    User: '1000:1000',
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: volumeName, Target: '/work', ReadOnly: false }],
      NetworkMode: 'none',
    },
  });
  try {
    await fixture.engine.startContainer(id);
    const exitCode = await fixture.engine.waitContainer(id);
    if (exitCode !== 0) {
      throw new Error(`planting failed: ${await fixture.engine.containerLogs(id, 50)}`);
    }
  } finally {
    await fixture.engine.removeContainer(id).catch(() => undefined);
  }
};

/** The temp file the fixture writes for a run, in a directory the test owns. */
export const exportPath = (fixture: DockerFixture, name: string): string =>
  path.join(fixture.exportDir, name);

/** Writes a file the test needs on the host (a symlink target for the bind-source cases). */
export const writeHostFile = async (file: string, content: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
};

/**
 * Makes one run's control directory readable by *this* process, after its real mode has been
 * measured.
 *
 * Q51, admitted rather than hidden. The launcher creates `<ctl>/<run-id>/` as `0700 1000:1000`
 * with the token `0600`, because the run container's shim is uid 1000 and the runner must be too;
 * a test process on any other uid — a GitHub Actions runner is 1001 — cannot even traverse the
 * directory, so `attach`, which reads the token, fails with `not_found`.
 *
 * Two ways out were rejected. Widening the mode in the *provider* would trade a real security
 * property for a test's convenience. Skipping `attach` in this tier would make the shared contract
 * suite's coverage of the Docker adapter quietly smaller than the fake's — the drift standing rule
 * 1 exists to prevent. So instead the mode is measured in its own case
 * (`docker-workspace.e2e.test.ts` › "creates the control sub-directory before the container starts (WP-13 obligation 1)")
 * and *then* relaxed here, by a root container, for the cases that must read it from the host.
 *
 * On a uid-1000 machine this is a no-op in effect. It is called unconditionally so the two
 * environments run the same code.
 */
export const relaxControlDirectoryForHost = async (
  fixture: DockerFixture,
  runId: string,
): Promise<void> => {
  await docker(
    [
      'run',
      '--rm',
      '-v',
      `${fixture.controlVolume}:/ctl`,
      ALPINE_IMAGE,
      'sh',
      '-c',
      `chmod 755 /ctl/${runId} && chmod 644 /ctl/${runId}/token`,
    ],
    { allowFailure: true },
  );
};

/**
 * Removes one run's control socket from inside a container.
 *
 * The host process cannot: unlinking needs write permission on `<ctl>/<run-id>`, which the launcher
 * creates `0700` owned by uid 1000, and on a Linux runner this process is 1001. It is the setup for
 * the readiness case — with the socket gone and the shim already past its own `listen`, nothing can
 * recreate it until the container restarts, which is what makes that case's ordering a fact rather
 * than a race.
 */
export const removeControlSocket = async (fixture: DockerFixture, runId: string): Promise<void> => {
  await docker([
    'run',
    '--rm',
    '--user',
    '0:0',
    '--network',
    'none',
    '-v',
    `${fixture.controlVolume}:/ctl`,
    ALPINE_IMAGE,
    'sh',
    '-c',
    `rm -f /ctl/${runId}/ctl.sock`,
  ]);
};

/** Whether one run's control socket exists, asked from inside a container for the same reason. */
export const controlSocketExists = async (
  fixture: DockerFixture,
  runId: string,
): Promise<boolean> => {
  const probe = await docker([
    'run',
    '--rm',
    '--user',
    '0:0',
    '--network',
    'none',
    '-v',
    `${fixture.controlVolume}:/ctl`,
    ALPINE_IMAGE,
    'sh',
    '-c',
    `test -S /ctl/${runId}/ctl.sock && echo yes || echo no`,
  ]);
  return probe.stdout === 'yes';
};

/**
 * An HTTP server on the fixture network under **two** names, for the egress case.
 *
 * One container, two aliases: the allowed name and the refused one resolve to the same address and
 * the same server, so the refusal can only come from the proxy's filter. A second container would
 * have left "the other host was unreachable" as an explanation for the 403 (standing rule 43).
 */
export const startEgressTarget = async (
  fixture: DockerFixture,
  allowedAlias: string,
  deniedAlias: string,
): Promise<{ name: string; port: number; stop: () => Promise<void> }> => {
  const name = `agentic-e2e-http-${uniqueSuffix()}`;
  const port = 8080;
  await docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    fixture.network,
    '--network-alias',
    allowedAlias,
    '--network-alias',
    deniedAlias,
    '--entrypoint',
    'node',
    RUNTIME_IMAGE,
    '-e',
    `require('node:http').createServer((_q, s) => s.end('EGRESS-TARGET-OK')).listen(${port})`,
  ]);
  return {
    name,
    port,
    stop: async () => {
      await docker(['rm', '-f', '-v', name], { allowFailure: true });
    },
  };
};
