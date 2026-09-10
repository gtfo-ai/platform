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

/** Thrown when the network never produced a response at all. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('the server could not be reached');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export interface ApiClientOptions {
  /** Injected so the whole client is testable without a server and without patching globals. */
  readonly fetchImpl?: typeof fetch;
  /** Empty in the browser: the SPA is served from the API's own origin (technical/08). */
  readonly baseUrl?: string;
  /** Injected for the same reason as `fetchImpl`; used for `Idempotency-Key`. */
  readonly newIdempotencyKey?: () => string;
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

    command: (path, options_) =>
      send(
        path,
        {
          method: options_.method ?? 'POST',
          credentials: 'same-origin',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            [CSRF_HEADER]: CSRF_HEADER_VALUE,
            ...(options_.idempotent === true
              ? { 'Idempotency-Key': newIdempotencyKey() }
              : undefined),
          },
          body: JSON.stringify(options_.body ?? {}),
          ...(options_.signal === undefined ? {} : { signal: options_.signal }),
        },
        options_,
      ),
  };
};
