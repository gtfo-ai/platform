/**
 * `get_task_context` over the read projections, against a real PostgreSQL 18 (WP-54, PROGRESS
 * backlog 83 — criterion 8).
 *
 * The tool's one promise is **this task's record and nobody else's**, so the world has three
 * tasks: the run's own (`MINE`), a second task in the **same** project, and a task in **another**
 * project. Each carries a distinctive string in every place a value is read from — the ticket
 * snapshot, an artifact, a return reason, a merge request, a coverage record, a run, a human action
 * — and every `include` value is asserted to return the first and **neither** of the others (rule
 * 42: a projection that returned nothing would pass the "not theirs" half on its own, so the "mine"
 * half is asserted beside it every time).
 *
 * The refusal half: a value the projection cannot answer — no ticket read, no merge request, no
 * coverage, an artifact stored before redaction existed — comes back `refused` with a reason, never
 * as an invented `null` or `[]`.
 */
import type { Id } from '@platform/contracts';
import { db } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readTaskContext,
  TASK_CONTEXT_MAX_CHARS,
  type TaskContextInclude,
  TaskContextRefusedError,
} from '../../../apps/server/src/queries/task-context-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool, withClient } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;

interface Seeded {
  readonly projectId: Id;
  readonly taskId: Id;
}
let mine: Seeded;
let sibling: Seeded;
let foreign: Seeded;
/** A task of the run's project on which the platform has read nothing and recorded nothing. */
let bare: Seeded;

const ALL: readonly TaskContextInclude[] = [
  'ticket',
  'artifacts',
  'feedback',
  'mr',
  'ci',
  'runs',
  'audit',
];

const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await pool.query<T>(text, values)).rows[0] as T;

/** One task carrying `tag` in every place `get_task_context` reads from. */
const seedTask = async (projectId: string, tag: string): Promise<Seeded> => {
  const snapshot = {
    title: `title ${tag}`,
    description: `description ${tag}`,
    comments: [],
    truncated: false,
    comment_count: 0,
    redaction_count: 0,
    ticket_updated_at: null,
  };
  const coverage = {
    head_sha: 'a'.repeat(40),
    head_pct: 81.5,
    base_branch: 'main',
    base_sha: 'b'.repeat(40),
    base_pct: 80,
    delta_pct: 1.5,
    measured_at: '2026-09-20T10:00:00.000Z',
  };
  const task = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, branch, mr_ref, ticket_snapshot, ticket_snapshot_at, coverage)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/X', 'feature', 'active',
             'code_review', $3, $4::jsonb, $5::jsonb, now(), $6::jsonb) returning id`,
    [
      projectId,
      `KEY-${tag}`,
      `agentic/${tag}`,
      JSON.stringify({
        iid: 7,
        url: `https://git.example.test/acme/api/-/merge_requests/mr-${tag}`,
      }),
      JSON.stringify(snapshot),
      JSON.stringify(coverage),
    ],
  );
  const stage = await one<{ id: string }>(
    `insert into task_stages (task_id, stage, attempt, state, outcome, return_reason, exited_at)
     values ($1, 'implementation', 1, 'exited', 'returned', $2, now()) returning id`,
    [task.id, `return reason ${tag}`],
  );
  const run = await one<{ id: string }>(
    `insert into runs (task_id, task_stage_id, project_id, role, model, prompt_version, status)
     values ($1, $2, $3, 'developer', $4, 'feature@1+developer', 'completed') returning id`,
    [task.id, stage.id, projectId, `model-${tag}`],
  );
  await pool.query(
    `insert into artifacts (task_id, type, version, markdown, data, schema_version,
                            produced_by_run_id, redaction_count)
     values ($1, 'RefinedSpec', 1, null, $2::jsonb, '1', $3, 0),
            ($1, 'RefinedSpec', 2, null, $4::jsonb, '1', $3, 0)`,
    [
      task.id,
      JSON.stringify({ goal: `old goal ${tag}` }),
      run.id,
      JSON.stringify({ goal: `goal ${tag}` }),
    ],
  );
  await pool.query(
    `insert into human_actions (task_id, action, params) values ($1, 'task.retry', $2::jsonb)`,
    [task.id, JSON.stringify({ note: `action ${tag}` })],
  );
  return { projectId: projectId as Id, taskId: task.id as Id };
};

beforeAll(async () => {
  database = await createMigratedDatabase('task-context');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  drizzled = drizzle(pool, { schema: db.schema });

  const org = await one<{ id: string }>(
    "insert into organizations (name) values ('tc') returning id",
  );
  const project = async (key: string) =>
    (
      await one<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, $2, $2, 'https://git.example.test/acme/api.git') returning id`,
        [org.id, key],
      )
    ).id;
  const ours = await project('ours');
  const theirs = await project('theirs');
  mine = await seedTask(ours, 'MINE');
  sibling = await seedTask(ours, 'SIBLING');
  foreign = await seedTask(theirs, 'FOREIGN');
  const bareTask = await one<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state)
     values ($1, 'fake-jira', 'KEY-BARE', 'https://jira.example.test/browse/B', 'feature', 'active')
     returning id`,
    [ours],
  );
  bare = { projectId: ours as Id, taskId: bareTask.id as Id };
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('get_task_context, scoped to the run’s own task', () => {
  it.each(ALL)(
    '%s: answers with this task’s rows and not another task’s or project’s',
    async (value) => {
      const answer = await readTaskContext(drizzled, [value], mine);
      expect(answer.task_id).toBe(mine.taskId);
      expect(Object.keys(answer.sections)).toEqual([value]);
      const section = answer.sections[value];
      expect(section?.status, JSON.stringify(section)).toBe('ok');
      const text = JSON.stringify(section);
      // The run's own task, positively — the half an empty answer would fail.
      const own: Record<TaskContextInclude, string> = {
        ticket: 'title MINE',
        artifacts: 'goal MINE',
        feedback: 'return reason MINE',
        mr: 'mr-MINE',
        ci: '81.5',
        runs: 'model-MINE',
        audit: 'action MINE',
      };
      expect(text).toContain(own[value]);
      // …and neither the sibling task nor the other project's.
      expect(text).not.toContain('SIBLING');
      expect(text).not.toContain('FOREIGN');
    },
  );

  it('serves the latest version of each artifact type, not every version', async () => {
    const answer = await readTaskContext(drizzled, ['artifacts'], mine);
    const text = JSON.stringify(answer.sections.artifacts);
    expect(text).toContain('"goal":"goal MINE"');
    expect(text).not.toContain('old goal MINE');
  });

  it('refuses, by value and with a reason, what the platform has not recorded — never a null', async () => {
    const answer = await readTaskContext(drizzled, ALL, bare);
    for (const value of ['ticket', 'mr', 'ci'] as const) {
      const section = answer.sections[value];
      expect(section?.status, value).toBe('refused');
      expect((section as { reason: string }).reason.length, value).toBeGreaterThan(0);
    }
    // What the platform *can* answer for an empty task is an empty list, which is a fact.
    expect(answer.sections.runs).toMatchObject({ status: 'ok', total: 0, runs: [] });
    expect(answer.sections.audit).toMatchObject({ status: 'ok', actions: [] });
    expect(answer.sections.feedback).toMatchObject({ status: 'ok', returns: [] });
    expect(answer.sections.artifacts).toMatchObject({ status: 'ok', latest_per_type: [] });
  });

  it('refuses an artifact stored before redaction existed rather than serving it', async () => {
    const legacy = await withClient(database.connectionString, async (client) => {
      await client.query(
        'alter table artifacts drop constraint artifacts_redaction_count_recorded',
      );
      try {
        return (
          await client.query<{ id: string }>(
            `insert into artifacts (task_id, type, version, data, schema_version)
             values ($1, 'ImplementationPlan', 1, '{"approach":"unredacted plan"}'::jsonb, '1')
             returning id`,
            [sibling.taskId],
          )
        ).rows[0]?.id as string;
      } finally {
        await client.query(
          `alter table artifacts add constraint artifacts_redaction_count_recorded
           check (redaction_count is not null and redaction_count >= 0) not valid`,
        );
      }
    });
    expect(legacy).toBeDefined();
    const text = JSON.stringify((await readTaskContext(drizzled, ['artifacts'], sibling)).sections);
    expect(text).toContain('"artifact_type":"ImplementationPlan","version":1,"status":"refused"');
    expect(text).not.toContain('unredacted plan');
    // …and the redacted one beside it is still served (rule 42).
    expect(text).toContain('goal SIBLING');
  });

  it('refuses the whole call for a task outside the run’s project, and for no task at all', async () => {
    await expect(
      readTaskContext(drizzled, ['runs'], { taskId: foreign.taskId, projectId: mine.projectId }),
    ).rejects.toThrow(TaskContextRefusedError);
    await expect(
      readTaskContext(drizzled, ['runs'], {
        taskId: '00000000-0000-4000-8000-00000000dead' as Id,
        projectId: mine.projectId,
      }),
    ).rejects.toThrow(/does not exist/);
    // The same foreign task, asked for by its own project, is served (rule 43: the refusal above
    // is about the scope, not about a task the query cannot read).
    const own = await readTaskContext(drizzled, ['runs'], foreign);
    expect(JSON.stringify(own.sections.runs)).toContain('model-FOREIGN');
  });

  /**
   * The byte bound (WP-54 review round 1): a task whose record is far larger than one answer —
   * forty large `human_actions.params` documents and one artifact bigger than a value's share — is
   * answered within `TASK_CONTEXT_MAX_CHARS`, the list says `truncated` and how many it `omitted`,
   * and the oversized artifact is refused by name with where to read it.
   */
  it('bounds the answer, and says what it left out', async () => {
    const big = await seedTask(mine.projectId, 'BIG');
    for (let index = 0; index < 40; index += 1) {
      await pool.query(
        `insert into human_actions (task_id, action, params) values ($1, 'task.retry', $2::jsonb)`,
        [big.taskId, JSON.stringify({ note: `n${String(index)}`, padding: 'p'.repeat(8_000) })],
      );
    }
    await pool.query(
      `insert into artifacts (task_id, type, version, data, schema_version, redaction_count)
       values ($1, 'ImplementationPlan', 1, $2::jsonb, '1', 0)`,
      [big.taskId, JSON.stringify({ approach: 'a'.repeat(200_000) })],
    );
    const answer = await readTaskContext(drizzled, ALL, big);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(TASK_CONTEXT_MAX_CHARS + 500);
    expect(answer.sections.audit).toMatchObject({ status: 'ok', truncated: true });
    expect((answer.sections.audit as unknown as { omitted: number }).omitted).toBeGreaterThan(0);
    const artifacts = JSON.stringify(answer.sections.artifacts);
    expect(artifacts).toContain(
      '"artifact_type":"ImplementationPlan","version":1,"status":"refused"',
    );
    expect(artifacts).toContain('/api/artifacts/');
    // …and the small artifact beside it is still served whole (rule 42).
    expect(artifacts).toContain('goal BIG');
    // A single value asked for alone gets the whole budget, so the same audit keeps more of it.
    const alone = await readTaskContext(drizzled, ['audit'], big);
    expect(
      (alone.sections.audit as unknown as { actions: unknown[] }).actions.length,
    ).toBeGreaterThan((answer.sections.audit as unknown as { actions: unknown[] }).actions.length);
  });
});
