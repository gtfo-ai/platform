/**
 * `createInviteCommands`' one call into Better Auth (TD-022's 2026-11-26 amendment): `createUser`
 * is called with a body and **nothing else** — no headers, no request — because Better Auth's
 * admin endpoint checks a session only when the call carries one, and the platform's own claim is
 * the authorisation here. The SQL beside it is driven against PostgreSQL in
 * `test/integration/server/invite-claim.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Auth } from './auth/better-auth.js';
import { createInviteCommands } from './invites.js';

const commandsWith = (api: Record<string, unknown>) =>
  createInviteCommands({
    // Unused by `createUser`: a call that reached the database would fail with a TypeError.
    database: {} as never,
    auth: { api } as unknown as Auth,
  });

const INPUT = {
  email: 'invited@example.test',
  name: 'Invited Person',
  password: 'a-fake-invite-password-1234',
  role: 'viewer' as const,
};

describe('createInviteCommands().createUser', () => {
  it('calls createUser with a body and nothing else, carrying the link’s role', async () => {
    const calls: Record<string, unknown>[] = [];
    const commands = commandsWith({
      createUser: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { user: { id: '00000000-0000-4000-8000-0000000000b2', email: INPUT.email } };
      },
    });
    expect(await commands.createUser(INPUT)).toEqual({
      kind: 'created',
      userId: '00000000-0000-4000-8000-0000000000b2',
      email: INPUT.email,
    });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0] ?? {})).toEqual(['body']);
    expect(calls[0]?.body).toEqual({
      email: INPUT.email,
      password: INPUT.password,
      name: INPUT.name,
      role: 'viewer',
    });
  });

  it('maps a refusal raised before the user row is written, and rethrows anything else', async () => {
    const refusing = (code: string) =>
      commandsWith({
        createUser: async () => {
          throw Object.assign(new Error(code), { body: { code } });
        },
      });
    expect(await refusing('USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL').createUser(INPUT)).toEqual({
      kind: 'email_taken',
    });
    expect(await refusing('INVALID_EMAIL').createUser(INPUT)).toEqual({ kind: 'invalid_email' });
    await expect(refusing('FAILED_TO_CREATE_USER').createUser(INPUT)).rejects.toThrow(
      'FAILED_TO_CREATE_USER',
    );
  });

  it('refuses by name a Better Auth composed without the admin plugin', async () => {
    await expect(commandsWith({}).createUser(INPUT)).rejects.toThrow(TypeError);
  });
});
