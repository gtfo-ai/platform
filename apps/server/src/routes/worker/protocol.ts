/**
 * **The worker protocol, the core's half** — WP-281, TD-031 decisions 2, 3, 6, 7, 8, 9 and 14:
 *
 *   POST /api/worker/v1/handshake               worker credential
 *   POST /api/worker/v1/claims                  worker credential, held ≤ 25 s
 *   POST /api/worker/v1/runs/:id/heartbeat      run token, held ≤ 20 s
 *   POST /api/worker/v1/runs/:id/release        run token
 *   POST /api/worker/v1/runs/:id/spawn          run token
 *   POST /api/worker/v1/runs/:id/finish         run token
 *   POST /api/worker/v1/runs/:id/late-cost      run token
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
  WORKER_PROTOCOL_HEADER,
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
  workerRunReleaseRequestSchema,
  workerSpawnRequestSchema,
  workerSpawnResponseSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { HttpError } from '../../errors.js';
import type { WorkerStore } from '../../queries/worker-queries.js';
import type { WorkerRelease } from '../../workers/release.js';
import { authenticateWorkerCredential } from '../../workers/secrets.js';

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

/**
 * `Cache-Control: no-store` and the protocol check on every `/api/worker/v1/` request, **first**
 * (`onRequest`, before body parsing and authentication). Registered on the root instance before any
 * worker route.
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
  readonly release: () => WorkerRelease | null;
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

const digestsUnresolved = (): HttpError =>
  new HttpError(
    503,
    'digests_unresolved',
    'this core cannot name its image digests (APP_WORKER_IMAGE_DIGESTS is unset), so it advertises and packages nothing',
  );

/** The protocol the request spoke; the check has already admitted it. */
const protocolOf = (request: FastifyRequest): number =>
  parseWorkerProtocolHeader(request.headers[WORKER_PROTOCOL_HEADER]) ?? WORKER_PROTOCOL_VERSION;

/** Whether the client went away before the answer — the response closed unfinished. */
interface ClientPresence {
  readonly gone: () => boolean;
  /** Calls `listener` once if the client goes away; answers the unsubscribe. */
  readonly onGone: (listener: () => void) => () => void;
}

const presenceOf = (reply: FastifyReply): ClientPresence => {
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

  /** The run the token authenticated — only its own. */
  const runHolder = (request: FastifyRequest): RunTokenSubject => {
    const subject = runs.get(request);
    if (subject === undefined) {
      throw unauthenticated('the run token is missing');
    }
    return subject;
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
        throw digestsUnresolved();
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
      const { workerId } = await worker(request, request.body.image_digests);
      const release = options.release();
      if (release === null) {
        throw digestsUnresolved();
      }
      if (request.body.paused) {
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
          return reply.code(200).send(answer.package);
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

  typed.post(
    path(WORKER_PATHS.heartbeat),
    {
      preValidation: authenticateRun,
      schema: {
        summary:
          'Renew a run’s lease and collect its commands — held up to 20 s (TD-031 §§2, 9, 14)',
        description:
          'Run token. Renews the 10-minute lease, fenced on the epoch, the worker and the worker still able to act (one statement, backlog 714); stamps the acks of delivered commands (`applied`, or `refused` with one of the four existing reasons); answers the run’s pending `run_commands` (steer, cancel, take-over) and decided approvals. With nothing pending it is held until a command is recorded or 20 s pass. `409 lease_lost`: stop the session and destroy the workspace (WP-281).',
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
      let commands = answer.commands;
      if (commands.length === 0) {
        await hold(
          options.broadcast,
          [runCommandsTopic(workerLeaseOwner(subject.workerId))],
          heartbeatHoldMs,
          presence,
        );
        if (!presence.gone()) {
          commands = await remote.pending({ runId, workerId: subject.workerId });
        }
      }
      return {
        lease_expires_at: answer.leaseExpiresAt,
        commands: commands.map(wireCommand),
        // TD-031 §9's decided approvals ride here once a worker can open one (`approvals`, WP-282);
        // none can be opened before it, so none is pending a delivery.
        approvals: [],
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
};
