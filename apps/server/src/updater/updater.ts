/**
 * **`ROLE=updater`, worker mode** — WP-287 (2), TD-032 decisions 3, 4 and 6.
 *
 * A long-running container of the worker's compose project. **At start** (after the start-up
 * recovery), then every {@link UpdaterConfig.pollMs} (a minute, TD-032's 2026-11-06 amendment to
 * decision 6) — and at once when the worker reports a `426` (its `/internal/state` reads
 * `upgrade_required`, looked at every 15 s) — it asks the core's `GET release` with the worker's
 * credential. A poll that **failed** (the core did not answer, refused the credential, or a
 * registry or Sigstore's trust root did not answer) **backs off**: the next waits twice as long,
 * up to {@link MAX_POLL_BACKOFF_MS}, and the first poll that works resets it
 * ({@link nextPollDelayMs}). When the advertised digests differ from the four this worker runs:
 *
 *  1. **verifies every advertised digest's build attestation** against the identity configured on
 *     this worker (`attestation.ts`). A digest that does not verify is refused, reported (`failed`,
 *     naming it) **once per advertised set**, and **nothing is pulled**. A worker with no verifier
 *     configured refuses by name, the same way. A set that verified is **remembered** (its commit
 *     and time), so a poll that answers the same set again — after a pull that failed, say — does
 *     not verify it again; the running set's build is read once for the same reason;
 *  2. **refuses a downgrade** below the running build unless the core's protocol range excludes this
 *     worker (`decide.ts`), reported the same way;
 *  3. **pulls** the four verified references (so a pull failure changes nothing and drains nothing);
 *  4. **drains** the worker (`POST /internal/drain`, `via: worker_internal_drain`) and **waits until it
 *     is idle** — a drained worker stays up, it does not exit (TD-031's 2026-11-05 amendment);
 *  5. writes its own template to `updates/compose.previous.yml` (the rollback's last resort) and
 *     **starts the apply container from the new image** (`apply.ts`): labelled, `--rm`, outside the
 *     project, on the same two networks as this container, with the person's install folder mounted
 *     at the **fixed** path {@link HOST_BUNDLE_MOUNT} — the source exactly as Docker reports it for
 *     this container's own mount of it (`${APP_WORKER_BUNDLE_DIR:-.}` in `compose.worker.yml`), so a
 *     `C:\Users\…` folder on Docker Desktop for Windows works and no host path is ever parsed
 *     (S-22.21, TD-032's 2026-11-05 decision-4 amendment, backlog 990). The apply drives the project
 *     **by name** from that folder and writes the new build back into it, so the folder always holds
 *     what runs.
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
 * filters by API path only. What keeps it to the worker's project is this code: the project's name is
 * read from this container's own compose labels, never from the core, and the folder is the one
 * Compose mounted into this container.
 */
import { randomUUID } from 'node:crypto';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@platform/application';
import { type CoreImageDigests, WORKER_PROTOCOL_VERSION } from '@platform/contracts';
import { CoreCallError, createCoreClient } from '../remote-worker/core-client.js';
import { readStoredCredential } from '../remote-worker/credential.js';
import { readStoredCoreUrl } from '../remote-worker/setup-files.js';
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
import { HEARTBEAT_EVERY_MS, writeHeartbeat } from './heartbeat.js';
import {
  HOST_BUNDLE_MOUNT,
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
/** The longest a failed poll's back-off waits (TD-032's 2026-11-06 amendment): five minutes. */
export const MAX_POLL_BACKOFF_MS = 300_000;

/** What one poll came to: `failed` is a poll to be asked again later, and backs the next one off. */
export type PollOutcome = 'ok' | 'failed';

/**
 * The wait before the next poll: the configured interval after a poll that worked, doubling with
 * each consecutive failure up to {@link MAX_POLL_BACKOFF_MS} — or the interval itself, when an
 * operator configured a longer one than that.
 */
export const nextPollDelayMs = (pollMs: number, consecutiveFailures: number): number => {
  if (consecutiveFailures <= 0) return pollMs;
  const cap = Math.max(MAX_POLL_BACKOFF_MS, pollMs);
  return Math.min(pollMs * 2 ** Math.min(consecutiveFailures, 30), cap);
};

/** The label every apply container carries, valued with the project's name. */
export const APPLY_LABEL = 'org.platform.update-apply';
export { HOST_BUNDLE_MOUNT };

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

/**
 * The compose project an apply drives: the person's project by name, from the mounted folder, with
 * the env file it was brought up with — by its name, inside that folder ({@link envFileNameOf}).
 */
export const bundleOf = (name: string, envFileName = '.env'): ComposeProject => ({
  name,
  workingDir: HOST_BUNDLE_MOUNT,
  envFile: path.posix.join(HOST_BUNDLE_MOUNT, envFileName),
});

/** A host path's last segment, either separator (a Windows label's too); `null` when unusable. */
const lastSegment = (
  hostPath: string,
): { readonly folder: string; readonly name: string } | null => {
  const trimmed = hostPath.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = trimmed.slice(at + 1);
  if (at < 0 || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') return null;
  return { folder: trimmed.slice(0, at).replace(/[\\/]+$/, ''), name };
};

/**
 * The name of the env file the project was brought up with (`--env-file .env.worker`), from Compose's
 * `environment_file` label, inside the folder the `working_dir` label names — else `.env`. Only the
 * file's **name** is used (the folder is the mount); the labels are compared as strings, never
 * opened. Several env files, or one outside the project's folder, cannot be kept current through the
 * mount: refused by name, before anything is pulled or drained.
 */
export const envFileNameOf = (labels: Readonly<Record<string, string>>): string => {
  const files = (labels['com.docker.compose.project.environment_file'] ?? '')
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
  if (files.length === 0) return '.env';
  if (files.length > 1) {
    throw new UpdaterSetupError(
      `the project was brought up with ${files.length} env files; the updater keeps one current (pass a single --env-file)`,
    );
  }
  const file = lastSegment(files[0] as string);
  const workingDir = (labels['com.docker.compose.project.working_dir'] ?? '').replace(
    /[\\/]+$/,
    '',
  );
  if (file === null || workingDir === '' || file.folder !== workingDir) {
    throw new UpdaterSetupError(
      `the project's env file ${JSON.stringify((files[0] as string).slice(0, 200))} is not a file in its folder ${JSON.stringify(workingDir.slice(0, 200))}; the updater keeps only the folder's own files current`,
    );
  }
  return file.name;
};

/** Where this updater runs, read off its own container. */
export interface SelfContainer {
  /** The person's project by name, run from {@link bundleOf}. */
  readonly project: ComposeProject;
  /**
   * The source of this container's {@link HOST_BUNDLE_MOUNT}, exactly as Docker reports it — handed
   * back to Docker for the apply's own mount, never read as a path.
   */
  readonly hostBundleSource: string;
  readonly image: string;
  readonly networks: readonly string[];
  readonly updatesVolume: string;
  readonly workerStateVolume: string;
}

export class UpdaterSetupError extends Error {
  override readonly name = 'UpdaterSetupError';
}

/** The project, its networks and volumes — from this container's labels and mounts. */
export const discoverSelf = async (
  docker: DockerRun,
  containerId: string,
  config: Pick<UpdaterConfig, 'stateDir' | 'workerStateDir'>,
): Promise<SelfContainer> => {
  const [self] = await inspectContainers(docker, [containerId]);
  if (self === undefined) throw new UpdaterSetupError(`container ${containerId} is not visible`);
  const labels = self.Config?.Labels ?? {};
  const name = labels['com.docker.compose.project'];
  if (name === undefined) {
    throw new UpdaterSetupError(
      'this updater is not a service of a compose project (no com.docker.compose.project label); it updates nothing',
    );
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new UpdaterSetupError(
      `the compose project's name ${JSON.stringify(name.slice(0, 80))} is not one Compose accepts on a command line; it updates nothing`,
    );
  }
  const folder = self.Mounts?.find((entry) => entry.Destination === HOST_BUNDLE_MOUNT);
  if (folder?.Type !== 'bind' || folder.Source === undefined || folder.Source === '') {
    throw new UpdaterSetupError(
      `the install folder is not mounted at ${HOST_BUNDLE_MOUNT}, so this updater cannot keep it current: the compose file predates S-22.21 — download it again from the core and run docker compose up -d`,
    );
  }
  const volumeAt = (destination: string): string => {
    const mount = self.Mounts?.find((entry) => entry.Destination === destination);
    if (mount?.Type !== 'volume' || mount.Name === undefined) {
      throw new UpdaterSetupError(`no named volume is mounted at ${destination}`);
    }
    return mount.Name;
  };
  const envFileName = envFileNameOf(labels);
  return {
    project: bundleOf(name, envFileName),
    hostBundleSource: folder.Source,
    image: self.Config?.Image ?? '',
    networks: Object.keys(self.NetworkSettings?.Networks ?? {}).sort(),
    updatesVolume: volumeAt(config.stateDir),
    workerStateVolume: volumeAt(config.workerStateDir),
  };
};

/**
 * A `--mount` value: its fields as CSV, which is how Docker reads it, so a source holding a comma or a
 * quote stays one field.
 */
export const mountSpec = (fields: readonly string[]): string =>
  fields
    .map((field) => (/[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
    .join(',');

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
    mountSpec(['type=bind', `source=${self.hostBundleSource}`, `target=${HOST_BUNDLE_MOUNT}`]),
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
  tick(): Promise<PollOutcome>;
  /** Start-up recovery: finish what a crashed apply left (`state.json`). */
  recover(): Promise<void>;
  /** Runs `recover` then the loop until {@link Updater.stop}. */
  run(): Promise<void>;
  stop(): void;
}

export const createUpdater = (deps: UpdaterDeps): Updater => {
  const { config, docker, logger } = deps;
  /**
   * The core this worker follows: `APP_CORE_URL`, else the platform chosen on the worker's page
   * (`core-url` in `worker-state`, WP-294) — read at every use, so a platform chosen or changed on
   * the page is followed without a restart. `null` while there is none: the updater idles.
   */
  const effectiveCoreUrl = async (): Promise<string | null> =>
    config.coreUrl ?? (await readStoredCoreUrl(config.workerStateDir).catch(() => null));
  /** The running set's verified build — its commit and time — once read (it does not change). */
  let runningBuild: { readonly commit: string | null; readonly at: Date | null } | null = null;
  /** The last advertised set that verified, by its digests: not verified again while it is advertised. */
  let verifiedTarget: {
    readonly key: string;
    readonly commit: string;
    readonly at: Date;
  } | null = null;
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

  /**
   * The worker credential — its first line only, and only when it was recorded for `coreUrl`'s
   * origin (WP-294: the file's second line names the core it belongs to).
   */
  const credential = async (coreUrl: string): Promise<string | null> =>
    readStoredCredential(config.workerStateDir, new URL(coreUrl).origin).catch(() => null);

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
    await reportResult(
      { ...deps, workerStateDir: config.workerStateDir },
      (await effectiveCoreUrl()) ?? '',
      {
        from: running,
        to: advertised,
        result: 'failed',
        detail: why,
      },
    );
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

  const tick = async (): Promise<PollOutcome> => {
    const coreUrl = await effectiveCoreUrl();
    if (coreUrl === null) {
      logger.info(
        {},
        'no core is configured yet (APP_CORE_URL or the worker’s page); the updater waits',
      );
      return 'ok';
    }
    const core = createCoreClient({
      baseUrl: coreUrl,
      fetch: (url, init) => deps.fetch(url, init),
    });
    const token = await credential(coreUrl);
    if (token === null) {
      logger.debug({}, 'this worker is not logged in yet; there is nothing to follow');
      return 'ok';
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
      return 'failed';
    }
    const running = runningDigestsOf(config.running);
    const advertised = answer.digests;
    if (advertised === null || running === null || sameDigests(running, advertised)) {
      logger.debug({}, 'nothing to update');
      return 'ok';
    }
    const advertisedKey = digestsKey(advertised);
    if (settled.has(advertisedKey)) return 'ok';
    // 1. Every digest's attestation, before anything else is read or pulled; one commit for all four.
    // A set that verified once is not verified again while the core keeps advertising it.
    let target: { readonly commit: string; readonly at: Date };
    if (verifiedTarget?.key === advertisedKey) {
      target = verifiedTarget;
    } else {
      const verified = await verifySet(advertised);
      if (verified === null) return 'failed';
      if (verified.kind === 'refused') {
        await refuse(running, advertised, verified.why);
        return 'ok';
      }
      verifiedTarget = { key: advertisedKey, commit: verified.commit, at: verified.at };
      target = verifiedTarget;
      logger.info(
        { advertised, commit: target.commit },
        'every advertised digest’s build attestation verifies, all four at one commit',
      );
    }
    // 2. Not a downgrade (unless the core no longer serves this worker): the running set's build,
    // read the same way. A running set that does not verify cannot be ordered.
    if (runningBuild === null) {
      const current = await verifySet(running);
      if (current === null) return 'failed';
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
    if (decision.kind === 'none') return 'ok';
    if (decision.kind === 'refuse') {
      await refuse(running, advertised, decision.why);
      return 'ok';
    }
    // 2b. Where this updater runs, before anything is pulled or drained (S-22.20): a project it
    // cannot apply to — no install folder mounted at the fixed path (a compose file from before
    // S-22.21), no `updates` volume — is refused and reported once, and the worker keeps taking
    // work. Before S-22.20 the refusal came after the drain, so such a worker stayed drained.
    let me: SelfContainer;
    try {
      me = await selfContainer();
    } catch (error) {
      if (!(error instanceof UpdaterSetupError)) throw error;
      await refuse(
        running,
        advertised,
        `this updater cannot apply an update here: ${error.message}`,
      );
      return 'ok';
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
      return 'failed';
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
    if (stopped) return 'ok';
    // 5. The rollback's template, the state, and the apply from the new image.
    await copyFile(deps.templatePath, path.join(config.stateDir, PREVIOUS_TEMPLATE_FILE));
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
      core_url: (await effectiveCoreUrl()) ?? '',
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
    return 'ok';
  };

  const recover = async (): Promise<void> => {
    const coreUrl = await effectiveCoreUrl();
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

  /** Sleeps `ms` until the next poll, or until the worker reports a `426`. */
  const pause = async (ms: number): Promise<void> => {
    const deadline = deps.now().getTime() + ms;
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
      // The container's healthcheck reads this (backlog 981): written first, then on its own timer.
      let heartbeatFailed = false;
      const beat = (): Promise<void> =>
        writeHeartbeat(config.stateDir, deps.now()).then(
          () => {
            heartbeatFailed = false;
          },
          (error: unknown) => {
            if (!heartbeatFailed) {
              logger.warn({ err: error }, 'the updater’s heartbeat file could not be written');
            }
            heartbeatFailed = true;
          },
        );
      await beat();
      const heartbeat = setInterval(() => void beat(), HEARTBEAT_EVERY_MS);
      try {
        if (config.verifier === null) {
          logger.error({}, config.verifierMissing ?? 'no verifier is configured');
        }
        try {
          await recover();
        } catch (error) {
          logger.error({ err: error }, 'the start-up recovery failed');
        }
        // The first poll is now, not one interval in: a worker installed one build behind its core
        // asks at once (TD-032's 2026-11-06 amendment).
        let failures = 0;
        while (!stopped) {
          let outcome: PollOutcome;
          try {
            outcome = await tick();
          } catch (error) {
            logger.error({ err: error }, 'an update poll failed');
            outcome = 'failed';
          }
          failures = outcome === 'failed' ? failures + 1 : 0;
          const delay = nextPollDelayMs(config.pollMs, failures);
          if (failures > 0) {
            logger.info(
              { consecutive_failures: failures, next_poll_seconds: delay / 1000 },
              'the poll failed; the next one backs off',
            );
          }
          await pause(delay);
        }
      } finally {
        clearInterval(heartbeat);
      }
    },
    stop() {
      stopped = true;
      wake?.();
    },
  };
};
