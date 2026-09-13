/**
 * `WorkspaceSpec`, built — WP-15g.
 *
 * ## Nothing built one before this file
 *
 * `workspaceSpecSchema` has existed since WP-14 and the only producer in the tree was the test
 * fixture `packages/infrastructure/src/workspace/fixtures.ts`. So every green result about a
 * workspace was a result about a spec a test wrote, and the fields that decide what a run container
 * may *do* — its limits, its egress allow-list, its runtime, whether it is read-only, how long its
 * volume is kept — had no production derivation at all. This is that derivation, as a pure function
 * so it can be asserted without a daemon.
 *
 * It lives beside the Docker adapter rather than in `packages/application` for one reason: its input
 * is a `RunSpec` and the one `RunSpec` fixture this repository has is in `packages/infrastructure`
 * (`runner/fixtures.ts`, which exists so that a spec built by hand in each work package cannot drift
 * from `runSpecSchema`). A second fixture in the application ring to test a pure function would be
 * the drift that fixture was written to prevent. Nothing in `application` calls this: the callers are
 * composition roots, and they are all outside that ring.
 *
 * ## BD-025's narrow-never-widen rule is satisfied by construction, not by a merge
 *
 * BD-025 lets a project *narrow* the organisation's maximum and never widen it. The obvious
 * implementation is a merge that drops anything a project tried to raise — and the obvious
 * implementation is not what this does, because **`agenticConfigSchema` has no workspace section**:
 * there is no key in `.agentic/config.yml` for cpus, memory, pids, the runtime or an egress host, so
 * a project cannot say anything about the workspace at all. Every input below comes from instance
 * configuration and from the git binding. That is the strongest form of the rule, and it is also the
 * form that cannot decay: a merge function nothing feeds is a merge function nobody tests, while an
 * input that does not exist cannot widen anything.
 *
 * Whether a project *should* be able to narrow its own runs — a repository that wants gVisor, or
 * less memory, or one more registry host — is a product question rather than an omission, and it is
 * filed as **Q62** with this recommendation: keep the workspace out of the repository's own
 * configuration until an operator asks, because every key added there is a key an attacker who can
 * open a merge request can propose.
 *
 * ## The egress allow-list is the part to read carefully
 *
 * technical/05 § "Network policy" lists four sources: the model provider host, the git host, "package
 * registries for the project's ecosystems (from discovery)" and read-only observability hosts for
 * stages that may use them. **Two of those four do not exist in this build.** Discovery has not been
 * written, so no registry host can be derived, and no stage carries observability hosts yet. So the
 * allow-list this produces is *the model host (or none, in `local` provider mode) plus the git host*,
 * and the consequence is stated rather than discovered: **a run cannot install a package.** A stage
 * whose work needs `npm install` fails inside the container rather than reaching a registry, which is
 * the fail-closed direction and is visibly wrong rather than silently permissive. Widening it is
 * discovery's job (WP-21's row) and an operator's, not this function's.
 */
import type {
  RunSpec,
  WorkspaceLimits,
  WorkspaceRuntime,
  WorkspaceSpec,
} from '@platform/application';
import { platformSkillOfQualified, workspaceSpecSchema } from '@platform/application';

/**
 * TD-021's per-run defaults: "project defaults 2 CPU / 4 GiB / 512 pids", `stop_grace_period: 20s`
 * (technical/05 § "Hardening flags"), and a `/tmp` tmpfs whose size technical/05 takes "from
 * config" — 512 MiB here, which is what a `node_modules` install writes to a temporary directory and
 * an order of magnitude below the memory limit it is charged against.
 */
export const PLATFORM_WORKSPACE_LIMITS: WorkspaceLimits = {
  cpus: 2,
  memoryMb: 4_096,
  pidsLimit: 512,
  tmpfsMb: 512,
  stopGraceSeconds: 20,
};

/**
 * How long a finished run's volume is kept (technical/05 §5: "3 days default, 14 days for
 * paused/taken-over").
 *
 * The three-day value is what a spec is *created* with, because at create time nothing knows whether
 * the task will be paused or taken over. Extending it for a workspace a human took over is the
 * launcher's job at export time and no code does it yet — recorded here rather than implied, because
 * the number in this file is the one an operator will find first.
 */
export const DEFAULT_WORKSPACE_KEEP_DAYS = 3;

/** Ports `CONNECT` may name. TD-021/technical-05: 443 only, unless a project needs more. */
const DEFAULT_CONNECT_PORTS = [443];

/**
 * The host of a repository URL, lowercased, with any port, credentials and path removed.
 *
 * `https://git.example.com:8443/acme/api.git` and git's scp-style `git@git.example.com:acme/api.git`
 * both name the same host and `egressHostSchema` accepts neither spelling, so the parse is here
 * rather than at the call site. A URL whose host cannot be read is an error and not an empty
 * allow-list entry: an egress list quietly missing the git host is a run that cannot push and a
 * failure three minutes later that names TLS.
 */
export const egressHostOfRepoUrl = (repoUrl: string): string => {
  const authority = repoUrl
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^/@]+@/, '')
    .split('/')[0] as string;
  // `host:port` (a URL) and `host:path` (scp style) both split on the first colon; the host is the
  // part in front either way.
  const host = (authority.split(':')[0] ?? '').toLowerCase();
  if (host.length === 0) {
    throw new Error(
      `the repository URL ${JSON.stringify(repoUrl)} names no host, so the run's egress allow-list cannot include the git host`,
    );
  }
  return host;
};

/**
 * A cache key for the project's bare mirror (`repo-cache`, one per project).
 *
 * The project id with its dashes removed: `workspaceRepoSchema` constrains the key to
 * `^[a-z0-9][a-z0-9._-]{0,62}$` because it becomes a **directory name** on a shared volume, and a
 * uuid is the one identifier the platform has that is already free of anything a filesystem reads
 * specially. Deriving it from `projects.repo_url` instead would make two projects that share a
 * repository share a mirror, which is a decision nobody has taken.
 */
export const mirrorCacheKeyFor = (projectId: string): string =>
  `p${projectId.replaceAll('-', '').toLowerCase()}`;

/**
 * Does this run need a git write credential?
 *
 * Read off the run's **own tool policy** rather than from a table of roles: `readOnly` decides
 * whether the launcher mints a token at all (BD-021 — "a read-only stage gets no git write
 * credential, so the broker mints nothing and `cred.get` has nothing to answer"), and the honest
 * question is whether this run can change the checkout. A run with no `Write` and no `Edit` cannot,
 * whatever its role is called. Deriving it from the spec also means a role whose tools are narrowed
 * later gets the narrower workspace automatically.
 */
export const runIsReadOnly = (spec: RunSpec): boolean =>
  !spec.tools.includes('Write') && !spec.tools.includes('Edit');

/**
 * The platform skills to provision, read off the run's own `skills` list.
 *
 * `RunSpec.skills` is plugin-qualified (`agentic:kb`) because that is what the SDK's filter takes;
 * a workspace directory is called `kb`. A name that is **not** the platform's is dropped rather
 * than provisioned: the provider has no file for it, and creating an empty directory named after
 * somebody else's skill would put a skill in the listing with no body. Dropping is safe in the
 * direction that matters — a skill that is not in the workspace cannot be used — and the planner is
 * the only producer, so a drop here means the two disagreed and the run is narrower than intended.
 */
export const platformSkillsOf = (spec: RunSpec): readonly string[] => {
  const names = spec.skills
    .map((qualified) => platformSkillOfQualified(qualified))
    .filter((name): name is string => name !== null);
  return [...new Set(names)].sort();
};

export interface BuildWorkspaceSpecInput {
  /** The run the workspace is for; `runId`, `projectId` and the tool policy are read from it. */
  readonly spec: RunSpec;
  /** `projects.repo_url` — what the mirror fetches from and what the export pushes to. */
  readonly repoUrl: string;
  readonly defaultBranch: string;
  /** The task's branch for a re-entry; `null` is the default branch (BD-025). */
  readonly checkoutBranch?: string | null;
  /**
   * Hosts the platform itself needs the run to reach: the model provider, or a proxy in front of it.
   * Empty in `local` provider mode, where the binary is on the host and talks to nothing.
   */
  readonly platformEgressHosts: readonly string[];
  /** Non-secret project variables for the *container's* environment (BD-025 §3 keeps secrets out). */
  readonly containerEnv?: Readonly<Record<string, string>>;
  readonly limits?: WorkspaceLimits;
  readonly runtime?: WorkspaceRuntime;
  readonly keepDays?: number;
  readonly now: Date;
}

/**
 * Builds the spec, and validates it here rather than trusting the caller.
 *
 * `workspaceSpecSchema.parse` at the end is not ceremony: the adapter validates again before it
 * reaches the daemon (the port's docblock says so), and this is the parse that turns a bad
 * `repo_url` or a host that is not a DNS name into an error an operator can read at the point the
 * *platform* made the decision, rather than into a container argument.
 */
export const buildWorkspaceSpec = (input: BuildWorkspaceSpecInput): WorkspaceSpec => {
  const gitHost = egressHostOfRepoUrl(input.repoUrl);
  const hosts = [
    ...new Set([...input.platformEgressHosts.map((host) => host.toLowerCase()), gitHost]),
  ];
  const keepUntil = new Date(
    input.now.getTime() + (input.keepDays ?? DEFAULT_WORKSPACE_KEEP_DAYS) * 24 * 60 * 60 * 1_000,
  );
  return workspaceSpecSchema.parse({
    runId: input.spec.runId,
    projectId: input.spec.projectId,
    repo: {
      url: input.repoUrl,
      defaultBranch: input.defaultBranch,
      checkoutBranch: input.checkoutBranch ?? null,
      cacheKey: mirrorCacheKeyFor(input.spec.projectId),
    },
    limits: input.limits ?? PLATFORM_WORKSPACE_LIMITS,
    egress: { hosts, connectPorts: DEFAULT_CONNECT_PORTS },
    // `runc` unless an operator asks for gVisor; TD-021 makes `runsc` opt-in and Linux-only.
    runtime: input.runtime ?? 'runc',
    readOnly: runIsReadOnly(input.spec),
    skills: platformSkillsOf(input.spec),
    env: { ...(input.containerEnv ?? {}) },
    keepUntil: keepUntil.toISOString(),
  });
};
