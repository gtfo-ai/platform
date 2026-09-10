/**
 * technical/05 § "Hardening flags (per run container)", as a Docker Engine create body.
 *
 * A pure function, so the flags can be asserted without a daemon — and asserted *again* against
 * what the daemon recorded, which is the assertion that matters. A test of this function is a test
 * of a string we wrote (standing rule 3); `test/e2e/workspace/docker-workspace.e2e.test.ts`
 * inspects the created container and, for the flags that buy a property, demonstrates the property
 * inside it: a write outside the workspace, a capability-requiring syscall, `NoNewPrivs` as the
 * kernel reports it, and a route off the run network.
 *
 * ## The one hole, named
 *
 * TD-021's run container is the `platform-runtime` image: the Claude binary, git, the CLIs, and
 * the bundled run shim as its entrypoint. **That image is WP-22's and does not exist yet.** Until
 * it does, a run container can only be a stock image with the repository's sources mounted so the
 * shim can be started from TypeScript — which is what WP-13's `runlet-container-check.mjs` does,
 * and it is a bind mount from the host, the one thing technical/05 says a run container never has.
 *
 * So it is a *named* hole rather than a general knob: {@link WorkspaceImages.runtimeSourceDir}, set
 * from the launcher's own environment (`APP_WORKSPACE_RUNTIME_SOURCE_DIR`, never from project
 * config, which BD-025 only lets narrow), mounted read-only at a fixed `/repo`, and accepted only
 * if it is an absolute path, its own `realpath`, and a checkout of this repository — see
 * {@link assertSafeBindSource}. With it unset — the production shape — the create body has **no**
 * binds at all, and `hardening.test.ts` asserts that rather than trusting it.
 */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  WorkspaceError,
  type WorkspaceLimits,
  type WorkspaceRuntime,
  type WorkspaceSpec,
} from '@platform/application';
import {
  CONTAINER_CACHE_MOUNT,
  CONTAINER_CONTROL_MOUNT,
  egressContainerName,
  runContainerName,
  runNetworkName,
  WORKSPACE_WORKDIR,
  workspaceVolumeName,
} from './names.js';

/** Where the repository's sources are mounted when {@link WorkspaceImages.runtimeSourceDir} is set. */
export const RUNTIME_SOURCE_MOUNT = '/repo';

/**
 * The file that makes a directory a checkout of this repository, and therefore the only kind of
 * directory {@link WorkspaceImages.runtimeSourceDir} is for.
 */
export const WORKSPACE_MARKER = 'pnpm-workspace.yaml';

export interface WorkspaceImages {
  /** The run container's image. `platform-runtime` in production (WP-22). */
  readonly runtime: string;
  /** The egress sidecar's image (tinyproxy). */
  readonly egress: string;
  /**
   * The sidecar's command, when the image's own entrypoint is not the proxy.
   *
   * Empty in production: `platform-egress`'s entrypoint *is* tinyproxy. It exists for the same
   * reason {@link WorkspaceImages.runtimeSourceDir} does — that image is WP-22's and does not
   * exist yet, so the e2e runs a stand-in that has to be told to stay alive. WP-22 removes it.
   */
  readonly egressCommand?: readonly string[];
  /** A git-bearing image for the mirror, clone and export helpers. */
  readonly git: string;
  /**
   * WP-22 removes this. Absolute host path of the repository, mounted read-only at `/repo` so the
   * run shim can be started from source until the `platform-runtime` image exists.
   */
  readonly runtimeSourceDir: string | null;
}

export interface DockerMount {
  readonly Type: 'volume' | 'bind' | 'tmpfs';
  readonly Source: string;
  readonly Target: string;
  readonly ReadOnly: boolean;
  readonly VolumeOptions?: { readonly Subpath: string };
  readonly BindOptions?: { readonly Propagation: 'rprivate' };
}

export interface DockerHostConfig {
  readonly CapDrop: readonly string[];
  readonly CapAdd: readonly string[];
  readonly SecurityOpt: readonly string[];
  readonly ReadonlyRootfs: boolean;
  readonly Tmpfs: Readonly<Record<string, string>>;
  readonly Memory: number;
  readonly MemorySwap: number;
  readonly NanoCpus: number;
  readonly PidsLimit: number;
  readonly Init: boolean;
  readonly Runtime: WorkspaceRuntime;
  readonly NetworkMode: string;
  readonly Mounts: readonly DockerMount[];
  readonly Privileged: false;
  readonly PublishAllPorts: false;
  readonly PortBindings: Readonly<Record<string, never>>;
  readonly AutoRemove: false;
  readonly RestartPolicy: { readonly Name: 'no' };
  readonly ExtraHosts: readonly string[];
  readonly GroupAdd: readonly string[];
}

export interface DockerCreateBody {
  readonly Image: string;
  readonly Cmd: readonly string[];
  readonly Entrypoint: readonly string[] | null;
  readonly Env: readonly string[];
  readonly User: string;
  readonly WorkingDir: string;
  readonly Labels: Readonly<Record<string, string>>;
  readonly StopTimeout: number;
  readonly AttachStdout: false;
  readonly AttachStderr: false;
  readonly OpenStdin: false;
  readonly Tty: boolean;
  readonly HostConfig: DockerHostConfig;
}

/** The uid every run container runs as, and therefore the uid the runner must be (Q51). */
export const WORKSPACE_UID = 1000;
export const WORKSPACE_GID = 1000;

const MIB = 1024 * 1024;

/** The two filesystem questions the guard asks, injected so a test can pose them a platform. */
export interface BindSourceChecks {
  readonly resolve?: (p: string) => string;
  readonly exists?: (p: string) => boolean;
}

/**
 * Validates a bind source: absolute, its own `realpath`, and a checkout of this repository.
 *
 * The `realpath` check is the one worth reading twice: Docker resolves a bind source on the
 * *daemon's* filesystem, so a symlink at the path we pass is followed by the daemon, not by us —
 * and `/home/ci/repo -> /` would mount the host root read-only into a container running an agent.
 *
 * ## Why an allow-condition and not a list of forbidden roots
 *
 * Round 1 refused `/`, `/proc`, `/sys`, `/dev`, `/run`, `/var/run`, `/etc` and `/boot`. Measured on
 * macOS, that list refused **none** of them by its own branch: `/etc` resolves to `/private/etc`
 * and `/var/run` to `/private/var/run`, so they were caught as symlinks, while `$HOME` and the
 * Docker socket's realpath — the two paths that really do hand over the machine — are their own
 * realpath and passed. The reviewer bound `$HOME` at `/repo` and read `~/.ssh/id_ed25519` and
 * `~/.docker/config.json` from inside a workspace container with every hardening flag on. *A
 * deny-list of paths inherits the platform's symlink layout rather than the author's intent*
 * (standing rule 15's shape, one layer up).
 *
 * So the condition is now positive: the resolved directory must contain {@link WORKSPACE_MARKER}.
 * `$HOME` does not, a socket does not, `/` does not.
 *
 * ## What this is and is not
 *
 * It is a guard against an **operator's** mistake, not against an attacker: the value comes from
 * the launcher's own environment, and anyone who can set it can also run the launcher. It bounds
 * the blast radius of a mis-set variable — the class of accident WP-22 removes entirely by shipping
 * an image that needs no bind at all.
 *
 * It is **not** proof that the directory is *this* checkout, or that the checkout is trustworthy: a
 * `pnpm-workspace.yaml` is a file anyone can create, so a hostile operator can still satisfy it.
 * And a checkout that *contains* a symlink is still mounted with that symlink in it — the guard
 * resolves the mount point, and nothing deeper.
 */
export const assertSafeBindSource = (source: string, checks: BindSourceChecks = {}): string => {
  const resolve = checks.resolve ?? realpathSync;
  const exists = checks.exists ?? existsSync;
  if (!path.isAbsolute(source)) {
    throw new WorkspaceError('invalid_spec', 'bind source is not an absolute path', {
      detail: source,
    });
  }
  const normalised = path.normalize(source).replace(/\/+$/, '') || '/';
  let real: string;
  try {
    real = resolve(normalised);
  } catch (cause) {
    throw new WorkspaceError('invalid_spec', 'bind source does not exist', {
      detail: normalised,
      cause,
    });
  }
  if (real !== normalised) {
    throw new WorkspaceError('invalid_spec', 'bind source is a symlink', {
      detail: `${normalised} -> ${real}`,
    });
  }
  if (!exists(path.join(real, WORKSPACE_MARKER))) {
    throw new WorkspaceError(
      'invalid_spec',
      `bind source is not a checkout of this repository (no ${WORKSPACE_MARKER} in it)`,
      { detail: real },
    );
  }
  return real;
};

const limitsToHostConfig = (
  limits: WorkspaceLimits,
): Pick<DockerHostConfig, 'Memory' | 'MemorySwap' | 'NanoCpus' | 'PidsLimit' | 'Tmpfs'> => ({
  Memory: limits.memoryMb * MIB,
  // Equal to `Memory`, which is Docker's spelling of "no swap on top of the limit". Left at the
  // default, a container over its memory limit swaps instead of failing, and the limit stops
  // bounding anything.
  MemorySwap: limits.memoryMb * MIB,
  NanoCpus: Math.round(limits.cpus * 1e9),
  PidsLimit: limits.pidsLimit,
  Tmpfs: { '/tmp': `size=${limits.tmpfsMb}m,mode=1777,nosuid,nodev` },
});

export interface RunContainerInput {
  readonly spec: WorkspaceSpec;
  readonly images: WorkspaceImages;
  readonly controlVolume: string;
  readonly cacheVolume: string;
  readonly labels: Readonly<Record<string, string>>;
  /** The shim's entrypoint, as the image provides it. */
  readonly command: readonly string[];
  readonly entrypoint: readonly string[] | null;
  readonly env: Readonly<Record<string, string>>;
  readonly bindChecks?: BindSourceChecks;
}

/**
 * The run container's create body: technical/05's flags, TD-025 §2's volumes.
 *
 * Note what is *absent* and is meant to be: no `Binds` (the legacy string form, which is how a
 * host mount usually sneaks in), no published ports, no `CapAdd`, no `Privileged`, no Docker
 * socket. Absence is asserted, not assumed — `hardening.test.ts` enumerates the create body's own
 * members rather than the fields this function happens to set (standing rule 37).
 */
export const runContainerCreateBody = (input: RunContainerInput): DockerCreateBody => {
  const { spec, images } = input;
  const mounts: DockerMount[] = [
    { Type: 'volume', Source: workspaceVolumeName(spec.runId), Target: '/work', ReadOnly: false },
    {
      Type: 'volume',
      Source: input.controlVolume,
      Target: CONTAINER_CONTROL_MOUNT,
      ReadOnly: false,
      VolumeOptions: { Subpath: spec.runId },
    },
    { Type: 'volume', Source: input.cacheVolume, Target: CONTAINER_CACHE_MOUNT, ReadOnly: true },
  ];
  if (images.runtimeSourceDir !== null) {
    mounts.push({
      Type: 'bind',
      Source: assertSafeBindSource(images.runtimeSourceDir, input.bindChecks ?? {}),
      Target: RUNTIME_SOURCE_MOUNT,
      ReadOnly: true,
      BindOptions: { Propagation: 'rprivate' },
    });
  }

  return {
    Image: images.runtime,
    Cmd: input.command,
    Entrypoint: input.entrypoint,
    Env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
    User: `${WORKSPACE_UID}:${WORKSPACE_GID}`,
    WorkingDir: WORKSPACE_WORKDIR,
    Labels: input.labels,
    StopTimeout: spec.limits.stopGraceSeconds,
    AttachStdout: false,
    AttachStderr: false,
    OpenStdin: false,
    Tty: false,
    HostConfig: {
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      ...limitsToHostConfig(spec.limits),
      Init: true,
      Runtime: spec.runtime,
      NetworkMode: runNetworkName(spec.runId),
      Mounts: mounts,
      Privileged: false,
      PublishAllPorts: false,
      PortBindings: {},
      AutoRemove: false,
      RestartPolicy: { Name: 'no' },
      ExtraHosts: [],
      GroupAdd: [],
    },
  };
};

export interface SidecarInput {
  readonly spec: WorkspaceSpec;
  readonly images: WorkspaceImages;
  readonly labels: Readonly<Record<string, string>>;
  readonly command: readonly string[];
  readonly entrypoint: readonly string[] | null;
  readonly configVolume: string;
}

/**
 * The egress sidecar's create body.
 *
 * It is the only container of a run with a route off the internal network, so it is hardened the
 * same way minus the parts a proxy needs: it keeps a read-only rootfs, drops every capability and
 * publishes nothing. It runs as uid 1000 as well, so the rendered allow-list on the config volume
 * — written by the launcher, owned by 1000 — is readable without widening anything.
 */
export const sidecarCreateBody = (input: SidecarInput): DockerCreateBody => ({
  Image: input.images.egress,
  Cmd: input.command,
  Entrypoint: input.entrypoint,
  Env: [],
  User: `${WORKSPACE_UID}:${WORKSPACE_GID}`,
  WorkingDir: '/',
  Labels: input.labels,
  StopTimeout: input.spec.limits.stopGraceSeconds,
  AttachStdout: false,
  AttachStderr: false,
  OpenStdin: false,
  Tty: false,
  HostConfig: {
    CapDrop: ['ALL'],
    CapAdd: [],
    SecurityOpt: ['no-new-privileges:true'],
    ReadonlyRootfs: true,
    Tmpfs: { '/tmp': 'size=16m,mode=1777,nosuid,nodev' },
    Memory: 128 * MIB,
    MemorySwap: 128 * MIB,
    NanoCpus: Math.round(0.5 * 1e9),
    PidsLimit: 64,
    Init: true,
    Runtime: 'runc',
    NetworkMode: runNetworkName(input.spec.runId),
    Mounts: [{ Type: 'volume', Source: input.configVolume, Target: '/etc/egress', ReadOnly: true }],
    Privileged: false,
    PublishAllPorts: false,
    PortBindings: {},
    AutoRemove: false,
    RestartPolicy: { Name: 'no' },
    ExtraHosts: [],
    GroupAdd: [],
  },
});

/** The names the daemon will know a run's objects by. */
export const runObjectNames = (runId: string) => ({
  container: runContainerName(runId),
  sidecar: egressContainerName(runId),
  network: runNetworkName(runId),
  volume: workspaceVolumeName(runId),
});
