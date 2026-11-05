/**
 * **`ROLE=updater`, worker mode** — WP-287 (2), TD-032 decisions 3, 4 and 6.
 *
 * A long-running container of the worker's compose project. Every {@link UpdaterConfig.pollMs}
 * (five minutes) — and at once when the worker reports a `426` (its `/internal/state` reads
 * `upgrade_required`, looked at every 15 s) — it asks the core's `GET release` with the worker's
 * credential and, when the advertised digests differ from the four this worker runs:
 *
 *  1. **verifies every advertised digest's build attestation** against the identity configured on
 *     this worker (`attestation.ts`). A digest that does not verify is refused, reported (`failed`,
 *     naming it) **once per advertised set**, and **nothing is pulled**. A worker with no verifier
 *     configured refuses by name, the same way;
 *  2. **refuses a downgrade** below the running build unless the core's protocol range excludes this
 *     worker (`decide.ts`), reported the same way;
 *  3. **pulls** the four verified references (so a pull failure changes nothing and drains nothing);
 *  4. **drains** the worker (`POST /internal/drain`, `via: worker_internal_drain`) and **waits until it
 *     is idle** — a drained worker stays up, it does not exit (TD-031's 2026-11-05 amendment);
 *  5. writes its own template to `updates/compose.previous.yml` (the rollback's) and **starts the
 *     apply container from the new image** (`apply.ts`): labelled, `--rm`, outside the project, on
 *     the same two networks as this container and with the project directory mounted **at its host
 *     path**, so the compose project it drives is the one the person brought up.
 *
 * The apply recreates this container last on success. On a rollback or a failure this updater stays,
 * remembers the set it could not apply, and does not try it again — until the core advertises
 * another one.
 *
 * At start it reads `updates/state.json`: a non-terminal state with no apply container running is a
 * crashed apply, and it starts one in `rollback` mode from **its own** (the previous) image; a
 * terminal result the core was never told is reported.
 *
 * **Its Docker access is root-equivalent on this machine** (TD-032 §4, TD-021's residual): the proxy
 * filters by API path only. What keeps it to the worker's project is this code: the project's name
 * and directory are read from this container's own compose labels, never from the core.
 */
import { randomUUID } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@platform/application';
import { type CoreImageDigests, WORKER_PROTOCOL_VERSION } from '@platform/contracts';
import { CoreCallError, createCoreClient } from '../remote-worker/core-client.js';
import { reportResult } from './apply.js';
import {
  AttestationRefusedError,
  type AttestationVerifier,
  type VerifiedBuild,
} from './attestation.js';
import type { UpdaterConfig } from './config.js';
import {
  decideUpdate,
  IMAGE_KEYS,
  type ImageReferences,
  repositoriesOf,
  runningDigestsOf,
  sameDigests,
} from './decide.js';
import { type ComposeProject, type DockerRun, inspectContainers } from './docker.js';
import {
  isTerminal,
  PREVIOUS_TEMPLATE_FILE,
  readState,
  type UpdatePlan,
  updatePlanSchema,
  writeState,
} from './plan.js';
import { parseImageRepositoryName } from './registry.js';

/** How often the worker's `/internal/state` is read for a `426` and, while draining, for idle. */
export const WORKER_STATE_POLL_MS = 15_000;
/** The label every apply container carries, valued with the project's name. */
export const APPLY_LABEL = 'org.platform.update-apply';

export interface UpdaterDeps {
  readonly config: UpdaterConfig;
  readonly docker: DockerRun;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly logger: Logger;
  /** `null` when {@link UpdaterConfig.verifier} is: this worker never self-updates. */
  readonly verifier: AttestationVerifier | null;
  /** This container's id (`HOSTNAME`), whose compose labels name the project. */
  readonly containerId: string;
  /** The template this image carries — the rollback's, written before an apply starts. */
  readonly templatePath: string;
  /** The environment the apply container is given beside the plan (`DOCKER_HOST`, `LOG_LEVEL`). */
  readonly applyEnvironment: Readonly<Record<string, string>>;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Where this updater runs, read off its own container. */
export interface SelfContainer {
  readonly project: ComposeProject;
  readonly image: string;
  readonly networks: readonly string[];
  readonly updatesVolume: string;
  readonly workerStateVolume: string;
}

export class UpdaterSetupError extends Error {
  override readonly name = 'UpdaterSetupError';
}

/** The project, its directory and env file, its networks and volumes — from this container's labels. */
export const discoverSelf = async (
  docker: DockerRun,
  containerId: string,
  config: Pick<UpdaterConfig, 'stateDir' | 'workerStateDir'>,
): Promise<SelfContainer> => {
  const [self] = await inspectContainers(docker, [containerId]);
  if (self === undefined) throw new UpdaterSetupError(`container ${containerId} is not visible`);
  const labels = self.Config?.Labels ?? {};
  const name = labels['com.docker.compose.project'];
  const workingDir = labels['com.docker.compose.project.working_dir'];
  if (name === undefined || workingDir === undefined || !workingDir.startsWith('/')) {
    throw new UpdaterSetupError(
      'this updater is not a service of a compose project (no com.docker.compose.project labels); it updates nothing',
    );
  }
  const envFiles = (labels['com.docker.compose.project.environment_file'] ?? '')
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
  if (envFiles.length > 1) {
    throw new UpdaterSetupError(
      `the project was brought up with ${envFiles.length} env files; the updater manages one (pass a single --env-file)`,
    );
  }
  const envFile = envFiles[0] ?? path.join(workingDir, '.env');
  const relative = path.relative(workingDir, envFile);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
    throw new UpdaterSetupError(
      `the project's env file ${envFile} is outside its directory ${workingDir}; the updater writes only inside it`,
    );
  }
  const volumeAt = (destination: string): string => {
    const mount = self.Mounts?.find((entry) => entry.Destination === destination);
    if (mount?.Type !== 'volume' || mount.Name === undefined) {
      throw new UpdaterSetupError(`no named volume is mounted at ${destination}`);
    }
    return mount.Name;
  };
  return {
    project: { name, workingDir, envFile },
    image: self.Config?.Image ?? '',
    networks: Object.keys(self.NetworkSettings?.Networks ?? {}).sort(),
    updatesVolume: volumeAt(config.stateDir),
    workerStateVolume: volumeAt(config.workerStateDir),
  };
};

/** The `docker container create` arguments of an apply container (`--rm`, labelled, no compose labels). */
export const applyContainerArgs = (input: {
  readonly self: SelfContainer;
  readonly plan: UpdatePlan;
  readonly image: string;
  readonly stateDir: string;
  readonly workerStateDir: string;
  readonly environment: Readonly<Record<string, string>>;
}): string[] => {
  const { self, plan } = input;
  const network = self.networks[0];
  if (network === undefined) throw new UpdaterSetupError('this updater joins no network');
  return [
    'container',
    'create',
    '--name',
    `${self.project.name}-update-apply`,
    '--rm',
    '--user',
    '0:0',
    '--label',
    `${APPLY_LABEL}=${self.project.name}`,
    '--label',
    `org.platform.update-id=${plan.id}`,
    '--env',
    'ROLE=update-apply',
    '--env',
    `APP_UPDATE_PLAN=${JSON.stringify(updatePlanSchema.parse(plan))}`,
    '--env',
    `APP_UPDATE_STATE_DIR=${input.stateDir}`,
    '--env',
    `APP_WORKER_STATE_DIR=${input.workerStateDir}`,
    ...Object.entries(input.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--mount',
    `type=bind,source=${self.project.workingDir},target=${self.project.workingDir}`,
    '--mount',
    `type=volume,source=${self.updatesVolume},target=${input.stateDir}`,
    '--mount',
    `type=volume,source=${self.workerStateVolume},target=${input.workerStateDir},readonly`,
    '--network',
    network,
    input.image,
  ];
};

const digestsKey = (digests: CoreImageDigests): string =>
  IMAGE_KEYS.map((key) => digests[key]).join(',');

export interface Updater {
  /** One poll, as the loop runs it — exported for the tests. */
  tick(): Promise<void>;
  /** Start-up recovery: finish what a crashed apply left (`state.json`). */
  recover(): Promise<void>;
  /** Runs `recover` then the loop until {@link Updater.stop}. */
  run(): Promise<void>;
  stop(): void;
}

export const createUpdater = (deps: UpdaterDeps): Updater => {
  const { config, docker, logger } = deps;
  /** `null` while no core is configured: the updater idles (S-22.17's first-run page). */
  const core =
    config.coreUrl === null
      ? null
      : createCoreClient({ baseUrl: config.coreUrl, fetch: (url, init) => deps.fetch(url, init) });
  /** The running set's verified build — its commit and time — once read (it does not change). */
  let runningBuild: { readonly commit: string | null; readonly at: Date | null } | null = null;
  /** Advertised sets this updater will not try again: refused, rolled back or failed. */
  const settled = new Set<string>();
  let stopped = false;
  let self: SelfContainer | null = null;
  let wake: (() => void) | null = null;
  /** The worker's connection at the last look: a `426` wakes a poll once, on the transition. */
  let lastConnection: string | null = null;

  const selfContainer = async (): Promise<SelfContainer> => {
    self ??= await discoverSelf(docker, deps.containerId, config);
    return self;
  };

  const credential = async (): Promise<string | null> =>
    readFile(path.join(config.workerStateDir, 'credential'), 'utf8').then(
      (text) => text.trim() || null,
      () => null,
    );

  const workerState = async (): Promise<{
    readonly connection?: string;
    readonly idle?: boolean;
  } | null> => {
    try {
      const response = await deps.fetch(`${config.workerUrl}/internal/state`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      return (await response.json()) as { connection?: string; idle?: boolean };
    } catch {
      return null;
    }
  };

  /** Refused for good (until the core advertises another set): logged, and reported once. */
  const refuse = async (
    running: CoreImageDigests,
    advertised: CoreImageDigests,
    why: string,
  ): Promise<void> => {
    const key = digestsKey(advertised);
    if (settled.has(key)) return;
    settled.add(key);
    logger.error({ advertised, why }, `this worker refuses the update its core advertises: ${why}`);
    await reportResult({ ...deps, workerStateDir: config.workerStateDir }, config.coreUrl ?? '', {
      from: running,
      to: advertised,
      result: 'failed',
      detail: why,
    });
  };

  const launchApply = async (plan: UpdatePlan, image: string): Promise<void> => {
    const me = await selfContainer();
    const created = (
      await docker(
        applyContainerArgs({
          self: me,
          plan,
          image,
          stateDir: config.stateDir,
          workerStateDir: config.workerStateDir,
          environment: deps.applyEnvironment,
        }),
      )
    ).stdout.trim();
    for (const network of me.networks.slice(1)) {
      await docker(['network', 'connect', network, created]);
    }
    await docker(['container', 'start', created]);
    logger.info(
      { update_id: plan.id, mode: plan.mode, image, container: created.slice(0, 12) },
      'the apply container started',
    );
    // Blocks until it exits — or until it recreates this container, which ends this process.
    await docker(['container', 'wait', created], { timeoutMs: 2 * 60 * 60_000 }).catch(
      (error: unknown) => logger.warn({ err: error }, 'waiting for the apply container failed'),
    );
    const state = await readState(config.stateDir).catch(() => null);
    if (state !== null && state.id === plan.id && state.result !== 'succeeded') {
      settled.add(digestsKey(state.to_digests));
    }
    logger.info(
      { update_id: plan.id, result: state?.result ?? null, detail: state?.detail ?? null },
      'the apply container ended',
    );
  };

  /**
   * The four attestations of a set: their one commit and earliest log time, a refusal naming why
   * (one does not verify, or they name no one commit), or `null` for a failure that is not a refusal
   * (a registry or the trust root did not answer) — asked again at the next poll.
   */
  const verifySet = async (
    digests: CoreImageDigests,
  ): Promise<
    | { readonly kind: 'verified'; readonly commit: string; readonly at: Date }
    | { readonly kind: 'refused'; readonly why: string }
    | null
  > => {
    if (config.verifier === null || deps.verifier === null) {
      return { kind: 'refused', why: config.verifierMissing ?? 'no verifier is configured' };
    }
    const repositories = repositoriesOf(config.verifier.repository);
    const builds: VerifiedBuild[] = [];
    for (const key of IMAGE_KEYS) {
      const image = parseImageRepositoryName(repositories[key]);
      if (image === null) {
        return { kind: 'refused', why: `${repositories[key]} is not an image repository` };
      }
      try {
        builds.push(await deps.verifier.verify(repositories[key], image, digests[key]));
      } catch (error) {
        if (error instanceof AttestationRefusedError)
          return { kind: 'refused', why: error.message };
        logger.warn(
          { err: error, image: repositories[key] },
          'the attestation could not be read; asked again later',
        );
        return null;
      }
    }
    const commits = new Set(builds.map((build) => build.commit));
    const [commit] = [...commits];
    if (commits.size !== 1 || commit === null || commit === undefined) {
      return {
        kind: 'refused',
        why: `the four images do not name one commit (${builds
          .map((build) => `${build.repository}: ${build.commit ?? 'none'}`)
          .join(', ')}); a mixed set is refused`,
      };
    }
    const at = new Date(Math.min(...builds.map((build) => build.loggedAt.getTime())));
    return { kind: 'verified', commit, at };
  };

  const tick = async (): Promise<void> => {
    if (core === null) {
      logger.info({}, 'no core is configured yet (APP_CORE_URL); the updater waits');
      return;
    }
    const token = await credential();
    if (token === null) {
      logger.debug({}, 'this worker is not logged in yet; there is nothing to follow');
      return;
    }
    let answer: Awaited<ReturnType<typeof core.release>>;
    try {
      answer = await core.release(token);
    } catch (error) {
      if (error instanceof CoreCallError && error.kind === 'unauthenticated') {
        logger.warn({}, 'the core refuses this worker’s credential; nothing to follow');
      } else {
        logger.warn({ err: error }, 'the core’s release could not be read; asked again later');
      }
      return;
    }
    const running = runningDigestsOf(config.running);
    const advertised = answer.digests;
    if (advertised === null || running === null || sameDigests(running, advertised)) {
      logger.debug({}, 'nothing to update');
      return;
    }
    if (settled.has(digestsKey(advertised))) return;
    // 1. Every digest's attestation, before anything else is read or pulled; one commit for all four.
    const target = await verifySet(advertised);
    if (target === null) return;
    if (target.kind === 'refused') {
      await refuse(running, advertised, target.why);
      return;
    }
    logger.info(
      { advertised, commit: target.commit },
      'every advertised digest’s build attestation verifies, all four at one commit',
    );
    // 2. Not a downgrade (unless the core no longer serves this worker): the running set's build,
    // read the same way. A running set that does not verify cannot be ordered.
    if (runningBuild === null) {
      const current = await verifySet(running);
      if (current === null) return;
      runningBuild =
        current.kind === 'verified'
          ? { commit: current.commit, at: current.at }
          : { commit: null, at: null };
    }
    const decision = decideUpdate({
      running,
      advertised,
      accepted: answer.accepted,
      protocol: WORKER_PROTOCOL_VERSION,
      runningCommit: runningBuild.commit,
      targetCommit: target.commit,
      runningAt: runningBuild.at,
      targetAt: target.at,
    });
    if (decision.kind === 'none') return;
    if (decision.kind === 'refuse') {
      await refuse(running, advertised, decision.why);
      return;
    }
    const repositories = repositoriesOf(config.verifier?.repository ?? '');
    const to = Object.fromEntries(
      IMAGE_KEYS.map((key) => [key, `${repositories[key]}@${advertised[key]}`]),
    ) as unknown as ImageReferences;
    // 3. Pull the verified images first: a failure here changes nothing and drains nothing.
    try {
      for (const key of IMAGE_KEYS) {
        await docker(['image', 'pull', '--quiet', to[key]], { timeoutMs: 30 * 60_000 });
      }
    } catch (error) {
      logger.warn({ err: error }, 'the verified images could not be pulled; asked again later');
      return;
    }
    // 4. Drain, then wait until idle — however long the run in flight takes.
    logger.info({ to }, 'draining this worker for the update');
    await deps
      .fetch(`${config.workerUrl}/internal/drain`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      })
      .catch((error: unknown) =>
        logger.warn({ err: error }, 'the drain request failed; waiting anyway'),
      );
    for (let waited = 0; !stopped; waited += WORKER_STATE_POLL_MS) {
      const state = await workerState();
      if (state?.idle === true) break;
      if (waited > 0 && waited % (10 * 60_000) === 0) {
        logger.info({ waited_ms: waited }, 'still waiting for the worker’s runs to finish');
      }
      await deps.sleep(WORKER_STATE_POLL_MS);
    }
    if (stopped) return;
    // 5. The rollback's template, the state, and the apply from the new image.
    await copyFile(deps.templatePath, path.join(config.stateDir, PREVIOUS_TEMPLATE_FILE));
    const me = await selfContainer();
    const plan: UpdatePlan = {
      id: randomUUID(),
      mode: 'update',
      project: me.project.name,
      working_dir: me.project.workingDir,
      env_file: me.project.envFile,
      from: config.running,
      to,
      from_digests: running,
      to_digests: advertised,
      core_url: config.coreUrl ?? '',
      worker_url: config.workerUrl,
      check_seconds: config.checkSeconds,
    };
    await writeState(config.stateDir, {
      id: plan.id,
      mode: 'update',
      step: 'launched',
      result: null,
      detail: null,
      from_digests: running,
      to_digests: advertised,
      from: plan.from,
      to: plan.to,
      started_at: deps.now().toISOString(),
      finished_at: null,
      reported: false,
    });
    await launchApply(plan, to.platform);
  };

  const recover = async (): Promise<void> => {
    const coreUrl = config.coreUrl;
    // Nothing to report to, and nothing applied without a core: there is nothing to recover.
    if (coreUrl === null) return;
    const state = await readState(config.stateDir);
    if (state === null) return;
    if (isTerminal(state)) {
      if (state.result !== 'succeeded') settled.add(digestsKey(state.to_digests));
      if (!state.reported) {
        const reported = await reportResult(
          { ...deps, workerStateDir: config.workerStateDir },
          coreUrl,
          {
            from: state.from_digests,
            to: state.to_digests,
            result: state.result ?? 'failed',
            detail: state.detail,
          },
        );
        await writeState(config.stateDir, { ...state, reported });
      }
      return;
    }
    const me = await selfContainer();
    const { stdout } = await docker([
      'container',
      'ls',
      '--quiet',
      '--filter',
      `label=${APPLY_LABEL}=${me.project.name}`,
    ]);
    if (stdout.trim() !== '') {
      logger.info({ update_id: state.id }, 'an apply is still running; waiting for it');
      await docker(['container', 'wait', stdout.trim().split('\n')[0] as string], {
        timeoutMs: 2 * 60 * 60_000,
      }).catch(() => undefined);
      return;
    }
    logger.warn(
      { update_id: state.id, step: state.step },
      'the last apply did not finish; rolling back from this (the previous) image',
    );
    settled.add(digestsKey(state.to_digests));
    await launchApply(
      {
        id: state.id,
        mode: 'rollback',
        project: me.project.name,
        working_dir: me.project.workingDir,
        env_file: me.project.envFile,
        from: state.from,
        to: state.to,
        from_digests: state.from_digests,
        to_digests: state.to_digests,
        core_url: coreUrl,
        worker_url: config.workerUrl,
        check_seconds: config.checkSeconds,
      },
      me.image,
    );
  };

  /** Sleeps until the next poll, or until the worker reports a `426`. */
  const pause = async (): Promise<void> => {
    const deadline = deps.now().getTime() + config.pollMs;
    while (!stopped && deps.now().getTime() < deadline) {
      await Promise.race([
        deps.sleep(Math.min(WORKER_STATE_POLL_MS, Math.max(0, deadline - deps.now().getTime()))),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      wake = null;
      const state = await workerState();
      const connection = state?.connection ?? null;
      const changed = connection !== lastConnection;
      lastConnection = connection;
      if (connection === 'upgrade_required' && changed) {
        logger.info({}, 'the worker reports a 426: asking the core now');
        return;
      }
    }
  };

  return {
    tick,
    recover,
    async run() {
      if (config.verifier === null) {
        logger.error({}, config.verifierMissing ?? 'no verifier is configured');
      }
      try {
        await recover();
      } catch (error) {
        logger.error({ err: error }, 'the start-up recovery failed');
      }
      while (!stopped) {
        try {
          await tick();
        } catch (error) {
          logger.error({ err: error }, 'an update poll failed');
        }
        await pause();
      }
    },
    stop() {
      stopped = true;
      wake?.();
    },
  };
};
