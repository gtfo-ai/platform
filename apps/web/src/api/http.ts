/**
 * The typed HTTP client for technical/08's REST surface.
 *
 * Three rules decide everything in this file.
 *
 * **The server is a boundary, so its answers are parsed, not cast.** Every response goes through
 * the zod schema `@platform/contracts` already publishes for it; a body that does not match is an
 * `ApiError` with code `invalid_response` rather than a value that flows into a component and
 * renders `undefined`. That is the same rule the server applies to its own inputs, pointed the
 * other way, and it is what stops a schema change from becoming a silent blank screen.
 *
 * **A mutation carries TD-022's CSRF evidence.** Same-origin credentials, `Origin` supplied by the
 * browser, and the `X-Requested-With: XMLHttpRequest` header the server's `csrfViolation()`
 * requires — a header a cross-site form post or image load cannot set. `POST`s that create take an
 * `Idempotency-Key` so a retry is not a second task (technical/08 § Principles).
 *
 * **An error body is data, not markup.** The message a caller gets is a string that goes into a
 * React text node; nothing in this app turns a server string into HTML. See `ui/untrusted.tsx`.
 */
import { apiErrorSchema } from '@platform/contracts';
import type * as z from 'zod';

/** Anything this client can fail with. Typed, never a bare `Error` (CLAUDE.md). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: readonly { readonly path: string; readonly message: string }[];

  constructor(
    status: number,
    code: string,
    message: string,
    details: readonly { readonly path: string; readonly message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * What the person is told when an answer failed its schema **because the server was upgraded**
 * under an open tab (WP-154 (d), PROGRESS backlog 487) — a platform sentence, and the whole fix.
 */
export const PLATFORM_UPDATED_MESSAGE = 'the platform was updated — reload this page';

/**
 * An `invalid_response` from a server that is **a different build** from this bundle (WP-154 (d)):
 * the old bundle's strict schemas refusing the new server's fields, not a contract defect. Thrown
 * in place of the schema error only after `/api/version` said so (`app/platform-version.ts`); when
 * the two builds are the same, or either is `dev`, the schema error stands.
 */
export class PlatformUpdatedError extends ApiError {
  constructor(status: number) {
    super(status, 'platform_updated', PLATFORM_UPDATED_MESSAGE);
    this.name = 'PlatformUpdatedError';
  }
}

/** Thrown when the network never produced a response at all. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('the server could not be reached');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * **WP-67's two in-flight refusals, answered here** (WP-73, PROGRESS backlog 242) — the one path
 * every keyed command goes through, so no screen needs its own handling.
 *
 * - `409 idempotency_key_in_flight`: the same intent's first request is still being performed (a
 *   double click on a button that does not disable itself, a retry that overtook a slow answer).
 *   The server's own instruction is *"send the same request again once it has answered"*, so the
 *   client does exactly that — the same body under the same key, every
 *   {@link IN_FLIGHT_RETRY_DELAY_MS}, at most {@link IN_FLIGHT_RETRY_LIMIT} times — and the caller
 *   sees a request that is still pending, then the first attempt's answer (a replay), which is what
 *   refreshes its queries. Only past the bound does it become an error.
 * - `409 idempotency_attempt_unknown`: a process died mid-command and nobody can say whether it
 *   performed. The key is **retired** — {@link isRetiredIdempotencyKey}, which `app/idempotency.ts`
 *   asks before reusing a held key — so the next send of that intent is a new request, and the
 *   message tells the person to look at the task first.
 */
export const IN_FLIGHT_RETRY_DELAY_MS = 1_000;
export const IN_FLIGHT_RETRY_LIMIT = 10;

/** How many retired keys are remembered; a key is a random id, so the bound is memory only. */
const RETIRED_KEYS_MAX = 256;
const retiredKeys = new Set<string>();

const retireKey = (key: string): void => {
  if (retiredKeys.size >= RETIRED_KEYS_MAX) {
    const oldest = retiredKeys.values().next();
    if (!oldest.done) {
      retiredKeys.delete(oldest.value);
    }
  }
  retiredKeys.add(key);
};

/** Whether a `409 idempotency_attempt_unknown` retired this key (WP-73, backlog 242). */
export const isRetiredIdempotencyKey = (key: string): boolean => retiredKeys.has(key);

/** What the person is told after `idempotency_attempt_unknown` — a platform sentence. */
export const ATTEMPT_UNKNOWN_MESSAGE =
  'The platform cannot tell whether this was done: a server stopped while performing it. Check the task before sending it again — sending it again is a new request.';

export interface ApiClientOptions {
  /** Injected so the whole client is testable without a server and without patching globals. */
  readonly fetchImpl?: typeof fetch;
  /** The wait between two sends of an in-flight command; injected so a test does not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Empty in the browser: the SPA is served from the API's own origin (technical/08). */
  readonly baseUrl?: string;
  /** Injected for the same reason as `fetchImpl`; used for `Idempotency-Key`. */
  readonly newIdempotencyKey?: () => string;
  /**
   * Asked before an `invalid_response` is thrown (WP-154 (d)): `true` when the server is a
   * different build from this bundle, and the client then throws {@link PlatformUpdatedError}
   * instead. Never asked about `/api/version` itself, which is what it reads.
   */
  readonly isPlatformUpdated?: () => Promise<boolean>;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions<TSchema extends z.ZodType> {
  readonly schema: TSchema;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
}

export interface CommandOptions<TSchema extends z.ZodType> extends RequestOptions<TSchema> {
  readonly body?: unknown;
  readonly method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** technical/08: POSTs that create are idempotent under a client-supplied key. */
  readonly idempotent?: boolean;
  /**
   * The key to send, when the caller owns one — PROGRESS backlog **53**.
   *
   * `idempotent: true` alone mints a **fresh** key per request, which is the defect that entry
   * records: the header's stated purpose is *"a retry is not a second task"*, and a double-clicked
   * form sent two first requests under two keys, so the server — which does answer a replay — was
   * never given one to answer. A key belongs to the user's *intent*, and only the call site that
   * owns the intent knows when one ends, so it is passed in from there (`app/idempotency.ts`).
   * Supplying this implies `idempotent`.
   */
  readonly idempotencyKey?: string;
}

export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_HEADER_VALUE = 'XMLHttpRequest';

const buildUrl = (
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const suffix = search.size === 0 ? '' : `?${search.toString()}`;
  return `${baseUrl}${path}${suffix}`;
};

/**
 * Turns a non-2xx response into an `ApiError`.
 *
 * The server's documented problem shape is `{ error: { code, message, details? } }`. A body that
 * is *not* that shape — a proxy's HTML error page, a gateway timeout — must not be shown to the
 * user as if it were a message from the platform, so it is replaced by the status line. The raw
 * body is deliberately dropped rather than embedded: it is attacker-influenceable text of unknown
 * length and unknown origin.
 */
const toApiError = async (response: Response): Promise<ApiError> => {
  const body: unknown = await response.json().catch(() => null);
  const parsed = apiErrorSchema.safeParse(body);
  if (!parsed.success) {
    return new ApiError(
      response.status,
      'unexpected_response',
      `the server answered ${response.status} without a problem document`,
    );
  }
  return new ApiError(
    response.status,
    parsed.data.error.code,
    parsed.data.error.message,
    parsed.data.error.details ?? [],
  );
};

export interface ApiClient {
  get<TSchema extends z.ZodType>(
    path: string,
    options: RequestOptions<TSchema>,
  ): Promise<z.output<TSchema>>;
  command<TSchema extends z.ZodType>(
    path: string,
    options: CommandOptions<TSchema>,
  ): Promise<z.output<TSchema>>;
}

export const createApiClient = (options: ApiClientOptions = {}): ApiClient => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl ?? '';
  const newIdempotencyKey = options.newIdempotencyKey ?? (() => crypto.randomUUID());
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));

  const send = async <TSchema extends z.ZodType>(
    path: string,
    init: RequestInit,
    options_: RequestOptions<TSchema>,
  ): Promise<z.output<TSchema>> => {
    let response: Response;
    try {
      response = await fetchImpl(buildUrl(baseUrl, path, options_.query), init);
    } catch (error) {
      // An aborted request is the caller's own decision (a route change, a React unmount) and must
      // stay an `AbortError` so TanStack Query can tell it apart from a failure worth retrying.
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      throw new NetworkError(error);
    }
    if (!response.ok) {
      throw await toApiError(response);
    }
    const body: unknown = await response.json().catch(() => null);
    const parsed = options_.schema.safeParse(body);
    if (!parsed.success) {
      if (
        path !== '/api/version' &&
        options.isPlatformUpdated !== undefined &&
        (await options.isPlatformUpdated())
      ) {
        throw new PlatformUpdatedError(response.status);
      }
      throw new ApiError(
        response.status,
        'invalid_response',
        `the server's answer to ${path} did not match the published schema`,
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  };

  return {
    get: (path, options_) =>
      send(
        path,
        {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
          ...(options_.signal === undefined ? {} : { signal: options_.signal }),
        },
        options_,
      ),

    command: async (path, options_) => {
      // The caller's key wins: it is the one that survives a retry of the same intent.
      const key =
        options_.idempotencyKey ?? (options_.idempotent === true ? newIdempotencyKey() : null);
      const init: RequestInit = {
        method: options_.method ?? 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [CSRF_HEADER]: CSRF_HEADER_VALUE,
          ...(key === null ? undefined : { 'Idempotency-Key': key }),
        },
        body: JSON.stringify(options_.body ?? {}),
        ...(options_.signal === undefined ? {} : { signal: options_.signal }),
      };
      for (let sent = 1; ; sent += 1) {
        try {
          return await send(path, init, options_);
        } catch (error) {
          if (key === null || !(error instanceof ApiError)) {
            throw error;
          }
          if (error.code === 'idempotency_key_in_flight' && sent < IN_FLIGHT_RETRY_LIMIT) {
            // A caller that gave up (a route change, an unmount) stops the retries here, as an
            // abort — the same error the fetch itself raises — rather than a second later.
            if (options_.signal?.aborted === true) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            await sleep(IN_FLIGHT_RETRY_DELAY_MS);
            continue;
          }
          if (error.code === 'idempotency_attempt_unknown') {
            retireKey(key);
            throw new ApiError(error.status, error.code, ATTEMPT_UNKNOWN_MESSAGE, error.details);
          }
          throw error;
        }
      }
    },
  };
};
