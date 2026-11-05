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
 * | `APP_CORE_URL` | the core's public origin (BD-032 decision 11); optional since WP-294 — absent (or empty), the page's wizard asks for it and keeps it as `core-url` in `worker-state` |
 * | `CLAUDE_CODE_OAUTH_TOKEN(_FILE)` | the developer's Claude token (`claude setup-token`); optional since WP-294 — absent, the page's *Sign in to Claude* stores it as `claude-token`. It goes into the CLI's environment and nowhere else (BD-032 decision 2) |
 * | `APP_WORKER_CORE_CANDIDATES` | more platform addresses the wizard probes, comma-separated, beside `http://host.docker.internal:{8080,5173}` (WP-294) |
 * | `APP_WORKER_CLAUDE_CLI` | the `claude` binary the sign-in runs — the `claude-cli` volume's copy of the run image's CLI, default `/opt/claude-cli/claude` (WP-294) |
 * | `APP_LAUNCHER_URL`, `APP_LAUNCHER_TOKEN(_FILE)` | this worker's own launcher (TD-028), required |
 * | `APP_WORKSPACE_CONTROL_ROOT` | where the `ctl` volume is mounted, required |
 * | `APP_WORKER_STATE_DIR` | the `worker-state` volume: the worker credential lives here (0600) |
 * | `APP_WORKER_CONCURRENCY` | runs at once, default 1 |
 * | `APP_WORKER_USAGE_PAUSE_DEFAULT` | seconds a usage limit that named no reset time pauses claiming (TD-031 §11), default 3600 |
 * | `PLATFORM_RUNTIME_IMAGE`, `PLATFORM_EGRESS_IMAGE` | the run and egress references `compose.worker.yml` pins; their `@sha256:` digests are what this worker reports it holds — only while its launcher resolves them on the local daemon |
 * | `HOST`, `PORT` | the local listener: `/healthz`, `/readyz`, `/internal/*` (compose network only) |
 * | `APP_WORKER_UI` | `enabled` (default) or `disabled`: the local page on container port 7357 (WP-292); `disabled` opens no port |
 * | `APP_WORKER_UI_PORT` | the **host** port `compose.worker.yml` publishes the page on, `127.0.0.1` only (default 7357) — the `Host` header the page must carry names it |
 * | `APP_WORKER_UI_AUTH` | `none` (default: no bearer, the page at `http://127.0.0.1:<port>`) or `token` (WP-292's `ui-token`, for a machine with more than one OS account) — TD-031's 2026-11-05 no-bearer amendment |
 * | `LOG_LEVEL` | |
 * | `SENTRY_DSN(_FILE)` | optional error reporting (WP-295): a Sentry DSN, `https://<key>@<host>/<project id>` (`http:` only to loopback) — malformed is a startup refusal. Set here it **wins** over the page's *Error reporting* setting, whose actions then answer `409` |
 * | `APP_VERSION`, `APP_COMMIT` | the build — the commit is reported at the handshake, both tag an error report |
 *
 * Each of the core URL and the Claude token is read **environment → `worker-state` file → wizard**
 * (TD-031's first-run amendment §1): an empty value counts as absent, and a value from the
 * environment is shown as such on the page, whose action for it answers `409`.
 */
import { DEFAULT_USAGE_PAUSE_SECONDS } from '@platform/application';
import {
  imageDigestSchema,
  WORKER_UI_CONTAINER_PORT,
  type WorkerUiAuth,
} from '@platform/contracts';
import { db as dbAdapters, errorReporting } from '@platform/infrastructure';

/** The role name `main.ts` dispatches on. Not one of `ROLES`: it composes none of their workloads. */
export const REMOTE_WORKER_ROLE = 'remote-worker';

/** Where the `worker-state` volume is mounted by default (`compose.worker.yml`). */
export const DEFAULT_WORKER_STATE_DIR = '/var/lib/platform/worker-state';

/** Where `compose.worker.yml` mounts the `claude-cli` volume's copy of the run image's CLI (WP-294). */
export const DEFAULT_CLAUDE_CLI_PATH = '/opt/claude-cli/claude';

/** The platforms the wizard probes on the developer's machine (TD-031's first-run amendment §3). */
export const DEFAULT_CORE_CANDIDATES = [
  'http://host.docker.internal:8080',
  'http://host.docker.internal:5173',
] as const;

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
  /** `APP_WORKER_UI_AUTH` (TD-031's no-bearer amendment): `none` reads no `Authorization`. */
  readonly auth: WorkerUiAuth;
}

/**
 * Whether a core address may be used: `https:`, or `http:` to this machine only, and no userinfo
 * (TD-031's first-run amendment §3). Answers the origin, or `null`.
 */
export const LOCAL_HTTP_HOSTS: readonly string[] = [
  'host.docker.internal',
  'localhost',
  '127.0.0.1',
  '[::1]',
];
export const coreOriginOf = (value: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.protocol === 'https:') return parsed.origin;
  if (parsed.protocol === 'http:' && LOCAL_HTTP_HOSTS.includes(parsed.hostname)) {
    return parsed.origin;
  }
  return null;
};

export interface RemoteWorkerConfig {
  /** `APP_CORE_URL`, or `null`: the wizard's *Connect to a platform* asks for it (WP-294). */
  readonly coreUrl: string | null;
  /** `CLAUDE_CODE_OAUTH_TOKEN(_FILE)`, or `null`: the wizard's *Sign in to Claude* (WP-294). */
  readonly claudeToken: string | null;
  /** More addresses the wizard probes (`APP_WORKER_CORE_CANDIDATES`); absent reads as none. */
  readonly coreCandidates?: readonly string[];
  /** The `claude` the sign-in runs (`APP_WORKER_CLAUDE_CLI`); absent reads as the default. */
  readonly claudeCliPath?: string;
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
  /** `APP_VERSION` — the build's version, a tag of an error report; absent reads as unknown. */
  readonly version?: string | null;
  /**
   * `SENTRY_DSN(_FILE)`, canonical, or `null` (WP-295): **wins** over the page's setting. Absent
   * reads as unset (a test's literal configuration).
   */
  readonly sentryDsn?: string | null;
  /** The local page; absent reads as disabled (a test's literal configuration). */
  readonly ui?: WorkerUiConfig;
  /** The `sha256:` digest `PLATFORM_IMAGE` names — this worker's own build, for *update pending*. */
  readonly platformImageDigest?: string | null;
  /**
   * `APP_WORKER_USAGE_PAUSE_DEFAULT`, in ms (WP-285): how long a usage limit that named no reset
   * time pauses claiming. Absent reads as {@link DEFAULT_USAGE_PAUSE_SECONDS}.
   */
  readonly usagePauseDefaultMs?: number;
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
  const coreRaw = read('APP_CORE_URL') || '';
  let coreUrl: string | null = null;
  if (coreRaw !== '') {
    let parsed: URL | null = null;
    try {
      parsed = new URL(coreRaw);
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
    } else {
      coreUrl = coreRaw;
    }
  }
  const claudeToken = read('CLAUDE_CODE_OAUTH_TOKEN') || null;
  const candidates: string[] = [];
  for (const entry of (read('APP_WORKER_CORE_CANDIDATES') ?? '').split(',')) {
    if (entry.trim() === '') continue;
    const origin = coreOriginOf(entry);
    if (origin === null) {
      problems.push(
        `APP_WORKER_CORE_CANDIDATES has ${JSON.stringify(entry.trim().slice(0, 200))}: each entry is an https URL, or http to this machine, with no credentials`,
      );
    } else if (!candidates.includes(origin)) {
      candidates.push(origin);
    }
  }
  const claudeCliPath = read('APP_WORKER_CLAUDE_CLI') || DEFAULT_CLAUDE_CLI_PATH;
  if (!/^\/[A-Za-z0-9._/-]+$/.test(claudeCliPath)) {
    problems.push('APP_WORKER_CLAUDE_CLI must be an absolute path of plain characters');
  }
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
  const uiAuth = read('APP_WORKER_UI_AUTH') || 'none';
  if (uiAuth !== 'none' && uiAuth !== 'token') {
    problems.push('APP_WORKER_UI_AUTH must be none or token');
  }
  const uiPortRaw = read('APP_WORKER_UI_PORT') || String(WORKER_UI_CONTAINER_PORT);
  const uiPort = Number(uiPortRaw);
  if (!/^[0-9]+$/.test(uiPortRaw) || !Number.isInteger(uiPort) || uiPort < 1 || uiPort > 65_535) {
    problems.push('APP_WORKER_UI_PORT must be a TCP port from 1 to 65535');
  }
  const pauseRaw = read('APP_WORKER_USAGE_PAUSE_DEFAULT') || String(DEFAULT_USAGE_PAUSE_SECONDS);
  const pauseSeconds = Number(pauseRaw);
  if (!/^[0-9]+$/.test(pauseRaw) || pauseSeconds < 60 || pauseSeconds > 8 * 24 * 3_600) {
    problems.push(
      'APP_WORKER_USAGE_PAUSE_DEFAULT must be whole seconds from 60 to 691200 (8 days)',
    );
  }
  const logLevel = (read('LOG_LEVEL') || 'info') as RemoteWorkerConfig['logLevel'];
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }
  const sentryRaw = read('SENTRY_DSN') || '';
  let sentryDsn: string | null = null;
  if (sentryRaw !== '') {
    const verdict = errorReporting.parseErrorReportingDsn(sentryRaw);
    // Never echoed: a DSN carries the project's key.
    if (verdict.ok) sentryDsn = verdict.dsn;
    else problems.push(`SENTRY_DSN must be ${errorReporting.DSN_SHAPE_WORDS}`);
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
    coreCandidates: candidates,
    claudeCliPath,
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
    version: read('APP_VERSION') || null,
    sentryDsn,
    usagePauseDefaultMs: pauseSeconds * 1_000,
    ui: {
      enabled: uiSwitch === 'enabled',
      host: '0.0.0.0',
      listenPort: WORKER_UI_CONTAINER_PORT,
      publishedPort: uiPort,
      auth: uiAuth as WorkerUiAuth,
    },
    platformImageDigest: digestOfImageReference(read('PLATFORM_IMAGE') ?? ''),
  };
};
