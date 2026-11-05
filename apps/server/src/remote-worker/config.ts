/**
 * **`ROLE=remote-worker`'s configuration** — WP-283 (1)–(3), BD-032 decisions 1–2.
 *
 * A worker is thin (BD-032 decision 1): it has **no database, no instance secret key and no
 * integration secrets**. So its configuration is not `loadServerConfig`'s — which requires both — but
 * this one, and it **refuses** `DATABASE_URL` and `APP_SECRET_KEY` (and their `_FILE` variants) by
 * name: a worker that was handed either is a deployment that put the core's keys on a developer's
 * machine, and starting would hide it.
 *
 * What it reads (technical/12's names, TD-020's `_FILE` convention for every secret):
 *
 * | variable | |
 * |---|---|
 * | `APP_CORE_URL` | the core's public origin (BD-032 decision 11), required |
 * | `CLAUDE_CODE_OAUTH_TOKEN(_FILE)` | the developer's Claude token (`claude setup-token`), required — it goes into the CLI's environment and nowhere else (BD-032 decision 2) |
 * | `APP_LAUNCHER_URL`, `APP_LAUNCHER_TOKEN(_FILE)` | this worker's own launcher (TD-028), required |
 * | `APP_WORKSPACE_CONTROL_ROOT` | where the `ctl` volume is mounted, required |
 * | `APP_WORKER_STATE_DIR` | the `worker-state` volume: the worker credential lives here (0600) |
 * | `APP_WORKER_CONCURRENCY` | runs at once, default 1 |
 * | `PLATFORM_RUNTIME_IMAGE`, `PLATFORM_EGRESS_IMAGE` | the run and egress references `compose.worker.yml` pins; their `@sha256:` digests are what this worker reports it holds — only while its launcher resolves them on the local daemon |
 * | `HOST`, `PORT` | the local listener: `/healthz`, `/readyz`, `/internal/*` (compose network only) |
 * | `APP_WORKER_UI` | `enabled` (default) or `disabled`: the local page on container port 7357 (WP-292); `disabled` opens no port |
 * | `APP_WORKER_UI_PORT` | the **host** port `compose.worker.yml` publishes the page on, `127.0.0.1` only (default 7357) — the `Host` header the page must carry names it |
 * | `LOG_LEVEL` | |
 */
import { imageDigestSchema, WORKER_UI_CONTAINER_PORT } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';

/** The role name `main.ts` dispatches on. Not one of `ROLES`: it composes none of their workloads. */
export const REMOTE_WORKER_ROLE = 'remote-worker';

/** Where the `worker-state` volume is mounted by default (`compose.worker.yml`). */
export const DEFAULT_WORKER_STATE_DIR = '/var/lib/platform/worker-state';

/** `APP_WORKER_CONCURRENCY`'s default (TD-031 §8: one run at a time). */
export const DEFAULT_WORKER_CONCURRENCY = 1;

/** The variables a worker refuses to start with, by name (WP-283 (1)). */
export const REFUSED_WORKER_VARIABLES = [
  'DATABASE_URL',
  'DATABASE_URL_FILE',
  'APP_SECRET_KEY',
  'APP_SECRET_KEY_FILE',
] as const;

/**
 * The image references a run needs — its run and egress images — whose registry digests a worker
 * reports holding **once its launcher resolves them locally** (TD-031 decision 4; `runtime.ts`).
 */
export const WORKER_IMAGE_VARIABLES = ['PLATFORM_RUNTIME_IMAGE', 'PLATFORM_EGRESS_IMAGE'] as const;

/** The worker's local page (WP-292, TD-031's worker-UI amendment §1–2). */
export interface WorkerUiConfig {
  readonly enabled: boolean;
  /** The address the listener binds — the container's interface, so a publish reaches it. */
  readonly host: string;
  /** The container port ({@link WORKER_UI_CONTAINER_PORT}); a test binds `0`. */
  readonly listenPort: number;
  /** `APP_WORKER_UI_PORT`: the host port the page is published on, which a `Host` header must name. */
  readonly publishedPort: number;
}

export interface RemoteWorkerConfig {
  readonly coreUrl: string;
  readonly claudeToken: string;
  readonly launcherUrl: string;
  readonly launcherToken: string;
  readonly controlRoot: string;
  readonly stateDir: string;
  readonly concurrency: number;
  /** The `sha256:` digests the run and egress references name, de-duplicated (reported only when local). */
  readonly imageDigests: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  /** `APP_COMMIT` — the build, reported at the handshake. */
  readonly commit: string | null;
  /** The local page; absent reads as disabled (a test's literal configuration). */
  readonly ui?: WorkerUiConfig;
  /** The `sha256:` digest `PLATFORM_IMAGE` names — this worker's own build, for *update pending*. */
  readonly platformImageDigest?: string | null;
}

export class RemoteWorkerConfigError extends Error {
  override readonly name = 'RemoteWorkerConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

/** The digest after `@` in an image reference, or `null`. */
export const digestOfImageReference = (reference: string): string | null => {
  const at = reference.lastIndexOf('@');
  if (at < 0) return null;
  const parsed = imageDigestSchema.safeParse(reference.slice(at + 1).trim());
  return parsed.success ? parsed.data : null;
};

/** The configuration, or one error naming every problem. */
export const loadRemoteWorkerConfig = (env: Env): RemoteWorkerConfig => {
  const problems: string[] = [];
  for (const name of REFUSED_WORKER_VARIABLES) {
    if ((env[name] ?? '').trim() !== '') {
      problems.push(
        `${name} is set: a remote worker has no database and no instance secret key (BD-032 decision 1) — remove it from this worker's environment`,
      );
    }
  }
  const read = (name: string): string | undefined => dbAdapters.readEnvWithFile(name, env)?.trim();
  const required = (name: string, what: string): string => {
    const value = read(name);
    if (value === undefined || value === '') {
      problems.push(`${name} is required: ${what}`);
      return '';
    }
    return value;
  };
  const coreUrl = required('APP_CORE_URL', "the core's public URL this worker claims runs from");
  if (coreUrl !== '') {
    let parsed: URL | null = null;
    try {
      parsed = new URL(coreUrl);
    } catch {
      parsed = null;
    }
    if (
      parsed === null ||
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      problems.push('APP_CORE_URL must be an http(s) URL with no credentials in it');
    }
  }
  const claudeToken = required(
    'CLAUDE_CODE_OAUTH_TOKEN',
    'the Claude Code subscription token (`claude setup-token`) this machine runs agents with',
  );
  const launcherUrl = required('APP_LAUNCHER_URL', "this worker's launcher (TD-028)");
  const launcherToken = required('APP_LAUNCHER_TOKEN', "the launcher's control-plane token");
  const controlRoot = required('APP_WORKSPACE_CONTROL_ROOT', 'where the ctl volume is mounted');
  if (controlRoot !== '' && !controlRoot.startsWith('/')) {
    problems.push('APP_WORKSPACE_CONTROL_ROOT must be an absolute path');
  }
  const stateDir = read('APP_WORKER_STATE_DIR') || DEFAULT_WORKER_STATE_DIR;
  const concurrencyRaw = read('APP_WORKER_CONCURRENCY');
  const concurrency =
    concurrencyRaw === undefined || concurrencyRaw === ''
      ? DEFAULT_WORKER_CONCURRENCY
      : Number(concurrencyRaw);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    problems.push('APP_WORKER_CONCURRENCY must be an integer from 1 to 64');
  }
  const portRaw = read('PORT') || '8080';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    problems.push('PORT must be a TCP port');
  }
  const uiSwitch = read('APP_WORKER_UI') || 'enabled';
  if (uiSwitch !== 'enabled' && uiSwitch !== 'disabled') {
    problems.push('APP_WORKER_UI must be enabled or disabled');
  }
  const uiPortRaw = read('APP_WORKER_UI_PORT') || String(WORKER_UI_CONTAINER_PORT);
  const uiPort = Number(uiPortRaw);
  if (!/^[0-9]+$/.test(uiPortRaw) || !Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65_535) {
    problems.push('APP_WORKER_UI_PORT must be a TCP port from 1 to 65535');
  }
  const logLevel = (read('LOG_LEVEL') || 'info') as RemoteWorkerConfig['logLevel'];
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }
  const imageDigests: string[] = [];
  for (const name of WORKER_IMAGE_VARIABLES) {
    const reference = read(name);
    if (reference === undefined || reference === '') continue;
    const digest = digestOfImageReference(reference);
    if (digest !== null && !imageDigests.includes(digest)) imageDigests.push(digest);
  }
  if (problems.length > 0) {
    throw new RemoteWorkerConfigError(
      `the remote worker's configuration is refused:\n- ${problems.join('\n- ')}`,
    );
  }
  return {
    coreUrl,
    claudeToken,
    launcherUrl,
    launcherToken,
    controlRoot,
    stateDir,
    concurrency,
    imageDigests,
    host: read('HOST') || '0.0.0.0',
    port,
    logLevel,
    commit: read('APP_COMMIT') || null,
    ui: {
      enabled: uiSwitch === 'enabled',
      host: '0.0.0.0',
      listenPort: WORKER_UI_CONTAINER_PORT,
      publishedPort: uiPort,
    },
    platformImageDigest: digestOfImageReference(read('PLATFORM_IMAGE') ?? ''),
  };
};
