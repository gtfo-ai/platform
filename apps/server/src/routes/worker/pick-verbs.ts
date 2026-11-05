/**
 * **What a worker picks up** — WP-293, TD-031's 2026-11-05 claim-scope amendment (decision 8):
 *
 *   GET  /api/worker/v1/claim-scope          worker credential, protocol ≥ 3
 *   PUT  /api/worker/v1/claim-scope          worker credential, protocol ≥ 3 — `{ claim_project_ids }`
 *   GET  /api/worker/v1/offers               worker credential, protocol ≥ 3
 *   POST /api/worker/v1/offers/:id/claim     worker credential, protocol ≥ 3 — `{ image_digests }`
 *
 * All four are a person's act on the worker's local page, carried by the worker; the core decides
 * each.
 *
 * - **The claim scope** narrows the worker's **automatic** claims: `null` every project, `[]` *pick
 *   only*, otherwise those projects. It is a conjunct of the claim's eligibility, never a boundary:
 *   no value admits an offer the eligibility refuses. A write naming a project where the user is not
 *   `member`+ now is `422` (it keeps the value meaningful); one `human_actions` row per change.
 * - **`offers`** lists at most {@link WORKER_OFFERS_LIST_MAX} open offers the worker could claim now
 *   — the claim's own eligibility text with the scope ignored (`RunOfferRepository.claimable`) —
 *   with display names from the **redacted** ticket snapshot and never an ask's question text.
 * - **`offers/:id/claim`** — *take this one* — is the one claim with its run named: `200` with the
 *   package exactly as `claims` answers it, or `409 offer_not_claimable`, which is every reason it
 *   claimed nothing (taken, withdrawn, before `workers_from`, inside another user's head start,
 *   excluded, paused) so it reveals none. It ignores the scope and nothing else (Q127 (a): a pick
 *   never jumps the server's preference). Not held. One `human_actions` row `worker.take_offer` in
 *   the claim's transaction.
 *
 * **Below protocol 3 each is `426`**: the verbs do not exist there.
 */
import type { RemoteRuns } from '@platform/application';
import {
  apiErrorSchema,
  type Id,
  type IsoDateTime,
  type RunDisplay,
  runPackageSchema,
  WORKER_OFFERS_LIST_MAX,
  WORKER_PATHS,
  WORKER_PROTOCOL_CLAIM_SCOPE,
  type WorkerUpgradeRequiredBody,
  workerClaimScopeRequestSchema,
  workerClaimScopeResponseSchema,
  workerClaimScopeSetResponseSchema,
  workerOfferClaimRequestSchema,
  workerOffersResponseSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { HttpError } from '../../errors.js';
import type { WorkerStore } from '../../queries/worker-queries.js';
import type { WorkerRelease } from '../../workers/release.js';
import { requireWorkerProtocol } from './owner-verbs.js';
import type { ClientPresence } from './protocol.js';

/** The display names of a task's runs, by task id — the package's own rule (`runDisplayOf`). */
export type OfferDisplays = (taskIds: readonly Id[]) => Promise<ReadonlyMap<string, RunDisplay>>;

export interface WorkerPickVerbOptions {
  readonly store: WorkerStore;
  readonly remote: RemoteRuns;
  readonly path: (verb: string) => string;
  readonly upgradeBody: (presented: number | null) => WorkerUpgradeRequiredBody;
  readonly authenticateWorker: (request: FastifyRequest) => Promise<void>;
  /** The authenticated worker, its contact — and the digests it reported, when it did — recorded. */
  readonly workerOf: (
    request: FastifyRequest,
    digests: readonly string[] | null,
  ) => Promise<{ readonly workerId: Id; readonly imageDigests: readonly string[] }>;
  readonly release: () => WorkerRelease | null;
  readonly unresolved: () => HttpError;
  /** `null`: every offer is listed without its names (`project_key`/`ticket_key`/`title` null). */
  readonly displays: OfferDisplays | null;
  /** Watches for the client going away (`protocol.ts`'s `presenceOf`), from before the claim. */
  readonly watch: (reply: FastifyReply) => ClientPresence;
  /**
   * Answers a claimed package for the request's protocol — or releases it when the worker went away
   * before the answer (`protocol.ts`, BACKLOG 960).
   */
  readonly deliverClaimed: (
    request: FastifyRequest,
    reply: FastifyReply,
    presence: ClientPresence,
    workerId: Id,
    pkg: z.output<typeof runPackageSchema>,
  ) => Promise<FastifyReply>;
  readonly now: () => Date;
}

const runParamsSchema = z.strictObject({ id: z.uuid() });

const unauthenticated = (what: string): HttpError =>
  new HttpError(401, 'unauthenticated', `${what} (TD-031 §7)`);

/** The digests a stored worker row holds, as `recordContact` kept them — what `offers` reads. */
export const storedDigestsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export const registerWorkerPickVerbs = (
  app: FastifyInstance,
  options: WorkerPickVerbOptions,
): void => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const gate = (verb: string) =>
    requireWorkerProtocol(options.upgradeBody, verb, WORKER_PROTOCOL_CLAIM_SCOPE);
  const isoNow = (): IsoDateTime => options.now().toISOString() as IsoDateTime;

  const readScope = async (workerId: Id) => {
    const scope = await options.store.claimScope(workerId);
    if (scope.status === 'not_found') {
      throw unauthenticated('the worker credential names no worker');
    }
    return {
      claim_project_ids: scope.claimProjectIds === null ? null : [...scope.claimProjectIds],
      projects: scope.projects.map((project) => ({
        id: project.id,
        key: project.key,
        name: project.name,
      })),
    };
  };

  typed.get(
    options.path(WORKER_PATHS.claimScope),
    {
      preValidation: [gate(WORKER_PATHS.claimScope), options.authenticateWorker],
      schema: {
        summary: 'The worker’s claim scope and the projects it may name (WP-293)',
        description:
          'Worker credential, protocol ≥ 3. `claim_project_ids`: `null` every project, `[]` pick only, otherwise those projects; `projects`: the projects where the worker’s user’s effective role is `member` or above now — the claim’s own predicate — by key. `426` below protocol 3.',
        tags: ['worker'],
        response: {
          200: workerClaimScopeResponseSchema,
          401: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
        },
      },
    },
    async (request): Promise<z.output<typeof workerClaimScopeResponseSchema>> => {
      const { workerId } = await options.workerOf(request, null);
      return readScope(workerId);
    },
  );

  typed.put(
    options.path(WORKER_PATHS.claimScope),
    {
      preValidation: [gate(WORKER_PATHS.claimScope), options.authenticateWorker],
      schema: {
        summary: 'Set what the worker’s automatic claims take — its owner, from the local page',
        description:
          'Worker credential, protocol ≥ 3. A state assertion over `workers.claim_project_ids` (WP-293, TD-031’s claim-scope amendment §2): `null` every project, `[]` pick only, otherwise those projects, stored distinct and sorted. A conjunct of an automatic claim only — it can only narrow, and a pick ignores it. `422 project_not_eligible` names the ids that are not a project where the user is `member`+ now; nothing is written. One `human_actions` row `worker.claim_scope` `{worker_id, project_ids, via: worker_ui}` per change, the worker’s user; a repeat of the stored value is `performed: false` and writes none. `426` below protocol 3.',
        tags: ['worker'],
        body: workerClaimScopeRequestSchema,
        response: {
          200: workerClaimScopeSetResponseSchema,
          401: apiErrorSchema,
          422: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
        },
      },
    },
    async (request): Promise<z.output<typeof workerClaimScopeSetResponseSchema>> => {
      const { workerId } = await options.workerOf(request, null);
      const result = await options.store.setClaimScope({
        workerId,
        projectIds: request.body.claim_project_ids,
      });
      if (result.status === 'not_found') {
        throw unauthenticated('the worker credential names no worker');
      }
      if (result.status === 'invalid') {
        throw new HttpError(
          422,
          'project_not_eligible',
          `the scope names ${result.projectIds.length} project(s) where this worker’s user may not take a run: ${result.projectIds.join(', ')}`,
        );
      }
      return {
        claim_project_ids: result.claimProjectIds === null ? null : [...result.claimProjectIds],
        performed: result.performed,
      };
    },
  );

  typed.get(
    options.path(WORKER_PATHS.offers),
    {
      preValidation: [gate(WORKER_PATHS.offers), options.authenticateWorker],
      schema: {
        summary: 'The open offers this worker could claim now — its scope ignored (WP-293)',
        description:
          'Worker credential, protocol ≥ 3. At most 50 open offers, oldest first, that the claim would admit for this worker now — the claim’s own eligibility text with the claim scope ignored, against the image digests the worker last reported — each with whether the scope takes it automatically (`automatic`). The ticket key and the title come from the redacted ticket snapshot and are untrusted text; an ask carries its task and stage, never the question’s text. `426` below protocol 3; `503 digests_unresolved` while the core cannot name its images.',
        tags: ['worker'],
        response: {
          200: workerOffersResponseSchema,
          401: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request): Promise<z.output<typeof workerOffersResponseSchema>> => {
      const { workerId, imageDigests } = await options.workerOf(request, null);
      const release = options.release();
      if (release === null) {
        throw options.unresolved();
      }
      const offers = await options.remote.offers({
        workerId,
        heldImageDigests: imageDigests,
        images: {
          run: release.digests.platform_runtime,
          egress: release.digests.platform_egress,
        },
        now: isoNow(),
        limit: WORKER_OFFERS_LIST_MAX,
      });
      const displays =
        options.displays === null || offers.length === 0
          ? new Map<string, RunDisplay>()
          : await options.displays([...new Set(offers.map((offer) => offer.taskId))]);
      return {
        offers: offers.map((offer) => {
          const display = displays.get(offer.taskId) ?? null;
          return {
            run_id: offer.runId,
            kind: offer.kind,
            project_key: display?.projectKey ?? null,
            ticket_key: display?.ticketKey ?? null,
            title: display?.title ?? null,
            stage: offer.stage,
            role: offer.role,
            offered_at: offer.offeredAt,
            automatic: offer.automatic,
          };
        }),
      };
    },
  );

  typed.post(
    options.path(WORKER_PATHS.offerClaim),
    {
      preValidation: [gate(WORKER_PATHS.offerClaim), options.authenticateWorker],
      schema: {
        summary:
          '*Take this one*: claim one listed offer — its scope ignored, nothing else (WP-293)',
        description:
          'Worker credential, protocol ≥ 3, not held. The one claim with its run named: the worker’s eligibility in the statement exactly as `claims` asks it — `workers_from` (a pick never jumps a server-preferred project’s head start, Q127 (a)), another user’s head start, the exclusions and both pauses — with the claim scope ignored. `200` with the run package exactly as `claims` answers it; `409 offer_not_claimable` for every reason nothing was claimed, which names none. One `human_actions` row `worker.take_offer` `{worker_id, run_id, via: worker_ui}` in the claim’s transaction. `426` below protocol 3; `503 digests_unresolved` while the core cannot name its images.',
        tags: ['worker'],
        params: runParamsSchema,
        body: workerOfferClaimRequestSchema,
        response: {
          200: runPackageSchema,
          401: apiErrorSchema,
          409: apiErrorSchema,
          426: workerUpgradeRequiredBodySchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { workerId } = await options.workerOf(request, request.body.image_digests);
      const release = options.release();
      if (release === null) {
        throw options.unresolved();
      }
      const presence = options.watch(reply);
      const answer = await options.remote.claim({
        workerId,
        heldImageDigests: request.body.image_digests,
        images: {
          run: release.digests.platform_runtime,
          egress: release.digests.platform_egress,
        },
        now: isoNow(),
        pick: request.params.id as Id,
      });
      if (answer.kind !== 'claimed') {
        // `not_packaged` too: the run was claimed and settled `not_started` — this worker has
        // nothing to run, which is what the one refusal says.
        throw new HttpError(
          409,
          'offer_not_claimable',
          'this offer cannot be taken by this worker now; refresh the list',
        );
      }
      return options.deliverClaimed(request, reply, presence, workerId, answer.package);
    },
  );
};
