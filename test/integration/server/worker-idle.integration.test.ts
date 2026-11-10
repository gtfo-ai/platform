/**
 * **Why a ready machine runs nothing, against PostgreSQL 18** (S-28.6, the M28 ruling A) — the SQL
 * half of `idle_reason` (`apps/server/src/queries/worker-idle.ts`), which every route test replaces
 * with a fake reader. What only the database can show:
 *
 *  - a full project the machine's person may run in, with tasks its policy takes queued there, is
 *    `project_limit` with the scheduler's counts;
 *  - a full project the person has **no role** in is never named — the reader asks the claim's own
 *    role predicate, so nothing about another team's project leaks into a stranger's row;
 *  - a `server_only` project, and one whose run credential keeps workers off, are not served;
 *  - a queued task the limits admit says nothing (the scheduler starts it);
 *  - a `mine` machine is not told about a full project whose queued tasks are somebody else's.
 *
 * Every person here is an organisation **viewer** with a project membership, so the role predicate
 * — not the organisation role — decides which projects each machine serves.
 */
import type { Id, WorkerClaimPolicy } from '@platform/contracts';
import { DEFAULT_WIP_LIMITS } from '@platform/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  createWorkerIdleReader,
  type WorkerIdleReader,
} from '../../../apps/server/src/queries/worker-idle.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const RUN_DIGEST = `sha256:${'c'.repeat(64)}`;
const EGRESS_DIGEST = `sha256:${'d'.repeat(64)}`;
const CORE = { run: RUN_DIGEST, egress: EGRESS_DIGEST };

let database: MigratedDatabase;
let pool: pg.Pool;
let reader: WorkerIdleReader;
let orgId: string;
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${(0x286000 + counter).toString(16).padStart(12, '0')}` as Id;
};

const one = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R> => (await pool.query<R>(text, values)).rows[0] as R;

beforeAll(async () => {
  database = await createMigratedDatabase('worker-idle');
  pool = createTestPool(database.connectionString, { max: 4 });
  reader = createWorkerIdleReader(drizzle(pool) as unknown as Database, async () => ({
    limits: DEFAULT_WIP_LIMITS,
    bounded: [],
  }));
  orgId = (
    await one<{ id: string }>("insert into organizations (name) values ('idle') returning id")
  ).id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const project = async (key: string): Promise<Id> =>
  (
    await one<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, $2, 'https://git.example.test/acme/idle.git') returning id`,
      [orgId, key],
    )
  ).id as Id;

/** An organisation viewer, a `member` of each of `projects`. */
const person = async (...projects: Id[]): Promise<Id> => {
  const user = await one<{ id: string }>(
    "insert into users (email, name, role) values ($1, 'Idle Person', 'viewer') returning id",
    [`${nextId()}@example.test`],
  );
  for (const projectId of projects) {
    await pool.query(
      "insert into project_members (project_id, user_id, role) values ($1, $2, 'member')",
      [projectId, user.id],
    );
  }
  return user.id as Id;
};

/** A connected machine holding the core's images, taking by `policy` over every project. */
const machine = async (userId: Id, policy: WorkerClaimPolicy): Promise<Id> => {
  const id = nextId();
  await pool.query(
    `insert into workers (id, user_id, name, credential_hash, last_seen_at, claim_policy,
                          image_digests)
     values ($1, $2, 'laptop', $3, now(), $4, $5::jsonb)`,
    [
      id,
      userId,
      id.replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      policy,
      JSON.stringify([RUN_DIGEST, EGRESS_DIGEST]),
    ],
  );
  return id;
};

/** `n` tasks of `projectId` in `state`, owned by `owner` (or nobody). */
const tasks = async (projectId: Id, state: string, n: number, owner: Id | null = null) => {
  for (let i = 0; i < n; i += 1) {
    const key = `IDLE-${nextId().slice(-6)}`;
    await pool.query(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                          current_stage, stage_attempts, owner_user_id)
       values ($1, 'jira-cloud', $2, 'https://jira.example.test/browse/' || $2, 'feature', $3,
               'implementation', '{"implementation": 1}'::jsonb, $4)`,
      [projectId, key, state, owner],
    );
  }
};

/** A project at `max_tasks_in_pipeline` (5 of 5, waiting for an approval) with `queued` behind. */
const fullProject = async (key: string, queued: number, owner: Id | null = null): Promise<Id> => {
  const id = await project(key);
  await tasks(id, 'waiting_approval', 5);
  await tasks(id, 'queued', queued, owner);
  return id;
};

const idleOf = async (workerId: Id) =>
  (
    await reader(
      [{ workerId, blocked: false, running: 0, concurrency: 1, claimPolicy: 'everything' }],
      CORE,
    )
  ).get(workerId);

const idleWith = async (workerId: Id, claimPolicy: WorkerClaimPolicy) =>
  (await reader([{ workerId, blocked: false, running: 0, concurrency: 1, claimPolicy }], CORE)).get(
    workerId,
  );

describe('idle_reason over PostgreSQL (S-28.6)', () => {
  it('names a full project its person may run in, with the scheduler’s counts', async () => {
    const full = await fullProject('FULLA', 2);
    const worker = await machine(await person(full), 'everything');
    expect(await idleOf(worker)).toEqual({
      kind: 'project_limit',
      project_id: full,
      project_key: 'FULLA',
      limit_kind: 'max_tasks_in_pipeline',
      count: 5,
      limit: 5,
      queued: 2,
      organisation_bound: false,
    });
  });

  it('never names a full project its person has no role in', async () => {
    await fullProject('FULLB', 3);
    const quiet = await project('QUIETB');
    const worker = await machine(await person(quiet), 'everything');
    expect(await idleOf(worker)).toEqual({ kind: 'nothing_queued' });
  });

  it('skips a server_only project and one whose run credential keeps workers off', async () => {
    const serverOnly = await fullProject('SRVC', 2);
    await pool.query(
      "insert into project_execution_settings (project_id, mode) values ($1, 'server_only')",
      [serverOnly],
    );
    const refused = await fullProject('CREDC', 2);
    const integration = await one<{ id: string }>(
      `insert into integrations (org_id, type, provider, name, config)
       values ($1, 'git', 'gitlab', 'git-idle', '{"run_credential": "static"}'::jsonb) returning id`,
      [orgId],
    );
    await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
      refused,
      integration.id,
    ]);
    const worker = await machine(await person(serverOnly, refused), 'everything');
    expect(await idleOf(worker)).toEqual({ kind: 'nothing_queued' });
  });

  it('says nothing when a queued task it would take is admitted: the scheduler starts it', async () => {
    const room = await project('ROOMD');
    await tasks(room, 'queued', 1);
    const worker = await machine(await person(room), 'everything');
    expect(await idleOf(worker)).toBeNull();
  });

  it('tells a mine machine nothing about a full project whose queued tasks are another’s', async () => {
    const full = await project('MINEE');
    const someone = await person(full);
    const me = await person(full);
    await tasks(full, 'waiting_approval', 5);
    await tasks(full, 'queued', 2, someone);
    const worker = await machine(me, 'mine');
    expect(await idleWith(worker, 'mine')).toEqual({ kind: 'nothing_queued' });
    // The same project with one of mine queued: now it is the cause.
    await tasks(full, 'queued', 1, me);
    expect(await idleWith(worker, 'mine')).toMatchObject({
      kind: 'project_limit',
      project_key: 'MINEE',
      queued: 1,
    });
  });
});
