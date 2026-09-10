/**
 * The launcher service (TD-021: `ROLE=launcher`, the only component that reaches the Docker
 * socket).
 *
 * It is the thin thing on top of `WorkspaceProvider` that owns a run's **whole** life: mirror,
 * credential, workspace, attachment, export, revocation, teardown, and the retention sweep that
 * runs on a timer between runs. The provider knows how to make a container; this knows the order
 * and what must happen even when a step fails.
 *
 * ## This is the layer that owns "a live container is always named by a handle"
 *
 * `DockerWorkspaceProvider` discharges that per call — `create` tears down what it made if a step
 * fails. It cannot discharge it for a *sequence* of calls, because between `create` returning and
 * the caller storing the handle the only reference to a running agent is a local variable in this
 * file. Round 1 proved the point: `attach` threw, the `catch` revoked the credential and rethrew,
 * and the container ran on with nothing able to name it (nothing reaps orphans — `purgeExpired`
 * removes volumes). So `startRun`'s failure path destroys the workspace it created, and
 * `service.test.ts` › "leaves nothing running whichever step fails, for every step it performs"
 * enumerates the steps rather than naming one.
 *
 * ## `endRun` is where WP-13's third obligation is discharged at the service level
 *
 * `docker stop`/`rm` on **every** path that ends a run. The export can fail — the git host can be
 * down, the branch can be rejected, the archive can be too big — and none of that may leave the
 * run container up: the shim signals one pid, so a detached grandchild outlives it, and only the
 * container's pid namespace ending takes it with it (`docs/research/12-run-shim-verification.md`).
 * So `destroy` runs in a `finally`, the credential is revoked in a `finally` of its own, and the
 * export's failure is reported *after* both. `service.test.ts` drives each of those failures and
 * asserts the container was stopped anyway.
 *
 * ## What is deliberately not here
 *
 * A network transport. TD-021 deploys this as its own container, which implies an RPC surface
 * between the runner and the launcher, and there is no second process to talk to until WP-22 has
 * a compose file — building an unexercised, security-critical HTTP surface now would be code
 * whose only test is the one written beside it. Filed as **Q52** with a recommendation; the
 * service is a plain object so either deployment can compose it.
 */
import path from 'node:path';
import type {
  Logger,
  PurgeReport,
  RunnerClock,
  WorkspaceAttachment,
  WorkspaceExport,
  WorkspaceExportRequest,
  WorkspaceGitCredential,
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceSpec,
} from '@platform/application';
import type { workspace } from '@platform/infrastructure';

/** What the run needs from the git provider, beyond the spec. */
export interface RunCredentialRequest {
  /** The provider's project handle (`acme/web`), not the platform's project id. */
  readonly project: string;
  /** The git host the workspace may ask for a credential for. Lowercase, no port. */
  readonly host: string;
  /** BD-025's namespace. */
  readonly branchPatterns: readonly string[];
  /** TD-021: "expires next day". */
  readonly ttlSeconds: number;
}

export interface StartedRun {
  readonly handle: WorkspaceHandle;
  readonly attachment: WorkspaceAttachment;
  /** `null` for a read-only stage, which gets no git write token at all (BD-021). */
  readonly credential: WorkspaceGitCredential | null;
}

export interface EndRunRequest {
  /** Take-over export, or `null` for an ordinary end of run. */
  readonly export:
    | (Omit<WorkspaceExportRequest, 'tarballPath'> & {
        /** `true` writes a tarball under the launcher's export directory. */
        readonly tarball: boolean;
      })
    | null;
}

export interface EndedRun {
  readonly exported: WorkspaceExport | null;
  /** What went wrong on the way, after the container was already stopped. */
  readonly failures: readonly string[];
}

export interface LauncherServiceOptions {
  readonly provider: WorkspaceProvider;
  readonly broker: workspace.RunCredentialBroker;
  readonly clock: RunnerClock;
  readonly logger: Logger;
  /** Where export tarballs are written. Absolute, on the launcher's own filesystem. */
  readonly exportDir: string;
  readonly retentionSweepMs: number;
}

export class LauncherService {
  readonly #options: LauncherServiceOptions;
  #cancelSweep: (() => void) | null = null;
  #sweeping = false;

  constructor(options: LauncherServiceOptions) {
    this.#options = options;
  }

  /**
   * Updates the mirror, mints the run's credential, creates the workspace and attaches.
   *
   * The mirror comes first because the clone reads from it with no network of its own; the
   * credential comes before the workspace because a run that cannot get one should not have a
   * container.
   */
  async startRun(spec: WorkspaceSpec, credential: RunCredentialRequest): Promise<StartedRun> {
    const { provider, broker, logger } = this.#options;
    const issued = await broker.issue({
      runId: spec.runId,
      project: credential.project,
      host: credential.host,
      readOnly: spec.readOnly,
      branchPatterns: credential.branchPatterns,
      ttlSeconds: credential.ttlSeconds,
    });
    // The handle lives outside the `try` because a step *after* `create` can fail with the
    // container already up: `attach` reads the control volume and throws `not_found` on a
    // mis-mounted one, and it builds a socket path that a long control root makes too long for
    // `sockaddr_un` (`names.ts` § MAX_UNIX_SOCKET_PATH). Then this local is the only reference to
    // a running agent anywhere in the process.
    let handle: WorkspaceHandle | null = null;
    try {
      await provider.updateMirror({
        projectId: spec.projectId,
        repo: spec.repo,
        credential: issued,
      });
      handle = await provider.create(spec);
      const attachment = await provider.attach(handle);
      logger.info({ run_id: spec.runId, project_id: spec.projectId }, 'workspace started');
      return { handle, attachment, credential: issued };
    } catch (error) {
      // A run that never started must not leave a live push token behind: the credential outlives
      // the failure by a day otherwise (TD-021 mints it with `expires_at` tomorrow).
      await this.#revokeQuietly(spec.runId);
      if (handle !== null) {
        await this.#destroyQuietly(handle);
      }
      throw error;
    }
  }

  /**
   * Revocation on the failed-start path, which must not become the failure the caller sees — and
   * must not be silent either.
   *
   * Both halves matter and only the first was here: `.catch(() => undefined)` kept the original
   * error, and threw away the only signal that a **run-scoped git push token is still live**. The
   * run is dead, nothing will revoke it again (`endRun` needs a handle this path never returns),
   * and the token stands until `ttlSeconds` expires it — a day, by TD-021's default. Its two
   * neighbours on this path, `#destroyQuietly` and `endRun`'s `revoke`, both log; this now matches
   * them.
   */
  async #revokeQuietly(runId: string): Promise<void> {
    try {
      await this.#options.broker.revoke(runId);
    } catch (error) {
      this.#options.logger.warn(
        { run_id: runId, error: describe(error) },
        'the credential of a failed start could not be revoked; a push token is live until it expires',
      );
    }
  }

  /**
   * Teardown on a failure path, which must not become the failure the caller sees.
   *
   * `provider.destroy` already tolerates every "no such thing" and logs its own partial failures;
   * what this adds is that a destroy which throws anyway — an unreachable daemon — cannot replace
   * the error that made the start fail, because the cause a launcher reports for a failed start is
   * the only thing an operator has.
   */
  async #destroyQuietly(handle: WorkspaceHandle): Promise<void> {
    try {
      await this.#options.provider.destroy(handle);
    } catch (error) {
      this.#options.logger.warn(
        { run_id: handle.runId, error: describe(error) },
        'the workspace of a failed start could not be destroyed; a container may be running',
      );
    }
  }

  /**
   * Ends a run: optional export, then revoke, then stop and remove — in that order, and the last
   * two happen whatever the first does.
   */
  async endRun(handle: WorkspaceHandle, request: EndRunRequest): Promise<EndedRun> {
    const { provider, broker, logger } = this.#options;
    const failures: string[] = [];
    let exported: WorkspaceExport | null = null;
    try {
      if (request.export !== null) {
        exported = await provider.export(
          handle,
          {
            branch: request.export.branch,
            commitMessage: request.export.commitMessage,
            tarballPath: request.export.tarball
              ? path.join(this.#options.exportDir, `${handle.runId}.tar`)
              : null,
          },
          broker.credentialFor(handle.runId),
        );
      }
    } catch (error) {
      failures.push(`export: ${describe(error)}`);
      logger.warn({ run_id: handle.runId }, 'workspace export failed; ending the run anyway');
    } finally {
      try {
        await broker.revoke(handle.runId);
      } catch (error) {
        failures.push(`revoke: ${describe(error)}`);
        logger.warn({ run_id: handle.runId }, 'run credential could not be revoked');
      }
      // The container stop is the guarantee. Nothing above may skip it.
      await provider.destroy(handle);
    }
    return { exported, failures };
  }

  /** One retention pass. */
  async sweep(now: Date = new Date(this.#options.clock.now())): Promise<PurgeReport> {
    const report = await this.#options.provider.purgeExpired(now);
    this.#options.logger.info(
      { examined: report.examined, removed: report.removed },
      'workspace retention sweep',
    );
    return report;
  }

  /**
   * Arms the retention sweep on the injected clock.
   *
   * On the clock, not on `setInterval`, because a test must be able to make a day pass; and it
   * re-arms after each pass rather than on a fixed interval, so a sweep that takes longer than the
   * period cannot stack up on itself.
   */
  startRetentionSweep(): void {
    if (this.#cancelSweep !== null) {
      return;
    }
    const arm = (): void => {
      this.#cancelSweep = this.#options.clock.setTimer(this.#options.retentionSweepMs, () => {
        void this.#runSweep().finally(() => {
          if (this.#cancelSweep !== null) {
            arm();
          }
        });
      });
    };
    arm();
  }

  async #runSweep(): Promise<void> {
    if (this.#sweeping) {
      return;
    }
    this.#sweeping = true;
    try {
      await this.sweep();
    } catch (error) {
      this.#options.logger.warn({ error: describe(error) }, 'retention sweep failed');
    } finally {
      this.#sweeping = false;
    }
  }

  stop(): void {
    this.#cancelSweep?.();
    this.#cancelSweep = null;
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
