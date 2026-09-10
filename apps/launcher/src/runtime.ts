/**
 * The launcher's composition root: environment in, a running {@link LauncherService} out.
 *
 * Separate from `index.ts` so everything except `process.exit` and signal wiring can be driven by
 * a test — the same split `apps/server` uses for `runtime.ts` and `main.ts`, and the reason
 * `index.ts` is the only file here excluded from coverage.
 */
import type { Logger } from '@platform/application';
import { runner, workspace } from '@platform/infrastructure';
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
    clock: runner.systemClock,
    logger,
    exportDir: config.exportDir,
    retentionSweepMs: config.retentionSweepMs,
  });
  if (config.images.runtimeSourceDir !== null) {
    logger.warn(
      { source_dir: config.images.runtimeSourceDir },
      'run containers mount the repository read-only because the platform-runtime image does not ' +
        'exist yet (WP-22); this is not a production configuration',
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
