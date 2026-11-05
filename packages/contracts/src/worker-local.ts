/**
 * **The worker's local page and its API** — TD-031's 2026-11-04 worker-UI amendment, WP-292.
 *
 * A `remote-worker` serves a second listener on container port {@link WORKER_UI_CONTAINER_PORT},
 * published `127.0.0.1:${APP_WORKER_UI_PORT:-7357}:7357` only: `apps/web`'s second entry
 * (`worker.html`) and the JSON verbs under {@link WORKER_LOCAL_API_PREFIX}. Both halves are in this
 * repository and read these bytes — the worker serialises with them and the page parses with them —
 * so the shapes live here (standing rule 63), snake_case like every API DTO.
 *
 * **What the page shows is exactly what the worker uploads** (amendment §3): the transcript entries
 * after the run's own redaction and the worker's exact-value redactor, the log lines after the
 * worker's log redactor — never the raw SDK stream. **The cost is shown only when reported**
 * (BD-011: a worker has no price list, so no estimate is invented) and `tokens` likewise.
 *
 * **The worker serialises with these schemas; the page reads their types and checks each answer
 * with a structural guard of its own** (`apps/web/src/worker/read-state.ts`), held to these shapes —
 * keys at every depth, enum members, bounds, nullability, both ways — by a test (TD-031's 2026-11-05
 * amendment, decision 4). Measured at WP-292: the page's initial graph is React (~60 kB gz), the
 * shared stylesheet (~10 kB) and the page — and with zod's chunk (24.5 kB gz) it was 127 kB, over
 * the page's own 120 kB budget (TD-031's worker-UI amendment §3). The exception to "zod at every
 * boundary" is ruled for this entry only (TD-031's 2026-11-05 amendment, decision 4).
 */
import * as z from 'zod';
import { agentRoleSchema, idSchema, isoDateTimeSchema } from './common.js';
import { transcriptEventSchema } from './transcript.js';

/** The local verbs' prefix on the worker's UI listener. */
export const WORKER_LOCAL_API_PREFIX = '/api/local';

/** The container port the UI listener binds; the host port is `APP_WORKER_UI_PORT` (default the same). */
export const WORKER_UI_CONTAINER_PORT = 7357;

/** The local verbs, relative to {@link WORKER_LOCAL_API_PREFIX}; `:id` is a run id. */
export const WORKER_LOCAL_PATHS = {
  state: 'state',
  pause: 'pause',
  drain: 'drain',
  cancel: 'runs/:id/cancel',
} as const;

/** How many transcript entries per run, and how many log lines, the worker keeps for the page. */
export const WORKER_LOCAL_TRANSCRIPT_TAIL = 40;
export const WORKER_LOCAL_LOG_TAIL = 200;
/** One kept log line's bound, in characters; a longer line is cut and says so. */
export const WORKER_LOCAL_LOG_LINE_MAX_CHARS = 2_000;

/** What the worker's connection to its core is (`runtime.ts`'s `WorkerConnection`). */
export const workerLocalConnectionSchema = z.enum([
  'logging_in',
  'handshaking',
  'connected',
  'revoked',
  'upgrade_required',
  'stopped',
]);
export type WorkerLocalConnection = z.infer<typeof workerLocalConnectionSchema>;

/** Where a run is on this machine. */
export const workerLocalRunPhaseSchema = z.enum(['provisioning', 'running', 'finishing', 'ended']);

/** One run this worker holds, as the page shows it. */
export const workerLocalRunSchema = z.strictObject({
  run_id: idSchema,
  task_id: idSchema,
  project_id: idSchema,
  /** From the package's display block (protocol ≥ 2); `null` from a core that sent none. */
  project_key: z.string().max(64).nullable(),
  ticket_key: z.string().max(256).nullable(),
  /** The ticket's title as the core redacted it — untrusted text, rendered as text (BD-022). */
  title: z.string().max(500).nullable(),
  stage: z.string().max(128).nullable(),
  role: agentRoleSchema,
  attempt: z.int().positive(),
  phase: workerLocalRunPhaseSchema,
  started_at: isoDateTimeSchema,
  elapsed_ms: z.int().nonnegative(),
  /**
   * Input + output tokens: while the run is `provisioning`/`running`, the sum of each model turn the
   * CLI has reported **so far** (backlog 772); once its `result` arrives, the total that reported.
   * `null` until the CLI reported any — never an estimate.
   */
  tokens: z.int().nonnegative().nullable(),
  /** The cost the run reported, USD; `null` until reported — never an estimate (BD-011). */
  cost_usd: z.number().nonnegative().nullable(),
  /** A cancel was asked from this page and the core accepted it. */
  cancel_requested: z.boolean(),
  /** The newest entries, oldest first, after redaction (at most {@link WORKER_LOCAL_TRANSCRIPT_TAIL}). */
  transcript: z.array(transcriptEventSchema).max(WORKER_LOCAL_TRANSCRIPT_TAIL),
});
export type WorkerLocalRun = z.infer<typeof workerLocalRunSchema>;

/** `GET /api/local/state` — the whole page in one answer, polled. */
export const workerLocalStateSchema = z.strictObject({
  worker_id: idSchema.nullable(),
  worker_name: z.string().max(200).nullable(),
  connection: workerLocalConnectionSchema,
  /** The protocol this worker speaks, and the range its core serves (`null` before a handshake). */
  protocol: z.int().positive(),
  core_protocol: z
    .strictObject({
      current: z.int().positive(),
      accepted: z.array(z.int().positive()).min(1).max(2),
    })
    .nullable(),
  /** The core's origin, for the link to a run's page there (steer and take-over live on the core). */
  core_url: z.string().max(2_048),
  last_handshake_at: isoDateTimeSchema.nullable(),
  /** The owner's hold from this page (or a drain's), as the core stored it. */
  manually_paused_at: isoDateTimeSchema.nullable(),
  /** A usage limit's pause (TD-031 §11), as the core last said — or as this worker set it (WP-285). */
  usage_paused_until: isoDateTimeSchema.nullable(),
  /**
   * `true` when this worker set the pause from a limit that named no reset time, so the instant is
   * its default pause (`APP_WORKER_USAGE_PAUSE_DEFAULT`) and the page says *until about* (WP-285).
   * `false` for a pause the core reported at a handshake: the protocol does not carry it.
   */
  usage_paused_estimated: z.boolean(),
  draining: z.boolean(),
  /** The core runs another build than this worker's image; `null` when either is unknown. */
  update_pending: z.boolean().nullable(),
  concurrency: z.int().positive().max(64),
  runs: z.array(workerLocalRunSchema).max(64),
  /** The worker's own log, newest last, redacted (at most {@link WORKER_LOCAL_LOG_TAIL} lines). */
  logs: z.array(z.string().max(WORKER_LOCAL_LOG_LINE_MAX_CHARS + 32)).max(WORKER_LOCAL_LOG_TAIL),
  server_time: isoDateTimeSchema,
});
export type WorkerLocalState = z.infer<typeof workerLocalStateSchema>;

/** `POST /api/local/pause` `{ paused }`: pause or resume claiming (the core's `manual-pause`). */
export const workerLocalPauseRequestSchema = z.strictObject({ paused: z.boolean() });

/** `POST /api/local/drain` takes no field: pause, finish what runs, take nothing new. */
export const workerLocalDrainRequestSchema = z.strictObject({});

/** `POST /api/local/runs/:id/cancel` `{ reason? }` with an `Idempotency-Key` — the core's cancel. */
export const workerLocalCancelRequestSchema = z.strictObject({
  reason: z.string().max(2_000).optional(),
});

/** `POST /api/local/runs/:id/cancel` → the core's verdict, in the page's words. */
export const workerLocalCancelResponseSchema = z.strictObject({
  run_id: idSchema,
  /** `true`: the stop was recorded for this worker's next heartbeat (or the run ended in place). */
  accepted: z.boolean(),
  /** The task is paused, as from the task page (Q126). */
  task_state: z.string().max(64),
});

export type WorkerLocalCancelResponse = z.infer<typeof workerLocalCancelResponseSchema>;

/** Every local answer that is not 2xx: `{ error: { code, message } }`, the API's envelope. */
export const workerLocalErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string().max(64), message: z.string().max(2_000) }),
});
