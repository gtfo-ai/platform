/**
 * WP-06's first acceptance criterion: **login** (docs/technical/13-implementation-plan.md).
 *
 * A whole instance, a real PostgreSQL 18, Better Auth's own endpoints and the RBAC middleware — the
 * only way to find out whether the field maps of migration 0011, the Argon2id hasher and the
 * session cookie actually agree with each other is to sign in and use the session.
 */
import type { OrgUsersResponse, UserSummary } from '@platform/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
