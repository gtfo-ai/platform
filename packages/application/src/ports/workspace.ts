/**
 * The `WorkspaceProvider` port — TD-021, technical/05 § "Workspace lifecycle".
 *
 * One isolated, disposable workspace per run (BD-021). The pipeline (WP-15) asks this port for a
 * workspace, gets back the coordinates of the run shim's control socket (TD-025), and gives the
 * workspace back when the run ends. Two adapters implement it: `DockerWorkspaceProvider` in
 * `packages/infrastructure/src/workspace` and {@link FakeWorkspaceProvider} in this ring's
 * `testing/`, and one shared contract suite runs against both
 * (`test/contract/support/workspace/provider-suite.ts`).
 *
 * ## `attach` does not return the SDK's `SpawnedProcess`, on purpose
 *
 * TD-021 writes the port as `attach(handle) → SpawnedProcess`. `SpawnedProcess` is a type of
 * `@anthropic-ai/claude-agent-sdk`, which this ring may not import (the dependency rule in
 * `biome.json`: `application` may name `domain` and `contracts` and nothing else), and the
 * translation from "a control socket on a shared volume" to "an object the SDK can spawn into" is
 * already implemented once, in `runlet/spawn-adapter.ts`. So `attach` returns the
 * {@link WorkspaceAttachment} — socket path, run token, and the workspace's own view of its
 * working directory — and the runner composes it with `createRunletSpawn`. The seam is the same
 * one TD-021 names; only the last translation moved to where the SDK types live.
 *
 * ## Naming
 *
 * camelCase, like `RunSpec` in `ports/runner.ts` and for the same reason: a `WorkspaceSpec` is
 * built inside the process from effective config and never appears on a wire. `CLAUDE.md`'s
 * snake_case rule governs config YAML, event payloads, artifact data, API DTOs and transcript
 * rows, and this is none of those. The one place snake_case *does* appear here is
 * {@link WorkspaceLabels}, because those strings go onto Docker objects and are read back by
 * `docker inspect` — an external system's wire.
 *
 * ## What is untrusted here
 *
 * The `WorkspaceSpec` is built from effective config, which a project can edit (BD-025 lets a
 * project narrow the org's maximum, never widen it), so every field that becomes a container
 * argument, a path component or a proxy rule is validated by the schemas below and again by the
 * adapter. The run id in particular becomes a *path component* of the control volume
 * (`<ctl>/<run-id>/`) and the name of a Docker object; `runIdSchema` is a uuid for exactly that
 * reason, and the adapter refuses anything else before it reaches the daemon.
 */
import { idSchema, isoDateTimeSchema, nonEmptyStringSchema } from '@platform/contracts';
import * as z from 'zod';

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * A run id. A uuid, because it names a directory on a volume several containers share and a
 * Docker object others can be asked about by name: `../other-run` and `..%2f` are not run ids.
 */
export const runIdSchema = idSchema;

/** A DNS host name, lowercase, no scheme, no port, no path. What the egress list is written in. */
export const egressHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/,
    'expected a lowercase DNS host name with no scheme, port or path',
  );

// ── The spec ─────────────────────────────────────────────────────────────────

/**
 * Resource limits per run container (TD-021: project defaults 2 CPU / 4 GiB / 512 pids).
 *
 * `stopGraceSeconds` is technical/05's `stop_grace_period`: how long the daemon waits between
 * SIGTERM and SIGKILL when the workspace is stopped.
 */
export const workspaceLimitsSchema = z.strictObject({
  cpus: z.number().positive().max(64),
  memoryMb: z.number().int().positive().max(1_048_576),
  pidsLimit: z.number().int().positive().max(65_536),
  tmpfsMb: z.number().int().positive().max(65_536),
  stopGraceSeconds: z.number().int().positive().max(3_600),
});
export type WorkspaceLimits = z.infer<typeof workspaceLimitsSchema>;

/** TD-021: `runc` by default, `runsc` (gVisor) opt-in per project on Linux hosts. */
export const workspaceRuntimeSchema = z.enum(['runc', 'runsc']);
export type WorkspaceRuntime = z.infer<typeof workspaceRuntimeSchema>;

/**
 * What the workspace may reach, rendered into the egress sidecar's allow-list.
 *
 * `hosts` is the union technical/05 § "Network policy" describes: the model provider host, the git
 * host, the package registries discovery found, and read-only observability hosts for stages that
 * may use them. Everything else is denied.
 */
export const workspaceEgressSchema = z.strictObject({
  hosts: z.array(egressHostSchema).max(256),
  /** Ports `CONNECT` may name. 443 only, unless a project needs more. */
  connectPorts: z.array(z.number().int().min(1).max(65_535)).min(1).max(32),
});
export type WorkspaceEgress = z.infer<typeof workspaceEgressSchema>;

/**
 * The repository half of the spec.
 *
 * `url` is what the mirror fetches from and what the export pushes to; `cacheKey` names the bare
 * mirror on the shared `repo-cache` volume (one per project, technical/05 §1). `checkoutBranch` is
 * the task branch for a re-entry — `null` means "the default branch", which is also the only
 * branch agent configuration is ever read from (BD-025).
 */
export const workspaceRepoSchema = z.strictObject({
  url: nonEmptyStringSchema.max(2_048),
  defaultBranch: nonEmptyStringSchema.max(255),
  checkoutBranch: nonEmptyStringSchema.max(255).nullable(),
  cacheKey: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'expected a lowercase mirror cache key'),
});
export type WorkspaceRepo = z.infer<typeof workspaceRepoSchema>;

/**
 * A workspace to create.
 *
 * `readOnly` is BD-021's least privilege at the workspace level: a read-only stage gets **no git
 * write credential at all**, so the broker mints nothing and `cred.get` has nothing to answer.
 */
export const workspaceSpecSchema = z.strictObject({
  runId: runIdSchema,
  projectId: idSchema,
  repo: workspaceRepoSchema,
  limits: workspaceLimitsSchema,
  egress: workspaceEgressSchema,
  runtime: workspaceRuntimeSchema,
  readOnly: z.boolean(),
  /**
   * Non-secret project variables placed in the container's environment. Integration credentials
   * never appear here (BD-025 §3); the git token arrives through the shim's credential socket.
   */
  env: z.record(
    z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'expected an UPPER_SNAKE_CASE variable name'),
    z.string().max(4_096),
  ),
  /** When the workspace's volume may be purged (technical/05 §5: 3 days, 14 when paused). */
  keepUntil: isoDateTimeSchema,
});
export type WorkspaceSpec = z.infer<typeof workspaceSpecSchema>;

// ── Handles ──────────────────────────────────────────────────────────────────

/**
 * Labels every Docker object of a run carries. snake_case values on an external system's wire.
 *
 * They are the retention sweep's only index: `purgeExpired` asks the daemon what it has rather
 * than carrying a list of its own (standing rule 7).
 */
export const WORKSPACE_LABELS = {
  run: 'com.agentic.run',
  project: 'com.agentic.project',
  role: 'com.agentic.role',
  keepUntil: 'com.agentic.keep_until',
  createdAt: 'com.agentic.created_at',
} as const;
export type WorkspaceLabels = Readonly<Record<string, string>>;

/** What a created workspace is made of. Every name is derived from the run id. */
export interface WorkspaceHandle {
  readonly runId: string;
  readonly projectId: string;
  /** The run container. `docker stop`/`rm` on this is what ends the run's processes. */
  readonly containerId: string;
  /** The egress sidecar, or `null` when the spec allowed no hosts at all. */
  readonly sidecarContainerId: string | null;
  readonly networkId: string;
  /** `ws-<run-id>`; outlives the container, per retention. */
  readonly volumeName: string;
  /**
   * The project's mirror on the shared cache volume.
   *
   * On the handle rather than looked up again, because the clone is `--shared`: the workspace's
   * objects live in that mirror, so anything that reads the workspace later — the export, a
   * future re-attach — needs to mount it and needs to know which one.
   */
  readonly cacheKey: string;
  /** The run's sub-directory of the shared control volume. */
  readonly controlSubPath: string;
  readonly keepUntil: string;
}

/**
 * The control channel, from the runner's side of the volume (TD-025 §2).
 *
 * `socketPath` is a path *in the runner process' own filesystem* — the whole `ctl` volume is
 * mounted there — not the `/ctl/ctl.sock` the container sees.
 */
export interface WorkspaceAttachment {
  readonly socketPath: string;
  readonly token: string;
  /** `/work/repo`: the `cwd` the runner passes to `spawn`. */
  readonly workdir: string;
}

// ── Export and retention ─────────────────────────────────────────────────────

export const workspaceExportRequestSchema = z.strictObject({
  /** The branch to push, always inside BD-025's `agentic/*` namespace. */
  branch: z
    .string()
    .regex(/^agentic\/[A-Za-z0-9._\-/]{1,200}$/, 'expected a branch inside agentic/'),
  /** Where the launcher writes the tarball. Absolute, on the launcher's own filesystem. */
  tarballPath: nonEmptyStringSchema.max(4_096).nullable(),
  /** A `wip:` commit for work in progress, when the workspace has uncommitted changes. */
  commitMessage: nonEmptyStringSchema.max(1_000),
});
export type WorkspaceExportRequest = z.infer<typeof workspaceExportRequestSchema>;

/**
 * What an export produced.
 *
 * `droppedLinks` is not bookkeeping: a symlink in the workspace pointing outside it is dropped
 * from the archive rather than carried, because an archive is extracted somewhere else and a link
 * that escapes there is the export handing an attacker a write outside the workspace. The count is
 * reported so a surprised operator can ask why.
 */
export interface WorkspaceExport {
  readonly branch: string;
  readonly pushed: boolean;
  readonly commitSha: string | null;
  readonly tarballPath: string | null;
  readonly tarballBytes: number;
  readonly droppedLinks: number;
}

/** One volume the retention sweep removed, or refused to remove. */
export interface PurgedWorkspace {
  readonly runId: string;
  readonly volumeName: string;
  readonly keepUntil: string;
  readonly removed: boolean;
  /** Why a volume was kept. `null` when it was removed. */
  readonly keptReason: 'not_expired' | 'in_use' | 'unlabelled' | null;
}

export interface PurgeReport {
  readonly examined: number;
  readonly removed: number;
  readonly volumes: readonly PurgedWorkspace[];
}

// ── Errors ───────────────────────────────────────────────────────────────────

export type WorkspaceErrorCode =
  /** The spec did not validate, or named something the adapter refuses (a mount escape). */
  | 'invalid_spec'
  /** The daemon (or the socket proxy in front of it) refused or was unreachable. */
  | 'engine_unavailable'
  /** A step of the lifecycle failed: the mirror could not fetch, the clone failed, a helper exited non-zero. */
  | 'workspace_failed'
  /** `attach`, `kill`, `export` or `destroy` named a run this provider does not have. */
  | 'not_found';

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly runId: string | null;
  /** Diagnostics safe to log: never a credential, never a command line that carried one. */
  readonly detail: string | null;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    options: { readonly runId?: string; readonly detail?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkspaceError';
    this.code = code;
    this.runId = options.runId ?? null;
    this.detail = options.detail ?? null;
  }
}

// ── The port ─────────────────────────────────────────────────────────────────

export interface WorkspaceProvider {
  /**
   * Updates (or creates) the project's bare mirror on the shared cache volume — technical/05 §1,
   * `git remote update --prune` before each run.
   *
   * Idempotent, and safe to call concurrently for *different* projects. Two runs of the same
   * project serialise: a mirror is one directory and two fetches into it race.
   */
  updateMirror(input: {
    readonly projectId: string;
    readonly repo: WorkspaceRepo;
    readonly credential: WorkspaceGitCredential | null;
  }): Promise<{ readonly cachePath: string; readonly updated: boolean }>;

  /**
   * Creates the whole run: network, volume, control directory, egress sidecar, workspace
   * container, clone.
   *
   * **Either it returns a handle or it leaves nothing behind.** A create that fails half way
   * removes what it made before it throws, because the alternative is a container running an agent
   * that no handle names.
   */
  create(spec: WorkspaceSpec): Promise<WorkspaceHandle>;

  /** The control-socket coordinates for a created workspace. */
  attach(handle: WorkspaceHandle): Promise<WorkspaceAttachment>;

  /**
   * Stops the run container: SIGTERM, then SIGKILL after `stopGraceSeconds`.
   *
   * This — not the shim's teardown — is what guarantees no process survives a run. The shim
   * signals one pid, so a child that forked a **detached** grandchild leaves it running
   * (measured; `docs/research/12-run-shim-verification.md` § "Teardown covers the child, not its
   * descendants"). Only the container's pid namespace ending takes the grandchild with it.
   * Idempotent: stopping a container that has already exited is a no-op.
   */
  kill(handle: WorkspaceHandle): Promise<void>;

  /**
   * Take-over export (technical/05 §6): commit and push the work-in-progress branch, and
   * optionally write a tarball of the workspace excluding `.git` and `node_modules`.
   */
  export(
    handle: WorkspaceHandle,
    request: WorkspaceExportRequest,
    credential: WorkspaceGitCredential | null,
  ): Promise<WorkspaceExport>;

  /**
   * Ends the run: stop and remove the container and the sidecar, remove the network and the
   * control directory. **The volume is kept**, per retention — `purgeExpired` removes it later.
   *
   * Idempotent, and it stops the container even when the shim has already exited: "the shim
   * exited" is not "the workspace's processes are gone".
   */
  destroy(handle: WorkspaceHandle): Promise<void>;

  /**
   * Removes every workspace volume whose `keep_until` has passed (technical/05 §5), reporting
   * what it examined. `now` is injected: retention is a policy, not a wall-clock reading.
   */
  purgeExpired(now: Date): Promise<PurgeReport>;
}

/**
 * The run-scoped git credential, as the workspace sees it.
 *
 * Structurally `MintedCredential`'s secret half, restated here so this port does not depend on the
 * integration ports: a workspace does not know what a GitLab project access token is.
 */
export interface WorkspaceGitCredential {
  readonly host: string;
  readonly username: string;
  readonly password: string;
}
