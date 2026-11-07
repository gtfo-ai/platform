/**
 * **The worker's half of the worker protocol** — WP-283 (1), TD-031 decision 9.
 *
 * Every call a `remote-worker` makes to its core goes through {@link createCoreClient}: JSON over
 * HTTPS under `/api/worker/v1/`, `X-Worker-Protocol` on every request, `Authorization: Bearer` with
 * the worker credential (the worker verbs) or the run token (the run verbs), and every answer parsed
 * by the **same** zod schema the core's route serialises with (`@platform/contracts`'s `worker.ts`).
 *
 * ## What an answer means to the worker
 *
 * One error class, {@link CoreCallError}, whose `kind` is what the caller branches on:
 *
 * | kind | when | what the worker does |
 * |---|---|---|
 * | `lease_lost` | `409 lease_lost`, and **every `401`** on a run verb (TD-031 §2, §7) | stops the session, destroys the workspace, pushes nothing |
 * | `run_gone` | `410 run_gone` | the same: the run's task was deleted |
 * | `unauthenticated` | `401` on a worker verb | the credential was revoked: stop claiming |
 * | `upgrade_required` | `426` | stop claiming; finish nothing not started (TD-032 §5) |
 * | `refused` | any other `4xx` | the call's own answer (`409 run_started`, `403 tool_not_granted`, …) |
 * | `transient` | a network failure, a timeout, `5xx`, `429`, an answer that does not parse | retried with jitter (`retry.ts`) until self-termination |
 *
 * ## Nothing secret in a body, by construction and by test
 *
 * The client never builds a body from the worker's own secrets: the Claude token is not a parameter
 * of any method, and the run token and the worker credential travel only in `Authorization`. The
 * bodies it sends are what the run session hands it — transcript entries, tool inputs, approval
 * requests — each already passed through the run's local redactor (`run-session.ts`), and
 * `remote-worker.test.ts` captures **every** request this client makes over a whole run with a
 * planted token and finds it in none.
 */
import {
  apiErrorSchema,
  type RunPackage,
  runPackageSchema,
  WORKER_API_PREFIX,
  WORKER_PATHS,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_VERSION,
  workerApprovalResponseSchema,
  workerClaimScopeResponseSchema,
  workerClaimScopeSetResponseSchema,
  workerDeviceResponseSchema,
  workerDeviceTokenErrorSchema,
  workerDeviceTokenResponseSchema,
  workerFinishResponseSchema,
  workerHandshakeResponseSchema,
  workerHeartbeatResponseSchema,
  workerLateCostResponseSchema,
  workerManualPauseResponseSchema,
  workerOffersResponseSchema,
  workerReleaseResponseSchema,
  workerRunCancelResponseSchema,
  workerSpawnResponseSchema,
  workerSshSignResponseSchema,
  workerToolCallResponseSchema,
  workerTranscriptResponseSchema,
  workerUpgradeRequiredBodySchema,
} from '@platform/contracts';
import type * as z from 'zod';

export type CoreCallErrorKind =
  | 'lease_lost'
  | 'run_gone'
  | 'unauthenticated'
  | 'upgrade_required'
  | 'refused'
  | 'transient';

export class CoreCallError extends Error {
  override readonly name = 'CoreCallError';
  readonly kind: CoreCallErrorKind;
  /** The HTTP status, or `null` for a call that got no answer. */
  readonly status: number | null;
  /** The envelope's `error.code`, when the core sent one. */
  readonly code: string | null;
  /** The envelope's `error.details`, when the core sent them (S-26.7: a refused pick's owner). */
  readonly details: readonly { readonly path: string; readonly message: string }[];
  constructor(
    kind: CoreCallErrorKind,
    status: number | null,
    code: string | null,
    message: string,
    details: readonly { readonly path: string; readonly message: string }[] = [],
  ) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a failed call may be made again unchanged. Only a {@link CoreCallError} can be: every
 * network failure is wrapped into one, so anything else is a defect, and a defect retried is a
 * defect repeated.
 */
export const isTransient = (error: unknown): boolean =>
  error instanceof CoreCallError && error.kind === 'transient';

/** Whether the run this call was about is no longer this worker's (TD-031 §2). */
export const isRunLost = (error: unknown): boolean =>
  error instanceof CoreCallError && (error.kind === 'lease_lost' || error.kind === 'run_gone');

export type CoreFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The longest any one call may take: a held request is ≤ 25 s on the core, plus the network. */
export const CORE_CALL_TIMEOUT_MS = 60_000;

export interface CoreClientOptions {
  /** `APP_CORE_URL` — the core's public origin. */
  readonly baseUrl: string;
  readonly fetch?: CoreFetch;
  readonly timeoutMs?: number;
}

/** The answer of `POST device/token`: the credential once, or one of RFC 8628's four. */
export type DeviceTokenAnswer =
  | { readonly kind: 'credential'; readonly workerId: string; readonly credential: string }
  | {
      readonly kind: 'pending' | 'slow_down' | 'access_denied' | 'expired_token';
    };

const errorCodeOf = (body: unknown): string | null => {
  const parsed = apiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
};

const classify = (status: number, code: string | null, runScoped: boolean): CoreCallErrorKind => {
  if (status === 401) return runScoped ? 'lease_lost' : 'unauthenticated';
  if (status === 409 && code === 'lease_lost') return 'lease_lost';
  if (status === 410) return 'run_gone';
  if (status === 426) return 'upgrade_required';
  if (status === 429 || status >= 500) return 'transient';
  return 'refused';
};

export interface RunScopedClient {
  heartbeat(
    body: unknown,
    signal?: AbortSignal,
  ): Promise<z.output<typeof workerHeartbeatResponseSchema>>;
  transcript(body: unknown): Promise<z.output<typeof workerTranscriptResponseSchema>>;
  tool(name: string, body: unknown): Promise<z.output<typeof workerToolCallResponseSchema>>;
  approval(body: unknown): Promise<z.output<typeof workerApprovalResponseSchema>>;
  sshSign(body: unknown): Promise<z.output<typeof workerSshSignResponseSchema>>;
  spawn(body: unknown): Promise<z.output<typeof workerSpawnResponseSchema>>;
  release(body: unknown): Promise<void>;
  finish(body: unknown): Promise<z.output<typeof workerFinishResponseSchema>>;
  lateCost(body: unknown): Promise<z.output<typeof workerLateCostResponseSchema>>;
  /**
   * A person's cancel from the local page (WP-292): the core's `run.cancel` as the worker's user,
   * under `idempotencyKey`. A `403` is a `refused` error carrying the core's words.
   */
  cancel(
    body: unknown,
    idempotencyKey: string,
  ): Promise<z.output<typeof workerRunCancelResponseSchema>>;
}

export interface CoreClient {
  device(): Promise<z.output<typeof workerDeviceResponseSchema>>;
  deviceToken(deviceCode: string): Promise<DeviceTokenAnswer>;
  handshake(
    credential: string,
    body: unknown,
  ): Promise<z.output<typeof workerHandshakeResponseSchema>>;
  /** `null` is `204`: nothing was claimable within the hold. */
  claim(credential: string, body: unknown, signal?: AbortSignal): Promise<RunPackage | null>;
  /** The owner's hold on claiming (WP-292, protocol 2): `{ paused }`, a state assertion. */
  manualPause(
    credential: string,
    body: unknown,
  ): Promise<z.output<typeof workerManualPauseResponseSchema>>;
  /** A usage limit's pause (WP-285, TD-031 §11): `{ until, reason, estimated? }`, `204`. */
  pause(credential: string, body: unknown): Promise<void>;
  /**
   * The claim scope and the projects it may name (WP-293, protocol 3) — and, at protocol 4
   * (S-26.4), the claim policy and `policy_skipped_offers`.
   */
  claimScope(credential: string): Promise<z.output<typeof workerClaimScopeResponseSchema>>;
  /**
   * Set the claim scope (WP-293): `{ claim_project_ids, claim_policy? }`, a state assertion; the
   * core refuses `[]` at protocol 4 (`422 claim_scope_empty`: *pick only* is `claim_policy`).
   */
  setClaimScope(
    credential: string,
    body: unknown,
  ): Promise<z.output<typeof workerClaimScopeSetResponseSchema>>;
  /**
   * The open offers this worker could take now, in its projects (WP-293; S-26.4: each with its
   * `owner` and `mine`, beside the list's `as_of` and `policy_skipped_offers`).
   */
  offers(credential: string): Promise<z.output<typeof workerOffersResponseSchema>>;
  /**
   * *Take this one* (WP-293): `{ image_digests, as_of? }` → the package, or a `refused` error with
   * `code: offer_not_claimable` — or, since protocol 4 (S-26.4), `task_taken_by_another` /
   * `task_owned_by_another` for a task another person owns. An answer that does not parse is
   * `refused` with `package_unreadable`, as `claim`'s is.
   */
  takeOffer(credential: string, runId: string, body: unknown): Promise<RunPackage>;
  forRun(runId: string, runToken: string): RunScopedClient;
  /**
   * `GET release` (TD-032 §3): the core's digests and the protocols it accepts. A `426` is not an
   * error here — its body names the same two (TD-031 §9), which is what the updater follows. The
   * verb is public since WP-294: `null` asks it with no `Authorization` header (a worker that is not
   * approved yet still follows its core's release).
   */
  release(credential: string | null): Promise<CoreReleaseAnswer>;
  /** `POST update-report` (TD-032 §6): how this worker's update ended. Answers nothing (`204`). */
  updateReport(credential: string, body: unknown): Promise<void>;
}

/** What `GET release` (or the `426` it may answer instead) says. */
export interface CoreReleaseAnswer {
  readonly accepted: readonly number[];
  /** `null` while the core cannot name its digests (a `426` carrying `digests: null`). */
  readonly digests: z.output<typeof workerReleaseResponseSchema>['digests'] | null;
  readonly upgradeRequired: boolean;
}

/**
 * A transport failure's message with the bearer taken out (review of PR #42): Node's `fetch` names a
 * header value it refuses (`… is an invalid header value`), so a credential that ever carried a line
 * break would otherwise reach the error — and every log line that serialises it. Each whitespace-
 * separated piece of the bearer is replaced, not only the whole.
 */
export const withoutBearer = (message: string, bearer: string | null): string => {
  if (bearer === null) return message;
  let text = message;
  const pieces = [bearer, ...bearer.split(/\s+/)].filter((piece) => piece.length >= 8);
  for (const piece of pieces.sort((a, b) => b.length - a.length)) {
    text = text.split(piece).join('[REDACTED:bearer]');
  }
  return text;
};

export const createCoreClient = (options: CoreClientOptions): CoreClient => {
  const fetcher: CoreFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? CORE_CALL_TIMEOUT_MS;
  const base = options.baseUrl.replace(/\/+$/, '');
  const url = (verb: string): string => `${base}${WORKER_API_PREFIX}/${verb}`;

  /** One call; answers the status and the parsed JSON body (or `null` for none). */
  const call = async (input: {
    /** @default `POST` — a `GET` sends no body. */
    readonly method?: 'GET' | 'POST' | 'PUT';
    readonly verb: string;
    readonly bearer: string | null;
    readonly body: unknown;
    readonly runScoped: boolean;
    readonly signal?: AbortSignal;
    readonly idempotencyKey?: string;
  }): Promise<{ readonly status: number; readonly body: unknown }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forward = (): void => controller.abort();
    input.signal?.addEventListener('abort', forward, { once: true });
    let response: Response;
    try {
      const method = input.method ?? 'POST';
      response = await fetcher(url(input.verb), {
        method,
        headers: {
          ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
          [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL_VERSION),
          ...(input.bearer === null ? {} : { authorization: `Bearer ${input.bearer}` }),
          ...(input.idempotencyKey === undefined
            ? {}
            : { 'idempotency-key': input.idempotencyKey }),
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify(input.body ?? {}) }),
        signal: controller.signal,
        // The request carries a credential: a redirect would hand it to wherever it points.
        redirect: 'error',
      });
    } catch (error) {
      throw new CoreCallError(
        'transient',
        null,
        null,
        `${input.verb}: the core could not be reached (${withoutBearer((error as Error).message, input.bearer)})`,
      );
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', forward);
    }
    const text = await response.text().catch(() => '');
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  };

  /** A call whose 2xx answer is parsed by `schema`; anything else is a {@link CoreCallError}. */
  const expect = async <T extends z.ZodType>(
    input: Parameters<typeof call>[0],
    schema: T,
  ): Promise<z.output<T>> => {
    const answer = await call(input);
    if (answer.status >= 200 && answer.status < 300) {
      const parsed = schema.safeParse(answer.body);
      if (!parsed.success) {
        throw new CoreCallError(
          'transient',
          answer.status,
          null,
          `${input.verb}: the core's answer does not parse (${parsed.error.issues[0]?.message ?? 'invalid'})`,
        );
      }
      return parsed.data;
    }
    throw refusal(input.verb, answer, input.runScoped);
  };

  const refusal = (
    verb: string,
    answer: { readonly status: number; readonly body: unknown },
    runScoped: boolean,
  ): CoreCallError => {
    const code = errorCodeOf(answer.body);
    const parsed = apiErrorSchema.safeParse(answer.body);
    const message = parsed.success ? parsed.data.error.message : `answered ${answer.status}`;
    return new CoreCallError(
      classify(answer.status, code, runScoped),
      answer.status,
      code,
      `${verb}: ${message}`,
      parsed.success ? (parsed.data.error.details ?? []) : [],
    );
  };

  return {
    device: () =>
      expect(
        { verb: WORKER_PATHS.device, bearer: null, body: {}, runScoped: false },
        workerDeviceResponseSchema,
      ),
    deviceToken: async (deviceCode) => {
      const answer = await call({
        verb: WORKER_PATHS.deviceToken,
        bearer: null,
        body: { device_code: deviceCode },
        runScoped: false,
      });
      if (answer.status === 200) {
        const parsed = workerDeviceTokenResponseSchema.safeParse(answer.body);
        if (!parsed.success) {
          throw new CoreCallError('transient', 200, null, 'device/token: an unreadable credential');
        }
        return {
          kind: 'credential',
          workerId: parsed.data.worker_id,
          credential: parsed.data.credential,
        };
      }
      const rfc = workerDeviceTokenErrorSchema.safeParse(answer.body);
      if (rfc.success) {
        return {
          kind: rfc.data.error === 'authorization_pending' ? 'pending' : rfc.data.error,
        };
      }
      throw refusal(WORKER_PATHS.deviceToken, answer, false);
    },
    handshake: (credential, body) =>
      expect(
        { verb: WORKER_PATHS.handshake, bearer: credential, body, runScoped: false },
        workerHandshakeResponseSchema,
      ),
    claim: async (credential, body, signal) => {
      const answer = await call({
        verb: WORKER_PATHS.claims,
        bearer: credential,
        body,
        runScoped: false,
        ...(signal === undefined ? {} : { signal }),
      });
      if (answer.status === 204) return null;
      if (answer.status === 200) {
        const parsed = runPackageSchema.safeParse(answer.body);
        if (!parsed.success) {
          // A package this build cannot read was still claimed on the core: its lease runs out and
          // the sweep re-offers it. Saying so is all the worker can do (TD-031 §4: refused, never cut).
          throw new CoreCallError(
            'refused',
            200,
            'package_unreadable',
            `claims: the run package does not parse (${parsed.error.issues[0]?.message ?? 'invalid'})`,
          );
        }
        return parsed.data;
      }
      throw refusal(WORKER_PATHS.claims, answer, false);
    },
    manualPause: (credential, body) =>
      expect(
        { verb: WORKER_PATHS.manualPause, bearer: credential, body, runScoped: false },
        workerManualPauseResponseSchema,
      ),
    pause: async (credential, body) => {
      const answer = await call({
        verb: WORKER_PATHS.pause,
        bearer: credential,
        body,
        runScoped: false,
      });
      if (answer.status !== 204) throw refusal(WORKER_PATHS.pause, answer, false);
    },
    release: async (credential) => {
      const answer = await call({
        verb: WORKER_PATHS.release,
        bearer: credential,
        body: null,
        runScoped: false,
        method: 'GET',
      });
      if (answer.status === 200) {
        const parsed = workerReleaseResponseSchema.safeParse(answer.body);
        if (!parsed.success) {
          throw new CoreCallError(
            'transient',
            200,
            null,
            "release: the core's answer does not parse",
          );
        }
        return {
          accepted: parsed.data.protocol.accepted,
          digests: parsed.data.digests,
          upgradeRequired: false,
        };
      }
      if (answer.status === 426) {
        const parsed = workerUpgradeRequiredBodySchema.safeParse(answer.body);
        if (parsed.success) {
          return {
            accepted: parsed.data.accepted,
            digests: parsed.data.digests,
            upgradeRequired: true,
          };
        }
      }
      throw refusal(WORKER_PATHS.release, answer, false);
    },
    updateReport: async (credential, body) => {
      const answer = await call({
        verb: WORKER_PATHS.updateReport,
        bearer: credential,
        body,
        runScoped: false,
      });
      if (answer.status !== 204) throw refusal(WORKER_PATHS.updateReport, answer, false);
    },
    claimScope: (credential) =>
      expect(
        {
          method: 'GET',
          verb: WORKER_PATHS.claimScope,
          bearer: credential,
          body: null,
          runScoped: false,
        },
        workerClaimScopeResponseSchema,
      ),
    setClaimScope: (credential, body) =>
      expect(
        {
          method: 'PUT',
          verb: WORKER_PATHS.claimScope,
          bearer: credential,
          body,
          runScoped: false,
        },
        workerClaimScopeSetResponseSchema,
      ),
    offers: (credential) =>
      expect(
        {
          method: 'GET',
          verb: WORKER_PATHS.offers,
          bearer: credential,
          body: null,
          runScoped: false,
        },
        workerOffersResponseSchema,
      ),
    takeOffer: async (credential, runId, body) => {
      const verb = WORKER_PATHS.offerClaim.replace(':id', runId);
      const answer = await call({ verb, bearer: credential, body, runScoped: false });
      if (answer.status === 200) {
        const parsed = runPackageSchema.safeParse(answer.body);
        if (!parsed.success) {
          throw new CoreCallError(
            'refused',
            200,
            'package_unreadable',
            `offers/claim: the run package does not parse (${parsed.error.issues[0]?.message ?? 'invalid'})`,
          );
        }
        return parsed.data;
      }
      throw refusal(WORKER_PATHS.offerClaim, answer, false);
    },
    forRun: (runId, runToken) => {
      const verb = (path: string, name?: string): string =>
        path.replace(':id', runId).replace(':name', name ?? '');
      const runCall = <T extends z.ZodType>(
        path: string,
        body: unknown,
        schema: T,
        name?: string,
      ) => expect({ verb: verb(path, name), bearer: runToken, body, runScoped: true }, schema);
      return {
        heartbeat: (body, signal) =>
          expect(
            {
              verb: verb(WORKER_PATHS.heartbeat),
              bearer: runToken,
              body,
              runScoped: true,
              ...(signal === undefined ? {} : { signal }),
            },
            workerHeartbeatResponseSchema,
          ),
        transcript: (body) =>
          runCall(WORKER_PATHS.transcript, body, workerTranscriptResponseSchema),
        tool: (name, body) => runCall(WORKER_PATHS.tool, body, workerToolCallResponseSchema, name),
        approval: (body) => runCall(WORKER_PATHS.approvals, body, workerApprovalResponseSchema),
        sshSign: (body) => runCall(WORKER_PATHS.sshSign, body, workerSshSignResponseSchema),
        spawn: (body) => runCall(WORKER_PATHS.spawn, body, workerSpawnResponseSchema),
        release: async (body) => {
          const answer = await call({
            verb: verb(WORKER_PATHS.runRelease),
            bearer: runToken,
            body,
            runScoped: true,
          });
          if (answer.status !== 204) throw refusal(WORKER_PATHS.runRelease, answer, true);
        },
        finish: (body) => runCall(WORKER_PATHS.finish, body, workerFinishResponseSchema),
        lateCost: (body) => runCall(WORKER_PATHS.lateCost, body, workerLateCostResponseSchema),
        cancel: (body, idempotencyKey) =>
          expect(
            {
              verb: verb(WORKER_PATHS.runCancel),
              bearer: runToken,
              body,
              runScoped: true,
              idempotencyKey,
            },
            workerRunCancelResponseSchema,
          ),
      };
    },
  };
};
