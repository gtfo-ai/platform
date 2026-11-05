/**
 * **A claimed run's workspace, from its package** — WP-283 (1), TD-031 decision 4 and its
 * 2026-11-04 amendment (backlog 693).
 *
 * The core decided everything a run's workspace is (`RunPackage.workspace`, `skills`, `images`,
 * `credential`); the worker only asks its own launcher for it, over the same control plane the
 * server's runner uses (TD-028), and never re-plans a byte. What the worker adds is exactly the
 * three things only it can do, because it holds the run token and the core does not reach its
 * machine:
 *
 *  - **the run's `cred.get`** (an HTTPS run): answered from the package's credential, through the
 *    same {@link workspaceAdapters.RunCredentialBroker} the server's provisioner holds (exact host,
 *    the project's repository path only, `null` once the release begins);
 *  - **the run container's `ssh.sign` frames** (a deploy-key run): forwarded to the core's
 *    `POST runs/:id/ssh-sign` — the key never leaves the core (TD-031 decision 5);
 *  - **the helper agent socket** (a deploy-key run, the `relayed` carriage): served on the `ctl`
 *    volume beside the run's control directory **before** the create, because the launcher's mirror
 *    fetch runs inside the create, and closed after the release — after the export, which signs
 *    through it too (amendment §4: every export before `finish`).
 *
 * A create request never carries a deploy key: the package has none (`signed_by_core`), and the
 * worker's launcher parses with `relayed` (`relayedCreateRunRequestSchema`) and would refuse one.
 */
import type { Logger, RunnerClock, RunSpec } from '@platform/application';
import { silentLogger, WorkspaceError } from '@platform/application';
import type { RunPackage } from '@platform/contracts';
import {
  launcher as launcherAdapters,
  runlet as runletAdapters,
  type runner as runnerAdapters,
  workspace as workspaceAdapters,
} from '@platform/infrastructure';

/** The helper agent socket of one run: a directory beside its control directory, never in it. */
export const helperAgentSocketOf = (runId: string): string => `helper-${runId}/agent.sock`;

/** A signature request as the runlet frame and the helper agent both carry it. */
export interface SshSignRequest {
  readonly keyBlob: Buffer;
  readonly data: Buffer;
  readonly flags: number;
}

export interface PackageWorkspaceOptions {
  readonly launcher: launcherAdapters.LauncherControlClient;
  /** `APP_WORKSPACE_CONTROL_ROOT` as this process mounts the `ctl` volume. */
  readonly controlRoot: string;
  readonly clock: RunnerClock;
  /** Forwards one signature to the core (`POST runs/:id/ssh-sign`); `null` is a refusal. */
  readonly sshSign: (request: SshSignRequest) => Promise<Buffer | null>;
  /** `projects.repo_url` → the repository path `cred.get` is answered for (backlog 481). */
  readonly repositoryPathOf: (repoUrl: string) => string;
  /**
   * `false` once the run is lost (a `lease_lost`, a `401`, self-termination): such a run exports
   * nothing — no saved work, no take-over branch (TD-031 §2). @default always allowed
   */
  readonly exportsAllowed?: () => boolean;
  /**
   * How the runner reaches the CLI in the created workspace — the run shim's socket by default.
   * The e2e tier's seam: its launcher is the fake provider, whose control socket has nothing
   * listening (its divergence 2), so it hands a scripted CLI here instead.
   */
  readonly spawnFor?: (input: {
    readonly pkg: RunPackage;
    readonly created: launcherAdapters.CreateRunResponse;
    readonly credentials: runletAdapters.RunletCredentialResponder;
    readonly sshSigner: runletAdapters.RunletSshSigner | undefined;
  }) =>
    | runnerAdapters.ProvisionedRunWorkspace['spawn']
    | Promise<runnerAdapters.ProvisionedRunWorkspace['spawn']>;
  readonly logger?: Logger;
}

/** The {@link runnerAdapters.RunWorkspaceProvisioner} of one claimed package. */
export const packageWorkspaceProvisioner = (
  pkg: RunPackage,
  options: PackageWorkspaceOptions,
): runnerAdapters.RunWorkspaceProvisioner => {
  const logger = options.logger ?? silentLogger;
  return {
    provision: async (spec: RunSpec) => {
      if (spec.runId !== pkg.runId) {
        throw new WorkspaceError('invalid_spec', 'a package provisions its own run only', {
          runId: spec.runId,
        });
      }
      const workspace = pkg.workspace;
      const ssh = workspace.repo?.ssh;
      const broker = new workspaceAdapters.RunCredentialBroker(logger);
      let released = false;
      let helper: runletAdapters.HelperAgent | null = null;
      const signer = async (request: SshSignRequest): Promise<Buffer | null> =>
        released ? null : options.sshSign(request);
      const closeHelper = async (): Promise<void> => {
        const open = helper;
        helper = null;
        if (open === null) return;
        logger.info(
          {
            run_id: pkg.runId,
            helper_signatures: open.signatures(),
            helper_refusals: open.refusals(),
          },
          'the run’s helper agent socket is closed',
        );
        await open.close().catch((error: unknown) => {
          logger.warn({ err: error, run_id: pkg.runId }, 'the helper agent socket was not removed');
        });
      };
      let created: launcherAdapters.CreateRunResponse | null = null;
      try {
        if (ssh !== undefined) {
          helper = await runletAdapters.serveHelperAgent({
            controlRoot: options.controlRoot,
            socket: helperAgentSocketOf(pkg.runId),
            publicKey: ssh.publicKey,
            // The helpers sign while the create runs, before any `release`: the export signs after
            // the run, inside the release, so the helper keeps signing until it is closed below.
            sign: (request) => options.sshSign(request),
            onRefusal: (why) =>
              logger.warn({ run_id: pkg.runId, reason: why }, 'the helper agent refused a request'),
          });
        }
        if (pkg.credential !== null && workspace.repo !== null && ssh === undefined) {
          broker.hold({
            runId: pkg.runId,
            readOnly: workspace.readOnly,
            credential: pkg.credential,
            repositoryPath: options.repositoryPathOf(workspace.repo.url),
          });
        }
        created = await options.launcher.createRun({
          spec: workspace,
          credential: pkg.credential,
          skills: pkg.skills,
          images: pkg.images,
          ...(ssh === undefined ? {} : { helperAgentSocket: helperAgentSocketOf(pkg.runId) }),
        });
        launcherAdapters.assertControlSocketUnderRoot(
          created.attachment.socketPath,
          options.controlRoot,
        );
      } catch (error) {
        broker.forget(pkg.runId);
        released = true;
        if (created !== null) {
          await options.launcher
            .endRun(pkg.runId, { handle: created.handle, export: null })
            .catch((endError: unknown) => {
              logger.error(
                { err: endError, run_id: pkg.runId },
                'a workspace whose create was refused afterwards could not be ended',
              );
            });
        }
        await closeHelper();
        throw error;
      }
      const ready = created;
      const credentials: runletAdapters.RunletCredentialResponder = async (question) => {
        const answered = broker.answer(pkg.runId, question);
        return answered === null
          ? null
          : { username: answered.username, password: answered.password };
      };
      const sshSigner = ssh === undefined ? undefined : signer;
      const spawn =
        (await options.spawnFor?.({ pkg, created: ready, credentials, sshSigner })) ??
        runletAdapters.createRunletSpawn({
          socketPath: ready.attachment.socketPath,
          token: ready.attachment.token,
          clock: options.clock,
          logger,
          credentials,
          ...(sshSigner === undefined ? {} : { sshSigner }),
        });
      logger.info(
        {
          run_id: pkg.runId,
          checkout: workspace.repo !== null,
          read_only: workspace.readOnly,
          credential_source: pkg.credential?.source ?? (ssh === undefined ? null : 'deploy_key'),
          relayed_helper: ssh !== undefined,
          replayed: ready.replayed,
        },
        'the run workspace is provisioned through this worker’s launcher',
      );
      return {
        workdir: ready.attachment.workdir,
        claudeCodePath: ready.claudeCodePath,
        existingProtectedPaths: ready.existingProtectedPaths,
        cliEnvironment: ready.cliEnvironment,
        spawn,
        release: async (ending) => {
          // The run container's own answers stop here; the helper signs on until the export below.
          released = true;
          broker.forget(pkg.runId);
          const exporting = options.exportsAllowed?.() ?? true;
          const takeOver = exporting && ending.kind === 'ended' ? (ending.takeOver ?? null) : null;
          const unfinished =
            exporting && takeOver === null && ending.kind === 'ended'
              ? (ending.unfinishedWork ?? null)
              : null;
          let savedWork: ReturnType<typeof launcherAdapters.savedWorkOf>;
          try {
            const ended = await options.launcher.endRun(pkg.runId, {
              handle: ready.handle,
              export:
                takeOver !== null
                  ? {
                      branch: takeOver.branch,
                      commitMessage: takeOver.commitMessage,
                      // TD-031 §14: a take-over of a remote run exports the branch and no tarball —
                      // there is no upload verb (backlog 688), so a tarball would stay on this
                      // machine where nobody who asked for it can download it.
                      tarball: false,
                      keepUntil: takeOver.keepUntil,
                    }
                  : unfinished !== null
                    ? {
                        branch: unfinished.branch,
                        commitMessage: unfinished.commitMessage,
                        tarball: false,
                        onlyIfChanged: true,
                      }
                    : null,
            });
            if (ended.failures.length > 0) {
              logger.warn(
                { run_id: pkg.runId, failures: ended.failures },
                'the run ended with failures after its container was stopped',
              );
            }
            savedWork =
              unfinished === null
                ? undefined
                : launcherAdapters.savedWorkOf(unfinished, ended.exported);
          } catch (error) {
            logger.error(
              { err: error, run_id: pkg.runId, ending: ending.kind },
              'this worker’s launcher could not be told that the run ended; its container may still be running',
            );
            savedWork =
              unfinished === null
                ? undefined
                : { branch: unfinished.branch, commit_sha: null, pushed: false };
          } finally {
            await closeHelper();
          }
          return savedWork === undefined ? undefined : { savedWork };
        },
      };
    },
  };
};
