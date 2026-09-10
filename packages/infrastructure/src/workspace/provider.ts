/**
 * `DockerWorkspaceProvider` — the launcher's core (TD-021, technical/05 § "Workspace lifecycle").
 *
 * One run, one network, one volume, one control directory, one sidecar, one container. Everything
 * it makes is labelled with the run id, because the retention sweep asks the daemon what exists
 * rather than carrying a list of its own (standing rule 7).
 *
 * ## The three obligations WP-13 left here, and where each is discharged
 *
 *  1. **Create and `chown` `<ctl>/<run-id>/` before the run container starts.** The daemon refuses
 *     a `volume-subpath` that does not exist — measured, loudly, on Docker 29.7.2 — and a volume's
 *     root is `root:root 0755`, so a container running as uid 1000 cannot create its socket in it.
 *     `#prepare` does both, plus the token file at `0600`, before anything else is created.
 *  2. **The runner runs as uid 1000** (Q51). The socket is `0600` and there is no mode knob;
 *     `assertRunnerUid` is called at construction so the mismatch is a startup failure naming the
 *     two uids, not a `connect ECONNREFUSED` three minutes into a run.
 *  3. **`docker stop`/`rm` on every path that ends a run.** The shim signals one pid, so a child
 *     that forked a *detached* grandchild leaves it running — measured, and no signal from the shim
 *     can reach it. Only the container's pid namespace ending does. So `kill` stops the container,
 *     `destroy` stops it again before removing anything (a stop of an already-exited container is a
 *     no-op), and a `create` that fails half way runs the same teardown before it throws.
 *
 *     **Which layer owns which half, because this class cannot own both.** What a *method* here
 *     promises is per call: none of them returns or throws with a container it started still
 *     running and named by no handle. `create`'s `catch` is that promise, and
 *     `docker-workspace.e2e.test.ts` › "leaves no container, network or sidecar behind when a step
 *     fails" is where it is measured against a daemon. What it cannot promise is the same thing
 *     for a *sequence* of its calls: between `create` returning and the caller storing the handle,
 *     the only reference to a live container is the caller's local. That half belongs to the
 *     composition root — `LauncherService.startRun`, which reopened exactly this gap in WP-14's
 *     round 1 by letting a failed `attach` throw past a created container — and it is enforced by
 *     enumeration rather than asserted in prose: `service.test.ts` › "leaves nothing running
 *     whichever step fails, for every step it performs" fails the n-th provider call for every n
 *     the successful path makes, so a step added later is covered the day it is added (standing
 *     rule 44). Both citations are resolved mechanically by `scripts/citations.test.ts` — and both
 *     of them run over the wrap, which is exactly where round 2's line-scoped parser lost them
 *     while this sentence claimed otherwise, so they are also the shapes its recall check counts.
 *
 * ## What the helper containers are
 *
 * The launcher has no git and no filesystem access to a named volume, so every filesystem step —
 * the mirror fetch, the clone, the control directory, the sidecar's config, the export — is a
 * short-lived container. They are hardened like the run container and, except for the two that
 * must reach the git host, they run with `NetworkMode: none`: the clone reads from the local
 * mirror rather than from the network, which is what the mirror is *for*, and it means the one
 * container that handles repository content at create time cannot talk to anything.
 *
 * ## Secrets: the redaction list travels with the thing it redacts
 *
 * A helper's output can quote a remote's error, and a remote's error quotes URLs and the output of
 * a credential helper. The only secret this class handles is the run-scoped credential, and it is
 * *per run* — so a `SecretRedactor` built at construction could not hold it, and a constructor
 * argument that in practice held nothing is the identity function wearing a security type
 * (standing rule 31 is about exactly that, and rule 41 about a second guard that can never be made
 * to fail).
 *
 * Instead the one function that puts a credential into a helper's environment returns the
 * environment **and** the secrets in it, so a caller cannot do the first without the second.
 * `#helper` requires that list, empty or not, and `provider.test.ts` plants the credential in a
 * helper's output and looks for it in the error (rule 35: the type gets you the argument, only a
 * planted secret gets you the behaviour).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  Logger,
  PurgedWorkspace,
  PurgeReport,
  WorkspaceAttachment,
  WorkspaceExport,
  WorkspaceExportRequest,
  WorkspaceGitCredential,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceRepo,
  WorkspaceSpec,
} from '@platform/application';
import {
  exactSecretRedactor,
  MIN_SECRET_LENGTH,
  silentLogger,
  WORKSPACE_LABELS,
  WorkspaceError,
  workspaceSpecSchema,
} from '@platform/application';
import { EGRESS_CONFIG_MOUNT, egressProxyUrl, renderEgressConfig } from './egress.js';
import type { DockerEngine, EngineVolume } from './engine.js';
import {
  type DockerMount,
  RUNTIME_SOURCE_MOUNT,
  runContainerCreateBody,
  runObjectNames,
  sidecarCreateBody,
  WORKSPACE_GID,
  WORKSPACE_UID,
  type WorkspaceImages,
} from './hardening.js';
import {
  assertRunId,
  CONTAINER_CACHE_MOUNT,
  controlDirectory,
  controlSocketPath,
  egressContainerName,
  mirrorPath,
  WORKSPACE_WORKDIR,
  workspaceVolumeName,
} from './names.js';
import { retentionDecisions } from './retention.js';
import { filterTar, parseTar } from './tar.js';

/**
 * Environment names a project may not set on its own run container.
 *
 * Not hygiene: `HTTPS_PROXY` is where the workspace's egress goes, `RUNLET_*` is how the control
 * channel is found and authenticated, and `GIT_CONFIG_*` is what makes the credential helper the
 * shim rather than something in the repository. A project narrowing the org's maximum is BD-025's
 * design; a project *redirecting* the run's proxy is not, so these are refused rather than
 * overridden — an overridden value is a policy violation that succeeds quietly.
 */
const RESERVED_ENV_PREFIXES = [
  'RUNLET_',
  'GIT_CONFIG',
  'CLAUDE_',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'HOME',
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'NODE_OPTIONS',
];

/** 32 hex characters, as `runlet/token.ts` says the launcher mints. */
export const mintRunToken = (): string => randomBytes(16).toString('hex');

export interface DockerWorkspaceProviderOptions {
  readonly engine: DockerEngine;
  readonly images: WorkspaceImages;
  /** The shared control volume (TD-025 §2) — one for the whole instance, one sub-directory per run. */
  readonly controlVolume: string;
  /** Where that volume is mounted in the *runner's* filesystem. */
  readonly controlRoot: string;
  /** The shared `repo-cache` volume holding one bare mirror per project. */
  readonly cacheVolume: string;
  /** Where the cache volume is mounted inside a helper container. */
  readonly cacheMount?: string;
  /** A network with a route out, for the two helpers that must reach the git host. */
  readonly helperNetwork: string;
  /** The network the egress sidecar is connected to besides the run's own. */
  readonly egressNetwork: string;
  readonly logger?: Logger;
  /** `process.getuid()` in production; a number in tests. Q51: it must be 1000. */
  readonly runnerUid: number;
  readonly mintToken?: () => string;
  readonly now?: () => Date;
  /** Ceiling on an export archive read into memory. */
  readonly maxExportBytes?: number;
}

interface CreatedObjects {
  network: string | null;
  volume: string | null;
  configVolume: string | null;
  sidecar: string | null;
  container: string | null;
  controlPrepared: boolean;
}

interface HelperRun {
  readonly name: string;
  readonly image: string;
  readonly script: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly mounts: readonly DockerMount[];
  readonly user: string;
  readonly network: string;
  readonly capAdd?: readonly string[];
  /**
   * Every secret this helper's environment carries, so its output can be redacted before it
   * becomes an error detail or a log line. Required, empty or not: an optional list is a list
   * somebody forgets.
   */
  readonly secrets: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  /** Keep the container so its filesystem can be read with `getArchive`. */
  readonly keep?: boolean;
}

const MIB = 1024 * 1024;

/**
 * Q51, asserted at construction.
 *
 * The control socket is `0600` and the shim creates it as uid 1000, so a runner process on another
 * uid gets `EACCES` on connect — "a one-line failure that looks like a protocol bug", in WP-13's
 * words. Refusing here turns it into a startup error that names both numbers.
 */
export const assertRunnerUid = (uid: number): void => {
  if (uid !== WORKSPACE_UID) {
    throw new WorkspaceError(
      'invalid_spec',
      `the runner must run as uid ${WORKSPACE_UID} to reach the run shim's 0600 control socket ` +
        `(this process is uid ${uid}) — TD-025, Q51`,
    );
  }
};

export class DockerWorkspaceProvider implements WorkspaceProvider {
  readonly #engine: DockerEngine;
  readonly #images: WorkspaceImages;
  readonly #controlVolume: string;
  readonly #controlRoot: string;
  readonly #cacheVolume: string;
  readonly #cacheMount: string;
  readonly #helperNetwork: string;
  readonly #egressNetwork: string;
  readonly #logger: Logger;
  readonly #mintToken: () => string;
  readonly #now: () => Date;
  readonly #maxExportBytes: number;
  /** One mirror is one directory; two fetches into it race. Serialised per project. */
  readonly #mirrorLocks = new Map<string, Promise<unknown>>();

  constructor(options: DockerWorkspaceProviderOptions) {
    assertRunnerUid(options.runnerUid);
    this.#engine = options.engine;
    this.#images = options.images;
    this.#controlVolume = options.controlVolume;
    this.#controlRoot = options.controlRoot;
    this.#cacheVolume = options.cacheVolume;
    this.#cacheMount = options.cacheMount ?? CONTAINER_CACHE_MOUNT;
    this.#helperNetwork = options.helperNetwork;
    this.#egressNetwork = options.egressNetwork;
    this.#logger = options.logger ?? silentLogger;
    this.#mintToken = options.mintToken ?? mintRunToken;
    this.#now = options.now ?? (() => new Date());
    this.#maxExportBytes = options.maxExportBytes ?? 128 * MIB;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  #labels(spec: { runId: string; projectId: string }, role: string, keepUntil: string) {
    return {
      [WORKSPACE_LABELS.run]: spec.runId,
      [WORKSPACE_LABELS.project]: spec.projectId,
      [WORKSPACE_LABELS.role]: role,
      [WORKSPACE_LABELS.keepUntil]: keepUntil,
      [WORKSPACE_LABELS.createdAt]: this.#now().toISOString(),
    };
  }

  /**
   * Redacts a helper's output against the secrets that helper was given.
   *
   * A value shorter than `MIN_SECRET_LENGTH` is dropped rather than redacted: `exactSecretRedactor`
   * refuses one because replacing a three-character string would turn ordinary text into
   * placeholders, and failing a *run* because a provider handed back a short token is the wrong
   * trade — such a token is a provider bug, and one whose value is visible either way.
   */
  #redact(text: string, secrets: readonly string[]): string {
    const usable = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH);
    if (usable.length === 0) {
      return text;
    }
    return exactSecretRedactor(
      usable.map((value, index) => ({ name: `run_credential_${index}`, value })),
    ).redactText(text).value;
  }

  /**
   * Runs one helper container to completion and removes it.
   *
   * A non-zero exit is a `workspace_failed` carrying the helper's own output, redacted. That
   * output is the only diagnostic an operator gets for "the clone failed", so it is not swallowed
   * — and it is not printed raw either.
   */
  async #helper(run: HelperRun): Promise<{ readonly output: string; readonly id: string }> {
    const body = {
      Image: run.image,
      Entrypoint: ['/bin/sh', '-c'],
      Cmd: [run.script],
      Env: Object.entries(run.env ?? {}).map(([key, value]) => `${key}=${value}`),
      User: run.user,
      WorkingDir: '/',
      Labels: run.labels,
      AttachStdout: false,
      AttachStderr: false,
      OpenStdin: false,
      Tty: false,
      HostConfig: {
        CapDrop: ['ALL'],
        CapAdd: run.capAdd ?? [],
        SecurityOpt: ['no-new-privileges:true'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'size=64m,mode=1777,nosuid,nodev' },
        Memory: 512 * MIB,
        MemorySwap: 512 * MIB,
        NanoCpus: 2e9,
        PidsLimit: 256,
        Init: true,
        NetworkMode: run.network,
        Mounts: run.mounts,
        Privileged: false,
        PublishAllPorts: false,
        PortBindings: {},
        AutoRemove: false,
        RestartPolicy: { Name: 'no' },
      },
    };
    const id = await this.#createHelperContainer(run.name, body);
    let output = '';
    try {
      await this.#engine.startContainer(id);
      const exitCode = await this.#engine.waitContainer(id);
      output = this.#redact(await this.#engine.containerLogs(id), run.secrets);
      if (exitCode !== 0) {
        // Logged as well as thrown: the caller decides what to do with a `WorkspaceError`, and
        // more than one of them drops the `detail` on the way out. The helper's own words are the
        // only diagnostic there is for "the clone failed", and they are already redacted.
        this.#logger.warn(
          { helper: run.name, exit_code: exitCode, detail: output.slice(-2000) },
          'workspace helper container failed',
        );
        throw new WorkspaceError('workspace_failed', `helper ${run.name} exited ${exitCode}`, {
          detail: output.slice(-2000),
        });
      }
    } finally {
      if (run.keep !== true) {
        await this.#engine.removeContainer(id).catch(() => undefined);
      }
    }
    return { output, id };
  }

  /**
   * Creates a helper container, clearing a stale one of the same name first.
   *
   * Helper names are derived from the run id rather than from a timestamp, so they are the same on
   * every attempt — which is what makes a crashed launcher's leftovers findable, and what would
   * otherwise make the next run fail with `409 name already in use` for ever. The removal is
   * narrow on purpose: only on that exact refusal, only once, and only for a name this class
   * builds.
   */
  async #createHelperContainer(name: string, body: unknown): Promise<string> {
    try {
      return await this.#engine.createContainer(name, body);
    } catch (error) {
      if (!(error instanceof WorkspaceError) || !/already in use/.test(error.detail ?? '')) {
        throw error;
      }
      this.#logger.warn({ helper: name }, 'removing a helper container left by an earlier run');
      await this.#engine.removeContainer(name);
      return this.#engine.createContainer(name, body);
    }
  }

  #volumeMount(source: string, target: string, readOnly: boolean): DockerMount {
    return { Type: 'volume', Source: source, Target: target, ReadOnly: readOnly };
  }

  // ── Mirror ─────────────────────────────────────────────────────────────────

  async updateMirror(input: {
    readonly projectId: string;
    readonly repo: WorkspaceRepo;
    readonly credential: WorkspaceGitCredential | null;
  }): Promise<{ readonly cachePath: string; readonly updated: boolean }> {
    const cachePath = mirrorPath(this.#cacheMount, input.repo.cacheKey);
    const previous = this.#mirrorLocks.get(input.repo.cacheKey) ?? Promise.resolve();
    const work = previous
      .catch(() => undefined)
      .then(async () => {
        await this.#ensureVolume(this.#cacheVolume);
        await this.#helper({
          name: `mirror-${input.repo.cacheKey}`,
          image: this.#images.git,
          // `gc.auto 0` because workspaces clone with the mirror as their object source
          // (technical/05 §1: "gc disabled while workspaces reference it"); a gc here would
          // delete objects a live run's alternates still point at.
          script: [
            'set -e',
            `if [ -d "${cachePath}" ]; then`,
            `  git -C "${cachePath}" remote set-url origin "$REPO_URL"`,
            `  git -C "${cachePath}" config gc.auto 0`,
            `  git -C "${cachePath}" remote update --prune`,
            'else',
            `  git clone --mirror "$REPO_URL" "${cachePath}"`,
            `  git -C "${cachePath}" config gc.auto 0`,
            'fi',
            `git -C "${cachePath}" rev-parse --is-bare-repository`,
          ].join('\n'),
          ...this.#gitCredentialEnv(input.credential, { REPO_URL: input.repo.url }),
          mounts: [this.#volumeMount(this.#cacheVolume, this.#cacheMount, false)],
          // Root, and it stays root: the mirror is written into a volume whose root is
          // `root:root`, and a helper with `cap-drop ALL` has no `DAC_OVERRIDE`, so root writing
          // into a tree owned by anyone else is refused exactly as an ordinary user would be. The
          // consumers run as 1000 and reach it through `safe.directory`, one exact quoted path
          // each — measured the hard way: chowning the mirror to 1000 made the *next* update fail
          // with `could not lock config file config: Permission denied`.
          user: '0:0',
          network: this.#helperNetwork,
          labels: {
            [WORKSPACE_LABELS.project]: input.projectId,
            [WORKSPACE_LABELS.role]: 'mirror',
          },
        });
        return { cachePath, updated: true };
      });
    this.#mirrorLocks.set(input.repo.cacheKey, work);
    try {
      return await work;
    } finally {
      if (this.#mirrorLocks.get(input.repo.cacheKey) === work) {
        this.#mirrorLocks.delete(input.repo.cacheKey);
      }
    }
  }

  /**
   * The credential, as environment for a helper's `credential.helper`.
   *
   * Never embedded in the URL: a URL with a password in it is echoed by git in error messages, put
   * into `.git/config` by `clone`, and recorded in the container's own configuration. A helper
   * script reading two variables keeps it out of all three.
   */
  #gitCredentialEnv(
    credential: WorkspaceGitCredential | null,
    extra: Readonly<Record<string, string>>,
  ): { readonly env: Record<string, string>; readonly secrets: readonly string[] } {
    const base: Record<string, string> = { HOME: '/tmp', ...extra };
    if (credential === null) {
      return { env: base, secrets: [] };
    }
    return {
      env: {
        ...base,
        GIT_USER: credential.username,
        GIT_PASS: credential.password,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '!f() { echo "username=$GIT_USER"; echo "password=$GIT_PASS"; }; f',
      },
      secrets: [credential.password],
    };
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(rawSpec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const parsed = workspaceSpecSchema.safeParse(rawSpec);
    if (!parsed.success) {
      throw new WorkspaceError('invalid_spec', 'workspace spec did not validate', {
        detail: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      });
    }
    const spec = parsed.data;
    assertRunId(spec.runId);
    assertProjectEnv(spec.env);

    const names = runObjectNames(spec.runId);
    const token = this.#mintToken();
    const made: CreatedObjects = {
      network: null,
      volume: null,
      configVolume: null,
      sidecar: null,
      container: null,
      controlPrepared: false,
    };

    try {
      await this.#ensureVolume(this.#controlVolume);
      await this.#ensureVolume(this.#cacheVolume);

      made.network = await this.#engine.createNetwork({
        name: names.network,
        internal: true,
        labels: this.#labels(spec, 'network', spec.keepUntil),
      });
      made.volume = await this.#engine.createVolume({
        name: names.volume,
        labels: this.#labels(spec, 'workspace', spec.keepUntil),
      });

      await this.#prepare(spec, token);
      made.controlPrepared = true;
      await this.#clone(spec);

      const sidecarHost = await this.#startSidecar(spec, made);

      const env = this.#runContainerEnv(spec, sidecarHost);
      made.container = await this.#engine.createContainer(
        names.container,
        runContainerCreateBody({
          spec,
          images: this.#images,
          controlVolume: this.#controlVolume,
          cacheVolume: this.#cacheVolume,
          labels: this.#labels(spec, 'workspace', spec.keepUntil),
          command: this.#runtimeCommand(),
          entrypoint: this.#runtimeEntrypoint(),
          env,
        }),
      );
      await this.#engine.startContainer(made.container);

      return {
        runId: spec.runId,
        projectId: spec.projectId,
        containerId: made.container,
        sidecarContainerId: made.sidecar,
        networkId: made.network,
        volumeName: names.volume,
        cacheKey: spec.repo.cacheKey,
        controlSubPath: spec.runId,
        keepUntil: spec.keepUntil,
      };
    } catch (error) {
      // Either a handle or nothing: a half-created run whose container is up is a container
      // running an agent that no handle names, and nothing would ever stop it.
      await this.#teardown(spec.runId, made, spec.limits.stopGraceSeconds);
      throw error;
    }
  }

  async #ensureVolume(name: string): Promise<void> {
    await this.#engine.createVolume({ name, labels: { [WORKSPACE_LABELS.role]: 'shared' } });
  }

  /**
   * WP-13's first obligation: the control sub-directory, owned by the uid the shim runs as, before
   * the run container starts. Also chowns the workspace volume's root, for the same reason — a
   * volume's root is `root:root` and the clone runs as 1000.
   */
  async #prepare(spec: WorkspaceSpec, token: string): Promise<void> {
    const dir = `/ctl/${spec.runId}`;
    await this.#helper({
      name: `prep-${spec.runId}`,
      image: this.#images.git,
      script: [
        'set -e',
        `mkdir -p ${dir} /work`,
        `printf %s "$RUNLET_TOKEN" > ${dir}/token`,
        `chmod 700 ${dir}`,
        `chmod 600 ${dir}/token`,
        `chown -R ${WORKSPACE_UID}:${WORKSPACE_GID} ${dir}`,
        `chown ${WORKSPACE_UID}:${WORKSPACE_GID} /work`,
        `ls -ld ${dir}`,
      ].join('\n'),
      // The token travels as environment rather than on the command line. Both are visible in this
      // helper's own `docker inspect`, and it is removed within a second — the exposure that
      // matters is the *run* container's, where every process the agent starts can read
      // `/proc/<pid>/environ`, and this is not that container. `RUNLET_TOKEN_FILE` exists for that
      // reason and is what the run container gets.
      env: { RUNLET_TOKEN: token },
      // The run token authenticates the control connection; a helper that echoed it would
      // put it in the launcher's log.
      secrets: [token],
      mounts: [
        this.#volumeMount(this.#controlVolume, '/ctl', false),
        this.#volumeMount(workspaceVolumeName(spec.runId), '/work', false),
      ],
      user: '0:0',
      // `chown` needs CAP_CHOWN even as root; everything else stays dropped.
      capAdd: ['CHOWN'],
      network: 'none',
      labels: this.#labels(spec, 'prepare', spec.keepUntil),
    });
  }

  /**
   * The clone, from the local mirror, with **no network at all**.
   *
   * technical/05 §2 writes this as `git clone --reference /cache/<project>.git`; cloning *from* the
   * mirror with `--shared` is the same mechanism (an `objects/info/alternates` entry pointing at
   * `/cache/<key>.git`, which the run container also has mounted, read-only, at the same path) and
   * it removes the network from the one step that handles repository content at create time. The
   * doc carries that sentence now.
   */
  async #clone(spec: WorkspaceSpec): Promise<void> {
    const cachePath = mirrorPath(this.#cacheMount, spec.repo.cacheKey);
    const checkout =
      spec.repo.checkoutBranch === null
        ? ''
        : `git -C /work/repo checkout "$CHECKOUT_BRANCH" 2>/dev/null || ` +
          `git -C /work/repo checkout -b "$CHECKOUT_BRANCH"`;
    await this.#helper({
      name: `clone-${spec.runId}`,
      image: this.#images.git,
      script: [
        'set -e',
        // The mirror is written by a root helper and read here as uid 1000; git refuses a
        // repository owned by another user unless it is told the ownership is expected.
        `git config --global --add safe.directory "${cachePath}"`,
        'git config --global --add safe.directory /work/repo',
        `git clone --shared --branch "$DEFAULT_BRANCH" "${cachePath}" /work/repo`,
        'git -C /work/repo remote set-url origin "$REPO_URL"',
        checkout,
        'git -C /work/repo rev-parse HEAD',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      env: {
        HOME: '/tmp',
        REPO_URL: spec.repo.url,
        DEFAULT_BRANCH: spec.repo.defaultBranch,
        ...(spec.repo.checkoutBranch === null ? {} : { CHECKOUT_BRANCH: spec.repo.checkoutBranch }),
      },
      mounts: [
        this.#volumeMount(workspaceVolumeName(spec.runId), '/work', false),
        this.#volumeMount(this.#cacheVolume, this.#cacheMount, true),
      ],
      user: `${WORKSPACE_UID}:${WORKSPACE_GID}`,
      secrets: [],
      network: 'none',
      labels: this.#labels(spec, 'clone', spec.keepUntil),
    });
  }

  /** The egress sidecar, or `null` when the spec allows no host at all. */
  async #startSidecar(spec: WorkspaceSpec, made: CreatedObjects): Promise<string | null> {
    if (spec.egress.hosts.length === 0) {
      this.#logger.info({ run_id: spec.runId }, 'no egress hosts allowed: no sidecar');
      return null;
    }
    const rendered = renderEgressConfig(spec.egress);
    const configVolume = `egress-${spec.runId}`;
    made.configVolume = await this.#engine.createVolume({
      name: configVolume,
      labels: this.#labels(spec, 'egress-config', spec.keepUntil),
    });
    await this.#helper({
      name: `egresscfg-${spec.runId}`,
      image: this.#images.git,
      script: [
        'set -e',
        `printf %s "$EGRESS_CONF" > ${EGRESS_CONFIG_MOUNT}/tinyproxy.conf`,
        `printf %s "$EGRESS_FILTER" > ${EGRESS_CONFIG_MOUNT}/filter`,
        `chmod 644 ${EGRESS_CONFIG_MOUNT}/tinyproxy.conf ${EGRESS_CONFIG_MOUNT}/filter`,
      ].join('\n'),
      env: { EGRESS_CONF: rendered.config, EGRESS_FILTER: rendered.filter },
      mounts: [this.#volumeMount(configVolume, EGRESS_CONFIG_MOUNT, false)],
      user: '0:0',
      secrets: [],
      network: 'none',
      labels: this.#labels(spec, 'egress-config', spec.keepUntil),
    });

    const sidecar = await this.#engine.createContainer(
      egressContainerName(spec.runId),
      sidecarCreateBody({
        spec,
        images: this.#images,
        labels: this.#labels(spec, 'egress', spec.keepUntil),
        command: this.#images.egressCommand ?? [],
        entrypoint: null,
        configVolume,
      }),
    );
    made.sidecar = sidecar;
    // The sidecar is the only container of a run with two networks; that asymmetry *is* the
    // network policy. The run container has one, and it is `internal: true`.
    await this.#engine.connectNetwork(this.#egressNetwork, sidecar);
    await this.#engine.startContainer(sidecar);
    return sidecar;
  }

  #runtimeCommand(): readonly string[] {
    return this.#images.runtimeSourceDir === null
      ? []
      : [
          'node',
          '--import',
          `${RUNTIME_SOURCE_MOUNT}/scripts/ts-source-resolver.mjs`,
          `${RUNTIME_SOURCE_MOUNT}/apps/runlet/src/index.ts`,
        ];
  }

  #runtimeEntrypoint(): readonly string[] | null {
    return this.#images.runtimeSourceDir === null ? null : [];
  }

  /** What the git credential helper inside the workspace is (TD-021: `credential.helper=!agentic-cred`). */
  #credentialHelperCommand(): string {
    return this.#images.runtimeSourceDir === null
      ? '!agentic-runlet credential'
      : `!node --import ${RUNTIME_SOURCE_MOUNT}/scripts/ts-source-resolver.mjs ` +
          `${RUNTIME_SOURCE_MOUNT}/apps/runlet/src/index.ts credential`;
  }

  #runContainerEnv(spec: WorkspaceSpec, sidecar: string | null): Record<string, string> {
    const proxy = sidecar === null ? null : egressProxyUrl(egressContainerName(spec.runId));
    return {
      ...spec.env,
      HOME: '/tmp',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      // technical/05 § "Network policy": telemetry hosts blocked, and the CLI told not to try.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      RUNLET_CONTROL_SOCKET: '/ctl/ctl.sock',
      RUNLET_CREDENTIAL_SOCKET: '/ctl/cred.sock',
      RUNLET_TOKEN_FILE: '/ctl/token',
      RUNLET_CHILD_UID: String(WORKSPACE_UID),
      RUNLET_CHILD_GID: String(WORKSPACE_GID),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: this.#credentialHelperCommand(),
      ...(proxy === null
        ? {}
        : { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1' }),
    };
  }

  // ── Attach, kill, destroy ──────────────────────────────────────────────────

  async attach(handle: WorkspaceHandle): Promise<WorkspaceAttachment> {
    const inspect = await this.#engine.inspectContainer(handle.containerId);
    if (!inspect.State.Running) {
      throw new WorkspaceError('not_found', 'the run container is not running', {
        runId: handle.runId,
        detail: inspect.State.Status,
      });
    }
    const token = await this.#readToken(handle.runId);
    return {
      socketPath: controlSocketPath(this.#controlRoot, handle.runId),
      token,
      workdir: WORKSPACE_WORKDIR,
    };
  }

  /**
   * Reads the run token back from the control volume, which the runner has mounted.
   *
   * The launcher minted it; the runner needs it. They are the same process today and separate ones
   * under TD-021's deployment, and in both the volume is the channel — which is why the token is a
   * file on it rather than a value passed through an API that does not exist yet.
   */
  async #readToken(runId: string): Promise<string> {
    const file = path.join(controlDirectory(this.#controlRoot, runId), 'token');
    const { readFile } = await import('node:fs/promises');
    try {
      return (await readFile(file, 'utf8')).trim();
    } catch (cause) {
      throw new WorkspaceError('not_found', 'the run token is not on the control volume', {
        runId,
        cause,
      });
    }
  }

  async kill(handle: WorkspaceHandle): Promise<void> {
    await this.#stopContainer(handle.containerId, 20);
  }

  async #stopContainer(id: string, graceSeconds: number): Promise<void> {
    try {
      await this.#engine.stopContainer(id, graceSeconds);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'not_found') {
        return;
      }
      throw error;
    }
  }

  async destroy(handle: WorkspaceHandle): Promise<void> {
    await this.#teardown(
      handle.runId,
      {
        network: handle.networkId,
        volume: handle.volumeName,
        configVolume: handle.sidecarContainerId === null ? null : `egress-${handle.runId}`,
        sidecar: handle.sidecarContainerId,
        container: handle.containerId,
        controlPrepared: true,
      },
      20,
    );
  }

  /**
   * Stop, then remove, in that order, tolerating every "no such thing".
   *
   * The workspace volume is **not** removed: retention keeps it (technical/05 §5) and
   * `purgeExpired` takes it later. Everything else goes, including the control sub-directory —
   * which holds the run token, so leaving it is leaving a credential on a shared volume.
   */
  async #teardown(runId: string, made: CreatedObjects, graceSeconds: number): Promise<void> {
    const failures: unknown[] = [];
    const step = async (what: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
        this.#logger.warn({ run_id: runId, step: what }, 'workspace teardown step failed');
      }
    };
    if (made.container !== null) {
      const container = made.container;
      await step('stop', () => this.#stopContainer(container, graceSeconds));
      await step('rm', () => this.#engine.removeContainer(container));
    }
    if (made.sidecar !== null) {
      const sidecar = made.sidecar;
      await step('stop-sidecar', () => this.#stopContainer(sidecar, 5));
      await step('rm-sidecar', () => this.#engine.removeContainer(sidecar));
    }
    if (made.controlPrepared) {
      await step('control-dir', () => this.#removeControlDirectory(runId));
    }
    if (made.network !== null) {
      const network = made.network;
      await step('rm-network', () => this.#engine.removeNetwork(network));
    }
    if (made.configVolume !== null) {
      const configVolume = made.configVolume;
      await step('rm-egress-config', () => this.#engine.removeVolume(configVolume));
    }
    if (failures.length > 0) {
      this.#logger.warn({ run_id: runId, failures: failures.length }, 'workspace teardown partial');
    }
  }

  async #removeControlDirectory(runId: string): Promise<void> {
    await this.#helper({
      name: `ctlrm-${assertRunId(runId)}`,
      image: this.#images.git,
      script: `rm -rf /ctl/${assertRunId(runId)}`,
      mounts: [this.#volumeMount(this.#controlVolume, '/ctl', false)],
      user: '0:0',
      secrets: [],
      network: 'none',
      labels: { [WORKSPACE_LABELS.run]: runId, [WORKSPACE_LABELS.role]: 'control-cleanup' },
    });
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  async export(
    handle: WorkspaceHandle,
    request: WorkspaceExportRequest,
    credential: WorkspaceGitCredential | null,
  ): Promise<WorkspaceExport> {
    const name = `export-${assertRunId(handle.runId)}`;
    const wantsTarball = request.tarballPath !== null;
    const helper = await this.#helper({
      name,
      image: this.#images.git,
      script: [
        'set -e',
        'git config --global --add safe.directory /work/repo',
        // The clone is `--shared`: its `objects/info/alternates` points into the mirror, which is
        // root-owned. Without this line every object older than the run is unreadable and the push
        // fails with `remote unpack failed`, which reads like a network fault.
        `git config --global --add safe.directory "${mirrorPath(this.#cacheMount, handle.cacheKey)}"`,
        'cd /work/repo',
        'git config user.email "agentic@localhost"',
        'git config user.name "agentic"',
        'if [ -n "$(git status --porcelain)" ]; then git add -A; git commit -q -m "$COMMIT_MESSAGE"; fi',
        'echo "SHA=$(git rev-parse HEAD)"',
        credential === null
          ? 'echo "PUSHED=no"'
          : 'if git push origin "HEAD:refs/heads/$BRANCH"; then echo "PUSHED=yes"; else echo "PUSHED=no"; fi',
        wantsTarball
          ? 'tar -cf /work/export.tar --exclude=.git --exclude=node_modules -C /work repo'
          : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      ...this.#gitCredentialEnv(credential, {
        BRANCH: request.branch,
        COMMIT_MESSAGE: request.commitMessage,
      }),
      // The cache, read-only, at the same path the run container sees it: the clone is `--shared`,
      // so `.git/objects/info/alternates` points at `/cache/<key>.git/objects` and **every** object
      // older than this run lives there. Without it `git rev-parse HEAD` still answers — the ref
      // file is local — and the push fails with `remote unpack failed: eof before pack header was
      // fully read`, which reads like a network fault. Found by the e2e; no unit tier could.
      mounts: [
        this.#volumeMount(handle.volumeName, '/work', false),
        this.#volumeMount(this.#cacheVolume, this.#cacheMount, true),
      ],
      user: `${WORKSPACE_UID}:${WORKSPACE_GID}`,
      network: credential === null ? 'none' : this.#helperNetwork,
      labels: { [WORKSPACE_LABELS.run]: handle.runId, [WORKSPACE_LABELS.role]: 'export' },
      keep: wantsTarball,
    });

    const commitSha = /SHA=([0-9a-f]{7,64})/.exec(helper.output)?.[1] ?? null;
    const pushed = /PUSHED=yes/.test(helper.output);
    if (!pushed && credential !== null) {
      // A refused push is the one failure this helper reports by exiting 0 — the branch is the
      // agent's work and the export must still produce a tarball. Reporting `pushed: false` and
      // nothing else would leave an operator with no way to find out why, so the helper's own
      // (redacted) words go to the log.
      this.#logger.warn(
        { run_id: handle.runId, branch: request.branch, detail: helper.output.slice(-2000) },
        'workspace export could not push the branch',
      );
    }
    let tarballBytes = 0;
    let droppedLinks = 0;
    try {
      if (request.tarballPath !== null) {
        const written = await this.#writeTarball(helper.id, request.tarballPath);
        tarballBytes = written.bytes;
        droppedLinks = written.droppedLinks;
      }
    } finally {
      if (wantsTarball) {
        await this.#engine.removeContainer(helper.id).catch(() => undefined);
      }
    }
    return {
      branch: request.branch,
      pushed,
      commitSha,
      tarballPath: request.tarballPath,
      tarballBytes,
      droppedLinks,
    };
  }

  /**
   * Reads the helper's `/work/export.tar` out of the container and writes it to the launcher's
   * filesystem, dropping links that escape.
   *
   * `GET /containers/{id}/archive` wraps whatever it is given in a tar of its own, so the file
   * comes back as a one-entry archive and the inner bytes are what gets filtered and written. The
   * unwrapping is asserted rather than assumed: an archive that is not exactly one regular file
   * named `export.tar` is a `workspace_failed`, because a silently-wrong unwrap would write a tar
   * of a tar and nobody would notice until someone tried to open it.
   */
  async #writeTarball(
    containerId: string,
    target: string,
  ): Promise<{ readonly bytes: number; readonly droppedLinks: number }> {
    const outer = await this.#engine.getArchive(containerId, '/work/export.tar');
    if (outer.length > this.#maxExportBytes) {
      throw new WorkspaceError('workspace_failed', 'export archive exceeds the size limit', {
        detail: `${outer.length} > ${this.#maxExportBytes}`,
      });
    }
    const entries = parseTar(outer);
    const single = entries.length === 1 ? entries[0] : undefined;
    if (single === undefined || single.type !== 'file' || single.name !== 'export.tar') {
      throw new WorkspaceError('workspace_failed', 'export archive has an unexpected shape', {
        detail: entries
          .map((entry) => `${entry.type}:${entry.name}`)
          .join(',')
          .slice(0, 200),
      });
    }
    const inner = outer.subarray(single.dataOffset, single.dataOffset + single.size);
    const filtered = filterTar(inner);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, filtered.bytes, { mode: 0o600 });
    return { bytes: filtered.bytes.length, droppedLinks: filtered.droppedLinks };
  }

  // ── Retention ──────────────────────────────────────────────────────────────

  async purgeExpired(now: Date): Promise<PurgeReport> {
    const volumes = await this.#engine.listVolumes({
      label: [`${WORKSPACE_LABELS.role}=workspace`],
    });
    const inUse = await this.#volumesInUse();
    const decisions = retentionDecisions(
      volumes.map((volume: EngineVolume) => ({
        volumeName: volume.Name,
        labels: volume.Labels ?? {},
        inUse: inUse.has(volume.Name),
      })),
      now,
    );
    const results: PurgedWorkspace[] = [];
    for (const decision of decisions) {
      if (decision.action === 'keep') {
        results.push(decision);
        continue;
      }
      try {
        await this.#engine.removeVolume(decision.volumeName);
        results.push({ ...decision, removed: true });
      } catch (error) {
        this.#logger.warn(
          { run_id: decision.runId, volume: decision.volumeName },
          'retention could not remove a volume',
        );
        results.push({ ...decision, removed: false, keptReason: 'in_use' });
        if (!(error instanceof WorkspaceError)) {
          throw error;
        }
      }
    }
    return {
      examined: results.length,
      removed: results.filter((result) => result.removed).length,
      volumes: results,
    };
  }

  async #volumesInUse(): Promise<Set<string>> {
    const containers = await this.#engine.listContainers({
      label: [WORKSPACE_LABELS.run],
    });
    const names = new Set<string>();
    for (const container of containers) {
      const runId = container.Labels?.[WORKSPACE_LABELS.run];
      if (runId !== undefined && runId.length > 0) {
        try {
          names.add(workspaceVolumeName(runId));
        } catch {
          // A label the daemon holds that is not a run id is not this sweep's business to fix; it
          // simply protects nothing.
        }
      }
    }
    return names;
  }
}

/** Refuses a project variable that would redirect the run's proxy or its control channel. */
export const assertProjectEnv = (env: Readonly<Record<string, string>>): void => {
  for (const name of Object.keys(env)) {
    if (RESERVED_ENV_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix))) {
      throw new WorkspaceError('invalid_spec', 'project environment names a reserved variable', {
        detail: name,
      });
    }
  }
};
