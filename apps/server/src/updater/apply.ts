/**
 * **`ROLE=update-apply`** — WP-287 (2), TD-032 decisions 4 and 6: one update of a worker's compose
 * project, run once from the **new, verified** `platform` image.
 *
 * Compose cannot recreate the container that runs it (research/17 § 5), so the long-running updater
 * never applies anything: it starts this one-shot — labelled, `--rm`, **outside** the compose project
 * (no compose labels, so no `up`/`down` of the project touches it) — on the updater's proxy network and
 * the project's default network, and it does, in order:
 *
 *  1. **pull** every image of the new template with the new references (the run, egress and git
 *     images included — a launcher never pulls at create, TD-031 decision 4). A failure changes
 *     nothing, and the worker is restarted so its drain's pause is cleared;
 *  2. **pin**: rewrite the managed block of the project's env file, the whole previous file kept as
 *     `.previous` (`env-file.ts`);
 *  3. **up** `-d --wait --wait-timeout <check>` every long-running service but the updater and its
 *     proxy, with the template **this image carries** (`/opt/platform/compose.worker.yml`) — never a
 *     file the core served (TD-032 §3);
 *  4. **check**: the worker's `/readyz` reads `core_handshake: ok` within the same bound, from a
 *     `remote-worker` container running the new `platform` reference;
 *  5. **report** `succeeded` (`POST update-report`), and **recreate the updater last**: its
 *     replacement is the new build's.
 *
 * A failure at 3 or 4 **rolls back**: the previous env file byte for byte, the previous template
 * (which the old updater wrote into the `updates` volume before it launched this), `up` again, the
 * same check — and reports `rolled_back`, or `failed` when even that does not come back. A crashed
 * apply leaves `updates/state.json` naming its step; the next updater start rolls back from it
 * (`mode: 'rollback'`, run from the updater's own — the old — image).
 *
 * **Carried values.** A first install passes `CLAUDE_CODE_OAUTH_TOKEN` (and maybe more) on the shell,
 * not in the env file, so an `up` from here would lose it. So every variable the template interpolates
 * as a service's whole environment value, and that neither the env file nor the managed block sets,
 * is carried over **from the running container's own environment** — through `docker compose`'s
 * process environment only (`docker.ts`): never a file, never an argument, never a log line.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@platform/application';
import type { CoreImageDigests } from '@platform/contracts';
import { createCoreClient } from '../remote-worker/core-client.js';
import { WORKER_IMAGE_VARIABLE } from '../workers/compose.js';
import { IMAGE_KEYS, type ImageReferences } from './decide.js';
import {
  type ComposeProject,
  composeArgs,
  type DockerRun,
  environmentOf,
  projectContainers,
  serviceOf,
} from './docker.js';
import { pinReferences, readEnvFile, restorePrevious } from './env-file.js';
import { PREVIOUS_TEMPLATE_FILE, type UpdatePlan, type UpdateState, writeState } from './plan.js';

/** The services the apply never brings up: the updater (recreated last) and its own proxy. */
export const UPDATER_SERVICES = ['updater', 'updater-docker-proxy'] as const;
export const WORKER_SERVICE = 'remote-worker';
/** Where the `platform` image carries the template (TD-032 §3). */
export const IMAGE_TEMPLATE_PATH = '/opt/platform/compose.worker.yml';

export interface ApplyDeps {
  readonly docker: DockerRun;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly logger: Logger;
  /** The template this image carries ({@link IMAGE_TEMPLATE_PATH}). */
  readonly templatePath: string;
  /** The `updates` volume. */
  readonly stateDir: string;
  /** The `worker-state` volume (read-only): the worker credential `update-report` carries. */
  readonly workerStateDir: string;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/** A compose variable reference that is a whole value: `${NAME}`, `${NAME:-x}`, `${NAME:?x}`, … */
const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(?::?[-?+])[^}]*)?\}$/;

interface ComposeModel {
  readonly services: Readonly<
    Record<
      string,
      {
        readonly environment?: Readonly<Record<string, string | null>>;
        readonly restart?: string;
      }
    >
  >;
}

/** The template as compose reads it, **uninterpolated** (so `${…}` survives to be mapped). */
export const readComposeModel = async (
  docker: DockerRun,
  project: ComposeProject,
  template: string,
): Promise<ComposeModel> => {
  const { stdout } = await docker(
    composeArgs(project, template, ['config', '--no-interpolate', '--format', 'json'], {
      envFile: false,
    }),
  );
  const parsed = JSON.parse(stdout) as Partial<ComposeModel>;
  return { services: parsed.services ?? {} };
};

/** The keys an env file sets (`NAME=…`, `export NAME=…`), comments and blanks aside. */
export const keysOfEnvFile = (text: string): Set<string> => {
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match !== null) keys.add(match[1] as string);
  }
  return keys;
};

/**
 * The values to carry over: for each `KEY: ${VAR…}` of each service, `VAR` ← the running container's
 * `KEY`, unless the env file or the managed block sets `VAR`.
 */
export const carriedEnvironment = (
  model: ComposeModel,
  running: ReadonlyMap<string, ReadonlyMap<string, string>>,
  envFileKeys: ReadonlySet<string>,
): Record<string, string> => {
  const managed = new Set<string>(IMAGE_KEYS.map((key) => WORKER_IMAGE_VARIABLE[key]));
  const carried: Record<string, string> = {};
  for (const [service, definition] of Object.entries(model.services)) {
    const env = running.get(service);
    if (env === undefined) continue;
    for (const [key, value] of Object.entries(definition.environment ?? {})) {
      const variable = typeof value === 'string' ? WHOLE_REFERENCE.exec(value)?.[1] : undefined;
      if (variable === undefined || managed.has(variable) || envFileKeys.has(variable)) continue;
      if (Object.hasOwn(carried, variable)) continue;
      const current = env.get(key);
      if (current !== undefined) carried[variable] = current;
    }
  }
  return carried;
};

/** The services `up` brings up: every long-running one but the updater and its proxy. */
export const servicesToUp = (model: ComposeModel): string[] =>
  Object.entries(model.services)
    .filter(
      ([name, definition]) =>
        !(UPDATER_SERVICES as readonly string[]).includes(name) &&
        (definition.restart ?? 'no') !== 'no',
    )
    .map(([name]) => name)
    .sort();

const referencesEnvironment = (references: ImageReferences): Record<string, string> =>
  Object.fromEntries(IMAGE_KEYS.map((key) => [WORKER_IMAGE_VARIABLE[key], references[key]]));

/** Waits for the worker's `/readyz` to read `core_handshake: ok`, within `seconds`. */
export const waitForHandshake = async (
  deps: Pick<ApplyDeps, 'fetch' | 'sleep' | 'now'>,
  workerUrl: string,
  seconds: number,
): Promise<{ readonly ok: boolean; readonly last: string }> => {
  const deadline = deps.now().getTime() + seconds * 1000;
  let last = 'no answer';
  while (deps.now().getTime() < deadline) {
    try {
      const response = await deps.fetch(`${workerUrl}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json().catch(() => null)) as {
        checks?: { core_handshake?: unknown };
      } | null;
      last = `${response.status} core_handshake=${String(body?.checks?.core_handshake ?? 'absent')}`;
      if (response.status === 200 && body?.checks?.core_handshake === 'ok') {
        return { ok: true, last };
      }
    } catch (error) {
      last = (error as Error).message;
    }
    await deps.sleep(2_000);
  }
  return { ok: false, last };
};

/** Reports how the update ended; `false` when the core could not be told (the next start retries). */
export const reportResult = async (
  deps: Pick<ApplyDeps, 'fetch' | 'workerStateDir' | 'sleep' | 'logger'>,
  coreUrl: string,
  report: {
    readonly from: CoreImageDigests;
    readonly to: CoreImageDigests;
    readonly result: 'succeeded' | 'rolled_back' | 'failed';
    readonly detail: string | null;
  },
): Promise<boolean> => {
  let credential: string;
  try {
    credential = (await readFile(path.join(deps.workerStateDir, 'credential'), 'utf8')).trim();
  } catch {
    deps.logger.warn({}, 'this worker has no credential yet, so the update is not reported');
    return false;
  }
  const core = createCoreClient({ baseUrl: coreUrl, fetch: (url, init) => deps.fetch(url, init) });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await core.updateReport(credential, {
        ...report,
        detail: report.detail === null ? null : report.detail.slice(0, 4_000),
      });
      return true;
    } catch (error) {
      deps.logger.warn({ err: error, attempt }, 'the update report did not reach the core');
      await deps.sleep(2_000 * (attempt + 1));
    }
  }
  return false;
};

/** The image the project's `remote-worker` container runs, or `null`. */
const workerImageOf = async (docker: DockerRun, project: string): Promise<string | null> => {
  const containers = await projectContainers(docker, project);
  const worker = containers.find(
    (container) => serviceOf(container) === WORKER_SERVICE && container.State?.Running === true,
  );
  return worker?.Config?.Image ?? null;
};

export const runApply = async (plan: UpdatePlan, deps: ApplyDeps): Promise<UpdateState> => {
  const { docker, logger } = deps;
  const project: ComposeProject = {
    name: plan.project,
    workingDir: plan.working_dir,
    envFile: plan.env_file,
  };
  let state: UpdateState = {
    id: plan.id,
    mode: plan.mode,
    step: 'launched',
    result: null,
    detail: null,
    from_digests: plan.from_digests,
    to_digests: plan.to_digests,
    from: plan.from,
    to: plan.to,
    started_at: deps.now().toISOString(),
    finished_at: null,
    reported: false,
  };
  const save = async (next: Partial<UpdateState>): Promise<void> => {
    state = { ...state, ...next };
    await writeState(deps.stateDir, state);
  };
  const finish = async (
    result: 'succeeded' | 'rolled_back' | 'failed',
    detail: string | null,
  ): Promise<void> => {
    await save({ step: 'done', result, detail, finished_at: deps.now().toISOString() });
    const reported = await reportResult(deps, plan.core_url, {
      from: plan.from_digests,
      to: plan.to_digests,
      result,
      detail,
    });
    await save({ reported });
    logger.info(
      { update_id: plan.id, result, detail, reported },
      `the update ${plan.id} ended ${result}`,
    );
  };

  /** Every compose call of this apply: the carried values, plus the references it asks for. */
  const compose = async (
    template: string,
    args: readonly string[],
    references: ImageReferences | null,
    timeoutMs?: number,
  ) => {
    const envText = await readEnvFile(plan.env_file);
    const model = await readComposeModel(docker, project, template);
    const running = new Map<string, ReadonlyMap<string, string>>();
    for (const container of await projectContainers(docker, plan.project)) {
      const service = serviceOf(container);
      if (service !== null && !running.has(service)) running.set(service, environmentOf(container));
    }
    const env = {
      ...carriedEnvironment(model, running, keysOfEnvFile(envText)),
      ...(references === null ? {} : referencesEnvironment(references)),
    };
    const hasEnvFile = await stat(plan.env_file).then(
      () => true,
      () => false,
    );
    return {
      model,
      result: await docker(composeArgs(project, template, args, { envFile: hasEnvFile }), {
        env,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
    };
  };

  /** `up` the template's long-running services and check the worker's handshake. */
  /**
   * The references are passed explicitly as well as pinned: a first install's env file has no block,
   * and its old references were the *rendered* file's defaults, which no template in an image carries.
   */
  const upAndCheck = async (
    template: string,
    references: ImageReferences,
  ): Promise<{ readonly ok: boolean; readonly detail: string }> => {
    const expectedPlatform = references.platform;
    try {
      const model = await readComposeModel(docker, project, template);
      await compose(
        template,
        [
          'up',
          '-d',
          '--wait',
          '--wait-timeout',
          String(plan.check_seconds),
          ...servicesToUp(model),
        ],
        references,
        (plan.check_seconds + 60) * 1000,
      );
    } catch (error) {
      return { ok: false, detail: `up failed: ${(error as Error).message}` };
    }
    const handshake = await waitForHandshake(deps, plan.worker_url, plan.check_seconds);
    const image = await workerImageOf(docker, plan.project).catch(() => null);
    if (!handshake.ok) {
      return {
        ok: false,
        detail: `the worker's /readyz did not read core_handshake: ok within ${plan.check_seconds} s (${handshake.last})`,
      };
    }
    if (image !== expectedPlatform) {
      return {
        ok: false,
        detail: `the worker runs ${image ?? 'nothing'}, not ${expectedPlatform}`,
      };
    }
    return { ok: true, detail: handshake.last };
  };

  const rollback = async (why: string, previousTemplate: string): Promise<void> => {
    await save({ step: 'rolling_back', detail: why });
    logger.warn({ update_id: plan.id, why }, 'the update failed; rolling back');
    try {
      await restorePrevious(plan.env_file);
    } catch (error) {
      await finish(
        'failed',
        `${why}; the previous env file could not be restored: ${(error as Error).message}`,
      );
      return;
    }
    const back = await upAndCheck(previousTemplate, plan.from);
    await finish(
      back.ok ? 'rolled_back' : 'failed',
      back.ok ? why : `${why}; the rollback did not come back either: ${back.detail}`,
    );
  };

  if (plan.mode === 'rollback') {
    await save({ step: 'rolling_back' });
    await rollback('the previous apply did not finish (its container is gone)', deps.templatePath);
    return state;
  }

  const previousTemplate = path.join(deps.stateDir, PREVIOUS_TEMPLATE_FILE);
  await save({ step: 'launched' });

  // 1. Pull, with the new references; a failure changes nothing.
  try {
    await compose(deps.templatePath, ['pull', '--quiet'], plan.to, 30 * 60_000);
    await save({ step: 'pulled' });
  } catch (error) {
    const detail = `pull failed, nothing changed: ${(error as Error).message}`;
    // The worker drained for this update: a restart clears a drain's pause (TD-031, 2026-11-05).
    await compose(deps.templatePath, ['restart', WORKER_SERVICE], plan.from).catch(
      (restart: unknown) =>
        logger.error({ err: restart }, 'the drained worker could not be restarted'),
    );
    await finish('failed', detail);
    return state;
  }

  // 2. Pin.
  try {
    await pinReferences(plan.env_file, plan.to);
    await save({ step: 'pinned' });
  } catch (error) {
    await finish('failed', `the env file could not be written: ${(error as Error).message}`);
    return state;
  }

  // 3–4. Up and check.
  const up = await upAndCheck(deps.templatePath, plan.to);
  if (!up.ok) {
    await rollback(up.detail, previousTemplate);
    return state;
  }
  await save({ step: 'checked' });

  // 5. Report, then the updater last.
  await finish('succeeded', null);
  try {
    await compose(deps.templatePath, ['up', '-d', '--no-deps', 'updater'], plan.to);
  } catch (error) {
    logger.error(
      { err: error },
      'the update succeeded but the updater could not be recreated on the new build; the next `docker compose up` does it',
    );
  }
  return state;
};
