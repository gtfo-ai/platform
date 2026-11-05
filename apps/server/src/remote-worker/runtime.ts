/**
 * **`ROLE=remote-worker`** — WP-283, TD-031 decisions 4 and 7–14, BD-032 decisions 1–2.
 *
 * The same image as the core, composed as the thinnest thing that can run an agent run on a
 * developer's machine: **no database, no `APP_SECRET_KEY`, no integration secret** (startup refuses
 * the first two by name — `config.ts`), and nothing of the pipeline. What it composes:
 *
 *  - the **device login** and the credential file on the `worker-state` volume (`credential.ts`);
 *  - the **handshake** — the protocol range, the core's digests, this worker's settings;
 *  - the **claim loop** — `POST claims` held ≤ 25 s, re-issued at once while a slot is free
 *    (`APP_WORKER_CONCURRENCY`, default 1), each package run by a {@link startRunSession} over the
 *    server's own runner (`createWorkspaceClaudeRunner` over `createClaudeRunner`) and this worker's
 *    launcher;
 *  - a **local listener** on the worker's compose network only (never published): `GET /healthz`,
 *    `GET /readyz` (`core_handshake`), `POST /internal/drain` (stop claiming, finish what runs —
 *    what the updater asks before it applies, TD-032 decision 6) and `GET /internal/state`;
 *  - **the local page** (WP-292, `local-ui.ts`): a second listener on container port 7357, published
 *    on `127.0.0.1` only, behind a token kept in `worker-state` (`ui-token.ts`) — state, slots, each
 *    run with its transcript tail, the log tail, and *Pause/Resume*, *Drain* and *Cancel run*.
 *
 * ## Pause, drain and cancel — the core decides each (TD-031's worker-UI amendment §4)
 *
 * *Pause* asks the core's `manual-pause` and, once it answered, claims nothing; *Resume* the
 * reverse. *Drain* is the same hold plus a marker file (`drain-pause`) in `worker-state`: the worker
 * finishes what runs and takes nothing new, and **its next start clears a drain's pause — only a
 * drain's**; an owner's *Pause* survives a restart. `POST /internal/drain` (the updater's) is the
 * same function. A drained worker **stays up, idle**, rather than exiting: `compose.worker.yml`
 * restarts it `unless-stopped`, so an exit would be a restart, and the restart would clear the
 * drain's pause and claim again — stopping is the person's `docker compose stop` (stated in the PR
 * and BACKLOG). *Cancel run* is the core's `run.cancel` (`runs/:id/cancel`), whose stop this
 * worker's own heartbeat delivers; the task is paused (Q126).
 *
 * A `401` on a worker verb is a revoked worker or user (TD-031 §7): it stops claiming and says so on
 * `/readyz`. A `426` is a core that no longer serves this protocol: it stops claiming and finishes
 * nothing it has not started (TD-032 §5). Every other failure is retried with jitter, forever — the
 * core may be deploying (TD-031 §9), and a run in flight outlives that on its 10-minute lease.
 *
 * **Logs are redacted by exact value** before they leave the process: the Claude token, the worker
 * credential and every live run's token and run credential are replaced in each line (TD-031 §10a —
 * the worker's own redactor is the only one that knows them).
 */
import { rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { Logger } from '@platform/application';
import { DEFAULT_USAGE_PAUSE_SECONDS, exactSecretRedactor } from '@platform/application';
import {
  type CoreImageDigests,
  MAX_REPORTED_IMAGE_DIGESTS,
  type WorkerManualPauseVia as ManualPauseVia,
  type RunPackage,
  shaSchema,
  WORKER_LOCAL_LOG_LINE_MAX_CHARS,
  WORKER_LOCAL_LOG_TAIL,
  WORKER_PROTOCOL_VERSION,
  type WorkerLocalState,
  type WorkerProtocolRange,
  workerLocalStateSchema,
} from '@platform/contracts';
import { launcher as launcherAdapters, runner as runnerAdapters } from '@platform/infrastructure';
import type { DestinationStream } from 'pino';
import { asLoggerPort, createLogger, type PinoLogger } from '../logging.js';
import { repositoryPathOf } from '../pipeline.js';
import { BUNDLED_WEB_ROOT, resolveBundleRoot } from '../web/bundle.js';
import { loadRemoteWorkerConfig, REMOTE_WORKER_ROLE, type RemoteWorkerConfig } from './config.js';
import { CoreCallError, type CoreFetch, createCoreClient, isTransient } from './core-client.js';
import { ensureCredential } from './credential.js';
import { createLocalUiServer, LocalUiError } from './local-ui.js';
import { backoffMs, sleepMs } from './retry.js';
import {
  type RunSession,
  redactKeysAndValues,
  startRunSession,
  WORKER_SECRET_NAMES,
} from './run-session.js';
import { ensureUiToken, uiAddressOf } from './ui-token.js';
import { type PackageWorkspaceOptions, packageWorkspaceProvisioner } from './workspaces.js';

/** What `/readyz` and `/internal/state` say about this worker's connection to its core. */
export type WorkerConnection =
  | 'logging_in'
  | 'handshaking'
  | 'connected'
  | 'revoked'
  | 'upgrade_required'
  | 'stopped';

export interface StartRemoteWorkerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly config?: RemoteWorkerConfig;
  /** Test seam: pino writes here (through the redactor) instead of stdout. */
  readonly logDestination?: DestinationStream;
  /** Test seam: how the worker reaches its core. */
  readonly coreFetch?: CoreFetch;
  /** Test seam: this worker's launcher (default: the control-plane client over `APP_LAUNCHER_URL`). */
  readonly launcher?: launcherAdapters.LauncherControlClient;
  /** Test seam: the CLI in a created workspace (`workspaces.ts`). */
  readonly spawnFor?: PackageWorkspaceOptions['spawnFor'];
  /** Test seam: the waits between retries. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam: where the local page's bundle is (default the image's `apps/web/dist`). */
  readonly webRoot?: string;
}

/** How often a usage-paused claim loop looks again before the reset (WP-285): a minute at most. */
export const USAGE_PAUSE_RECHECK_MS = 60_000;

/** The marker a drain leaves in `worker-state`: its pause is cleared at the next start (WP-292). */
export const DRAIN_MARKER_FILE = 'drain-pause';

/** Who drains: the page's *Drain*, or `POST /internal/drain` (the updater's or an operator's). */
export type DrainVia = Extract<ManualPauseVia, 'worker_ui_drain' | 'worker_internal_drain'>;

export interface RemoteWorkerState {
  readonly role: typeof REMOTE_WORKER_ROLE;
  readonly connection: WorkerConnection;
  readonly worker_id: string | null;
  readonly worker_name: string | null;
  readonly protocol: number;
  readonly core_protocol: WorkerProtocolRange | null;
  readonly core_digests: CoreImageDigests | null;
  readonly last_handshake_at: string | null;
  readonly draining: boolean;
  readonly idle: boolean;
  readonly concurrency: number;
  readonly runs: readonly {
    readonly run_id: string;
    readonly task_id: string;
    readonly stage: string | null;
    readonly epoch: number;
    readonly phase: string;
    readonly started_at: string;
  }[];
}

export interface RemoteWorkerRuntime {
  readonly config: RemoteWorkerConfig;
  readonly logger: PinoLogger;
  /** Starts the local listener — and the local page's, when enabled; answers the first's address. */
  listen(): Promise<string>;
  /** The local page's listener address once listening, `null` when disabled or not yet started. */
  uiAddress(): string | null;
  /**
   * Stop claiming and let the runs in flight finish (`POST /internal/drain`, the page's *Drain*):
   * the core's manual pause, remembered as a drain's so the next start clears it (WP-292).
   */
  drain(via: DrainVia): Promise<void>;
  /** The owner's *Pause* / *Resume* from the local page — the core's `manual-pause` (WP-292). */
  setPaused(paused: boolean): Promise<void>;
  state(): RemoteWorkerState;
  /** What the local page shows, redacted by every secret this worker knows (WP-292). */
  localState(): WorkerLocalState;
  /** The sessions in flight, by run id — a test reads how each one ended. */
  readonly sessions: ReadonlyMap<string, RunSession>;
  /** Every session this worker started, in order, kept after it ended. */
  readonly history: readonly RunSession[];
  /** Stop claiming, hand every run back, close the listener. */
  stop(): Promise<void>;
}

/**
 * A pino destination that replaces every value of `secrets()` in each line before it is written —
 * and hands the redacted line to `kept`, the local page's log tail (WP-292).
 */
const redactingDestination = (
  inner: DestinationStream,
  secrets: () => readonly { readonly name: string; readonly value: string }[],
  kept: (line: string) => void = () => undefined,
): DestinationStream => ({
  write: (line: string) => {
    const known = secrets();
    const redacted = known.length === 0 ? line : exactSecretRedactor(known).redactText(line).value;
    inner.write(redacted);
    kept(redacted);
  },
});

export const startRemoteWorker = async (
  options: StartRemoteWorkerOptions = {},
): Promise<RemoteWorkerRuntime> => {
  const config = options.config ?? loadRemoteWorkerConfig(options.env ?? process.env);
  const sleep = options.sleep ?? sleepMs;
  /** The exact values the log redacts: the Claude token, the credential, each live run's two. */
  const logSecrets = new Map<string, { readonly name: string; readonly value: string }>([
    [
      WORKER_SECRET_NAMES.claudeToken,
      { name: WORKER_SECRET_NAMES.claudeToken, value: config.claudeToken },
    ],
  ]);
  const rawDestination = options.logDestination ?? {
    write: (line: string) => process.stdout.write(line),
  };
  /** The local page's log tail: lines after the redactor, newest last (WP-292). */
  const logTail: string[] = [];
  const destination = redactingDestination(
    rawDestination,
    () => [...logSecrets.values()],
    (line) => {
      const trimmed = line.replace(/\n$/, '');
      logTail.push(
        trimmed.length > WORKER_LOCAL_LOG_LINE_MAX_CHARS
          ? `${trimmed.slice(0, WORKER_LOCAL_LOG_LINE_MAX_CHARS)} … [cut]`
          : trimmed,
      );
      if (logTail.length > WORKER_LOCAL_LOG_TAIL)
        logTail.splice(0, logTail.length - WORKER_LOCAL_LOG_TAIL);
    },
  );
  const logger = createLogger({
    level: config.logLevel,
    format: 'json',
    role: REMOTE_WORKER_ROLE,
    destination,
  });
  const loggerPort: Logger = asLoggerPort(logger);
  const core = createCoreClient({
    baseUrl: config.coreUrl,
    ...(options.coreFetch === undefined ? {} : { fetch: options.coreFetch }),
  });
  const launcher =
    options.launcher ??
    launcherAdapters.createLauncherControlClient({
      baseUrl: config.launcherUrl,
      token: config.launcherToken,
      logger: loggerPort,
    });

  let connection: WorkerConnection = 'logging_in';
  let stopping = false;
  let draining = false;
  let credential: string | null = null;
  let workerId: string | null = null;
  let workerName: string | null = null;
  let coreProtocol: WorkerProtocolRange | null = null;
  let coreDigests: CoreImageDigests | null = null;
  let lastHandshakeAt: string | null = null;
  /** The owner's (or a drain's) hold, as the core stored it (WP-292). */
  let manuallyPausedAt: string | null = null;
  /**
   * A usage limit's pause (TD-031 §11, WP-285): set from the handshake (the core's record) and by
   * this worker when a run's session reports a limit. **A separate hold from the owner's** — when it
   * passes, claiming resumes by itself; it never clears `manuallyPausedAt`.
   */
  let usagePausedUntil: string | null = null;
  /** The pause is this worker's default, the limit named no reset — the page says *until about*. */
  let usagePausedEstimated = false;
  const usagePauseDefaultMs = config.usagePauseDefaultMs ?? DEFAULT_USAGE_PAUSE_SECONDS * 1_000;
  /** ms until the usage pause ends, `0` when none holds. */
  const usagePauseRemainingMs = (): number =>
    usagePausedUntil === null ? 0 : Math.max(0, Date.parse(usagePausedUntil) - Date.now());
  let heldDigests: string[] = [];
  const sessions = new Map<string, RunSession>();
  const history: RunSession[] = [];
  let claimAbort: AbortController | null = null;
  let slotFreed: (() => void) | null = null;
  const drainMarker = path.join(config.stateDir, DRAIN_MARKER_FILE);

  /**
   * The digests this worker **holds** — only what its launcher resolves on the local daemon now
   * (backlog 704, 763): its health check answers the run and egress images it is configured with,
   * by registry digest where the daemon has one, or `null` when either is missing, and every name
   * the daemon knows them by (`heldImageDigests`: ids and `RepoDigests`, S-22.14) — so the core's
   * advertised registry digest is held under the containerd store and the classic one alike.
   * Resolved, the worker's own pinned references are held too (it is running from them).
   * Unresolved, or with no launcher answer, nothing is held and no offer matches — so a worker whose
   * images are still being pulled claims nothing it could not start.
   */
  const refreshHeldDigests = async (): Promise<void> => {
    try {
      const health = await launcher.health();
      heldDigests =
        health.images === null
          ? []
          : [
              ...new Set([
                ...config.imageDigests,
                health.images.run,
                health.images.egress,
                ...(health.heldImageDigests ?? []),
              ]),
            ].slice(0, MAX_REPORTED_IMAGE_DIGESTS);
    } catch (error) {
      heldDigests = [];
      loggerPort.warn(
        { err: error },
        'this worker’s launcher did not answer its health check, so it reports no image as held and claims nothing',
      );
    }
  };

  const handshake = async (): Promise<boolean> => {
    connection = 'handshaking';
    for (let attempt = 0; !stopping; attempt += 1) {
      try {
        await refreshHeldDigests();
        const commit = shaSchema.safeParse(config.commit ?? '');
        const answer = await core.handshake(credential as string, {
          image_digests: heldDigests,
          commit: commit.success ? commit.data : null,
        });
        coreProtocol = answer.protocol;
        coreDigests = answer.digests;
        workerId = answer.worker.id;
        workerName = answer.worker.name;
        manuallyPausedAt = answer.worker.manually_paused_at ?? null;
        // The core's record wins only when it is later than a pause this worker already holds.
        if (
          answer.worker.paused_until !== null &&
          (usagePausedUntil === null ||
            Date.parse(answer.worker.paused_until) > Date.parse(usagePausedUntil))
        ) {
          usagePausedUntil = answer.worker.paused_until;
          usagePausedEstimated = false;
        }
        lastHandshakeAt = new Date().toISOString();
        connection = 'connected';
        loggerPort.info(
          {
            worker_id: workerId,
            worker_name: workerName,
            core_protocol: coreProtocol,
            paused_until: answer.worker.paused_until,
          },
          'this worker is connected to its core',
        );
        return true;
      } catch (error) {
        if (error instanceof CoreCallError && error.kind === 'unauthenticated') {
          connection = 'revoked';
          loggerPort.error(
            {},
            'the core does not accept this worker’s credential (revoked, or its user may not act); delete the credential file in the worker-state volume to log in again',
          );
          return false;
        }
        if (error instanceof CoreCallError && error.kind === 'upgrade_required') {
          connection = 'upgrade_required';
          loggerPort.error({ err: error }, 'the core does not serve this worker’s protocol');
          return false;
        }
        const wait = backoffMs(attempt);
        loggerPort.warn({ err: error, wait_ms: wait }, 'the handshake failed; it is retried');
        await sleep(wait);
      }
    }
    return false;
  };

  /**
   * **A run's session reported a usage limit** (WP-285, TD-031 decision 11): this worker claims
   * nothing until the limit resets — the reset it named, or `APP_WORKER_USAGE_PAUSE_DEFAULT` from
   * now when it named none — and tells the core (`POST pause`), so the claim refuses it there too
   * and the Workers screen says so. The core's refusal is the backstop; the local hold is what
   * stops the claim loop at once. When the instant passes, claiming resumes by itself.
   */
  const noteUsageLimit = async (limit: {
    readonly resetsAt: string | null;
    readonly signal: string;
  }): Promise<void> => {
    const estimated = limit.resetsAt === null;
    const until = estimated
      ? new Date(Date.now() + usagePauseDefaultMs).toISOString()
      : (limit.resetsAt as string);
    if (usagePausedUntil !== null && Date.parse(usagePausedUntil) >= Date.parse(until)) return;
    usagePausedUntil = until;
    usagePausedEstimated = estimated;
    claimAbort?.abort();
    loggerPort.warn(
      { paused_until: until, estimated, signal: limit.signal },
      'this worker’s Claude usage limit was reached: it claims nothing until the limit resets, then resumes by itself',
    );
    // The first attempt is awaited — the run's `finish` follows it, so the core's re-plan is not
    // offered back to this worker — and a failed one is retried in the background, bounded.
    const tell = async (): Promise<boolean> => {
      if (credential === null) return true;
      try {
        await core.pause(credential, { until, reason: 'usage_limited', estimated });
        return true;
      } catch (error) {
        if (error instanceof CoreCallError && error.kind === 'unauthenticated') return true;
        loggerPort.warn({ err: error }, 'the core did not take this worker’s usage pause yet');
        return false;
      }
    };
    if (await tell()) return;
    void (async () => {
      for (let attempt = 1; attempt < 5 && !stopping; attempt += 1) {
        await sleep(backoffMs(attempt));
        if (await tell()) return;
      }
    })();
  };

  const startSession = (pkg: RunPackage): void => {
    const runKeys = [`run_token:${pkg.runId}`, `run_credential:${pkg.runId}`];
    logSecrets.set(runKeys[0] as string, {
      name: `${WORKER_SECRET_NAMES.runToken}_${pkg.epoch}_${pkg.runId.slice(0, 8)}`,
      value: pkg.runToken,
    });
    if (pkg.credential !== null) {
      logSecrets.set(runKeys[1] as string, {
        name: `${WORKER_SECRET_NAMES.runCredential}_${pkg.epoch}_${pkg.runId.slice(0, 8)}`,
        value: pkg.credential.password,
      });
    }
    const session = startRunSession({
      pkg,
      core: core.forRun(pkg.runId, pkg.runToken),
      claudeToken: config.claudeToken,
      logger: loggerPort,
      sleep,
      usagePausedUntil: () => (usagePauseRemainingMs() > 0 ? usagePausedUntil : null),
      onUsageLimit: noteUsageLimit,
      provisionerFor: ({ sshSign, exportsAllowed }) =>
        packageWorkspaceProvisioner(pkg, {
          launcher,
          controlRoot: config.controlRoot,
          clock: runnerAdapters.systemClock,
          sshSign,
          exportsAllowed,
          repositoryPathOf,
          ...(options.spawnFor === undefined ? {} : { spawnFor: options.spawnFor }),
          logger: loggerPort,
        }),
    });
    sessions.set(pkg.runId, session);
    history.push(session);
    loggerPort.info(
      { run_id: pkg.runId, task_id: pkg.run.taskId, lease_epoch: pkg.epoch },
      'this worker claimed a run',
    );
    void session.done.finally(() => {
      sessions.delete(pkg.runId);
      for (const key of runKeys) logSecrets.delete(key);
      slotFreed?.();
    });
  };

  const claimLoop = async (): Promise<void> => {
    let failures = 0;
    while (!stopping && connection === 'connected') {
      // Drained or held by its owner: wait for *Resume* (WP-292) — never claim.
      if (draining || manuallyPausedAt !== null) {
        await new Promise<void>((resolve) => {
          slotFreed = resolve;
        });
        slotFreed = null;
        continue;
      }
      if (sessions.size >= config.concurrency) {
        await new Promise<void>((resolve) => {
          slotFreed = resolve;
        });
        slotFreed = null;
        continue;
      }
      // A usage limit holds it (WP-285): wait for the reset — or a wake-up — then claim again by
      // itself. A person's *Pause* is the branch above and is never cleared by this.
      const usageWait = usagePauseRemainingMs();
      if (usageWait > 0) {
        await new Promise<void>((resolve) => {
          slotFreed = resolve;
          const timer = setTimeout(resolve, Math.min(usageWait, USAGE_PAUSE_RECHECK_MS));
          (timer as { unref?: () => void }).unref?.();
        });
        slotFreed = null;
        continue;
      }
      claimAbort = new AbortController();
      try {
        // Asked before every claim: an image pulled (or removed) since the last one counts now.
        await refreshHeldDigests();
        const pkg = await core.claim(
          credential as string,
          {
            free_slots: config.concurrency - sessions.size,
            image_digests: heldDigests,
            paused: false,
          },
          claimAbort.signal,
        );
        failures = 0;
        if (pkg !== null) startSession(pkg);
      } catch (error) {
        if (stopping) break;
        if (draining || manuallyPausedAt !== null || usagePauseRemainingMs() > 0) continue;
        if (error instanceof CoreCallError && error.kind === 'unauthenticated') {
          connection = 'revoked';
          loggerPort.error({}, 'the core refused this worker’s credential; it stops claiming');
          break;
        }
        if (error instanceof CoreCallError && error.kind === 'upgrade_required') {
          connection = 'upgrade_required';
          loggerPort.error(
            { err: error },
            'the core no longer serves this protocol; it stops claiming',
          );
          break;
        }
        failures += 1;
        const wait = backoffMs(failures);
        loggerPort.warn(
          { err: error, wait_ms: wait, transient: isTransient(error) },
          'a claim failed; claiming again',
        );
        await sleep(wait);
      } finally {
        claimAbort = null;
      }
    }
  };

  /** Wakes the claim loop: a slot freed, a resume, a drain or a stop. */
  const wakeClaims = (): void => {
    slotFreed?.();
  };

  const exists = async (file: string): Promise<boolean> =>
    stat(file).then(
      () => true,
      () => false,
    );

  /**
   * The core's `manual-pause`, stored here once it answered (WP-292). `via` is who asked — the
   * page, its Drain, `/internal/drain` or this start — and the audit row says which.
   */
  const assertPause = async (paused: boolean, via: ManualPauseVia): Promise<void> => {
    if (credential === null) {
      throw new LocalUiError(
        409,
        'not_connected',
        'this worker is not logged in to its core yet, so it cannot be paused there',
      );
    }
    const answer = await core.manualPause(credential, { paused, via });
    manuallyPausedAt = answer.manually_paused_at;
  };

  /**
   * At start, after the handshake: a drain's pause is cleared — **only a drain's** (the marker
   * says so); an owner's *Pause* survives a restart. Retried until the core answers or the worker
   * stops; until then this worker claims nothing, which is what the pause said anyway.
   */
  const clearDrainPause = async (): Promise<void> => {
    if (!(await exists(drainMarker))) return;
    for (let attempt = 0; !stopping; attempt += 1) {
      try {
        await assertPause(false, 'worker_start');
        await rm(drainMarker, { force: true });
        loggerPort.info({}, 'the last drain’s pause is cleared at this start; claiming again');
        return;
      } catch (error) {
        if (
          error instanceof CoreCallError &&
          (error.kind === 'unauthenticated' || error.kind === 'upgrade_required')
        ) {
          loggerPort.error({ err: error }, 'the last drain’s pause could not be cleared');
          return;
        }
        await sleep(backoffMs(attempt));
      }
    }
  };

  /** The owner's *Pause* / *Resume* (WP-292): the core first, then this worker. */
  const setPaused = async (paused: boolean): Promise<void> => {
    await assertPause(paused, 'worker_ui');
    // Either way the hold is now the owner's, not a drain's: a later start leaves a *Pause* in place.
    await rm(drainMarker, { force: true });
    if (paused) {
      claimAbort?.abort();
    } else {
      draining = false;
    }
    wakeClaims();
    loggerPort.info(
      { paused },
      paused
        ? 'this worker’s owner paused it: it claims nothing until resumed'
        : 'this worker’s owner resumed it: claiming again',
    );
  };

  /**
   * *Drain* (WP-292) and `POST /internal/drain` (WP-283 (3)): claim nothing more at once, finish
   * what runs, and hold the core's pause as a **drain's** — the marker makes the next start clear
   * it. The core's pause is best-effort here: a drain the updater asks for must happen whether or
   * not the core answers, and the claim loop is already stopped locally.
   *
   * **A drain of a worker its owner already paused is no drain's pause** (review of PR #30): the
   * hold is the owner's, so no marker is written and nothing is asked of the core — otherwise the
   * next start would clear the owner's *Pause* and the worker would claim again.
   */
  const drain = async (via: DrainVia): Promise<void> => {
    const first = !draining;
    draining = true;
    claimAbort?.abort();
    wakeClaims();
    if (first) {
      loggerPort.info(
        { runs: sessions.size, via },
        'this worker is draining: it claims nothing more',
      );
    }
    if (manuallyPausedAt !== null) {
      return;
    }
    await writeFile(drainMarker, `${new Date().toISOString()} ${via}\n`, { mode: 0o600 }).catch(
      (error: unknown) =>
        loggerPort.warn({ err: error }, 'the drain marker could not be written in worker-state'),
    );
    try {
      await assertPause(true, via);
    } catch (error) {
      loggerPort.warn(
        { err: error },
        'the core did not record the drain’s pause; this worker claims nothing either way',
      );
    }
  };

  /** A person's cancel from the local page: the core's `run.cancel` (WP-292, Q126). */
  const cancelRun = async (input: {
    readonly runId: string;
    readonly reason: string | undefined;
    readonly idempotencyKey: string;
  }) => {
    const session = sessions.get(input.runId);
    if (session === undefined) {
      throw new LocalUiError(404, 'run_not_here', 'this worker does not hold that run (any more)');
    }
    try {
      const answer = await session.requestCancel({
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      loggerPort.info(
        { run_id: input.runId, command_id: answer.command_id },
        'a cancel from the local page was accepted by the core; the task is paused',
      );
      return {
        run_id: answer.run_id,
        accepted: answer.performed || answer.command_id !== null,
        task_state: answer.task_state,
      };
    } catch (error) {
      if (error instanceof CoreCallError && error.status !== null && error.status < 500) {
        throw new LocalUiError(
          error.status === 403 ? 403 : 409,
          error.code ?? 'refused',
          `the core refused the cancel: ${error.message}`,
        );
      }
      throw new LocalUiError(
        502,
        'core_unreachable',
        `the core did not answer the cancel: ${(error as Error).message}`,
      );
    }
  };

  /**
   * Every secret this worker knows (WP-292): the log's — the Claude token, the credential, each
   * live run's token and run credential — and, once the page listens, the page's own token.
   */
  let uiToken: string | null = null;
  const pageRedactor = () => exactSecretRedactor([...logSecrets.values()]);

  /**
   * The local page's state (WP-292): read from this worker's memory only — no core read — and
   * passed, keys and values, through every exact secret this worker knows before it is answered.
   */
  const localState = (): WorkerLocalState => {
    const now = Date.now();
    const value = {
      worker_id: workerId,
      worker_name: workerName,
      connection,
      protocol: WORKER_PROTOCOL_VERSION,
      core_protocol: coreProtocol,
      core_url: config.coreUrl,
      last_handshake_at: lastHandshakeAt,
      manually_paused_at: manuallyPausedAt,
      // A pause that has passed is no pause: the page says *taking work* again by itself.
      usage_paused_until: usagePauseRemainingMs() > 0 ? usagePausedUntil : null,
      usage_paused_estimated: usagePauseRemainingMs() > 0 && usagePausedEstimated,
      draining,
      update_pending:
        coreDigests === null || (config.platformImageDigest ?? null) === null
          ? null
          : coreDigests.platform !== config.platformImageDigest,
      concurrency: config.concurrency,
      runs: [...sessions.values()].map((session) => ({
        run_id: session.state.runId,
        task_id: session.state.taskId,
        project_id: session.state.projectId,
        project_key: session.state.display?.projectKey ?? null,
        ticket_key: session.state.display?.ticketKey ?? null,
        title: session.state.display?.title ?? null,
        stage: session.state.stage,
        role: session.state.role,
        attempt: session.state.attempt,
        phase: session.state.phase,
        started_at: session.state.startedAt,
        elapsed_ms: Math.max(0, now - Date.parse(session.state.startedAt)),
        tokens: session.state.tokens,
        cost_usd: session.state.costUsd,
        cancel_requested: session.state.cancelRequested,
        transcript: [...session.state.tail],
      })),
      logs: [...logTail],
      server_time: new Date(now).toISOString(),
    };
    return workerLocalStateSchema.parse(redactKeysAndValues(pageRedactor(), value));
  };

  const main = (async () => {
    try {
      credential = await ensureCredential({
        core,
        stateDir: config.stateDir,
        logger: loggerPort,
        stopped: () => stopping,
        sleep,
      });
      if (credential === null) return;
      logSecrets.set('credential', { name: 'worker_credential', value: credential });
      if (!(await handshake())) return;
      await clearDrainPause();
      await claimLoop();
    } catch (error) {
      loggerPort.error({ err: error }, 'the remote worker stopped claiming after an error');
    }
  })();

  const state = (): RemoteWorkerState => ({
    role: REMOTE_WORKER_ROLE,
    connection,
    worker_id: workerId,
    worker_name: workerName,
    protocol: WORKER_PROTOCOL_VERSION,
    core_protocol: coreProtocol,
    core_digests: coreDigests,
    last_handshake_at: lastHandshakeAt,
    draining,
    idle: sessions.size === 0,
    concurrency: config.concurrency,
    runs: [...sessions.values()].map((session) => ({
      run_id: session.state.runId,
      task_id: session.state.taskId,
      stage: session.state.stage,
      epoch: session.state.epoch,
      phase: session.state.phase,
      started_at: session.state.startedAt,
    })),
  });

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const path = (request.url ?? '/').split('?')[0];
    if (request.method === 'GET' && path === '/healthz') {
      send(response, 200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && path === '/readyz') {
      const ok = connection === 'connected';
      send(response, ok ? 200 : 503, {
        status: ok ? 'ok' : 'down',
        checks: { core_handshake: ok ? 'ok' : connection },
      });
      return;
    }
    if (request.method === 'GET' && path === '/internal/state') {
      send(response, 200, state());
      return;
    }
    if (request.method === 'POST' && path === '/internal/drain') {
      void drain('worker_internal_drain').then(
        () => send(response, 202, state()),
        () => send(response, 202, state()),
      );
      return;
    }
    send(response, 404, { error: { code: 'not_found', message: `${path} is not served here` } });
  };
  let server: Server | null = null;
  let uiServer: Server | null = null;
  let uiAddress: string | null = null;

  const bind = async (listening: Server, port: number, host: string): Promise<string> => {
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(port, host, () => resolve());
    });
    const address = listening.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    return `http://${host}:${bound}`;
  };

  /**
   * The local page's listener (WP-292): only when `APP_WORKER_UI=enabled`. The token is created
   * once in `worker-state` and the page's address is logged **once per start**, written straight to
   * the process's output — the one line that carries the token, which every other line, the log
   * tail and every local answer redact.
   */
  const listenUi = async (): Promise<void> => {
    const ui = config.ui;
    if (ui === undefined || !ui.enabled) {
      loggerPort.info({}, 'the local page is disabled (APP_WORKER_UI=disabled): no port is open');
      return;
    }
    uiToken = await ensureUiToken(config.stateDir);
    const token = uiToken;
    logSecrets.set('ui_token', { name: 'worker_ui_token', value: token });
    const webRoot = await resolveBundleRoot(options.webRoot ?? BUNDLED_WEB_ROOT);
    const listening = createLocalUiServer({
      token,
      publishedPort: ui.publishedPort,
      webRoot,
      redact: (text) => pageRedactor().redactText(text).value,
      api: {
        state: localState,
        pause: async (paused) => {
          try {
            await setPaused(paused);
          } catch (error) {
            if (error instanceof LocalUiError) throw error;
            throw new LocalUiError(
              502,
              'core_unreachable',
              `the core did not record the ${paused ? 'pause' : 'resume'}: ${(error as Error).message}`,
            );
          }
          return localState();
        },
        drain: async () => {
          await drain('worker_ui_drain');
          return localState();
        },
        cancel: cancelRun,
      },
    });
    uiServer = listening;
    uiAddress = await bind(listening, ui.listenPort, ui.host);
    rawDestination.write(
      `${JSON.stringify({
        level: 30,
        time: Date.now(),
        role: REMOTE_WORKER_ROLE,
        msg: `this worker's page: ${uiAddressOf(ui.publishedPort, token)} (open it on this machine; the address is printed at every start — delete ui-token in the worker-state volume to change it)`,
      })}\n`,
    );
  };

  return {
    config,
    logger,
    sessions,
    history,
    listen: async () => {
      const listening = createServer(handle);
      server = listening;
      const address = await bind(listening, config.port, config.host);
      await listenUi();
      return address;
    },
    uiAddress: () => uiAddress,
    drain,
    setPaused,
    state,
    localState,
    stop: async () => {
      stopping = true;
      claimAbort?.abort();
      slotFreed?.();
      for (const session of sessions.values()) session.shutdown();
      await Promise.all([...sessions.values()].map((session) => session.done));
      await main;
      connection = 'stopped';
      for (const open of [server, uiServer]) {
        if (open !== null) {
          open.closeAllConnections();
          await new Promise<void>((resolve) => open.close(() => resolve()));
        }
      }
      server = null;
      uiServer = null;
      uiAddress = null;
    },
  };
};
