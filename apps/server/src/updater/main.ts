/**
 * The two updater processes' composition — `ROLE=updater` and `ROLE=update-apply` (WP-287). Like
 * `ROLE=remote-worker` neither is one of the core's roles: each composes no database, no secret key
 * and nothing of the pipeline, so `main.ts` dispatches to them before `loadServerConfig`.
 */
import { hostname } from 'node:os';
import process from 'node:process';
import type { Logger } from '@platform/application';
import { asLoggerPort, createLogger, type PinoLogger } from '../logging.js';
import { IMAGE_TEMPLATE_PATH, runApply } from './apply.js';
import { createAttestationVerifier } from './attestation.js';
import { loadUpdaterConfig, UPDATE_APPLY_ROLE, UPDATER_ROLE } from './config.js';
import { createDockerCli } from './docker.js';
import { updatePlanSchema } from './plan.js';
import { createRegistryClient } from './registry.js';
import { createUpdater, type Updater } from './updater.js';

/**
 * A **ref'd** wait. The worker's `sleepMs` unrefs its timer (the worker's listener keeps its process
 * alive); these two processes have no listener, so an unref'd wait empties the event loop and the
 * process exits on `beforeExit` in the middle of a poll — measured: the updater restarted every
 * poll in the first run of `scripts/worker-update-check.mjs`.
 */
export const refSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface StartedUpdater {
  readonly logger: PinoLogger;
  readonly updater: Updater;
  readonly done: Promise<void>;
}

export const startUpdaterProcess = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): StartedUpdater => {
  const config = loadUpdaterConfig(env);
  const logger = createLogger({ level: config.logLevel, format: 'json', role: UPDATER_ROLE });
  const port: Logger = asLoggerPort(logger);
  const registry = createRegistryClient({ endpoints: config.registryEndpoints });
  const verifier =
    config.verifier === null
      ? null
      : createAttestationVerifier({
          registry,
          policy: config.verifier,
          tufCachePath: `${config.stateDir}/tuf`,
        });
  const applyEnvironment: Record<string, string> = {};
  for (const name of ['DOCKER_HOST', 'LOG_LEVEL'] as const) {
    const value = env[name];
    if (value !== undefined && value !== '') applyEnvironment[name] = value;
  }
  const updater = createUpdater({
    config,
    docker: createDockerCli(),
    fetch: (url, init) => fetch(url, init),
    logger: port,
    verifier,
    containerId: env.HOSTNAME ?? hostname(),
    templatePath: IMAGE_TEMPLATE_PATH,
    applyEnvironment,
    now: () => new Date(),
    sleep: refSleep,
  });
  logger.info(
    {
      core_url: config.coreUrl,
      trusted_repository: config.verifier?.repository ?? null,
      poll_seconds: config.pollMs / 1000,
    },
    'the updater is following its core',
  );
  return { logger, updater, done: updater.run() };
};

/** One apply, then exit: `0` for a result the core was given, `1` for an apply that failed. */
export const runApplyProcess = async (
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> => {
  const logger = createLogger({
    level: (env.LOG_LEVEL as 'info' | undefined) ?? 'info',
    format: 'json',
    role: UPDATE_APPLY_ROLE,
  });
  const plan = updatePlanSchema.parse(JSON.parse(env.APP_UPDATE_PLAN ?? 'null'));
  const state = await runApply(plan, {
    docker: createDockerCli(),
    fetch: (url, init) => fetch(url, init),
    logger: asLoggerPort(logger),
    templatePath: IMAGE_TEMPLATE_PATH,
    stateDir: env.APP_UPDATE_STATE_DIR ?? '/var/lib/platform/updates',
    workerStateDir: env.APP_WORKER_STATE_DIR ?? '/var/lib/platform/worker-state',
    now: () => new Date(),
    sleep: refSleep,
  });
  return state.result === 'succeeded' ? 0 : 1;
};

export { UPDATE_APPLY_ROLE, UPDATER_ROLE };
