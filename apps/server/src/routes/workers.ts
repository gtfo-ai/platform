/**
 * The people's half of the worker surface — WP-280, TD-031 decisions 7 and 10c, technical/08's
 * TD-031 amendment:
 *
 *   GET    /api/workers/device/:user_code   what `/workers/approve` shows before a decision
 *   POST   /api/workers/device/approve      approve (naming the machine) or deny a code
 *   GET    /api/workers                     own workers; every worker for an administrator
 *   DELETE /api/workers/:id                 revoke (own; any for an administrator)
 *
 * Session-authenticated and, being mutations, behind the CSRF hook (`auth/plugin.ts`). The device
 * pair and the list are `worker.register` (any signed-in active user — TD-031 §10c: "the approver
 * must be an active user; the worker is theirs"); seeing and revoking somebody else's worker is
 * `org.workers.manage` (admin). Somebody else's worker reads as **absent** to a non-administrator
 * (`404`), so its id is not confirmed to exist.
 *
 * ## Against code phishing (TD-031 §10c)
 *
 * The read publishes what the requesting machine sent — its address, its user agent and how old the
 * code is — and `needs_confirmation` once it is older than five minutes; approving such a code
 * without `confirm_stale: true` is `409 device_code_needs_confirmation`. The page carries the
 * warning; the server holds the second confirmation, so a client that skips the page cannot skip it.
 * An unknown, malformed, expired or already decided code all read `404 device_code_not_found` here:
 * the lookup is not an oracle for which codes exist.
 *
 * ## The audit
 *
 * A decision writes one `human_actions` row (`worker.device.approve`/`worker.device.deny`) and a
 * performed revocation one (`worker.revoke`), each in the transaction of its write; a refused
 * command writes none. The row never carries a code.
 *
 * ## Revocation
 *
 * `revoked_at` is set, the credential stops authenticating, and the worker's live runs get
 * `lease_expires_at = now()` in the same transaction and nothing else (TD-031 §7) — the lease sweep
 * ends them. A second revoke answers `200` with `performed: false`.
 */
import {
  apiErrorSchema,
  type IsoDateTime,
  imageDigestSchema,
  revokeWorkerResponseSchema,
  type WorkerSummary,
  workerDeviceDecisionRequestSchema,
  workerDeviceDecisionResponseSchema,
  workerDeviceLookupParamsSchema,
  workerDeviceLookupResponseSchema,
  workerParamsSchema,
  workerPauseReasonSchema,
  workerStateSchema,
  workersResponseSchema,
} from '@platform/contracts';
import { can, isDeviceCodeStale, normaliseUserCode } from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import type { Actor } from '../auth/rbac.js';
import { type PermissionGuardDependencies, requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { WorkerListRow, WorkerStore } from '../queries/worker-queries.js';
import { hashTypedUserCode } from '../workers/secrets.js';

export interface WorkerRoutesOptions {
  readonly store: WorkerStore;
  /** Unused by an org-scoped guard, and required by its type. */
  readonly projectRole: PermissionGuardDependencies['projectRole'];
  readonly now?: () => Date;
}

const iso = (value: Date): IsoDateTime => value.toISOString() as IsoDateTime;
const isoOrNull = (value: Date | null): IsoDateTime | null => (value === null ? null : iso(value));

/** One stored row on the wire; a value the contract refuses fails the response, never invented. */
export const toWireWorker = (row: WorkerListRow): WorkerSummary => ({
  id: row.id,
  name: row.name,
  user: { id: row.userId, email: row.userEmail, name: row.userName },
  created_at: iso(row.createdAt),
  last_seen_at: isoOrNull(row.lastSeenAt),
  protocol_version: row.protocolVersion,
  image_digests: z.array(imageDigestSchema).parse(row.imageDigests),
  state: workerStateSchema.parse(row.state),
  revoked_at: isoOrNull(row.revokedAt),
  paused_until: isoOrNull(row.pausedUntil),
  paused_reason: row.pausedReason === null ? null : workerPauseReasonSchema.parse(row.pausedReason),
  concurrency: row.concurrency,
});

const deviceCodeNotFound = (): HttpError =>
  new HttpError(
    404,
    'device_code_not_found',
    'no pending device code matches; ask the machine for the code it is showing now',
  );

export const registerWorkerRoutes = async (
  app: FastifyInstance,
  options: WorkerRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.projectRole };
  const now = options.now ?? (() => new Date());

  const actorOf = (request: FastifyRequest): Actor => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`; kept because the audit row's user is not optional.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return actor;
  };

  typed.get(
    '/api/workers/device/:user_code',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'What a pending device code’s machine sent, before a decision',
        description:
          'The requesting address, user agent and age of a **pending** device code, and `needs_confirmation` once it is older than five minutes (TD-031 §10c). The code is normalised (case, spaces and the hyphen are ignored). An unknown, malformed, expired or decided code is `404 device_code_not_found`. Any signed-in user (`worker.register`, WP-280).',
        tags: ['workers'],
        params: workerDeviceLookupParamsSchema,
        response: { 200: workerDeviceLookupResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request): Promise<z.output<typeof workerDeviceLookupResponseSchema>> => {
      const normalised = normaliseUserCode(request.params.user_code);
      const hash = hashTypedUserCode(request.params.user_code);
      if (normalised === null || hash === null) {
        throw deviceCodeNotFound();
      }
      const at = now();
      const view = await options.store.findPendingDeviceCode(hash, at);
      if (view === null) {
        throw deviceCodeNotFound();
      }
      return {
        user_code: normalised,
        requested_ip: view.clientAddress,
        user_agent: view.userAgent,
        requested_at: iso(view.createdAt),
        expires_at: iso(view.expiresAt),
        age_seconds: Math.max(0, Math.floor((at.getTime() - view.createdAt.getTime()) / 1000)),
        needs_confirmation: isDeviceCodeStale(
          { createdAt: view.createdAt.getTime() },
          at.getTime(),
        ),
      };
    },
  );

  typed.post(
    '/api/workers/device/approve',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'Approve a device code for your machine, or deny it',
        description:
          'Approving names the machine; the worker is created — yours — when the machine collects its credential with `device/token`. A code older than five minutes needs `confirm_stale: true` (`409 device_code_needs_confirmation` otherwise, TD-031 §10c); denying needs nothing and makes the poll answer `access_denied`. `404 device_code_not_found` for an unknown or malformed code, `409 device_code_expired`, `409 device_code_already_decided`. One `human_actions` row per decision. Any signed-in user (`worker.register`, WP-280).',
        tags: ['workers'],
        body: workerDeviceDecisionRequestSchema,
        response: {
          200: workerDeviceDecisionResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
        },
      },
    },
    async (request): Promise<z.output<typeof workerDeviceDecisionResponseSchema>> => {
      const actor = actorOf(request);
      const body = request.body;
      const hash = hashTypedUserCode(body.user_code);
      if (hash === null) {
        throw deviceCodeNotFound();
      }
      const result = await options.store.decideDeviceCode({
        userCodeHash: hash,
        decision: body.decision,
        name: body.decision === 'approve' ? body.name : null,
        confirmedStale: body.decision === 'approve' && body.confirm_stale,
        actorUserId: actor.userId,
        now: now(),
        auditParams: {},
      });
      switch (result.status) {
        case 'decided':
          return { decision: body.decision, decided_at: iso(result.decidedAt) };
        case 'not_found':
          throw deviceCodeNotFound();
        case 'expired':
          throw new HttpError(409, 'device_code_expired', 'this device code has expired');
        case 'already_decided':
          throw new HttpError(
            409,
            'device_code_already_decided',
            'this device code was already approved or denied',
          );
        case 'needs_confirmation':
          throw new HttpError(
            409,
            'device_code_needs_confirmation',
            'this code is older than five minutes: approve only a code your own machine is showing you now, and confirm it again',
          );
      }
    },
  );

  typed.get(
    '/api/workers',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'Registered workers: your own, or every one for an administrator',
        description:
          'Machine, user, created and last seen, protocol, image digests, state, paused until. `scope` is `all` for an administrator (`org.workers.manage`) and `own` otherwise. Newest first (WP-280).',
        tags: ['workers'],
        response: { 200: workersResponseSchema },
      },
    },
    async (request): Promise<z.output<typeof workersResponseSchema>> => {
      const actor = actorOf(request);
      const all = can(actor.role, 'org.workers.manage');
      const rows = await options.store.listWorkers(all ? null : actor.userId);
      return { items: rows.map(toWireWorker), scope: all ? 'all' : 'own' };
    },
  );

  typed.delete(
    '/api/workers/:id',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'Revoke a worker',
        description:
          'Sets `revoked_at`: every later call with the worker’s credential is `401`, which the worker treats as `lease_lost`. In the same transaction the worker’s live runs get `lease_expires_at = now()` and nothing else, so the lease sweep ends them (TD-031 §7). Your own worker, or any for an administrator; somebody else’s is `404`. A second revoke answers `performed: false`. One `human_actions` row per performed revocation (WP-280).',
        tags: ['workers'],
        params: workerParamsSchema,
        response: { 200: revokeWorkerResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request): Promise<z.output<typeof revokeWorkerResponseSchema>> => {
      const actor = actorOf(request);
      const result = await options.store.revokeWorker({
        workerId: request.params.id,
        ownerUserId: can(actor.role, 'org.workers.manage') ? null : actor.userId,
        actorUserId: actor.userId,
        now: now(),
      });
      if (result.status === 'not_found') {
        throw new NotFoundError(`worker ${request.params.id}`);
      }
      return {
        worker_id: request.params.id,
        performed: result.performed,
        revoked_at: iso(result.revokedAt),
        expired_runs: result.expiredRuns,
      };
    },
  );
};
