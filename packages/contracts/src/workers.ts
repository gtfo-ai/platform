/**
 * The **people's** half of the worker surface (WP-280, TD-031 decisions 7 and 10c; technical/08's
 * TD-031 amendment): the approval page's read and decision, the Workers screen's list and the
 * revoke. Session-authenticated, CSRF-protected API DTOs, snake_case like every other.
 *
 * The **machine's** half — `POST /api/worker/v1/device` and `device/token` — is the worker protocol
 * and lives in `./worker.ts` beside the rest of it.
 *
 *   POST   /api/workers/device/lookup       what the approval page shows before a decision
 *   POST   /api/workers/device/approve      approve (naming the machine) or deny a code
 *   GET    /api/workers                     the caller's workers; every worker for an administrator
 *   DELETE /api/workers/:id                 revoke (own; any for an administrator)
 *   PUT    /api/workers/:id/claim-policy    what the machine takes (its owner only, S-26.4)
 */
import * as z from 'zod';
import { idSchema, isoDateTimeSchema, nonEmptyStringSchema } from './common.js';
import {
  coreImageDigestsSchema,
  imageDigestSchema,
  policySkippedOffersSchema,
  WORKER_CLAIM_SCOPE_MAX_PROJECTS,
  workerClaimPolicySchema,
  workerClaimScopeSchema,
  workerPauseReasonSchema,
  workerUpdateResultSchema,
  workerUserCodeSchema,
} from './worker.js';
import { workerClaimBlockersSchema } from './worker-claim-blockers.js';
import { workerIdleReasonSchema } from './worker-idle-reason.js';
import { workspaceUnavailableSchema } from './workspace-unavailable.js';

/** What a person typed: normalised by the server (case, spaces, hyphen), so only bounded here. */
export const typedUserCodeSchema = z.string().min(1).max(32);

/**
 * `POST /api/workers/device/lookup`'s body. A **read sent as a POST** on purpose (WP-280 review): a
 * user code in a URL path reaches every access log between the browser and the core, and a code is
 * ~34 bits of a pending approval.
 */
export const workerDeviceLookupRequestSchema = z.strictObject({ user_code: typedUserCodeSchema });

/**
 * What the approval page shows against code phishing (TD-031 §10c): where the request came from,
 * which client sent it and how old it is. `needs_confirmation` is `true` once the code is older than
 * five minutes, when approving it takes a second confirmation. `requested_ip` and `user_agent` are
 * what the **requesting machine** sent — untrusted text, rendered as text (BD-022).
 */
export const workerDeviceLookupResponseSchema = z.strictObject({
  user_code: workerUserCodeSchema,
  requested_ip: z.string().min(1).max(64),
  user_agent: z.string().max(512).nullable(),
  requested_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema,
  age_seconds: z.int().nonnegative(),
  needs_confirmation: z.boolean(),
});
export type WorkerDeviceLookup = z.infer<typeof workerDeviceLookupResponseSchema>;

/** A machine's name, chosen by the person who approves it. */
export const workerNameSchema = nonEmptyStringSchema
  .max(200)
  .refine((name) => name.trim() === name, 'no leading or trailing whitespace');

/**
 * `POST /api/workers/device/approve`. Approving names the machine and, for a code older than five
 * minutes, carries `confirm_stale: true` (TD-031 §10c's second confirmation); denying needs neither.
 */
export const workerDeviceDecisionRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('approve'),
    user_code: typedUserCodeSchema,
    name: workerNameSchema,
    confirm_stale: z.boolean(),
  }),
  z.strictObject({ decision: z.literal('deny'), user_code: typedUserCodeSchema }),
]);
export type WorkerDeviceDecisionRequest = z.infer<typeof workerDeviceDecisionRequestSchema>;

/**
 * The decision as recorded. The worker row is created when the machine collects the credential.
 * `performed: false` is a retry of the caller's own recorded decision (same decision, same name),
 * answered with its original instant; nothing was written.
 */
export const workerDeviceDecisionResponseSchema = z.strictObject({
  decision: z.enum(['approve', 'deny']),
  decided_at: isoDateTimeSchema,
  performed: z.boolean(),
});

/** `active` until revoked; a revoked worker's credential answers `401` to every call (TD-031 §7). */
export const workerStateSchema = z.enum(['active', 'revoked']);

/**
 * The last update a worker reported (`POST /api/worker/v1/update-report`, WP-287 (4)): how it ended,
 * from which four digests to which, the updater's words (machine text, rendered as text) and when
 * the core recorded it. `null` for a worker that never reported one.
 */
export const workerLastUpdateSchema = z.strictObject({
  result: workerUpdateResultSchema,
  from: coreImageDigestsSchema,
  to: coreImageDigestsSchema,
  detail: z.string().max(4_096).nullable(),
  reported_at: isoDateTimeSchema,
});
export type WorkerLastUpdate = z.infer<typeof workerLastUpdateSchema>;

/** One row of the Workers screen. */
export const workerSummarySchema = z.strictObject({
  id: idSchema,
  name: workerNameSchema,
  user: z.strictObject({ id: idSchema, email: z.email(), name: nonEmptyStringSchema.nullable() }),
  created_at: isoDateTimeSchema,
  last_seen_at: isoDateTimeSchema.nullable(),
  protocol_version: z.int().positive().nullable(),
  image_digests: z.array(imageDigestSchema).max(64),
  state: workerStateSchema,
  revoked_at: isoDateTimeSchema.nullable(),
  paused_until: isoDateTimeSchema.nullable(),
  paused_reason: workerPauseReasonSchema.nullable(),
  /**
   * `true` when the usage limit named no reset time and `paused_until` is the worker's default pause
   * (TD-031 §11, WP-285): the screen says *until about*. `false` with no pause.
   */
  paused_until_estimated: z.boolean(),
  /** The owner's hold from the worker's local page (WP-292): *paused by its owner*. */
  manually_paused_at: isoDateTimeSchema.nullable(),
  concurrency: z.int().positive().max(64),
  /**
   * The worker's claim scope, set by its owner (WP-293; on this screen since S-26.4): `null` —
   * every project; otherwise those projects, each with its key (`null` for a project that no
   * longer exists, which matches nothing). A legacy `[]` — *pick only* before the policy — is
   * published as stored: it narrows no project, and `claim_policy` reads `pick_only` for it.
   */
  claim_projects: z
    .array(z.strictObject({ id: idSchema, key: z.string().max(64).nullable() }))
    .max(WORKER_CLAIM_SCOPE_MAX_PROJECTS)
    .nullable(),
  /**
   * The live runs (`created`, `starting`, `running`) this worker holds (S-23.15): its claim of the
   * run's offer, or `runs.worker_id`. Ids only — the run itself is `GET /api/runs/:id`.
   */
  running: z.array(z.strictObject({ run_id: idSchema, task_id: idSchema, project_id: idSchema })),
  /**
   * What the machine takes by itself (S-26.4, TD-031's 2026-11-06 amendment item 6): the stored
   * policy, or what a `null` reads as — `pick_only` for a legacy `[]` scope, `everything`
   * otherwise. Set by the worker's own user only (`PUT /api/workers/:id/claim-policy`, or the
   * machine's page); an administrator reads it. **Optional on the wire for one reason** — the SPA's
   * fixtures predate it (its card is S-26.8a), as S-26.1's owner fields are — and this build's
   * server always sends it and `policy_skipped_offers`.
   */
  claim_policy: workerClaimPolicySchema.optional(),
  /**
   * Open offers its eligibility and scope admit now and its policy leaves for others — a `mine`
   * machine with nothing of its own is idle by choice, which is not a blocker (`claim_blockers`
   * stays empty). `null` while the core cannot name its images.
   */
  policy_skipped_offers: policySkippedOffersSchema.optional(),
  /** The last update its updater reported (WP-287 (4)), or `null`. */
  last_update: workerLastUpdateSchema.nullable(),
  /**
   * Why it takes no work, as the core knows it (S-22.19): the claim's own predicates minus the
   * per-offer ones, in the vocabulary's order — the first is the one a row shows. Empty when the
   * core would admit a claim from it now.
   */
  claim_blockers: workerClaimBlockersSchema,
  /**
   * `claim_blockers` is empty: the core would admit an **automatic** claim from it now (S-22.19).
   * A *pick only* worker (`pick_only`) is `false` here and may still take a run picked on its page.
   */
  can_claim: z.boolean(),
  /** When it last claimed a run (`run_offers.claimed_at`), or `null` — its first run is a milestone. */
  last_claimed_at: isoDateTimeSchema.nullable(),
  /**
   * **Why it runs nothing (more)** although nothing blocks it (S-28.6, the M28 ruling A): one cause,
   * with its numbers — `null` while a blocker stands (its words win) or while it is about to take
   * something. Optional on the wire for the reason `claim_policy` is (the SPA's fixtures predate it);
   * this build's server always sends it.
   */
  idle_reason: workerIdleReasonSchema.nullable().optional(),
  /**
   * S-28.12: the machine could not provision a run's workspace — the classified cause, the launcher
   * error's first line (the worker's redaction; untrusted text) and since when — from its `release
   * provision_failed` until its next claim. Its claim blockers then include `workspace_unavailable`.
   * Optional on the wire for the SPA's fixtures; this build's server always sends it.
   */
  workspace_unavailable: workspaceUnavailableSchema.nullable().optional(),
});
export type WorkerSummary = z.infer<typeof workerSummarySchema>;

/** `GET /api/workers`: the caller's own workers, or every worker for an administrator. */
export const workersResponseSchema = z.strictObject({
  items: z.array(workerSummarySchema),
  /** Whether the list is every worker (an administrator's) or only the caller's. */
  scope: z.enum(['own', 'all']),
  /**
   * The organisation's timezone (an IANA name; `UTC` when none is set or the stored one is not a
   * zone this server can use) — what a usage pause's *until HH:MM* is shown in (WP-285).
   */
  timezone: nonEmptyStringSchema.max(64),
});

export const workerParamsSchema = z.strictObject({ id: idSchema });

/**
 * `PUT /api/workers/:id/claim-policy` (S-26.4, the M26 UX spec § 1's card) — a **state assertion**
 * of both of the card's controls: *which tasks* (`claim_policy`) and *in which projects*
 * (`claim_project_ids`, `null` for every project the user may see). `[]` is refused `422
 * claim_scope_empty` (*pick only* is a policy), an id that is not a project where the user is
 * `member`+ now `422 project_not_eligible`. Only the worker's own user may write it: an
 * administrator is `403 claim_policy_owner_only`, anybody else `404`.
 */
export const workerClaimPolicyRequestSchema = z.strictObject({
  claim_policy: workerClaimPolicySchema,
  claim_project_ids: workerClaimScopeSchema,
});
export type WorkerClaimPolicyRequest = z.infer<typeof workerClaimPolicyRequestSchema>;

/**
 * The stored pair (ids distinct and sorted) and whether this call changed it: a repeat writes no
 * `human_actions` row. A run in flight is never moved — the policy applies to the next claim.
 */
export const workerClaimPolicyResponseSchema = z.strictObject({
  worker_id: idSchema,
  claim_policy: workerClaimPolicySchema,
  claim_project_ids: workerClaimScopeSchema,
  performed: z.boolean(),
});
export type WorkerClaimPolicyResponse = z.infer<typeof workerClaimPolicyResponseSchema>;

/**
 * `DELETE /api/workers/:id`. `performed: false` is a worker that was already revoked (a replay);
 * `expired_runs` is how many of its live runs had their lease expired in the revoking transaction.
 */
export const revokeWorkerResponseSchema = z.strictObject({
  worker_id: idSchema,
  performed: z.boolean(),
  revoked_at: isoDateTimeSchema,
  expired_runs: z.int().nonnegative(),
});
