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
 */
import * as z from 'zod';
import { idSchema, isoDateTimeSchema, nonEmptyStringSchema } from './common.js';
import {
  coreImageDigestsSchema,
  imageDigestSchema,
  WORKER_CLAIM_SCOPE_MAX_PROJECTS,
  workerPauseReasonSchema,
  workerUpdateResultSchema,
  workerUserCodeSchema,
} from './worker.js';

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

/**
 * **Why a worker takes no work** — one vocabulary for the Workers screen, a project's execution
 * read and the worker's own local page (TD-031's 2026-11-05 blocker-vocabulary amendment, S-22.19).
 * Ordered **most fundamental first**: a list of blockers is always sorted in this order, and the
 * first is the one sentence a screen shows. Each side answers the half it can know:
 *
 * - `not_set_up` *(local)*: no platform chosen, no Claude sign-in, or the machine not approved yet;
 * - `revoked`: its credential was revoked — it must be approved again;
 * - `offline`: the core has not heard from it in a minute *(core)*, or it cannot reach its core
 *   *(local)*;
 * - `protocol_outdated`: it speaks a worker protocol the core no longer accepts;
 * - `claude_rejected` *(local)*: Claude refused the token it holds;
 * - `paused`: its owner paused it on its page;
 * - `draining`: a drain — finish what runs, take nothing new (the page's *Drain*, or its updater);
 * - `usage_limited`: paused until its Claude usage limit resets;
 * - `launcher_unreachable` *(local)*: its launcher does not answer, so it cannot start a run;
 * - `images_missing`: it holds none of the run images (its launcher is down, or still pulling);
 * - `images_outdated`: it holds images of another build than the core's current one;
 * - `no_eligible_project` *(core)*: no project would give it work — none it may run in admits
 *   workers, or its claim scope names none of those. *Pick only* is the owner's choice, not a
 *   blocker.
 *
 * The words are `WORKER_CLAIM_BLOCKER_WORDS` in `apps/web/src/ui/humanize.ts`, exhaustive by type.
 */
export const WORKER_CLAIM_BLOCKERS = [
  'not_set_up',
  'revoked',
  'offline',
  'protocol_outdated',
  'claude_rejected',
  'paused',
  'draining',
  'usage_limited',
  'launcher_unreachable',
  'images_missing',
  'images_outdated',
  'no_eligible_project',
] as const;
export const workerClaimBlockerSchema = z.enum(WORKER_CLAIM_BLOCKERS);
export type WorkerClaimBlocker = z.infer<typeof workerClaimBlockerSchema>;

/** A list of blockers in the vocabulary's order, each once — what every answer carries. */
export const workerClaimBlockersSchema = z
  .array(workerClaimBlockerSchema)
  .max(WORKER_CLAIM_BLOCKERS.length)
  .refine(
    (list) =>
      list.every(
        (blocker, index) =>
          index === 0 ||
          WORKER_CLAIM_BLOCKERS.indexOf(list[index - 1] as WorkerClaimBlocker) <
            WORKER_CLAIM_BLOCKERS.indexOf(blocker),
      ),
    'blockers are distinct and in the vocabulary’s order',
  );

/** Sorts and de-duplicates blockers into the vocabulary's order. */
export const orderClaimBlockers = (
  blockers: Iterable<WorkerClaimBlocker>,
): WorkerClaimBlocker[] => {
  const present = new Set(blockers);
  return WORKER_CLAIM_BLOCKERS.filter((blocker) => present.has(blocker));
};

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
   * The worker's claim scope, set by its owner from the worker's local page (WP-293), read only
   * here: `null` — every project; `[]` — *pick only*; otherwise those projects, each with its key
   * (`null` for a project that no longer exists, which matches nothing).
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
  /** The last update its updater reported (WP-287 (4)), or `null`. */
  last_update: workerLastUpdateSchema.nullable(),
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
 * `DELETE /api/workers/:id`. `performed: false` is a worker that was already revoked (a replay);
 * `expired_runs` is how many of its live runs had their lease expired in the revoking transaction.
 */
export const revokeWorkerResponseSchema = z.strictObject({
  worker_id: idSchema,
  performed: z.boolean(),
  revoked_at: isoDateTimeSchema,
  expired_runs: z.int().nonnegative(),
});
