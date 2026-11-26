/**
 * `readVisibilitySources` against a real PostgreSQL 18 (S-30.1 acceptance 1): the one statement
 * behind `visibleProjects`, held to the unit table of `apps/server/src/auth/visibility.test.ts` —
 * each person below is one of its rows built as rows, read back through the statement, and decided
 * by the real rule.
 */
import { db } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createVisibleProjects,
  type VisibleProjects,
  visibleIdsOf,
} from '../../../apps/server/src/auth/visibility.js';
import { readVisibilitySources } from '../../../apps/server/src/queries/project-visibility-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let visible: (
  userId: string,
  role: 'viewer' | 'member' | 'maintainer' | 'admin',
) => Promise<VisibleProjects>;
const projects: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
let counter = 0;

const one = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[],
): Promise<R> => (await pool.query<R>(text, values)).rows[0] as R;

const user = async (role: string): Promise<string> => {
  counter += 1;
  return (
    await one<{ id: string }>(
      'insert into users (email, name, role) values ($1, $2, $3) returning id',
      [`v${counter}@example.test`, `v${counter}`, role],
    )
  ).id;
};

const worker = async (
  userId: string,
  scope: readonly string[] | null,
  revoked = false,
): Promise<void> => {
  counter += 1;
  await pool.query(
    `insert into workers (user_id, name, credential_hash, claim_project_ids, state, revoked_at)
     values ($1, 'laptop', $2, $3::uuid[], $4, case when $5 then now() end)`,
    [userId, String(counter).padStart(64, '0'), scope, revoked ? 'revoked' : 'active', revoked],
  );
};

const membership = async (userId: string, projectId: string): Promise<void> => {
  await pool.query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'member')",
    [projectId, userId],
  );
};

const ownedTask = async (userId: string, projectId: string, state: string): Promise<void> => {
  counter += 1;
  await pool.query(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        owner_user_id)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/' || $2, 'feature', $3, $4)`,
    [projectId, `VIS-${counter}`, state, userId],
  );
};

const asExpected = (answer: VisibleProjects): 'all' | readonly string[] =>
  visibleIdsOf(answer) ?? 'all';

beforeAll(async () => {
  database = await createMigratedDatabase('project-visibility');
  pool = createTestPool(database.connectionString, { max: 2 });
  const drizzled = drizzle(pool, { schema: db.schema });
  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('visibility') returning id",
    [],
  );
  for (const key of ['a', 'b', 'c'] as const) {
    projects[key] = (
      await one<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, $2, $2, 'https://git.example.test/acme/' || $2 || '.git') returning id`,
        [org.id, `VIS${key.toUpperCase()}`],
      )
    ).id;
  }
  const read = createVisibleProjects(async (userId) => readVisibilitySources(drizzled, userId));
  visible = async (userId, role) =>
    read({ userId, role, email: 'x@example.test', name: 'x', sessionId: 's' });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const sorted = (...ids: string[]): string[] => [...ids].sort();

describe('readVisibilitySources holds the statement to BD-035’s table', () => {
  it('an admin sees every project, whatever their worker takes', async () => {
    const id = await user('admin');
    await worker(id, [projects.a]);
    expect(asExpected(await visible(id, 'admin'))).toBe('all');
  });

  it('no worker and no membership: every project', async () => {
    expect(asExpected(await visible(await user('member'), 'member'))).toBe('all');
  });

  it('a worker scoped to [A]: A only', async () => {
    const id = await user('member');
    await worker(id, [projects.a]);
    expect(asExpected(await visible(id, 'member'))).toEqual([projects.a]);
  });

  it('a worker scoped to [A] beside a null worker: every project', async () => {
    const id = await user('member');
    await worker(id, [projects.a]);
    await worker(id, null);
    expect(asExpected(await visible(id, 'member'))).toBe('all');
  });

  it("a legacy '{}' worker: every project", async () => {
    const id = await user('member');
    await worker(id, [projects.a]);
    await worker(id, []);
    expect(asExpected(await visible(id, 'member'))).toBe('all');
  });

  it('a revoked worker is ignored, in both directions', async () => {
    const narrowedByRevoked = await user('member');
    await worker(narrowedByRevoked, [projects.a], true);
    expect(asExpected(await visible(narrowedByRevoked, 'member'))).toBe('all');

    const widenedByRevoked = await user('member');
    await worker(widenedByRevoked, [projects.a]);
    await worker(widenedByRevoked, null, true);
    expect(asExpected(await visible(widenedByRevoked, 'member'))).toEqual([projects.a]);
  });

  it('a membership adds', async () => {
    const id = await user('member');
    await worker(id, [projects.a]);
    await membership(id, projects.b);
    expect(asExpected(await visible(id, 'member'))).toEqual(sorted(projects.a, projects.b));
  });

  it('an unfinished owned task adds; a finished one does not', async () => {
    const id = await user('member');
    await worker(id, [projects.a]);
    await ownedTask(id, projects.b, 'active');
    await ownedTask(id, projects.c, 'done');
    await ownedTask(id, projects.c, 'cancelled');
    expect(asExpected(await visible(id, 'member'))).toEqual(sorted(projects.a, projects.b));
  });
});
