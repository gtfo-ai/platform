/**
 * The launcher's composition root: environment in, a running {@link LauncherService} out.
 *
 * Separate from `index.ts` so everything except `process.exit` and signal wiring can be driven by
 * a test — the same split `apps/server` uses for `runtime.ts` and `main.ts`, and the reason
 * `index.ts` is the only file here excluded from coverage.
 */
import type { Logger, RunnerClock } from '@platform/application';
import { workspace } from '@platform/infrastructure';
import { type LauncherConfig, readLauncherConfig } from './config.js';
import { asLoggerPort, createLauncherLogger } from './logging.js';
import { LauncherService } from './service.js';

export interface LauncherRuntime {
  readonly config: LauncherConfig;
  readonly service: LauncherService;
  readonly provider: workspace.DockerWorkspaceProvider;
  readonly logger: Logger;
  stop(): void;
}

export interface BuildLauncherOptions {
  readonly env: Record<string, string | undefined>;
  /** The credential source the broker mints through. The server wires GitLab's here. */
  readonly credentials: workspace.RunCredentialSource;
  /** `process.getuid()` in production. Q51: the runner and the run container share uid 1000. */
  readonly uid: number;
  readonly logger?: Logger;
}

/**
 * Builds the launcher.
 *
 * The uid check is not negotiable: the shim creates its control socket `0600` as uid 1000, so a
 * launcher on another uid produces runs whose control connection is refused with `EACCES` — a
 * failure that looks like a protocol fault three minutes into a run instead of a startup error
 * (Q51).
 *
 * It is **not** the first thing that happens, and saying so would be the kind of invariant a
 * comment asserts and nothing holds (standing rule 3). It happens where it belongs, in
 * `DockerWorkspaceProvider`'s constructor — the fourth step here, after the config, the logger and
 * the engine. What makes that equivalent for the property that matters is that none of the three
 * before it touches the daemon or the filesystem: `readLauncherConfig` parses environment,
 * `createLauncherLogger` builds a pino instance, and `new DockerEngine` stores an address without
 * connecting to it. So a launcher on the wrong uid still fails at startup, with both numbers
 * named, before anything has been created.
 */
/**
 * The launcher's clock — `systemClock` **without** the `unref`, and that is what keeps the
 * container alive (WP-22).
 *
 * `runner.systemClock` unrefs every timer it arms, deliberately: in `apps/server` the deadlines are
 * a run's stall detector and its wall clock, and a pending one must never be the reason a process
 * that is otherwise finished stays up. The launcher is the opposite shape. It has **no** server, no
 * socket and no queue worker — Q52's transport is unbuilt — so the retention sweep's timer is the
 * only handle it owns, and with that timer unrefed `main()` returns, the event loop empties, and the
 * process exits 0 having done nothing.
 *
 * Measured at WP-22 against the composed container, which is the only place it can be seen: the
 * launcher logged `launcher started` and exited, and `restart: unless-stopped` looped it about once
 * a second — a crash-loop with no error in it, and a retention sweep that never ran. The same code
 * in the unit tier is green, because a test process has its own reasons to stay alive.
 *
 * So the sweep keeps the process up, which is also the honest statement of what this container is
 * for today. `service.stop()` cancels it, so SIGTERM still ends the process rather than waiting out
 * the interval.
 */
export const launcherClock: RunnerClock = {
  now: () => Date.now(),
  setTimer: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  },
};

export const buildLauncher = (options: BuildLauncherOptions): LauncherRuntime => {
  const config = readLauncherConfig(options.env);
  const logger = options.logger ?? asLoggerPort(createLauncherLogger({ level: config.logLevel }));
  const engine = new workspace.DockerEngine({
    ...config.engine,
    logger,
    maxResponseBytes: config.maxExportBytes,
  });
  const provider = new workspace.DockerWorkspaceProvider({
    engine,
    images: config.images,
    controlVolume: config.controlVolume,
    controlRoot: config.controlRoot,
    cacheVolume: config.cacheVolume,
    helperNetwork: config.helperNetwork,
    egressNetwork: config.egressNetwork,
    logger,
    runnerUid: options.uid,
    maxExportBytes: config.maxExportBytes,
  });
  const service = new LauncherService({
    provider,
    broker: new workspace.RunCredentialBroker(options.credentials, logger),
    clock: launcherClock,
    logger,
    exportDir: config.exportDir,
    retentionSweepMs: config.retentionSweepMs,
  });
  if (config.images.runtimeSourceDir !== null) {
    logger.warn(
      { source_dir: config.images.runtimeSourceDir },
      'run containers mount the repository read-only from APP_WORKSPACE_RUNTIME_SOURCE_DIR; the ' +
        'platform-runtime image needs no such mount and technical/05 forbids one, so this is a ' +
        'development configuration',
    );
  }
  service.startRetentionSweep();
  return {
    config,
    service,
    provider,
    logger,
    stop: () => service.stop(),
  };
};
