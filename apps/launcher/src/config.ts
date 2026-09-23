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
import { db, workspace } from '@platform/infrastructure';
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
  APP_WORKSPACE_RUNTIME_CLI_PATH: z.string().min(1).optional(),
  APP_LAUNCHER_TOKEN: z.string().min(1).optional(),
  APP_LAUNCHER_HOST: z.string().min(1).optional(),
  APP_LAUNCHER_PORT: positiveInt.max(65_535).optional(),
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
    /** Where the `claude` binary is inside the run image (PROGRESS backlog 34). */
    readonly runtimeCliPath: string;
  };
  /**
   * TD-028's control plane, or `null` for a launcher that exposes none.
   *
   * **`null` is the fail-closed answer to a missing `APP_LAUNCHER_TOKEN`**, not a default that
   * opens the surface: a control plane that creates containers must never come into existence
   * because a variable was forgotten (standing rules 18 and 55, and the same shape `DOCKER_HOST`'s
   * refusal has). A launcher started this way runs its retention sweep and nothing can talk to it,
   * which the start-up log says in as many words.
   */
  readonly controlPlane: {
    readonly token: string;
    readonly host: string;
    readonly port: number;
  } | null;
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
 *
 * ## Absent is a startup error, and it used to be the host socket
 *
 * Until WP-15g an unset (or blank) `DOCKER_HOST` returned `/var/run/docker.sock` — reproduced from
 * `readLauncherConfig({})` with nothing set at all. So *absence of configuration granted the
 * unfiltered daemon that TD-021 deploys `docker-socket-proxy` to remove*: an operator who forgot
 * the variable got the most privileged arrangement the decision forbids, silently, and the only
 * symptom would be a container created through an unfiltered API. That is standing rule **55**'s
 * shape — a guard whose default is the thing it exists to prevent — and standing rule **18**'s: an
 * unset value must not produce the permissive result. TD-021's WP-15g amendment requires the
 * refusal; `.env.example` already documented it.
 *
 * The cost is stated: a launcher started with no `DOCKER_HOST` no longer starts. That is the point —
 * one line in a compose file (or `unix:///var/run/docker.sock` written out, which is then a
 * *decision* somebody made) against a daemon nobody chose.
 */
export const parseDockerHost = (value: string | undefined): EngineAddressConfig => {
  if (value === undefined || value.trim().length === 0) {
    throw new LauncherConfigError(
      'DOCKER_HOST is required and has no default: it must be unix:///path or tcp://host:port. ' +
        'TD-021 puts docker-socket-proxy in front of the daemon and this is the only component ' +
        'that may reach either, so an absent value must not silently select the host socket.',
    );
  }
  const raw = value.trim();
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

/** TD-028 decision 2's port. Never published; only the runner container joins the network. */
export const DEFAULT_CONTROL_PLANE_PORT = 7780;

/**
 * The shortest `APP_LAUNCHER_TOKEN` this launcher will start with.
 *
 * It is instance configuration rather than a credential the launcher mints (TD-028 decision 3), so
 * nothing here can generate it — which makes the only protection against a two-character one a
 * refusal. Thirty-two characters is what `.env.example` tells an operator to generate and what
 * `APP_SECRET_KEY` already demands.
 */
export const MIN_LAUNCHER_TOKEN_LENGTH = 32;

export const readLauncherConfig = (env: Record<string, string | undefined>): LauncherConfig => {
  const present = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        /*
         * **Blank is absent, not present-and-empty** — WP-53, found by `compose-stock-check.mjs`.
         *
         * Every name below is declared `.min(1).optional()`, so an empty string reaching this strict
         * schema is a *parse error* rather than a default: `readLauncherConfig` threw,
         * `buildLauncher` threw, the process exited 1 and `restart: unless-stopped` looped the
         * launcher container for ever. And an empty value is exactly what a stock instance has,
         * because `.env.example` ships `APP_LAUNCHER_TOKEN=` with no value and `compose.yml`
         * interpolates it as `${APP_LAUNCHER_TOKEN:-}` — so the shipped file and the shipped schema
         * disagreed, invisibly to every tier without a daemon.
         *
         * It is the same rule `readEnvWithFile` below and `nullableString` in `apps/server` already
         * apply, and the same direction standing rule 18 asks for: an unset value must reach the
         * code that decides what absence *means* (here: no control plane) rather than the parser.
         */
        value !== undefined &&
        value.trim() !== '' &&
        (key === 'DOCKER_HOST' ||
          key === 'LOG_LEVEL' ||
          key.startsWith('APP_WORKSPACE_') ||
          // `APP_LAUNCHER_TOKEN_FILE` is read by `readEnvWithFile` below and must not reach the
          // strict schema, which is why the filter names the three exactly rather than the prefix.
          key === 'APP_LAUNCHER_HOST' ||
          key === 'APP_LAUNCHER_PORT' ||
          key === 'APP_LAUNCHER_TOKEN'),
    ),
  );
  // TD-020's `_FILE` convention, resolved before the schema sees the name it shadows.
  const token = db.readEnvWithFile('APP_LAUNCHER_TOKEN', env);
  const parsed = launcherEnvSchema.parse(
    token === undefined ? present : { ...present, APP_LAUNCHER_TOKEN: token },
  );
  const sourceDir = parsed.APP_WORKSPACE_RUNTIME_SOURCE_DIR ?? '';
  const launcherToken = parsed.APP_LAUNCHER_TOKEN?.trim() ?? '';
  if (launcherToken.length > 0 && launcherToken.length < MIN_LAUNCHER_TOKEN_LENGTH) {
    throw new LauncherConfigError(
      `APP_LAUNCHER_TOKEN must be at least ${String(MIN_LAUNCHER_TOKEN_LENGTH)} characters: it is the only credential in front of a surface that creates containers`,
    );
  }
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
      runtimeCliPath: parsed.APP_WORKSPACE_RUNTIME_CLI_PATH ?? workspace.DEFAULT_RUNTIME_CLI_PATH,
    },
    controlPlane:
      launcherToken.length === 0
        ? null
        : {
            token: launcherToken,
            // `0.0.0.0` because the only network this container joins for it is `internal: true`
            // with no published port (TD-028 decision 2). Binding the loopback instead would make
            // the surface unreachable from the runner container, which is its only caller.
            host: parsed.APP_LAUNCHER_HOST ?? '0.0.0.0',
            port: parsed.APP_LAUNCHER_PORT ?? DEFAULT_CONTROL_PLANE_PORT,
          },
    helperNetwork: parsed.APP_WORKSPACE_HELPER_NETWORK ?? 'bridge',
    egressNetwork: parsed.APP_WORKSPACE_EGRESS_NETWORK ?? 'bridge',
    exportDir: parsed.APP_WORKSPACE_EXPORT_DIR ?? '/var/lib/app/exports',
    retentionSweepMs: parsed.APP_WORKSPACE_RETENTION_SWEEP_MS ?? HOUR_MS,
    maxExportBytes: parsed.APP_WORKSPACE_MAX_EXPORT_BYTES ?? 128 * 1024 * 1024,
    logLevel: parsed.LOG_LEVEL ?? 'info',
  };
};
