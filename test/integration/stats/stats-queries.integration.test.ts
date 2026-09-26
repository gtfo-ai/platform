/**
 * The statistics reads against a real PostgreSQL 18 (technical/10 integration tier, WP-41).
 *
 * **The two projections this work package owns are never seeded** (standing rule 82, criterion 8):
 * the delivery row and the counters are produced by dispatching real events through the real
 * `EventBus` into the real adapter, because a tier that inserted them would certify nothing about
 * the fold. The rows this endpoint *reads from other components* — `tasks`, `task_stages`,
 * `questions`, `human_time_entries`, `cost_entries`, `kb_proposals` — are seeded, since they are
 * those components' output and their own tiers assert how they come to exist.
 *
 * What only a database can show, and what this file is therefore for:
 *
 *  - **the returns predicate**. The return is read off `outcome`. Until WP-55 `task_stages.state`
 *    only ever held `entered`/`exited`, so a predicate on `state = 'returned'` matched nothing and
 *    published a return rate of exactly zero on every instance — a silent zero no fake would have
 *    caught. Since migration 0040 a return's row is `state = 'returned'` too, and the predicate
 *    stays on `outcome` because rows closed before WP-55 carried the return there first;
 *  - **the template filter**, which decides what "tasks started" means: a discovery task is
 *    `mode = 'normal'` and can never open a merge request;
 *  - **PROGRESS backlog 89's read-side cap**, which is a `least(sum(...), 480)` over a group key
 *    the projector deliberately cannot use;
 *  - **the civil-day arithmetic in a zone that is not UTC**, which is where an instant comparison
 *    and a date comparison disagree.
 */
import { EventBus, statsHandlers } from '@platform/application';
import type { DomainEvent } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { db as dbAdapters, eventing, stats } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  foldStats,
  resolveRange,
  type StatsSources,
} from '../../../apps/server/src/queries/stats-metrics.js';
import {
  MAX_TASK_ROWS,
  readStatsSources,
  StatsRangeTooLargeError,
} from '../../../apps/server/src/queries/stats-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const APP_ROLE = 'platform_app';
const ZONE = 'Europe/Prague';

/**
 * The clock every case is written against: **24 hours ago**, so that "today" is complete and no
 * case straddles midnight while the suite runs.
 *
 * Each case seeds on a civil day of its own — the offsets below are hours apart on purpose — because
 * the reads are over the whole range and a count taken on a shared day would be a count of what
 * every other case wrote (standing rule 10).
 */
const BASE_MS = Math.floor((Date.now() - 24 * 60 * 60_000) / 1000) * 1000;
const at = (minutes: number): string => new Date(BASE_MS + minutes * 60_000).toISOString();

const dayOf = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date(iso));

describe('the statistics reads (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let unitOfWork: eventing.PostgresUnitOfWork;
  let db: dbAdapters.Database;
  let orgId: string;
  let projectId: string;
  let otherProjectId: string;
  /** Per **stream**: `events` enforces `(stream_type, stream_id, stream_seq)` globally. */
  const sequences = new Map<string, number>();

  beforeAll(async () => {
    database = await createMigratedDatabase('stats-queries');
    pool = createTestPool(database.connectionString, {
      options: `-c role=${APP_ROLE}`,
      max: 8,
      connectionTimeoutMillis: 5_000,
    });
    unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    db = drizzle(pool, { schema: dbAdapters.schema }) as unknown as dbAdapters.Database;
    const org = await pool.query<{ id: string }>(
      'insert into organizations (name, timezone) values ($1, $2) returning id',
      ['stats', ZONE],
    );
    orgId = org.rows[0]?.id as string;
    projectId = await seedProject('api');
    otherProjectId = await seedProject('web');
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const seedProject = async (key: string): Promise<string> => {
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'API', 'https://git.example.test/acme/api.git') returning id`,
      [orgId, `${key}-${Math.random().toString(16).slice(2)}`],
    );
    return project.rows[0]?.id as string;
  };

  const seedTask = async (input: {
    readonly project?: string;
    readonly template?: string;
    readonly mode?: string;
    readonly state?: string;
    readonly createdAt: string;
    readonly snapshot?: unknown;
    readonly estimateUsd?: number;
    readonly costActual?: number;
  }): Promise<string> => {
    const task = await pool.query<{ id: string }>(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, mode,
                          state, created_at, template_snapshot, estimate_usd, cost_actual)
       values ($1, 'fake-jira', $2, 'https://jira.example.test/x', $3, $4, $5, $6, $7, $8, $9)
       returning id`,
      [
        input.project ?? projectId,
        `ACME-${Math.random().toString(16).slice(2)}`,
        input.template ?? 'feature',
        input.mode ?? 'normal',
        input.state ?? 'active',
        input.createdAt,
        input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
        input.estimateUsd ?? null,
        input.costActual ?? 0,
      ],
    );
    return task.rows[0]?.id as string;
  };

  /** Drives a real event through a real bus into the real projector — never an insert. */
  const publish = async (taskId: string, spec: Record<string, unknown>): Promise<void> => {
    const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
    for (const handler of statsHandlers({ store: stats.createPostgresStatsStore() })) {
      bus.register(handler);
    }
    const seq = (sequences.get(taskId) ?? 0) + 1;
    sequences.set(taskId, seq);
    const event = domainEventSchemasByType[
      spec.type as keyof typeof domainEventSchemasByType
    ].parse({
      id: crypto.randomUUID(),
      stream_type: 'task',
      stream_id: taskId,
      stream_seq: seq,
      correlation_id: taskId,
      cause_event_id: null,
      actor: { kind: 'system', component: 'test' },
      occurred_at: spec.occurred_at,
      type: spec.type,
      payload: spec.payload,
    }) as DomainEvent;
    const [appended] = await unitOfWork.transaction(async (scope) => scope.events.append([event]));
    const result = await bus.dispatch(appended as NonNullable<typeof appended>);
    expect(result.status).toBe('dispatched');
  };

  const merge = (projectOf: string, taskId: string, occurredAt: string) =>
    publish(taskId, {
      type: 'mr.merged',
      occurred_at: occurredAt,
      payload: {
        project_id: projectOf,
        task_id: taskId,
        mr: {
          provider: 'gitlab',
          project_path: 'acme/api',
          iid: 7,
          url: 'https://git.example.test/acme/api/-/merge_requests/7',
        },
        draft: false,
        head_sha: 'a'.repeat(40),
        diff_stats: null,
        merge_commit_sha: 'c'.repeat(40),
      },
    });

  const read = async (project: string | null = projectId): Promise<StatsSources> =>
    readStatsSources(db, resolveRange('7d', 'day', dayOf(at(0))), {
      timezone: ZONE,
      projectId: project,
    });

  it('counts a delivery at merge time and reads its returns from `outcome`', async () => {
    const taskId = await seedTask({ createdAt: at(-600), estimateUsd: 6, costActual: 4 });
    // Two stage rows in the vocabulary the interpreter really writes: `state` is `exited` and the
    // return is in `outcome`. A read that matched `state = 'returned'` sees zero here.
    await pool.query(
      `insert into task_stages (task_id, stage, attempt, state, outcome, entered_at, exited_at)
       values ($1, 'code_review', 1, 'returned', 'returned', $2, $3),
              ($1, 'code_review', 2, 'completed', 'passed', $3, $3)`,
      [taskId, at(-60), at(-30)],
    );
    await pool.query(
      `insert into runs (task_id, project_id, role, model, prompt_version, status,
                         started_at, ended_at)
       values ($1, $2, 'reviewer', 'claude', 'v1', 'completed', $3, $4)`,
      [taskId, projectId, at(-60), at(-30)],
    );
    await pool.query(
      `insert into cost_entries (run_id, task_id, project_id, stage, model, usd, is_estimate, created_at)
       select id, $1, $2, 'code_review', 'claude', 2.5, true, $3 from runs where task_id = $1`,
      [taskId, projectId, at(-30)],
    );

    await merge(projectId, taskId, at(0));

    const sources = await read();
    expect(sources.deliveredTasks).toHaveLength(1);
    expect(sources.deliveredTasks[0]).toMatchObject({
      mergedDay: dayOf(at(0)),
      returns: 1,
      questions: 0,
      costUsd: 2.5,
      estimateUsd: 6,
      costActual: 4,
    });
    // 10 hours between creation and merge, and half an hour of run time.
    expect(sources.deliveredTasks[0]?.cycleHours).toBeCloseTo(10, 1);
    expect(sources.deliveredTasks[0]?.agentHours).toBeCloseTo(0.5, 2);
    // The per-stage read uses the same predicate, so the two cannot disagree.
    expect(sources.stageReturns).toEqual([
      { stage: 'code_review', entries: 2, returns: 1, rate: null },
    ]);
    // PROGRESS backlog 75's projection: the share is read off `cost_entries.is_estimate` and
    // `tasks.cost_estimated` no longer exists (dropped by migration 0035, WP-47).
    expect(sources.estimatedSpend).toEqual([{ day: dayOf(at(-30)), usd: 2.5, estimatedUsd: 2.5 }]);
  });

  it('counts only the templates that can deliver a merge request', async () => {
    await seedTask({ createdAt: at(-2160), template: 'feature' });
    await seedTask({ createdAt: at(-2160), template: 'discovery' });
    await seedTask({ createdAt: at(-2160), template: 'feature', mode: 'shadow' });
    // A project's own template is judged on what it *does*: this one has a `merged_gate`, so it
    // counts although its id is nobody's shipped template.
    await seedTask({
      createdAt: at(-2160),
      template: 'house_style',
      snapshot: {
        stages: [
          { id: 'intake', kind: 'system' },
          { id: 'merged_gate', kind: 'gate' },
        ],
      },
    });

    const sources = await read();
    // Scoped to **this case's** day: the cases above seeded tasks of their own, and a count over
    // the whole range would be a count of everything this file has ever written (standing rule 10
    // — a number satisfied by more than one arrangement is not an assertion about this one).
    const started = sources.startedTasks.filter((row) => row.startedDay === dayOf(at(-2160)));
    expect(started).toHaveLength(2);
  });

  it('marks a task a human had to touch, and leaves the others alone', async () => {
    const untouched = await seedTask({ createdAt: at(-3600) });
    const questioned = await seedTask({ createdAt: at(-3600) });
    const escalated = await seedTask({ createdAt: at(-3600), state: 'needs_human' });
    await pool.query(
      `insert into questions (task_id, text, asked_at, answered_at) values ($1, 'why?', $2, $3)`,
      [questioned, at(-3590), at(-3580)],
    );

    const sources = await read();
    const today = sources.startedTasks.filter((row) => row.startedDay === dayOf(at(-3600)));
    const intervened = today.filter((row) => row.intervened).length;
    const clean = today.filter((row) => !row.intervened).length;
    expect({ intervened, clean }).toEqual({ intervened: 2, clean: 1 });
    expect([untouched, questioned, escalated]).toHaveLength(3);

    // The question's latency is read at its **answer**, ten minutes after it was asked.
    expect(sources.questions).toEqual([{ answeredDay: dayOf(at(-3580)), minutes: 10 }]);
  });

  it('caps one person’s review minutes at eight hours a day across tasks (backlog 89)', async () => {
    const first = await seedTask({ createdAt: at(-5040) });
    const second = await seedTask({ createdAt: at(-5040) });
    // Five hours on each of two tasks, same unmapped reviewer, same civil day: the projector's
    // per-entry cap admits both, and the read's per-(identity, day) cap clamps the total to 480.
    for (const taskId of [first, second]) {
      await pool.query(
        `insert into human_time_entries (task_id, kind, user_id, external_author, started_at,
                                         ended_at, minutes)
         values ($1, 'review', null, 'gitlab:ada', $2, $3, 300)`,
        [taskId, at(-5030), at(-60)],
      );
    }
    // A different reviewer on the same day is a different bucket and is not clamped with her.
    await pool.query(
      `insert into human_time_entries (task_id, kind, user_id, external_author, started_at,
                                       ended_at, minutes)
       values ($1, 'review', null, 'gitlab:bob', $2, $3, 120)`,
      [first, at(-5030), at(-60)],
    );

    const sources = await read();
    const review = sources.humanMinutes.filter((row) => row.kind === 'review');
    expect(review).toEqual([{ day: dayOf(at(-5030)), kind: 'review', minutes: 600 }]);
  });

  it('keeps one project’s numbers out of another’s', async () => {
    const mine = await seedTask({ createdAt: at(-45) });
    const theirs = await seedTask({ project: otherProjectId, createdAt: at(-45) });
    await merge(otherProjectId, theirs, at(-40));
    await publish(mine, {
      type: 'task.rebase.checked',
      occurred_at: at(-40),
      payload: {
        project_id: projectId,
        task_id: mine,
        mr: {
          provider: 'gitlab',
          project_path: 'acme/api',
          iid: 9,
          url: 'https://git.example.test/acme/api/-/merge_requests/9',
        },
        conflicts: false,
        attempt: 0,
        outcome: 'clean',
      },
    });

    const scoped = await read(otherProjectId);
    expect(scoped.counters).toEqual([]);
    expect(scoped.deliveredTasks).toHaveLength(1);

    const everything = await read(null);
    expect(everything.counters.map((row) => row.metric)).toContain('rebase.clean');
    expect(everything.deliveredTasks.length).toBeGreaterThan(1);
  });

  it('refuses a range with more tasks than one answer is folded from, rather than serving it short', async () => {
    // The one **guard** this module owns, and the reason `stats-queries.ts` is excluded from the
    // unit tier's coverage rather than quietly uncovered: a truncated total is indistinguishable
    // from a real one on a screen, so the read fails by name and the route answers 409.
    const project = await seedProject('bulk');
    await pool.query(
      `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, created_at)
       select $1, 'fake-jira', 'BULK-' || g, 'https://jira.example.test/x', 'feature', $2
         from generate_series(1, ${MAX_TASK_ROWS + 1}) as g`,
      [project, at(-10)],
    );

    await expect(read(project)).rejects.toThrow(StatsRangeTooLargeError);
    // …and one row under the bound is served, so the refusal is a boundary rather than a ceiling
    // nobody can reach (standing rule 42).
    await pool.query('delete from tasks where ticket_key = $1', [`BULK-${MAX_TASK_ROWS + 1}`]);
    const sources = await read(project);
    expect(sources.startedTasks).toHaveLength(MAX_TASK_ROWS);
  }, 120_000);

  it('folds what it read into a document the contract accepts', async () => {
    // The two halves together, once: the SQL's rows through the pure fold, so a shape the queries
    // can produce and the fold cannot is a failure here rather than a 500 on an instance.
    const sources = await read();
    const document = foldStats({
      range: resolveRange('7d', 'day', dayOf(at(0))),
      timezone: ZONE,
      timezoneSubstituted: false,
      projectId,
      generatedAt: at(0) as never,
      sources,
    });
    expect(document.metrics.find((metric) => metric.id === 'tasks_delivered')?.value).toBe(1);
    expect(document.metrics.find((metric) => metric.id === 'loc_changed')?.absent).not.toBeNull();
  });
});
