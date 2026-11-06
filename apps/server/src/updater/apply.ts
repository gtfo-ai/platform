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
 *  2. **render** the new build's compose file from the template **this image carries**
 *     (`/opt/platform/compose.worker.yml`) for the new digests and the core's URL — the bytes the core
 *     would serve for that build, never a file the core served (TD-032 §3);
 *  3. **write it back** into the person's install folder, mounted at `HOST_BUNDLE_MOUNT` (S-22.21,
 *     TD-032's decision-4 amendment), and **pin** the managed block of the folder's `.env` (their own
 *     lines kept): the previous compose file is kept in the `updates` volume and the previous env file
 *     as `.env.previous`. The folder then holds what runs, so a person's own `docker compose up` there
 *     is this build, never an older one;
 *  4. **up** `-d --wait --wait-timeout <check>` every long-running service but the updater and its
 *     proxy, from that folder by the project's name;
 *  5. **check**: the worker's `/readyz` reads `core_handshake: ok` (and `launcher: ok`, backlog 980)
 *     within the same bound, from a `remote-worker` container running the new `platform` reference.
 *     `up --wait` waits for the launcher's healthcheck too, and a worker that started before its
 *     launcher listened asks it again with backoff, so the check reads `launcher: ok` once it answers;
 *  6. **report** `succeeded` (`POST update-report`), and **recreate the updater last**: its
 *     replacement is the new build's.
 *
 * A failure at 4 or 5 **rolls back**: the folder's previous compose file and env file byte for byte
 * (or, when nothing of the folder was rewritten, the env file and the previous image's template the old
 * updater wrote into the `updates` volume, with the previous references passed), `up` again, the
 * same check — and reports `rolled_back`, or `failed` when even that does not come back. A crashed
 * apply leaves `updates/state.json` naming its step; the next updater start rolls back from it
 * (`mode: 'rollback'`, run from the updater's own — the old — image).
 *
 * **Carried values.** A first install passes `CLAUDE_CODE_OAUTH_TOKEN` (and maybe more) on the shell,
 * not in the env file, so an `up` from here would lose it. So a variable the template interpolates as a
 * service's whole environment value, that neither the env file nor the managed block sets, **and that
 * the template declares with no non-empty default** — `${VAR}`, `${VAR:?…}`, `${VAR?…}`, `${VAR:-}`,
 * `${VAR-}` — is carried over **from the running container's own environment**, through
 * `docker compose`'s process environment only (`docker.ts`): never a file, never an argument, never a
 * log line. A variable with a non-empty default (`${VAR:-x}`, `${VAR-x}`) is **never** carried: the
 * running container cannot tell a person's choice from an older template's default, and carrying it
 * baked the old default in (2026-11-06: `APP_UPDATE_POLL_SECONDS` stayed `300` after the template's
 * default became `60`), so a setting with a default follows the template being rendered, and a person
 * who wants their own puts it in the folder's `.env`. The defaults are read off the model of the
 * template being brought up, across every use in the services' environments; a variable used more than
 * once is carried when **any** use has no non-empty default (the conservative reading: a use that
 * would otherwise read empty must not lose the value), and its value is taken from such a use first.
 * A `${VAR:+…}`/`${VAR+…}` use is no source (the container holds the alternative, not `VAR`) and no
 * reason to carry. `APP_CORE_URL` is one such setting in the file the folder runs: the render writes
 * `${APP_CORE_URL:-<core>}` with `plan.core_url`, so it follows the core the updater talks to and is
 * not carried; only the image's own template (a git checkout, a rollback's last resort) declares it
 * `${APP_CORE_URL:-}` and carries it. A worker already holding an old default un-sticks on the very
 * update that deploys this rule: the forward apply runs from the new, verified image, so it already
 * applies the new rule. Only a `mode: 'rollback'` apply runs from the updater's own — the old — image,
 * and with it the old rule. A value a person set in the folder's `.env` needs no carriage:
 * Compose reads that file, here as in their own `docker compose up` — a setting a newer template reads
 * for the first time included. The one value
 * passed besides is {@link BUNDLE_SOURCE_VARIABLE}: from the folder as project directory, the
 * template's `${APP_WORKER_BUNDLE_DIR:-.}` would name the container's path, so the source Docker
 * reports for the updater's own mount of the folder is handed back to it.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@platform/application';
import type { CoreImageDigests } from '@platform/contracts';
import { createCoreClient } from '../remote-worker/core-client.js';
import { readStoredCredential } from '../remote-worker/credential.js';
import { renderWorkerCompose, WORKER_IMAGE_VARIABLE } from '../workers/compose.js';
import { IMAGE_KEYS, type ImageReferences } from './decide.js';
import {
  type ComposeProject,
  composeArgs,
  type DockerRun,
  environmentOf,
  projectContainers,
  serviceOf,
} from './docker.js';
import {
  copyFileAtomically,
  pinReferences,
  readEnvFile,
  restorePrevious,
  writeFileAtomically,
} from './env-file.js';
import {
  HOST_BUNDLE_MOUNT,
  PREVIOUS_TEMPLATE_FILE,
  type UpdatePlan,
  type UpdateState,
  writeState,
} from './plan.js';

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
const WHOLE_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}$/;

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
 * Every variable reference in a compose value — `$$` (an escaped dollar), `${NAME}`, `${NAME<op><word>}`
 * with `<op>` one of `:-` `-` `:?` `?` `:+` `+`, or a bare `$NAME`.
 */
const REFERENCE =
  /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * True when one use leaves its variable with **no non-empty default**: `${V}`, `$V`, `${V:?…}`,
 * `${V?…}`, `${V:-}`, `${V-}`. `${V:-x}`/`${V-x}` have one; `${V:+…}`/`${V+…}` never read `V`'s value.
 */
const hasNoDefault = (operator: string | undefined, word: string): boolean =>
  operator === undefined || operator.endsWith('?') || (operator.endsWith('-') && word === '');

/** The variables some use in the services' environments declares with no non-empty default. */
export const variablesWithoutDefault = (model: ComposeModel): Set<string> => {
  const names = new Set<string>();
  for (const definition of Object.values(model.services)) {
    for (const value of Object.values(definition.environment ?? {})) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(REFERENCE)) {
        if (match[0] === '$$') continue;
        const name = (match[1] ?? match[4]) as string;
        if (hasNoDefault(match[2], match[3] ?? '')) names.add(name);
      }
    }
  }
  return names;
};

/**
 * The values to carry over: for each `KEY: ${VAR…}` of each service, `VAR` ← the running container's
 * `KEY` — only for a `VAR` some use declares with no non-empty default ({@link variablesWithoutDefault}),
 * and unless the env file or the managed block sets `VAR`. A use with no default is read first, so a
 * defaulted use's value (possibly the default itself) is the source only when no other use answers.
 */
export const carriedEnvironment = (
  model: ComposeModel,
  running: ReadonlyMap<string, ReadonlyMap<string, string>>,
  envFileKeys: ReadonlySet<string>,
): Record<string, string> => {
  const managed = new Set<string>(IMAGE_KEYS.map((key) => WORKER_IMAGE_VARIABLE[key]));
  const withoutDefault = variablesWithoutDefault(model);
  const sources: { variable: string; value: string; noDefault: boolean }[] = [];
  for (const [service, definition] of Object.entries(model.services)) {
    const env = running.get(service);
    if (env === undefined) continue;
    for (const [key, value] of Object.entries(definition.environment ?? {})) {
      const whole = typeof value === 'string' ? WHOLE_REFERENCE.exec(value) : null;
      const variable = whole?.[1];
      // `${V:+x}`/`${V+x}`: the container holds the alternative, never `V` — no source.
      if (whole?.[2]?.endsWith('+')) continue;
      if (variable === undefined || managed.has(variable) || envFileKeys.has(variable)) continue;
      if (!withoutDefault.has(variable)) continue;
      const current = env.get(key);
      if (current === undefined) continue;
      sources.push({
        variable,
        value: current,
        noDefault: hasNoDefault(whole?.[2], whole?.[3] ?? ''),
      });
    }
  }
  const carried: Record<string, string> = {};
  for (const preferred of [true, false]) {
    for (const source of sources) {
      if (source.noDefault !== preferred || Object.hasOwn(carried, source.variable)) continue;
      carried[source.variable] = source.value;
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

/**
 * Waits for the worker's `/readyz` to read `core_handshake: ok` — and `launcher: ok` where the worker
 * reports one (backlog 980; a build before it does not, and a rollback may bring one up) — within
 * `seconds`. An update whose worker cannot reach its launcher claims nothing, so it is no success.
 */
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
        checks?: { core_handshake?: unknown; launcher?: unknown };
      } | null;
      const launcher = body?.checks?.launcher;
      last = `${response.status} core_handshake=${String(body?.checks?.core_handshake ?? 'absent')} launcher=${String(launcher ?? 'absent')}`;
      if (
        response.status === 200 &&
        body?.checks?.core_handshake === 'ok' &&
        (launcher === undefined || launcher === 'ok')
      ) {
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
  // The first line only, and only for this core (WP-294: the second line names its core).
  let origin: string | undefined;
  try {
    origin = new URL(coreUrl).origin;
  } catch {
    origin = undefined;
  }
  const credential =
    origin === undefined
      ? null
      : await readStoredCredential(deps.workerStateDir, origin).catch(() => null);
  if (credential === null) {
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

/** The variable `compose.worker.yml` mounts the install folder from (`${APP_WORKER_BUNDLE_DIR:-.}`). */
export const BUNDLE_SOURCE_VARIABLE = 'APP_WORKER_BUNDLE_DIR';
/** In the `updates` volume: the folder's files as they were before an apply, one directory per update. */
export const PREVIOUS_BUNDLE_DIRECTORY = 'previous-bundle';
/** Written there when the folder had no compose file of that name, so a rollback removes the new one. */
const KEPT_ABSENT = '.absent';

/**
 * The names Compose looks for in a folder, in its order, then the name the README once used: where
 * the person's file is looked for when Compose's label names none that is a worker bundle here.
 */
export const BUNDLE_FILE_NAMES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'compose.worker.yml',
] as const;

const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Whether a file is a worker bundle: it declares the `updater` service. Never another project's file. */
const isWorkerBundle = async (file: string): Promise<boolean> =>
  readFile(file, 'utf8').then(
    (text) => {
      // Line endings aside: a file saved on Windows is the same bundle.
      const lines = text.replace(/\r\n?/g, '\n');
      return /\n {2}updater:\n/.test(lines) && lines.includes('ROLE: updater');
    },
    () => false,
  );

/**
 * The person's compose file in the folder: the one Compose recorded it ran (only the **name** of the
 * label's first file, `com.docker.compose.project.config_files`, is used — a Windows label's
 * directory is meaningless here), else the first of {@link BUNDLE_FILE_NAMES} there; either only
 * when it is a worker bundle, so a folder that also holds another project's `compose.yml` keeps it.
 * None, and the apply writes `compose.yaml` — unless a `compose.yaml` that is **not** a worker bundle
 * is there, which is never overwritten: `null`, and nothing of the folder is rewritten.
 */
export const bundleFileIn = async (
  folder: string,
  configFiles: string | null,
): Promise<string | null> => {
  const recorded = configFiles?.split(',')[0]?.trim().split(/[\\/]/).pop() ?? '';
  const names = [...(/^[A-Za-z0-9._-]+$/.test(recorded) ? [recorded] : []), ...BUNDLE_FILE_NAMES];
  for (const name of names) {
    if (await isWorkerBundle(path.join(folder, name))) return path.join(folder, name);
  }
  const fallback = path.join(folder, BUNDLE_FILE_NAMES[0]);
  return (await exists(fallback)) ? null : fallback;
};

/** `<registry>/<namespace>` of a `…/platform@sha256:…` reference: what the core renders with. */
export const repositoryOf = (platformReference: string): string => {
  const at = platformReference.lastIndexOf('/platform@');
  if (at <= 0) {
    throw new Error(`${platformReference} is not a <repository>/platform@<digest> reference`);
  }
  return platformReference.slice(0, at);
};

export const runApply = async (plan: UpdatePlan, deps: ApplyDeps): Promise<UpdateState> => {
  const { docker, logger } = deps;
  const project: ComposeProject = {
    name: plan.project,
    workingDir: plan.working_dir,
    envFile: plan.env_file,
  };
  /** The folder's compose file — the one the person runs — which this apply keeps current. */
  const recordedFiles =
    (await projectContainers(docker, plan.project).catch(() => []))
      .map((container) => container.Config?.Labels?.['com.docker.compose.project.config_files'])
      .find((label): label is string => typeof label === 'string' && label !== '') ?? null;
  const bundleFile = await bundleFileIn(plan.working_dir, recordedFiles);
  /** Where the compose file is written (and, for a crashed apply, put back). */
  const bundleTarget = bundleFile ?? path.join(plan.working_dir, BUNDLE_FILE_NAMES[0]);
  /**
   * A git checkout (the repository's own `compose.worker.yml`, run from a clone) is never rewritten:
   * its files are tracked; nor is a folder whose only compose file is not a worker bundle. Its env
   * file is pinned as before, and the image's template is what runs.
   */
  const writeBack = bundleFile !== null && !(await exists(path.join(plan.working_dir, '.git')));
  /** Where the folder's files are kept before they are rewritten: the rollback's source. */
  const kept = path.join(deps.stateDir, PREVIOUS_BUNDLE_DIRECTORY, plan.id);
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
    let folderSource: string | null = null;
    for (const container of await projectContainers(docker, plan.project)) {
      const service = serviceOf(container);
      if (service !== null && !running.has(service)) running.set(service, environmentOf(container));
      folderSource ??=
        container.Mounts?.find(
          (mount) => mount.Type === 'bind' && mount.Destination === HOST_BUNDLE_MOUNT,
        )?.Source ?? null;
    }
    const env = {
      ...carriedEnvironment(model, running, keysOfEnvFile(envText)),
      ...(references === null ? {} : referencesEnvironment(references)),
      // The folder's source for the updater's own mount of it, as Docker reports it: from the
      // folder-as-project-directory, `${APP_WORKER_BUNDLE_DIR:-.}` would name the container's path.
      ...(folderSource === null ? {} : { [BUNDLE_SOURCE_VARIABLE]: folderSource }),
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
    options: { readonly restartWorker?: boolean } = {},
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
      // A rollback's `up` may leave the worker as it was — still the drained process, when the
      // forward `up` failed before it recreated it. A restart clears a drain's pause (and only a
      // drain's: an owner's *Pause* survives it, TD-031's 2026-11-05 amendment).
      if (options.restartWorker === true) {
        await compose(template, ['restart', WORKER_SERVICE], references);
      }
    } catch (error) {
      return { ok: false, detail: `up failed: ${(error as Error).message}` };
    }
    const handshake = await waitForHandshake(deps, plan.worker_url, plan.check_seconds);
    const image = await workerImageOf(docker, plan.project).catch(() => null);
    if (!handshake.ok) {
      return {
        ok: false,
        detail: `the worker's /readyz did not read core_handshake and launcher: ok within ${plan.check_seconds} s (${handshake.last})`,
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

  /** A drained worker's restart: a drain's pause ends with the process (TD-031, 2026-11-05). */
  const restartDrained = async (template: string): Promise<void> => {
    await compose(template, ['restart', WORKER_SERVICE], plan.from).catch((restart: unknown) =>
      logger.error({ err: restart }, 'the drained worker could not be restarted'),
    );
  };

  /**
   * The parts of the folder this apply has rewritten, each set only once it is on disk: a failure is
   * answered by putting back exactly those, each on its own (S-22.21, review of PR #57). The compose
   * file's write is atomic (a rename), so a failed write leaves it untouched and needs no restore.
   */
  const written = { env: false, bundle: false };

  /**
   * Puts back what `parts` names, each part independently and byte for byte (a copy, then a rename).
   * Answers `file` when the folder's compose file is back, `absent` when it had none (the new one is
   * removed), `none` when it was not asked for or nothing was kept. **Throws** naming every part that
   * could not be put back: a half-restored folder is reported, never swallowed.
   */
  const restoreFolder = async (parts: {
    readonly env: boolean;
    readonly bundle: boolean;
  }): Promise<'file' | 'absent' | 'none'> => {
    const failures: string[] = [];
    let bundleState: 'file' | 'absent' | 'none' = 'none';
    if (parts.bundle) {
      try {
        const keptFile = path.join(kept, path.basename(bundleTarget));
        if (await exists(keptFile)) {
          await copyFileAtomically(keptFile, bundleTarget);
          bundleState = 'file';
        } else if (await exists(path.join(kept, KEPT_ABSENT))) {
          await rm(bundleTarget, { force: true });
          bundleState = 'absent';
        }
      } catch (error) {
        failures.push(`the compose file: ${(error as Error).message}`);
      }
    }
    if (parts.env) {
      try {
        await restorePrevious(plan.env_file);
      } catch (error) {
        failures.push(`the env file: ${(error as Error).message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`the install folder could not be put back (${failures.join('; ')})`);
    }
    return bundleState;
  };

  const rollback = async (why: string, fallbackTemplate: string): Promise<void> => {
    await save({ step: 'rolling_back', detail: why });
    logger.warn({ update_id: plan.id, why }, 'the update failed; rolling back');
    let template = bundleTarget;
    try {
      // An apply that crashed knows nothing of what it wrote: everything that was kept goes back.
      const parts = plan.mode === 'rollback' ? { env: true, bundle: true } : written;
      const restored = await restoreFolder(parts);
      // The previous image's template when the folder holds no compose file of its own to run.
      if (restored !== 'file') template = fallbackTemplate;
    } catch (error) {
      await finish('failed', `${why}; ${(error as Error).message}`);
      return;
    }
    const back = await upAndCheck(template, plan.from, { restartWorker: true });
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
    await restartDrained(deps.templatePath);
    await finish('failed', `pull failed, nothing changed: ${(error as Error).message}`);
    return state;
  }

  // 2. The new build's compose file, rendered from the template this (the new, verified) image
  // carries for the new digests — never a file the core served (TD-032 §3).
  let rendered: string;
  try {
    rendered = renderWorkerCompose(await readFile(deps.templatePath, 'utf8'), {
      digests: plan.to_digests,
      repository: repositoryOf(plan.to.platform),
      coreUrl: plan.core_url,
    });
  } catch (error) {
    await restartDrained(deps.templatePath);
    await finish(
      'failed',
      `the new build's compose template cannot be rendered, nothing changed: ${(error as Error).message}`,
    );
    return state;
  }

  // 3. Write it back into the folder and pin `.env`, the previous files kept first (S-22.21): the
  // folder then holds what runs, so a person's own `docker compose up` there is this build.
  try {
    if (writeBack) {
      await mkdir(kept, { recursive: true });
      if (await exists(bundleTarget)) {
        await copyFile(bundleTarget, path.join(kept, path.basename(bundleTarget)));
      } else {
        await writeFile(path.join(kept, KEPT_ABSENT), '');
      }
    }
    await pinReferences(plan.env_file, plan.to);
    written.env = true;
    if (writeBack) {
      await writeFileAtomically(bundleTarget, rendered);
      written.bundle = true;
    }
    await save({ step: 'pinned' });
  } catch (error) {
    let detail = `the install folder could not be written, so nothing of it was changed: ${(error as Error).message}`;
    try {
      await restoreFolder(written);
    } catch (restore) {
      detail = `the install folder could not be written (${(error as Error).message}), and ${(restore as Error).message}`;
    }
    await restartDrained(deps.templatePath);
    await finish('failed', detail);
    return state;
  }

  // 4–5. Up from the folder, and check.
  const running = writeBack ? bundleTarget : deps.templatePath;
  const up = await upAndCheck(running, plan.to);
  if (!up.ok) {
    await rollback(up.detail, previousTemplate);
    return state;
  }
  await save({ step: 'checked' });

  // 6. Report, then the updater last.
  await finish('succeeded', null);
  try {
    await compose(running, ['up', '-d', '--no-deps', 'updater'], plan.to);
  } catch (error) {
    logger.error(
      { err: error },
      'the update succeeded but the updater could not be recreated on the new build; the next `docker compose up` does it',
    );
  }
  return state;
};
