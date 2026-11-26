/**
 * Invite links against a real PostgreSQL 18 and the real Better Auth (TD-022's 2026-11-26
 * amendment): the claim's conditional update is the whole guarantee that one link makes one
 * account, and only the database can say whether two concurrent accepts really serialise on it.
 *
 * The routes run in a bare Fastify over `createInviteCommands`, the composition `app.ts` uses, so
 * the claim, Better Auth's `createUser` with no headers, the release and the completion are the
 * production ones. The unit tier (`apps/server/src/routes/invites.test.ts`) holds the order of the
 * steps over a fake; this file holds what a fake cannot: the row lock and the `timestamptz` reads.
 */
import { createRequire } from 'node:module';
import { db } from '@platform/infrastructure';
import { createAuth, loadServerConfig } from '@platform/server';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashInviteToken } from '../../../apps/server/src/auth/invite-token.js';
import { toApiError } from '../../../apps/server/src/errors.js';
import { createInviteCommands } from '../../../apps/server/src/invites.js';
import {
  claimInvite,
  insertInvite,
  listInvites,
} from '../../../apps/server/src/queries/invite-queries.js';
import { recordHumanAction } from '../../../apps/server/src/queries/onboarding-queries.js';
import { registerInviteRoutes } from '../../../apps/server/src/routes/invites.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const PASSWORD = 'a-fake-invite-password-1234';

/**
 * Fastify and its zod compilers, resolved **from `apps/server`**, the package that depends on them
 * (`read-api.integration.test.ts` has the measurement behind it). Typed by the one shape used here.
 */
const fromServer = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
type FastifyInstance = Parameters<typeof registerInviteRoutes>[0];
const fastify = fromServer('fastify') as () => FastifyInstance;
const { serializerCompiler, validatorCompiler } = fromServer('fastify-type-provider-zod') as {
  // biome-ignore lint/suspicious/noExplicitAny: the compilers' own types live in apps/server's graph.
  readonly serializerCompiler: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  readonly validatorCompiler: any;
};

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;
let app: FastifyInstance;
let admin: string;
let sequence = 0;

const newId = (): string => {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
};

/** A pending link whose token the test knows. */
const link = async (token: string, role: 'member' | 'viewer' = 'member') =>
  insertInvite(drizzled, {
    id: newId(),
    tokenSha256: hashInviteToken(token),
    role,
    createdBy: admin,
    validForHours: 24,
  });

const accept = (token: string, email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/invites/accept',
    payload: { token, email, name: 'Invited Person', password: PASSWORD },
  });

const countUsers = async (emails: readonly string[]): Promise<number> => {
  const result = await pool.query<{ count: string }>(
    'select count(*)::text as count from users where email = any($1)',
    [emails],
  );
  return Number(result.rows[0]?.count ?? '0');
};

beforeAll(async () => {
  database = await createMigratedDatabase('invite-claim');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 8 });
  drizzled = drizzle(pool, { schema: db.schema });
  const inserted = await pool.query<{ id: string }>(
    "insert into users (email, name, role) values ('admin@example.test', 'Admin', 'admin') returning id",
  );
  admin = inserted.rows[0]?.id as string;

  const config = loadServerConfig({
    DATABASE_URL: database.connectionString,
    APP_SECRET_KEY: 'integration-test-secret-not-a-real-secret',
  });
  const auth = createAuth({ pool, config });
  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error: unknown, _request, reply) => {
    const mapped = toApiError(error, 'integration');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  await registerInviteRoutes(app, {
    invites: createInviteCommands({
      database: drizzled,
      auth,
      recordAction: async (input) => recordHumanAction(drizzled, input),
    }),
    projectRole: async () => null,
    baseUrl: 'http://localhost:8080',
    newId,
  });
  await app.ready();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await database?.drop();
});

describe('one link, one account', () => {
  it('lets exactly one of two concurrent accepts make an account', async () => {
    const token = 'FAKE-concurrent-invite-token-00000000000000';
    const row = await link(token, 'viewer');
    const emails = ['first.racer@example.test', 'second.racer@example.test'];
    const answers = await Promise.all(emails.map((email) => accept(token, email)));

    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 410]);
    const loser = answers.find((answer) => answer.statusCode === 410)?.json() as
      | { error: { code: string } }
      | undefined;
    expect(loser?.error.code).toBe('invite_used');
    expect(await countUsers(emails)).toBe(1);

    const winner = answers.find((answer) => answer.statusCode === 201)?.json() as {
      user_id: string;
      role: string;
    };
    expect(winner.role).toBe('viewer');
    const stored = await pool.query<{ accepted_user_id: string; role: string }>(
      'select i.accepted_user_id, u.role::text as role from user_invites i join users u on u.id = i.accepted_user_id where i.id = $1',
      [row.id],
    );
    expect(stored.rows).toEqual([{ accepted_user_id: winner.user_id, role: 'viewer' }]);
    const audit = await pool.query<{ user_id: string }>(
      "select user_id from human_actions where action = 'org.user.invite_accept' and params->>'invite_id' = $1",
      [row.id],
    );
    expect(audit.rows).toEqual([{ user_id: winner.user_id }]);
  }, 60_000);

  it('releases the claim when the email is taken, and the link then works with another', async () => {
    const token = 'FAKE-email-taken-invite-token-000000000000';
    const row = await link(token);
    const taken = await accept(token, 'admin@example.test');
    expect(taken.statusCode).toBe(409);
    expect((taken.json() as { error: { code: string } }).error.code).toBe('email_taken');
    const after = await pool.query<{ accepted_at: Date | null }>(
      'select accepted_at from user_invites where id = $1',
      [row.id],
    );
    expect(after.rows[0]?.accepted_at).toBeNull();
    expect((await accept(token, 'fresh.person@example.test')).statusCode).toBe(201);
  }, 60_000);
});

describe('the reads and the claim', () => {
  it('reads every instant as a Date and claims nothing once the expiry passed', async () => {
    const token = 'FAKE-expired-invite-token-0000000000000000';
    const row = await link(token);
    // Both instants move, or the table's `expires_at > created_at` check refuses the update.
    await pool.query(
      "update user_invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = $1",
      [row.id],
    );
    expect(await claimInvite(drizzled, hashInviteToken(token))).toBeNull();
    const listed = (await listInvites(drizzled)).find((item) => item.id === row.id);
    expect(listed?.createdAt).toBeInstanceOf(Date);
    expect(listed?.now).toBeInstanceOf(Date);
    expect(listed?.expiresAt.getTime()).toBeLessThan(listed?.now.getTime() ?? 0);
    const refused = await accept(token, 'too.late@example.test');
    expect((refused.json() as { error: { code: string } }).error.code).toBe('invite_expired');
  });

  it('counts the validity from the database’s now(), in whole hours', async () => {
    const row = await insertInvite(drizzled, {
      id: newId(),
      tokenSha256: hashInviteToken('FAKE-validity-invite-token-000000000000000'),
      role: 'member',
      createdBy: admin,
      validForHours: 720,
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(720 * 3_600_000);
  });
});
