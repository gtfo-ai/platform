/**
 * The HTTP error types and the single mapping onto `apiErrorSchema` (technical/08).
 *
 * Every non-2xx response in the platform has the same body — `{ error: { code, message, details? } }`
 * with a `lower_snake_case` machine-readable `code` — because a client that has to parse prose to
 * tell "you may not do that" from "that does not exist" ends up branching on English.
 *
 * Two rules the mapper holds to:
 *
 * - **A 5xx never carries its cause.** An unexpected error's message can hold a connection string,
 *   a row, or a stack path; it goes to the log with the request id, and the client gets the id
 *   plus `internal_error`. A 4xx does carry its message, because the client caused it and needs to
 *   know what to fix.
 * - **Validation failures are field-level.** `fastify-type-provider-zod` raises the zod issue list,
 *   which maps straight onto `details[]` — the shape `apiErrorSchema` already publishes.
 */
import type { ApiError } from '@platform/contracts';
import { PermissionDeniedError } from '@platform/domain';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: ApiError['error']['details'];

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: ApiError['error']['details'],
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'authentication required') {
    super(401, 'unauthenticated', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends HttpError {
  constructor(action: string, role: string) {
    super(403, 'forbidden', `role ${role} may not perform ${action}`);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends HttpError {
  constructor(what: string) {
    super(404, 'not_found', `${what} does not exist`);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends HttpError {
  constructor(code: string, message: string, details?: ApiError['error']['details']) {
    super(400, code, message, details);
    this.name = 'BadRequestError';
  }
}

export class TooManyRequestsError extends HttpError {
  constructor(message: string) {
    super(429, 'too_many_requests', message);
    this.name = 'TooManyRequestsError';
  }
}

export interface MappedError {
  readonly statusCode: number;
  readonly body: ApiError;
  /** True when the cause must be logged at `error` rather than `info`. */
  readonly unexpected: boolean;
}

/** Maps any thrown value onto the wire shape. The only place a status code is chosen. */
export const toApiError = (error: unknown, requestId: string): MappedError => {
  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      statusCode: 400,
      unexpected: false,
      body: {
        error: {
          code: 'invalid_request',
          message: 'the request did not match the endpoint schema',
          details: error.validation.map((issue) => ({
            path: issue.instancePath,
            message: issue.message ?? 'invalid',
          })),
        },
      },
    };
  }

  if (error instanceof HttpError) {
    return {
      statusCode: error.statusCode,
      unexpected: false,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    };
  }

  // The domain raises this from `assertCan`; it means the same thing as ForbiddenError and must
  // not escape as a 500 just because it was thrown deeper than the guard.
  if (error instanceof PermissionDeniedError) {
    return {
      statusCode: 403,
      unexpected: false,
      body: { error: { code: 'forbidden', message: error.message } },
    };
  }

  const fastifyStatus = (error as { statusCode?: unknown })?.statusCode;
  if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
    return {
      statusCode: fastifyStatus,
      unexpected: false,
      body: {
        error: {
          code:
            String((error as { code?: unknown }).code ?? 'bad_request')
              .toLowerCase()
              .replaceAll(/[^a-z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '') || 'bad_request',
          message: (error as Error).message ?? 'bad request',
        },
      },
    };
  }

  return {
    statusCode: 500,
    unexpected: true,
    body: {
      error: {
        code: 'internal_error',
        // Deliberately not the cause: see the module note.
        message: `the request failed; quote request id ${requestId} when reporting it`,
      },
    },
  };
};
