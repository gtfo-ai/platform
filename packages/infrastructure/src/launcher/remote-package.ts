/**
 * **A remote run's package** — the core's half of TD-031 decision 4 (WP-281).
 *
 * The server's claimant hands its launcher a create request built by `provisioner.ts`; a remote
 * worker's launcher is handed the same pieces by the worker, from the **run package** the core
 * answers its claim with. This module builds that package from the same functions the provisioner
 * builds a create from — {@link runWorkspaceSpecFor} (the `WorkspaceSpec`), `runSkillsFor` (the
 * skills' content and the digest), the {@link RunGitCredentialMinter} — so a run's isolation is
 * decided by one mapping whichever claimant runs it:
 *
 * - `run` is the **stored** spec (`storedRunSpecSchema`: every secret value already absent) with
 *   `secretEnvNames` emptied — the core never puts a secret value, or the name of one, in a package;
 *   the worker adds its own model credential locally (TD-031 §4);
 * - the credential is **minted after the claim committed** (the caller's ordering) for exactly the
 *   scope the spec asks — `push` for a writing run, `read` otherwise. A `minted` one travels. A
 *   **static** run token or a **deploy key** reaches a worker only behind the git integration's
 *   `remote_run_credential: allow` (WP-282, TD-031 decision 5, Q124 (a)), re-read here because the
 *   claim's eligibility read it in another transaction: with `allow`, a static token travels as the
 *   package's credential (`source: 'static'`), and a deploy key **never does** — the package carries
 *   no credential, the spec carries the SSH route and the public key (`withGitSsh`), and the worker
 *   signs through `ssh-sign` (TD-031's 2026-11-04 amendment); with `deny` (a binding changed between
 *   the claim and the mint) it is a **retryable** start failure: the re-planned offer's eligibility
 *   then answers who may claim it (TD-031's 2026-11-05 amendment, item 2);
 * - the package is validated by `runPackageSchema` — its refinements (one run, no credential in an
 *   environment, the 4 MiB bound) are the last word — and refused, never cut.
 *
 * **Endings — every one a start failure the caller settles `not_started`, never a release** (TD-031's
 * 2026-11-05 amendment, backlog 740). A mint that throws is a `RunStartError` diagnosed
 * `run_credential_unavailable` whose `retryable` is the mint error's own (`isRetryableMintFailure`:
 * an `IntegrationError` that is `rate_limited` or `unavailable`), so Q59(a)'s bound spaces and ends
 * it. A writing run whose binding can mint nothing, a skill this deployment does not ship, a scope
 * wider than asked and a package the schema refuses are terminal `invalid_spec` `WorkspaceError`s.
 * Whatever was minted is revoked before a refusal is thrown, so a refused package leaves no live
 * token behind.
 */
import type {
  RemotePackageAnswer,
  RemoteRunPackager,
  RunnerClock,
  WorkspaceErrorReason,
} from '@platform/application';
import {
  isRetryableMintFailure,
  type Logger,
  RUN_CREDENTIAL_UNAVAILABLE_DIAGNOSIS,
  RunStartError,
  silentLogger,
  WorkspaceError,
} from '@platform/application';
import {
  type RunCredentialPayload,
  type RunDisplay,
  type RunSpec,
  runPackageSchema,
} from '@platform/contracts';
import { type PlatformSkillCatalogue, runSkillsFor } from '../workspace/skills.js';
import {
  gitSshOf,
  type MintedRunGitCredential,
  type RunGitCredentialMinter,
  type RunWorkspaceProjectSource,
  runWorkspaceSpecFor,
  withGitSsh,
} from './provisioner.js';

export interface RemoteRunPackagerOptions {
  readonly projects: RunWorkspaceProjectSource;
  readonly credentials: RunGitCredentialMinter;
  /** The skills this deployment ships (`PLATFORM_SKILLS`) — the bytes the planner digested. */
  readonly skills: PlatformSkillCatalogue;
  /** `APP_MODEL_EGRESS_HOSTS`: the hosts the run reaches besides its git host (the provisioner's). */
  readonly modelEgressHosts: readonly string[];
  /** `APP_RUN_REGISTRY_HOSTS` (WP-82): only a run that may install from a lockfile gets them. */
  readonly runRegistryHosts: readonly string[];
  readonly credentialTtlSeconds: number;
  readonly clock: RunnerClock;
  /**
   * The project's git integration `remote_run_credential` (WP-282, Q124 (a)), read at packaging:
   * `allow` lets a static token or a deploy key reach a remote worker. Required — an absent opt-in
   * check is an open one (standing rule 31).
   */
  readonly remoteRunCredential: (spec: RunSpec) => Promise<'allow' | 'deny'>;
  /**
   * The worker's local page's names for the run — the project's key, the ticket's key and title from
   * the **redacted** ticket snapshot (WP-292). Absent or `null`: the package carries no `display`
   * block, and the page names the run by its ids. The claims route strips the block for a
   * version-1 worker.
   */
  readonly display?: (spec: RunSpec) => Promise<RunDisplay | null>;
  readonly logger?: Logger;
}

const refusal = (runId: string, message: string, reason: WorkspaceErrorReason): WorkspaceError =>
  new WorkspaceError('invalid_spec', `run ${runId}'s package is refused: ${message}`, {
    runId,
    reason,
  });

export const createRemoteRunPackager = (options: RemoteRunPackagerOptions): RemoteRunPackager => {
  const logger = options.logger ?? silentLogger;

  /** Revokes what was minted, once, never throwing (the provisioner's `onceRevoker` rule). */
  const revokeQuietly = async (runId: string, minted: MintedRunGitCredential): Promise<void> => {
    try {
      await minted.revoke();
    } catch (error) {
      logger.error(
        { err: error, run_id: runId, scope: minted.scope, expires_at: minted.expiresAt },
        'a refused remote package’s credential could not be revoked here; the recovery pass reaches it once the run has ended, or it expires (PROGRESS backlog 155)',
      );
    }
  };

  return {
    build: async (input): Promise<RemotePackageAnswer> => {
      const spec = input.spec;
      const project = await options.projects.forRun(spec);
      const workspace = runWorkspaceSpecFor({
        spec,
        project,
        modelEgressHosts: options.modelEgressHosts,
        runRegistryHosts: options.runRegistryHosts,
        now: new Date(options.clock.now()),
      });
      // What the launcher writes is decided before a credential exists, so its refusal revokes nothing.
      const skills = runSkillsFor(spec.runId, workspace.skills, options.skills);
      let minted: MintedRunGitCredential | null = null;
      /** A deploy key's route and public key go on the spec; the key itself stays here (WP-282). */
      let packagedWorkspace = workspace;
      if (workspace.repo !== null) {
        const scope = workspace.readOnly ? 'read' : 'push';
        let answer: Awaited<ReturnType<RunGitCredentialMinter['mint']>>;
        try {
          answer = await options.credentials.mint({
            spec,
            project,
            scope,
            ttlSeconds: options.credentialTtlSeconds,
          });
        } catch (error) {
          if (error instanceof WorkspaceError) {
            throw error;
          }
          throw new RunStartError(
            `run ${spec.runId}'s git credential could not be minted after its claim`,
            {
              retryable: isRetryableMintFailure(error),
              cause: error,
              diagnosis: RUN_CREDENTIAL_UNAVAILABLE_DIAGNOSIS,
            },
          );
        }
        if (answer.kind === 'unavailable') {
          if (!workspace.readOnly) {
            throw refusal(
              spec.runId,
              `it writes to its checkout and no git credential can be given to it: ${answer.reason}`,
              'run_credential_unavailable',
            );
          }
          logger.warn(
            { run_id: spec.runId, reason: answer.reason },
            'a read-only remote run has no git credential and fetches anonymously',
          );
        } else {
          minted = answer.credential;
          const source = minted.source ?? 'minted';
          if (source !== 'minted' && (await options.remoteRunCredential(spec)) !== 'allow') {
            await revokeQuietly(spec.runId, minted);
            // The binding changed between the claim and the mint: retryable, so the re-planned
            // offer's eligibility answers who may claim it (TD-031's 2026-11-05 amendment, item 2).
            throw new RunStartError(
              `run ${spec.runId}'s project now gives a ${source} run credential, which reaches a remote worker only behind remote_run_credential: allow (TD-031 decision 5, WP-282)`,
              { retryable: true, diagnosis: RUN_CREDENTIAL_UNAVAILABLE_DIAGNOSIS },
            );
          }
          if (source === 'deploy_key') {
            // TD-031 decision 5: the key never leaves the core. Its route and public key go on the
            // spec, the package carries no credential, and the worker forwards every signature to
            // `ssh-sign`. Nothing is revoked: removing the key from the project is its revocation.
            packagedWorkspace = withGitSsh(workspace, gitSshOf(minted));
          } else if (source === 'minted' && scope === 'read' && minted.scope === 'push') {
            await revokeQuietly(spec.runId, minted);
            throw refusal(
              spec.runId,
              'it is read-only and was minted a push credential (BD-021)',
              'run_credential_scope_mismatch',
            );
          }
        }
      }
      const credential: RunCredentialPayload | null =
        minted === null || minted.source === 'deploy_key'
          ? null
          : {
              host: project.gitHost,
              username: minted.username,
              password: minted.password,
              scope: minted.scope,
              expiresAt: minted.expiresAt,
              source: minted.source ?? 'minted',
            };
      // A display read that fails costs the page its names, never the run (WP-292).
      const display = await (options.display?.(spec) ?? Promise.resolve(null)).catch(
        (error: unknown) => {
          logger.warn(
            { err: error, run_id: spec.runId },
            'the run’s display names could not be read; the package carries none',
          );
          return null;
        },
      );
      const parsed = runPackageSchema.safeParse({
        runId: spec.runId,
        epoch: input.epoch,
        runToken: input.runToken,
        run: { ...spec, secretEnvNames: [] },
        workspace: packagedWorkspace,
        credential,
        skills,
        images: { run: input.images.run, egress: input.images.egress },
        limits: { leaseTtlMs: input.leaseTtlMs },
        ...(display === null ? {} : { display }),
      });
      if (!parsed.success) {
        if (minted !== null) {
          await revokeQuietly(spec.runId, minted);
        }
        // The issues' messages and paths only — never the input, which holds the credential.
        throw refusal(
          spec.runId,
          parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(package)'}: ${issue.message}`)
            .join('; '),
          'run_package_refused',
        );
      }
      return { kind: 'package', package: parsed.data };
    },
  };
};
