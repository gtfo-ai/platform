/**
 * S-26.3 — the owner write-back against a real PostgreSQL 18 (TD-031's 2026-11-06 amendment
 * item 4; criteria 2 and 4's SQL half).
 *
 *  1. **Which account the duty assigns** (`TaskOwnerDirectory.personIdentity`): a user's `person`
 *     identity for the provider, the oldest of two, never a `machine`, never another provider's.
 *  2. **The task DTO's `owner_writes_back`** (`listProjectTasks`): `true` exactly when the project's
 *     task-management binding sets `lifecycle.assign_owner` — read through the pipeline's own
 *     lifecycle reading — and the owner has a `person` identity for the ticket's provider; `false`
 *     for an owner with none, an unowned task, a shadow task, and a project whose binding does not
 *     opt in.
 *
 * The duty itself is `packages/application/src/pipeline/owner-write-back.test.ts`'s.
 */
import {
  INITIAL_TASK_VERSION,
  type PipelineStore,
  type StoredTask,
  type Transaction,
} from '@platform/application';
import type { Id, IsoDateTime, Slug, TaskMode } from '@platform/contracts';
import { FEATURE_TEMPLATE, SHIPPED_TEMPLATES, UNOWNED } from '@platform/domain';
import { db, pipeline } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listProjectTasks,
  ownerCandidateWriteBack,
  ownerWriteBackFor,
} from '../../../apps/server/src/queries/pipeline-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

const NOW = '2026-11-07T09:00:00.000Z' as IsoDateTime;

let database: MigratedDatabase;
let pool: pg.Pool;
let store: PipelineStore;
/** The project whose binding sets `lifecycle.assign_owner`, and one whose binding does not. */
let optedIn: Id;
let optedOut: Id;
const users: Record<'bob' | 'dora', Id> = { bob: '' as Id, dora: '' as Id };
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
  database = await createMigratedDatabase('task-owner-write-back');
  pool = createTestPool(database.connectionString, { max: 4 });
  store = pipeline.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
  const [org] = await query<{ id: string }>(
    "insert into organizations (name) values ('write-back') returning id",
  );
  const project = async (key: string): Promise<Id> =>
    (
      (
        await query<{ id: string }>(
          `insert into projects (org_id, key, name, repo_url)
           values ($1, $2, $2, 'https://git.example.test/acme/' || $2 || '.git') returning id`,
          [org?.id, key],
        )
      )[0] as { id: string }
    ).id as Id;
  optedIn = await project('wbin');
  optedOut = await project('wbout');
  const user = async (email: string): Promise<Id> =>
    (
      (
        await query<{ id: string }>(
          "insert into users (email, name, role) values ($1, $2, 'member') returning id",
          [email, email.split('@')[0]],
        )
      )[0] as { id: string }
    ).id as Id;
  // Both are organisation members, so they may own a task of either project with no membership.
  users.bob = await user('bob@example.test');
  users.dora = await user('dora@example.test');
  // Bob has two Jira accounts, linked a day apart, and a GitLab one; Dora has none at Jira.
  await query(
    `insert into user_identities (provider, external_id, user_id, kind, created_at) values
       ('jira-cloud', 'acct-bob-second', $1, 'person', now()),
       ('jira-cloud', 'acct-bob-first', $1, 'person', now() - interval '1 day'),
       ('gitlab', 'bob-on-gitlab', $1, 'person', now() - interval '2 days'),
       ('gitlab', 'dora-on-gitlab', $2, 'person', now()),
       ('jira-cloud', 'acct-build-bot', null, 'machine', now() - interval '3 days')`,
    [users.bob, users.dora],
  );
  const [integration] = await query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name)
     values ($1, 'task_management', 'jira-cloud', 'tracker') returning id`,
    [org?.id],
  );
  await query(
    `insert into bindings (project_id, integration_id, config) values
       ($1, $3, '{"lifecycle": {"claim": false, "assign_owner": true}}'::jsonb),
       ($2, $3, '{"lifecycle": {"claim": false}}'::jsonb)`,
    [optedIn, optedOut, integration?.id],
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

/** A committed live task of `projectId`, owned by `owner` (or nobody) on the platform. */
const ownedTask = async (
  projectId: Id,
  owner: Id | null,
  options: { readonly mode?: TaskMode; readonly provider?: string } = {},
): Promise<Id> => {
  const taskId = nextId();
  const provider = options.provider ?? 'jira-cloud';
  const stored = {
    task: {
      id: taskId,
      projectId,
      ticket: {
        provider,
        key: `WB-${counter}`,
        url: `https://jira.example.test/browse/WB-${counter}`,
      },
      template: 'feature',
      mode: options.mode ?? 'normal',
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
  if (owner !== null) {
    await within((tx) =>
      store.tasks.saveOwner(tx, taskId, {
        expected: { ownerUserId: null, ticketAssignee: null },
        next: { ...UNOWNED, ownerUserId: owner, ownerSource: 'platform', ownerChangedAt: NOW },
      }),
    );
  }
  return taskId;
};

describe('which account the write-back assigns (TaskOwnerDirectory.personIdentity)', () => {
  it('answers the oldest person link of the provider, and nothing for another provider or none', async () => {
    const ask = (userId: Id, provider: string) =>
      within((tx) => store.owners.personIdentity(tx, { userId, provider }));
    expect(await ask(users.bob, 'jira-cloud')).toEqual({ externalId: 'acct-bob-first' });
    expect(await ask(users.bob, 'gitlab')).toEqual({ externalId: 'bob-on-gitlab' });
    expect(await ask(users.dora, 'jira-cloud')).toBeNull();
    expect(await ask(users.dora, 'gitlab')).toEqual({ externalId: 'dora-on-gitlab' });
    expect(await ask(users.bob, 'linear')).toBeNull();
  });
});

describe('the task DTO’s owner_writes_back (criterion 4)', () => {
  it('is true exactly when the binding opts in and the owner has an account at the provider', async () => {
    const drizzled = drizzle(pool, { schema: db.schema });
    const bobs = await ownedTask(optedIn, users.bob);
    const doras = await ownedTask(optedIn, users.dora);
    const nobodys = await ownedTask(optedIn, null);
    const shadow = await ownedTask(optedIn, users.bob, { mode: 'shadow' });
    // Bob has a GitLab account, but this ticket is a platform-issued reference: nothing to assign.
    const platformTicket = await ownedTask(optedIn, users.bob, { provider: 'platform' });
    const elsewhere = await ownedTask(optedOut, users.bob);

    const writesBack = async (projectId: Id): Promise<Record<string, boolean | undefined>> =>
      Object.fromEntries(
        ((await listProjectTasks(drizzled, projectId, { limit: 200 }))?.items ?? []).map((item) => [
          item.id,
          item.owner_writes_back,
        ]),
      );
    const inProject = await writesBack(optedIn);
    expect({
      bobs: inProject[bobs],
      doras: inProject[doras],
      nobodys: inProject[nobodys],
      shadow: inProject[shadow],
      platformTicket: inProject[platformTicket],
    }).toEqual({
      bobs: true,
      doras: false,
      nobodys: false,
      shadow: false,
      platformTicket: false,
    });
    expect((await writesBack(optedOut))[elsewhere]).toBe(false);
  });
});

describe('whether a Take or an Assign… would write back, per person (take_writes_back, review of #97)', () => {
  it('is true for a linked caller and false for an unlinked one, on a task nobody owns', async () => {
    const drizzled = drizzle(pool, { schema: db.schema });
    const ask = (
      projectId: Id,
      task: { readonly ticketProvider?: string; readonly mode?: TaskMode } = {},
    ) =>
      ownerWriteBackFor(
        drizzled,
        {
          projectId,
          ticketProvider: task.ticketProvider ?? 'jira-cloud',
          mode: task.mode ?? 'normal',
        },
        [users.bob, users.dora],
      );
    // The task's current owner plays no part: the question is about the person who would take it.
    const unowned = await ownedTask(optedIn, null);
    const published = (await listProjectTasks(drizzled, optedIn, { limit: 200 }))?.items.find(
      (item) => item.id === unowned,
    );
    expect(published?.owner_writes_back).toBe(false);

    expect(Object.fromEntries(await ask(optedIn))).toEqual({
      [users.bob]: true,
      [users.dora]: false,
    });
    // Dora's GitLab account answers for a GitLab-provider ticket: the identity is per provider.
    expect(Object.fromEntries(await ask(optedIn, { ticketProvider: 'gitlab' }))).toEqual({
      [users.bob]: true,
      [users.dora]: true,
    });
    for (const nobody of [
      await ask(optedIn, { mode: 'shadow' }),
      await ask(optedIn, { ticketProvider: 'platform' }),
      await ask(optedOut),
    ]) {
      expect(Object.fromEntries(nobody)).toEqual({ [users.bob]: false, [users.dora]: false });
    }
  });
});

describe('the owner candidates’ writes_back, of the project or of a task (S-26.3, review of #97)', () => {
  it('answers per candidate, refines from the task, and refuses a task of another project', async () => {
    const drizzled = drizzle(pool, { schema: db.schema });
    const ask = (projectId: Id, taskId: Id | null) =>
      ownerCandidateWriteBack(drizzled, { projectId, taskId }, [users.bob, users.dora]);
    const both = (bob: boolean, dora: boolean) => ({ [users.bob]: bob, [users.dora]: dora });

    // No task: the project's binding (Jira Cloud) — Bob has a Jira account, Dora does not.
    expect(Object.fromEntries((await ask(optedIn, null)) ?? [])).toEqual(both(true, false));
    expect(Object.fromEntries((await ask(optedOut, null)) ?? [])).toEqual(both(false, false));
    // A normal task of the project answers as the project does; shadow and platform-issued read false.
    const normal = await ownedTask(optedIn, null);
    const shadow = await ownedTask(optedIn, null, { mode: 'shadow' });
    const platform = await ownedTask(optedIn, null, { provider: 'platform' });
    expect(Object.fromEntries((await ask(optedIn, normal)) ?? [])).toEqual(both(true, false));
    expect(Object.fromEntries((await ask(optedIn, shadow)) ?? [])).toEqual(both(false, false));
    expect(Object.fromEntries((await ask(optedIn, platform)) ?? [])).toEqual(both(false, false));
    // A task of another project, or one that does not exist: no answer (the route's 404).
    const theirs = await ownedTask(optedOut, null);
    expect(await ask(optedIn, theirs)).toBeNull();
    expect(await ask(optedIn, nextId())).toBeNull();
  });
});
