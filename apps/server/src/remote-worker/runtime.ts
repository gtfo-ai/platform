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
 *    what the updater asks before it applies, TD-032 decision 6) and `GET /internal/state`.
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
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from '@platform/application';
import { exactSecretRedactor } from '@platform/application';
import {
  type CoreImageDigests,
  type RunPackage,
  shaSchema,
  WORKER_PROTOCOL_VERSION,
  type WorkerProtocolRange,
} from '@platform/contracts';
import { launcher as launcherAdapters, runner as runnerAdapters } from '@platform/infrastructure';
import type { DestinationStream } from 'pino';
import { asLoggerPort, createLogger, type PinoLogger } from '../logging.js';
import { repositoryPathOf } from '../pipeline.js';
import { loadRemoteWorkerConfig, REMOTE_WORKER_ROLE, type RemoteWorkerConfig } from './config.js';
import { CoreCallError, type CoreFetch, createCoreClient, isTransient } from './core-client.js';
import { ensureCredential } from './credential.js';
import { backoffMs, sleepMs } from './retry.js';
import { type RunSession, startRunSession, WORKER_SECRET_NAMES } from './run-session.js';
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
}

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
  /** Starts the local listener; answers its address. */
  listen(): Promise<string>;
  /** Stop claiming and let the runs in flight finish (`POST /internal/drain`). */
  drain(): void;
  state(): RemoteWorkerState;
  /** The sessions in flight, by run id — a test reads how each one ended. */
  readonly sessions: ReadonlyMap<string, RunSession>;
  /** Every session this worker started, in order, kept after it ended. */
  readonly history: readonly RunSession[];
  /** Stop claiming, hand every run back, close the listener. */
  stop(): Promise<void>;
}

/** A pino destination that replaces every value of `secrets()` in each line before it is written. */
const redactingDestination = (
  inner: DestinationStream,
  secrets: () => readonly { readonly name: string; readonly value: string }[],
): DestinationStream => ({
  write: (line: string) => {
    const known = secrets();
    inner.write(known.length === 0 ? line : exactSecretRedactor(known).redactText(line).value);
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
  const destination = redactingDestination(
    options.logDestination ?? { write: (line: string) => process.stdout.write(line) },
    () => [...logSecrets.values()],
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
  let heldDigests: string[] = [];
  const sessions = new Map<string, RunSession>();
  const history: RunSession[] = [];
  let claimAbort: AbortController | null = null;
  let slotFreed: (() => void) | null = null;

  /**
   * The digests this worker **holds** — only what its launcher resolves on the local daemon now
   * (backlog 704): its health check answers the run and egress images it is configured with, by the
   * daemon's id, or `null` when either is missing. Resolved, they are held under both names — the
   * id and the registry digest of the pinned reference the launcher resolved, which is the one a
   * core advertises. Unresolved, or with no launcher answer, nothing is held and no offer matches —
   * so a worker whose images are still being pulled claims nothing it could not start.
   */
  const refreshHeldDigests = async (): Promise<void> => {
    try {
      const health = await launcher.health();
      heldDigests =
        health.images === null
          ? []
          : [...new Set([...config.imageDigests, health.images.run, health.images.egress])];
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
    while (!stopping && !draining && connection === 'connected') {
      if (sessions.size >= config.concurrency) {
        await new Promise<void>((resolve) => {
          slotFreed = resolve;
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
        if (stopping || draining) break;
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

  const drain = (): void => {
    if (draining) return;
    draining = true;
    claimAbort?.abort();
    slotFreed?.();
    loggerPort.info({ runs: sessions.size }, 'this worker is draining: it claims nothing more');
  };

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
      drain();
      send(response, 202, state());
      return;
    }
    send(response, 404, { error: { code: 'not_found', message: `${path} is not served here` } });
  };
  let server: Server | null = null;

  return {
    config,
    logger,
    sessions,
    history,
    listen: async () => {
      const listening = createServer(handle);
      server = listening;
      await new Promise<void>((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(config.port, config.host, () => resolve());
      });
      const address = listening.address();
      const port = typeof address === 'object' && address !== null ? address.port : config.port;
      return `http://${config.host}:${port}`;
    },
    drain,
    state,
    stop: async () => {
      stopping = true;
      claimAbort?.abort();
      slotFreed?.();
      for (const session of sessions.values()) session.shutdown();
      await Promise.all([...sessions.values()].map((session) => session.done));
      await main;
      connection = 'stopped';
      const open = server;
      server = null;
      if (open !== null) {
        await new Promise<void>((resolve) => open.close(() => resolve()));
      }
    },
  };
};
