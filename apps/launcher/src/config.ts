/**
 * The launcher's configuration (TD-020 naming: `APP_*` for platform settings, tool-native names
 * for tools).
 *
 * `DOCKER_HOST` is tool-native on purpose — it is the variable an operator already knows and the
 * one `docker` itself reads, so a compose file that points the CLI and the launcher at the same
 * daemon sets one thing. TD-021 puts `docker-socket-proxy` in front of it, which speaks the Engine
 * API over TCP, so both forms have to work and both are parsed here rather than guessed at the
 * call site.
 *
 * Strict, so a typo is a startup failure rather than a default (the same reasoning as the shim's
 * `runletEnvSchema`): a launcher that silently fell back to `platform-runtime:latest` because
 * `APP_WORKSPACE_RUNTME_IMAGE` was misspelt would start every run on the wrong image.
 */
import * as z from 'zod';

const positiveInt = z.coerce.number().int().positive();

export const launcherEnvSchema = z.strictObject({
  DOCKER_HOST: z.string().min(1).optional(),
  APP_WORKSPACE_CONTROL_VOLUME: z.string().min(1).optional(),
  APP_WORKSPACE_CONTROL_ROOT: z.string().min(1).optional(),
  APP_WORKSPACE_CACHE_VOLUME: z.string().min(1).optional(),
  APP_WORKSPACE_RUNTIME_IMAGE: z.string().min(1).optional(),
  APP_WORKSPACE_EGRESS_IMAGE: z.string().min(1).optional(),
  APP_WORKSPACE_GIT_IMAGE: z.string().min(1).optional(),
  APP_WORKSPACE_RUNTIME_SOURCE_DIR: z.string().optional(),
  APP_WORKSPACE_HELPER_NETWORK: z.string().min(1).optional(),
  APP_WORKSPACE_EGRESS_NETWORK: z.string().min(1).optional(),
  APP_WORKSPACE_EXPORT_DIR: z.string().min(1).optional(),
  APP_WORKSPACE_RETENTION_SWEEP_MS: positiveInt.optional(),
  APP_WORKSPACE_MAX_EXPORT_BYTES: positiveInt.optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
});

export interface EngineAddressConfig {
  readonly socketPath?: string;
  readonly host?: string;
  readonly port?: number;
}

export interface LauncherConfig {
  readonly engine: EngineAddressConfig;
  readonly controlVolume: string;
  readonly controlRoot: string;
  readonly cacheVolume: string;
  readonly images: {
    readonly runtime: string;
    readonly egress: string;
    readonly git: string;
    readonly runtimeSourceDir: string | null;
  };
  readonly helperNetwork: string;
  readonly egressNetwork: string;
  readonly exportDir: string;
  readonly retentionSweepMs: number;
  readonly maxExportBytes: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export class LauncherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LauncherConfigError';
  }
}

/**
 * Parses `DOCKER_HOST`.
 *
 * Only the two forms the platform deploys: a Unix socket and a plain TCP endpoint. `ssh://` and
 * `tcp://` **with TLS** are deliberately refused rather than silently downgraded — TD-021's whole
 * point is that exactly one component reaches the daemon, and "the launcher quietly talked to a
 * different daemon than the operator meant" is the failure that has no symptom until a container
 * appears somewhere unexpected.
 */
export const parseDockerHost = (value: string | undefined): EngineAddressConfig => {
  const raw =
    value === undefined || value.trim().length === 0 ? 'unix:///var/run/docker.sock' : value.trim();
  if (raw.startsWith('unix://')) {
    const socketPath = raw.slice('unix://'.length);
    if (socketPath.length === 0 || !socketPath.startsWith('/')) {
      throw new LauncherConfigError(`DOCKER_HOST names no socket path: ${raw}`);
    }
    return { socketPath };
  }
  if (raw.startsWith('tcp://')) {
    const [host = '', port = ''] = raw.slice('tcp://'.length).split(':');
    const parsed = Number.parseInt(port, 10);
    if (host.length === 0 || !Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new LauncherConfigError(`DOCKER_HOST is not host:port: ${raw}`);
    }
    return { host, port: parsed };
  }
  throw new LauncherConfigError(
    `DOCKER_HOST must be unix:///path or tcp://host:port (got ${raw.split('://')[0] ?? raw})`,
  );
};

const HOUR_MS = 60 * 60 * 1000;

export const readLauncherConfig = (env: Record<string, string | undefined>): LauncherConfig => {
  const present = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        value !== undefined &&
        (key === 'DOCKER_HOST' || key === 'LOG_LEVEL' || key.startsWith('APP_WORKSPACE_')),
    ),
  );
  const parsed = launcherEnvSchema.parse(present);
  const sourceDir = parsed.APP_WORKSPACE_RUNTIME_SOURCE_DIR ?? '';
  return {
    engine: parseDockerHost(parsed.DOCKER_HOST),
    controlVolume: parsed.APP_WORKSPACE_CONTROL_VOLUME ?? 'agentic-ctl',
    controlRoot: parsed.APP_WORKSPACE_CONTROL_ROOT ?? '/run/agentic/ctl',
    cacheVolume: parsed.APP_WORKSPACE_CACHE_VOLUME ?? 'agentic-repo-cache',
    images: {
      runtime: parsed.APP_WORKSPACE_RUNTIME_IMAGE ?? 'platform-runtime:latest',
      egress: parsed.APP_WORKSPACE_EGRESS_IMAGE ?? 'platform-egress:latest',
      // Pinned by tag, and the mirror/clone/export helpers are the only things that use it. WP-22
      // replaces it with a digest in the compose file.
      git: parsed.APP_WORKSPACE_GIT_IMAGE ?? 'alpine/git:v2.49.1',
      runtimeSourceDir: sourceDir.length === 0 ? null : sourceDir,
    },
    helperNetwork: parsed.APP_WORKSPACE_HELPER_NETWORK ?? 'bridge',
    egressNetwork: parsed.APP_WORKSPACE_EGRESS_NETWORK ?? 'bridge',
    exportDir: parsed.APP_WORKSPACE_EXPORT_DIR ?? '/var/lib/app/exports',
    retentionSweepMs: parsed.APP_WORKSPACE_RETENTION_SWEEP_MS ?? HOUR_MS,
    maxExportBytes: parsed.APP_WORKSPACE_MAX_EXPORT_BYTES ?? 128 * 1024 * 1024,
    logLevel: parsed.LOG_LEVEL ?? 'info',
  };
};
