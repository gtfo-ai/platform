/**
 * The three Better Auth calls the SPA makes (TD-022, technical/08 § Auth).
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
import { userRoleSchema } from '@platform/contracts';
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

export interface AuthApi {
  readonly getSession: () => Promise<SessionResponse>;
  readonly signIn: (credentials: SignInCredentials) => Promise<void>;
  readonly signOut: () => Promise<void>;
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
});

/** What the UI shows for a user: the name when there is one, the email otherwise. */
export const displayName = (user: SessionUser): string =>
  user.name === null || user.name === undefined || user.name.trim() === '' ? user.email : user.name;
