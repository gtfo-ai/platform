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
 *   scope the spec asks — `push` for a writing run, `read` otherwise — and only a `minted` one
 *   travels: a static run token or a deploy key is WP-282's opt-in, and the claim's eligibility
 *   already keeps such a project off a worker, so one met here (a binding changed between the claim
 *   and the mint) is answered `credential_unavailable` and the claim is released;
 * - the package is validated by `runPackageSchema` — its refinements (one run, no credential in an
 *   environment, the 4 MiB bound) are the last word — and refused, never cut.
 *
 * **Endings.** A provider error while minting is `credential_unavailable` (the caller releases the
 * claim). A writing run whose binding can mint nothing, a skill this deployment does not ship, a
 * scope wider than asked and a package the schema refuses are terminal `invalid_spec`
 * `WorkspaceError`s (the caller settles the run `not_started`). Whatever was minted is revoked before
 * a refusal is thrown, so a refused package leaves no live token behind.
 */
import type {
  RemotePackageAnswer,
  RemoteRunPackager,
  RunnerClock,
  WorkspaceErrorReason,
} from '@platform/application';
import { type Logger, silentLogger, WorkspaceError } from '@platform/application';
import { type RunCredentialPayload, runPackageSchema } from '@platform/contracts';
import { type PlatformSkillCatalogue, runSkillsFor } from '../workspace/skills.js';
import {
  type MintedRunGitCredential,
  type RunGitCredentialMinter,
  type RunWorkspaceProjectSource,
  runWorkspaceSpecFor,
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
          return {
            kind: 'credential_unavailable',
            detail: error instanceof Error ? error.message : String(error),
          };
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
          if ((minted.source ?? 'minted') !== 'minted') {
            await revokeQuietly(spec.runId, minted);
            return {
              kind: 'credential_unavailable',
              detail: `the project's run credential is ${minted.source}, which reaches a remote worker only behind remote_run_credential: allow (TD-031 decision 5, WP-282)`,
            };
          }
          if (scope === 'read' && minted.scope === 'push') {
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
        minted === null
          ? null
          : {
              host: project.gitHost,
              username: minted.username,
              password: minted.password,
              scope: minted.scope,
              expiresAt: minted.expiresAt,
              source: 'minted',
            };
      const parsed = runPackageSchema.safeParse({
        runId: spec.runId,
        epoch: input.epoch,
        runToken: input.runToken,
        run: { ...spec, secretEnvNames: [] },
        workspace,
        credential,
        skills,
        images: { run: input.images.run, egress: input.images.egress },
        limits: { leaseTtlMs: input.leaseTtlMs },
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
