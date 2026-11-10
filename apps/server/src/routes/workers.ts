/**
 * The people's half of the worker surface — WP-280, TD-031 decisions 7 and 10c, technical/08's
 * TD-031 amendment:
 *
 *   POST   /api/workers/device/lookup       what `/workers/approve` shows before a decision
 *   POST   /api/workers/device/approve      approve (naming the machine) or deny a code
 *   GET    /api/workers                     own workers; every worker for an administrator
 *   DELETE /api/workers/:id                 revoke (own; any for an administrator)
 *   PUT    /api/workers/:id/claim-policy    what the machine takes — its own user only (S-26.4)
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
 * command writes none, and neither does a **retry**: the same person repeating their own recorded
 * decision (same decision, same machine name) is answered `200` with the original instant and
 * `performed: false` — `repeatedDeviceDecision` in `@platform/domain`. The row never carries a code.
 *
 * ## Revocation
 *
 * `revoked_at` is set, the credential stops authenticating, and the worker's live runs get
 * `lease_expires_at = now()` in the same transaction and nothing else (TD-031 §7) — the lease sweep
 * ends them. A second revoke answers `200` with `performed: false`.
 *
 * ## What a machine takes (S-26.4, TD-031's 2026-11-06 amendment item 6)
 *
 * `PUT /api/workers/:id/claim-policy` is the M26 UX spec § 1's card from a session: the policy and
 * the project list, a state assertion, **by the worker's own user only** — an administrator, who
 * sees every worker here, is `403 claim_policy_owner_only` (they read it, BD-032's amendment 2),
 * and anybody else's worker is `404` as for the revoke. One `human_actions` row
 * `worker.claim_policy` per change, none for a repeat. The list carries `claim_policy` and
 * `policy_skipped_offers`; a policy other than `pick_only` is **no blocker** — a *mine* machine
 * with nothing of its own is idle by choice, which `policy_skipped_offers` says instead.
 */
import {
  apiErrorSchema,
  type IsoDateTime,
  imageDigestSchema,
  revokeWorkerResponseSchema,
  type WorkerClaimBlocker,
  type WorkerIdleReason,
  type WorkerSummary,
  workerClaimPolicyRequestSchema,
  workerClaimPolicyResponseSchema,
  workerDeviceDecisionRequestSchema,
  workerDeviceDecisionResponseSchema,
  workerDeviceLookupRequestSchema,
  workerDeviceLookupResponseSchema,
  workerLastUpdateSchema,
  workerParamsSchema,
  workerPauseReasonSchema,
  workerStateSchema,
  workersResponseSchema,
} from '@platform/contracts';
import {
  type CoreWorkerClaimFacts,
  can,
  coreClaimBlockersOf,
  isDeviceCodeStale,
  normaliseUserCode,
  type RunImageDigests,
} from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import type { Actor } from '../auth/rbac.js';
import { type PermissionGuardDependencies, requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { WorkerIdleReader } from '../queries/worker-idle.js';
import {
  WORKER_CONNECTED_SECONDS,
  type WorkerListRow,
  type WorkerStore,
} from '../queries/worker-queries.js';
import { hashTypedUserCode } from '../workers/secrets.js';

export interface WorkerRoutesOptions {
  readonly store: WorkerStore;
  /** Unused by an org-scoped guard, and required by its type. */
  readonly projectRole: PermissionGuardDependencies['projectRole'];
  readonly now?: () => Date;
  /**
   * The core's current run and egress digests (`release()`'s `platform_runtime`/`platform_egress`),
   * or `null` while it cannot name them — what `images_outdated` compares with (S-22.19). Absent is
   * `null`: nothing is said about a worker's images but that it holds none.
   */
  readonly coreDigests?: () => RunImageDigests | null;
  /**
   * Why each ready machine runs nothing (more) — `idle_reason` (S-28.6, the M28 ruling A). Absent
   * or `null`: every row answers `idle_reason: null` (nothing is said rather than guessed).
   */
  readonly idle?: WorkerIdleReader | null;
}

const iso = (value: Date): IsoDateTime => value.toISOString() as IsoDateTime;
const isoOrNull = (value: Date | null): IsoDateTime | null => (value === null ? null : iso(value));

/**
 * The core's claim facts of a listed row (S-22.19). A row read without them (not `listWorkers`'s)
 * is judged online on this process's clock and its projects are not asked.
 */
export const claimFactsOf = (
  row: WorkerListRow,
  coreDigests: RunImageDigests | null,
  now: Date,
): CoreWorkerClaimFacts => {
  const facts = row.claimFacts;
  return {
    revoked: row.revokedAt !== null || row.state === 'revoked',
    ownerMayAct: facts?.ownerMayAct ?? true,
    online:
      facts?.online ??
      (row.lastSeenAt !== null &&
        now.getTime() - row.lastSeenAt.getTime() < WORKER_CONNECTED_SECONDS * 1000),
    protocolVersion: row.protocolVersion,
    hold: facts?.hold ?? (row.manuallyPausedAt === null ? null : 'paused'),
    usagePaused:
      facts?.usagePaused ?? (row.pausedUntil !== null && row.pausedUntil.getTime() > now.getTime()),
    heldDigests: z.array(imageDigestSchema).parse(row.imageDigests),
    coreDigests,
    eligibleProjects: facts?.eligibleProjects ?? null,
    // S-26.4: *pick only* is the policy now — a legacy `[]` scope reads as it (`claimPolicy`).
    pickOnly: row.claimPolicy === 'pick_only',
  };
};

/** One stored row on the wire; a value the contract refuses fails the response, never invented. */
export const toWireWorker = (
  row: WorkerListRow,
  coreDigests: RunImageDigests | null = null,
  now: Date = new Date(),
  idleReason: WorkerIdleReason | null = null,
): WorkerSummary => {
  const blockers = claimBlockersOfRow(row, coreDigests, now);
  return {
    ...toWireWorkerRow(row),
    claim_blockers: blockers,
    can_claim: blockers.length === 0,
    last_claimed_at: isoOrNull(row.claimFacts?.lastClaimedAt ?? null),
    // A revoked machine is not idle; a blocked one's blocker speaks (the reader answers `null`).
    idle_reason: row.revokedAt !== null || row.state === 'revoked' ? null : idleReason,
  };
};

/** A listed row's blockers (S-22.19) — what `toWireWorker` publishes and the idle read is told. */
const claimBlockersOfRow = (
  row: WorkerListRow,
  coreDigests: RunImageDigests | null,
  now: Date,
): WorkerClaimBlocker[] => coreClaimBlockersOf(claimFactsOf(row, coreDigests, now));

const toWireWorkerRow = (
  row: WorkerListRow,
): Omit<WorkerSummary, 'claim_blockers' | 'can_claim' | 'last_claimed_at' | 'idle_reason'> => ({
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
  paused_until_estimated: row.pausedUntil !== null && row.pausedUntilEstimated,
  manually_paused_at: isoOrNull(row.manuallyPausedAt),
  claim_projects:
    row.claimProjects === null
      ? null
      : row.claimProjects.map((project) => ({ id: project.id, key: project.key })),
  concurrency: row.concurrency,
  running: row.running.map((run) => ({
    run_id: run.runId,
    task_id: run.taskId,
    project_id: run.projectId,
  })),
  claim_policy: row.claimPolicy,
  policy_skipped_offers: row.policySkippedOffers ?? null,
  last_update:
    row.lastUpdate === undefined || row.lastUpdate === null
      ? null
      : workerLastUpdateSchema.parse({
          result: row.lastUpdate.result,
          from: row.lastUpdate.from,
          to: row.lastUpdate.to,
          detail: row.lastUpdate.detail,
          reported_at: iso(row.lastUpdate.reportedAt),
        }),
});

/**
 * **One worker's `idle_reason`** (S-28.6) — the Workers screen's own answer for the machine a
 * worker credential names, for `GET offers?fields=idle_reason`: its row read as the list reads it
 * (its user's workers, the core's digests), its blockers decided by the same function, then the
 * reader. `null` for a worker the list does not name or a revoked one.
 */
export const idleReasonOfWorker = async (
  store: WorkerStore,
  idle: WorkerIdleReader,
  workerId: string,
  coreDigests: RunImageDigests | null,
  now: Date,
): Promise<WorkerIdleReason | null> => {
  const subject = await store.findCredentialSubject(workerId);
  if (subject === null) return null;
  const row = (await store.listWorkers(subject.userId, coreDigests)).find(
    (listed) => listed.id === workerId,
  );
  if (row === undefined || row.revokedAt !== null || row.state === 'revoked') return null;
  const answer = await idle(
    [
      {
        workerId,
        blocked: claimBlockersOfRow(row, coreDigests, now).length > 0,
        running: row.running.length,
        concurrency: row.concurrency,
        claimPolicy: row.claimPolicy,
      },
    ],
    coreDigests,
  );
  return answer.get(workerId) ?? null;
};

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

  // A read sent as a POST (WP-280 review): a user code in a URL path reaches every access log
  // between the browser and the core. The body never does.
  typed.post(
    '/api/workers/device/lookup',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'What a pending device code’s machine sent, before a decision',
        description:
          'A read sent as a POST, so the code never sits in a URL an access log records. The requesting address, user agent and age of a **pending** device code, and `needs_confirmation` once it is older than five minutes (TD-031 §10c). The code is normalised (case, spaces and the hyphen are ignored). An unknown, malformed, expired or decided code is `404 device_code_not_found`. Any signed-in user (`worker.register`, WP-280).',
        tags: ['workers'],
        body: workerDeviceLookupRequestSchema,
        response: { 200: workerDeviceLookupResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request): Promise<z.output<typeof workerDeviceLookupResponseSchema>> => {
      const normalised = normaliseUserCode(request.body.user_code);
      const hash = hashTypedUserCode(request.body.user_code);
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
          'Approving names the machine; the worker is created — yours — when the machine collects its credential with `device/token`. A code older than five minutes needs `confirm_stale: true` (`409 device_code_needs_confirmation` otherwise, TD-031 §10c); denying needs nothing and makes the poll answer `access_denied`. `404 device_code_not_found` for an unknown or malformed code, `409 device_code_expired`, `409 device_code_already_decided` (somebody else’s decision, the other decision, or another name). **A retry of your own recorded decision** — same decision, same name — answers `200` with its original `decided_at` and `performed: false`, even after the code expired. One `human_actions` row per performed decision, none for a retry. Any signed-in user (`worker.register`, WP-280).',
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
          return {
            decision: body.decision,
            decided_at: iso(result.decidedAt),
            performed: result.performed,
          };
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
          'Machine, user, created and last seen, protocol, image digests, state, `claim_policy` (what the machine takes by itself, S-26.4: the stored policy, or what a worker connected before it reads as) and `policy_skipped_offers` (open offers its eligibility and scope admit now and its policy leaves for others; `null` while this core cannot name its images), paused until (and whether that instant is the default pause of a usage limit that named no reset, `paused_until_estimated`, WP-285), and `running`: the ids of the live runs the worker holds (S-23.15). `scope` is `all` for an administrator (`org.workers.manage`) and `own` otherwise. Newest first (WP-280). `timezone` is the organisation’s, which a usage pause’s time is shown in. **Why it takes no work** (S-22.19): `claim_blockers` — the claim’s own predicates minus the per-offer ones, in the vocabulary’s order (`revoked`, `owner_disabled`, `offline`, `protocol_outdated`, `platform_images_unresolved` while this core cannot name its own digests and so answers every claim 503, `paused`, `draining`, `usage_limited`, `images_missing`, `images_outdated` against this core’s current run and egress digests, `no_eligible_project`, `pick_only`) — `can_claim` (an automatic claim would be admitted) when it is empty, and `last_claimed_at`. **Why a ready machine runs nothing (more)** (S-28.6): `idle_reason` — one cause with its numbers, `null` while a blocker stands or while it is about to take something: `slots_busy`, `owner_limit`, `project_limit` (a project it serves is full and tasks it would take are queued), `policy_skips` (its claim policy leaves waiting runs for others) or `nothing_queued`.',
        tags: ['workers'],
        response: { 200: workersResponseSchema },
      },
    },
    async (request): Promise<z.output<typeof workersResponseSchema>> => {
      const actor = actorOf(request);
      const all = can(actor.role, 'org.workers.manage');
      const digests = options.coreDigests?.() ?? null;
      const rows = await options.store.listWorkers(all ? null : actor.userId, digests);
      const at = now();
      // S-28.6: why each ready machine runs nothing (more), for the active rows only.
      const idle =
        options.idle === undefined || options.idle === null
          ? new Map<string, WorkerIdleReason | null>()
          : await options.idle(
              rows
                .filter((row) => row.revokedAt === null && row.state !== 'revoked')
                .map((row) => ({
                  workerId: row.id,
                  blocked: claimBlockersOfRow(row, digests, at).length > 0,
                  running: row.running.length,
                  concurrency: row.concurrency,
                  claimPolicy: row.claimPolicy,
                })),
              digests,
            );
      return {
        items: rows.map((row) => toWireWorker(row, digests, at, idle.get(row.id) ?? null)),
        scope: all ? 'all' : 'own',
        timezone: await options.store.organisationTimezone(),
      };
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

  typed.put(
    '/api/workers/:id/claim-policy',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'Set what your machine takes: which tasks, in which projects (S-26.4)',
        description:
          'A state assertion of both controls of *What this machine takes* (the M26 UX spec § 1): `claim_policy` — `mine_and_unassigned` (your tasks and unassigned ones), `mine` (only your tasks), `everything`, or `pick_only` (nothing by itself: a run starts when you pick it on the machine’s page, which assigns it to you) — and `claim_project_ids`, `null` for every project you may run in or those projects, stored distinct and sorted. It applies to the next claim; a run in flight is never moved. **Only the worker’s own user** may change it: an administrator is `403 claim_policy_owner_only`, and somebody else’s worker is `404` to anybody else. `422 claim_scope_empty` for `[]` (*pick only* is a policy), `422 project_not_eligible` naming the ids that are not a project where you are `member`+ now; nothing is written for either. One `human_actions` row `worker.claim_policy` `{worker_id, claim_policy, project_ids, via: workers_screen}` per change; a repeat of the stored pair is `performed: false` and writes none.',
        tags: ['workers'],
        params: workerParamsSchema,
        body: workerClaimPolicyRequestSchema,
        response: {
          200: workerClaimPolicyResponseSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request): Promise<z.output<typeof workerClaimPolicyResponseSchema>> => {
      const actor = actorOf(request);
      const result = await options.store.setClaimPolicy({
        workerId: request.params.id,
        actorUserId: actor.userId,
        canSeeAll: can(actor.role, 'org.workers.manage'),
        projectIds: request.body.claim_project_ids,
        policy: request.body.claim_policy,
      });
      switch (result.status) {
        case 'set':
          return {
            worker_id: request.params.id,
            claim_policy: result.claimPolicy,
            claim_project_ids: result.claimProjectIds === null ? null : [...result.claimProjectIds],
            performed: result.performed,
          };
        case 'not_found':
          throw new NotFoundError(`worker ${request.params.id}`);
        case 'not_owner':
          throw new HttpError(
            403,
            'claim_policy_owner_only',
            'only the person whose machine this is can change what it takes',
          );
        case 'empty_scope':
          throw new HttpError(
            422,
            'claim_scope_empty',
            'choose at least one project, or every project; to take nothing by itself, choose only what you pick',
          );
        case 'invalid':
          throw new HttpError(
            422,
            'project_not_eligible',
            `the list names ${result.projectIds.length} project(s) you may not take a run of: ${result.projectIds.join(', ')}`,
          );
      }
    },
  );
};
