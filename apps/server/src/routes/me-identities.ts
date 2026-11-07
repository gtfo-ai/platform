/**
 * **Your accounts** — a person links their own tracker or git account, proven by the provider and
 * confirmed by them (S-26.6, TD-031's 2026-11-06 amendment item 9, product/04's M26 UX spec § 5).
 *
 * | Route | What it does |
 * |---|---|
 * | `POST /api/me/identity-links` | issues a code (`agentic-link-` + 10 Crockford base32, 30 min), answered once |
 * | `GET /api/me/identity-links` | the newest code's state — never the code — and its matches |
 * | `POST /api/me/identity-links/read` | *I wrote it on …*: reads a task's ticket or merge request through the binding |
 * | `POST /api/me/identity-links/matches/:match_id/confirm` | the confirmation — the only self-service writer of `user_identities` |
 * | `GET /api/me/identities` | the caller's own linked accounts |
 * | `DELETE /api/me/identities/:provider/:external_id` | the caller unlinks one of their own |
 *
 * (The admin's unlink is `DELETE /api/org/identities/:provider/:external_id`, beside the admin
 * mapping in `org.ts`.)
 *
 * ## Why a link needs all of this
 *
 * A linked identity answers questions and approves plans from the tracker (BD-006, BD-022, Q10). So
 * the account is never typed and never matched by email: it is the **authenticated author** of a
 * comment carrying the person's code, read from a verified delivery or through the binding, and
 * even then it is only a **match** until the person confirms *that* account with their session and
 * an `Idempotency-Key`. A code posted where others can read it is copyable — by a JSM customer, a
 * guest, any member, the platform's own account — and every one of them must fail; the recorder's
 * refusals are in `packages/application/src/identity/identity-links.ts`.
 *
 * ## RBAC
 *
 * `identity.link` (viewer — any active user): a person links their own account. The thread read is
 * refused `403 identity_link_read_not_permitted` unless the caller's **effective** role in the named
 * project is `member` or above (TD-031 item 9 (d)), and it names only a thread a task of that
 * project already holds (`404 link_thread_not_found` otherwise), so the platform's credential reads
 * no thread on a person's say-so.
 *
 * Every write leaves one `human_actions` row and a refusal leaves none: `identity.link_code.issue`
 * (no code in it), `identity.link`, `identity.unlink`.
 */
import type {
  LinkCodeIssue,
  LinkCodeState,
  LinkConfirmation,
  LinkThreadOutcome,
  LinkThreadTarget,
} from '@platform/application';
import {
  apiErrorSchema,
  type IdentityLinkState,
  type IsoDateTime,
  identityAccountParamsSchema,
  identityLinkCodeIssuedSchema,
  identityLinkConfirmedSchema,
  identityLinkStateSchema,
  identityLinkThreadRequestSchema,
  identityLinkThreadResponseSchema,
  identityUnlinkedSchema,
  idSchema,
  type JsonObject,
  myIdentityListSchema,
  type UserRole,
} from '@platform/contracts';
import { ROLE_LEVELS } from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { effectiveRole, requirePermission } from '../auth/rbac.js';
import { HttpError } from '../errors.js';
import type { MyIdentityRow } from '../queries/identity-link-queries.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  requireIdempotencyKey,
} from './idempotency.js';

/** What the commands of this file are, bound by the composition root (`identity-links.ts`). */
export interface IdentityLinkCommands {
  readonly issue: (userId: string) => Promise<LinkCodeIssue>;
  readonly confirm: (userId: string, matchId: string) => Promise<LinkConfirmation>;
  readonly state: (userId: string) => Promise<LinkCodeState>;
  /**
   * Reads the thread and records its matches; `unavailable` when the provider or the binding could
   * not be read (the reason in the platform's words, redacted by the adapter).
   */
  readonly readThread: (
    projectId: string,
    target: LinkThreadTarget,
  ) => Promise<LinkThreadOutcome | { readonly kind: 'unavailable'; readonly reason: string }>;
}

/** Everything these routes read or write outside the application ring, as plain functions. */
export interface MeIdentityQueries extends IdempotencyRecords {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly listMine: (userId: string) => Promise<readonly MyIdentityRow[]>;
  readonly unlinkMine: (input: {
    readonly userId: string;
    readonly provider: string;
    readonly externalId: string;
  }) => Promise<boolean>;
  readonly threadOf: (
    projectId: string,
    target: { readonly ticketKey: string } | { readonly mergeRequestIid: number },
  ) => Promise<LinkThreadTarget | null>;
  readonly recordAction: (input: {
    readonly userId: string;
    readonly action: string;
    readonly params: JsonObject;
    readonly taskId?: string | null;
  }) => Promise<void>;
}

export interface MeIdentityRoutesOptions {
  readonly queries: MeIdentityQueries;
  /** `null` on a process that composed none: every route answers `503` by name, behind its guard. */
  readonly commands: IdentityLinkCommands | null;
  /** The clock a code's status is read against; the wall clock when absent. */
  readonly now?: () => Date;
}

const matchParamsSchema = z.strictObject({ match_id: idSchema });

/** The newest code's state on the wire — the code itself is never in it. */
export const toWireLinkState = (state: LinkCodeState, now: Date): IdentityLinkState => {
  const code = state.code;
  return {
    code:
      code === null
        ? null
        : {
            id: code.id,
            created_at: code.createdAt,
            expires_at: code.expiresAt,
            status:
              code.consumedAt !== null
                ? 'consumed'
                : code.voidedAt !== null
                  ? 'voided'
                  : Date.parse(code.expiresAt) <= now.getTime()
                    ? 'expired'
                    : 'live',
            void_reason: code.voidReason,
          },
    matches: state.matches.map((match) => ({
      id: match.id,
      provider: match.provider,
      external_id: match.externalId,
      display_name: match.displayName,
      integration_id: match.integrationId,
      integration_name: match.integrationName,
      matched_at: match.createdAt,
      confirmed_at: match.confirmedAt,
    })),
  };
};

/** A confirmation's refusal as the answer it is to the person. */
const confirmRefusal = (outcome: Extract<LinkConfirmation, { kind: 'refused' }>): HttpError => {
  switch (outcome.reason) {
    case 'match_not_found':
      return new HttpError(404, 'link_match_not_found', 'no match of your link code has this id');
    case 'code_expired':
      return new HttpError(
        409,
        'link_code_expired',
        'the link code this match used has expired; issue a new code and comment again',
      );
    case 'code_used':
      return new HttpError(
        409,
        'link_code_used',
        'the link code this match used already linked an account',
      );
    case 'code_voided':
      return new HttpError(
        409,
        'link_code_voided',
        outcome.voidReason === 'second_author'
          ? 'someone else used this link code, so it links nobody; issue a new code'
          : outcome.voidReason === 'identity_linked_elsewhere'
            ? 'the account that used this link code is linked to another person; ask an admin'
            : 'this link code was replaced by a newer one',
        [{ path: 'void_reason', message: outcome.voidReason ?? 'unknown' }],
      );
    case 'identity_linked_elsewhere':
      return new HttpError(
        409,
        'identity_linked_elsewhere',
        'this account is linked to another person; ask an admin',
      );
    case 'identity_is_machine':
      return new HttpError(
        409,
        'identity_is_machine',
        'an admin declared this account a machine, so it links nobody',
      );
    case 'identity_is_binding_account':
      return new HttpError(
        409,
        'identity_is_binding_account',
        'this is the account an integration acts as, so it links nobody; an admin maps it if it is yours',
      );
  }
};

export const registerMeIdentityRoutes = async (
  app: FastifyInstance,
  options: MeIdentityRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { queries } = options;
  const guard = { projectRole: queries.projectRole };
  const now = options.now ?? (() => new Date());

  const actorOf = (request: FastifyRequest) => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`; the audit row's user id is not optional.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return actor;
  };
  const commandsOf = (): IdentityLinkCommands => {
    if (options.commands === null) {
      throw new HttpError(
        503,
        'identity_links_unavailable',
        'this process composed no account linking; ask an operator',
      );
    }
    return options.commands;
  };

  typed.post(
    '/api/me/identity-links',
    {
      preValidation: requirePermission(guard, 'identity.link'),
      schema: {
        summary: 'Issue a one-time code that links your own tracker or git account',
        description:
          'Answers `agentic-link-` and ten Crockford base32 characters (50 bits from a CSPRNG), valid 30 minutes, **once**: only its SHA-256 is stored, so no later read answers it. Write it as a comment from your own account on a ticket (Jira) or a merge request (GitLab) of a project you are in; the platform reads the comment’s authenticated author and offers that account for your confirmation. Issuing a code voids your previous one. At most five per hour (`429 link_code_rate_limited` with `Retry-After`). `Cache-Control: no-store`. Any signed-in user (`identity.link`, S-26.6).',
        tags: ['identity'],
        response: { 201: identityLinkCodeIssuedSchema, 429: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const issued = await commandsOf().issue(actor.userId);
      if (issued.kind === 'rate_limited') {
        reply.header('retry-after', String(Math.ceil(issued.retryAfterMs / 1000)));
        throw new HttpError(
          429,
          'link_code_rate_limited',
          'you have issued five link codes in the last hour; use the newest one or wait',
        );
      }
      await queries.recordAction({
        userId: actor.userId,
        action: 'identity.link_code.issue',
        // The code's id and expiry, never the code: an audit row is read by more people than a code.
        params: { code_id: issued.id, expires_at: issued.expiresAt },
      });
      reply.header('cache-control', 'no-store');
      reply.code(201);
      return { id: issued.id, code: issued.code, expires_at: issued.expiresAt };
    },
  );

  typed.get(
    '/api/me/identity-links',
    {
      preHandler: requirePermission(guard, 'identity.link'),
      schema: {
        summary: 'Your newest link code and the accounts that used it',
        description:
          'The code’s status (`live`, `expired`, `voided`, `consumed`) and its matches — each a provider account whose comment carried the code: **a proposal, never a link**. `display_name` is the provider’s untrusted text (BD-022); show it with `provider` and `external_id`. `void_reason: second_author` means someone else used the code: offer a new one. Never the code itself.',
        tags: ['identity'],
        response: { 200: identityLinkStateSchema, 503: apiErrorSchema },
      },
    },
    async (request) => toWireLinkState(await commandsOf().state(actorOf(request).userId), now()),
  );

  typed.post(
    '/api/me/identity-links/read',
    {
      preValidation: requirePermission(guard, 'identity.link'),
      schema: {
        summary: 'I wrote it on … — read a ticket or merge request for your link code',
        description:
          'For a binding with no webhook: names the ticket key or the merge request iid of a **task of this project** where you wrote your code, and the platform reads that thread’s comments through the binding (`IntegrationActionExecutor`), applying the same rules as a webhook — the author comes from the provider, an edited comment, the binding’s own account, a machine, a platform marker and an author linked to someone else are refused, and a second author voids the code. `403 identity_link_read_not_permitted` below an effective `member` in the project; `404 link_thread_not_found` for a ticket or merge request no task of the project holds; `409 link_thread_no_binding` when the project has no binding that reads it; `503 link_thread_unavailable` when the provider could not be read.',
        tags: ['identity'],
        body: identityLinkThreadRequestSchema,
        response: {
          200: identityLinkThreadResponseSchema,
          403: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = request.body;
      const commands = commandsOf();
      const role = effectiveRole(
        actor.role,
        await queries.projectRole(body.project_id, actor.userId),
      );
      if (ROLE_LEVELS[role] < ROLE_LEVELS.member) {
        throw new HttpError(
          403,
          'identity_link_read_not_permitted',
          'a thread is read for a link code only in a project where you are a member or above',
        );
      }
      const target = await queries.threadOf(
        body.project_id,
        'ticket_key' in body
          ? { ticketKey: body.ticket_key }
          : { mergeRequestIid: body.merge_request_iid },
      );
      if (target === null) {
        throw new HttpError(
          404,
          'link_thread_not_found',
          'no task of this project holds that ticket or merge request',
        );
      }
      const outcome = await commands.readThread(body.project_id, target);
      if (outcome.kind === 'no_binding') {
        throw new HttpError(
          409,
          'link_thread_no_binding',
          'this project has no binding that reads that thread’s comments',
        );
      }
      if (outcome.kind === 'unavailable') {
        throw new HttpError(503, 'link_thread_unavailable', outcome.reason);
      }
      return {
        comments: outcome.comments,
        carried_code: outcome.claims,
        matched: outcome.recorded.matched,
        state: toWireLinkState(await commands.state(actor.userId), now()),
      };
    },
  );

  typed.post(
    '/api/me/identity-links/matches/:match_id/confirm',
    {
      preValidation: requirePermission(guard, 'identity.link'),
      schema: {
        summary: 'Confirm that a matched account is yours — the link',
        description:
          'The only self-service writer of `user_identities` (`kind: person`). Needs an `Idempotency-Key`. Re-checks everything: the match must be of **your** live code (`404 link_match_not_found` otherwise), no second account may have used the code (`409 link_code_voided`, `void_reason: second_author` — the code is voided), and the account must not be linked to someone else (`409 identity_linked_elsewhere`), declared a machine (`409 identity_is_machine`) or an integration’s own account (`409 identity_is_binding_account`). `409 link_code_expired` after 30 minutes, `409 link_code_used` once another match was confirmed. One `human_actions` row `identity.link {provider, external_id, via: link_code}`.',
        tags: ['identity'],
        params: matchParamsSchema,
        response: {
          200: identityLinkConfirmedSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const commands = commandsOf();
      const key = requireIdempotencyKey(request);
      const matchId = request.params.match_id;
      const claim = await claimIdempotentAttempt(queries, {
        userId: actor.userId,
        action: 'identity.link',
        key,
        request: { match_id: matchId },
      });
      if (claim.replayed) {
        const provider = claim.previous?.provider;
        const externalId = claim.previous?.external_id;
        if (typeof provider !== 'string' || typeof externalId !== 'string') {
          throw new HttpError(
            409,
            'idempotency_key_reused',
            'this Idempotency-Key already confirmed a link this build cannot name; use a new key',
          );
        }
        return {
          provider,
          external_id: externalId,
          // The display name is provider text and was never put in the audit row.
          display_name: null,
          user_id: actor.userId,
          performed: false,
        };
      }
      return claim.run(async (performed) => {
        const outcome = await commands.confirm(actor.userId, matchId);
        if (outcome.kind === 'refused') {
          throw confirmRefusal(outcome);
        }
        if (outcome.replayed) {
          // Confirmed already under another key: nothing was written, so the key is released.
          return {
            provider: outcome.provider,
            external_id: outcome.externalId,
            display_name: outcome.displayName,
            user_id: actor.userId,
            performed: false,
          };
        }
        performed();
        await queries.recordAction({
          userId: actor.userId,
          action: 'identity.link',
          params: {
            provider: outcome.provider,
            external_id: outcome.externalId,
            via: 'link_code',
            match_id: outcome.matchId,
            display_name_chars: (outcome.displayName ?? '').length,
            idempotency_key: key,
            ...(claim.digest === null ? {} : { body_digest: claim.digest }),
          },
        });
        return {
          provider: outcome.provider,
          external_id: outcome.externalId,
          display_name: outcome.displayName,
          user_id: actor.userId,
          performed: true,
        };
      });
    },
  );

  typed.get(
    '/api/me/identities',
    {
      preHandler: requirePermission(guard, 'identity.link'),
      schema: {
        summary: 'Your linked tracker and git accounts',
        description:
          'Every `person` row of `user_identities` that names you — linked by you (a confirmed code) or by an admin. `display_name` is the provider’s untrusted text (BD-022).',
        tags: ['identity'],
        response: { 200: myIdentityListSchema },
      },
    },
    async (request) => ({
      items: (await queries.listMine(actorOf(request).userId)).map((row) => ({
        provider: row.provider,
        external_id: row.external_id,
        display_name: row.display_name,
        created_at: row.created_at.toISOString() as IsoDateTime,
      })),
    }),
  );

  typed.delete(
    '/api/me/identities/:provider/:external_id',
    {
      preValidation: requirePermission(guard, 'identity.link'),
      schema: {
        summary: 'Unlink one of your own accounts',
        description:
          'Deletes your `person` row for the account. `404 identity_not_found` for an account that is not linked to you — another person’s, a machine or none are one answer. Nothing it changed on a task is undone here: an owner a link adopted changes at the ticket’s next sync (BACKLOG 1083). One `human_actions` row `identity.unlink`.',
        tags: ['identity'],
        params: identityAccountParamsSchema,
        response: { 200: identityUnlinkedSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const { provider, external_id: externalId } = request.params;
      const removed = await queries.unlinkMine({ userId: actor.userId, provider, externalId });
      if (!removed) {
        throw new HttpError(404, 'identity_not_found', 'that account is not linked to you');
      }
      await queries.recordAction({
        userId: actor.userId,
        action: 'identity.unlink',
        params: { provider, external_id: externalId, user_id: actor.userId, by: 'self' },
      });
      return { provider, external_id: externalId };
    },
  );
};
