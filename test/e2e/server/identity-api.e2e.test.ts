/**
 * **The identity pair against a real PostgreSQL** — `POST` and `GET /api/org/identities` (WP-31,
 * PROGRESS backlog 79), on a whole `apps/server` instance.
 *
 * The pair shipped with a route-level test that drives it through a **fake** `IdentityQueries`
 * whose `upsertMapping` returns a `Date`, and with no tier that put a database behind it. The real
 * one answers something else: a `sql` template through `db.execute` installs a `getTypeParser`
 * that returns PostgreSQL's own rendering of a `timestamptz` **as a string** (drizzle-orm 0.45.2,
 * `node-postgres/session.js`; `2026-09-14 11:47:18.53969+00`, measured in
 * `test/integration/server/identity-queries.integration.test.ts`). `isoDateTimeSchema` refused it
 * and the response failed serialisation, so **every** call to the product's only identity-mapping
 * command was a 500 — reproduced by this file before it was fixed, as
 * `FST_ERR_RESPONSE_SERIALIZATION` / `"Invalid ISO datetime"` at `created_at` in the instance's
 * log and `{"error":{"code":"internal_error"}}` at the client. That is standing rule 1's shape (a
 * fake kinder than the real adapter) and rule 82's (the seam the work package exists to exercise is
 * the seam the test replaced), and the only tier that can falsify it is this one.
 *
 * So the assertion about `created_at` here is deliberately not "it looks like a timestamp": it is
 * **the instant the row holds**, read back out of `user_identities` by a second connection and
 * compared to the published string. A mapping that re-rendered the column, dropped the zone or
 * published the driver's string cannot satisfy it.
 *
 * `GET` is driven in the same case rather than in one of its own, because it shares
 * `toWireIdentityMapping` with the `POST` — the same defect, and on an **empty** table it answers
 * `{"items": []}` and looks healthy, which is why nothing had ever seen it fail.
 *
 * What this file does not re-assert: the refusals the route test already drives through the fake
 * (a wrong role, a missing body field, an unauthenticated caller). It drives the two whose answer
 * depends on the database — a `user_id` no `users` row holds, and a member who may not decide who
 * acts as whom — and nothing else.
 */
import { identityMappingListSchema, identityMappingSchema } from '@platform/contracts';
import pg from 'pg';
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
  // Not `silent`, which is the harness default: a 500 reaches the client as `internal_error` and a
  // request id, and the cause exists only in the instance's own log. The defect this file exists
  // for was diagnosed from exactly that line.
  instance = await startInstance({ label: 'identities', logLevel: 'error' });
}, 180_000);

afterAll(async () => {
  await instance?.stop();
});

/** A second connection, so the rows are read as another session sees them. */
const rows = async <T extends Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> => {
  const client = new pg.Client({ connectionString: instance.database.connectionString });
  await client.connect();
  try {
    return (await client.query<T>(text, [...params])).rows;
  } finally {
    await client.end();
  }
};

interface IdentityRow extends Record<string, unknown> {
  provider: string;
  external_id: string;
  user_id: string;
  display_name: string | null;
  email: string | null;
  created_at: Date;
}

interface ActionRow extends Record<string, unknown> {
  user_id: string | null;
  action: string;
  params: Record<string, unknown>;
  task_id: string | null;
}

const identityRows = (externalId: string): Promise<IdentityRow[]> =>
  rows<IdentityRow>(
    `select provider, external_id, user_id, display_name, email, created_at
       from user_identities where external_id = $1`,
    [externalId],
  );

const actionRows = (externalId: string): Promise<ActionRow[]> =>
  rows<ActionRow>(
    `select user_id, action, params, task_id
       from human_actions
      where action = 'org.identity.map' and params->>'external_id' = $1
      order by created_at`,
    [externalId],
  );

const signIn = async (email: string, password: string): Promise<Client> => {
  const client = new Client(instance.baseUrl);
  const response = await client.post('/api/auth/sign-in/email', { email, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

/** A real `users` row, made the way an administrator makes one. */
const createUser = async (
  admin: Client,
  email: string,
  name: string,
  role: string,
): Promise<string> => {
  const created = await admin.post<{ user: { id: string } }>('/api/auth/admin/create-user', {
    email,
    password: 'not-a-real-password-0000',
    name,
    role,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.user.id;
};

const map = (client: Client, body: Record<string, unknown>) =>
  client.json<Record<string, unknown>>('/api/org/identities', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/org/identities, against the database it writes to', () => {
  it('maps an account, publishes the instant the row holds, and records who decided it', async () => {
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const session = await admin.json<{ user: { id: string } }>('/api/auth/get-session');
    const adminId = session.body.user.id;
    const ada = await createUser(admin, 'ada@example.test', 'Ada Lovelace', 'member');

    const response = await map(admin, {
      provider: 'jira-cloud',
      external_id: 'acct-ada',
      user_id: ada,
      display_name: 'Ada Lovelace',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const published = identityMappingSchema.parse(response.body);
    expect(published).toMatchObject({
      provider: 'jira-cloud',
      external_id: 'acct-ada',
      user_id: ada,
      display_name: 'Ada Lovelace',
    });

    const stored = await identityRows('acct-ada');
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      provider: 'jira-cloud',
      user_id: ada,
      display_name: 'Ada Lovelace',
      // `email` is a column of the table and this route deliberately never writes it: an address
      // the platform matched itself is the one route BD-022 and Q10 refuse (`routes/org.ts`).
      email: null,
    });
    // **The assertion the fake could not make.** `created_at` is a `timestamptz` the database
    // defaulted, read here through `pg`'s own parser; what the endpoint published must be that
    // same instant, rendered as ISO-8601.
    expect(published.created_at).toBe(stored[0]?.created_at.toISOString());

    const actions = await actionRows('acct-ada');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      user_id: adminId,
      action: 'org.identity.map',
      // A mapping is organisation-scoped and `human_actions` has no project column.
      task_id: null,
      params: {
        provider: 'jira-cloud',
        external_id: 'acct-ada',
        user_id: ada,
        display_name_chars: 'Ada Lovelace'.length,
      },
    });
    // "The shape of the request, never the words": the label itself is not in the audit row.
    expect(JSON.stringify(actions[0]?.params)).not.toContain('Ada Lovelace');

    // The sibling read, over the row this request wrote — the same `toWireIdentityMapping` and the
    // same 500 until it was fixed, invisible while the table was empty.
    const listed = await admin.json<unknown>('/api/org/identities');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const list = identityMappingListSchema.parse(listed.body);
    expect(list.items).toContainEqual(published);
  });

  it('re-maps the same account to another person without creating a second row', async () => {
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const grace = await createUser(admin, 'grace@example.test', 'Grace Hopper', 'member');
    const margaret = await createUser(
      admin,
      'margaret@example.test',
      'Margaret Hamilton',
      'member',
    );

    const first = await map(admin, {
      provider: 'gitlab',
      external_id: 'acct-shared',
      user_id: grace,
      display_name: 'Grace Hopper',
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);

    // What an operator does when somebody leaves: the account moves to another person. The upsert
    // is on `(provider, external_id)`, so this is one row changing owner, not a second mapping.
    const second = await map(admin, {
      provider: 'gitlab',
      external_id: 'acct-shared',
      user_id: margaret,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(identityMappingSchema.parse(second.body)).toMatchObject({
      user_id: margaret,
      // Omitted on the second request, so the label the first one set is cleared rather than kept:
      // `excluded.display_name` is what the upsert writes.
      display_name: null,
    });

    const stored = await identityRows('acct-shared');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.user_id).toBe(margaret);
    // Two requests, two audit rows — the route has no `Idempotency-Key` on purpose, and this is
    // what that costs: a true record of two decisions, one effect (`routes/org.ts`).
    expect(await actionRows('acct-shared')).toHaveLength(2);
  });

  it('refuses a user id no row holds, and writes nothing for the refusal', async () => {
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    // Well-formed and nobody's: the check is a real `users` read, not the fake's set.
    const response = await map(admin, {
      provider: 'slack',
      external_id: 'acct-nobody',
      user_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('unknown_user');
    // A refused command leaves no row, so the count of rows is the count of things that happened.
    expect(await identityRows('acct-nobody')).toHaveLength(0);
    expect(await actionRows('acct-nobody')).toHaveLength(0);
  });

  it('refuses a member: deciding who may act as whom is `org.users.manage`', async () => {
    const admin = await signIn(BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD);
    const alan = await createUser(admin, 'alan@example.test', 'Alan Turing', 'member');
    const member = await signIn('alan@example.test', 'not-a-real-password-0000');

    const response = await map(member, {
      provider: 'slack',
      external_id: 'acct-alan',
      user_id: alan,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect((response.body as { error: { code: string } }).error.code).toBe('forbidden');
    expect(await identityRows('acct-alan')).toHaveLength(0);
    expect(await actionRows('acct-alan')).toHaveLength(0);

    // …and the list is closed to them too, for the reason the route gives: the mapping says which
    // human is behind a provider account.
    const listed = await member.json<{ error: { code: string } }>('/api/org/identities');
    expect(listed.status).toBe(403);
  });
});
