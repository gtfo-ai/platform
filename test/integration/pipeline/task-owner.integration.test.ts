/**
 * S-26.1 — a task's owner against a real PostgreSQL 18 (criteria 1, 5 and 6; TD-031's 2026-11-06
 * amendment items 1, 3 and 6, migration 0104).
 *
 *  1. **Who an assignee is** (`TaskOwnerDirectory.classifyAssignee`) over `user_identities`, the
 *     effective project role (an organisation role at `member` or above needs no membership, a
 *     membership promotes and never demotes — backlog 886) and `bindings.account_identity`: a
 *     linked member, a linked viewer, an unlinked account, a machine and the binding's own account.
 *  2. **Held elsewhere, two spellings, one answer**: the application's `heldElsewhereNow` (the
 *     domain predicate over the directory) and `taskHeldElsewhereSql` (what the DTO, and S-26.4's
 *     claim and pick, read) agree on every case, and both read a link made since the tracker read.
 *  3. **Intake's sync in the insert's transaction**, through `syncOwnerAtIntake` on the real store.
 *  4. **The stage offer names the owner** (`routeNewOffer`, closes backlog 730) while the owner's
 *     machine is online and takes the project automatically — not when it is pick-only, offline,
 *     or when the task has no owner.
 *  5. **The board's owner filter and the DTO's four fields** (`listProjectTasks`).
 */
import {
  heldElsewhereNow,
  INITIAL_TASK_VERSION,
  type PipelineStore,
  routeNewOffer,
  type StoredTask,
  syncOwnerAtIntake,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES, UNOWNED } from '@platform/domain';
import { db, pipeline } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listProjectTasks } from '../../../apps/server/src/queries/pipeline-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW = '2026-11-07T09:00:00.000Z' as IsoDateTime;

let database: MigratedDatabase;
let pool: pg.Pool;
let store: PipelineStore;
let projectId: Id;
const users: Record<'alice' | 'admin' | 'carol' | 'erin', Id> = {
  alice: '' as Id,
  admin: '' as Id,
  carol: '' as Id,
  erin: '' as Id,
};
let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

const query = async <R extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<R[]> => (await pool.query<R>(text, values)).rows;

beforeAll(async () => {
  database = await createMigratedDatabase('task-owner');
  pool = createTestPool(database.connectionString, { max: 4 });
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const [org] = await query<{ id: string }>(
    "insert into organizations (name) values ('task-owner') returning id",
  );
  const [project] = await query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'own', 'Owners', 'https://git.example.test/acme/own.git') returning id`,
    [org?.id],
  );
  projectId = project?.id as Id;
  const user = async (email: string, role: string): Promise<Id> =>
    (
      (
        await query<{ id: string }>(
          'insert into users (email, name, role) values ($1, $2, $3) returning id',
          [email, email.split('@')[0], role],
        )
      )[0] as { id: string }
    ).id as Id;
  // Alice is an organisation viewer the project promotes to member; the admin needs no membership;
  // Carol is a project viewer; Erin is a member nobody has linked yet.
  users.alice = await user('alice@example.test', 'viewer');
  users.admin = await user('admin@example.test', 'admin');
  users.carol = await user('carol@example.test', 'viewer');
  users.erin = await user('erin@example.test', 'member');
  await query(
    "insert into project_members (project_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'viewer')",
    [projectId, users.alice, users.carol],
  );
  await query(
    `insert into user_identities (provider, external_id, user_id, kind) values
       ('jira-cloud', 'acct-alice', $1, 'person'),
       ('jira-cloud', 'acct-admin', $2, 'person'),
       ('jira-cloud', 'acct-carol', $3, 'person'),
       ('jira-cloud', 'acct-dan', null, 'machine')`,
    [users.alice, users.admin, users.carol],
  );
  const [integration] = await query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name)
     values ($1, 'task_management', 'jira-cloud', 'tracker') returning id`,
    [org?.id],
  );
  await query(
    `insert into bindings (project_id, integration_id, account_identity)
     values ($1, $2, '{"provider": "jira-cloud", "external_id": "acct-bot"}'::jsonb)`,
    [projectId, integration?.id],
  );
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

/** One connection, one transaction, committed or rolled back with what `work` answers. */
const within = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  try {
    const answer = await work({ adapter: 'postgres', client } as unknown as Transaction);
    await client.query('commit');
    return answer;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    await client.end();
  }
};

/** A committed live task of the project. */
const committedTask = async (): Promise<Id> => {
  const taskId = nextId();
  const stored = {
    task: {
      id: taskId,
      projectId,
      ticket: {
        provider: 'jira-cloud',
        key: `OWN-${counter}`,
        url: `https://jira.example.test/browse/OWN-${counter}`,
      },
      template: 'feature',
      mode: 'normal',
      state: 'active',
      currentStage: 'implementation' as Slug,
      stageAttempts: { implementation: 1 },
      iterationCounters: {},
      limits: {
        code_review: 3,
        business_review: 2,
        ci_fix: 3,
        human_rounds: 3,
        refinement_questions: 2,
        architecture_revisions: 2,
        rebase: 2,
        rebase_rechecks: 10,
        dependency_policy: 2,
      },
      sequence: 1,
    },
    template: FEATURE_TEMPLATE,
    pipelineDial: null,
    qaStage: false,
    priorityRank: 2,
    createdAt: NOW,
    branch: null,
    mr: null,
    workpad: null,
    costActualUsd: 0,
    estimateUsd: null,
    estimateBasis: null,
    estimateSamples: null,
    ticketSnapshot: null,
    ticketSnapshotAt: null,
    ticketSignalAt: null,
    reviewSubject: null,
    historySample: null,
    riskClasses: [],
    coverage: null,
    dependencies: null,
    requiredReviewers: null,
    reviewThreads: null,
    readyHeadSha: null,
    ciHeadSha: null,
    ciExcusedPaths: [],
    requestedByUserId: null,
    version: INITIAL_TASK_VERSION,
  } as unknown as StoredTask;
  await within((tx) => store.tasks.insert(tx, stored));
  return taskId;
};

const ACCOUNTS = ['alice', 'admin', 'carol', 'dan', 'bot', 'erin'] as const;

describe('who a tracker assignee is (TaskOwnerDirectory, migration 0104)', () => {
  it('answers member, platform or person over identities, the effective role and the binding', async () => {
    const answers = await within(async (tx) =>
      Object.fromEntries(
        await Promise.all(
          ACCOUNTS.map(async (account) => [
            account,
            await store.owners.classifyAssignee(tx, {
              projectId,
              provider: 'jira-cloud',
              externalId: `acct-${account}`,
            }),
          ]),
        ),
      ),
    );
    expect(answers).toEqual({
      // A membership promotes an organisation viewer; an organisation admin needs none.
      alice: { kind: 'member', userId: users.alice },
      admin: { kind: 'member', userId: users.admin },
      // Linked, but a viewer of the project: shown as an assignee, never an owner.
      carol: { kind: 'person' },
      dan: { kind: 'platform' },
      bot: { kind: 'platform' },
      erin: { kind: 'person' },
    });
    // Another provider's account of the same id is nobody the platform knows.
    expect(
      await within((tx) =>
        store.owners.classifyAssignee(tx, {
          projectId,
          provider: 'gitlab',
          externalId: 'acct-alice',
        }),
      ),
    ).toEqual({ kind: 'person' });
  });

  it('says who may own a task of the project', async () => {
    const may = await within(async (tx) => ({
      alice: await store.owners.mayOwn(tx, { projectId, userId: users.alice }),
      admin: await store.owners.mayOwn(tx, { projectId, userId: users.admin }),
      carol: await store.owners.mayOwn(tx, { projectId, userId: users.carol }),
      erin: await store.owners.mayOwn(tx, { projectId, userId: users.erin }),
    }));
    expect(may).toEqual({ alice: true, admin: true, carol: false, erin: true });
  });

  it('refuses a disabled user: no owner, and the identity reads as a person (review of #92)', async () => {
    const ask = () =>
      within(async (tx) => ({
        may: await store.owners.mayOwn(tx, { projectId, userId: users.alice }),
        assignee: await store.owners.classifyAssignee(tx, {
          projectId,
          provider: 'jira-cloud',
          externalId: 'acct-alice',
        }),
      }));
    // Calibrated against the same user enabled, before and after.
    expect(await ask()).toEqual({ may: true, assignee: { kind: 'member', userId: users.alice } });
    await query("update users set status = 'disabled' where id = $1", [users.alice]);
    try {
      expect(await ask()).toEqual({ may: false, assignee: { kind: 'person' } });
    } finally {
      await query("update users set status = 'active' where id = $1", [users.alice]);
    }
    expect((await ask()).may).toBe(true);
  });
});

describe('intake’s sync on the real store, and held elsewhere in two spellings', () => {
  const heldSql = pipeline.taskHeldElsewhereSql('t');

  /** A task whose intake read `account`, synced by `syncOwnerAtIntake` in one transaction. */
  const intakeOf = async (account: (typeof ACCOUNTS)[number] | null): Promise<Id> => {
    const taskId = await committedTask();
    await within(async (tx) =>
      syncOwnerAtIntake({ store, ids: { next: nextId }, clock: { now: () => NOW } }, tx, {
        projectId,
        taskId,
        read: {
          assignee:
            account === null
              ? null
              : {
                  provider: 'jira-cloud',
                  external_id: `acct-${account}`,
                  display_name: account,
                  verified: false,
                },
          assigneeDisplayName: account,
        },
        causeEventId: nextId(),
      }),
    );
    return taskId;
  };

  const heldBoth = async (taskId: Id) =>
    within(async (tx) => {
      const ownership = await store.tasks.ownership(tx, taskId);
      const [row] = (
        await (tx as unknown as { client: pg.ClientBase }).client.query<{ held: boolean }>(
          `select ${heldSql} as held from tasks t where t.id = $1`,
          [taskId],
        )
      ).rows;
      return {
        application: await heldElsewhereNow(store, tx, projectId, ownership),
        sql: row?.held,
      };
    });

  it('stores the assignee for every case, and owns the task only for a linked member', async () => {
    const owners: Record<string, Id | null> = {};
    for (const account of ACCOUNTS) {
      const taskId = await intakeOf(account);
      const ownership = await within((tx) => store.tasks.ownership(tx, taskId));
      owners[account] = ownership.ownerUserId;
      expect(ownership.ticketAssignee, account).toEqual({
        provider: 'jira-cloud',
        external_id: `acct-${account}`,
        display_name: account,
        platform: account === 'dan' || account === 'bot',
      });
    }
    expect(owners).toEqual({
      alice: users.alice,
      admin: users.admin,
      carol: null,
      dan: null,
      bot: null,
      erin: null,
    });
    const unassigned = await intakeOf(null);
    expect(await within((tx) => store.tasks.ownership(tx, unassigned))).toEqual(UNOWNED);
  });

  it('agrees with the SQL predicate on every case, and both read a link made since', async () => {
    const expected: Record<string, boolean> = {
      alice: false,
      admin: false,
      carol: true,
      dan: false,
      bot: false,
      erin: true,
    };
    for (const account of ACCOUNTS) {
      const taskId = await intakeOf(account);
      expect(await heldBoth(taskId), account).toEqual({
        application: expected[account],
        sql: expected[account],
      });
    }
    expect(await heldBoth(await intakeOf(null))).toEqual({ application: false, sql: false });

    // Erin's account is linked after the read: both spellings stop calling it held elsewhere.
    const erinTask = await intakeOf('erin');
    await query(
      "insert into user_identities (provider, external_id, user_id, kind) values ('jira-cloud', 'acct-erin', $1, 'person')",
      [users.erin],
    );
    expect(await heldBoth(erinTask)).toEqual({ application: false, sql: false });
    // …and the adoption finds it: unowned, live, its stored assignee the linked identity.
    const adoptable = await within((tx) =>
      store.tasks.unownedLiveByAssignee(tx, { provider: 'jira-cloud', externalId: 'acct-erin' }),
    );
    expect(adoptable.map((row) => row.taskId)).toContain(erinTask);
    await query("delete from user_identities where external_id = 'acct-erin'");
  });
});

describe('a stage offer names the owner (criterion 5, backlog 730)', () => {
  const route = (assigneeUserId: Id | null) =>
    within((tx) =>
      routeNewOffer(store.execution, tx, {
        projectId,
        assigneeUserId,
        now: new Date().toISOString() as IsoDateTime,
      }),
    );

  it('gives the owner’s online machine the head start, and only while it takes the project', async () => {
    const taskId = await committedTask();
    await within((tx) =>
      store.tasks.saveOwner(tx, taskId, {
        expected: { ownerUserId: null, ticketAssignee: null },
        next: {
          ...UNOWNED,
          ownerUserId: users.alice,
          ownerSource: 'platform',
          ownerChangedAt: NOW,
        },
      }),
    );
    const owner = (await within((tx) => store.tasks.ownership(tx, taskId))).ownerUserId;
    expect(owner).toBe(users.alice);

    // No machine yet: no head start.
    expect((await route(owner)).assigneeUserId).toBeNull();
    const workerId = nextId();
    await query(
      `insert into workers (id, user_id, name, credential_hash, last_seen_at)
       values ($1, $2, 'laptop', repeat('b', 64), now())`,
      [workerId, users.alice],
    );
    const online = await route(owner);
    expect(online.assigneeUserId).toBe(users.alice);
    expect(online.assigneeUntil).not.toBeNull();
    // Pick-only (`'{}'`): the machine takes nothing by itself, so it holds no window.
    await query("update workers set claim_project_ids = '{}' where id = $1", [workerId]);
    expect((await route(owner)).assigneeUserId).toBeNull();
    // A scope naming the project takes it again; offline does not.
    await query('update workers set claim_project_ids = array[$2::uuid] where id = $1', [
      workerId,
      projectId,
    ]);
    expect((await route(owner)).assigneeUserId).toBe(users.alice);
    // A disabled owner holds no window: the claim would refuse their machine anyway.
    await query("update users set status = 'disabled' where id = $1", [users.alice]);
    try {
      expect((await route(owner)).assigneeUserId).toBeNull();
    } finally {
      await query("update users set status = 'active' where id = $1", [users.alice]);
    }
    expect((await route(owner)).assigneeUserId).toBe(users.alice);
    await query("update workers set last_seen_at = now() - interval '61 seconds' where id = $1", [
      workerId,
    ]);
    expect((await route(owner)).assigneeUserId).toBeNull();
    // A task with no owner names nobody, whoever is online.
    await query('update workers set last_seen_at = now() where id = $1', [workerId]);
    expect((await route(null)).assigneeUserId).toBeNull();
  });
});

describe('the board’s owner filter and the DTO’s four fields (criterion 6)', () => {
  it('filters owner=me and owner=none, and publishes the owner and the assignee who holds it elsewhere', async () => {
    const drizzled = drizzle(pool, { schema: db.schema });
    const mine = await committedTask();
    await within((tx) =>
      store.tasks.saveOwner(tx, mine, {
        expected: { ownerUserId: null, ticketAssignee: null },
        next: {
          ...UNOWNED,
          ownerUserId: users.alice,
          ownerSource: 'platform',
          ownerChangedAt: NOW,
        },
      }),
    );
    const held = await committedTask();
    await within((tx) =>
      store.tasks.saveOwner(tx, held, {
        expected: { ownerUserId: null, ticketAssignee: null },
        next: {
          ...UNOWNED,
          ticketAssignee: {
            provider: 'jira-cloud',
            external_id: 'acct-stranger',
            display_name: 'Jan Novák',
            platform: false,
          },
        },
      }),
    );

    const page = async (owner?: { kind: 'user'; userId: string } | { kind: 'none' }) =>
      (
        await listProjectTasks(drizzled, projectId, {
          limit: 200,
          ...(owner === undefined ? {} : { owner }),
        })
      )?.items ?? [];

    const ofAlice = await page({ kind: 'user', userId: users.alice });
    expect(ofAlice.map((item) => item.id)).toContain(mine);
    expect(ofAlice.every((item) => item.owner?.user_id === users.alice)).toBe(true);
    const nobodys = await page({ kind: 'none' });
    expect(nobodys.map((item) => item.id)).toContain(held);
    expect(nobodys.map((item) => item.id)).not.toContain(mine);
    expect(nobodys.every((item) => item.owner === null)).toBe(true);

    const everyone = await page();
    const mineItem = everyone.find((item) => item.id === mine);
    const heldItem = everyone.find((item) => item.id === held);
    expect(mineItem).toMatchObject({
      owner: { user_id: users.alice, name: 'alice' },
      owner_source: 'platform',
      unlinked_assignee: null,
      owner_writes_back: false,
    });
    expect(heldItem).toMatchObject({
      owner: null,
      owner_source: null,
      unlinked_assignee: { display_name: 'Jan Novák' },
      owner_writes_back: false,
    });
  });
});
