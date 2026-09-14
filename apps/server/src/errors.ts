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
 * - **An error class is not a status on its own.** A domain refusal means "the caller chose a
 *   transition the state machine has not" on the command surface and "this build has a bug"
 *   anywhere else, so {@link commandRefusal} translates it for the routes that issue commands and
 *   {@link toApiError} keeps answering `500 internal_error` for everyone else.
 */
import {
  CommandsUnavailableError,
  IterationLimitReachedError,
  RunNotLiveError,
  RunNotReachableError,
  StageNotCurrentError,
  StageNotInTemplateError,
  TaskConflictExhaustedError,
  UnknownAggregateError,
} from '@platform/application';
import type { ApiError } from '@platform/contracts';
import {
  IllegalTransitionError,
  InvariantViolationError,
  PermissionDeniedError,
  PolicyViolationError,
} from '@platform/domain';
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

/**
 * The refusals an **aggregate** or a command use case raises, as the answer they are to a caller
 * who chose the transition (WP-15i; narrowed at the pre-merge round).
 *
 * `routes/commands.ts` calls it around the command it issues, and nothing else does — that call is
 * the narrowing. Before it, `toApiError` recognised these nine classes for **every** route, which
 * reads well for the command surface and badly everywhere else: `PolicyViolationError` is also what
 * a malformed shipped pipeline template raises (`domain/pipeline/templates.ts`) and what a budget
 * policy raises, and mapping those globally would answer `409 policy_violation` and log the
 * platform's own bug at `info` as a refusal the caller earned. So `toApiError` still ends at
 * `500 internal_error`, `unexpected: true`, for every one of them, and a route that means "the
 * caller chose this transition" says so by translating first.
 *
 * The mapping itself stays here rather than in the route module, because this file is where a
 * status code is chosen (see the module note).
 *
 * `409` for the state-machine four: the request is well-formed and the resource's current state is
 * what conflicts with it. `PolicyViolationError` is in the list because a command compiles the
 * task's template (`compilePipeline`) and a project's budget policy is a policy too — inside a
 * command those are "your project's configuration refuses this", which a person can act on; on a
 * route that reads, the same class is a malformed **shipped** template, which they cannot. The `code` names the *kind* of refusal and the message names the
 * transition or the invariant, which is what a client branches on rather than parsing prose. The
 * three that are not state-machine edges each name their own code, because they are three different
 * things to tell a person: you asked about a stage the task has left, the loop you are spending is
 * spent, and that run is not in a status this command can act on. `UnknownAggregateError` is the
 * 404 of the same family — a command for a question or a run that does not exist.
 *
 * `CommandsUnavailableError` is `503` and not `500`: the request is fine and *this instance* cannot
 * serve it, the same answer `routes/kb.ts` and `routes/onboarding.ts` give for a collaborator their
 * process did not compose.
 *
 * `TaskConflictExhaustedError` is `409` (WP-15e, WP-15i): the pipeline's own jobs answer a spent
 * write-conflict bound by escalating the task, because a job has nobody to tell. An HTTP request
 * does — the caller is a person who can press the button again, and escalating from a request would
 * park a task in `needs_human` for a race the human never saw.
 */
export const commandRefusal = (error: unknown): HttpError | null => {
  if (error instanceof IllegalTransitionError) {
    return new HttpError(409, 'illegal_transition', error.message);
  }
  if (error instanceof InvariantViolationError) {
    return new HttpError(409, 'invariant_violation', error.message);
  }
  if (error instanceof PolicyViolationError) {
    return new HttpError(409, 'policy_violation', error.message);
  }
  if (error instanceof StageNotCurrentError) {
    return new HttpError(409, 'stage_not_current', error.message);
  }
  if (error instanceof IterationLimitReachedError) {
    return new HttpError(409, 'iteration_limit_reached', error.message);
  }
  if (error instanceof RunNotLiveError) {
    return new HttpError(409, 'run_not_live', error.message);
  }
  if (error instanceof RunNotReachableError) {
    // A **different** code from `run_not_live`, because the two have different remedies: one says
    // the run has ended, the other says the session is somewhere this process cannot reach (WP-27).
    return new HttpError(409, 'run_not_reachable', error.message);
  }
  if (error instanceof StageNotInTemplateError) {
    return new HttpError(409, 'stage_not_in_template', error.message);
  }
  if (error instanceof TaskConflictExhaustedError) {
    return new HttpError(409, 'task_conflict', error.message);
  }
  if (error instanceof UnknownAggregateError) {
    return new HttpError(404, 'not_found', error.message);
  }
  if (error instanceof CommandsUnavailableError) {
    return new HttpError(503, 'commands_unavailable', error.message);
  }
  return null;
};

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
