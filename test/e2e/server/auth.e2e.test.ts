/**
 * WP-06's first acceptance criterion: **login** (docs/technical/13-implementation-plan.md).
 *
 * A whole instance, a real PostgreSQL 18, Better Auth's own endpoints and the RBAC middleware — the
 * only way to find out whether the field maps of migration 0011, the Argon2id hasher and the
 * session cookie actually agree with each other is to sign in and use the session.
 */
import type { OrgUsersResponse, UserSummary } from '@platform/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestClient } from '../../integration/support/postgres.js';
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_PASSWORD,
  Client,
  type Instance,
  startInstance,
} from '../support/instance.js';

let instance: Instance;

beforeAll(async () => {
  instance = await startInstance();
}, 180_000);

afterAll(async () => {
  await instance?.stop();
});

const signIn = async (email: string, password: string): Promise<Client> => {
  const client = new Client(instance.baseUrl);
  const response = await client.post<{ user?: { id: string } }>('/api/auth/sign-in/email', {
    email,
    password,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

describe('login', () => {
  it('signs the bootstrap administrator in and returns a session cookie', async () => {
    const client = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    // `sessionCookieName` yields the unprefixed name over http; `__Host-` needs Secure, which a
    // browser will not accept over plain http (see auth/better-auth.ts).
    expect(client.hasCookie('session')).toBe(true);

    const session = await client.json<{ user: { email: string; role: string } }>(
      '/api/auth/get-session',
    );
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(BOOTSTRAP_EMAIL);
    // The bootstrap account is promoted to `admin` in the same boot that creates it.
    expect(session.body.user.role).toBe('admin');
  });

  it('refuses the wrong password and issues no cookie', async () => {
    const client = new Client(instance.baseUrl);
    const response = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: 'definitely-not-the-password',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(client.hasCookie('session')).toBe(false);
  });

  it('refuses an anonymous request to a guarded endpoint with 401, not 403', async () => {
    const anonymous = new Client(instance.baseUrl);
    const response = await anonymous.json<{ error: { code: string } }>('/api/org/users');
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('unauthenticated');
  });

  it('does not let anyone register while APP_ALLOW_SIGNUP is off', async () => {
    const client = new Client(instance.baseUrl);
    const response = await client.post('/api/auth/sign-up/email', {
      email: 'intruder@example.test',
      password: 'another-fake-password-1234',
      name: 'Intruder',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('changing your own password (Settings → Password)', () => {
  // A user of its own: the bootstrap administrator's password is every other case's credential.
  const EMAIL = 'changes-password@example.test';
  const OLD = 'an-old-fake-password-1111';
  const NEW = 'a-new-fake-password-2222';

  it('verifies the current password, stores the new one, and signs out the other sessions', async () => {
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const created = await admin.post('/api/auth/admin/create-user', {
      email: EMAIL,
      password: OLD,
      name: 'Changes Password',
      role: 'member',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const here = await signIn(EMAIL, OLD);
    const elsewhere = await signIn(EMAIL, OLD);

    // The server's minimum (`PASSWORD_MIN_LENGTH`, the bootstrap's 12), not Better Auth's 8.
    const short = await here.post('/api/auth/change-password', {
      currentPassword: OLD,
      newPassword: 'eleven-char',
      revokeOtherSessions: true,
    });
    expect(short.status).toBe(400);

    // A wrong current password changes nothing.
    const wrong = await here.post('/api/auth/change-password', {
      currentPassword: 'not-the-current-password',
      newPassword: NEW,
      revokeOtherSessions: true,
    });
    expect(wrong.status).toBe(400);
    await signIn(EMAIL, OLD);

    const changed = await here.post('/api/auth/change-password', {
      currentPassword: OLD,
      newPassword: NEW,
      revokeOtherSessions: true,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    // This browser has a fresh, working session; the other one is gone.
    const mine = await here.json<{ user: { email: string } } | null>('/api/auth/get-session');
    expect(mine.body?.user.email).toBe(EMAIL);
    const theirs = await elsewhere.json<{ error: { code: string } }>('/api/org/users');
    expect(theirs.status).toBe(401);

    // The old password no longer signs in; the new one does (Argon2id, through the field maps).
    const old = await new Client(instance.baseUrl).post('/api/auth/sign-in/email', {
      email: EMAIL,
      password: OLD,
    });
    expect(old.status).toBeGreaterThanOrEqual(400);
    await signIn(EMAIL, NEW);
  });

  it('refuses an anonymous caller', async () => {
    const response = await new Client(instance.baseUrl).post('/api/auth/change-password', {
      currentPassword: OLD,
      newPassword: NEW,
    });
    expect(response.status).toBe(401);
  });
});

describe('one-time invite links (TD-022’s 2026-11-26 amendment)', () => {
  const PASSWORD = 'an-invited-fake-password-3333';

  interface Created {
    readonly invite: { readonly id: string; readonly role: string; readonly state: string };
    readonly url: string;
  }

  const tokenOf = (url: string): string => url.slice(url.indexOf('#') + 1);

  const makeLink = async (body: Record<string, unknown> = {}): Promise<Created> => {
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const created = await admin.post<Created>('/api/org/users/invites', body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body;
  };

  const accept = (token: string, email: string, password = PASSWORD) =>
    new Client(instance.baseUrl).post<{ user_id?: string; error?: { code: string } }>(
      '/api/invites/accept',
      { token, email, name: 'Invited Person', password },
    );

  const inspect = (token: string) =>
    new Client(instance.baseUrl).post<{ state?: string; role?: string; error?: { code: string } }>(
      '/api/invites/inspect',
      { token },
    );

  const sql = async (text: string, params: readonly unknown[] = []): Promise<void> => {
    const client = createTestClient(instance.database.connectionString);
    await client.connect();
    try {
      await client.query(text, [...params]);
    } finally {
      await client.end();
    }
  };

  it('creates a link, accepts it, and signs the new person in with the chosen role', async () => {
    const created = await makeLink({ role: 'maintainer', valid_for_hours: 1 });
    expect(created.url).toMatch(/\/invite#[A-Za-z0-9_-]{43}$/);
    expect(created.invite).toMatchObject({ role: 'maintainer', state: 'pending' });

    const accepted = await accept(tokenOf(created.url), 'invited.maintainer@example.test');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    const person = await signIn('invited.maintainer@example.test', PASSWORD);
    const session = await person.json<{ user: { role: string } }>('/api/auth/get-session');
    expect(session.body.user.role).toBe('maintainer');
    // `org.audit.read` is maintainer-and-above: the role bites, not only reads back.
    expect((await person.json('/api/org/audit')).status).toBe(200);

    // A second accept of the same link is refused; the link is spent.
    const again = await accept(tokenOf(created.url), 'someone.else@example.test');
    expect(again.status).toBe(410);
    expect(again.body.error?.code).toBe('invite_used');

    // The list names it used, by whom, and carries no token.
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const list = await admin.json<{
      items: { id: string; state: string; accepted_user_id: string }[];
    }>('/api/org/users/invites');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(tokenOf(created.url));
    const row = list.body.items.find((item) => item.id === created.invite.id);
    expect(row?.state).toBe('accepted');
    expect(row?.accepted_user_id).toBe(accepted.body.user_id);
  });

  it('inspects a link without consuming it', async () => {
    const created = await makeLink();
    const token = tokenOf(created.url);
    for (let read = 0; read < 2; read += 1) {
      const inspected = await inspect(token);
      expect(inspected.status).toBe(200);
      expect(inspected.body).toMatchObject({ role: 'member', state: 'pending' });
    }
    expect((await accept(token, 'inspected.first@example.test')).status).toBe(201);
    expect((await inspect(token)).body.state).toBe('accepted');
    expect((await inspect('FAKE-no-such-invite-token')).status).toBe(404);
  });

  it('refuses a revoked link and an expired one', async () => {
    const revoked = await makeLink();
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const revoke = await admin.post(`/api/org/users/invites/${revoked.invite.id}/revoke`, {});
    expect(revoke.status).toBe(200);
    const refusedRevoked = await accept(tokenOf(revoked.url), 'revoked.link@example.test');
    expect(refusedRevoked.status).toBe(410);
    expect(refusedRevoked.body.error?.code).toBe('invite_revoked');

    const expired = await makeLink({ valid_for_hours: 1 });
    // Both instants move, or `expires_at > created_at` refuses the update.
    await sql(
      "update user_invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1",
      [expired.invite.id],
    );
    const refusedExpired = await accept(tokenOf(expired.url), 'expired.link@example.test');
    expect(refusedExpired.status).toBe(410);
    expect(refusedExpired.body.error?.code).toBe('invite_expired');
  });

  it('refuses a short password with 400 and leaves the link pending', async () => {
    const created = await makeLink();
    const short = await accept(tokenOf(created.url), 'short.password@example.test', 'eleven-char');
    expect(short.status).toBe(400);
    expect((await inspect(tokenOf(created.url))).body.state).toBe('pending');
  });

  it('answers a taken email 409 and leaves the link usable', async () => {
    const created = await makeLink();
    const taken = await accept(tokenOf(created.url), BOOTSTRAP_EMAIL);
    expect(taken.status).toBe(409);
    expect(taken.body.error?.code).toBe('email_taken');
    expect((await inspect(tokenOf(created.url))).body.state).toBe('pending');
    expect((await accept(tokenOf(created.url), 'after.taken@example.test')).status).toBe(201);
  });

  it('refuses a non-admin 403 and an anonymous caller 401 on the admin routes', async () => {
    const created = await makeLink({ role: 'member' });
    expect((await accept(tokenOf(created.url), 'plain.member@example.test')).status).toBe(201);
    const member = await signIn('plain.member@example.test', PASSWORD);
    const anonymous = new Client(instance.baseUrl);
    for (const [method, path] of [
      ['GET', '/api/org/users/invites'],
      ['POST', '/api/org/users/invites'],
      ['POST', `/api/org/users/invites/${created.invite.id}/revoke`],
    ] as const) {
      const init =
        method === 'GET'
          ? {}
          : { method, headers: { 'content-type': 'application/json' }, body: '{}' };
      expect((await member.json(path, init)).status, `${method} ${path}`).toBe(403);
      expect((await anonymous.json(path, init)).status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('RBAC delegates to packages/domain can()', () => {
  it('lets a member read the user list but not the audit log', async () => {
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);

    const created = await admin.post<{ user: { id: string } }>('/api/auth/admin/create-user', {
      email: 'member@example.test',
      password: 'a-third-fake-password-5678',
      name: 'Member',
      role: 'member',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    const member = await signIn('member@example.test', 'a-third-fake-password-5678');

    // `org.read` is viewer-and-above (Q36), so a member may list users.
    const users = await member.json<OrgUsersResponse>('/api/org/users');
    expect(users.status).toBe(200);
    expect(users.body.items.map((user: UserSummary) => user.email)).toContain(BOOTSTRAP_EMAIL);

    // `org.audit.read` is maintainer-and-above, so the same member may not read the audit log.
    const audit = await member.json<{ error: { code: string } }>('/api/org/audit');
    expect(audit.status).toBe(403);
    expect(audit.body.error.code).toBe('forbidden');

    // …and the administrator may.
    const adminAudit = await admin.json<{ items: unknown[] }>('/api/org/audit');
    expect(adminAudit.status).toBe(200);
    expect(adminAudit.body.items).toEqual([]);
  });
});

describe('CSRF (TD-022)', () => {
  it('refuses a cookie-authenticated mutation without the custom header', async () => {
    const client = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const response = await fetch(`${instance.baseUrl}/events/subscriptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: client.cookieHeader,
        origin: instance.baseUrl,
        // no x-requested-with
      },
      body: JSON.stringify({ connection_id: 'nope', add: ['org'] }),
    });
    expect(response.status).toBe(403);
    // Its own code and sentence (backlog 56), not a role that "may not perform" the request.
    expect(await response.json()).toMatchObject({
      error: {
        code: 'cross_site_request',
        message:
          'cross-site request refused for POST /events/subscriptions: the x-requested-with header is required on mutating requests',
      },
    });
  });

  it('refuses a cookie-authenticated mutation from another origin', async () => {
    const client = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const response = await fetch(`${instance.baseUrl}/events/subscriptions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: client.cookieHeader,
        origin: 'https://evil.example',
        'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify({ connection_id: 'nope', add: ['org'] }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'cross_site_request',
        message:
          'cross-site request refused for POST /events/subscriptions: Origin https://evil.example is not a trusted origin',
      },
    });
  });
});

describe('OpenAPI', () => {
  it('generates a document from the zod route schemas', async () => {
    const client = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const document = await client.json<{
      openapi: string;
      info: { title: string };
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    }>('/openapi.json');

    expect(document.status).toBe(200);
    expect(document.body.openapi).toBe('3.1.0');
    expect(Object.keys(document.body.paths)).toEqual(
      expect.arrayContaining([
        '/healthz',
        '/readyz',
        '/api/version',
        '/metrics',
        '/api/org/users',
        '/api/org/audit',
        '/api/projects/{project_id}/config',
        '/events',
        '/events/subscriptions',
      ]),
    );

    // The schemas are generated, not hand-written: the user list's 200 response has to describe the
    // `items` array of `userSummarySchema`, which only a transform of the zod schema can produce.
    const users = document.body.paths['/api/org/users']?.get?.responses?.['200'] as {
      content: { 'application/json': { schema: { properties: Record<string, unknown> } } };
    };
    expect(Object.keys(users.content['application/json'].schema.properties)).toEqual(['items']);

    // Better Auth's own routes are deliberately not described here — it publishes its own document.
    expect(Object.keys(document.body.paths).some((path) => path.startsWith('/api/auth'))).toBe(
      false,
    );
  });
});
