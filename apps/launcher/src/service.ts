/**
 * The launcher service (TD-021: `ROLE=launcher`, the only component that reaches the Docker
 * socket).
 *
 * It is the thin thing on top of `WorkspaceProvider` that owns a run's **whole** life: mirror,
 * credential (held, never minted — WP-76), workspace, attachment, export, teardown, and the
 * retention sweep that runs on a timer between runs. The provider knows how to make a container; this knows the order
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
 * So `destroy` runs in a `finally`, the credential is forgotten before it (the runner revokes it at
 * the provider once this returns — TD-028's WP-76 amendment, decision 5), and the
 * export's failure is reported *after* both. `service.test.ts` drives each of those failures and
 * asserts the container was stopped anyway.
 *
 * ## The network transport is beside this file, not in it (WP-53)
 *
 * This paragraph used to read *"what is deliberately not here: a network transport … there is no
 * second process to talk to until WP-22 has a compose file"*. WP-22 shipped that file and TD-028
 * decided the transport, so `control-plane.ts` is now the HTTP surface in front of **this** object:
 * five verbs on a run id, authenticated on every request, idempotent on the run id.
 *
 * What is still deliberately not here is any knowledge of it. This class takes a
 * `WorkspaceProvider` and a broker and knows nothing about a listener, which is what keeps Q52's
 * *other* answer — the in-process composition of `scripts/runlet-launcher-inner.mjs`, and TD-028
 * decision 1's "the in-process composition remains valid for the single-process developer mode" —
 * a composition rather than a second implementation.
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
import { WorkspaceError } from '@platform/application';
import type { workspace } from '@platform/infrastructure';

/**
 * The run's git credential as the create request carried it — minted by the **runner** through
 * `IntegrationActionExecutor` (TD-028's WP-76 amendment). This service mints nothing and revokes
 * nothing at the provider: it holds the value in the broker for the mirror fetch and the take-over
 * export push, and forgets it when the run ends.
 */
export type RunCredential = workspace.CarriedRunCredential;

export interface StartedRun {
  readonly handle: WorkspaceHandle;
  readonly attachment: WorkspaceAttachment;
  /**
   * What the broker holds for this run: `null` for a run with no checkout, or a read-only run that
   * fetches anonymously. A read-only run that holds one holds a `read` credential (BD-021).
   */
  readonly credential: WorkspaceGitCredential | null;
  readonly credentialScope: workspace.RunCredentialScope | null;
}

export interface EndRunRequest {
  /** Take-over export, or `null` for an ordinary end of run. */
  readonly export:
    | (Omit<WorkspaceExportRequest, 'tarballPath'> & {
        /** `true` writes a tarball under the launcher's export directory. */
        readonly tarball: boolean;
        /**
         * How long the workspace volume is kept (technical/05 §5, WP-27).
         *
         * Absent leaves the three days `buildWorkspaceSpec` wrote at create time. A take-over sets
         * fourteen, because the volume now holds work a **person** is coming back to — which is the
         * fact create time could not know, and the reason the extension is a separate operation
         * rather than a longer default.
         */
        readonly keepUntil?: string;
      })
    | null;
}

export interface EndedRun {
  readonly exported: WorkspaceExport | null;
  /** The retention window this run's volume ended up with, when the request asked for one. */
  readonly keepUntil: string | null;
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
   * Holds the run's credential, updates the mirror, creates the workspace and attaches.
   *
   * The credential comes first because the mirror fetch uses it — a private remote cannot be
   * mirrored anonymously (backlog 133 (2)) — and the mirror before the workspace because the clone
   * reads from it with no network of its own.
   *
   * **A spec with no repository skips both** (WP-74): no mirror fetch, nothing to push, and a
   * credential beside it is refused rather than held. A **writing** spec with no credential is
   * refused too (TD-028's WP-76 amendment, decision 3): the runner refuses such a run before it
   * asks, so one arriving here is a caller that forgot, and running it would fail at the push.
   */
  async startRun(spec: WorkspaceSpec, credential: RunCredential | null): Promise<StartedRun> {
    const { provider, broker, logger } = this.#options;
    if (spec.repo === null && credential !== null) {
      throw new WorkspaceError(
        'invalid_spec',
        'a spec with no repository carries no credential: nothing will fetch or push',
        { runId: spec.runId },
      );
    }
    if (spec.repo !== null && !spec.readOnly && credential === null) {
      throw new WorkspaceError(
        'invalid_spec',
        'a spec that writes must carry a run credential (TD-028, WP-76 amendment decision 3)',
        { runId: spec.runId },
      );
    }
    // `hold` refuses a push credential on a read-only spec and a blank one (BD-021, rule 18).
    const held =
      credential === null
        ? null
        : broker.hold({ runId: spec.runId, readOnly: spec.readOnly, credential });
    // The handle lives outside the `try` because a step *after* `create` can fail with the
    // container already up: `attach` reads the control volume and throws `not_found` on a
    // mis-mounted one, and it builds a socket path that a long control root makes too long for
    // `sockaddr_un` (`names.ts` § MAX_UNIX_SOCKET_PATH). Then this local is the only reference to
    // a running agent anywhere in the process.
    let handle: WorkspaceHandle | null = null;
    try {
      if (spec.repo !== null) {
        await provider.updateMirror({
          projectId: spec.projectId,
          repo: spec.repo,
          credential: held,
        });
      }
      handle = await provider.create(spec);
      const attachment = await provider.attach(handle);
      logger.info(
        {
          run_id: spec.runId,
          project_id: spec.projectId,
          credential_scope: credential?.scope ?? null,
        },
        'workspace started',
      );
      return { handle, attachment, credential: held, credentialScope: credential?.scope ?? null };
    } catch (error) {
      // Forgotten here; **revoked by the runner**, which sees this create fail and owns the
      // credential it minted (decision 5). The launcher can no longer hand it to anything.
      broker.forget(spec.runId);
      if (handle !== null) {
        await this.#destroyQuietly(handle);
      }
      throw error;
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
   * Ends a run: optional export, then the retention window, then forget the credential, then stop
   * and remove — in that order, and the last two happen whatever the first two do.
   *
   * **The retention extension is attempted even when the export failed**, and that is the whole
   * reason it is a step of its own rather than part of the export. The two failures are different
   * facts: an export that could not push has left the work in the workspace volume and *nowhere
   * else*, which is precisely when purging it on day 4 destroys the only copy. So a failed export
   * makes the longer window more necessary, not less (standing rule 60's direction: fix the sweep,
   * never the retention rule).
   */
  async endRun(handle: WorkspaceHandle, request: EndRunRequest): Promise<EndedRun> {
    const { provider, broker, logger } = this.#options;
    const failures: string[] = [];
    let exported: WorkspaceExport | null = null;
    let keepUntil: string | null = null;
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
      const requested = request.export?.keepUntil;
      if (requested !== undefined) {
        try {
          keepUntil = (await provider.extendRetention(handle, requested)).keepUntil;
        } catch (error) {
          failures.push(`retention: ${describe(error)}`);
          logger.warn(
            { run_id: handle.runId, keep_until: requested },
            'the taken-over workspace could not be held past its own retention window; it will be purged on the ordinary schedule',
          );
        }
      }
      // Forgotten, not revoked: the runner revokes after this returns (decision 5), so the export
      // above has already pushed with it and nothing after this line can.
      broker.forget(handle.runId);
      // The container stop is the guarantee. Nothing above may skip it.
      await provider.destroy(handle);
    }
    return { exported, keepUntil, failures };
  }

  /** One retention pass. */
  async sweep(now: Date = new Date(this.#options.clock.now())): Promise<PurgeReport> {
    const report = await this.#options.provider.purgeExpired(now);
    const directories = report.controlDirectories;
    this.#options.logger.info(
      {
        examined: report.examined,
        removed: report.removed,
        // The control-directory half (PROGRESS backlog **0b**) reaches the summary line too, and
        // separately: an operator counting workspaces must not count a control directory as one,
        // and `reclaimed` and `unreclaimed` are the two facts worth waking up for — the second is
        // an orphaned run token that is still readable. It was absent from this line until WP-53's
        // review, which made the sweep's most security-relevant half visible only at `warn`.
        control_directories: directories.length,
        control_directories_reclaimed: directories.filter((entry) => entry.removed).length,
        control_directories_unreclaimed: directories.filter(
          (entry) => entry.keptReason === 'remove_failed',
        ).length,
      },
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
