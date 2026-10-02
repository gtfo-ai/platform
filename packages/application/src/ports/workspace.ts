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
 * camelCase, like `RunSpec` in `ports/runner.ts`. It **does** appear on a wire since WP-53 — TD-028's
 * control plane carries a `WorkspaceSpec` from the runner to the launcher — and it stays camelCase
 * there: `packages/infrastructure/src/launcher/protocol.ts` sends this very schema rather than a
 * snake_case re-spelling of it, because a second spelling of one structure is a second schema to
 * drift. `CLAUDE.md`'s snake_case rule governs config YAML, event payloads, artifact data, API DTOs
 * and transcript rows, and a process-to-process RPC between two halves of one instance is none of
 * those; the deviation is stated in that module's docblock. The one place snake_case *does* appear here is
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
import {
  idSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  shaSchema,
} from '@platform/contracts';
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

/** How many protected patterns a spec may carry; the shipped default list has fourteen. */
export const MAX_WORKSPACE_PROTECTED_PATTERNS = 256;

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
 * branch agent configuration is ever read from (BD-025). `checkoutCommit` is a commit to check out
 * detached — a shadow task's base (Q82 (a), WP-105) — which the clone **refuses by name** when the
 * mirror does not hold it, where a branch that does not exist yet is created. At most one is set.
 */
export const workspaceRepoSchema = z
  .strictObject({
    url: nonEmptyStringSchema.max(2_048),
    defaultBranch: nonEmptyStringSchema.max(255),
    checkoutBranch: nonEmptyStringSchema.max(255).nullable(),
    checkoutCommit: shaSchema.nullable(),
    cacheKey: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'expected a lowercase mirror cache key'),
  })
  .refine((repo) => repo.checkoutBranch === null || repo.checkoutCommit === null, {
    message: 'a workspace checks out a branch or a commit, never both',
    path: ['checkoutCommit'],
  });
export type WorkspaceRepo = z.infer<typeof workspaceRepoSchema>;

/**
 * Where the platform's own skills are provisioned inside the workspace, and what they are called.
 *
 * ## Measured, because the obvious layout does not work
 *
 * technical/04 says *"copy platform skills into the workspace `.claude/skills/_platform/` at
 * provisioning so `settingSources: ['project']` discovers them"*. Against the pinned CLI
 * (`@anthropic-ai/claude-agent-sdk@0.3.267` and the `claude` binary it resolves), a skill at
 * `.claude/skills/_platform/<name>/SKILL.md` is **not discovered**: the CLI's own `system`/`init`
 * message lists a sibling at `.claude/skills/<name>/SKILL.md` and never the nested one. Discovery
 * under `.claude/skills` is one level deep, and a `.claude/skills` in a *parent* of the checkout is
 * not read either. The measurement and its second fixture are in
 * `packages/prompts/src/skills.ts`; the amendment is on technical/04.
 *
 * ## So the skills are a plugin, and that is better than the alternative anyway
 *
 * A directory containing `skills/<name>/SKILL.md`, handed to the CLI as a plugin
 * (`Options.plugins`, one `--plugin-dir` per entry), **is** discovered, and its skills are
 * namespaced: `agentic:kb`. Measured the same way. Three things follow, each of which the flat
 * copy into `.claude/skills/` would have got wrong:
 *
 *  - **the project's own skills are untouched** — nothing is written inside `.claude/` at all, so
 *    there is no name to collide with and no file of the project's to overwrite;
 *  - **the names say where they came from**: `agentic:kb` in the model's listing and in the audit
 *    is the platform's `kb`, not a repository's;
 *  - **nothing is added to the checkout's tracked tree** under a name a `git add -A` would sweep
 *    up. It still lands *inside* the checkout — the CLI reads a relative plugin path against its
 *    `cwd`, and `cwd` is the checkout — so provisioning also writes `.git/info/exclude`, which is
 *    local to the clone and can never be committed.
 *
 * `.agentic-run/` is already the platform's directory inside a workspace (`CONTEXT_DIRECTORY`),
 * which is why the plugin lives under it rather than at a new top-level name.
 */
export const PLATFORM_SKILLS_PLUGIN_NAME = 'agentic';

/** Relative to the checkout: the plugin root, whose `skills/<name>/SKILL.md` the CLI discovers. */
export const PLATFORM_SKILLS_PLUGIN_DIRECTORY = `.agentic-run/plugins/${PLATFORM_SKILLS_PLUGIN_NAME}`;

/**
 * A platform skill's name — which is its **directory** name.
 *
 * Measured: a `SKILL.md` whose frontmatter `name` differs from its directory is listed under the
 * directory's name, and the CLI's own error text says so ("Skill names match the skill's directory
 * name"). The alphabet is therefore the alphabet of a directory this platform creates on a shared
 * volume, and it is narrow on purpose: the name reaches a shell as part of a path in the
 * provisioning helper's script.
 */
export const platformSkillNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'expected a lowercase platform skill directory name');

/** `kb` → `agentic:kb`: what `RunSpec.skills` and the SDK's `skills` filter name. */
export const qualifiedPlatformSkill = (name: string): string =>
  `${PLATFORM_SKILLS_PLUGIN_NAME}:${name}`;

/**
 * `agentic:kb` → `kb`, and **null for anything else**.
 *
 * Null rather than the input, because the only caller turns a `RunSpec` into a `WorkspaceSpec`: a
 * name that is not the platform's is a name this platform has no file for, and provisioning it as
 * if it were would create an empty skill directory named after somebody else's skill.
 */
export const platformSkillOfQualified = (qualified: string): string | null => {
  const prefix = `${PLATFORM_SKILLS_PLUGIN_NAME}:`;
  if (!qualified.startsWith(prefix)) {
    return null;
  }
  const name = qualified.slice(prefix.length);
  return platformSkillNameSchema.safeParse(name).success ? name : null;
};

/**
 * A workspace to create.
 *
 * `readOnly` is BD-021's least privilege at the workspace level: a read-only stage gets **no git
 * write credential at all** — the runner mints it a `read` credential or none, and the control
 * plane refuses a `push` one for it (TD-028's WP-76 amendment, decision 3).
 */
export const workspaceSpecSchema = z.strictObject({
  runId: runIdSchema,
  projectId: idSchema,
  /**
   * The repository to check out, or **`null` for a run that holds no tool to open one** (WP-74,
   * PROGRESS backlog 82).
   *
   * `null` means *no checkout*, and never *no container*: a repo-less spec skips the mirror update
   * and the clone and **keeps** the network, the volume, the egress sidecar, the control socket and
   * the platform skills, because the CLI is what the run shim execs inside that container and a run
   * has no other transport. Executing a tool-less run's CLI in the platform process instead is ruled
   * out by TD-021's **decision body** — *"the Agent SDK runs in the platform `runner` role and spawns
   * `claude` inside the container"* (`docs/decisions/technical/TD-021-workspace-isolation.md:10`) —
   * and **not** by the WP-15g amendment's Docker-client clause, which that path would not breach. A
   * reader who checks only the amendment concludes the option is open; it is not.
   *
   * The predicate that decides it is on the run's **tools**, never its role or stage:
   * `runNeedsCheckout` in `packages/infrastructure/src/workspace/spec.ts`. The SDK's tool filter runs
   * inside the container, so it is a context filter and not a sandbox — the honest restriction for a
   * run that may not read the tree is not to put the tree there.
   */
  repo: workspaceRepoSchema.nullable(),
  limits: workspaceLimitsSchema,
  egress: workspaceEgressSchema,
  runtime: workspaceRuntimeSchema,
  readOnly: z.boolean(),
  /**
   * The platform skills to provision into this workspace — the stage's role's list, by directory
   * name, unqualified.
   *
   * It is on the **spec** rather than fixed for every workspace because the copy is the real
   * restriction. The SDK's `skills` option is "a context filter, not a sandbox: unlisted skills are
   * hidden from the model's listing and rejected by the Skill tool, but their files remain on disk
   * and are reachable via Read/Bash" (`sdk.d.ts:2089-2098`), so a skill a role may not use must not
   * be *in* the workspace — which is a decision provisioning can enforce and a run option cannot.
   */
  skills: z.array(platformSkillNameSchema).max(32),
  /**
   * The run's effective BD-024 protected patterns (`RunSpec.protectedPaths`), so the launcher can
   * list which of them **exist** at the merge base with the default branch (WP-99, {@link existingProtectedPathsSchema}).
   * The launcher reads them and nothing else: it decides nothing about a write.
   */
  protectedPaths: z.array(pathPatternSchema).max(MAX_WORKSPACE_PROTECTED_PATTERNS),
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

// ── What exists at the merge base with the default branch (WP-99) ────────────

/** How many tracked entries the launcher reads out of a checkout before it gives up (fail closed). */
export const MAX_TRACKED_ENTRIES = 100_000;
/** How many tracked files matching a protected pattern a listing may carry. */
export const MAX_EXISTING_PROTECTED_PATHS = 10_000;
/** How many tracked symlinks and submodules a listing may carry. */
export const MAX_OPAQUE_TRACKED_PATHS = 1_000;

/** A repository-relative path as git lists it: `/`-separated, no NUL, bounded. */
const trackedPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes('\0'), 'a tracked path carries no NUL byte');

/**
 * Which protected paths **exist** at the merge base of the run's checkout and the default branch (WP-99 review round 1: the base the merge request diff is computed against) — what the path guard needs to tell a
 * write that creates a protected path (allowed) from one that changes an existing one (allowed only
 * when the plan declares it). BD-024 §2 as amended at WP-81; technical/04's WP-99 amendment.
 *
 * `listed` is the launcher's answer from the fresh checkout: `paths` are the regular files at the
 * merge base matching one of the spec's protected patterns, and `opaque` is **every** tracked symlink and
 * submodule, because a write at or under one of those lands somewhere the path does not name.
 *
 * `unlisted` is every other case, and it **fails closed**: the guard then treats every protected
 * path as existing, which is its behaviour before WP-99. The planner writes it (nothing is listed
 * before there is a workspace), and the launcher answers it for a run with no checkout, no known
 * default branch or no computable merge base, a listing that failed, one past a bound, and one with
 * a line it could not read. `reason` is platform text.
 */
export const existingProtectedPathsSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('listed'),
    paths: z.array(trackedPathSchema).max(MAX_EXISTING_PROTECTED_PATHS),
    opaque: z.array(trackedPathSchema).max(MAX_OPAQUE_TRACKED_PATHS),
  }),
  z.strictObject({
    state: z.literal('unlisted'),
    reason: nonEmptyStringSchema.max(500),
  }),
]);
export type ExistingProtectedPaths = z.infer<typeof existingProtectedPathsSchema>;

/** The fail-closed answer, with the platform's reason. */
export const unlistedProtectedPaths = (reason: string): ExistingProtectedPaths => ({
  state: 'unlisted',
  reason,
});

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
  /**
   * Which instance's launcher made the object (WP-103, TD-028 decision 12). The Docker provider
   * writes its **control volume's name**: two instances on one daemon cannot share one without
   * sharing every run's token, so it is the one name that already separates them, and it needs no
   * new setting. The listing verb filters by it, so a second instance on the same daemon is never
   * listed — and therefore never reaped — by this one. Objects created before WP-103 carry no such
   * label and are not listed at all (`DockerWorkspaceProvider.listLabelledRuns` states it).
   */
  instance: 'com.agentic.instance',
} as const;
export type WorkspaceLabels = Readonly<Record<string, string>>;

/**
 * One run the provider labelled a container or a network for, as the **daemon** answers it (WP-103,
 * TD-028 decision 12; networks since WP-118's pre-review round) — never from a process's memory,
 * which a restart empties.
 */
export interface LabelledRunWorkspace {
  readonly runId: string;
  /** When the run's oldest labelled container was created, per the daemon (ISO-8601). */
  readonly createdAt: string;
  /** Whether any of its labelled containers is running. */
  readonly running: boolean;
}

/** At most this many run ids per listing; the rest are answered by the next pass. */
export const MAX_LABELLED_RUNS = 1_000;

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
   * The project's mirror on the shared cache volume, or `null` for a workspace with no checkout
   * (`WorkspaceSpec.repo` was `null`, WP-74).
   *
   * On the handle rather than looked up again, because the clone is `--shared`: the workspace's
   * objects live in that mirror, so anything that reads the workspace later — the export, a
   * future re-attach — needs to mount it and needs to know which one. A `null` here is what makes
   * `export` refuse by name rather than mount a mirror for a tree that was never cloned.
   */
  readonly cacheKey: string | null;
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

/**
 * One git configuration entry the `claude` process must carry — a key and its value, never an
 * environment variable name. The runner numbers the list once (`GIT_CONFIG_COUNT`, `KEY_n`,
 * `VALUE_n`) together with its own entries, so this list carries no index.
 */
export interface WorkspaceGitConfigEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * The values that describe the **run container** and that the `claude` process needs as well —
 * TD-025's amendment (PROGRESS backlog 342, WP-118).
 *
 * The shim starts the CLI with the spawn frame's environment **alone** (`env` replaces, never
 * merges), so a variable set only on the container reaches the shim and stops there. These are the
 * container facts only the workspace knows — its proxy, its home, the image's own `PATH`, the git
 * credential helper — answered by the provider and composed into the CLI's environment by the
 * runner (`packages/infrastructure/src/runner/options.ts`, `cliEnvironment`).
 *
 * **Structured, never a free-form record**, so a `RUNLET_*` name, a credential or anything else
 * nobody named cannot travel in it. Every value is a path, an internal proxy URL or a command
 * string; none is a secret. The provider writes the run container's own environment from the same
 * object, so a `docker exec` and the CLI see the same values.
 */
export interface WorkspaceCliEnvironment {
  /** The egress sidecar, or `null` when the run has none (a spec that allows no host). */
  readonly proxy: {
    /** `HTTPS_PROXY` and `HTTP_PROXY`. */
    readonly url: string;
    /** `NO_PROXY`. */
    readonly noProxy: string;
  } | null;
  /** `HOME`. */
  readonly home: string;
  /** `CLAUDE_CONFIG_DIR`. */
  readonly claudeConfigDir: string;
  /** `PATH`: the run image's own declared value, read off the image. */
  readonly path: string;
  /** The container's git configuration (`credential.helper`), in order. */
  readonly gitConfig: readonly WorkspaceGitConfigEntry[];
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

/**
 * One of TD-025 §2's per-run control directories the sweep looked at — PROGRESS backlog **0b**.
 *
 * The control volume is shared and its *directories* are not Docker objects, so the label sweep
 * that finds volumes cannot see one (standing rule **60**, one level down): a `destroy` whose
 * two-step removal did not finish leaves either a **live run token** or an empty directory behind,
 * for ever, in a volume nothing enumerates. This is what makes the sweep's answer countable —
 * *a sweep that found nothing and a sweep that looked at nothing are spelled the same* — which is
 * why a provider with no control volume reports an empty list rather than omitting the field.
 */
export interface PurgedControlDirectory {
  /** The directory's name. A run id when it parses as one; the raw name otherwise. */
  readonly runId: string;
  readonly removed: boolean;
  /**
   * Why a directory was kept. `null` when it was removed.
   *
   * `run_alive` — a container still carries this run's label, so the token is in use.
   * `not_a_run_id` — the name is not a uuid, so nothing here made it and nothing here removes it.
   * `remove_failed` — the sweep tried and could not; the token may still be readable.
   *
   * **`remove_failed` is separate from `run_alive` and that is the point.** They were spelled the
   * same until WP-53's review, which is the confusion `PurgeReport`'s own contract forbids one level
   * up — *a sweep that found nothing and a sweep that looked at nothing are spelled the same* — and
   * the two mean opposite things to an operator: `run_alive` is the sweep working, `remove_failed`
   * is an orphaned run token that is still there.
   *
   * There is deliberately **no `too_young`**. The grace window that stops the sweep deleting the
   * control directory of a run that is *being created* is applied on the **daemon's** side, by the
   * listing's own `find -mmin`, so a directory inside it is never listed and can produce no row
   * here. A declared reason nothing can write is a reason a reader trusts and a test cannot reach;
   * the limit is stated instead — **this report counts what the sweep examined, not what the window
   * withheld**.
   */
  readonly keptReason: 'run_alive' | 'not_a_run_id' | 'remove_failed' | null;
}

export interface PurgeReport {
  readonly examined: number;
  readonly removed: number;
  readonly volumes: readonly PurgedWorkspace[];
  /**
   * The control directories this sweep examined (backlog **0b**).
   *
   * Reported separately from `examined`/`removed`, which count **volumes**: an operator counting
   * workspaces must not count a control directory as one, and the two have different lifetimes —
   * a volume outlives its run by three days and a control directory should not outlive it at all.
   */
  readonly controlDirectories: readonly PurgedControlDirectory[];
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

/**
 * Why a workspace refused or failed, as **platform text** (WP-127, PROGRESS backlog 351).
 *
 * A closed vocabulary beside {@link WorkspaceErrorCode}, set only where the platform itself wrote
 * the refusal and knows what it means. It exists because the error's *message* may not travel: it
 * can quote an image reference, a path, a daemon's answer or a provider's words, and the stage
 * executor writes its escalation into `events.payload` and the blocker brief with no redactor
 * (`stage-executor.ts`). A reason code is a word this file chose, so it can reach the task where the
 * message cannot; the message stays in the log line beside it. Absent (`null`) means *no
 * platform-written cause* — the kind alone is then all the task is told.
 */
export const WORKSPACE_ERROR_REASONS = [
  /** The shadow base this run must start from is not in the project's mirror after a fetch (Q82 (a)). */
  'checkout_commit_missing',
  /** The project has no mirror to clone from: `updateMirror` did not run, or did not leave one. */
  'mirror_missing',
  /** The run image has no executable at the configured CLI path (backlog 34). */
  'runtime_cli_missing',
  /** `APP_WORKSPACE_RUNTIME_CLI_PATH` is not an absolute path of plain characters. */
  'runtime_cli_path_invalid',
  /** The run image declares no `PATH` (WP-118). */
  'runtime_image_path_missing',
  /** The run image declares a `PATH` that is not a list of absolute directories (WP-118). */
  'runtime_image_path_invalid',
  /** The runner is not the uid the run shim's `0600` control socket admits (TD-025, Q51). */
  'runner_uid_mismatch',
  /** The workspace spec did not validate against `workspaceSpecSchema`. */
  'spec_invalid',
  /** A skill named in the spec is not a skill name. */
  'skill_name_invalid',
  /** The project's environment names a variable the platform reserves. */
  'reserved_environment_variable',
  /** The launcher and the runner mount the control volume at different paths. */
  'control_root_mismatch',
  /** A run that writes to its checkout could not be minted a git credential (TD-028, WP-76). */
  'run_credential_unavailable',
  /** The run's credential does not fit its spec: a push scope on a read-only run, or one with no repository. */
  'run_credential_scope_mismatch',
  /** The egress sidecar is not running after create. */
  'egress_sidecar_not_running',
  /** The run shim did not create its control socket in time. */
  'control_socket_timeout',
  /** The launcher's control plane could not be reached (TD-028). */
  'launcher_unreachable',
  /** The launcher refused the runner's token (TD-028). */
  'launcher_unauthorized',
  /** The launcher refused the request as malformed (TD-028). */
  'launcher_request_refused',
  /** The launcher failed for a reason it does not publish; its own log has it (TD-028). */
  'launcher_internal_error',
] as const;
export type WorkspaceErrorReason = (typeof WORKSPACE_ERROR_REASONS)[number];
export const workspaceErrorReasonSchema = z.enum(WORKSPACE_ERROR_REASONS);

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly runId: string | null;
  /** Diagnostics safe to log: never a credential, never a command line that carried one. */
  readonly detail: string | null;
  /** The platform-written cause, or `null` — {@link WORKSPACE_ERROR_REASONS}. */
  readonly reason: WorkspaceErrorReason | null;
  /**
   * The commit the refusal is about, **only** through `shaSchema` (WP-127): a value that does not
   * parse is dropped here rather than carried, so nothing but a hexadecimal sha can ride beside
   * the reason into stored state.
   */
  readonly commit: string | null;

  constructor(
    code: WorkspaceErrorCode,
    message: string,
    options: {
      readonly runId?: string;
      readonly detail?: string;
      readonly cause?: unknown;
      readonly reason?: WorkspaceErrorReason | null;
      readonly commit?: string | null;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkspaceError';
    this.code = code;
    this.runId = options.runId ?? null;
    this.detail = options.detail ?? null;
    this.reason = workspaceErrorReasonSchema.safeParse(options.reason).data ?? null;
    this.commit = shaSchema.safeParse(options.commit).data ?? null;
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
  readonly updateMirror: (input: {
    readonly projectId: string;
    readonly repo: WorkspaceRepo;
    readonly credential: WorkspaceGitCredential | null;
  }) => Promise<{ readonly cachePath: string; readonly updated: boolean }>;

  /**
   * Creates the whole run: network, volume, control directory, egress sidecar, workspace
   * container, clone — the clone only when `spec.repo` is not `null`, and then only after
   * {@link updateMirror} (a repo-ful create with no mirror is refused; a repo-less one needs none).
   *
   * **Either it returns a handle or it leaves nothing behind.** A create that fails half way
   * removes what it made before it throws, because the alternative is a container running an agent
   * that no handle names.
   */
  readonly create: (spec: WorkspaceSpec) => Promise<WorkspaceHandle>;

  /** The control-socket coordinates for a created workspace. */
  readonly attach: (handle: WorkspaceHandle) => Promise<WorkspaceAttachment>;

  /**
   * The container facts the `claude` process needs in its own environment (WP-118,
   * {@link WorkspaceCliEnvironment}) — produced by the same function that wrote the run container's
   * environment at {@link create}, so the two cannot disagree. Derived from the handle, so it
   * answers after a launcher restart as well.
   */
  readonly cliEnvironment: (handle: WorkspaceHandle) => Promise<WorkspaceCliEnvironment>;

  /**
   * Which of `patterns` exist at the **merge base of the checkout and the default branch** — the
   * base a merge request's diff is computed against, so a file an earlier run of the same task
   * added reads as new, as the CI gate's `changedExistingPaths` reads it — and every tracked symlink
   * and submodule at that commit (WP-99, amended at its review round 1;
   * {@link existingProtectedPathsSchema}). A `null` default branch is `unlisted`.
   *
   * Called after {@link create} and before the runner starts the CLI, so nothing the agent does is
   * in the tree yet. **Never throws for a listing it could not make**: it answers `unlisted` with
   * the reason, which fails closed at the guard — a run is not refused for a listing, it is guarded
   * as strictly as before the listing existed. A workspace with no checkout answers `unlisted`.
   */
  readonly listExistingProtectedPaths: (
    handle: WorkspaceHandle,
    request: { readonly patterns: readonly string[]; readonly defaultBranch: string | null },
  ) => Promise<ExistingProtectedPaths>;

  /**
   * Stops the run container: SIGTERM, then SIGKILL after `stopGraceSeconds`.
   *
   * This — not the shim's teardown — is what guarantees no process survives a run. The shim
   * signals one pid, so a child that forked a **detached** grandchild leaves it running
   * (measured; `docs/research/12-run-shim-verification.md` § "Teardown covers the child, not its
   * descendants"). Only the container's pid namespace ending takes the grandchild with it.
   * Idempotent: stopping a container that has already exited is a no-op.
   */
  readonly kill: (handle: WorkspaceHandle) => Promise<void>;

  /**
   * Take-over export (technical/05 §6): commit and push the work-in-progress branch, and
   * optionally write a tarball of the workspace excluding `.git` and `node_modules`.
   *
   * @throws {WorkspaceError} `invalid_spec` for a handle whose `cacheKey` is `null`: a workspace
   * with no checkout has no branch to push and no tree to archive (WP-74).
   */
  readonly export: (
    handle: WorkspaceHandle,
    request: WorkspaceExportRequest,
    credential: WorkspaceGitCredential | null,
  ) => Promise<WorkspaceExport>;

  /**
   * Ends the run: stop and remove the container and the sidecar, remove the network and the
   * control directory. **The volume is kept**, per retention — `purgeExpired` removes it later.
   *
   * Idempotent, and it stops the container even when the shim has already exited: "the shim
   * exited" is not "the workspace's processes are gone".
   */
  readonly destroy: (handle: WorkspaceHandle) => Promise<void>;

  /**
   * The run ids this provider labelled a container **or a network** for — **this instance's**
   * objects, any role, running or not — read from the daemon (WP-103, TD-028 decision 12). A run
   * whose create was interrupted can have a helper container and no run container, and it is listed
   * all the same: that helper is what keeps the run "alive" to the retention sweep. One whose create
   * was killed after its first object can have **only its network** (measured, WP-118's pre-review
   * round), and it is listed too. Bounded by {@link MAX_LABELLED_RUNS}, oldest first.
   */
  readonly listLabelledRuns: () => Promise<readonly LabelledRunWorkspace[]>;

  /**
   * {@link destroy} for a run no handle names — found **by label**: every container carrying the
   * run's label for this instance, the sidecar's configuration volume, the run's network and the
   * control directory. The workspace volume is kept, as `destroy` keeps it (retention owns it).
   *
   * Idempotent: a run with nothing left answers `found: false` and succeeds.
   */
  readonly destroyRun: (runId: string) => Promise<{ readonly found: boolean }>;

  /**
   * Keeps this run's workspace until `keepUntil` — technical/05 §5's *"14 days for
   * paused/taken-over"* (WP-27).
   *
   * **It is not a relabel**, and it cannot be: the `keep_until` an adapter writes at create time is
   * a label on a Docker object, and a Docker volume's labels are immutable — the two ways of trying
   * are measured at `retentionHoldVolumeName`, and one of them *succeeds while changing nothing*.
   * So an adapter records the extension as a **hold** beside the workspace and `purgeExpired` takes
   * the later of the two instants. What a caller may rely on is only this: after it resolves, a
   * sweep at an instant before `keepUntil` keeps the volume, and one after it removes it.
   *
   * Idempotent, and it only ever **extends**: a `keepUntil` earlier than the window the workspace
   * already has is honoured as a no-op rather than shortening it, because the caller of this method
   * is saying "a human needs this for longer" and nothing in the product asks for the opposite. The
   * effective instant is returned, so a caller that asked for less can see that it got more.
   *
   * @throws {WorkspaceError} `not_found` when this provider has no such run.
   */
  readonly extendRetention: (
    handle: WorkspaceHandle,
    keepUntil: string,
  ) => Promise<{ readonly keepUntil: string }>;

  /**
   * Removes every workspace volume whose `keep_until` has passed (technical/05 §5), reporting
   * what it examined. `now` is injected: retention is a policy, not a wall-clock reading.
   *
   * A volume held by {@link extendRetention} is removed at the **held** instant, and its hold is
   * removed with it; the report's `keepUntil` is the effective one, so a reader never sees the
   * three-day label on a workspace that is being kept for fourteen days.
   */
  readonly purgeExpired: (now: Date) => Promise<PurgeReport>;
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
