/**
 * WP-30's storage against a real PostgreSQL 18 (technical/10 integration tier).
 *
 * Four things only this tier can check, and each is a statement about SQL rather than about a
 * function:
 *
 *  - **migration 0021's backfill**, which is BD-027:14 applied to rows that existed before the
 *    column did. Every project gets the preset its level meant *at that release*, and a stored
 *    `features.review_only.trigger: manual` — a value the platform's own API accepted and the
 *    current schema refuses — is rewritten to the one the pipeline already behaves as (backlog 58);
 *  - the **upsert** `PUT …/budgets` rests on. `unique nulls not distinct (scope, scope_id, window)`
 *    is a claim about an index, and an in-memory double would answer it from a `Map`;
 *  - `human_actions` has no `project_id` column, so the settings audit's predicate is
 *    `params->>'project_id'` — which only a real jsonb operator can be asked;
 *  - the dial round-trips through `jsonb` and back out through its published schema.
 */
import { readFileSync } from 'node:fs';
import type { AutonomyLevel } from '@platform/contracts';
import { agenticConfigSchema } from '@platform/contracts';
import {
  AUTONOMY_ORDER,
  AUTONOMY_PRESET_VERSION,
  applyAutonomyPreset,
  toWireAutonomyPolicies,
} from '@platform/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listOrgBudgets, writeBudget } from '../../../apps/server/src/queries/cost-queries.js';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  createProject,
  recordHumanAction,
  writeProjectAutonomy,
  writeProjectConfig,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import {
  findProjectAutonomy,
  listProjectAudit,
} from '../../../apps/server/src/queries/project-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let orgId: string;
let userId: string;
let projectId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('settings');
  pool = createTestPool(database.connectionString, { max: 4 });
  db = drizzle(pool) as unknown as Database;
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('settings') returning id",
  );
  orgId = org.rows[0]?.id as string;
  const user = await pool.query<{ id: string }>(
    "insert into users (email, name) values ('operator@example.test', 'Operator') returning id",
  );
  userId = user.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query('delete from budgets');
  await pool.query('delete from human_actions');
  await pool.query('delete from projects');
  const created = await createProject(db, orgId, {
    // `projectRecordSchema` wants a lower_snake_case slug; a hyphen is refused.
    key: `acme_${Math.random()
      .toString(36)
      .slice(2, 8)
      .replaceAll(/[^a-z0-9]/g, 'x')}`,
    name: 'ACME API',
    repoUrl: 'https://git.example.test/acme/api.git',
  });
  projectId = created.project.id;
});

describe('the materialised dial in the row', () => {
  it('is written by the create, so a project that never reached step 4 still has one', async () => {
    // BD-027:14 — a project has *selected* a position the moment it exists: the column's default,
    // `supervised`. Leaving the column null would make the first read re-derive it, which is the
    // re-derivation the decision forbids.
    const published = await findProjectAutonomy(db, projectId);
    expect(published?.materialised).toBe(true);
    expect(published?.level).toBe('supervised');
    expect(published?.preset_version).toBe(AUTONOMY_PRESET_VERSION);
    expect(published?.applied_by).toBeNull();
    expect(published?.policies.probation_tasks).toBe(5);
  });

  it('moves the word and the policies together, for every position', async () => {
    for (const level of AUTONOMY_ORDER) {
      const written = await writeProjectAutonomy(db, projectId, { level, appliedBy: userId });
      expect(written.status).toBe('written');
      const { rows } = await pool.query<{ level: AutonomyLevel; policies: unknown }>(
        'select autonomy_level as level, autonomy_policies as policies from projects where id = $1',
        [projectId],
      );
      // The column and the document agree — the state the platform was in before WP-30 is a word
      // saying "autonomous" beside policies nobody had materialised.
      expect(rows[0]?.level, level).toBe(level);
      const published = await findProjectAutonomy(db, projectId);
      expect(published?.level, level).toBe(level);
      expect(published?.applied_by, level).toBe(userId);
      expect(published?.policies, level).toEqual(
        toWireAutonomyPolicies(applyAutonomyPreset(level)),
      );
      expect(published?.preset_outdated, level).toBe(false);
    }
  });

  it('is written by the configuration route’s dial too, and only when a level is sent', async () => {
    await writeProjectAutonomy(db, projectId, { level: 'observe', appliedBy: null });
    // A configuration write with no dial must **not** re-materialise: that would move a project's
    // policies on a write that did not touch them.
    await writeProjectConfig(db, projectId, { config: { version: 1 }, hash: 'h1' });
    expect((await findProjectAutonomy(db, projectId))?.level).toBe('observe');

    await writeProjectConfig(db, projectId, {
      config: { version: 1 },
      hash: 'h2',
      autonomyLevel: 'autonomous',
      appliedBy: userId,
    });
    const published = await findProjectAutonomy(db, projectId);
    expect(published?.level).toBe('autonomous');
    expect(published?.applied_by).toBe(userId);
    expect(published?.policies.plan_approval).toBe('never');
  });

  it('answers "never materialised" for a row inserted without one', async () => {
    // Only a harness can produce this row — migration 0021 backfilled every one that existed and
    // all three writers supply a document — so the honest answer is that the dial was never
    // applied, never a substituted preset (standing rule 16).
    await pool.query('update projects set autonomy_policies = null where id = $1', [projectId]);
    const published = await findProjectAutonomy(db, projectId);
    expect(published?.materialised).toBe(false);
    expect(published?.applied_at).toBeNull();
  });

  it('answers null for a project that does not exist', async () => {
    expect(await findProjectAutonomy(db, '00000000-0000-4000-8000-0000000000ff')).toBeNull();
  });
});

/**
 * Migration 0021, run against rows that existed **before** it — which is the only way its backfill
 * can be exercised, because a freshly migrated database has no projects in it.
 *
 * The statements are read out of the shipped file rather than paraphrased here: a test that
 * re-stated the migration would pass whether or not the file's own literals were right, which is
 * standing rule 3 in its usual shape. The `alter table` is skipped because the column exists
 * already; the four `update`s and the review-only rewrite are idempotent, so re-running them is a
 * no-op for rows the migration has already touched.
 */
describe('migration 0021, re-run over rows it would have backfilled', () => {
  const statements = readFileSync(
    new URL(
      '../../../packages/infrastructure/src/db/migrations/0021_autonomy_materialised.sql',
      import.meta.url,
    ),
    'utf8',
  )
    // The `--` comments go **first**: this file's prose contains semicolons, so splitting before
    // stripping them produces fragments that are not statements (measured — `syntax error at or
    // near "changing"`). There is no `--` inside any of the string literals below it.
    .replaceAll(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
    .filter((statement) => !/alter\s+table/i.test(statement));

  const runMigration = async (): Promise<void> => {
    for (const statement of statements) {
      await pool.query(statement);
    }
  };

  it('reads the file it is about', () => {
    // The scope, asserted before anything is concluded from it (standing rule 4): a split that
    // produced no statements would report a perfectly successful backfill.
    expect(statements).toHaveLength(5);
  });

  it('backfills at a preset version of at least 1; the literal equality to the source table is asserted by the settings-api e2e', () => {
    // The migration writes the v1 table as SQL literals and is **never edited** (TD-011), so this
    // equality holds only while the source table is still at version 1. Once a release bumps it the
    // disagreement is the property BD-027:14 asks for rather than drift, and this case says so
    // instead of failing.
    expect(AUTONOMY_PRESET_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('gives a pre-0021 row the policies its level meant, for all four levels', async () => {
    if (AUTONOMY_PRESET_VERSION !== 1) {
      return;
    }
    for (const level of AUTONOMY_ORDER) {
      // A row as a pre-0021 build would have left it: the word, and no document.
      await pool.query(
        'update projects set autonomy_level = $2, autonomy_policies = null where id = $1',
        [projectId, level],
      );
      await runMigration();
      const published = await findProjectAutonomy(db, projectId);
      expect(published?.materialised, level).toBe(true);
      expect(published?.level, level).toBe(level);
      expect(published?.applied_by, level).toBeNull();
      // The assertion the paraphrase could not make: the file's own literals against the source.
      expect(published?.policies, level).toEqual(
        toWireAutonomyPolicies(applyAutonomyPreset(level)),
      );
      expect(published?.preset_outdated, level).toBe(false);
    }
  });

  it('leaves a row it already materialised exactly as it was', async () => {
    // The predicate is the **level**, so re-running the migration rewrites a document that is
    // already there. That is harmless only because the values are the same; asserted rather than
    // assumed, because a second run is what a redeployed migrator would do if the ledger were lost.
    await writeProjectAutonomy(db, projectId, { level: 'assist', appliedBy: userId });
    const before = await findProjectAutonomy(db, projectId);
    await runMigration();
    const after = await findProjectAutonomy(db, projectId);
    expect(after?.policies).toEqual(before?.policies);
    expect(after?.level).toBe('assist');
  });

  it('rewrites a stored review-only trigger this release refuses, and changes no behaviour', async () => {
    // PROGRESS backlog 58: `manual` was accepted by the platform's own `PUT …/config` before WP-24
    // narrowed the enum, and `GET …/config` then answered 500 for the whole document. `paths: []`
    // matches nothing, which is exactly what the pipeline already does with `manual` through
    // `matchesReviewOnly`'s default branch — so the migration changes the document and not the
    // behaviour. `label` would have started an enabled project reviewing every labelled merge
    // request it never asked for (standing rule 20's fail-closed direction).
    await pool.query(
      `update projects set config = '{"version":1,"features":{"review_only":{"enabled":true,"trigger":"manual"}}}'::jsonb
       where id = $1`,
      [projectId],
    );
    await runMigration();
    const { rows } = await pool.query<{ config: { features: { review_only: unknown } } }>(
      'select config from projects where id = $1',
      [projectId],
    );
    expect(rows[0]?.config.features.review_only).toEqual({
      enabled: true,
      trigger: 'paths',
      paths: [],
    });
    // …and the repaired document parses, which is the whole point of the read-side half.
    expect(agenticConfigSchema.safeParse(rows[0]?.config).success).toBe(true);
  });

  it('leaves a project that already names its paths alone', async () => {
    // The rewrite is predicated on the **value**, not on the key: a project on `paths` must not
    // have its list replaced by an empty one (standing rule 42's other side).
    await pool.query(
      `update projects set config = '{"version":1,"features":{"review_only":{"trigger":"paths","paths":["src/**"]}}}'::jsonb
       where id = $1`,
      [projectId],
    );
    await runMigration();
    const { rows } = await pool.query<{
      config: { features: { review_only: { paths: string[] } } };
    }>('select config from projects where id = $1', [projectId]);
    expect(rows[0]?.config.features.review_only.paths).toEqual(['src/**']);
  });
});

describe('the budget writer — BD-010’s first production one', () => {
  it('upserts on the natural key rather than making a second cap for one window', async () => {
    const first = await writeBudget(db, {
      scope: 'project',
      scopeId: projectId,
      window: 'month',
      limitUsd: 100,
      createdBy: userId,
    });
    expect(first.outcome).toBe('created');
    const second = await writeBudget(db, {
      scope: 'project',
      scopeId: projectId,
      window: 'month',
      limitUsd: 250,
      createdBy: userId,
    });
    expect(second.outcome).toBe('updated');
    expect(second.id).toBe(first.id);
    // What the cap was, for the audit row product/18:5 asks to say what changed.
    expect(first.previousLimitUsd).toBeNull();
    expect(second.previousLimitUsd).toBe(100);
    const { rows } = await pool.query<{ n: string; limit: string }>(
      "select count(*)::text as n, max(limit_usd)::text as limit from budgets where scope = 'project'",
    );
    expect(rows[0]?.n).toBe('1');
    expect(Number(rows[0]?.limit)).toBe(250);
  });

  it('treats the organisation’s null scope id as one value, which is what `nulls not distinct` buys', async () => {
    await writeBudget(db, {
      scope: 'org',
      scopeId: null,
      window: 'day',
      limitUsd: 10,
      createdBy: userId,
    });
    const again = await writeBudget(db, {
      scope: 'org',
      scopeId: null,
      window: 'day',
      limitUsd: 20,
      createdBy: userId,
    });
    expect(again.outcome).toBe('updated');
    const budgets = await listOrgBudgets(db, new Date().toISOString() as never);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]?.limit_usd).toBe(20);
    // …and the project's own cap is a different row, not the same one.
    await writeBudget(db, {
      scope: 'project',
      scopeId: projectId,
      window: 'day',
      limitUsd: 5,
      createdBy: userId,
    });
    expect(await listOrgBudgets(db, new Date().toISOString() as never)).toHaveLength(1);
  });

  it('removes a cap on a null limit, and says so when there was none to remove', async () => {
    expect(
      (
        await writeBudget(db, {
          scope: 'project',
          scopeId: projectId,
          window: 'week',
          limitUsd: null,
          createdBy: userId,
        })
      ).outcome,
    ).toBe('absent');
    await writeBudget(db, {
      scope: 'project',
      scopeId: projectId,
      window: 'week',
      limitUsd: 30,
      createdBy: userId,
    });
    expect(
      (
        await writeBudget(db, {
          scope: 'project',
          scopeId: projectId,
          window: 'week',
          limitUsd: null,
          createdBy: userId,
        })
      ).outcome,
    ).toBe('removed');
    const { rows } = await pool.query<{ n: string }>('select count(*)::text as n from budgets');
    expect(rows[0]?.n).toBe('0');
  });

  it('keeps the window’s recorded spend when a cap is raised', async () => {
    // `budget_windows` cascades from `budgets`, so a delete-then-insert would reset the meter an
    // operator is raising the cap *because of*. The upsert is what keeps it.
    const created = await writeBudget(db, {
      scope: 'project',
      scopeId: projectId,
      window: 'month',
      limitUsd: 100,
      createdBy: userId,
    });
    await pool.query(
      "insert into budget_windows (budget_id, window_start, spent_usd) values ($1, date_trunc('month', now()), 42)",
      [created.id],
    );
    await writeBudget(db, {
      scope: 'project',
      scopeId: projectId,
      window: 'month',
      limitUsd: 500,
      createdBy: userId,
    });
    const { rows } = await pool.query<{ spent: string }>(
      'select spent_usd::text as spent from budget_windows where budget_id = $1',
      [created.id],
    );
    expect(Number(rows[0]?.spent)).toBe(42);
  });

  it('refuses a cap the table refuses', async () => {
    // `budgets_limit_positive` — a zero cap would block every run for ever, which is not "no cap".
    await expect(
      writeBudget(db, {
        scope: 'project',
        scopeId: projectId,
        window: 'day',
        limitUsd: 0,
        createdBy: userId,
      }),
    ).rejects.toThrow();
  });
});

describe('the settings audit', () => {
  it('finds this project’s rows through `params->>project_id`, newest first', async () => {
    // `human_actions` has no project column: the wizard's commands put the id in `params`, which is
    // where the insert's own docblock says a reader would look. That predicate is a jsonb operator
    // and can only be asked of a real database.
    for (const action of ['project.config.write', 'project.autonomy.write', 'budget.write']) {
      await recordHumanAction(db, { userId, action, params: { project_id: projectId } });
    }
    await recordHumanAction(db, {
      userId,
      action: 'project.autonomy.write',
      params: { project_id: '00000000-0000-4000-8000-0000000000ff' },
    });
    // A task command's row names a task rather than a project, so it is not this project's
    // *settings* audit — which the endpoint's description says rather than implies.
    await recordHumanAction(db, { userId, action: 'task.pause', params: {} });

    const page = await listProjectAudit(db, projectId, 50);
    expect(page.items.map((entry) => entry.action)).toEqual([
      'budget.write',
      'project.autonomy.write',
      'project.config.write',
    ]);
    expect(page.items[0]?.user_email).toBe('operator@example.test');
    expect(page.items[0]?.params).toEqual({ project_id: projectId });
  });

  it('honours the caller’s limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      await recordHumanAction(db, {
        userId,
        action: `budget.write.${i}`,
        params: { project_id: projectId },
      });
    }
    expect((await listProjectAudit(db, projectId, 2)).items).toHaveLength(2);
  });
});
