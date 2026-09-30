/**
 * Dead letters — the list and the re-queue an operator had no way to reach (WP-95, PROGRESS
 * backlog 126).
 *
 *   GET  /api/org/dead-letters
 *   POST /api/org/dead-letters/:position/requeue
 *
 * WP-49 gave a poisoned event an ending — after `APP_DISPATCH_MAX_ATTEMPTS` failures its queue row
 * is marked `dead_lettered_at`, its stream moves on, and the task it names is escalated — and left
 * an operator a gauge that said *how many* and a hand-typed `update` to serve one again. An event
 * that names no task had no brief anywhere: the first two questions, *which event* and *which
 * handler*, had no answer short of a psql session. These two routes are those answers.
 *
 * ## Who may, and what a caller is shown
 *
 * Both are `org.dead_letters.manage` (**admin**), the shape `org.users.manage` gives the identity
 * pair: the list crosses every project, and the re-queue serves an event again to handlers that
 * write. `error` is a handler's message and may quote a provider, a URL or a credential — the
 * reason WP-49 kept it off the task brief does not stop applying because the reader is an admin —
 * so it is **redacted by the platform's patterns and then bounded** (TD-012; redact-then-slice for
 * `routes/settings.ts`'s measured reason), and the SPA renders it as text (BD-022). The event's
 * payload is not published at all: nothing an operator decides here needs it, and it is the one
 * field that is wholly somebody else's text.
 *
 * ## The re-queue is a command on the queue row
 *
 * The row is the aggregate and its one legal transition is `dead_lettered → pending`
 * (`packages/application/src/ports/dead-letters.ts`). Every other state is refused by name: a row
 * that is queued and not dead-lettered is `409 event_not_dead_lettered`, an event whose dispatch
 * already completed is `409 event_already_dispatched`, and a position with no event is `404`. The
 * command follows `routes/commands.ts`'s rules: the `Idempotency-Key` is **claimed before** the
 * command performs (`routes/idempotency.ts`), a refusal releases it, and **exactly one**
 * `human_actions` row is written per accepted re-queue and none for a refused one. The row's
 * `task_id` is the task the dead letter escalated when there is one — which makes the re-queue
 * visible in that task's own audit read — and its `params` name the position, the event type, the
 * handler and the attempts, never the error text.
 *
 * What a re-queue does to the queue and to the log, and why re-dispatching cannot double an effect,
 * is `packages/application/src/events/requeue.ts`.
 */
import {
  type DeadLetterCommands,
  DeadLetterRequeueRefusedError,
  type DeadLetterRow,
  type SecretRedactor,
} from '@platform/application';
import {
  apiErrorSchema,
  type DeadLetter,
  deadLetterParamsSchema,
  deadLettersResponseSchema,
  type IsoDateTime,
  MAX_DEAD_LETTER_ERROR_CHARS,
  MAX_DEAD_LETTERS_PAGE,
  paginationQuerySchema,
  requeueDeadLetterResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type * as z from 'zod';
import { type PermissionGuardDependencies, requirePermission } from '../auth/rbac.js';
import { BadRequestError, HttpError, NotFoundError } from '../errors.js';
import type { HumanActionInput } from '../queries/onboarding-queries.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  readIdempotencyKey,
} from './idempotency.js';

/** The page a screen asks for when it names none. */
export const DEFAULT_DEAD_LETTERS_PAGE = 50;

/** The action every re-queue's audit row and idempotency record carry. */
export const REQUEUE_ACTION = 'org.dead_letter.requeue';

export interface DeadLetterRoutesOptions {
  /** `null` on a process that composed no eventing; both routes then answer 503 by name. */
  readonly commands: DeadLetterCommands | null;
  readonly records: IdempotencyRecords & {
    readonly recordAction: (input: HumanActionInput) => Promise<void>;
  };
  /** Unused by an org-scoped guard, and required by its type: no project is named here. */
  readonly projectRole: PermissionGuardDependencies['projectRole'];
  /** TD-012's pattern rules — an HTTP request carries no run-scoped credential (Q55). */
  readonly redactor: SecretRedactor;
}

/**
 * The cursor is the last position of the previous page, as the decimal string this route handed
 * out. `paginationQuerySchema` types it as an opaque non-empty string, so anything else is a client
 * error rather than a `NaN` in a query.
 */
export const parseDeadLetterCursor = (cursor: string): number => {
  if (!/^[1-9][0-9]{0,18}$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) {
    throw new BadRequestError(
      'invalid_cursor',
      'cursor must be the `next_cursor` this endpoint returned',
    );
  }
  return Number(cursor);
};

/** One row on the wire: the error redacted, **then** bounded, and the cut stated. */
export const toWireDeadLetter = (row: DeadLetterRow, redactor: SecretRedactor): DeadLetter => {
  const redacted = row.error === null ? null : redactor.redactText(row.error).value;
  return {
    position: row.position,
    event_type: row.eventType,
    stream_type: row.streamType,
    stream_id: row.streamId,
    occurred_at: row.occurredAt as IsoDateTime,
    dead_lettered_at: row.deadLetteredAt as IsoDateTime,
    handler: row.handler,
    attempts: row.attempts,
    error: redacted === null ? null : redacted.slice(0, MAX_DEAD_LETTER_ERROR_CHARS),
    error_truncated: redacted !== null && redacted.length > MAX_DEAD_LETTER_ERROR_CHARS,
    task:
      row.task === null
        ? null
        : { id: row.task.id, ticket_key: row.task.ticketKey, project_key: row.task.projectKey },
  };
};

const refusalToHttp = (error: DeadLetterRequeueRefusedError): HttpError => {
  switch (error.refusal) {
    case 'not_dead_lettered':
      return new HttpError(409, 'event_not_dead_lettered', error.message);
    case 'already_dispatched':
      return new HttpError(409, 'event_already_dispatched', error.message);
    case 'unknown_event':
      return new NotFoundError(`event ${error.position}`);
  }
};

export const registerDeadLetterRoutes = async (
  app: FastifyInstance,
  options: DeadLetterRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.projectRole };

  const commands = (): DeadLetterCommands => {
    if (options.commands === null) {
      throw new HttpError(
        503,
        'dead_letters_unavailable',
        'this process composed no event dispatch, so it cannot read or re-queue dead letters',
      );
    }
    return options.commands;
  };

  const actorOf = (request: FastifyRequest): { readonly userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`; kept because the audit row's user is not optional.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  typed.get(
    '/api/org/dead-letters',
    {
      preValidation: requirePermission(guard, 'org.dead_letters.manage'),
      schema: {
        summary: 'Events whose dispatch spent its attempt bound, newest first',
        description:
          'The rows of `event_dispatch` carrying `dead_lettered_at` (WP-49), joined to their events: the position, the event type, the stream, the handler whose failure spent the bound, the attempts, and the last error — **redacted by the platform’s patterns and bounded**, with `error_truncated` saying whether the bound cut it. `task` is the task the dead-letter sink escalated, when the event names one that exists; `null` for an event that names none. `total` is every dead letter, not the page. `next_cursor` is **opaque**: send it back unchanged. The event payload is not published. Admin only (WP-95, PROGRESS backlog 126).',
        tags: ['org'],
        querystring: paginationQuerySchema,
        response: { 200: deadLettersResponseSchema, 400: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request) => {
      const limit = Math.min(
        request.query.limit ?? DEFAULT_DEAD_LETTERS_PAGE,
        MAX_DEAD_LETTERS_PAGE,
      );
      const page = await commands().list({
        limit: limit + 1,
        ...(request.query.cursor === undefined
          ? {}
          : { beforePosition: parseDeadLetterCursor(request.query.cursor) }),
      });
      const items = page.items.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((row) => toWireDeadLetter(row, options.redactor)),
        total: page.total,
        next_cursor: page.items.length > limit && last !== undefined ? String(last.position) : null,
      };
    },
  );

  typed.post(
    '/api/org/dead-letters/:position/requeue',
    {
      preValidation: requirePermission(guard, 'org.dead_letters.manage'),
      schema: {
        summary: 'Put one dead-lettered event back in the dispatch queue',
        description:
          'Clears `dead_lettered_at` and `attempts` on the event’s queue row under its row lock (of two concurrent re-queues, one succeeds), and wakes a dispatcher. The event itself is **not** copied and nothing is appended: the same row of the append-only log is dispatched again, and every handler that already succeeded for it is skipped (`handler_executions`), so an effect it committed is not repeated. Refused `409 event_not_dead_lettered` for a row that is queued and not dead-lettered, `409 event_already_dispatched` when the dispatch already completed, `404` for a position with no event. One `human_actions` row per accepted request, none for a refused one; `Idempotency-Key` optional and honoured — a replay performs nothing and answers `performed: false`. The task the dead letter escalated stays where it is. Admin only (WP-95, PROGRESS backlog 126).',
        tags: ['org'],
        params: deadLetterParamsSchema,
        response: {
          200: requeueDeadLetterResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request): Promise<z.output<typeof requeueDeadLetterResponseSchema>> => {
      const position = request.params.position;
      const handle = commands();
      const actor = actorOf(request);
      const key = readIdempotencyKey(request);
      const claim = await claimIdempotentAttempt(options.records, {
        userId: actor.userId,
        action: REQUEUE_ACTION,
        key,
        request: { position },
      });
      if (claim.replayed) {
        const requeuedAt = claim.previous?.requeued_at;
        if (typeof requeuedAt !== 'string') {
          // A completed key whose audit row went with its task answers nothing recorded, and a
          // route that needs a field refuses rather than invents one (`findCommandAttempt`).
          throw new HttpError(
            409,
            'idempotency_attempt_unknown',
            `the ${REQUEUE_ACTION} under Idempotency-Key "${key ?? ''}" was performed, and its audit row no longer says when; check the dead-letter list`,
          );
        }
        return { position, performed: false, requeued_at: requeuedAt as IsoDateTime };
      }
      return claim.run(async (performed) => {
        let requeued: Awaited<ReturnType<DeadLetterCommands['requeue']>>;
        try {
          requeued = await handle.requeue(position);
        } catch (error) {
          throw error instanceof DeadLetterRequeueRefusedError ? refusalToHttp(error) : error;
        }
        performed();
        const { row } = requeued;
        await options.records.recordAction({
          userId: actor.userId,
          action: REQUEUE_ACTION,
          taskId: row.task?.id ?? null,
          params: {
            position: row.position,
            event_type: row.eventType,
            stream_type: row.streamType,
            stream_id: row.streamId,
            handler: row.handler,
            attempts: row.attempts,
            dead_lettered_at: row.deadLetteredAt,
            requeued_at: requeued.requeuedAt,
            ...(key === null ? {} : { idempotency_key: key }),
            ...(claim.digest === null ? {} : { body_digest: claim.digest }),
          },
        });
        return {
          position,
          performed: true,
          requeued_at: requeued.requeuedAt as IsoDateTime,
        };
      });
    },
  );
};
