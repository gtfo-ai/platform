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
 *    `GET /readyz` (`core_handshake` and, since backlog 980, `launcher` — ready is both),
 *    `POST /internal/drain` (stop claiming, finish what runs —
 *    what the updater asks before it applies, TD-032 decision 6) and `GET /internal/state`;
 *  - **the local page** (WP-292, `local-ui.ts`): a second listener on container port 7357, published
 *    on `127.0.0.1` only — with no token by default (`APP_WORKER_UI_AUTH=none`), or behind one kept
 *    in `worker-state` (`ui-token.ts`) under `token` — state, slots, each run with its transcript
 *    tail, the log tail, and *Pause/Resume*, *Drain* and *Cancel run* — and, since WP-293, the claim
 *    scope and *Take this one* (the core's `claim-scope`, `offers` and `offers/:id/claim`, protocol 3);
 *  - **the first-run wizard** (WP-294, TD-031's 2026-11-05 first-run amendment): the worker starts
 *    with no core URL, no Claude token and no credential, calls no core and claims nothing, and the
 *    page walks *Connect to a platform* (`core-probe.ts`, stored `core-url`) → *Sign in to Claude*
 *    (`claude-sign-in.ts`, stored `claude-token`) → *Approve this machine* (the device code on the
 *    page, `credential.ts`). Each step is skipped when its value is there — environment first, then
 *    the `worker-state` file — and each advances by itself. The page's state carries this
 *    process's `started_at`, so the page can tell a restart mid-sign-in from a sign-in that ended
 *    (BACKLOG 1053).
 *
 * ## The cycle
 *
 * What the worker does is one **cycle** — platform? Claude? credential, handshake, claim loop — and
 * a page action that changes one of its inputs (a platform chosen or forgotten, a sign-in stored or
 * removed, *Connect again*, *Try now*) or Claude refusing the token on a run's stream **restarts**
 * it: the claim loop stops, the runs in flight finish on their own leases, and the next cycle starts
 * from the first step that is not satisfied. No restart of the process is ever needed.
 *
 * ## Pause, drain and cancel — the core decides each (TD-031's worker-UI amendment §4)
 *
 * *Pause* asks the core's `manual-pause` and, once it answered, claims nothing; *Resume* the
 * reverse. *Drain* is the same hold plus a marker file (`drain-pause`) in `worker-state`: the worker
 * finishes what runs and takes nothing new, and **its next start clears a drain's pause — only a
 * drain's**; an owner's *Pause* survives a restart. `POST /internal/drain` (the updater's) is the
 * same function. **A drain waits for a Claude sign-in** (or its token check) already running —
 * `/internal/state`'s `idle` is false meanwhile — and **an update's** drain (`POST /internal/drain`)
 * **refuses to start a new one** (`409 draining`), so a person who keeps starting sign-ins cannot
 * postpone an update forever (BACKLOG 1054); the running one's code and a pasted token are still
 * taken — and only while the updater still waits ({@link UPDATE_DRAIN_SIGN_IN_HOLD_MS} after its last
 * drain or state read), because the owner's rule is that no setup step may trap a person and an
 * updater that gave up sends nothing more. The owner's page *Drain* refuses no sign-in: the setup
 * screens offer no *Resume*. A drained worker **stays up,
 * idle**, rather than exiting: `compose.worker.yml`
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
 *
 * **Optional error reporting** (WP-295, TD-023's 2026-11-05 amendment): with a DSN — `SENTRY_DSN`
 * in the environment, which wins, or the page's *Error reporting* setting, kept as `sentry-dsn` in
 * `worker-state` — each `error`/`fatal` line is reported, rebuilt from the reporter's allow-list
 * and redacted by the same exact values plus TD-012's patterns. A change on the page swaps the
 * client without a restart; *Send a test error* sends one.
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
  type WorkerClaimPolicy,
  type WorkerLocalClaimScope,
  type WorkerLocalCoreFailure,
  type WorkerLocalErrorReportingTestResponse,
  type WorkerLocalLauncher,
  type WorkerLocalOffers,
  type WorkerLocalState,
  type WorkerProtocolRange,
  workerLocalClaimScopeSchema,
  workerLocalErrorReportingTestResponseSchema,
  workerLocalOffersSchema,
  workerLocalStateSchema,
} from '@platform/contracts';
import { localClaimBlockersOf } from '@platform/domain';
import {
  errorReporting,
  launcher as launcherAdapters,
  runner as runnerAdapters,
} from '@platform/infrastructure';
import type { DestinationStream } from 'pino';
import {
  ErrorReportingTestError,
  type ReportingTransport,
  reportingLogHook,
  sentryClientFactory,
} from '../error-reporting.js';
import { asLoggerPort, createLogger, type PinoLogger } from '../logging.js';
import { repositoryPathOf } from '../pipeline.js';
import { BUNDLED_WEB_ROOT, resolveBundleRoot } from '../web/bundle.js';
import {
  type ClaudeCliLauncher,
  createClaudeSignIn,
  InvalidClaudeTokenError,
  SignInBusyError,
  scriptCliLauncher,
} from './claude-sign-in.js';
import {
  DEFAULT_CLAUDE_CLI_PATH,
  DEFAULT_CORE_CANDIDATES,
  loadRemoteWorkerConfig,
  REMOTE_WORKER_ROLE,
  type RemoteWorkerConfig,
} from './config.js';
import {
  CoreCallError,
  type CoreClient,
  type CoreFetch,
  createCoreClient,
  isTransient,
} from './core-client.js';
import { CoreCheckError, checkCoreAddress, probeCoreCandidates } from './core-probe.js';
import { CREDENTIAL_FILE, ensureCredential } from './credential.js';
import { createLocalUiServer, LocalUiError } from './local-ui.js';
import { backoffMs, RETRY_MAX_MS, sleepMs } from './retry.js';
import {
  type RunSession,
  redactKeysAndValues,
  startRunSession,
  WORKER_SECRET_NAMES,
} from './run-session.js';
import {
  CLAUDE_TOKEN_FILE,
  CORE_URL_FILE,
  readStoredClaudeToken,
  readStoredCoreUrl,
  readStoredSentryDsn,
  removeFile,
  SENTRY_DSN_FILE,
  writePrivateFile,
} from './setup-files.js';
import { ensureUiToken, plainUiAddressOf, uiAddressOf } from './ui-token.js';
import { type PackageWorkspaceOptions, packageWorkspaceProvisioner } from './workspaces.js';

/** What `/readyz` and `/internal/state` say about this worker's connection to its core. */
export type WorkerConnection =
  | 'needs_platform'
  | 'needs_claude'
  | 'logging_in'
  | 'handshaking'
  | 'connected'
  | 'revoked'
  | 'upgrade_required'
  | 'core_unreachable'
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
  /** Test seam: one launcher health probe's bound (default {@link LAUNCHER_PROBE_TIMEOUT_MS}). */
  readonly launcherProbeTimeoutMs?: number;
  /** Test seam: where the local page's bundle is (default the image's `apps/web/dist`). */
  readonly webRoot?: string;
  /** Test seam: how the sign-in starts `claude` (default `script(1)` around the configured CLI). */
  readonly claudeCli?: ClaudeCliLauncher;
  /** Test seam: how the wizard checks a platform address (default the global `fetch`). */
  readonly probeFetch?: CoreFetch;
  /** Test seam: how the error reporter sends an envelope (default the SDK's HTTP transport). */
  readonly errorReportingTransport?: ReportingTransport;
  /** Test seam: {@link UPDATE_DRAIN_SIGN_IN_HOLD_MS}. */
  readonly updateDrainSignInHoldMs?: number;
}

/**
 * How long an update's drain refuses a new Claude sign-in **after the last sign that an update is
 * still waiting** — `POST /internal/drain`, or the updater's `GET /internal/state` while it waits
 * for idle (every few seconds, however long a run takes). Once the worker is idle the updater
 * stops asking and starts the apply, which restarts this worker within a few minutes (the images
 * are pulled before the drain, and `up --wait` is bounded at 120 s, a rollback's again). An
 * updater that gave up — a failed apply create or start, a failed restart of the drained worker,
 * an updater stopped mid-wait — sends no further sign, so the refusal ends within this window
 * rather than at the next restart: the owner's rule is that no setup step may trap a person. The
 * failure paths that restart the drained worker (`apply.ts`'s `restartDrained`) end it at once.
 */
export const UPDATE_DRAIN_SIGN_IN_HOLD_MS = 10 * 60_000;

/** How long *Send a test error* waits for the event to be sent before it answers. */
export const ERROR_REPORTING_TEST_FLUSH_MS = 5_000;

/**
 * How long one launcher health probe may take before it counts as no answer (backlog 980). The
 * control client's own bound is ten minutes — a create's — and a probe that hung that long held the
 * claim loop with it.
 */
export const LAUNCHER_PROBE_TIMEOUT_MS = 10_000;

/** What `/readyz`'s `launcher` says: the last health probe answered, did not, or none was made. */
export type LauncherReach = WorkerLocalLauncher;

/** How often a usage-paused claim loop looks again before the reset (WP-285): a minute at most. */
export const USAGE_PAUSE_RECHECK_MS = 60_000;

/**
 * A core call's failure as the page names it (WP-294 (6)): a certificate the worker could not
 * trust, an answer that is not a platform's, or no answer. Never the body.
 */
export const coreFailureOf = (error: unknown): WorkerLocalCoreFailure => {
  if (!(error instanceof CoreCallError)) return 'no_answer';
  if (error.kind === 'upgrade_required') return 'needs_other_version';
  if (error.status === null) {
    return /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|certificate/i.test(error.message)
      ? 'certificate'
      : 'no_answer';
  }
  if (error.status === 429 || error.status >= 500) return 'no_answer';
  return 'not_a_platform';
};

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
  /** The error reporter (WP-295) — a test flushes it before reading what its transport received. */
  readonly errorReporter: errorReporting.ErrorReporter;
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
  const uiAuth = config.ui?.auth ?? 'token';
  /**
   * The exact values the log redacts: the Claude token (every one this process has known), the
   * credential, each live run's two, the page's token and the wizard's code — by unique names.
   */
  const logSecrets = new Map<string, { readonly name: string; readonly value: string }>();
  let secretCount = 0;
  const rememberSecret = (name: string, value: string): void => {
    if (value === '' || [...logSecrets.values()].some((known) => known.value === value)) return;
    secretCount += 1;
    logSecrets.set(`known:${secretCount}`, { name: `${name}_${secretCount}`, value });
  };
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
  /**
   * Optional error reporting (WP-295): every exact value the log redacts, read per event, then
   * TD-012's patterns (`sentryClientFactory`). Its tags are read when a line is reported: the
   * worker's id and its platform change at the handshake and on the page.
   */
  const errorReporter = errorReporting.createErrorReporter({
    createClient: sentryClientFactory({
      secrets: () => exactSecretRedactor([...logSecrets.values()]),
      ...(options.errorReportingTransport === undefined
        ? {}
        : { transport: options.errorReportingTransport }),
    }),
    // Below `error`, so a failure to report is never itself reported.
    onFailure: (error) => loggerPort.warn({ err: error }, 'error reporting failed'),
  });
  const reportTags = (): errorReporting.ReportTags => {
    const tags: errorReporting.ReportTags = {
      role: REMOTE_WORKER_ROLE,
      version: config.version ?? null,
      commit: config.commit,
    };
    try {
      return { ...tags, worker_id: workerId, core_url: coreUrl };
    } catch {
      // A line logged before the connection's state is declared (start-up) has no id to tag.
      return tags;
    }
  };
  const logger = createLogger({
    level: config.logLevel,
    format: 'json',
    role: REMOTE_WORKER_ROLE,
    destination,
    onError: reportingLogHook(errorReporter, reportTags),
  });
  const loggerPort: Logger = asLoggerPort(logger);
  const launcher =
    options.launcher ??
    launcherAdapters.createLauncherControlClient({
      baseUrl: config.launcherUrl,
      token: config.launcherToken,
      logger: loggerPort,
    });
  const probeTimeoutMs = options.launcherProbeTimeoutMs ?? LAUNCHER_PROBE_TIMEOUT_MS;
  /**
   * The health probe's own client (review of PR #48): bounded at {@link LAUNCHER_PROBE_TIMEOUT_MS}
   * by its `fetch`, so a lost race below leaves no ten-minute request open. A test's launcher seam
   * is its own prober; the race is then the bound.
   */
  const launcherProbe =
    options.launcher ??
    launcherAdapters.createLauncherControlClient({
      baseUrl: config.launcherUrl,
      token: config.launcherToken,
      logger: loggerPort,
      timeoutMs: probeTimeoutMs,
    });

  // ── The wizard's inputs (WP-294): environment → `worker-state` file → the page ──────────────
  const coreFromEnvironment = config.coreUrl !== null;
  const claudeFromEnvironment = config.claudeToken !== null;
  let coreUrl: string | null = config.coreUrl ?? (await readStoredCoreUrl(config.stateDir));
  let claudeToken: string | null =
    config.claudeToken ?? (await readStoredClaudeToken(config.stateDir));
  if (claudeToken !== null) rememberSecret(WORKER_SECRET_NAMES.claudeToken, claudeToken);
  // Error reporting (WP-295): environment → `worker-state` file → the page's setting.
  const sentryFromEnvironment = (config.sentryDsn ?? null) !== null;
  const startingDsn = config.sentryDsn ?? (await readStoredSentryDsn(config.stateDir));
  if (startingDsn !== null) {
    try {
      await errorReporter.configure(startingDsn);
      loggerPort.info(
        { host: new URL(startingDsn).host, source: sentryFromEnvironment ? 'environment' : 'file' },
        'error reporting is on: error lines are reported, redacted',
      );
    } catch {
      // Heard by `onFailure` (a warning line); the worker runs on with reporting off — and the
      // page says *Off*, because it reads the reporter rather than the stored value.
    }
  }
  /** Claude refused the token this worker holds (WP-294 (6)): no claim until a new sign-in. */
  let claudeRejected = false;
  let candidates: { readonly url: string; readonly version: string }[] = [];
  let device: {
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresAt: Date;
  } | null = null;
  let unreachable: {
    readonly failure: WorkerLocalCoreFailure;
    readonly retryAt: Date | null;
  } | null = null;
  let core: CoreClient | null = null;

  let connection: WorkerConnection = 'logging_in';
  let stopping = false;
  let draining = false;
  /**
   * When the last sign came that an update's drain — `POST /internal/drain`, the updater's (or an
   * operator's), never the owner's page *Drain* — is still waiting: `null` for no update's drain.
   * Only that drain refuses a new Claude sign-in, and only for {@link UPDATE_DRAIN_SIGN_IN_HOLD_MS}
   * after it (BACKLOG 1054; the owner's rule that no setup step may trap a person).
   */
  let updateDrainSignalAt: number | null = null;
  const updateDrainSignInHoldMs = options.updateDrainSignInHoldMs ?? UPDATE_DRAIN_SIGN_IN_HOLD_MS;
  const updateDrainRefusesSignIn = (): boolean =>
    draining &&
    updateDrainSignalAt !== null &&
    Date.now() - updateDrainSignalAt < updateDrainSignInHoldMs;
  /** This process's start — the page's start identity: another one is a restart (BACKLOG 1053). */
  const startedAt = new Date().toISOString();
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
  /** Whether this worker's launcher answered its last health probe (`/readyz`'s `launcher`). */
  let launcherReach: LauncherReach = 'unknown';
  /** The re-probe loop while the launcher does not answer (backlog 980), else `null`. */
  let launcherWatch: Promise<void> | null = null;
  /** The claim out now was sent holding no image: the core can match nothing to it. */
  let claimSentHoldingNothing = false;
  /** The claim was called off because the launcher answered again: claim at once, no backoff. */
  let reclaimNow = false;
  const sessions = new Map<string, RunSession>();
  const history: RunSession[] = [];
  let claimAbort: AbortController | null = null;
  /** The claim loop's held `claims` request while one is out, settled either way (WP-293). */
  let claimInFlight: Promise<void> | null = null;
  /** A *take this one* is under way: the claim loop holds off so the two never fill one slot twice. */
  let taking = false;
  /** The claim scope as the core last said (handshake ≥ 3, or a write from the page), WP-293. */
  let claimScope: readonly string[] | null | undefined;
  /** The claim policy as the core last said (handshake ≥ 4, or the scope's read or write), S-26.4. */
  let claimPolicy: WorkerClaimPolicy | null = null;
  /** The open offers the policy leaves for others, as the core last counted them (S-26.4). */
  let policySkippedOffers: number | null = null;
  let slotFreed: (() => void) | null = null;
  const drainMarker = path.join(config.stateDir, DRAIN_MARKER_FILE);

  /** The current cycle; a page action that changes one of its inputs aborts it (see the docblock). */
  let cycle = new AbortController();
  /** Wakes the claim loop: a slot freed, a resume, a drain, a restart or a stop. */
  const wakeClaims = (): void => {
    slotFreed?.();
  };
  const restartCycle = (why: string): void => {
    cycle.abort();
    cycle = new AbortController();
    claimAbort?.abort();
    wakeClaims();
    loggerPort.info({ why }, 'this worker starts its connection again');
  };
  /** A wait that a restart (or a stop) ends early. */
  const pause = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      signal.addEventListener('abort', done, { once: true });
      void sleep(ms).then(done);
    });
  /** Waits until the cycle is restarted (or the worker stops). */
  const untilRestart = (signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener('abort', () => resolve(), { once: true });
    });

  /**
   * The digests this worker **holds** — only what its launcher resolves on the local daemon now
   * (backlog 704, 763): its health check answers the run and egress images it is configured with,
   * by registry digest where the daemon has one, or `null` when either is missing, and every name
   * the daemon knows them by (`heldImageDigests`: ids and `RepoDigests`, S-22.14) — so the core's
   * advertised registry digest is held under the containerd store and the classic one alike.
   * Resolved, the worker's own pinned references are held too (it is running from them).
   * Unresolved, or with no launcher answer, nothing is held and no offer matches — so a worker whose
   * images are still being pulled claims nothing it could not start.
   *
   * **A launcher that does not answer is asked again** (backlog 980): the first self-update on Autix
   * started `remote-worker` a second before `launcher`, the start's probe failed, and the worker sat
   * *connected* and claiming nothing for seven minutes. Each probe is bounded
   * ({@link LAUNCHER_PROBE_TIMEOUT_MS}, not the control client's ten-minute create bound), a failed
   * one starts {@link watchLauncher} — a re-probe with backoff, besides the one before every claim —
   * and the outage is logged once when it starts and once when it ends.
   */
  const refreshHeldDigests = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const health = await Promise.race([
        launcherProbe.health(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`the launcher’s health check did not answer within ${probeTimeoutMs} ms`),
              ),
            probeTimeoutMs,
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
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
      const recovered = launcherReach === 'unreachable';
      launcherReach = 'ok';
      if (recovered) {
        loggerPort.info(
          { held_images: heldDigests.length },
          'this worker’s launcher answers its health check again: it reports its images as held and claims',
        );
      }
      return true;
    } catch (error) {
      heldDigests = [];
      if (launcherReach !== 'unreachable') {
        loggerPort.warn(
          { err: error },
          'this worker’s launcher did not answer its health check, so it reports no image as held and claims nothing; it asks again with backoff',
        );
      }
      launcherReach = 'unreachable';
      watchLauncher();
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * While the launcher does not answer: ask it again with backoff (≤ {@link RETRY_MAX_MS}), and once
   * it does, call off a claim that went out holding nothing — the core could match no offer to it, so
   * nothing is lost — so the next one reports the images at once rather than up to 25 s later.
   */
  const watchLauncher = (): void => {
    if (launcherWatch !== null || stopping) return;
    launcherWatch = (async () => {
      for (let attempt = 0; !stopping && launcherReach === 'unreachable'; attempt += 1) {
        await sleep(backoffMs(attempt));
        if (stopping || launcherReach !== 'unreachable') break;
        if (await refreshHeldDigests()) {
          if (claimAbort !== null && claimSentHoldingNothing) {
            reclaimNow = true;
            claimAbort.abort();
          }
          wakeClaims();
        }
      }
    })().finally(() => {
      launcherWatch = null;
      // A probe that failed while this loop was ending found it still set: start it again.
      if (launcherReach === 'unreachable' && !stopping) watchLauncher();
    });
  };

  const handshake = async (client: CoreClient, signal: AbortSignal): Promise<boolean> => {
    connection = 'handshaking';
    for (let attempt = 0; !stopping && !signal.aborted; attempt += 1) {
      try {
        await refreshHeldDigests();
        const commit = shaSchema.safeParse(config.commit ?? '');
        const answer = await client.handshake(credential as string, {
          image_digests: heldDigests,
          commit: commit.success ? commit.data : null,
        });
        coreProtocol = answer.protocol;
        coreDigests = answer.digests;
        workerId = answer.worker.id;
        workerName = answer.worker.name;
        manuallyPausedAt = answer.worker.manually_paused_at ?? null;
        claimScope = answer.worker.claim_project_ids;
        claimPolicy = answer.worker.claim_policy ?? claimPolicy;
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
        unreachable = null;
        connection = 'connected';
        loggerPort.info(
          {
            worker_id: workerId,
            worker_name: workerName,
            core_protocol: coreProtocol,
            paused_until: answer.worker.paused_until,
            claim_scope:
              claimScope === undefined
                ? 'unknown'
                : claimScope === null
                  ? 'every project'
                  : claimScope.length === 0
                    ? 'pick only'
                    : `${claimScope.length} project(s)`,
          },
          'this worker is connected to its core',
        );
        return true;
      } catch (error) {
        if (error instanceof CoreCallError && error.kind === 'unauthenticated') {
          connection = 'revoked';
          loggerPort.error(
            {},
            'the core does not accept this worker’s credential (revoked, or its user may not act); connect again from the worker’s page',
          );
          return false;
        }
        if (error instanceof CoreCallError && error.kind === 'upgrade_required') {
          connection = 'upgrade_required';
          loggerPort.error({ err: error }, 'the core does not serve this worker’s protocol');
          return false;
        }
        const wait = backoffMs(attempt);
        connection = 'core_unreachable';
        unreachable = { failure: coreFailureOf(error), retryAt: new Date(Date.now() + wait) };
        loggerPort.warn({ err: error, wait_ms: wait }, 'the handshake failed; it is retried');
        await pause(wait, signal);
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
      if (credential === null || core === null) return true;
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

  /** Claude refused the token on a run's stream (WP-294 (6)): no claim until a new sign-in. */
  const claudeWasRejected = (): void => {
    if (claudeRejected) return;
    claudeRejected = true;
    loggerPort.error(
      {},
      'Claude no longer accepts this worker’s sign-in: it claims nothing until you sign in again on the worker’s page',
    );
    restartCycle('claude_rejected');
  };

  const startSession = (client: CoreClient, pkg: RunPackage): void => {
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
      core: client.forRun(pkg.runId, pkg.runToken),
      claudeToken: claudeToken as string,
      onClaudeRejected: claudeWasRejected,
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

  const claimLoop = async (client: CoreClient, signal: AbortSignal): Promise<void> => {
    let failures = 0;
    while (!stopping && !signal.aborted && connection === 'connected') {
      // Drained or held by its owner: wait for *Resume* (WP-292) — never claim. A *take this one*
      // under way (WP-293) holds the loop the same way until it has started its run or failed.
      if (draining || manuallyPausedAt !== null || taking) {
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
        claimSentHoldingNothing = heldDigests.length === 0;
        const claiming = client.claim(
          credential as string,
          {
            free_slots: config.concurrency - sessions.size,
            image_digests: heldDigests,
            paused: false,
          },
          claimAbort.signal,
        );
        claimInFlight = claiming.then(
          () => undefined,
          () => undefined,
        );
        const pkg = await claiming;
        failures = 0;
        if (pkg !== null) startSession(client, pkg);
      } catch (error) {
        if (stopping || signal.aborted) break;
        if (reclaimNow) {
          reclaimNow = false;
          continue;
        }
        if (draining || manuallyPausedAt !== null || taking || usagePauseRemainingMs() > 0) {
          continue;
        }
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
        await pause(wait, signal);
      } finally {
        claimAbort = null;
        claimInFlight = null;
        claimSentHoldingNothing = false;
        reclaimNow = false;
      }
    }
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
    if (credential === null || core === null || connection !== 'connected') {
      throw new LocalUiError(
        409,
        'not_connected',
        'this worker is not connected to its platform yet, so it cannot be paused there',
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
  const clearDrainPause = async (signal: AbortSignal): Promise<void> => {
    if (!(await exists(drainMarker))) return;
    for (let attempt = 0; !stopping && !signal.aborted; attempt += 1) {
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
        await pause(backoffMs(attempt), signal);
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
      updateDrainSignalAt = null;
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
    if (via === 'worker_internal_drain') updateDrainSignalAt = Date.now();
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

  /** The worker's credential, or a `409` naming why the page cannot ask the core yet (WP-293). */
  const connectedCredential = (): string => {
    if (credential === null || core === null || connection !== 'connected') {
      throw new LocalUiError(
        409,
        'not_connected',
        'this worker is not connected to its core yet, so it cannot ask it',
      );
    }
    return credential;
  };
  /** The core client of a connected worker (checked by {@link connectedCredential} first). */
  const connectedCore = (): CoreClient => core as CoreClient;

  /** A core refusal in the page's words: its own status for a `4xx`, `502` when it did not answer. */
  const asLocalError = (error: unknown, what: string): LocalUiError => {
    if (error instanceof LocalUiError) return error;
    if (error instanceof CoreCallError && error.kind === 'upgrade_required') {
      return new LocalUiError(
        409,
        'upgrade_required',
        `the core does not serve this worker’s protocol, so it cannot ${what}: ${error.message}`,
      );
    }
    if (error instanceof CoreCallError && error.status !== null && error.status < 500) {
      return new LocalUiError(
        error.status === 422 ? 422 : 409,
        error.code ?? 'refused',
        `the core refused to ${what}: ${error.message}`,
      );
    }
    return new LocalUiError(
      502,
      'core_unreachable',
      `the core did not answer when asked to ${what}: ${(error as Error).message}`,
    );
  };

  /** The claim scope and the projects it may name, as the core holds them (WP-293). */
  const readClaimScope = async (): Promise<WorkerLocalClaimScope> => {
    const held = connectedCredential();
    try {
      const answer = await connectedCore().claimScope(held);
      claimScope = answer.claim_project_ids;
      claimPolicy = answer.claim_policy ?? claimPolicy;
      if (answer.policy_skipped_offers !== undefined) {
        policySkippedOffers = answer.policy_skipped_offers;
      }
      return workerLocalClaimScopeSchema.parse(redactKeysAndValues(pageRedactor(), answer));
    } catch (error) {
      throw asLocalError(error, 'read the claim scope');
    }
  };

  /** The owner sets what the automatic claims take (WP-293): the core first, then read back. */
  const writeClaimScope = async (
    projectIds: readonly string[] | null,
    policy?: WorkerClaimPolicy,
  ): Promise<WorkerLocalClaimScope> => {
    const held = connectedCredential();
    try {
      const answer = await connectedCore().setClaimScope(held, {
        claim_project_ids: projectIds === null ? null : [...projectIds],
        ...(policy === undefined ? {} : { claim_policy: policy }),
      });
      claimScope = answer.claim_project_ids;
      claimPolicy = answer.claim_policy ?? claimPolicy;
      loggerPort.info(
        {
          claim_scope:
            answer.claim_project_ids === null ? 'every project' : answer.claim_project_ids,
          claim_policy: answer.claim_policy ?? 'unknown',
          performed: answer.performed,
        },
        'this worker’s owner set what it takes by itself',
      );
    } catch (error) {
      throw asLocalError(error, 'set the claim scope');
    }
    // No call-off: the held claim re-reads the scope in its statement at every poll (≤ 5 s), and
    // calling it off would only log a false failure and back off.
    return readClaimScope();
  };

  /** What this worker could take now (WP-293): the core's list, through every exact secret. */
  const listOffers = async (): Promise<WorkerLocalOffers> => {
    const held = connectedCredential();
    try {
      const answer = await connectedCore().offers(held);
      if (answer.policy_skipped_offers !== undefined) {
        policySkippedOffers = answer.policy_skipped_offers;
      }
      return workerLocalOffersSchema.parse(redactKeysAndValues(pageRedactor(), answer));
    } catch (error) {
      throw asLocalError(error, 'list the offers');
    }
  };

  /**
   * *Take this one* (WP-293): the core's pick — the one claim narrowed to the run, its scope
   * ignored and nothing else — then the run starts here exactly as a claimed one does. A free slot
   * is needed; the claim loop's held request is called off first and the loop waits, so the pick
   * and an automatic claim never fill one slot twice. A held claim the core answered after it was
   * called off is released by the core, not sent nowhere (BACKLOG 960, `protocol.ts`'s
   * `deliverClaimed`); only a close landing while the answer is being written is left to the sweep.
   */
  const takeOffer = async (runId: string, asOf?: string): Promise<{ readonly run_id: string }> => {
    const held = connectedCredential();
    if (draining || manuallyPausedAt !== null) {
      throw new LocalUiError(
        409,
        'paused',
        'this worker is paused or draining: resume it before taking a run',
      );
    }
    if (usagePauseRemainingMs() > 0) {
      throw new LocalUiError(
        409,
        'usage_limited',
        'this worker’s Claude usage limit has not reset yet, so it takes nothing',
      );
    }
    if (taking) {
      throw new LocalUiError(409, 'take_in_progress', 'another take is under way; wait for it');
    }
    if (sessions.size >= config.concurrency) {
      throw new LocalUiError(
        409,
        'no_free_slot',
        `every slot of this worker is busy (${config.concurrency}); take one when a run ends`,
      );
    }
    taking = true;
    try {
      claimAbort?.abort();
      await claimInFlight;
      if (sessions.size >= config.concurrency) {
        throw new LocalUiError(
          409,
          'no_free_slot',
          'this worker claimed a run by itself just now and has no slot left',
        );
      }
      await refreshHeldDigests();
      let pkg: RunPackage;
      try {
        // S-26.4: the list's `as_of`, so a refusal can tell *taken a moment ago* from *someone's*.
        pkg = await connectedCore().takeOffer(held, runId, {
          image_digests: heldDigests,
          ...(asOf === undefined ? {} : { as_of: asOf }),
        });
      } catch (error) {
        throw asLocalError(error, 'hand over that run');
      }
      startSession(connectedCore(), pkg);
      loggerPort.info({ run_id: pkg.runId }, 'this worker’s owner took a run from the list');
      return { run_id: pkg.runId };
    } finally {
      taking = false;
      wakeClaims();
    }
  };

  // ── The wizard's actions (WP-294, TD-031's first-run amendment §8) ────────────────────────────

  /** The sign-in: the CLI's own, under a pty; what it reads is never logged (`claude-sign-in.ts`). */
  const signIn = createClaudeSignIn({
    launcher:
      options.claudeCli ?? scriptCliLauncher(config.claudeCliPath ?? DEFAULT_CLAUDE_CLI_PATH),
    logger: loggerPort,
    onSecret: (name, value) => rememberSecret(name, value),
    onToken: async (token) => {
      await writePrivateFile(config.stateDir, CLAUDE_TOKEN_FILE, token);
      rememberSecret(WORKER_SECRET_NAMES.claudeToken, token);
      claudeToken = token;
      claudeRejected = false;
      restartCycle('claude_signed_in');
    },
  });

  const refuseFromEnvironment = (what: 'platform' | 'claude'): void => {
    if (what === 'platform' && coreFromEnvironment) {
      throw new LocalUiError(
        409,
        'set_in_environment',
        'this worker’s platform comes from APP_CORE_URL in its environment: change it there',
      );
    }
    if (what === 'claude' && claudeFromEnvironment) {
      throw new LocalUiError(
        409,
        'set_in_environment',
        'this worker’s Claude sign-in comes from CLAUDE_CODE_OAUTH_TOKEN in its environment: change it there',
      );
    }
  };
  const refuseUnlessIdle = (): void => {
    if (sessions.size > 0) {
      throw new LocalUiError(
        409,
        'not_idle',
        'a run is in flight on this worker: drain it first, and change this once it is idle',
      );
    }
  };

  const refreshCandidates = async (): Promise<void> => {
    const list = [...DEFAULT_CORE_CANDIDATES, ...(config.coreCandidates ?? [])];
    candidates = await probeCoreCandidates(list, options.probeFetch);
  };

  const checkCore = async (address: string) => {
    try {
      return await checkCoreAddress(address, options.probeFetch);
    } catch (error) {
      if (error instanceof CoreCheckError) {
        throw new LocalUiError(422, error.failure, error.message);
      }
      throw error;
    }
  };

  /** *Connect to a platform* (`{ url }`) and *Change platform* (`{ url: null }`). */
  const setCore = async (address: string | null): Promise<void> => {
    refuseFromEnvironment('platform');
    if (address !== null) {
      if (coreUrl !== null) {
        throw new LocalUiError(
          409,
          'platform_set',
          'this worker already has a platform: change platform first',
        );
      }
      const found = await checkCore(address);
      await writePrivateFile(config.stateDir, CORE_URL_FILE, found.url);
      coreUrl = found.url;
      candidates = [];
      loggerPort.info({ core_url: found.url }, 'this worker’s platform is chosen on its page');
      restartCycle('platform_chosen');
      return;
    }
    refuseUnlessIdle();
    // Repointing never carries the developer's Claude sign-in (TD-031's no-bearer amendment §3).
    if (uiAuth === 'none') refuseFromEnvironment('claude');
    await removeFile(config.stateDir, CORE_URL_FILE);
    await removeFile(config.stateDir, CREDENTIAL_FILE);
    if (uiAuth === 'none') {
      signIn.cancel();
      await removeFile(config.stateDir, CLAUDE_TOKEN_FILE);
      claudeToken = null;
      claudeRejected = false;
    }
    coreUrl = null;
    credential = null;
    workerId = null;
    workerName = null;
    coreProtocol = null;
    coreDigests = null;
    lastHandshakeAt = null;
    manuallyPausedAt = null;
    usagePausedUntil = null;
    loggerPort.info(
      {},
      'this worker’s platform was forgotten on its page; its credential is deleted',
    );
    restartCycle('platform_forgotten');
  };

  const startSignIn = async (action: 'start' | 'cancel'): Promise<void> => {
    refuseFromEnvironment('claude');
    if (action === 'cancel') {
      signIn.cancel();
      return;
    }
    // An update's drain waits for a sign-in in progress (`idle`); a new one would postpone it
    // again, and a sequence of them forever (BACKLOG 1054). The one running, its code and a paste
    // stay allowed. An owner's page *Drain* refuses nothing here, and an update's only while the
    // updater still waits: the setup screens offer no *Resume*, and the owner's rule is that no
    // setup step may trap a person.
    if (updateDrainRefusesSignIn()) {
      throw new LocalUiError(
        409,
        'draining',
        'this worker is draining for an update: it starts no new Claude sign-in until it restarts; paste a token instead',
      );
    }
    try {
      await signIn.start();
    } catch (error) {
      if (error instanceof SignInBusyError)
        throw new LocalUiError(409, 'sign_in_busy', error.message);
      throw error;
    }
  };

  const submitCode = (code: string): void => {
    refuseFromEnvironment('claude');
    try {
      signIn.submitCode(code);
    } catch (error) {
      if (error instanceof SignInBusyError) {
        throw new LocalUiError(409, 'not_waiting_for_code', error.message);
      }
      throw error;
    }
  };

  /** A paste wins over a browser sign-in; whitespace inside it is removed (`claude-sign-in.ts`). */
  const acceptToken = (token: string): void => {
    refuseFromEnvironment('claude');
    try {
      signIn.acceptToken(token);
    } catch (error) {
      // Never echoed: a malformed paste may still be most of a secret.
      if (error instanceof InvalidClaudeTokenError)
        throw new LocalUiError(400, 'invalid_token', error.message);
      if (error instanceof SignInBusyError)
        throw new LocalUiError(409, 'token_check_running', error.message);
      throw error;
    }
  };

  /** *Sign out / change Claude account*: deletes the stored token; Anthropic still holds it. */
  const signOut = async (): Promise<void> => {
    refuseFromEnvironment('claude');
    refuseUnlessIdle();
    signIn.cancel();
    await removeFile(config.stateDir, CLAUDE_TOKEN_FILE);
    claudeToken = null;
    claudeRejected = false;
    loggerPort.info({}, 'the Claude sign-in was removed from this worker on its page');
    restartCycle('claude_signed_out');
  };

  /** *Connect again* after a revocation: a new device flow, no restart. */
  const connectAgain = async (): Promise<void> => {
    if (connection !== 'revoked') {
      throw new LocalUiError(409, 'not_revoked', 'this worker’s credential was not refused');
    }
    await removeFile(config.stateDir, CREDENTIAL_FILE);
    credential = null;
    restartCycle('connect_again');
  };

  /**
   * *Error reporting* (WP-295): *Save* a DSN, or *Remove* it with `null` — applied **without a
   * restart** (the reporter closes its client and builds a new one). Refused while `SENTRY_DSN` is
   * set in the environment, which wins; a malformed DSN is `422`, never echoed.
   */
  const setErrorReporting = async (dsn: string | null): Promise<void> => {
    if (sentryFromEnvironment) {
      throw new LocalUiError(
        409,
        'set_in_environment',
        'this worker’s error reporting comes from SENTRY_DSN in its environment: change it there',
      );
    }
    if (dsn === null) {
      await removeFile(config.stateDir, SENTRY_DSN_FILE);
      await errorReporter.configure(null);
      loggerPort.info({}, 'error reporting was turned off on this worker’s page');
      return;
    }
    const verdict = errorReporting.parseErrorReportingDsn(dsn);
    if (!verdict.ok) {
      throw new LocalUiError(422, 'invalid_dsn', `that is not ${errorReporting.DSN_SHAPE_WORDS}`);
    }
    await writePrivateFile(config.stateDir, SENTRY_DSN_FILE, verdict.dsn);
    await errorReporter.configure(verdict.dsn);
    loggerPort.info({ host: verdict.host }, 'error reporting is on: set on this worker’s page');
  };

  /** *Send a test error* (WP-295): one event through the reporter, then a bounded flush. */
  const testErrorReporting = async (): Promise<WorkerLocalErrorReportingTestResponse> => {
    if (errorReporter.dsn() === null) {
      throw new LocalUiError(
        409,
        'error_reporting_off',
        'error reporting is off on this worker: save a DSN first',
      );
    }
    const error = new ErrorReportingTestError('this worker’s page');
    const eventId = errorReporter.report({ error, message: error.message, tags: reportTags() });
    const delivered = await errorReporter.flush(ERROR_REPORTING_TEST_FLUSH_MS);
    return workerLocalErrorReportingTestResponseSchema.parse({
      event_id: eventId,
      delivered: eventId !== null && delivered,
    });
  };

  /**
   * *Try now*: the core is asked again at once — or, on a connected worker whose launcher did not
   * answer or holds no image (S-22.19, R-L3), the launcher is, and the claim loop woken. A connected
   * worker with nothing to ask again answers `409`.
   */
  const retry = async (): Promise<void> => {
    if (connection === 'connected') {
      if (launcherReach === 'ok' && heldDigests.length > 0) {
        throw new LocalUiError(409, 'connected', 'this worker is connected');
      }
      await refreshHeldDigests();
      wakeClaims();
      return;
    }
    restartCycle('retry');
  };

  /**
   * Every secret this worker knows (WP-292): the log's — the Claude tokens, the credential, each
   * live run's token and run credential, the wizard's code — and the page's own token.
   */
  const pageRedactor = () => exactSecretRedactor([...logSecrets.values()]);

  /** The approval link, only on the core's own origin (TD-031's first-run amendment §5). */
  const approveUrlOf = (code: NonNullable<typeof device>): string | null => {
    if (coreUrl === null) return null;
    try {
      const link = new URL(code.verificationUri);
      if (link.origin !== new URL(coreUrl).origin) return null;
      link.searchParams.set('code', code.userCode);
      return link.toString();
    } catch {
      return null;
    }
  };

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
      core_url: coreUrl,
      last_handshake_at: lastHandshakeAt,
      manually_paused_at: manuallyPausedAt,
      // A pause that has passed is no pause: the page says *taking work* again by itself.
      usage_paused_until: usagePauseRemainingMs() > 0 ? usagePausedUntil : null,
      usage_paused_estimated: usagePauseRemainingMs() > 0 && usagePausedEstimated,
      draining,
      launcher: launcherReach,
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
      setup: {
        core_source: coreUrl === null ? null : coreFromEnvironment ? 'environment' : 'file',
        candidates: candidates.slice(0, 8),
        claude_source: claudeToken === null ? null : claudeFromEnvironment ? 'environment' : 'file',
        claude_rejected: claudeRejected,
        sign_in: signIn.status(),
        device:
          device === null || connection !== 'logging_in'
            ? null
            : {
                user_code: device.userCode,
                approve_url: approveUrlOf(device),
                expires_at: device.expiresAt.toISOString(),
              },
        unreachable:
          unreachable === null || connection !== 'core_unreachable'
            ? null
            : {
                failure: unreachable.failure,
                retry_at: unreachable.retryAt === null ? null : unreachable.retryAt.toISOString(),
              },
        idle: sessions.size === 0,
        auth: uiAuth,
      },
      claim_blockers: localClaimBlockersOf({
        connection,
        claudeRejected,
        manuallyPaused: manuallyPausedAt !== null,
        draining,
        usagePaused: usagePauseRemainingMs() > 0,
        launcherAnswered: launcherReach === 'unknown' ? null : launcherReach === 'ok',
        heldDigests,
        coreDigests:
          coreDigests === null
            ? null
            : { run: coreDigests.platform_runtime, egress: coreDigests.platform_egress },
      }),
      claim_policy: claimPolicy,
      policy_skipped_offers: policySkippedOffers,
      // What the reporter sends to now, not what was stored: a client that failed to build is *Off*.
      error_reporting: ((dsn: string | null) => ({
        source: dsn === null ? null : sentryFromEnvironment ? 'environment' : 'file',
        host: dsn === null ? null : new URL(dsn).host,
      }))(errorReporter.dsn()),
      started_at: startedAt,
      server_time: new Date(now).toISOString(),
    };
    return workerLocalStateSchema.parse(redactKeysAndValues(pageRedactor(), value));
  };

  /** One cycle: the first unsatisfied step waits for the page; then login, handshake, claims. */
  const runCycle = async (signal: AbortSignal): Promise<void> => {
    device = null;
    unreachable = null;
    if (coreUrl === null) {
      connection = 'needs_platform';
      // Nothing is asked of any core until the person chose one (WP-294 (1)).
      void refreshCandidates();
      await untilRestart(signal);
      return;
    }
    if (claudeToken === null || claudeRejected) {
      connection = 'needs_claude';
      await untilRestart(signal);
      return;
    }
    const origin = new URL(coreUrl).origin;
    const client = createCoreClient({
      baseUrl: coreUrl,
      ...(options.coreFetch === undefined ? {} : { fetch: options.coreFetch }),
    });
    core = client;
    connection = 'logging_in';
    credential = await ensureCredential({
      core: client,
      stateDir: config.stateDir,
      origin,
      logger: loggerPort,
      stopped: () => stopping || signal.aborted,
      sleep: (ms) => pause(ms, signal),
      onCode: (code) => {
        device = code;
        unreachable = null;
        connection = 'logging_in';
      },
      onUnreachable: (error, wait) => {
        connection = 'core_unreachable';
        unreachable = { failure: coreFailureOf(error), retryAt: new Date(Date.now() + wait) };
      },
    });
    device = null;
    if (credential === null || signal.aborted) return;
    rememberSecret('worker_credential', credential);
    if (!(await handshake(client, signal))) return;
    await clearDrainPause(signal);
    await claimLoop(client, signal);
  };

  // Asked at once, before (and whatever) the wizard asks: the page says whether the launcher answers
  // even while this worker has no platform yet, and the watch starts if it does not (backlog 980).
  void refreshHeldDigests();

  const main = (async () => {
    while (!stopping) {
      const signal = cycle.signal;
      try {
        await runCycle(signal);
      } catch (error) {
        if (error instanceof CoreCallError && error.kind === 'upgrade_required') {
          connection = 'upgrade_required';
        }
        loggerPort.error({ err: error }, 'the remote worker stopped claiming after an error');
      }
      if (stopping) break;
      // Ended by itself (revoked, upgrade required, an error): wait for the page or a stop.
      await untilRestart(signal);
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
    // An update's drain waits for this: no run, and no Claude sign-in half done (a restart
    // mid-sign-in leaves the person at step 2 with nothing to show for it).
    idle: sessions.size === 0 && !signIn.inProgress(),
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
      // Ready is connected **and** a launcher that answers (backlog 980): the updater's apply checks
      // this, so an update is not called good while its worker cannot reach its launcher.
      const connected = connection === 'connected';
      const ok = connected && launcherReach === 'ok';
      send(response, ok ? 200 : 503, {
        status: ok ? 'ok' : 'down',
        checks: { core_handshake: connected ? 'ok' : connection, launcher: launcherReach },
      });
      return;
    }
    if (request.method === 'GET' && path === '/internal/state') {
      // The updater waiting for idle reads this: its update's drain still holds (see the hold).
      if (draining && updateDrainSignalAt !== null) updateDrainSignalAt = Date.now();
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

  /** The page's answer to a wizard action: its state after it, or the refusal it raised. */
  const acting =
    <A extends unknown[]>(action: (...args: A) => Promise<void> | void) =>
    async (...args: A): Promise<WorkerLocalState> => {
      await action(...args);
      return localState();
    };

  /**
   * The local page's listener (WP-292): only when `APP_WORKER_UI=enabled`. Under
   * `APP_WORKER_UI_AUTH=token` the token is created once in `worker-state` and the page's address is
   * logged **once per start**, written straight to the process's output — the one line that carries
   * the token, which every other line, the log tail and every local answer redact. Under `none`
   * (the default) no token exists and the plain address is logged (TD-031's no-bearer amendment).
   */
  const listenUi = async (): Promise<void> => {
    const ui = config.ui;
    if (ui === undefined || !ui.enabled) {
      loggerPort.info({}, 'the local page is disabled (APP_WORKER_UI=disabled): no port is open');
      return;
    }
    let token: string | null = null;
    if (uiAuth === 'token') {
      token = await ensureUiToken(config.stateDir);
      rememberSecret('worker_ui_token', token);
    }
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
        claimScope: readClaimScope,
        setClaimScope: writeClaimScope,
        offers: listOffers,
        take: takeOffer,
        checkCore,
        setCore: acting(setCore),
        signIn: acting(startSignIn),
        claudeCode: acting(submitCode),
        claudeToken: acting(acceptToken),
        signOut: acting(signOut),
        connectAgain: acting(connectAgain),
        retry: acting(retry),
        errorReporting: acting(setErrorReporting),
        errorReportingTest: testErrorReporting,
      },
    });
    uiServer = listening;
    uiAddress = await bind(listening, ui.listenPort, ui.host);
    const address =
      token === null ? plainUiAddressOf(ui.publishedPort) : uiAddressOf(ui.publishedPort, token);
    rawDestination.write(
      `${JSON.stringify({
        level: 30,
        time: Date.now(),
        role: REMOTE_WORKER_ROLE,
        msg:
          token === null
            ? `this worker's page: ${address} (open it on this machine)`
            : `this worker's page: ${address} (open it on this machine; the address is printed at every start — delete ui-token in the worker-state volume to change it)`,
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
    errorReporter,
    stop: async () => {
      stopping = true;
      cycle.abort();
      claimAbort?.abort();
      slotFreed?.();
      await signIn.close();
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
      // Last: an error line written while stopping is still sent.
      await errorReporter.close();
    },
  };
};
