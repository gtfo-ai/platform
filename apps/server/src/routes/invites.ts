/**
 * One-time invite links (TD-022's 2026-11-26 amendment): three administrator commands and the
 * public pair a link's holder uses.
 *
 * - `POST /api/org/users/invites` — `{role?, valid_for_hours?}` (member, 24 h by default; 1–720 h)
 *   → `{invite, url}`. The **only** answer that carries the token, inside `url`
 *   (`<APP_BASE_URL origin>/invite#<token>`); only the token's SHA-256 is stored.
 * - `GET /api/org/users/invites` — every link with its state, never a token or a hash.
 * - `POST /api/org/users/invites/:id/revoke` — while the link is neither accepted nor revoked.
 * - `POST /api/invites/inspect` — **public**: `{token}` → role, expiry and state. Never consumes it.
 * - `POST /api/invites/accept` — **public**: `{token, email, name, password}` → the account.
 *
 * The three administrator routes need `org.users.manage` (admin), guarded in `preValidation` so an
 * anonymous request with no body is `401`, never a `400` describing the route's shape.
 *
 * ## No `Idempotency-Key` on creation (the amendment's item 6)
 *
 * The header separates a retry from a different request under a used key by replaying a stored
 * outcome (`routes/idempotency.ts`). There is nothing to replay here: the answer's whole value is a
 * token shown **once** and never stored, so a replay could only answer a link without it. A double
 * submit therefore makes two links, both listed and each revocable — a visible, harmless outcome.
 * Revocation is an update guarded by its own state, so repeating it changes nothing twice.
 *
 * ## Accepting, in this order (item 4)
 *
 * 1. The body is validated by zod, the password against `PASSWORD_MIN_LENGTH`–`PASSWORD_MAX_LENGTH`
 *    — Better Auth's `create-user` checks no length.
 * 2. **Claim**: one conditional `update … where accepted_at is null and revoked_at is null and
 *    expires_at > now() returning`. Two concurrent accepts of one link: exactly one gets the row.
 * 3. Nothing claimed: the row is read to say why — `404 invite_not_found`, `410 invite_used`,
 *    `invite_expired` or `invite_revoked`.
 * 4. Only a claimed link reaches `createUser`, server-side and with **no headers** (so Better Auth's
 *    admin check does not apply, and no Argon2 runs for an unproven token).
 * 5. A refusal Better Auth raises **before it writes the user** — the email in use, or not an email
 *    — releases the claim, so the link stays usable (`409 email_taken`, `400 invalid_email`). Any
 *    other failure keeps the claim: `createUser` writes the user, then hashes and links the
 *    password, so a failure after its first write could have made an account, and releasing then
 *    could let a second accept make another. The link is burned instead — never two accounts.
 * 6. The account is named on the link and `org.user.invite_accept` recorded **as the new user**,
 *    in one transaction.
 *
 * Every accepted command leaves one `human_actions` row — `org.user.invite` (role, hours),
 * `org.user.invite_revoke`, `org.user.invite_accept` — **in the same transaction as its write**
 * (`queries/invite-queries.ts`), never the token, never its hash.
 *
 * ## A revoke during an accept (how this route reads the amendment's "revocable until then")
 *
 * "Until then" is read as *until an account exists*: a revoke that lands while an accept holds the
 * claim succeeds, and a release after a refused email clears only the claim, so the link stays
 * revoked and the administrator's answer stays true. Should that in-flight accept make its account
 * anyway, the row carries both endings and reads *accepted* — the account exists.
 *
 * ## Not rate-limited here, stated
 *
 * The server has no limiter for public routes (`routes/setup-state.ts`). A 256-bit token is not
 * guessable, and an unclaimed token costs one indexed lookup, never an Argon2 hash; the hashing
 * happens only for a claimed link, which is one per link.
 */
import type {
  InviteState,
  InviteSummary,
  IsoDateTime,
  JsonObject,
  UserRole,
} from '@platform/contracts';
import {
  apiErrorSchema,
  createInviteRequestSchema,
  INVITE_VALID_FOR_HOURS_DEFAULT,
  idSchema,
  inviteAcceptedSchema,
  inviteAcceptRequestSchema,
  inviteCreatedSchema,
  inviteInspectRequestSchema,
  inviteInspectResponseSchema,
  inviteListSchema,
  inviteSummarySchema,
} from '@platform/contracts';
import { inviteStateAt } from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { generateInviteToken, hashInviteToken, inviteUrl } from '../auth/invite-token.js';
import { type PermissionGuardDependencies, requirePermission } from '../auth/rbac.js';
import type { VisibleProjectsReader } from '../auth/visibility.js';
import { HttpError } from '../errors.js';
import type { InviteRecord } from '../queries/invite-queries.js';

/** What Better Auth's `createUser` came to. */
export type CreateInvitedUserOutcome =
  | { readonly kind: 'created'; readonly userId: string; readonly email: string }
  /** Refused before the user row was written: the claim may be released. */
  | { readonly kind: 'email_taken' }
  | { readonly kind: 'invalid_email' };

/** The links' persistence and the account creation, bound by the composition root. */
export interface InviteCommands {
  /** Makes the link and records `org.user.invite` in one transaction. */
  readonly create: (input: {
    readonly id: string;
    readonly tokenSha256: string;
    readonly role: UserRole;
    readonly createdBy: string;
    readonly validForHours: number;
  }) => Promise<InviteRecord>;
  readonly list: () => Promise<readonly InviteRecord[]>;
  readonly findById: (id: string) => Promise<InviteRecord | null>;
  readonly findByTokenHash: (tokenSha256: string) => Promise<InviteRecord | null>;
  /**
   * Revokes a link that has made no account and is not revoked yet — a claimed one included — and
   * records `org.user.invite_revoke` in the same transaction; `null` when there was none such.
   */
  readonly revoke: (input: {
    readonly id: string;
    readonly revokedBy: string;
  }) => Promise<InviteRecord | null>;
  readonly claim: (
    tokenSha256: string,
  ) => Promise<{ readonly id: string; readonly role: UserRole } | null>;
  readonly release: (id: string) => Promise<void>;
  /**
   * `auth.api.createUser` with no headers. Throws for every failure that is not a refusal raised
   * before the user row is written (see the module note, step 5).
   */
  readonly createUser: (input: {
    readonly email: string;
    readonly name: string;
    readonly password: string;
    readonly role: UserRole;
  }) => Promise<CreateInvitedUserOutcome>;
  readonly completeAccept: (input: {
    readonly id: string;
    readonly userId: string;
    readonly params: JsonObject;
  }) => Promise<void>;
}

export interface InviteRoutesOptions {
  /**
   * Always composed (`app.ts`): it needs only the database and Better Auth, which every process
   * that serves the API has — so there is no `503` branch to fall back to.
   */
  readonly invites: InviteCommands;
  readonly projectRole: PermissionGuardDependencies['projectRole'];
  /** The caller's visible projects (BD-035, `auth/visibility.ts`). */
  readonly visibleProjects: VisibleProjectsReader;
  /** `APP_BASE_URL` — the link is its origin, `/invite`, and the token as the fragment. */
  readonly baseUrl: string;
  /** The id of a new link; injectable for a test. */
  readonly newId: () => string;
}

const iso = (value: Date): IsoDateTime => value.toISOString() as IsoDateTime;
const isoOrNull = (value: Date | null): IsoDateTime | null => (value === null ? null : iso(value));

const stateOf = (record: InviteRecord): InviteState =>
  inviteStateAt(
    {
      acceptedAt: record.acceptedAt,
      acceptedUserId: record.acceptedUserId,
      revokedAt: record.revokedAt,
      expiresAt: record.expiresAt,
    },
    record.now,
  );

/** One link on the wire. Never a token and never its hash — the record does not carry either. */
export const toWireInvite = (record: InviteRecord): InviteSummary => ({
  id: record.id,
  role: record.role,
  state: stateOf(record),
  created_at: iso(record.createdAt),
  created_by: record.createdBy,
  expires_at: iso(record.expiresAt),
  accepted_at: isoOrNull(record.acceptedAt),
  accepted_user_id: record.acceptedUserId,
  revoked_at: isoOrNull(record.revokedAt),
});

/**
 * The refusal for a link that is not pending, by state — each code a literal, so the client's
 * error-code census reads every one off this file.
 */
const refusalFor = (state: Exclude<InviteState, 'pending'>): HttpError => {
  switch (state) {
    case 'accepted':
      return new HttpError(410, 'invite_used', 'this invite link has already been used');
    case 'expired':
      return new HttpError(410, 'invite_expired', 'this invite link has expired');
    case 'revoked':
      return new HttpError(410, 'invite_revoked', 'this invite link was revoked');
  }
};

const notFound = (): HttpError =>
  new HttpError(404, 'invite_not_found', 'no invite link matches that token');

const inviteParamsSchema = z.strictObject({ invite_id: idSchema });

export const registerInviteRoutes = async (
  app: FastifyInstance,
  options: InviteRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: options.projectRole,
    visibleProjects: options.visibleProjects,
  };
  const manage = requirePermission(guard, 'org.users.manage');

  const commandsOf = (): InviteCommands => options.invites;

  /** Unreachable through `requirePermission`, which refuses an anonymous caller first. */
  const actorOf = (request: FastifyRequest): string => {
    const actor = request.actor;
    if (actor === undefined) {
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return actor.userId;
  };

  typed.post(
    '/api/org/users/invites',
    {
      preValidation: manage,
      schema: {
        summary: 'Make a one-time invite link',
        description:
          'TD-022’s 2026-11-26 amendment. `role` defaults to `member`, `valid_for_hours` to 24 (1–720), counted from the database’s `now()`. The answer’s `url` — `<APP_BASE_URL>/invite#<token>` — is the **only** time the token is shown: only its SHA-256 is stored. No `Idempotency-Key`: there is no stored answer to replay, so a double submit makes two links, each revocable. One `human_actions` row `org.user.invite` (role, hours).',
        tags: ['org'],
        body: createInviteRequestSchema,
        response: { 201: inviteCreatedSchema, 400: apiErrorSchema },
      },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      const invites = commandsOf();
      const role = request.body.role ?? 'member';
      const validForHours = request.body.valid_for_hours ?? INVITE_VALID_FOR_HOURS_DEFAULT;
      const token = generateInviteToken();
      const record = await invites.create({
        id: options.newId(),
        tokenSha256: hashInviteToken(token),
        role,
        createdBy: actor,
        validForHours,
      });
      reply.status(201);
      return { invite: toWireInvite(record), url: inviteUrl(options.baseUrl, token) };
    },
  );

  typed.get(
    '/api/org/users/invites',
    {
      preHandler: manage,
      schema: {
        summary: 'Every invite link, with its state',
        description:
          'Pending, accepted, expired and revoked links, newest first (at most 200), with the role, who made each, its expiry and the account an accepted one made. Never a token or its hash.',
        tags: ['org'],
        response: { 200: inviteListSchema },
      },
    },
    async () => ({ items: (await commandsOf().list()).map(toWireInvite) }),
  );

  typed.post(
    '/api/org/users/invites/:invite_id/revoke',
    {
      preValidation: manage,
      schema: {
        summary: 'Revoke an invite link',
        description:
          'Allowed until the link has made an account and while it is not revoked — an expired one, and one an accept holds the claim of, may still be revoked; the revoke then stands even if that accept is refused and releases its claim. `404 invite_not_found`; `409 invite_used` once an account was made, `409 invite_revoked` for one already revoked. One `human_actions` row `org.user.invite_revoke`, in the revoke’s transaction.',
        tags: ['org'],
        params: inviteParamsSchema,
        response: { 200: inviteSummarySchema, 404: apiErrorSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const actor = actorOf(request);
      const invites = commandsOf();
      const id = request.params.invite_id;
      const revoked = await invites.revoke({ id, revokedBy: actor });
      if (revoked === null) {
        const current = await invites.findById(id);
        if (current === null) {
          throw notFound();
        }
        if (current.acceptedUserId !== null) {
          throw new HttpError(409, 'invite_used', 'this invite link has already been used');
        }
        throw new HttpError(409, 'invite_revoked', 'this invite link was already revoked');
      }
      return toWireInvite(revoked);
    },
  );

  typed.post(
    '/api/invites/inspect',
    {
      schema: {
        summary: 'Read an invite link’s role, expiry and state',
        description:
          'Public: the invite page reads it before a session exists. Never consumes the link. `404 invite_not_found` for a token that names no link; an accepted, expired or revoked one answers 200 with its state.',
        tags: ['auth'],
        body: inviteInspectRequestSchema,
        response: { 200: inviteInspectResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      const record = await commandsOf().findByTokenHash(hashInviteToken(request.body.token));
      if (record === null) {
        throw notFound();
      }
      return { role: record.role, state: stateOf(record), expires_at: iso(record.expiresAt) };
    },
  );

  typed.post(
    '/api/invites/accept',
    {
      schema: {
        summary: 'Accept an invite link: create the account',
        description:
          'Public. Creates the account with the link’s role and the email, name and password given; the browser then signs in through `/api/auth/sign-in/email`. `400` on a password outside `PASSWORD_MIN_LENGTH`–`PASSWORD_MAX_LENGTH` or a malformed body; `404 invite_not_found`; `410 invite_used`, `invite_expired`, `invite_revoked`; `409 email_taken`, which leaves the link usable. The email is unverified and resolves nothing but a sign-in (BD-022, Q10).',
        tags: ['auth'],
        body: inviteAcceptRequestSchema,
        response: {
          201: inviteAcceptedSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          410: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const invites = commandsOf();
      const body = request.body;
      const tokenSha256 = hashInviteToken(body.token);
      const claimed = await invites.claim(tokenSha256);
      if (claimed === null) {
        const current = await invites.findByTokenHash(tokenSha256);
        if (current === null) {
          throw notFound();
        }
        const state = stateOf(current);
        // `pending` here is a claim released between the update and this read (a concurrent
        // accept refused by Better Auth): this request lost the race, so it is answered as used
        // rather than retried — the person may submit again and meet the released link.
        throw refusalFor(state === 'pending' ? 'accepted' : state);
      }
      const outcome = await invites.createUser({
        email: body.email,
        name: body.name,
        password: body.password,
        role: claimed.role,
      });
      if (outcome.kind !== 'created') {
        await invites.release(claimed.id);
        if (outcome.kind === 'email_taken') {
          throw new HttpError(
            409,
            'email_taken',
            'an account with that email already exists; the invite link is still usable',
          );
        }
        throw new HttpError(400, 'invalid_email', 'that is not an email address');
      }
      await invites.completeAccept({
        id: claimed.id,
        userId: outcome.userId,
        params: { invite_id: claimed.id, role: claimed.role },
      });
      reply.status(201);
      return { user_id: outcome.userId, email: outcome.email, role: claimed.role };
    },
  );
};
