/**
 * **The worker protocol, the core's half** — WP-281, TD-031 decisions 2, 3, 6, 7, 8, 9 and 14:
 *
 *   POST /api/worker/v1/handshake               worker credential
 *   POST /api/worker/v1/claims                  worker credential, held ≤ 25 s
 *   POST /api/worker/v1/pause                   worker credential — a usage limit's pause (WP-285)
 *   POST /api/worker/v1/runs/:id/heartbeat      run token, held ≤ 20 s
 *   POST /api/worker/v1/runs/:id/release        run token
 *   POST /api/worker/v1/runs/:id/spawn          run token
 *   POST /api/worker/v1/runs/:id/finish         run token
 *   POST /api/worker/v1/runs/:id/late-cost      run token
 *   GET  /api/worker/v1/release                 none — public since WP-294; the protocol check stays
 *   GET  /api/worker/v1/compose.yml             none — a person's first-install download (WP-284 (6))
 *   GET  /api/worker/v1/install.sh              none — the one-command install, macOS and Linux (S-22.20)
 *   GET  /api/worker/v1/install.ps1             none — the one-command install, Windows (S-22.20)
 *   POST /api/worker/v1/update-report           worker credential (WP-287 (4))
 *   POST /api/worker/v1/manual-pause            worker credential, protocol ≥ 2 (WP-292, `owner-verbs.ts`)
 *   POST /api/worker/v1/runs/:id/cancel         run token, protocol ≥ 2 (WP-292, `owner-verbs.ts`)
 *   GET  /api/worker/v1/claim-scope             worker credential, protocol ≥ 3 (WP-293, `pick-verbs.ts`)
 *   PUT  /api/worker/v1/claim-scope             worker credential, protocol ≥ 3 (WP-293)
 *   GET  /api/worker/v1/offers                  worker credential, protocol ≥ 3 (WP-293)
 *   POST /api/worker/v1/offers/:id/claim        worker credential, protocol ≥ 3 (WP-293)
 *
 * Protocol 4 (S-26.4) adds no verb: the claim policy's fields on the handshake, `claim-scope`,
 * `offers` and the pick (`pick-verbs.ts`), accepted beside protocol 3 (`[3, 4]`).
 *
 * and, registered from here with the same authentication (WP-282, `run-calls.ts`): `transcript`,
 * `tools/:name`, `approvals`, `session` and `ssh-sign`. The heartbeat delivers the run's decided
 * approvals beside its commands, and is held only while neither is pending.
 *
 * Every verb under `/api/worker/v1/` first passes {@link registerWorkerProtocolCheck}: `Cache-Control:
 * no-store`, and an `X-Worker-Protocol` the core does not accept answered `426` **before**
 * authentication — the device flow's two verbs included (backlog 712: TD-031 §9 asks the header on
 * *every* request, and a worker whose protocol the core does not serve should learn it before it
 * registers a credential it cannot use).
 *
 * ## Authentication
 *
 * `Authorization: Bearer <credential>` — the worker credential (`wkr_…`) on the worker verbs, the run
 * token (32 bytes, base64url) on the run verbs. Either one missing, malformed, unknown, revoked or
 * belonging to a user who may not act is `401 unauthenticated`, which a worker treats exactly as
 * `lease_lost` (TD-031 §2, §7). A run token authenticates only its own run, and the fence's owner
 * (`worker:<id>`) is derived from it — a body names an epoch and nothing else of the claim. Every
 * authenticated call records the worker's contact (`last_seen_at`, the protocol, the digests a claim
 * or a handshake reported): that is what *online* means to routing (TD-031 §8) and what `/readyz`
 * counts.
 *
 * ## Held requests
 *
 * `claims` is held up to {@link WORKER_CLAIM_HOLD_MS}, woken by `pg_notify('run_offers')` on the
 * broadcast every API process already listens on and by a short poll (an offer becomes claimable
 * when its `workers_from` passes, which nothing announces). `heartbeat` renews at once and, with
 * nothing pending, is held up to {@link WORKER_HEARTBEAT_HOLD_MS}, woken by the lease holder's
 * command topic (`runCommandsTopic('worker:<id>')`, where a cancel, a steer or a take-over
 * notifies). Both end early when the client goes away. Every hold ends by 25 s — under a CDN's idle
 * cut (research/17 § 8).
 */

import {
  type Broadcast,
  type DeliveredRunCommand,
  type RemoteRunCalls,
  type RemoteRuns,
  RUN_OFFERS_TOPIC,
  type RunTokenSubject,
  runCommandsTopic,
  settleOutcomeOfFinish,
  workerLeaseOwner,
} from '@platform/application';
import {
  ACCEPTED_WORKER_PROTOCOLS,
  apiErrorSchema,
  type Id,
  type IsoDateTime,
  isAcceptedWorkerProtocol,
  parseWorkerProtocolHeader,
  runPackageSchema,
  WORKER_API_PREFIX,
  WORKER_CLAIM_HOLD_MS,
  WORKER_HEARTBEAT_HOLD_MS,
  WORKER_PATHS,
  WORKER_PROTOCOL_CLAIM_POLICY,
  WORKER_PROTOCOL_CLAIM_SCOPE,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_LOCAL_UI,
  WORKER_PROTOCOL_VERSION,
  type WorkerUpgradeRequiredBody,
  workerClaimRequestSchema,
  workerFinishRequestSchema,
  workerFinishResponseSchema,
  workerHandshakeRequestSchema,
  workerHandshakeResponseSchema,
  workerHeartbeatRequestSchema,
  workerHeartbeatResponseSchema,
  workerLateCostRequestSchema,
  workerLateCostResponseSchema,
  workerLeaseLostBodySchema,
  workerPauseReasonSchema,
  workerPauseRequestSchema,
  workerReleaseResponseSchema,
  workerRunReleaseRequestSchema,
  workerSpawnRequestSchema,
  workerSpawnResponseSchema,
  workerUpdateReportRequestSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { HttpError } from '../../errors.js';
import type { WorkerStore } from '../../queries/worker-queries.js';
import { renderInstallScripts } from '../../workers/install.js';
import type { WorkerRelease } from '../../workers/release.js';
import { authenticateWorkerCredential } from '../../workers/secrets.js';
import { registerWorkerOwnerVerbs, type WorkerRunCancelPort } from './owner-verbs.js';
import {
  type OfferDisplays,
  registerWorkerPickVerbs,
  storedDigestsOf,
  type WorkerPickVerbOptions,
} from './pick-verbs.js';
import { registerWorkerRunCallRoutes } from './run-calls.js';

/** How often a held claim asks again with no notification: an offer's `workers_from` passing. */
export const WORKER_CLAIM_POLL_MS = 5_000;

const runParamsSchema = z.strictObject({ id: z.uuid() });

export interface WorkerProtocolCheckOptions {
  /** What the `426` names; `null` while the core cannot name its digests. */
  readonly release: () => WorkerRelease | null;
  /** `APP_BASE_URL`: the `426`'s `compose_url` is absolute. */
  readonly baseUrl: string;
}

/** The `426` body (TD-031 §9). */
export const upgradeRequiredBody = (
  options: WorkerProtocolCheckOptions,
  presented: number | null,
): WorkerUpgradeRequiredBody => ({
  error: {
    code: 'upgrade_required',
    message:
      presented === null
        ? `this request carries no valid ${WORKER_PROTOCOL_HEADER} header; this core serves worker protocol ${ACCEPTED_WORKER_PROTOCOLS.join(', ')}`
        : `worker protocol ${presented} is not served by this core, which serves ${ACCEPTED_WORKER_PROTOCOLS.join(', ')}; update the worker (or the core) and claim again`,
  },
  accepted: [...ACCEPTED_WORKER_PROTOCOLS],
  compose_url: new URL(
    `${WORKER_API_PREFIX}/${WORKER_PATHS.composeFile}`,
    options.baseUrl,
  ).toString(),
  digests: options.release()?.digests ?? null,
});

/** The first-install compose file, a worker path a person fetches (TD-031's 2026-11-05 amendment). */
export const WORKER_COMPOSE_FILE_PATH = `${WORKER_API_PREFIX}/${WORKER_PATHS.composeFile}`;

/**
 * The worker paths a person fetches rather than a worker calls: the compose file (TD-031's
 * 2026-11-05 amendment) and the two install scripts (S-22.20, its install-scripts amendment).
 */
export const PUBLIC_WORKER_DOWNLOAD_PATHS: readonly string[] = [
  WORKER_COMPOSE_FILE_PATH,
  `${WORKER_API_PREFIX}/${WORKER_PATHS.installSh}`,
  `${WORKER_API_PREFIX}/${WORKER_PATHS.installPs1}`,
];

/**
 * Whether a request is a public download — `GET` (or the `HEAD` Fastify answers for it) of exactly
 * one of {@link PUBLIC_WORKER_DOWNLOAD_PATHS}, any query — the paths the protocol check skips
 * (TD-031's 2026-11-05 amendments). Each is a human download, not a protocol message.
 */
export const isPublicWorkerDownload = (method: string, url: string): boolean =>
  (method === 'GET' || method === 'HEAD') &&
  PUBLIC_WORKER_DOWNLOAD_PATHS.includes(url.split('?')[0] ?? '');

/**
 * `Cache-Control: no-store` and the protocol check on every `/api/worker/v1/` request, **first**
 * (`onRequest`, before body parsing and authentication). Registered on the root instance before any
 * worker route. The public downloads are the exceptions to the check, never to `no-store` (TD-031's
 * 2026-11-05 amendments).
 */
export const registerWorkerProtocolCheck = (
  app: FastifyInstance,
  options: WorkerProtocolCheckOptions,
): void => {
  const prefix = `${WORKER_API_PREFIX}/`;
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith(prefix)) {
      return;
    }
    reply.header('cache-control', 'no-store');
    if (isPublicWorkerDownload(request.method, request.url)) {
      return;
    }
    const version = parseWorkerProtocolHeader(request.headers[WORKER_PROTOCOL_HEADER]);
    if (version === null || !isAcceptedWorkerProtocol(version)) {
      const body = workerUpgradeRequiredBodySchema.parse(upgradeRequiredBody(options, version));
      reply.code(426).send(body);
      return reply;
    }
  });
};

export interface WorkerProtocolRoutesOptions {
  readonly store: WorkerStore;
  /**
   * The protocol's commands, or `null` in a process that composed none (no job client — a test's
   * app, the census): the routes are registered either way, refuse an anonymous caller with `401`
   * first, and answer an authenticated one `503 worker_protocol_unavailable` by name.
   */
  readonly remoteRuns: RemoteRuns | null;
  /**
   * The run-scoped calls besides the claim (WP-282): transcript, tools, approvals, session mirror,
   * SSH signing. `null`/absent: those routes answer an authenticated caller `503` by name, and the
   * heartbeat delivers no approval.
   */
  readonly runCalls?: RemoteRunCalls | null;
  /**
   * The task page's cancel, for the worker's local page (WP-292). `null`/absent: `runs/:id/cancel`
   * answers an authenticated caller `503 commands_unavailable` by name.
   */
  readonly runCancel?: WorkerRunCancelPort | null;
  /**
   * The display names of the listed offers' tasks (WP-293) — the package's own rule over the redacted
   * ticket snapshot. `null`/absent: `GET offers` lists every offer without its names.
   */
  readonly offerDisplays?: OfferDisplays | null;
  /**
   * Whether somebody other than the asking worker takes each project's unassigned tasks by itself
   * (BACKLOG 1456) — `GET claim-scope?fields=unassigned_has_taker`. `null`/absent: never sent.
   */
  readonly unassignedTakers?: WorkerPickVerbOptions['unassignedTakers'];
  /** `APP_BASE_URL`, for the owner verbs' `426` (`compose_url`). @default `http://localhost` */
  readonly baseUrl?: string;
  readonly release: () => WorkerRelease | null;
  /** Why `release()` is `null`, naming the image (WP-284) — the `503 digests_unresolved`'s words. */
  readonly unresolved?: () => string | null;
  /** Where offers and commands are announced — the process's one `LISTEN`; `null` holds by time. */
  readonly broadcast: Broadcast | null;
  readonly now?: () => Date;
  /** @default WORKER_CLAIM_HOLD_MS */
  readonly claimHoldMs?: number;
  /** @default WORKER_HEARTBEAT_HOLD_MS */
  readonly heartbeatHoldMs?: number;
  /** @default WORKER_CLAIM_POLL_MS */
  readonly claimPollMs?: number;
}

const bearerOf = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/.exec(header.trim());
  return match?.[1] ?? null;
};

const unauthenticated = (what: string): HttpError =>
  new HttpError(
    401,
    'unauthenticated',
    `${what}; a worker treats this as lease_lost and stops the run (TD-031 §7)`,
  );

const leaseLost = (runId: string): HttpError =>
  new HttpError(
    409,
    'lease_lost',
    `run ${runId} is not held under this claim any more: stop the session and destroy the workspace (TD-031 §2)`,
  );

const digestsUnresolved = (why: string | null = null): HttpError =>
  new HttpError(
    503,
    'digests_unresolved',
    why === null
      ? 'this core cannot name its image digests yet (it resolves them from its registry, or APP_WORKER_IMAGE_DIGESTS pins them), so it advertises and packages nothing'
      : `this core cannot name its image digests, so it advertises and packages nothing: ${why}`,
  );

/** The protocol the request spoke; the check has already admitted it. */
const protocolOf = (request: FastifyRequest): number =>
  parseWorkerProtocolHeader(request.headers[WORKER_PROTOCOL_HEADER]) ?? WORKER_PROTOCOL_VERSION;

/** Whether the client went away before the answer — the response closed unfinished. */
export interface ClientPresence {
  readonly gone: () => boolean;
  /** Calls `listener` once if the client goes away; answers the unsubscribe. */
  readonly onGone: (listener: () => void) => () => void;
}

export const presenceOf = (reply: FastifyReply): ClientPresence => {
  let gone = false;
  const listeners = new Set<() => void>();
  reply.raw.once('close', () => {
    if (reply.raw.writableFinished) return;
    gone = true;
    for (const listener of listeners) listener();
  });
  return {
    gone: () => gone,
    onGone: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/**
 * Waits for a message on `topics`, `ms` to pass, or the client to go away — whichever is first.
 * A subscription that fails is a plain wait: the hold degrades to the poll, never to an error.
 */
const hold = async (
  broadcast: Broadcast | null,
  topics: readonly string[],
  ms: number,
  presence: ClientPresence,
): Promise<void> => {
  if (ms <= 0 || presence.gone()) return;
  await new Promise<void>((resolve) => {
    let done = false;
    let subscription: { close: () => Promise<void> } | null = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopWatching();
      void subscription?.close().catch(() => {});
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const stopWatching = presence.onGone(finish);
    broadcast
      ?.subscribe([...topics], () => finish())
      .then(
        (opened) => {
          subscription = opened;
          if (done) void opened.close().catch(() => {});
        },
        () => {},
      );
  });
};

const isoNow = (now: () => Date): IsoDateTime => now().toISOString() as IsoDateTime;

const unavailable = (): never => {
  throw new HttpError(
    503,
    'worker_protocol_unavailable',
    'this process composed no worker protocol (it holds no job client); ask another API replica',
  );
};

/** {@link WorkerProtocolRoutesOptions.remoteRuns}' `null`: every command refuses by name. */
const unavailableRemoteRuns: RemoteRuns = {
  claim: async () => unavailable(),
  offers: async () => unavailable(),
  authenticate: async () => unavailable(),
  heartbeat: async () => unavailable(),
  pending: async () => unavailable(),
  release: async () => unavailable(),
  spawn: async () => unavailable(),
  finish: async () => unavailable(),
  lateCost: async () => unavailable(),
};

/** A delivered command on the wire. */
const wireCommand = (command: DeliveredRunCommand) => ({
  id: command.id,
  kind: command.kind,
  payload: command.payload,
});

export const registerWorkerProtocolRoutes = async (
  app: FastifyInstance,
  options: WorkerProtocolRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const now = options.now ?? (() => new Date());
  const claimHoldMs = options.claimHoldMs ?? WORKER_CLAIM_HOLD_MS;
  const heartbeatHoldMs = options.heartbeatHoldMs ?? WORKER_HEARTBEAT_HOLD_MS;
  const claimPollMs = options.claimPollMs ?? WORKER_CLAIM_POLL_MS;
  const path = (verb: string): string => `${WORKER_API_PREFIX}/${verb}`;
  const remote = options.remoteRuns ?? unavailableRemoteRuns;
  const unresolved = (): HttpError => digestsUnresolved(options.unresolved?.() ?? null);

  /**
   * **Authentication runs in `preValidation`** — after the protocol check, before the body is
   * validated — so a request with no credential is `401` whatever its body (the census's per-route
   * assertion), and nothing of an unauthenticated body is parsed. The subject is kept per request.
   */
  const workers = new WeakMap<FastifyRequest, { readonly workerId: Id }>();
  const runs = new WeakMap<FastifyRequest, RunTokenSubject>();

  const authenticateWorker = async (request: FastifyRequest): Promise<void> => {
    const presented = bearerOf(request);
    const subject =
      presented === null ? null : await authenticateWorkerCredential(options.store, presented);
    if (subject === null) {
      throw unauthenticated('the worker credential is missing, unknown or revoked');
    }
    workers.set(request, { workerId: subject.workerId as Id });
  };

  const authenticateRun = async (request: FastifyRequest): Promise<void> => {
    const runId = (request.params as { readonly id?: unknown }).id;
    const token = bearerOf(request);
    const subject =
      token === null ||
      typeof runId !== 'string' ||
      !runParamsSchema.safeParse({ id: runId }).success
        ? null
        : await remote.authenticate({ runId: runId as Id, token, now: isoNow(now) });
    if (subject === null) {
      throw unauthenticated(`the run token is missing, wrong or expired for this run`);
    }
    runs.set(request, subject);
    await options.store.recordContact({
      workerId: subject.workerId,
      protocolVersion: protocolOf(request),
      imageDigests: null,
    });
  };

  /** The authenticated worker, its contact (and the digests it reported) recorded. */
  const worker = async (request: FastifyRequest, digests: readonly string[]) => {
    const subject = workers.get(request);
    if (subject === undefined) {
      throw unauthenticated('the worker credential is missing');
    }
    const row = await options.store.recordContact({
      workerId: subject.workerId,
      protocolVersion: protocolOf(request),
      imageDigests: digests,
    });
    if (row === null) {
      throw unauthenticated('the worker credential names no worker');
    }
    return { workerId: subject.workerId, row };
  };

  /** A worker verb with no body: the contact is recorded, no digests reported. */
  const workerContact = async (request: FastifyRequest): Promise<void> => {
    const subject = workers.get(request);
    if (subject === undefined) {
      throw unauthenticated('the worker credential is missing');
    }
    const row = await options.store.recordContact({
      workerId: subject.workerId,
      protocolVersion: protocolOf(request),
      imageDigests: null,
    });
    if (row === null) {
      throw unauthenticated('the worker credential names no worker');
    }
  };

  /** The run the token authenticated — only its own. */
  const runHolder = (request: FastifyRequest): RunTokenSubject => {
    const subject = runs.get(request);
    if (subject === undefined) {
      throw unauthenticated('the run token is missing');
    }
    return subject;
  };

  /**
   * A claimed package as the request's protocol reads it: a version-1 worker's strict package schema
   * refuses the display block (the worker-UI amendment §5). Version 1 is no longer accepted since
   * protocol 3 (WP-293), so this holds only while a build accepting it could reach here.
   */
  const packageFor = <P extends { readonly display?: unknown }>(
    request: FastifyRequest,
    pkg: P,
  ): P => {
    if (protocolOf(request) >= WORKER_PROTOCOL_LOCAL_UI) return pkg;
    const { display: _display, ...v1Package } = pkg;
    return v1Package as P;
  };

  /**
   * Answers a claimed package — **or releases it** when the worker already went away (BACKLOG 960):
   * a held `claims` the worker called off (a *Pause*, a *Take this one*), or a pick whose page gave
   * up, would otherwise send the package nowhere and leave the run to the lease sweep with this
   * worker excluded. Before `run.started` a release is the claim undone (TD-031 §6): the offer open
   * again, the epoch kept, the minted credential revoked, nobody excluded (`shutdown`, the worker's
   * own going away). A release that fails is logged; the sweep remains the backstop. The residual is
   * a close that lands after this check, while the answer is being written.
   */
  const deliverClaimed = async (
    request: FastifyRequest,
    reply: FastifyReply,
    presence: ClientPresence,
    workerId: Id,
    pkg: z.output<typeof runPackageSchema>,
  ) => {
    if (!presence.gone()) {
      return reply.code(200).send(packageFor(request, pkg));
    }
    try {
      const released = await remote.release({
        runId: pkg.runId as Id,
        workerId,
        epoch: pkg.epoch,
        reason: 'shutdown',
        now: isoNow(now),
      });
      request.log.info(
        { run_id: pkg.runId, worker_id: workerId, released },
        'the worker went away before its claimed package was answered; the claim is released',
      );
    } catch (error) {
      request.log.error(
        { err: error, run_id: pkg.runId, worker_id: workerId },
        'a claim the worker never received could not be released; the lease sweep ends it',
      );
    }
    return reply.code(204).send(null);
  };

  const runErrors = {
    401: apiErrorSchema,
    409: z.union([workerLeaseLostBodySchema, apiErrorSchema]),
    426: workerUpgradeRequiredBodySchema,
    503: apiErrorSchema,
  } as const;

  typed.post(
    path(WORKER_PATHS.handshake),
    {
      preValidation: authenticateWorker,
      schema: {
        summary: 'Open a worker’s session with this core (TD-031 §9)',
        description:
          'Worker credential. Answers the protocol range this core serves, its four image digests, the compose bundle’s digest, the worker’s settings as the core holds them and the server time; records the digests the worker holds. `503 digests_unresolved` while the core cannot name its digests (WP-281).',
        tags: ['worker'],
        body: workerHandshakeRequestSchema,
        response: {
          200: workerHandshakeResponseSchema,
          401: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request): Promise<z.output<typeof workerHandshakeResponseSchema>> => {
      const { row } = await worker(request, request.body.image_digests);
      const release = options.release();
      if (release === null) {
        throw unresolved();
      }
      const paused = row.pausedUntil !== null && row.pausedUntil.getTime() > now().getTime();
      return {
        protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [...ACCEPTED_WORKER_PROTOCOLS] },
        digests: release.digests,
        compose_bundle_digest: release.composeBundleDigest,
        worker: {
          id: row.id,
          name: row.name,
          concurrency: row.concurrency,
          paused_until: paused ? (row.pausedUntil?.toISOString() as IsoDateTime) : null,
          paused_reason:
            paused && row.pausedReason !== null
              ? workerPauseReasonSchema.parse(row.pausedReason)
              : null,
          // TD-031's worker-UI amendment §5: a version-1 worker's strict schema refuses the key.
          ...(protocolOf(request) >= WORKER_PROTOCOL_LOCAL_UI
            ? {
                manually_paused_at:
                  row.manuallyPausedAt === null
                    ? null
                    : (row.manuallyPausedAt.toISOString() as IsoDateTime),
              }
            : {}),
          // TD-031's claim-scope amendment §6: a version-2 worker's strict schema refuses the key.
          // S-26.4: a version-3 worker is told its *pick only* the way it spells it, `[]`.
          ...(protocolOf(request) >= WORKER_PROTOCOL_CLAIM_SCOPE
            ? {
                claim_project_ids:
                  protocolOf(request) < WORKER_PROTOCOL_CLAIM_POLICY &&
                  row.claimPolicy === 'pick_only'
                    ? []
                    : row.claimProjects === null
                      ? null
                      : row.claimProjects.map((project) => project.id),
              }
            : {}),
          // S-26.4 (TD-031's 2026-11-06 amendment item 7): a version-3 worker refuses the key.
          ...(protocolOf(request) >= WORKER_PROTOCOL_CLAIM_POLICY
            ? { claim_policy: row.claimPolicy }
            : {}),
        },
        server_time: isoNow(now),
      };
    },
  );

  typed.post(
    path(WORKER_PATHS.claims),
    {
      preValidation: authenticateWorker,
      schema: {
        summary: 'Claim an eligible run offer — held up to 25 s (TD-031 §§2, 8, 9)',
        description:
          'Worker credential. The one claim, with the worker’s eligibility checked in its statement (TD-031 §8: a project member at `member`+, not revoked, not paused, not excluded, the offer’s images held, the project’s run credential `minted`), the run token minted and stored hashed, the git credential minted after the claim commits. `200` with the run package, or `204` when nothing was claimable within the hold. A `paused` worker is answered `204` at once (TD-031 §11). `503 digests_unresolved` while the core cannot name its images (WP-281).',
        tags: ['worker'],
        body: workerClaimRequestSchema,
        response: {
          200: runPackageSchema,
          204: z.null(),
          401: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { workerId, row } = await worker(request, request.body.image_digests);
      const release = options.release();
      if (release === null) {
        throw unresolved();
      }
      // The owner's hold (WP-292) answers at once, as a worker's own `paused` does: the claim's
      // eligibility would refuse it anyway, and holding the request would only keep a slot busy.
      if (request.body.paused || row.manuallyPausedAt !== null) {
        return reply.code(204).send(null);
      }
      const presence = presenceOf(reply);
      const deadline = Date.now() + claimHoldMs;
      for (;;) {
        const answer = await remote.claim({
          workerId,
          heldImageDigests: request.body.image_digests,
          images: {
            run: release.digests.platform_runtime,
            egress: release.digests.platform_egress,
          },
          now: isoNow(now),
        });
        if (answer.kind === 'claimed') {
          return deliverClaimed(request, reply, presence, workerId, answer.package);
        }
        const remaining = deadline - Date.now();
        if (answer.kind === 'not_packaged' || remaining <= 0 || presence.gone()) {
          return reply.code(204).send(null);
        }
        await hold(
          options.broadcast,
          [RUN_OFFERS_TOPIC],
          Math.min(remaining, claimPollMs),
          presence,
        );
        if (presence.gone()) {
          return reply.code(204).send(null);
        }
      }
    },
  );

  /** The furthest a usage pause may end: a weekly limit plus a day, as `resetsAtOf` reads a reset. */
  const MAX_USAGE_PAUSE_MS = 8 * 86_400_000;

  /**
   * **`POST pause`** (WP-285, TD-031 decision 11): the worker hit its usage limit and claims nothing
   * before `until`; the core stores it so the claim's eligibility (`paused_until`) refuses the
   * worker meanwhile and the Workers screen says so. A person's *Pause* is `manual-pause`'s column
   * and is never touched here, and nothing clears it when `until` passes — the limit's pause simply
   * ends.
   */
  typed.post(
    path(WORKER_PATHS.pause),
    {
      preValidation: authenticateWorker,
      schema: {
        summary: 'Pause the worker’s claiming until its usage limit resets (TD-031 §11)',
        description:
          'Worker credential. `{until, reason: usage_limited, estimated?}` with `until` at most eight days ahead (`400 pause_too_long` past it): stores `paused_until`, `paused_reason` and whether `until` is the worker’s default pause rather than a reset the limit named (`estimated`, the screen’s *until about*). The claim refuses the worker until then; a person’s hold (`manual-pause`) is a separate column this never touches. A repeat stores the same. `204` (WP-285).',
        tags: ['worker'],
        body: workerPauseRequestSchema,
        response: {
          204: z.null(),
          400: apiErrorSchema,
          401: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
        },
      },
    },
    async (request, reply) => {
      const subject = workers.get(request);
      if (subject === undefined) {
        throw unauthenticated('the worker credential is missing');
      }
      await workerContact(request);
      // The runner's own bound on a believable reset (a weekly limit and a day), held here too.
      if (Date.parse(request.body.until) - now().getTime() > MAX_USAGE_PAUSE_MS) {
        throw new HttpError(
          400,
          'pause_too_long',
          `a usage pause ends within ${String(MAX_USAGE_PAUSE_MS / 86_400_000)} days; this one does not`,
        );
      }
      const stored = await options.store.setUsagePause({
        workerId: subject.workerId,
        until: new Date(request.body.until),
        estimated: request.body.estimated ?? false,
      });
      if (!stored) {
        throw unauthenticated('the worker credential names no worker');
      }
      return reply.code(204).send(null);
    },
  );

  typed.post(
    path(WORKER_PATHS.heartbeat),
    {
      preValidation: authenticateRun,
      schema: {
        summary:
          'Renew a run’s lease and collect its commands — held up to 20 s (TD-031 §§2, 9, 14)',
        description:
          'Run token. Renews the 10-minute lease, fenced on the epoch, the worker and the worker still able to act (one statement, backlog 714); stamps the acks of delivered commands (`applied`, or `refused` with one of the four existing reasons); answers the run’s pending `run_commands` (steer, cancel, take-over) and decided approvals. With nothing pending it is held until a command is recorded, an approval is decided, or 20 s pass; a decided approval is delivered once (WP-282). `409 lease_lost`: stop the session and destroy the workspace (WP-281).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerHeartbeatRequestSchema,
        response: { 200: workerHeartbeatResponseSchema, ...runErrors },
      },
    },
    async (request, reply): Promise<z.output<typeof workerHeartbeatResponseSchema>> => {
      const runId = request.params.id as Id;
      const presence = presenceOf(reply);
      const subject = runHolder(request);
      const answer = await remote.heartbeat({
        runId,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        acks: request.body.acks.map((ack) =>
          ack.outcome === 'applied'
            ? { commandId: ack.command_id as Id, outcome: 'applied' as const }
            : {
                commandId: ack.command_id as Id,
                outcome: 'refused' as const,
                reason: ack.refused_reason,
              },
        ),
        now: isoNow(now),
      });
      if (answer.kind === 'lease_lost') {
        throw leaseLost(runId);
      }
      // TD-031 §9: decided approvals ride the heartbeat beside the commands (WP-282). A decision
      // wakes the lease holder's command topic, which the hold below listens on.
      const decided = async () =>
        options.runCalls === undefined || options.runCalls === null
          ? []
          : options.runCalls.deliverApprovals({ runId });
      let commands = answer.commands;
      let approvals = await decided();
      if (commands.length === 0 && approvals.length === 0) {
        await hold(
          options.broadcast,
          [runCommandsTopic(workerLeaseOwner(subject.workerId))],
          heartbeatHoldMs,
          presence,
        );
        if (!presence.gone()) {
          commands = await remote.pending({ runId, workerId: subject.workerId });
          approvals = await decided();
        }
      }
      return {
        lease_expires_at: answer.leaseExpiresAt,
        commands: commands.map(wireCommand),
        approvals: approvals.map((approval) => ({
          approval_id: approval.approvalId,
          decision: approval.decision,
          reason: approval.reason.slice(0, 4_096),
          question_id: approval.questionId,
        })),
      };
    },
  );

  typed.post(
    path(WORKER_PATHS.runRelease),
    {
      preValidation: authenticateRun,
      schema: {
        summary: 'Hand a claimed run back unspent, before its CLI spawn marker (TD-031 §6)',
        description:
          'Run token. Only while the run is `starting` and its CLI spawn marker is unwritten: the offer `claimed → open` (epoch kept), the lease cleared, the run `starting → created`, `run.offer.released`, the worker excluded for `usage_limited` and `provision_failed`, the minted credential revoked; nothing charged. A repeat answers `204` again. `409 run_started` once the marker is written — a started run ends through `finish`; `409 lease_lost` for another claim or an ended run (WP-281).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerRunReleaseRequestSchema,
        response: { 204: z.null(), ...runErrors },
      },
    },
    async (request, reply) => {
      const runId = request.params.id as Id;
      const subject = runHolder(request);
      const result = await remote.release({
        runId,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        reason: request.body.reason,
        now: isoNow(now),
      });
      if (result === 'run_started') {
        throw new HttpError(
          409,
          'run_started',
          `run ${runId} asked for its CLI: a started run ends through finish, never a release (TD-031 §6)`,
        );
      }
      if (result === 'lease_lost') {
        throw leaseLost(runId);
      }
      return reply.code(204).send(null);
    },
  );

  typed.post(
    path(WORKER_PATHS.spawn),
    {
      preValidation: authenticateRun,
      schema: {
        summary: 'Record the CLI spawn marker — before the `spawn` frame (TD-031 amendment §4)',
        description:
          'Run token. Fenced on the epoch and the worker: writes `runs.cli_spawn_requested_at` and `started_at`, moves the run `starting → running` and appends `run.started`, in one transaction. The worker sends **no** `spawn` frame before this `200`. A repeat under the same claim answers the first instant. `409 lease_lost` for a stale fence or an ended run; `409 run_not_startable` for a run whose context pack was never recorded (WP-281).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerSpawnRequestSchema,
        response: { 200: workerSpawnResponseSchema, ...runErrors },
      },
    },
    async (request): Promise<z.output<typeof workerSpawnResponseSchema>> => {
      const runId = request.params.id as Id;
      const subject = runHolder(request);
      const answer = await remote.spawn({
        runId,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        now: isoNow(now),
      });
      if (answer.kind === 'lease_lost') {
        throw leaseLost(runId);
      }
      if (answer.kind === 'not_startable') {
        throw new HttpError(
          409,
          'run_not_startable',
          `run ${runId} recorded no context pack, so run.started cannot be written; finish it as not_started`,
        );
      }
      return { started_at: answer.startedAt };
    },
  );

  typed.post(
    path(WORKER_PATHS.finish),
    {
      preValidation: authenticateRun,
      schema: {
        summary: 'Settle a run — `settleRun` with the four-field request (TD-031 §3)',
        description:
          'Run token. The epoch and the outcome — a run that ran, or one that never started — and the worker’s stop register (`stop_reason`, the closed vocabulary). The fence’s owner is the authenticated worker. Idempotent on `(run_id, epoch)`: a repeat answers `already_settled` with the stored ending. `409 lease_lost` for a stale fence; `410 run_gone` when the run’s task was deleted mid-run, which a worker treats as terminal (WP-281).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerFinishRequestSchema,
        response: { 200: workerFinishResponseSchema, 410: apiErrorSchema, ...runErrors },
      },
    },
    async (request): Promise<z.output<typeof workerFinishResponseSchema>> => {
      const runId = request.params.id as Id;
      const subject = runHolder(request);
      const answer = await remote.finish({
        runId,
        workerId: subject.workerId,
        epoch: request.body.epoch,
        outcome: settleOutcomeOfFinish(runId, request.body),
        stopReason: request.body.stop_reason,
      });
      if (answer.kind === 'lease_lost') {
        throw leaseLost(runId);
      }
      if (answer.kind === 'run_gone') {
        throw new HttpError(
          410,
          'run_gone',
          `run ${runId}'s task was deleted while it ran; nothing was written — destroy the workspace`,
        );
      }
      return workerFinishResponseSchema.parse({
        outcome: answer.kind,
        ending: {
          status: answer.ending.status,
          terminal_reason: answer.ending.terminalReason,
          epoch: answer.ending.epoch,
        },
      });
    },
  );

  typed.post(
    path(WORKER_PATHS.lateCost),
    {
      preValidation: authenticateRun,
      schema: {
        summary: 'Report what a run burned after another writer ended it (Q70 (b))',
        description:
          'Run token — valid until fifteen minutes after the run’s terminal write. For a run another writer ended (a cancel in place, the lease sweep) under this claim: the narrow cost write and its `late` ledger rows (`cost/late.ts`). `recorded: false` when the row already carries a figure or the ledger charged it — a repeat writes nothing. `409 run_live` while the run is still live (its `finish` carries the cost); `409 lease_lost` for another claim (WP-281).',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerLateCostRequestSchema,
        response: { 200: workerLateCostResponseSchema, 410: apiErrorSchema, ...runErrors },
      },
    },
    async (request): Promise<z.output<typeof workerLateCostResponseSchema>> => {
      const runId = request.params.id as Id;
      const subject = runHolder(request);
      const body = request.body;
      const answer = await remote.lateCost({
        runId,
        workerId: subject.workerId,
        epoch: body.epoch,
        spend: {
          sessionId: body.session_id,
          numTurns: body.num_turns,
          wallMs: body.wall_ms,
          cost: body.cost,
          usage: body.usage,
          modelUsage: body.model_usage,
        },
        now: isoNow(now),
      });
      switch (answer.kind) {
        case 'recorded':
          return { recorded: answer.recorded };
        case 'lease_lost':
          throw leaseLost(runId);
        case 'run_live':
          throw new HttpError(
            409,
            'run_live',
            `run ${runId} is still live under this claim: its cost travels on finish`,
          );
        case 'run_gone':
          throw new HttpError(410, 'run_gone', `run ${runId} no longer exists`);
      }
    },
  );

  typed.get(
    path(WORKER_PATHS.release),
    {
      schema: {
        summary: 'This core’s image digests and protocol range (TD-032 decision 3)',
        description:
          'Public since WP-294 (TD-031’s first-run amendment §6): the range and the digests already reach an anonymous caller through the `426`, and the wizard of a worker that has no credential yet checks a typed address with it. The `X-Worker-Protocol` check stays; a credential, if presented, is ignored and no contact is recorded. The core’s four images by digest — its own `sha-<7>` tags resolved with the anonymous OCI `HEAD`, or `APP_WORKER_IMAGE_DIGESTS` — and the protocol range it serves. No compose file: an updater applies digests only and reads the template from the verified new image (TD-032 §3). `503 digests_unresolved` naming the image while they cannot be resolved (WP-284).',
        tags: ['worker'],
        response: {
          200: workerReleaseResponseSchema,
          426: workerUpgradeRequiredBodySchema,
          503: apiErrorSchema,
        },
      },
    },
    async (): Promise<z.output<typeof workerReleaseResponseSchema>> => {
      const release = options.release();
      if (release === null) {
        throw unresolved();
      }
      return {
        protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [...ACCEPTED_WORKER_PROTOCOLS] },
        digests: release.digests,
      };
    },
  );

  typed.post(
    path(WORKER_PATHS.updateReport),
    {
      preValidation: authenticateWorker,
      schema: {
        summary: 'How this worker’s update ended (TD-032 decision 6, WP-287 (4))',
        description:
          'Worker credential. The updater reports each update it applied (`succeeded`), put back (`rolled_back`) or did not apply (`failed` — an attestation that does not verify, a downgrade, no verifier, or a rollback that did not come back), from which four digests to which, in its own words. Recorded as one `human_actions` row (`worker.update`) under the worker’s user; the Workers screen shows the newest. Answers `204`.',
        tags: ['worker'],
        body: workerUpdateReportRequestSchema,
        response: {
          204: z.null(),
          401: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
        },
      },
    },
    async (request, reply) => {
      await workerContact(request);
      const subject = workers.get(request) as { readonly workerId: Id };
      const recorded = await options.store.recordUpdateReport({
        workerId: subject.workerId,
        report: request.body,
        now: now(),
      });
      if (recorded === 'not_found') {
        throw unauthenticated('the worker credential names no worker');
      }
      return reply.code(204).send(null);
    },
  );

  typed.get(
    path(WORKER_PATHS.composeFile),
    {
      schema: {
        summary:
          '`compose.worker.yml`, pinned to this core’s digests — first install only (TD-032 §3)',
        description:
          'Public, and outside the `X-Worker-Protocol` check (TD-031’s 2026-11-05 amendment): a person’s first-install download, which no worker calls and which holds no secret. A credential, if presented, is ignored and no contact is recorded. The template baked into this core’s image (`/opt/platform/compose.worker.yml`) with every platform image pinned **by digest** to this core’s own and `APP_CORE_URL` defaulted to this core — for a person to read and run on a first install (BD-032 decision 9). No updater ever applies a file the core served. Its SHA-256 is the handshake’s `compose_bundle_digest`. `503 digests_unresolved` naming the image, or `503 compose_template_unavailable` (WP-284).',
        tags: ['worker'],
        // **No `response` block**, for `transcript.jsonl`'s reason (`downloads.ts`): the body is a
        // YAML file, not one JSON document, and a serialiser compiled for one would quote it.
      },
    },
    async (_request, reply) => {
      const release = options.release();
      if (release === null) {
        throw unresolved();
      }
      if (release.composeFile === null) {
        throw new HttpError(
          503,
          'compose_template_unavailable',
          'this core’s image carries no readable compose.worker.yml template (or one whose images cannot all be pinned by digest), so it serves no compose file',
        );
      }
      return reply
        .code(200)
        .header('content-type', 'application/yaml; charset=utf-8')
        .header('content-disposition', 'attachment; filename="compose.worker.yml"')
        .send(release.composeFile);
    },
  );

  // S-22.20: the one-command install, rendered once with this core's URL (`workers/install.ts`).
  const installScripts = renderInstallScripts(options.baseUrl ?? 'http://localhost');
  for (const [verb, name, language] of [
    [WORKER_PATHS.installSh, 'install.sh', 'POSIX sh, for macOS and Linux'],
    [WORKER_PATHS.installPs1, 'install.ps1', 'PowerShell 5.1 and 7, for Windows'],
  ] as const) {
    typed.get(
      path(verb),
      {
        schema: {
          summary: `\`${name}\`: install a worker on this machine in one command (${language})`,
          description: `Public, and outside the \`X-Worker-Protocol\` check (TD-031's 2026-11-05 install-scripts amendment): a person's download, which no worker calls and which holds no secret. The script baked into this core's image with this core's \`APP_BASE_URL\` filled in. It checks Docker, creates \`~/agentic-worker\`, downloads \`compose.yml\` from this core, starts the bundle — its updater included — and opens the worker's page; a re-run never changes the images a worker runs. \`503 install_script_unavailable\` when \`APP_BASE_URL\` cannot be quoted safely (S-22.20).`,
          tags: ['worker'],
          // No `response` block: the body is a script, not JSON (as `compose.yml`).
        },
      },
      async (_request, reply) => {
        const script = installScripts[name];
        if ('error' in script) {
          throw new HttpError(503, 'install_script_unavailable', script.error);
        }
        return reply
          .code(200)
          .header('content-type', 'text/plain; charset=utf-8')
          .header('x-content-type-options', 'nosniff')
          .header('content-disposition', `inline; filename="${name}"`)
          .send(script.text);
      },
    );
  }

  registerWorkerOwnerVerbs(app, {
    store: options.store,
    runCancel: options.runCancel ?? null,
    path,
    upgradeBody: (presented) =>
      upgradeRequiredBody(
        { release: options.release, baseUrl: options.baseUrl ?? 'http://localhost' },
        presented,
      ),
    authenticateWorker,
    authenticateRun,
    workerOf: async (request) => {
      await workerContact(request);
      return workers.get(request) as { readonly workerId: Id };
    },
    runHolder,
    now,
  });

  registerWorkerPickVerbs(app, {
    store: options.store,
    remote,
    path,
    upgradeBody: (presented) =>
      upgradeRequiredBody(
        { release: options.release, baseUrl: options.baseUrl ?? 'http://localhost' },
        presented,
      ),
    authenticateWorker,
    workerOf: async (request, digests) => {
      const { workerId, row } =
        digests === null
          ? await (async () => {
              const subject = workers.get(request);
              if (subject === undefined) {
                throw unauthenticated('the worker credential is missing');
              }
              const contact = await options.store.recordContact({
                workerId: subject.workerId,
                protocolVersion: protocolOf(request),
                imageDigests: null,
              });
              if (contact === null) {
                throw unauthenticated('the worker credential names no worker');
              }
              return { workerId: subject.workerId, row: contact };
            })()
          : await worker(request, digests);
      return { workerId, imageDigests: storedDigestsOf(row.imageDigests) };
    },
    release: options.release,
    unresolved,
    displays: options.offerDisplays ?? null,
    unassignedTakers: options.unassignedTakers ?? null,
    watch: presenceOf,
    deliverClaimed,
    now,
  });

  registerWorkerRunCallRoutes(app, {
    runCalls: options.runCalls ?? null,
    path,
    authenticateRun,
    runHolder,
    leaseLost,
  });
};
