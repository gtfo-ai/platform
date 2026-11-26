/**
 * The four Better Auth calls the SPA makes, and the platform's three pre-session calls — the setup
 * state and an invite link's inspect and accept (TD-022, technical/08 § Auth).
 *
 * Better Auth owns `/api/auth/*` and its payloads are camelCase — the one documented exception to
 * the platform's snake_case wire format, because they are a third party's shape rather than one
 * the platform defines. They are therefore parsed with a **loose** object: the fields the UI needs
 * are named and checked, and everything else the library adds (`emailVerified`, `image`,
 * `createdAt`, plugin fields) is carried through untouched rather than rejected. That is the same
 * exemption CLAUDE.md grants "opaque provider payloads"; it is not a licence to skip parsing, and
 * a `role` outside TD-022's four values still fails here.
 *
 * `role` is read from the session because the server refreshes it from the `users` row on every
 * request (`auth/plugin.ts`): a demotion bites the next request, so the client's copy is only ever
 * used to decide what to *offer*, never to decide what is allowed. The server is the authority.
 */
import {
  type InviteAccepted,
  type InviteInspectResponse,
  inviteAcceptedSchema,
  inviteAcceptRequestSchema,
  inviteInspectRequestSchema,
  inviteInspectResponseSchema,
  type SetupStateResponse,
  setupStateResponseSchema,
  userRoleSchema,
} from '@platform/contracts';
import * as z from 'zod';
import type { ApiClient } from '../api/http.js';

export const sessionUserSchema = z.looseObject({
  id: z.string().min(1),
  email: z.email(),
  name: z.string().nullish(),
  role: userRoleSchema,
});

export const sessionResponseSchema = z
  .looseObject({
    user: sessionUserSchema,
    session: z.looseObject({ id: z.string().min(1) }),
  })
  .nullable();

export type SessionUser = z.infer<typeof sessionUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

const signInResponseSchema = z.looseObject({});

export interface SignInCredentials {
  readonly email: string;
  readonly password: string;
}

export interface ChangePasswordRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
  /** Sign out every other session of this user; this browser gets a fresh session cookie. */
  readonly revokeOtherSessions: boolean;
}

/**
 * The password length bounds the server sets on Better Auth (`@platform/contracts`). The form
 * checks them before it sends, because Better Auth's refusal is `{ code, message }` — not the
 * platform's problem document — so the client sees every `400` as `unexpected_response` and cannot
 * tell a short password from a wrong current one. Checked here, a `400` means the current password.
 */
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@platform/contracts';

export interface AuthApi {
  readonly getSession: () => Promise<SessionResponse>;
  readonly signIn: (credentials: SignInCredentials) => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** `POST /api/auth/change-password` — the signed-in user's own password. */
  readonly changePassword: (request: ChangePasswordRequest) => Promise<void>;
  /**
   * `GET /api/setup-state` (WP-291) — whether anybody has signed in to this instance yet. The
   * platform's own route rather than Better Auth's, so its payload is snake_case and strict.
   */
  readonly setupState: () => Promise<SetupStateResponse>;
  /**
   * `POST /api/invites/inspect` (TD-022's 2026-11-26 amendment) — an invite link's role, expiry and
   * state, before an account exists. The token travels in the body only; reading never consumes it.
   */
  readonly inspectInvite: (token: string) => Promise<InviteInspectResponse>;
  /** `POST /api/invites/accept` — creates the account with the link's role; then sign in. */
  readonly acceptInvite: (request: {
    readonly token: string;
    readonly email: string;
    readonly name: string;
    readonly password: string;
  }) => Promise<InviteAccepted>;
}

export const createAuthApi = (client: ApiClient): AuthApi => ({
  getSession: () => client.get('/api/auth/get-session', { schema: sessionResponseSchema }),
  signIn: async (credentials) => {
    await client.command('/api/auth/sign-in/email', {
      schema: signInResponseSchema,
      body: { email: credentials.email, password: credentials.password },
    });
  },
  signOut: async () => {
    await client.command('/api/auth/sign-out', { schema: signInResponseSchema, body: {} });
  },
  changePassword: async (request) => {
    await client.command('/api/auth/change-password', {
      schema: signInResponseSchema,
      body: {
        currentPassword: request.currentPassword,
        newPassword: request.newPassword,
        revokeOtherSessions: request.revokeOtherSessions,
      },
    });
  },
  setupState: () => client.get('/api/setup-state', { schema: setupStateResponseSchema }),
  inspectInvite: (token) =>
    client.command('/api/invites/inspect', {
      schema: inviteInspectResponseSchema,
      body: inviteInspectRequestSchema.parse({ token }),
    }),
  acceptInvite: (request) =>
    client.command('/api/invites/accept', {
      schema: inviteAcceptedSchema,
      body: inviteAcceptRequestSchema.parse({
        token: request.token,
        email: request.email,
        name: request.name,
        password: request.password,
      }),
    }),
});

/** What the UI shows for a user: the name when there is one, the email otherwise. */
export const displayName = (user: SessionUser): string =>
  user.name === null || user.name === undefined || user.name.trim() === '' ? user.email : user.name;
