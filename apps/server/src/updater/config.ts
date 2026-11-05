/**
 * **`ROLE=updater`'s configuration** — WP-287 (2), TD-032 decisions 3, 4 and 6.
 *
 * The worker's updater is a container of the `platform` image in the worker's own compose project
 * (`compose.worker.yml`'s `updater`). Like the worker it holds **no database and no instance secret
 * key** (both are refused by name); unlike it, it reaches Docker — only through its **own** socket
 * proxy on an internal network (`DOCKER_HOST`), never the socket.
 *
 * | variable | |
 * |---|---|
 * | `APP_CORE_URL` | the core it follows; unset, the updater **idles** until it is (S-22.17's first-run page may start a worker before a core is known) |
 * | `APP_TRUSTED_IMAGE_REPOSITORY` | the `platform` image's repository, e.g. `ghcr.io/<owner>/platform`; the other three are `-launcher`, `-runtime`, `-egress` beside it (TD-032 §3) |
 * | `APP_TRUSTED_BUILDER` | `<owner>/<repo>/.github/workflows/<file>@<ref>` — the workflow whose attestation is trusted |
 * | `APP_UPDATE_REGISTRY_ENDPOINTS` | optional: `host=origin,…`, where a registry is read from (`registry.ts`; not a trust decision) |
 * | `APP_UPDATE_POLL_SECONDS` | how often `release` is asked, default 300 (TD-032 §6: every 5 minutes) |
 * | `APP_UPDATE_CHECK_SECONDS` | the apply's `--wait-timeout` and its `core_handshake` bound, default 120 |
 * | `APP_WORKER_LOCAL_URL` | the worker's local listener (`/internal/drain`, `/internal/state`, `/readyz`) |
 * | `APP_WORKER_STATE_DIR` | the `worker-state` volume, read-only: the worker credential `GET release` and `update-report` carry |
 * | `APP_UPDATE_STATE_DIR` | the `updates` volume: `state.json` and the previous template |
 * | `PLATFORM_*_IMAGE` | the four references this worker runs — what an update is compared with |
 *
 * **A worker without a verifier refuses to self-update, by name** (TD-032 §3): with either trusted
 * variable unset (or unreadable) the configuration still loads — the updater stays up and says, every
 * poll, which variable is missing — and nothing is ever applied.
 */
import { db as dbAdapters } from '@platform/infrastructure';
import { REFUSED_WORKER_VARIABLES } from '../remote-worker/config.js';
import { WORKER_IMAGE_VARIABLE } from '../workers/compose.js';
import { parseTrustedBuilder, type VerifierPolicy } from './attestation.js';
import { IMAGE_KEYS, type ImageReferences } from './decide.js';
import { parseImageRepositoryName, parseRegistryEndpoints } from './registry.js';

export const UPDATER_ROLE = 'updater';
export const UPDATE_APPLY_ROLE = 'update-apply';

export const DEFAULT_UPDATE_POLL_SECONDS = 300;
export const DEFAULT_UPDATE_CHECK_SECONDS = 120;
export const DEFAULT_WORKER_LOCAL_URL = 'http://remote-worker:8080';
export const DEFAULT_UPDATE_STATE_DIR = '/var/lib/platform/updates';

export interface UpdaterConfig {
  /** `null` until a core is configured: the updater idles and says so (S-22.17). */
  readonly coreUrl: string | null;
  /** `null`, with {@link UpdaterConfig.verifierMissing} naming why: this worker never self-updates. */
  readonly verifier: (VerifierPolicy & { readonly repository: string }) | null;
  readonly verifierMissing: string | null;
  readonly registryEndpoints: ReadonlyMap<string, string>;
  readonly pollMs: number;
  readonly checkSeconds: number;
  readonly workerUrl: string;
  readonly workerStateDir: string;
  readonly stateDir: string;
  readonly running: ImageReferences;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
}

export class UpdaterConfigError extends Error {
  override readonly name = 'UpdaterConfigError';
}

type Env = Readonly<Record<string, string | undefined>>;

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

const seconds = (raw: string | undefined, fallback: number, name: string, problems: string[]) => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 86_400) {
    problems.push(`${name} must be a whole number of seconds from 1 to 86400`);
    return fallback;
  }
  return value;
};

export const loadUpdaterConfig = (env: Env): UpdaterConfig => {
  const problems: string[] = [];
  for (const name of REFUSED_WORKER_VARIABLES) {
    if ((env[name] ?? '').trim() !== '') {
      problems.push(
        `${name} is set: a worker's updater holds no database and no instance secret key`,
      );
    }
  }
  const read = (name: string): string => dbAdapters.readEnvWithFile(name, env)?.trim() ?? '';
  const coreUrl = read('APP_CORE_URL');
  if (coreUrl !== '') {
    try {
      const parsed = new URL(coreUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
      if (parsed.username !== '' || parsed.password !== '') throw new Error();
    } catch {
      problems.push('APP_CORE_URL must be an http(s) URL with no credentials in it');
    }
  }
  let registryEndpoints: ReadonlyMap<string, string> = new Map();
  try {
    registryEndpoints = parseRegistryEndpoints(read('APP_UPDATE_REGISTRY_ENDPOINTS'));
  } catch (error) {
    problems.push((error as Error).message);
  }
  const running: Partial<Record<keyof ImageReferences, string>> = {};
  for (const key of IMAGE_KEYS) {
    running[key] = read(WORKER_IMAGE_VARIABLE[key]);
  }
  const logLevel = (read('LOG_LEVEL') || 'info') as UpdaterConfig['logLevel'];
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
  }
  const pollSeconds = seconds(
    read('APP_UPDATE_POLL_SECONDS'),
    DEFAULT_UPDATE_POLL_SECONDS,
    'APP_UPDATE_POLL_SECONDS',
    problems,
  );
  const checkSeconds = seconds(
    read('APP_UPDATE_CHECK_SECONDS'),
    DEFAULT_UPDATE_CHECK_SECONDS,
    'APP_UPDATE_CHECK_SECONDS',
    problems,
  );
  if (problems.length > 0) {
    throw new UpdaterConfigError(
      `the updater's configuration is refused:\n- ${problems.join('\n- ')}`,
    );
  }

  // The verifier: missing pieces are named, never a start failure (TD-032 §3).
  const missing: string[] = [];
  const repositoryRaw = read('APP_TRUSTED_IMAGE_REPOSITORY');
  const builderRaw = read('APP_TRUSTED_BUILDER');
  if (repositoryRaw === '') missing.push('APP_TRUSTED_IMAGE_REPOSITORY is unset');
  else if (parseImageRepositoryName(repositoryRaw) === null) {
    missing.push(`APP_TRUSTED_IMAGE_REPOSITORY (${repositoryRaw}) is not <registry>/<repository>`);
  }
  const builder = builderRaw === '' ? null : parseTrustedBuilder(builderRaw);
  if (builderRaw === '') missing.push('APP_TRUSTED_BUILDER is unset');
  else if (builder === null) {
    missing.push(
      `APP_TRUSTED_BUILDER (${builderRaw}) is not <owner>/<repo>/.github/workflows/<file>@<ref>`,
    );
  }
  const verifier =
    missing.length === 0 && builder !== null ? { repository: repositoryRaw, builder } : null;
  return {
    coreUrl: coreUrl === '' ? null : coreUrl,
    verifier,
    verifierMissing:
      verifier === null
        ? `this worker has no attestation verifier configured, so it does not self-update: ${missing.join('; ')}`
        : null,
    registryEndpoints,
    pollMs: pollSeconds * 1000,
    checkSeconds,
    workerUrl: (read('APP_WORKER_LOCAL_URL') || DEFAULT_WORKER_LOCAL_URL).replace(/\/+$/, ''),
    workerStateDir: read('APP_WORKER_STATE_DIR') || '/var/lib/platform/worker-state',
    stateDir: read('APP_UPDATE_STATE_DIR') || DEFAULT_UPDATE_STATE_DIR,
    running: running as ImageReferences,
    logLevel,
  };
};
