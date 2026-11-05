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
import {
  workerClaimScopeResponseSchema,
  workerClaimScopeSchema,
  workerOffersResponseSchema,
} from './worker.js';
import { WORKER_CLAIM_BLOCKERS, workerClaimBlockerSchema } from './worker-claim-blockers.js';

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
  /** The claim scope: `GET` reads it with the projects it may name, `POST` sets it (WP-293). */
  claimScope: 'claim-scope',
  /** The open offers this worker could take now (WP-293); the page polls it while visible. */
  offers: 'offers',
  /** *Take this one* (WP-293): the core's `POST offers/:id/claim`, then the run starts here. */
  take: 'offers/:id/take',
  // The first-run wizard (TD-031's 2026-11-05 first-run amendment §8, WP-294).
  coreCheck: 'core/check',
  core: 'core',
  claudeSignIn: 'claude/sign-in',
  claudeCode: 'claude/code',
  claudeToken: 'claude/token',
  claudeSignOut: 'claude/sign-out',
  connectAgain: 'connect-again',
  retry: 'retry',
  // The *Error reporting* setting (WP-295, TD-023's 2026-11-05 amendment §3).
  errorReporting: 'error-reporting',
  errorReportingTest: 'error-reporting/test',
} as const;

/**
 * `APP_WORKER_UI_AUTH` (TD-031's 2026-11-05 no-bearer amendment): `none` (the default) needs no
 * bearer on `/api/local/*`; `token` keeps WP-292's `ui-token` and its `401`.
 */
export const workerUiAuthSchema = z.enum(['none', 'token']);
export type WorkerUiAuth = z.infer<typeof workerUiAuthSchema>;

/** How many transcript entries per run, and how many log lines, the worker keeps for the page. */
export const WORKER_LOCAL_TRANSCRIPT_TAIL = 40;
export const WORKER_LOCAL_LOG_TAIL = 200;
/** One kept log line's bound, in characters; a longer line is cut and says so. */
export const WORKER_LOCAL_LOG_LINE_MAX_CHARS = 2_000;

/** What the worker's connection to its core is (`runtime.ts`'s `WorkerConnection`). */
export const workerLocalConnectionSchema = z.enum([
  // The wizard's open steps (WP-294): no platform yet, no Claude sign-in yet.
  'needs_platform',
  'needs_claude',
  'logging_in',
  'handshaking',
  'connected',
  'revoked',
  'upgrade_required',
  /** The core did not answer (or not as a platform): retried with backoff, *Try now* on the page. */
  'core_unreachable',
  'stopped',
]);
export type WorkerLocalConnection = z.infer<typeof workerLocalConnectionSchema>;

/** Where a value the worker runs with came from: its environment (changed there), or the page. */
export const workerLocalSourceSchema = z.enum(['environment', 'file']);
export type WorkerLocalSource = z.infer<typeof workerLocalSourceSchema>;

/**
 * Why a platform address was not taken, or why the core does not answer — a class, never the body
 * it answered (TD-031's first-run amendment §3).
 */
export const workerLocalCoreFailureSchema = z.enum([
  /** `http:` to a host that is not this machine, userinfo, or not a URL at all. */
  'address_refused',
  'no_answer',
  'not_a_platform',
  'certificate',
  /** The core's `426`: it serves another worker protocol. */
  'needs_other_version',
]);
export type WorkerLocalCoreFailure = z.infer<typeof workerLocalCoreFailureSchema>;

/** Where the Claude sign-in (`claude setup-token` in a pty) is. */
export const workerLocalSignInPhaseSchema = z.enum([
  'idle',
  'starting',
  'waiting_for_code',
  'checking',
  'failed',
]);
export type WorkerLocalSignInPhase = z.infer<typeof workerLocalSignInPhaseSchema>;

/** Why a sign-in did not end with a stored token — platform words are the page's, by this key. */
export const workerLocalSignInFailureSchema = z.enum([
  /** The CLI could not be started (no `claude-cli` volume). */
  'cli_unavailable',
  /** The CLI ended, or showed nothing this worker reads, before a token. */
  'cli_ended',
  /** Claude refused the pasted code. */
  'code_refused',
  /** The token was captured or pasted, and Claude refused it at the check. */
  'token_rejected',
  /** The check could not reach Claude. */
  'check_failed',
  /** Ten minutes passed. */
  'timed_out',
]);
export type WorkerLocalSignInFailure = z.infer<typeof workerLocalSignInFailureSchema>;

/**
 * The first-run wizard's facts (WP-294) — local only, never the protocol. **Write-only secrets**:
 * the Claude token, the pasted code and the credential appear here as their *source* or not at all.
 */
export const workerLocalSetupSchema = z.strictObject({
  /** `null` while no platform is chosen; `environment` is changed there, not on the page. */
  core_source: workerLocalSourceSchema.nullable(),
  /** Platforms the worker found answering on this machine (`host.docker.internal`, the list). */
  candidates: z
    .array(z.strictObject({ url: z.string().max(2_048), version: z.string().max(128) }))
    .max(8),
  claude_source: workerLocalSourceSchema.nullable(),
  /** Claude refused the token this worker holds: it claims nothing until a new sign-in. */
  claude_rejected: z.boolean(),
  sign_in: z.strictObject({
    phase: workerLocalSignInPhaseSchema,
    /** The CLI's sign-in address — `https:` on an Anthropic host only, else `null`. */
    url: z.string().max(4_096).nullable(),
    failure: workerLocalSignInFailureSchema.nullable(),
  }),
  /** The device code to approve, while one is open; `approve_url` is on the core's own origin. */
  device: z
    .strictObject({
      user_code: z.string().max(16),
      approve_url: z.string().max(2_048).nullable(),
      expires_at: isoDateTimeSchema,
    })
    .nullable(),
  /** Why the core is not answering, and when it is asked again. */
  unreachable: z
    .strictObject({
      failure: workerLocalCoreFailureSchema,
      retry_at: isoDateTimeSchema.nullable(),
    })
    .nullable(),
  /** No run in flight: *Change platform* and *Sign out* are offered only then. */
  idle: z.boolean(),
  /** How the page is reached (`APP_WORKER_UI_AUTH`). */
  auth: workerUiAuthSchema,
});
export type WorkerLocalSetup = z.infer<typeof workerLocalSetupSchema>;

/**
 * The *Error reporting* setting (WP-295, TD-023's 2026-11-05 amendment §3): where the DSN came from
 * — `SENTRY_DSN(_FILE)` in the environment wins, else the page's `sentry-dsn` in `worker-state` —
 * and the host events go to. **The DSN itself is never answered**: it carries the project's key.
 */
export const workerLocalErrorReportingSchema = z.strictObject({
  /** `null`: off. `environment`: changed there, the page's actions answer `409`. */
  source: workerLocalSourceSchema.nullable(),
  /** The DSN's host (`o1.ingest.sentry.io`, `localhost:9000`), `null` while off. */
  host: z.string().max(253).nullable(),
});
export type WorkerLocalErrorReporting = z.infer<typeof workerLocalErrorReportingSchema>;

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

/**
 * Whether the worker's launcher answered its last health probe (`runtime.ts`'s `LauncherReach`,
 * backlog 980): `unknown` before the first, which the worker makes at start — the wizard included.
 */
export const workerLocalLauncherSchema = z.enum(['unknown', 'ok', 'unreachable']);
export type WorkerLocalLauncher = z.infer<typeof workerLocalLauncherSchema>;

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
  /**
   * The core's origin, for the link to a run's page there (steer and take-over live on the core);
   * `null` while no platform is chosen (WP-294).
   */
  core_url: z.string().max(2_048).nullable(),
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
  /** The launcher this worker starts runs through — a page that came up without it says so. */
  launcher: workerLocalLauncherSchema,
  /** The core runs another build than this worker's image; `null` when either is unknown. */
  update_pending: z.boolean().nullable(),
  concurrency: z.int().positive().max(64),
  runs: z.array(workerLocalRunSchema).max(64),
  /** The worker's own log, newest last, redacted (at most {@link WORKER_LOCAL_LOG_TAIL} lines). */
  logs: z.array(z.string().max(WORKER_LOCAL_LOG_LINE_MAX_CHARS + 32)).max(WORKER_LOCAL_LOG_TAIL),
  /** The first-run wizard's facts (WP-294). */
  setup: workerLocalSetupSchema,
  /**
   * Why this worker takes no work, as the machine knows it (S-22.19): its connection, Claude's
   * verdict on its token, its holds, whether its launcher answered and which images it holds against
   * the digests its core named — the one vocabulary, most fundamental first (the worker sorts it;
   * the page's guard checks members and bound only). Empty: *Taking work*.
   */
  claim_blockers: z.array(workerClaimBlockerSchema).max(WORKER_CLAIM_BLOCKERS.length),
  /** The *Error reporting* setting (WP-295). */
  error_reporting: workerLocalErrorReportingSchema,
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

/**
 * `GET /api/local/claim-scope` and `POST /api/local/claim-scope`'s answer (WP-293): the core's
 * `GET claim-scope` as it answered — the stored scope and the projects it may name.
 */
export const workerLocalClaimScopeSchema = workerClaimScopeResponseSchema;
export type WorkerLocalClaimScope = z.infer<typeof workerLocalClaimScopeSchema>;

/** `POST /api/local/claim-scope` `{ claim_project_ids }`: `null` every project, `[]` pick only. */
export const workerLocalClaimScopeRequestSchema = z.strictObject({
  claim_project_ids: workerClaimScopeSchema,
});

/** `GET /api/local/offers` — the core's `GET offers`, after this worker's exact-value redactor. */
export const workerLocalOffersSchema = workerOffersResponseSchema;
export type WorkerLocalOffers = z.infer<typeof workerLocalOffersSchema>;

/** `POST /api/local/offers/:id/take` takes no field. */
export const workerLocalTakeRequestSchema = z.strictObject({});

/** `POST /api/local/offers/:id/take` → the run this worker claimed and now runs. */
export const workerLocalTakeResponseSchema = z.strictObject({ run_id: idSchema });
export type WorkerLocalTakeResponse = z.infer<typeof workerLocalTakeResponseSchema>;
/** `POST /api/local/core/check` and `POST /api/local/core` `{ url }`; `core` takes `null` to forget it. */
export const workerLocalCoreCheckRequestSchema = z.strictObject({
  url: z.string().min(1).max(2_048),
});
export const workerLocalCoreRequestSchema = z.strictObject({
  url: z.string().min(1).max(2_048).nullable(),
});

/** `POST /api/local/core/check` → only fields the worker parsed with the core's own schemas. */
export const workerLocalCoreCheckResponseSchema = z.strictObject({
  /** The origin the worker would use. */
  url: z.string().max(2_048),
  host: z.string().max(253),
  version: z.string().max(128),
  /** `unknown`: an older core whose `release` asked for a credential — *checked partly*. */
  protocol_fit: z.enum(['fits', 'unknown']),
});
export type WorkerLocalCoreCheckResponse = z.infer<typeof workerLocalCoreCheckResponseSchema>;

/** `POST /api/local/claude/sign-in` `{ action }`: start the CLI's sign-in, or cancel it. */
export const workerLocalSignInRequestSchema = z.strictObject({
  action: z.enum(['start', 'cancel']),
});

/**
 * `POST /api/local/claude/code` `{ code }`: what Claude's page shows (`code#state`, V-WM10), written
 * to the CLI's stdin — so only its characters, never a control character or a line break that would
 * answer a prompt the CLI shows next (review of PR #42).
 */
export const workerLocalClaudeCodeRequestSchema = z.strictObject({
  code: z
    .string()
    .min(1)
    .max(1_024)
    .regex(/^[A-Za-z0-9#_-]+$/, 'expected the code Claude shows'),
});

/** `POST /api/local/claude/token` `{ token }`: a token from `claude setup-token`, pasted. */
export const workerLocalClaudeTokenRequestSchema = z.strictObject({
  token: z.string().min(1).max(1_024),
});

/** Every local answer that is not 2xx: `{ error: { code, message } }`, the API's envelope. */
export const workerLocalErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.string().max(64), message: z.string().max(2_000) }),
});

/**
 * `POST /api/local/error-reporting` `{ dsn }` (WP-295): *Save* a DSN, or *Remove* it with `null`.
 * Validated by the worker (`https://<key>@<host>/<project id>`, `http:` only to loopback) — `422`
 * otherwise, never echoing the value — and answered with the state.
 */
export const workerLocalErrorReportingRequestSchema = z.strictObject({
  dsn: z.string().min(1).max(2_048).nullable(),
});

/** `POST /api/local/error-reporting/test` takes no field: *Send a test error*. */
export const workerLocalErrorReportingTestRequestSchema = z.strictObject({});

/**
 * `POST /api/local/error-reporting/test` → the test event's id (`null` when the SDK made none) and
 * whether the sending finished within the worker's bound — not whether Sentry stored it.
 */
export const workerLocalErrorReportingTestResponseSchema = z.strictObject({
  event_id: z.string().max(64).nullable(),
  delivered: z.boolean(),
});
export type WorkerLocalErrorReportingTestResponse = z.infer<
  typeof workerLocalErrorReportingTestResponseSchema
>;
