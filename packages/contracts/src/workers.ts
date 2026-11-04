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
import { imageDigestSchema, workerPauseReasonSchema, workerUserCodeSchema } from './worker.js';

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
  concurrency: z.int().positive().max(64),
});
export type WorkerSummary = z.infer<typeof workerSummarySchema>;

/** `GET /api/workers`: the caller's own workers, or every worker for an administrator. */
export const workersResponseSchema = z.strictObject({
  items: z.array(workerSummarySchema),
  /** Whether the list is every worker (an administrator's) or only the caller's. */
  scope: z.enum(['own', 'all']),
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
