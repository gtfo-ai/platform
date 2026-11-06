/**
 * What an approval approves, against a real PostgreSQL 18 (S-25.1, TD-035 decisions 3–6).
 *
 * Three claims a fake cannot make:
 *
 * 1. **Old rows read *not recorded*, and nothing is invented.** A plan approval written as a
 *    pre-0103 build wrote it — no `subject_artifact_id`, no `reasons` — gets `subject: null` and
 *    `reasons: null` from the task read and the inbox read alike, even though the task **has** a
 *    plan: "the task's latest plan" is exactly the guess TD-035 rejects.
 * 2. **The one exact chain is the only derivation.** A pre-0103 row whose stage attempt produced
 *    exactly one `ImplementationPlan` (`artifacts.produced_by_run_id → runs.task_stage_id →
 *    task_stages`) reads `basis: 'derived'`; two plans at the end of the chain read `null`.
 * 3. **The read and the decide command name the same plan.** The read derives in Drizzle
 *    (`apps/server/src/queries/approval-views.ts`) and the store in SQL
 *    (`ApprovalRepository.planSubject`); every case asks both, so the two cannot drift.
 *
 * Rows are seeded with SQL: the cases are the shapes the pipeline no longer writes.
 */
import type { Transaction } from '@platform/application';
import type { ApprovalView, Id } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import { db, pipeline as pipelineAdapters } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTaskDetail, listInbox } from '../../../apps/server/src/queries/pipeline-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;
let projectId: string;

const one = async <T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T> => {
  const result = await pool.query<T>(text, values);
  return result.rows[0] as T;
};

/** A task at `waiting_approval` with a stage attempt `architecture/1` and its run. */
const taskWithAttempt = async (key: string) => {
  const task = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/' || $2, 'feature',
             'waiting_approval', 'architecture') returning id`,
    [projectId, key],
  );
  const stage = await one<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state, outcome)
     values ($1, 'architecture', 1, 'completed', 'approve') returning id`,
    [task.id],
  );
  const run = await one<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, prompt_version, status)
     values ($1, $2, $3, 'architect', 'claude-opus-5', 'feature@1+architect', 'completed')
     returning id`,
    [task.id, stage.id, projectId],
  );
  return { taskId: task.id, runId: run.id };
};

const plan = async (taskId: string, version: number, producedByRunId: string | null) =>
  (
    await one<{ id: string }>(
      // `redaction_count` is required of every new artifact (migration 0038's
      // `artifacts_redaction_count_recorded`): 0 is "the redactor ran and replaced nothing".
      `insert into artifacts (task_id, type, version, data, schema_version, produced_by_run_id,
                              redaction_count)
       values ($1, 'ImplementationPlan', $2, '{"estimated_size": "L"}'::jsonb, '1', $3, 0)
       returning id`,
      [taskId, version, producedByRunId],
    )
  ).id;

/** A pending plan approval for `architecture/1`, as the given build would have written it. */
const approval = async (
  taskId: string,
  recorded: { subject: string; reasons: unknown } | null = null,
) =>
  (
    await one<{ id: string }>(
      `insert into approvals (task_id, kind, status, stage, attempt, subject_artifact_id, reasons)
       values ($1, 'plan', 'pending', 'architecture', 1, $2, $3::jsonb) returning id`,
      [
        taskId,
        recorded?.subject ?? null,
        recorded === null ? null : JSON.stringify(recorded.reasons),
      ],
    )
  ).id;

/** The store's answer — the decide command's subject — inside a rolled-back transaction. */
const storeSubject = async (approvalId: string) => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    await client.query('begin');
    const tx = { adapter: 'postgres', client } as unknown as Transaction;
    const store = pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES });
    return await store.approvals.planSubject(tx, approvalId as Id);
  } finally {
    await client.query('rollback');
    await client.end();
  }
};

const readBoth = async (taskId: string, approvalId: string) => {
  const detail = await findTaskDetail(drizzled, taskId);
  const inbox = await listInbox(drizzled);
  const fromTask = detail?.approvals.find((row) => row.id === approvalId) as ApprovalView;
  const fromInbox = inbox.approvals.find((row) => row.id === approvalId) as ApprovalView;
  // One function serves both reads: the page that decides and the list that points at it agree.
  expect(fromInbox).toEqual(fromTask);
  return fromTask;
};

beforeAll(async () => {
  database = await createMigratedDatabase('approval-subject');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  drizzled = drizzle(pool, { schema: db.schema });
  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('approvals') returning id",
  );
  projectId = (
    await one<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
      [org.id],
    )
  ).id;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('an approval’s subject and reasons (TD-035)', () => {
  it('reads a recorded plan with its version, and the stored reasons', async () => {
    const { taskId, runId } = await taskWithAttempt('ACME-10');
    await plan(taskId, 1, runId);
    const second = await plan(taskId, 2, runId);
    const reasons = [{ code: 'size_at_or_above', size: 'L', threshold: 'L', source: 'dial' }];
    const id = await approval(taskId, { subject: second, reasons });

    const view = await readBoth(taskId, id);
    expect(view.subject).toEqual({
      kind: 'plan',
      artifact_id: second,
      artifact_version: 2,
      stage: 'architecture',
      attempt: 1,
      basis: 'recorded',
    });
    expect(view.reasons).toEqual(reasons);
    expect(await storeSubject(id)).toEqual({ artifactId: second, basis: 'recorded' });
  });

  it('reads an old row whose chain pins nothing as not recorded, though the task has a plan', async () => {
    const { taskId } = await taskWithAttempt('ACME-11');
    // A plan nothing links to the attempt (no producing run): the task's latest plan, and still
    // not the subject — that would be the guess TD-035 rejects.
    await plan(taskId, 1, null);
    const id = await approval(taskId);

    const view = await readBoth(taskId, id);
    expect(view.subject).toBeNull();
    expect(view.reasons).toBeNull();
    expect(await storeSubject(id)).toBeNull();
  });

  it('derives an old row’s plan by the one exact chain, and labels it derived', async () => {
    const { taskId, runId } = await taskWithAttempt('ACME-12');
    const only = await plan(taskId, 1, runId);
    const id = await approval(taskId);

    const view = await readBoth(taskId, id);
    expect(view.subject).toEqual({
      kind: 'plan',
      artifact_id: only,
      artifact_version: 1,
      stage: 'architecture',
      attempt: 1,
      basis: 'derived',
    });
    // Reasons are never derived: the policy may have changed since.
    expect(view.reasons).toBeNull();
    expect(await storeSubject(id)).toEqual({ artifactId: only, basis: 'derived' });
  });

  it('derives nothing when the chain ends in two plans', async () => {
    const { taskId, runId } = await taskWithAttempt('ACME-13');
    await plan(taskId, 1, runId);
    await plan(taskId, 2, runId);
    const id = await approval(taskId);

    expect((await readBoth(taskId, id)).subject).toBeNull();
    expect(await storeSubject(id)).toBeNull();
  });

  it('reads a budget approval’s figures, and a pre-0103 one as not recorded', async () => {
    const { taskId } = await taskWithAttempt('ACME-14');
    const detail = {
      estimate_usd: 61.5,
      threshold_usd: 50,
      estimate_basis: 'project_history',
      estimate_samples: 7,
    };
    const recorded = (
      await one<{ id: string }>(
        `insert into approvals (task_id, kind, status, stage, attempt, subject_detail, reasons)
         values ($1, 'budget', 'pending', 'refinement', 1, $2::jsonb, $3::jsonb) returning id`,
        [
          taskId,
          JSON.stringify(detail),
          JSON.stringify([
            { code: 'estimate_above_threshold', estimate_usd: 61.5, threshold_usd: 50 },
          ]),
        ],
      )
    ).id;
    const old = (
      await one<{ id: string }>(
        `insert into approvals (task_id, kind, status, stage, attempt)
         values ($1, 'budget', 'pending', 'refinement', 1) returning id`,
        [taskId],
      )
    ).id;

    expect((await readBoth(taskId, recorded)).subject).toEqual({ kind: 'budget', ...detail });
    const unrecorded = await readBoth(taskId, old);
    expect(unrecorded.subject).toBeNull();
    expect(unrecorded.reasons).toBeNull();
    // A budget approval has no plan to approve, whatever is in its row.
    expect(await storeSubject(recorded)).toBeNull();
  });

  it('refuses an empty reason list at the column (migration 0103)', async () => {
    const { taskId } = await taskWithAttempt('ACME-15');
    await expect(
      approval(taskId, { subject: await plan(taskId, 1, null), reasons: [] }),
    ).rejects.toThrow(/approvals_reasons_not_empty/);
  });
});
