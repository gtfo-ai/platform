/**
 * **A change of the default branch against a real PostgreSQL 18** (WP-142, backlog 441 and 442).
 *
 * Two properties the unit tier cannot express, because both are about locks and committed rows:
 *
 *  1. **Task creation and a change serialise.** The production `tasks.insert` takes the project row
 *     `for share` before it inserts, and the production change (`writeProjectDefaultBranch`) takes
 *     it `for update` and counts the live tasks under it. So a task whose transaction is open when a
 *     change starts makes the change **wait**, and the change then counts it and refuses
 *     (`live_tasks`) — the instant WP-139 named as its residual. The second case is the reason the
 *     lock is `for share` rather than the foreign key's own `for key share`: a writer that takes the
 *     row `for no key update` (what a plain `update projects` takes) also waits, so the guarantee
 *     does not rest on the change taking the strongest lock. With the `for share` line removed from
 *     the store, the first case still passes (the foreign key's check conflicts with `for update`)
 *     and the second fails — which is what the canary under WP-142 measured.
 *  2. **A change resets the poll's baseline.** `bindings.mr_poll_default_head` is cleared in the
 *     change's transaction, and the poll store then answers the new branch with no head, so the next
 *     poll takes a baseline (`first_read`) and records no `default_branch.moved`.
 */
import { randomUUID } from 'node:crypto';
import type { StoredTask, Transaction } from '@platform/application';
import { DefaultBranchChangedError, INITIAL_TASK_VERSION } from '@platform/application';
import type { Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { pipeline as pipelineAdapters } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import { writeProjectDefaultBranch } from '../../../apps/server/src/queries/onboarding-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('default-branch-change');
  pool = createTestPool(database.connectionString, { max: 6 });
  db = drizzle(pool) as unknown as Database;
  orgId =
    (
      await pool.query<{ id: string }>(
        "insert into organizations (name) values ('wp142') returning id",
      )
    ).rows[0]?.id ?? '';
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const newProject = async (): Promise<Id> =>
  (
    await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url, default_branch)
       values ($1, $2, 'Autix', 'https://git.example.test/acme/autix.git', 'develop') returning id`,
      [orgId, `autix_${randomUUID().slice(0, 8).replace(/-/g, '')}`],
    )
  ).rows[0]?.id as Id;

const storedTask = (projectId: Id): StoredTask =>
  ({
    task: {
      id: randomUUID() as Id,
      projectId,
      ticket: {
        provider: 'fake-jira',
        key: `AUT-${Math.floor(Math.random() * 1_000_000)}`,
        url: 'https://tickets.example.test/browse/AUT-1',
      },
      template: 'feature',
      mode: 'normal',
      state: 'queued',
      currentStage: null,
      stageAttempts: {},
      iterationCounters: {},
      limits: { code_review: 3, business_review: 2, ci_fix: 3, human_rounds: 3 },
      requestedBy: null,
      sequence: 1,
    },
    template: SHIPPED_TEMPLATES.feature,
    priorityRank: 1,
    createdAt: new Date().toISOString(),
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
    pipelineDial: null,
    qaStage: false,
    version: INITIAL_TASK_VERSION,
  }) as unknown as StoredTask;

/** A connection with an open transaction, ended by the caller (or by the `finally` on a throw). */
const openTransaction = async (): Promise<{
  client: pg.Client;
  tx: Transaction;
  end: (verb: 'commit' | 'rollback') => Promise<void>;
}> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  await client.query('begin');
  let ended = false;
  return {
    client,
    tx: { adapter: 'postgres', client } as unknown as Transaction,
    end: async (verb) => {
      if (ended) {
        return;
      }
      ended = true;
      await client.query(verb).catch(() => {});
      await client.end().catch(() => {});
    },
  };
};

/**
 * Is a backend waiting on a lock with `needle` in its query? Read until a bounded deadline: the
 * waiting statement was started before this is asked, and a backend reaches the lock wait within
 * milliseconds — the 5 s is a bound for a loaded machine, never a sleep the test relies on.
 */
const waitsOnLock = async (needle: string, deadlineMs = 5_000): Promise<boolean> => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from pg_stat_activity
        where wait_event_type = 'Lock' and query like '%' || $1 || '%'`,
      [needle],
    );
    if (Number(rows[0]?.n ?? 0) > 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const store = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });

describe('a task created at the instant of a default-branch change (WP-142, backlog 442)', () => {
  it('makes the change wait for the task’s transaction, which it then counts and refuses on', async () => {
    const projectId = await newProject();
    const intake = await openTransaction();
    try {
      await store.tasks.insert(intake.tx, storedTask(projectId));

      let settled = false;
      const change = writeProjectDefaultBranch(db, projectId, 'main').finally(() => {
        settled = true;
      });
      expect(await waitsOnLock('from "projects"')).toBe(true);
      expect(settled).toBe(false);

      await intake.end('commit');
      expect(await change).toEqual({ status: 'live_tasks', count: 1 });
    } finally {
      await intake.end('rollback');
    }
    const row = await pool.query<{ default_branch: string }>(
      'select default_branch from projects where id = $1',
      [projectId],
    );
    expect(row.rows[0]?.default_branch).toBe('develop');
  });

  it('holds a writer that takes the row `for no key update` too, so it does not rest on the change’s lock strength', async () => {
    const projectId = await newProject();
    const intake = await openTransaction();
    const writer = await openTransaction();
    try {
      await store.tasks.insert(intake.tx, storedTask(projectId));

      let settled = false;
      const weaker = writer.client
        .query('select 1 from projects where id = $1 for no key update /* wp142-weaker */', [
          projectId,
        ])
        .finally(() => {
          settled = true;
        });
      expect(await waitsOnLock('wp142-weaker')).toBe(true);
      expect(settled).toBe(false);

      await intake.end('commit');
      await weaker;
      const counted = await writer.client.query<{ n: string }>(
        `select count(*)::text as n from tasks where project_id = $1`,
        [projectId],
      );
      expect(counted.rows[0]?.n).toBe('1');
    } finally {
      await intake.end('rollback');
      await writer.end('rollback');
    }
  });

  it('lets a task created after the change commit start on the new branch, and two creations share the lock', async () => {
    const projectId = await newProject();
    expect((await writeProjectDefaultBranch(db, projectId, 'main')).status).toBe('written');
    const first = await openTransaction();
    const second = await openTransaction();
    try {
      // Two creations at once: `for share` is shared, so neither waits for the other.
      await store.tasks.insert(first.tx, storedTask(projectId));
      await store.tasks.insert(second.tx, storedTask(projectId));
      await first.end('commit');
      await second.end('commit');
    } finally {
      await first.end('rollback');
      await second.end('rollback');
    }
    const counted = await pool.query<{ n: string }>(
      'select count(*)::text as n from tasks where project_id = $1',
      [projectId],
    );
    expect(counted.rows[0]?.n).toBe('2');
  });
});

/**
 * **Intake's check and its insert against a change in between** (WP-149, backlog 443). The lock
 * orders a change with an *open* creation; a change that committed **between** intake's protection
 * check (outside any transaction) and the insert's transaction is invisible to it. The guarded insert
 * re-reads `projects.default_branch` under its `for share` lock and refuses when it is not the branch
 * intake checked. The interleaving is driven: the branch is read, the change commits, the insert runs.
 */
describe('intake’s insert re-reads the branch it checked, under the project lock (WP-149, backlog 443)', () => {
  it('refuses a task whose checked branch was changed before its transaction, and writes nothing', async () => {
    const projectId = await newProject();
    // Intake's read and check: the stored branch is `develop`.
    const checked = (
      await pool.query<{ default_branch: string }>(
        'select default_branch from projects where id = $1',
        [projectId],
      )
    ).rows[0]?.default_branch as string;
    expect(checked).toBe('develop');
    // The change commits while the provider is being asked (no task is live, so it is allowed).
    expect((await writeProjectDefaultBranch(db, projectId, 'main')).status).toBe('written');

    const intake = await openTransaction();
    try {
      const refused = await store.tasks
        .insert(intake.tx, storedTask(projectId), { defaultBranch: checked })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(DefaultBranchChangedError);
      expect(refused).toMatchObject({ checked: 'develop', stored: 'main' });
    } finally {
      await intake.end('rollback');
    }
    const counted = await pool.query<{ n: string }>(
      'select count(*)::text as n from tasks where project_id = $1',
      [projectId],
    );
    expect(counted.rows[0]?.n).toBe('0');
  });

  it('inserts when the branch it checked is still the stored one, and a change then waits and counts it', async () => {
    const projectId = await newProject();
    const intake = await openTransaction();
    try {
      await store.tasks.insert(intake.tx, storedTask(projectId), { defaultBranch: 'develop' });
      let settled = false;
      const change = writeProjectDefaultBranch(db, projectId, 'main').finally(() => {
        settled = true;
      });
      expect(await waitsOnLock('from "projects"')).toBe(true);
      expect(settled).toBe(false);
      await intake.end('commit');
      expect(await change).toEqual({ status: 'live_tasks', count: 1 });
    } finally {
      await intake.end('rollback');
    }
  });
});

describe('a change of the default branch resets the poll’s baseline (WP-142, backlog 441)', () => {
  const bindGit = async (projectId: Id): Promise<Id> => {
    const integration = await pool.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name)
       values ($1, 'git', 'fake-git', $2) returning id`,
      [orgId, `git-${randomUUID().slice(0, 8)}`],
    );
    const integrationId = integration.rows[0]?.id as Id;
    await pool.query(
      `insert into bindings (project_id, integration_id, mr_poll_default_head)
       values ($1, $2, $3)`,
      [projectId, integrationId, 'a'.repeat(40)],
    );
    return integrationId;
  };

  it('clears the head the last poll saw in the change’s transaction, so the poll store answers the new branch with no head', async () => {
    const projectId = await newProject();
    const integrationId = await bindGit(projectId);
    const polls = pipelineAdapters.createPostgresMergeRequestPollStore({ sql: pool });
    expect(await polls.defaultHeadOf({ projectId, integrationId })).toEqual({
      branch: 'develop',
      head: 'a'.repeat(40),
    });

    expect((await writeProjectDefaultBranch(db, projectId, 'main')).status).toBe('written');

    expect(await polls.defaultHeadOf({ projectId, integrationId })).toEqual({
      branch: 'main',
      head: null,
    });
    // A poll that read the old branch while the change committed writes nothing of it.
    await polls.recordDefaultHead({ projectId, integrationId }, 'b'.repeat(40), 'develop');
    expect(await polls.defaultHeadOf({ projectId, integrationId })).toEqual({
      branch: 'main',
      head: null,
    });
  });

  it('keeps the head when the branch written is the branch already stored', async () => {
    const projectId = await newProject();
    const integrationId = await bindGit(projectId);
    expect((await writeProjectDefaultBranch(db, projectId, 'develop')).status).toBe('written');
    const polls = pipelineAdapters.createPostgresMergeRequestPollStore({ sql: pool });
    expect(await polls.defaultHeadOf({ projectId, integrationId })).toEqual({
      branch: 'develop',
      head: 'a'.repeat(40),
    });
  });
});
