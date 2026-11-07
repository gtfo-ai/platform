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
 *
 * ## Protocol 4: the claim policy, and a pick that assigns (S-26.4, TD-031's 2026-11-06 amendment
 * items 6–7)
 *
 * - `claim-scope` reads and writes `claim_policy` beside the project list, and the read counts
 *   `policy_skipped_offers`. A version-4 `[]` is `422 claim_scope_empty` (*pick only* is the policy
 *   `pick_only`); a version-3 `[]` is stored as `pick_only` over every project, any other version-3
 *   write leaves the policy as it was, and a version-3 worker whose policy reads `pick_only` is
 *   answered `[]` — its own spelling of it.
 * - `offers` is **narrowed by the project list** (a legacy `[]` narrows nothing), `automatic` is
 *   the policy's answer, and at protocol 4 each entry names the task's `owner` and whether it is
 *   `mine`, beside the list's `as_of` and `policy_skipped_offers`.
 * - `offers/:id/claim` of an unassigned stage offer makes the picker the task's owner in the claim's
 *   transaction (a second `human_actions` row `task.owner {via: pick}`), claims a task held
 *   elsewhere without assigning, assigns nothing for an ask, and refuses another person's task:
 *   `409 task_taken_by_another` when its owner changed after the body's `as_of`, else `409
 *   task_owned_by_another`, both naming the owner — and `offer_not_claimable` to a version-3 worker.
 *
 * ## `GET claim-scope?fields=unassigned_has_taker` (BACKLOG 1456)
 *
 * The M26 UX spec § 1's consequence line — "Unassigned tasks in Autix have nowhere to run." — needs,
 * per project the page lists, whether **someone other than this worker** takes its unassigned tasks
 * by itself. The worker has no user session, so the execution read (S-26.5's
 * `others_take_unassigned`) is not its to call; the answer rides on the read that already lists
 * exactly those projects and is read exactly when the setting is — at the page's mount, after a
 * save, and whenever the polled state's policy moves — rather than on `GET offers`, which the page
 * polls every 10 s for an answer about other machines' **settings** that moves far less often, or
 * on a new verb, which an older core would answer `404`. It is **opt-in** (`fields=`, as
 * `held_elsewhere` is on `GET offers`): a worker built before it parses strictly and never asks, an
 * older core ignores the query and sends no field, which the page reads as unknown. Protocol ≥ 4
 * only. The computation is the execution read's own statement (`queries/offer-waiting.ts`'s
 * `unassignedTakersOf`) with the **asking worker** excluded instead of its user, since the spec says
 * "no other machine" — the user's other machines take work too — and it names no machine.
 */
import type { RemoteRuns } from '@platform/application';
import {
  apiErrorSchema,
  type Id,
  type IsoDateTime,
  parseWorkerProtocolHeader,
  type RunDisplay,
  runPackageSchema,
  WORKER_CLAIM_SCOPE_TAKERS_QUERY,
  WORKER_OFFERS_HELD_ELSEWHERE_QUERY,
  WORKER_OFFERS_LIST_MAX,
  WORKER_PATHS,
  WORKER_PROTOCOL_CLAIM_POLICY,
  WORKER_PROTOCOL_CLAIM_SCOPE,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
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
  /**
   * Per project id: whether somebody other than `workerId` takes its unassigned tasks by itself
   * (BACKLOG 1456, `unassignedTakersOf`). `null`/absent: `unassigned_has_taker` is never sent.
   */
  readonly unassignedTakers?:
    | ((workerId: Id, projectIds: readonly Id[]) => Promise<ReadonlyMap<string, boolean>>)
    | null;
}

const runParamsSchema = z.strictObject({ id: z.uuid() });

const unauthenticated = (what: string): HttpError =>
  new HttpError(401, 'unauthenticated', `${what} (TD-031 §7)`);

/** Whether the request speaks protocol 4 or later — the claim policy's shapes (S-26.4). */
const speaksClaimPolicy = (request: FastifyRequest): boolean =>
  (parseWorkerProtocolHeader(request.headers[WORKER_PROTOCOL_HEADER]) ?? WORKER_PROTOCOL_VERSION) >=
  WORKER_PROTOCOL_CLAIM_POLICY;

/** Whether the request's `fields` names `field` — the opt-ins' one reader. */
const asksField = (request: FastifyRequest, field: string | null): boolean => {
  const fields = (request.query as Record<string, unknown> | undefined)?.fields;
  return typeof fields === 'string' && fields.split(',').includes(field ?? '');
};

/** The `fields` value a worker sends to be told each offer's `held_elsewhere` (S-26.7). */
const HELD_ELSEWHERE_FIELD = new URLSearchParams(WORKER_OFFERS_HELD_ELSEWHERE_QUERY).get('fields');

/**
 * Whether the request asked for `held_elsewhere` (S-26.7): an opt-in, so a worker built before the
 * field — whose strict parse refuses an unknown key — is never sent it. The route declares no
 * querystring schema, so any other query is ignored, as it always was.
 */
const asksHeldElsewhere = (request: FastifyRequest): boolean =>
  asksField(request, HELD_ELSEWHERE_FIELD);

/** The `fields` value a worker sends to be told `unassigned_has_taker` (BACKLOG 1456). */
const TAKERS_FIELD = new URLSearchParams(WORKER_CLAIM_SCOPE_TAKERS_QUERY).get('fields');

/**
 * The scope a version-3 worker is shown (S-26.4): `[]` — its own *pick only* — when the policy
 * reads `pick_only`, else the list as stored.
 */
const scopeForV3 = (
  claimProjectIds: readonly string[] | null,
  claimPolicy: string,
): string[] | null =>
  claimPolicy === 'pick_only' ? [] : claimProjectIds === null ? null : [...claimProjectIds];

/** A pick's ownership refusal as the API says it: the owner by name, and their id in `details`. */
const ownedRefusal = (
  refusal: 'task_taken_by_another' | 'task_owned_by_another',
  owner: { readonly userId: string; readonly name: string },
): HttpError => {
  const who = owner.name.length > 0 ? owner.name : 'another person';
  return new HttpError(
    409,
    refusal,
    refusal === 'task_taken_by_another'
      ? `${who} took this task a moment ago; pick another`
      : `this task is ${who}'s; a maintainer can reassign it on the task page`,
    [
      { path: 'owner.user_id', message: owner.userId },
      { path: 'owner.name', message: owner.name },
    ],
  );
};

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

  const readScope = async (workerId: Id, v4: boolean, takers = false) => {
    const release = options.release();
    const scope = await options.store.claimScope(
      workerId,
      release === null
        ? null
        : { run: release.digests.platform_runtime, egress: release.digests.platform_egress },
    );
    if (scope.status === 'not_found') {
      throw unauthenticated('the worker credential names no worker');
    }
    const projects = scope.projects.map((project) => ({
      id: project.id,
      key: project.key,
      name: project.name,
    }));
    if (!v4) {
      return { claim_project_ids: scopeForV3(scope.claimProjectIds, scope.claimPolicy), projects };
    }
    const asked = takers ? (options.unassignedTakers ?? null) : null;
    const answered =
      asked === null
        ? null
        : await asked(
            workerId,
            projects.map((project) => project.id as Id),
          );
    return {
      claim_project_ids: scope.claimProjectIds === null ? null : [...scope.claimProjectIds],
      projects,
      claim_policy: scope.claimPolicy,
      policy_skipped_offers: scope.policySkippedOffers,
      // BACKLOG 1456: a listed project the answer does not name (gone since) is left unknown.
      ...(answered === null
        ? {}
        : {
            unassigned_has_taker: Object.fromEntries(
              projects.flatMap((project) => {
                const value = answered.get(project.id);
                return value === undefined ? [] : [[project.id, value] as const];
              }),
            ),
          }),
    };
  };

  typed.get(
    options.path(WORKER_PATHS.claimScope),
    {
      preValidation: [gate(WORKER_PATHS.claimScope), options.authenticateWorker],
      schema: {
        summary: 'The worker’s claim scope and the projects it may name (WP-293)',
        description:
          'Worker credential, protocol ≥ 3. `claim_project_ids`: `null` every project, otherwise those projects; `projects`: the projects where the worker’s user’s effective role is `member` or above now — the claim’s own predicate — by key. Protocol ≥ 4 (S-26.4): `claim_policy` — what the worker takes by itself — and `policy_skipped_offers`, the open offers its eligibility and scope admit now and its policy leaves for others (`null` while the core cannot name its images). With `?fields=unassigned_has_taker` (BACKLOG 1456), protocol ≥ 4: `unassigned_has_taker`, per listed project id, whether the server claimant or any machine other than this one takes the project’s unassigned tasks by itself — the setting, connected or not, naming no machine — an opt-in, so a worker built before the field is never sent it. A version-3 worker is answered `[]` for a policy that reads `pick_only`. `426` below protocol 3.',
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
      return readScope(workerId, speaksClaimPolicy(request), asksField(request, TAKERS_FIELD));
    },
  );

  typed.put(
    options.path(WORKER_PATHS.claimScope),
    {
      preValidation: [gate(WORKER_PATHS.claimScope), options.authenticateWorker],
      schema: {
        summary: 'Set what the worker’s automatic claims take — its owner, from the local page',
        description:
          'Worker credential, protocol ≥ 3. A state assertion over `workers.claim_project_ids` (WP-293, TD-031’s claim-scope amendment §2): `null` every project, otherwise those projects, stored distinct and sorted — and, protocol ≥ 4 (S-26.4), `claim_policy` (absent leaves it as it was). A conjunct of an automatic claim only — it can only narrow, and a pick ignores it. At protocol 4 `[]` is `422 claim_scope_empty` (*pick only* is `claim_policy: pick_only`); a version-3 worker’s `[]` is stored as `pick_only` over every project. `422 project_not_eligible` names the ids that are not a project where the user is `member`+ now; nothing is written. One `human_actions` row per change, the worker’s user — `worker.claim_policy` `{worker_id, claim_policy, project_ids, via: worker_ui}` when the policy moved, else `worker.claim_scope` `{worker_id, project_ids, via: worker_ui}`; a repeat of the stored pair is `performed: false` and writes none. `426` below protocol 3.',
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
      const v4 = speaksClaimPolicy(request);
      const ids = request.body.claim_project_ids;
      // S-26.4: a version-3 worker's `[]` is its *pick only* — the policy over every project.
      const legacyPickOnly = !v4 && ids !== null && ids.length === 0;
      const policy = legacyPickOnly ? 'pick_only' : request.body.claim_policy;
      const result = await options.store.setClaimScope({
        workerId,
        projectIds: legacyPickOnly ? null : ids,
        ...(policy === undefined ? {} : { policy }),
      });
      if (result.status === 'not_found' || result.status === 'not_owner') {
        throw unauthenticated('the worker credential names no worker');
      }
      if (result.status === 'empty_scope') {
        throw new HttpError(
          422,
          'claim_scope_empty',
          'choose at least one project, or every project; to take nothing by itself, set claim_policy to pick_only',
        );
      }
      if (result.status === 'invalid') {
        throw new HttpError(
          422,
          'project_not_eligible',
          `the scope names ${result.projectIds.length} project(s) where this worker’s user may not take a run: ${result.projectIds.join(', ')}`,
        );
      }
      return v4
        ? {
            claim_project_ids: result.claimProjectIds === null ? null : [...result.claimProjectIds],
            claim_policy: result.claimPolicy,
            performed: result.performed,
          }
        : {
            claim_project_ids: scopeForV3(result.claimProjectIds, result.claimPolicy),
            performed: result.performed,
          };
    },
  );

  typed.get(
    options.path(WORKER_PATHS.offers),
    {
      preValidation: [gate(WORKER_PATHS.offers), options.authenticateWorker],
      schema: {
        summary: 'The open offers this worker could take now, in its projects (WP-293, S-26.4)',
        description:
          'Worker credential, protocol ≥ 3. At most 50 open offers, oldest first, that a pick would admit for this worker now — the claim’s own eligibility text, against the image digests the worker last reported, **narrowed by its project list** (S-26.4; a pick of an offer outside it is still admitted) — each with whether its claim scope and policy take it automatically (`automatic`). Protocol ≥ 4: each entry’s `owner` (the task’s, `null` for nobody) and `mine` (a task its user owns, or an ask they asked), and the list’s `as_of` and `policy_skipped_offers`; with `?fields=held_elsewhere` (S-26.7) each entry adds `held_elsewhere` — its task’s tracker assignee is a person the platform cannot match to a member, so a pick claims it without assigning — an opt-in, so a worker built before the field is never sent it. The ticket key and the title come from the redacted ticket snapshot and are untrusted text; an ask carries its task and stage, never the question’s text. `426` below protocol 3; `503 digests_unresolved` while the core cannot name its images.',
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
      const v4 = speaksClaimPolicy(request);
      const heldElsewhere = v4 && asksHeldElsewhere(request);
      const asOf = isoNow();
      const offers = await options.remote.offers({
        workerId,
        heldImageDigests: imageDigests,
        images: {
          run: release.digests.platform_runtime,
          egress: release.digests.platform_egress,
        },
        now: asOf,
        limit: WORKER_OFFERS_LIST_MAX,
      });
      const skipped = v4
        ? await options.store.policySkippedOffers(workerId, {
            run: release.digests.platform_runtime,
            egress: release.digests.platform_egress,
          })
        : null;
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
            ...(v4
              ? {
                  owner:
                    offer.owner === null
                      ? null
                      : { user_id: offer.owner.userId, name: offer.owner.name },
                  mine: offer.mine,
                }
              : {}),
            ...(heldElsewhere ? { held_elsewhere: offer.heldElsewhere } : {}),
          };
        }),
        ...(v4 ? { as_of: asOf, policy_skipped_offers: skipped } : {}),
      };
    },
  );

  typed.post(
    options.path(WORKER_PATHS.offerClaim),
    {
      preValidation: [gate(WORKER_PATHS.offerClaim), options.authenticateWorker],
      schema: {
        summary:
          '*Take this one*: claim one listed offer — scope and policy ignored; an unassigned task becomes yours (WP-293, S-26.4)',
        description:
          'Worker credential, protocol ≥ 3, not held. The one claim with its run named: the worker’s eligibility in the statement exactly as `claims` asks it — `workers_from` (a pick never jumps a server-preferred project’s head start, Q127 (a)), another user’s head start, the exclusions and both pauses — with the claim scope and policy ignored. `200` with the run package exactly as `claims` answers it. One `human_actions` row `worker.take_offer` `{worker_id, run_id, via: worker_ui}` in the claim’s transaction. **A pick assigns** (S-26.4): a stage offer whose task is unassigned — no owner, not held elsewhere — makes the worker’s user its owner in the same transaction (`task.owner.changed`, `via: pick`; a second row `task.owner` `{via: pick}`); a task held elsewhere is claimed without assigning; an ask assigns nothing. A task another person owns is never taken: `409 task_taken_by_another` when its owner changed after the body’s `as_of`, else `409 task_owned_by_another`, each naming the owner (`details`: `owner.user_id`, `owner.name`) — a version-3 worker is answered `offer_not_claimable` for both. `409 offer_not_claimable` for every other reason nothing was claimed, which names none. `426` below protocol 3; `503 digests_unresolved` while the core cannot name its images.',
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
        ...(request.body.as_of === undefined ? {} : { asOf: request.body.as_of }),
      });
      if (answer.kind === 'owned_by_another' && speaksClaimPolicy(request)) {
        throw ownedRefusal(answer.refusal, answer.owner);
      }
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
