/**
 * The `RunSpec` and the launcher's `WorkspaceSpec` — moved here from `packages/application/src/ports/
 * {runner,workspace}.ts` at WP-273, together with the run credential the launcher protocol carries.
 *
 * ## Why they live in `@platform/contracts` now
 *
 * TD-031 decision 4 puts `runPackageSchema` in this package, and a run package **is** these shapes: the
 * `RunSpec` minus its secret values, the `WorkspaceSpec`, the run credential (`./worker.ts`). This
 * package may import nothing of the platform's (the dependency rule in `biome.json`), so the schemas
 * moved rather than the package reaching up. They moved verbatim, docblocks included; the two
 * application ports and `packages/infrastructure/src/launcher/protocol.ts` re-export every name, so no
 * importer changed. The functions that came with them (`qualifiedPlatformSkill`,
 * `platformSkillOfQualified`, `unlistedProtectedPaths`) are pure and moved with their schemas rather
 * than splitting one section across two rings.
 *
 * ## camelCase, a stated deviation from this package's snake_case rule
 *
 * `index.ts` states the rule: the wire is snake_case. These shapes are camelCase because they were
 * never a wire until the launcher's control plane carried the `WorkspaceSpec` (TD-028's WP-53 note,
 * stated in `protocol.ts`) and a run package carries both (TD-031 §4, which states the same
 * deviation). Re-spelling them for one hop would be a second schema for one structure. Everything
 * else in this package — the worker protocol's HTTP DTOs included — stays snake_case.
 */
import * as z from 'zod';
import {
  agentRoleSchema,
  artifactTypeSchema,
  effortSchema,
  idSchema,
  isoDateTimeSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  providerModeSchema,
  runModeSchema,
  runSavedWorkSchema,
  shaSchema,
  stageIdSchema,
  usdSchema,
} from './common.js';
import { unattendedCommandModeSchema } from './config.js';
import { jsonObjectSchema } from './records.js';

// ── WorkspaceSpec (from `ports/workspace.ts`) ─────────────────────────────────

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
 * A run whose git goes over **SSH** with a project deploy key — TD-028 decision 13b (WP-146). Every
 * field is non-secret and platform-written (the provider's route, the key's public half): the private
 * key never travels in a spec, only in the create request's credential, and never enters the run
 * container. The launcher writes {@link knownHosts} to the run's control directory, serves
 * `/ctl/ssh-agent.sock` through the shim listing {@link publicKey}, and answers the CLI's
 * `GIT_SSH_COMMAND` and one `url.<sshPrefix>.insteadOf = <httpsPrefix>` pair (`cliEnvironment`).
 */
export const workspaceGitSshSchema = z.strictObject({
  /** The deploy key's `ssh-ed25519 AAAA…` line, without a comment. */
  publicKey: z
    .string()
    .max(200)
    .regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/, 'expected an ssh-ed25519 public key line'),
  /** The repository URL prefix git rewrites (`https://gitlab.com/`). */
  httpsPrefix: z
    .string()
    .max(300)
    .regex(/^https:\/\/[a-z0-9.-]+\/$/, 'expected https://<host>/'),
  /** What it becomes (`ssh://git@altssh.gitlab.com:443/`). */
  sshPrefix: z
    .string()
    .max(300)
    .regex(/^ssh:\/\/git@[a-z0-9.-]+:\d{1,5}\/$/, 'expected ssh://git@<host>:<port>/'),
  /** The host the egress sidecar is asked to `CONNECT` to — one of the spec's egress hosts. */
  connectHost: egressHostSchema,
  /** Its port, one of the spec's `connectPorts` (443: no port 22 is ever admitted). */
  connectPort: z.int().min(1).max(65_535),
  /** The name the host keys are pinned under (`HostKeyAlias`). */
  hostKeyAlias: egressHostSchema,
  /** The documented `known_hosts` lines, each `<hostKeyAlias> <type> <base64>`. */
  knownHosts: z
    .array(
      z
        .string()
        .max(1_024)
        .regex(
          /^[a-z0-9.-]+ (?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+={0,2}$/,
          'expected one known_hosts line',
        ),
    )
    .min(1)
    .max(8),
});
export type WorkspaceGitSsh = z.infer<typeof workspaceGitSshSchema>;

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
    /** SSH with a deploy key (WP-146, TD-028 decision 13b); absent is HTTPS with the credential helper. */
    ssh: workspaceGitSshSchema.optional(),
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
  /**
   * The run-shim protocol the **requesting runner** speaks (`RUNLET_PROTOCOL_VERSION`, WP-151,
   * TD-025's M9 amendment) — the runner, not the launcher, is the other end of the run's control
   * socket, and the two can be from different builds. The launcher compares it with the run image's
   * `com.agentic.runlet-protocol` label before it creates anything and refuses another number, or
   * none, as `invalid_spec` naming the image and both numbers. Required: a runner from before WP-151
   * sends no number, and its create is refused by this schema rather than admitted unchecked.
   */
  runletProtocol: z.int().positive(),
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

// ── RunSpec ──────────────────────────────────────────────────────────────────

/** technical/04: `maxTurns`, `maxBudgetUsd`, `stallTimeoutMs`, `wallClockMs` from effective config. */
export const runLimitsSchema = z.strictObject({
  maxTurns: z.int().positive().max(1000),
  maxBudgetUsd: usdSchema,
  /** No transcript output for this long ⇒ the run is `stalled` (technical/02: default 5 min). */
  stallTimeoutMs: z.int().positive(),
  /** Hard ceiling on the whole run; the process tree is killed (technical/05). */
  wallClockMs: z.int().positive(),
  /** `PostToolUse` truncates tool output to this many characters, head and tail (technical/04). */
  toolOutputMaxChars: z.int().positive(),
  /** How long `canUseTool` waits for a human before it denies (BD-025: unattended default deny). */
  questionTimeoutMs: z.int().positive(),
});

export const runLimitsDefaults = {
  maxTurns: 60,
  maxBudgetUsd: 10,
  stallTimeoutMs: 5 * 60_000,
  wallClockMs: 60 * 60_000,
  toolOutputMaxChars: 10_000,
  questionTimeoutMs: 24 * 60 * 60_000,
} as const satisfies z.infer<typeof runLimitsSchema>;

/** The three-list command policy as it reaches the runner (BD-025); resolved by WP-15. */
export const runCommandPolicySchema = z.strictObject({
  allow: z.array(nonEmptyStringSchema),
  ask: z.array(nonEmptyStringSchema),
  block: z.array(nonEmptyStringSchema),
  /**
   * What the `PreToolUse(Bash)` hook does with an `ask` (BD-025's 2026-10-06 amendment): `auto`
   * runs it in the sandbox, `deny` refuses it — `unattendedCommandModeOf` over the organisation,
   * the settings and the repository file. Required, so no planner can leave a run to a default.
   */
  unattended: unattendedCommandModeSchema,
});

/** One subagent definition (technical/04 `agents`). */
export const runSubagentSchema = z.strictObject({
  description: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  tools: z.array(nonEmptyStringSchema),
});

/** A context-pack document written into the workspace (product/05, technical/04). */
export const runContextDocumentSchema = z.strictObject({
  tier: z.union([z.literal(0), z.literal(1)]),
  path: pathPatternSchema,
  reason: z.string(),
});

/**
 * The ten in-process MCP tools of technical/04 (`get_conversation` joined at WP-180, TD-029 decision
 * 11). A run is given the subset its role needs: a
 * read-only stage never sees `open_mr`, so a mutating action is impossible rather than merely
 * refused (BD-021).
 */
export const PLATFORM_TOOL_NAMES = [
  'ask_human',
  'notify_human',
  'report_progress',
  'get_task_context',
  'get_conversation',
  'kb_search',
  'add_ticket_comment',
  'open_mr',
  'update_mr_description',
  'create_followup_ticket',
] as const;

export type PlatformToolName = (typeof PLATFORM_TOOL_NAMES)[number];

export const platformToolNameSchema = z.enum(PLATFORM_TOOL_NAMES);

/** Platform tools that change something outside the workspace. */
export const MUTATING_PLATFORM_TOOLS = [
  'add_ticket_comment',
  'open_mr',
  'update_mr_description',
  'create_followup_ticket',
] as const satisfies readonly PlatformToolName[];

/**
 * What a run's prompt already carries **whole**, so `get_task_context` need not send it again
 * (PROGRESS backlog 474): on Autix the tool re-sent the ticket and the RefinedSpec the user prompt
 * held — about 22 KB of a run's context, twice.
 *
 * Written by the planner from the same cut the assembler applies (`artifactShownWhole`), never
 * re-derived by the tool. Absent for a run whose prompt the tool knows nothing about (the ask, a
 * test's hand-built spec), and then every value is served as before — the safe direction.
 */
export const promptHoldsSchema = z.strictObject({
  ticket: z.boolean(),
  artifacts: z.array(
    z.strictObject({ artifact_type: artifactTypeSchema, version: z.int().positive() }),
  ),
});

export type PromptHolds = z.infer<typeof promptHoldsSchema>;

export const runSpecSchema = z.strictObject({
  runId: idSchema,
  taskId: idSchema,
  projectId: idSchema,
  /** Null for runs that belong to no pipeline stage — discovery, librarian, ask-the-task. */
  stage: stageIdSchema.nullable(),
  role: agentRoleSchema,
  mode: runModeSchema,
  attempt: z.int().positive(),
  model: nonEmptyStringSchema,
  effort: effortSchema,
  providerMode: providerModeSchema,
  /** Hash of prompt layers 1–3 (technical/04 § "Prompt assembly"). */
  promptVersion: nonEmptyStringSchema,
  /** Layers 1–3, already assembled by `assemblePrompt`; appended to the `claude_code` preset. */
  systemPromptAppend: nonEmptyStringSchema,
  /** Layers 4–6: the task block, the context pack and the output contract. */
  userPrompt: nonEmptyStringSchema,
  /** Absolute path of the task's workspace; the only writable tree (BD-021, TD-021). */
  workspacePath: nonEmptyStringSchema,
  /**
   * The **branch** the workspace checks out — technical/05 §2's *"checkout of the task branch for
   * re-entries"*, which had no carrier at all until WP-34 (PROGRESS backlog **71**).
   *
   * A branch name, never a commit (WP-105: a commit is {@link checkoutCommit}). `null` means the
   * repository's default branch, which is what the *first* run of a task gets: the task's branch
   * does not exist on the remote yet, and a provisioner that failed on it would fail every task's
   * first stage.
   *
   * One producer, `pipeline/planner.ts`: an ordinary task checks out its **own branch**
   * (`tasks.branch`), so a returned `implementation` run sees what the previous attempt pushed and
   * a `code_review` stage reviews the tree the merge request is about.
   *
   * **It is honoured since WP-53**, which is the mapping backlog 71 was filed for:
   * `runWorkspaceSpecFor` (`packages/infrastructure/src/launcher/provisioner.ts`) writes it to
   * `WorkspaceSpec.repo.checkoutBranch`, and the Docker provider's clone runs
   * `git checkout "$B" || git checkout -b "$B"` — so a task's first run, whose branch is not on the
   * remote, clones the default branch and creates it rather than failing. Measured end to end
   * against a real daemon by `scripts/launcher-control-plane-check.mjs`.
   */
  checkoutRef: nonEmptyStringSchema.nullable(),
  /**
   * The **commit** the workspace checks out, detached — a **shadow** task's base: the merge base of
   * the human merge request it is compared with (Q82 (a)), because a diff written against today's
   * tree and a human diff written against the tree six months ago measure drift, not similarity.
   *
   * Its own field since WP-105 (WP-98's discovered work). Until then the sha travelled in
   * {@link checkoutRef}, and the clone's `checkout "$B" || checkout -b "$B"` — right for a branch a
   * task's first run creates — turned a commit the mirror does not hold into a new branch *named*
   * after the sha at the default branch's head: the run started on today's tree, which Q82 (a) says
   * must be refused. A field per kind is how the workspace tells *a branch that does not exist yet*
   * (create it) from *a commit that does not exist* (refuse the start by name, `invalid_spec`,
   * terminal — `#clone` in `packages/infrastructure/src/workspace/provider.ts`). At most one of the
   * two is set; the planner is the one producer.
   */
  checkoutCommit: shaSchema.nullable(),
  /**
   * Where this run's **unfinished work** goes if it ends without a result — the product owner's
   * 2026-10-05 decision (BD-025's amendment of that date, PROGRESS backlog 467) — or `null` for a
   * run whose work is not saved.
   *
   * One producer, the planner (`unfinishedWorkBranchFor` in `pipeline/unfinished-work.ts`): a
   * Developer run of an ordinary task at any stage but `conflict_resolution`, whose checkout is an
   * `agentic/*` branch — the same value as {@link checkoutRef}, so the work goes back to the branch
   * the run was given. One reader, the workspace runner, which asks the workspace for the export when
   * the outcome is one `savesUnfinishedWork` names. A field rather than a rule the runner re-derives
   * because the runner must not grow a second opinion about roles, stages and task modes.
   */
  unfinishedWorkBranch: runSavedWorkSchema.shape.branch.nullable(),
  contextPack: z.array(runContextDocumentSchema),
  limits: runLimitsSchema,
  /**
   * The role's tool policy: the **base set** the run may use, mapped onto the SDK's `tools`.
   *
   * Named `tools` and not `allowedTools` because the SDK means something else by that name — an
   * auto-approve list that shadows `canUseTool` — which technical/04's table got wrong and WP-12
   * corrected there (see the note under the RunSpec table). The field kept the wrong name for one
   * work package; it is renamed here so the next reader inherits the correction rather than the
   * confusion. The `runs.allowed_tools` **column** keeps its name: that is technical/03's wire.
   */
  tools: z.array(nonEmptyStringSchema),
  disallowedTools: z.array(nonEmptyStringSchema),
  platformTools: z.array(platformToolNameSchema),
  commandPolicy: runCommandPolicySchema,
  /**
   * BD-024's protected paths (technical/04's WP-99 amendment). A write that **creates** one is
   * allowed; a write to one that **exists** at the merge base with the default branch (`existingProtectedPaths`) is
   * allowed only when a pattern of `plannedProtectedPaths` matches it.
   */
  protectedPaths: z.array(pathPatternSchema),
  /**
   * The latest ImplementationPlan's `protected_path_changes[].path` — the planner reads them through
   * the CI gate's own `exceptionsOf`, and an absent or unparsable plan gives `[]`.
   */
  plannedProtectedPaths: z.array(pathPatternSchema),
  /**
   * Which protected paths exist at the merge base of the checkout and the default branch. The planner writes `unlisted` (nothing is
   * listed before there is a workspace, and `unlisted` fails closed); the workspace runner
   * substitutes the launcher's listing beside `workspacePath`.
   */
  existingProtectedPaths: existingProtectedPathsSchema,
  agents: z.record(nonEmptyStringSchema, runSubagentSchema),
  /** Opaque per-provider MCP configuration (technical/06); passed to the SDK unread. */
  mcpServers: z.record(nonEmptyStringSchema, jsonObjectSchema),
  skills: z.array(nonEmptyStringSchema),
  /**
   * The artifact this run must produce, or null for a run that produces none (intake
   * classification, ask-the-task). The runner derives **both** the JSON Schema it hands the SDK
   * (`outputFormat: { type: 'json_schema' }`) and the validator it re-checks the answer with from
   * `artifactDataSchemas` in `@platform/contracts`, so "what the model was asked for" and "what the
   * platform accepts" cannot drift apart — technical/04 calls the second check defence in depth,
   * and defence in depth against a *different* schema is not depth.
   */
  artifactType: artifactTypeSchema.nullable(),
  /**
   * The subprocess environment, explicit and never inherited (technical/04; the SDK's `env`
   * REPLACES `process.env` rather than merging with it — verified in `Options.env`).
   */
  env: z.record(nonEmptyStringSchema, z.string()),
  /**
   * Names of `env` entries whose values are secret. The composition root builds the run's
   * injected-secret redactor from these (TD-012 step 1); the runner never copies the values.
   */
  secretEnvNames: z.array(nonEmptyStringSchema),
  /** `pathToClaudeCodeExecutable` in `local` provider mode (BD-004); null uses the bundled binary. */
  claudeCodePath: nonEmptyStringSchema.nullable(),
  /** Session to resume after a platform restart (technical/04 § "Resume and take-over"). */
  resumeSessionId: nonEmptyStringSchema.nullable(),
  /** {@link promptHoldsSchema}: what `get_task_context` need not send again. Optional. */
  promptHolds: promptHoldsSchema.optional(),
});

export type RunSpec = z.infer<typeof runSpecSchema>;
export type RunLimits = z.infer<typeof runLimitsSchema>;
export type RunCommandPolicy = z.infer<typeof runCommandPolicySchema>;
export type RunSubagent = z.infer<typeof runSubagentSchema>;
export type RunContextDocument = z.infer<typeof runContextDocumentSchema>;

// ── The run credential (moved from `launcher/protocol.ts` at WP-273) ─────────

/**
 * The run's git credential, **minted by the runner and carried to the launcher** — TD-028's WP-76
 * amendment (2026-09-25), decision 3.
 *
 * This read *"The launcher **mints** through its own `RunCredentialSource`; the caller says what to
 * mint for"* until WP-76, and the launcher could not: it holds no binding, no `APP_SECRET_KEY` and
 * no database (TD-021), so its source refused and every writing run failed terminally at
 * `startRun` (PROGRESS backlog 133). The second clause survives — **the scope is still decided
 * platform-side**, by the spec's `readOnly` — and the first is reversed: the runner mints through
 * `IntegrationActionExecutor` (one audit row per mint and per revoke, keyed by the git binding) and
 * sends the material here.
 *
 * What that costs, stated rather than implied: **the runner holds the token for the life of the
 * run**, not of one request — it answers the workspace's `cred.get` from its own copy and revokes
 * after `endRun` returns — and the token crosses this hop, the same `internal: true`, authenticated
 * network the run token already crosses the other way (`workspaceAttachmentSchema`). No `revokeId`
 * travels: the launcher cannot use one. Neither end logs a body.
 */
export const runCredentialSchema = z.strictObject({
  /** The git host the credential is for. Lowercase, no port — {@link egressHostSchema}'s form. */
  host: nonEmptyStringSchema.max(253),
  username: nonEmptyStringSchema.max(255),
  /** The secret. Standing rule 18: `nonEmptyStringSchema` refuses empty and blank. */
  password: nonEmptyStringSchema.max(4_096),
  scope: z.enum(['read', 'push']),
  expiresAt: isoDateTimeSchema,
  /**
   * `minted` for a run-scoped token, `static` for an integration's declared run token (TD-028
   * decision 13, WP-137) — the one credential a **read-only** spec may carry with `push` scope,
   * because it cannot be narrowed. Absent is `minted`, so an absent field falls under the strict
   * rule rather than the exception.
   *
   * `deploy_key` (TD-028 decision 13b, WP-146) is a project SSH deploy key: `password` is then the
   * **OpenSSH private key text**, `username` is `git`, the spec's `repo.ssh` must be present (and is
   * present only then), and the launcher uses the key for exactly one thing — its mirror and export
   * helpers, from a `0600` file on the helper's tmpfs. It is never answered to the workspace's
   * `cred.get`; the run's signatures come from the runner through `/ctl/ssh-agent.sock`.
   */
  source: z.enum(['minted', 'static', 'deploy_key']).optional(),
});
export type RunCredentialPayload = z.infer<typeof runCredentialSchema>;

/**
 * How a deploy key travels: `carried` — in the launcher's create request, to the launcher's own mirror
 * and export helpers (TD-028 decision 13b) — or `signed_by_core` — never: a run package for a remote
 * worker carries no deploy key and the worker forwards `ssh.sign` to the core (TD-031 decision 5).
 */
export type DeployKeyCarriage = 'carried' | 'signed_by_core';

/**
 * The run credential's rules against the spec it travels with — TD-028's WP-76 amendment (decisions 3
 * and 6) and decision 13b, as `createRunRequestSchema` has applied them since WP-76, moved here at
 * WP-273 so the run package applies **the same** rules rather than a copy (`./worker.ts`). Each
 * message is one refusal; an empty list admits the pair. The order of the checks, and therefore of
 * the messages, is the launcher's own.
 *
 * The one difference is {@link DeployKeyCarriage}: under `signed_by_core` a `deploy_key` credential
 * is refused and an SSH spec carries none, because the key never leaves the core (TD-031 §5).
 *
 * What it does **not** check is the credential in the environment: the launcher's request has one
 * environment (`spec.env`) and a package has two, so each schema runs `secretInEnvironment` over its own.
 */
export const runCredentialIssues = (
  spec: WorkspaceSpec,
  credential: RunCredentialPayload | null,
  deployKey: DeployKeyCarriage,
): string[] => {
  const issues: string[] = [];
  if (spec.repo === null) {
    if (credential !== null) {
      issues.push('a spec with no repository carries no credential: nothing will fetch or push');
    }
    return issues;
  }
  const ssh = spec.repo.ssh;
  if (deployKey === 'signed_by_core') {
    if (credential?.source === 'deploy_key') {
      issues.push(
        'a deploy key never leaves the core: a run package carries none, and the worker forwards ssh.sign to the core (TD-031 decision 5)',
      );
      return issues;
    }
    if (ssh !== undefined && credential !== null) {
      issues.push(
        'a spec whose git goes over SSH carries no credential in a run package: the core signs for it (TD-031 decision 5)',
      );
    }
  }
  if (credential === null) {
    if (ssh !== undefined && deployKey === 'carried') {
      issues.push('a spec whose git goes over SSH carries its deploy key (TD-028 decision 13b)');
    }
    if (!spec.readOnly && (ssh === undefined || deployKey === 'carried')) {
      issues.push(
        'a spec that writes must carry a run credential; a binding that cannot mint refuses the run before it is created',
      );
    }
    if (ssh !== undefined && deployKey === 'signed_by_core') {
      issues.push(...sshRouteIssues(spec, ssh));
    }
    return issues;
  }
  // WP-146: a deploy key and the spec's SSH route travel together or not at all, and the route's
  // CONNECT host and port are ones the run may reach — 443, never 22 (decision 13b item 4).
  if (deployKey === 'carried' && (credential.source === 'deploy_key') !== (ssh !== undefined)) {
    issues.push(
      'a deploy-key credential and the spec’s repo.ssh route travel together: one without the other is an SSH run with no key or a key with no route (TD-028 decision 13b)',
    );
  }
  if (ssh !== undefined) issues.push(...sshRouteIssues(spec, ssh));
  if (
    spec.readOnly &&
    credential.scope === 'push' &&
    credential.source !== 'static' &&
    credential.source !== 'deploy_key'
  ) {
    issues.push(
      'a read-only spec may carry a read credential or none, never a minted push one (BD-021); only a static run credential, which cannot be narrowed, is push-scoped there (TD-028 decision 13)',
    );
  }
  if (!spec.egress.hosts.includes(credential.host)) {
    issues.push('the credential names a host that is not one of the spec’s egress hosts');
  }
  return issues;
};

/** The SSH route's CONNECT host and port are ones the run may reach — 443, never 22. */
const sshRouteIssues = (spec: WorkspaceSpec, ssh: WorkspaceGitSsh): string[] => {
  const issues: string[] = [];
  if (!spec.egress.hosts.includes(ssh.connectHost)) {
    issues.push('the SSH route’s CONNECT host is not one of the spec’s egress hosts');
  }
  if (!spec.egress.connectPorts.includes(ssh.connectPort) || ssh.connectPort === 22) {
    issues.push(
      'the SSH route’s port must be one the sidecar admits for CONNECT, and never 22 (TD-028 decision 13b item 4)',
    );
  }
  return issues;
};

/** Whether `secret` occurs in any value of any of `environments` — the credential-in-env rule. */
export const secretInEnvironment = (
  secret: string,
  environments: readonly Readonly<Record<string, string>>[],
): boolean =>
  environments.some((env) => Object.values(env).some((value) => value.includes(secret)));
