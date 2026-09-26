/**
 * The first production `RunWorkspaceProvisioner` — WP-53, and the thing whose absence made every
 * green result about a run in this repository a result about a test's fake.
 *
 * Until this file, `apps/server/src/agent.ts` took a provisioner it was *given*, nothing gave it
 * one, and `startRuntime` therefore composed `unavailableClaudeRunner`. So **no production agent
 * run had ever executed**, and eleven findings were latent behind that one fact (TD-028 § Context).
 * This is the composition that ends it: a `RunSpec` in, a live control socket and a `SpawnedProcess`
 * factory out, with the Docker daemon on the other side of TD-028's HTTP control plane.
 *
 * ## It holds no Docker client, and that is checked rather than promised
 *
 * TD-021's WP-15g amendment forbids the process that composes the pipeline or serves `/webhooks/*`
 * from constructing one. Everything this file touches is `client.ts` (a `fetch`) and
 * `createRunletSpawn` (a Unix socket on a volume). `apps/launcher/src/docker-access.test.ts` reads
 * every tracked source off disk and would fail if that changed.
 *
 * ## The run's git credential is minted here, held here and revoked here (WP-76)
 *
 * TD-028's WP-76 amendment, closing PROGRESS backlog **133**: the launcher holds no binding, so the
 * **runner** mints — through {@link RunGitCredentialMinter}, which the composition root builds over
 * `IntegrationActionExecutor` — and the create request carries the material. Four obligations
 * follow, each discharged in {@link createLauncherRunWorkspaceProvisioner} and each with a test:
 *
 *  - **the scope is the spec's**: `push` for a writing spec, `read` for a read-only one; a binding
 *    that cannot mint **refuses a writing run** here, before the create (`invalid_spec`, terminal,
 *    naming the binding and the setting), and a read-only run proceeds with no credential — an
 *    anonymous fetch;
 *  - **the runner answers `cred.get`** — the agent's own `git push origin agentic/*` asks the shim,
 *    the shim asks this process, and `createRunletSpawn` had no responder here, so every answer was
 *    *"runlet has no credential responder; refusing"*. It answers from a {@link RunCredentialBroker}
 *    with the broker's exact-host comparison, and `null` from the moment `release` begins;
 *  - **revoked exactly once**: after `endRun` returns on every ending (so a take-over export pushes
 *    first), or when the create fails for any reason — never twice, because a per-call adapter has
 *    no memory of an earlier revoke and a second one is `not_found` (GitLab divergence 6);
 *  - **never logged**: the log lines carry the scope, never the value.
 *
 * ## Four things it decides, each of which was a filed defect
 *
 *  - **`spec.checkoutRef` reaches `WorkspaceSpec.repo.checkoutBranch`** (PROGRESS backlog **71**).
 *    The planner has filled that field since WP-34 and it reached nothing; the one mapping is
 *    {@link runWorkspaceSpecFor}. The *"the branch is not on the remote"* half was already answered
 *    at the provider — `#clone` runs `git checkout "$B" || git checkout -b "$B"` — so a task's first
 *    run clones the default branch and creates the task branch rather than failing.
 *  - **The CLI's path comes from the run image** (backlog **34**). The launcher answers it on
 *    `create`; this file puts it on the workspace so `createWorkspaceClaudeRunner` can substitute it
 *    into the spec beside `workspacePath`. Nothing here guesses a path.
 *  - **Both provider modes need the model host in the egress allow-list.** `buildWorkspaceSpec`'s
 *    docblock says *"the model host (or none, in `local` provider mode), … the binary is on the host
 *    and talks to nothing"*, which was true when `local` meant an operator's own binary. Since WP-22
 *    it is not: `compose.local.yml` says *"the CLI does not run in this container: it runs in the
 *    per-run `platform-runtime` container"*, and WP-53 measured that the pinned CLI reads
 *    `CLAUDE_CODE_OAUTH_TOKEN` and authenticates against the **same** API (`401 OAuth access token
 *    is invalid`). So the host is on the list in both modes, and the sentence is corrected there.
 *  - **The socket path is checked against this process' own control root.** The launcher computes it
 *    from *its* `APP_WORKSPACE_CONTROL_ROOT`; the runner mounts the same volume and may have mounted
 *    it somewhere else. A mismatch is a compose mistake, and without this check it surfaces as
 *    `ECONNREFUSED` thirty seconds into a run instead of as a named refusal before one starts.
 */
import type {
  Logger,
  RunnerClock,
  RunSpec,
  WorkspaceHandle,
  WorkspaceSpec,
} from '@platform/application';
import { silentLogger, WorkspaceError } from '@platform/application';
import { createRunletSpawn } from '../runlet/spawn-adapter.js';
import type {
  ProvisionedRunWorkspace,
  RunWorkspaceEnding,
  RunWorkspaceProvisioner,
} from '../runner/workspace-runner.js';
import { RunCredentialBroker, type RunCredentialScope } from '../workspace/broker.js';
import { buildWorkspaceSpec } from '../workspace/spec.js';
import type { LauncherControlClient } from './client.js';
import type { CreateRunResponse, RunCredentialPayload } from './protocol.js';

/**
 * What the platform knows about a run's project that the launcher does not.
 *
 * The launcher has no database connection and no route to one (`compose.yml`'s launcher service
 * joins neither the default network nor `db`), so every one of these travels on the create request.
 */
export interface RunWorkspaceProject {
  /** `projects.repo_url` — what the mirror fetches from and what an export pushes to. */
  readonly repoUrl: string;
  /** `projects.default_branch`. */
  readonly defaultBranch: string;
  /** The provider's project handle (`acme/web`), for the run-scoped credential's scope. */
  readonly projectPath: string;
  /** The git host the workspace may ask a credential for. Lowercase, no port. */
  readonly gitHost: string;
  /** BD-025's namespace for what this run may push. */
  readonly branchPatterns: readonly string[];
  /** Non-secret project variables for the container's environment (BD-025 §3). */
  readonly containerEnv: Readonly<Record<string, string>>;
}

/** Where {@link RunWorkspaceProject} comes from. `apps/server` reads it from `projects`. */
export interface RunWorkspaceProjectSource {
  forRun(spec: RunSpec): Promise<RunWorkspaceProject>;
}

/** A credential the runner minted for one run, and the one way to revoke it. */
export interface MintedRunGitCredential {
  readonly username: string;
  /** The secret. Never logged, never stored; carried to the launcher on the create request. */
  readonly password: string;
  readonly scope: RunCredentialScope;
  readonly expiresAt: string;
  /** Revokes it at the provider, through the executor. The provisioner calls it exactly once. */
  revoke(): Promise<void>;
}

/** What the minter answers: a credential, or why there is none (decision 6's refusal is ours). */
export type RunGitCredentialAnswer =
  | { readonly kind: 'minted'; readonly credential: MintedRunGitCredential }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Mints the run's git credential — `apps/server/src/workspaces.ts` composes it over the project's
 * git binding and `IntegrationActionExecutor` (TD-028's WP-76 amendment, decision 1).
 *
 * `scope` is what the spec asks for; the minter may answer a **narrower** one (a shadow task's
 * writing run gets `read`, Q98 (a)) and never a wider one — a `push` answer to a `read` question is
 * refused here.
 */
export interface RunGitCredentialMinter {
  mint(request: {
    readonly spec: RunSpec;
    readonly project: RunWorkspaceProject;
    readonly scope: RunCredentialScope;
    readonly ttlSeconds: number;
  }): Promise<RunGitCredentialAnswer>;
}

export interface LauncherProvisionerOptions {
  readonly client: LauncherControlClient;
  readonly projects: RunWorkspaceProjectSource;
  /**
   * The run's git credential (WP-76). **Required**, with no default: standing rule 31 — an optional
   * security dependency is an absent one, and an absent minter is exactly backlog 133's launcher
   * that could authenticate nothing.
   */
  readonly credentials: RunGitCredentialMinter;
  /**
   * `APP_WORKSPACE_CONTROL_ROOT` **as this process mounts it** — TD-025 §2's static mount.
   *
   * Required, with no default, for standing rule 55's reason: a default here would silently accept
   * a launcher whose control root is somewhere else and produce a connection to a path that is not
   * the one the shim is listening on.
   */
  readonly controlRoot: string;
  /**
   * Hosts the run must reach besides its git host — the model provider, or a proxy in front of it.
   *
   * Configuration rather than a constant, because an instance behind an egress proxy names a
   * different host. Empty is legal and **fails closed**: the run container reaches only its git
   * host, and the CLI's first request is refused by the egress sidecar rather than silently
   * succeeding, which is the direction technical/05 asks for.
   */
  readonly modelEgressHosts: readonly string[];
  /** TD-021's "expires next day" for the run-scoped git credential. */
  readonly credentialTtlSeconds: number;
  readonly clock: RunnerClock;
  readonly logger?: Logger;
}

/**
 * The `WorkspaceSpec` of one run.
 *
 * Exported so the unit tier can assert the mapping without a control plane: it is the whole of
 * backlog **71**'s fix and the whole of where a run's isolation is decided.
 */
export const runWorkspaceSpecFor = (input: {
  readonly spec: RunSpec;
  readonly project: RunWorkspaceProject;
  readonly modelEgressHosts: readonly string[];
  readonly now: Date;
}): WorkspaceSpec =>
  buildWorkspaceSpec({
    spec: input.spec,
    repoUrl: input.project.repoUrl,
    defaultBranch: input.project.defaultBranch,
    // PROGRESS backlog 71, in one line. `null` is the first run of a task: the branch is not on the
    // remote yet and `#clone` creates it.
    checkoutBranch: input.spec.checkoutRef,
    platformEgressHosts: input.modelEgressHosts,
    containerEnv: input.project.containerEnv,
    now: input.now,
  });

/**
 * Refuses a socket path that is not under this process' control root.
 *
 * Exported for the same reason the spec builder is: it is a security-relevant boundary check on a
 * string another process chose, and the unit tier asserts both directions.
 */
export const assertControlSocketUnderRoot = (socketPath: string, controlRoot: string): void => {
  const root = controlRoot.endsWith('/') ? controlRoot : `${controlRoot}/`;
  // `/../` **and** a trailing `/..`: the first spelling was the only one refused until WP-53's
  // review, so `<root>/x/..` — which resolves to the root's parent — was accepted. Both are checked
  // on the raw string rather than resolved, because this is a string another process chose and a
  // `path.resolve` here would answer about *this* process' filesystem.
  const climbs = socketPath.includes('/../') || socketPath.endsWith('/..');
  if (!socketPath.startsWith(root) || climbs) {
    throw new WorkspaceError(
      'invalid_spec',
      `the launcher answered with a control socket at ${socketPath}, which is not under this process' control root ${controlRoot}: the two containers mount the ctl volume at different paths (APP_WORKSPACE_CONTROL_ROOT)`,
    );
  }
};

export const createLauncherRunWorkspaceProvisioner = (
  options: LauncherProvisionerOptions,
): RunWorkspaceProvisioner => {
  const logger = options.logger ?? silentLogger;
  if (!options.controlRoot.startsWith('/')) {
    throw new WorkspaceError(
      'invalid_spec',
      `APP_WORKSPACE_CONTROL_ROOT must be an absolute path (got ${options.controlRoot})`,
    );
  }

  /** What this process answers `cred.get` from — one for the provisioner, keyed by run id. */
  const broker = new RunCredentialBroker(logger);

  return {
    provision: async (spec: RunSpec): Promise<ProvisionedRunWorkspace> => {
      const project = await options.projects.forRun(spec);
      const workspaceSpec = runWorkspaceSpecFor({
        spec,
        project,
        modelEgressHosts: options.modelEgressHosts,
        now: new Date(options.clock.now()),
      });
      // WP-74: a run with no checkout gets no credential — there is no mirror to fetch and nothing
      // to push. WP-76: a run with one gets one minted here, once per provision call.
      const minted =
        workspaceSpec.repo === null
          ? null
          : await mintFor({
              minter: options.credentials,
              spec,
              project,
              readOnly: workspaceSpec.readOnly,
              ttlSeconds: options.credentialTtlSeconds,
              logger,
            });
      const revokeOnce = onceRevoker(spec.runId, minted, logger);
      const carried: RunCredentialPayload | null =
        minted === null
          ? null
          : {
              host: project.gitHost,
              username: minted.username,
              password: minted.password,
              scope: minted.scope,
              expiresAt: minted.expiresAt,
            };
      if (carried !== null) {
        broker.hold({ runId: spec.runId, readOnly: workspaceSpec.readOnly, credential: carried });
      }
      let created: CreateRunResponse | null = null;
      try {
        created = await options.client.createRun({ spec: workspaceSpec, credential: carried });
        assertControlSocketUnderRoot(created.attachment.socketPath, options.controlRoot);
      } catch (error) {
        // A run that never started must not leave a live token behind (TD-028's WP-76 amendment,
        // decision 5): stop answering, give back a workspace the launcher did make, then revoke —
        // in that order, so the export helper of that end has nothing to push with afterwards.
        broker.forget(spec.runId);
        if (created !== null) {
          await releaseRun({
            client: options.client,
            handle: created.handle,
            ending: { kind: 'not_started' },
            logger,
          });
        }
        await revokeOnce();
        throw error;
      }
      const ready = created;
      logger.info(
        {
          run_id: spec.runId,
          project_id: spec.projectId,
          checkout: workspaceSpec.repo !== null,
          checkout_branch: workspaceSpec.repo?.checkoutBranch ?? null,
          read_only: workspaceSpec.readOnly,
          credential_scope: carried?.scope ?? null,
          launcher_credential_scope: ready.credentialScope,
          replayed: ready.replayed,
        },
        'the run workspace is provisioned through the launcher control plane',
      );
      return {
        workdir: ready.attachment.workdir,
        claudeCodePath: ready.claudeCodePath,
        spawn: createRunletSpawn({
          socketPath: ready.attachment.socketPath,
          token: ready.attachment.token,
          clock: options.clock,
          logger,
          // The agent's own `git push origin agentic/*` asks here (decision 4). Exact host, and
          // `null` once `release` has begun — the broker forgets before the end request is sent.
          // The frame carries `username` and `password` and nothing else (its schema is strict: a
          // `host` beside them fails the reply's validation and the shim drops the connection).
          credentials: async ({ host }) => {
            const answered = broker.answer(spec.runId, host);
            return answered === null
              ? null
              : { username: answered.username, password: answered.password };
          },
        }),
        release: async (ending: RunWorkspaceEnding) => {
          broker.forget(spec.runId);
          await releaseRun({
            client: options.client,
            handle: ready.handle,
            ending,
            logger,
          });
          // After `endRun` returns, on every ending: a take-over export pushes with the launcher's
          // copy first, and only then is the token destroyed.
          await revokeOnce();
        },
      };
    },
  };
};

/**
 * Asks the minter, and turns its answer into a credential or a refusal.
 *
 * `unavailable` refuses a **writing** run by name — the binding's own token is never sent instead
 * (decision 6) — and lets a read-only run proceed with no credential. A scope wider than the one
 * asked for is refused as a defect, after revoking what was minted.
 */
const mintFor = async (input: {
  readonly minter: RunGitCredentialMinter;
  readonly spec: RunSpec;
  readonly project: RunWorkspaceProject;
  readonly readOnly: boolean;
  readonly ttlSeconds: number;
  readonly logger: Logger;
}): Promise<MintedRunGitCredential | null> => {
  const scope: RunCredentialScope = input.readOnly ? 'read' : 'push';
  const answer = await input.minter.mint({
    spec: input.spec,
    project: input.project,
    scope,
    ttlSeconds: input.ttlSeconds,
  });
  if (answer.kind === 'unavailable') {
    if (!input.readOnly) {
      throw new WorkspaceError(
        'invalid_spec',
        `run ${input.spec.runId} writes to its checkout and no git credential can be minted for it: ${answer.reason}`,
        { runId: input.spec.runId },
      );
    }
    input.logger.warn(
      { run_id: input.spec.runId, reason: answer.reason },
      'a read-only run has no git credential and fetches anonymously; a private repository will fail at the mirror',
    );
    return null;
  }
  if (scope === 'read' && answer.credential.scope === 'push') {
    const revoked = await onceRevoker(input.spec.runId, answer.credential, input.logger)();
    throw new WorkspaceError(
      'invalid_spec',
      `run ${input.spec.runId} is read-only and was minted a push credential; the run is refused (BD-021) and ${
        revoked
          ? 'the credential was revoked'
          : `the credential's revocation failed, so it is live until the recovery pass revokes it or it expires at ${answer.credential.expiresAt}`
      }`,
      { runId: input.spec.runId },
    );
  }
  return answer.credential;
};

/**
 * `revoke`, at most once, never throwing — a failed revocation is logged as what it is: a live
 * token. Rule 20's second half: the failure must not be silent. Answers whether *this* call revoked
 * it, so a message can say so honestly.
 *
 * It still never retries, and that is now a division of labour rather than a gap (WP-77, PROGRESS
 * backlog 155): the failed attempt left a `revoke_credential` audit row that is not a success, so
 * the recovery pass (`packages/application/src/recovery/run-credential.ts`) finds the run once it is
 * terminal and revokes the token **once** from the mint row's `revoke_id`, through the executor and
 * outside any transaction. Until that pass runs — a pass interval after the run ends — the token is
 * live, and if that attempt fails too it is live until the provider's expiry.
 */
const onceRevoker = (
  runId: string,
  credential: MintedRunGitCredential | null,
  logger: Logger,
): (() => Promise<boolean>) => {
  let done = credential === null;
  return async () => {
    if (done || credential === null) {
      return false;
    }
    done = true;
    try {
      await credential.revoke();
      logger.info({ run_id: runId, scope: credential.scope }, 'the run credential is revoked');
      return true;
    } catch (error) {
      logger.error(
        { err: error, run_id: runId, scope: credential.scope, expires_at: credential.expiresAt },
        'the run credential could not be revoked here; unless the recovery pass has already revoked it (a cancelled run is reached that way, and a not_found here then means it is gone), it is live until that pass revokes it from its audit row, or until it expires if the pass cannot (PROGRESS backlog 155)',
      );
      return false;
    }
  };
};

/**
 * Gives the workspace back, on every one of `createWorkspaceClaudeRunner`'s eight endings.
 *
 * The take-over is the only ending that carries anything beyond the fact of it, and it is read off
 * the `ended` arm rather than from a flag: a run that never started has no tree to commit and a
 * crashed one is a fault rather than a hand-over (`RunWorkspaceEnding`'s own docblock).
 *
 * **It does not throw.** `createWorkspaceClaudeRunner` calls this in a `finally` and logs what it
 * catches, but a throw here would still replace nothing useful — the run's own outcome is what the
 * caller needs — while the container stop is the launcher's guarantee either way (`endRun` runs
 * `destroy` in a `finally`). What a failure must not be is *silent*, so it is logged with the run
 * id and the ending.
 */
const releaseRun = async (input: {
  readonly client: LauncherControlClient;
  readonly handle: WorkspaceHandle;
  readonly ending: RunWorkspaceEnding;
  readonly logger: Logger;
}): Promise<void> => {
  const takeOver = input.ending.kind === 'ended' ? (input.ending.takeOver ?? null) : null;
  try {
    const ended = await input.client.endRun(input.handle.runId, {
      handle: input.handle,
      export:
        takeOver === null
          ? null
          : {
              branch: takeOver.branch,
              commitMessage: takeOver.commitMessage,
              tarball: takeOver.tarball,
              keepUntil: takeOver.keepUntil,
            },
    });
    if (ended.failures.length > 0) {
      input.logger.warn(
        { run_id: input.handle.runId, failures: ended.failures },
        'the run ended with failures after its container was stopped',
      );
    }
  } catch (error) {
    input.logger.error(
      { err: error, run_id: input.handle.runId, ending: input.ending.kind },
      'the launcher could not be told that this run ended; its container may still be running',
    );
  }
};
