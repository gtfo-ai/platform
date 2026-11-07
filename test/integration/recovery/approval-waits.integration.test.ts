/**
 * **An approval waits until a person decides it** — S-27.1, BD-006's 2026-11-07 amendment, against
 * PostgreSQL 18.
 *
 * The unit tier (`packages/application/src/pipeline/deadlines.test.ts`) asserts the rules over the
 * in-memory twin; this file proves them over the real store, the real unit of work and the real
 * recovery reads, because the defect being removed lived in SQL as much as in code: the recovery
 * pass's overdue read found a pending approval by its `deadline_at` and expired it, and its backfill
 * gave an undated one a deadline.
 *
 * - **Criterion 1.** A pending approval with an old, past `deadline_at` (an earlier build's) and a
 *   new one with none both stay `pending` through a `deadline.sweep` fire (`approval_timeout`, which
 *   still parses — criterion 2) and a recovery pass; neither `deadline_at` is written; no
 *   `task.approval.decided` is appended.
 * - **Criterion 3's recovery row.** A pending approval whose **next** reminder (its third) is long
 *   overdue is reminded once by the pass — `reminders_sent` 2 → 3 in the row, one `notify` duty with
 *   the third reminder's own cause, and the fourth armed — while one with its five reminders spent
 *   and one already decided are not.
 */
import { randomUUID } from 'node:crypto';
import type { DeadlineRecoverySite, UnitOfWork } from '@platform/application';
import {
  approvalReminderAt,
  createWorkingCalendar,
  declareDeadlineQueue,
  declarePipelineQueues,
  defaultProjectSettings,
  JOB_QUEUES,
  noSecretsRedactor,
  recoverDeadlines,
  reminderCauseId,
  settleDeadline,
  staticProjectSettings,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { addMs, FEATURE_TEMPLATE, SHIPPED_TEMPLATES } from '@platform/domain';
import {
  eventing,
  jobs as jobsAdapters,
  pipeline as pipelineAdapters,
  recovery as recoveryAdapters,
} from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recentInstant } from '../../support/recent-instant.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: Id;
let taskId: Id;
let unitOfWork: UnitOfWork;

const NOW = recentInstant();
const DAY = 24 * 60 * 60_000;
const calendar = createWorkingCalendar();
const pipelineStore = pipelineAdapters.createPostgresPipelineStore({
  templates: SHIPPED_TEMPLATES,
});

const seedApproval = async (row: {
  readonly requestedAt: IsoDateTime;
  readonly deadlineAt: IsoDateTime | null;
  readonly status?: 'pending' | 'approved';
  readonly remindersSent?: number;
  readonly attempt: number;
}): Promise<Id> => {
  const id = randomUUID() as Id;
  await pool.query(
    `insert into approvals (id, task_id, kind, status, requested_at, deadline_at, stage, attempt,
                            reminders_sent)
     values ($1, $2, 'plan', $3::approval_status, $4, $5, 'architecture', $6, $7)`,
    [
      id,
      taskId,
      row.status ?? 'pending',
      row.requestedAt,
      row.deadlineAt,
      row.attempt,
      row.remindersSent ?? 0,
    ],
  );
  return id;
};

const approvalRow = async (id: Id) => {
  const { rows } = await pool.query<{
    status: string;
    deadline_at: Date | null;
    reminders_sent: number;
  }>('select status, deadline_at, reminders_sent from approvals where id = $1', [id]);
  return rows[0];
};

const composed = async () => {
  const runtime = jobsAdapters.createInMemoryJobs({ startTime: new Date(NOW) });
  await declarePipelineQueues(runtime.jobs);
  await declareDeadlineQueue(runtime.jobs);
  const site: DeadlineRecoverySite = {
    store: recoveryAdapters.createPostgresDeadlineRecoveryStore(),
    settings: staticProjectSettings((id) => defaultProjectSettings(id)),
    sweep: {
      unitOfWork,
      store: pipelineStore,
      // Only a take-over's ending reads a run stream; no approval path reaches it.
      eventStore: {
        nextStreamSequence: async () => {
          throw new Error('no approval path reads a run stream');
        },
      },
      jobs: runtime.jobs,
      calendar,
      settings: staticProjectSettings((id) => defaultProjectSettings(id)),
      ids: { next: () => randomUUID() as Id },
      redactor: noSecretsRedactor(),
    },
  };
  return { runtime, site };
};

const pass = async (site: DeadlineRecoverySite) =>
  recoverDeadlines(site, {
    now: NOW,
    graceMs: 60_000,
    limit: 50,
    clock: { now: () => NOW },
  });

beforeAll(async () => {
  database = await createMigratedDatabase('approval-waits');
  pool = createTestPool(database.connectionString, { max: 6 });
  unitOfWork = new eventing.PostgresUnitOfWork({ pool });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('approvals') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'apw', 'Approvals', 'https://git.example.test/acme/apw.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as Id;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

beforeEach(async () => {
  await pool.query('delete from approvals');
  await pool.query('delete from tasks');
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot)
     values ($1, 'fake-jira', 'ACME-1', 'https://jira.example.test/browse/ACME-1', 'feature',
             'waiting_approval', 'architecture', $2::jsonb) returning id`,
    [projectId, JSON.stringify(FEATURE_TEMPLATE)],
  );
  taskId = task.rows[0]?.id as Id;
});

describe('an approval waits until a person decides it (S-27.1, BD-006 2026-11-07)', () => {
  it('keeps a pending approval with an old past deadline, and one with none, pending through a sweep fire and a recovery pass (criterion 1)', async () => {
    const { site } = await composed();
    // An earlier build's row: requested an hour ago and given a deadline that passed half an hour
    // ago — what the Q95 rule would have expired on this pass.
    const oldDeadline = addMs(NOW, -30 * 60_000);
    const old = await seedApproval({
      requestedAt: addMs(NOW, -60 * 60_000),
      deadlineAt: oldDeadline,
      attempt: 1,
    });
    // This build's row: no deadline at all, which the backfill would have dated from now.
    const fresh = await seedApproval({ requestedAt: NOW, deadlineAt: null, attempt: 2 });

    const sweep = { ...site.sweep, clock: { now: () => NOW } };
    for (const id of [old, fresh]) {
      expect(
        await settleDeadline(sweep, { aggregate: 'approval', id, kind: 'approval_timeout' }),
      ).toEqual({
        kind: 'settled',
      });
    }
    const report = await pass(site);
    expect(report).toMatchObject({ found: 0, expired: 0, backfilled: 0 });

    expect(await approvalRow(old)).toMatchObject({ status: 'pending' });
    expect((await approvalRow(old))?.deadline_at?.toISOString()).toBe(oldDeadline);
    expect(await approvalRow(fresh)).toMatchObject({ status: 'pending', deadline_at: null });
    const { rows: tasks } = await pool.query<{ state: string }>(
      'select state from tasks where id = $1',
      [taskId],
    );
    expect(tasks[0]?.state).toBe('waiting_approval');
    const { rows: decided } = await pool.query(
      `select 1 from events where type = 'task.approval.decided'`,
    );
    expect(decided).toEqual([]);
  });

  it('reminds an approval whose next reminder is a grace overdue, once, and arms the one after it (criterion 3’s recovery row)', async () => {
    const { runtime, site } = await composed();
    const requestedAt = addMs(NOW, -30 * DAY);
    const due = await seedApproval({ requestedAt, deadlineAt: null, remindersSent: 2, attempt: 1 });
    const spent = await seedApproval({
      requestedAt,
      deadlineAt: null,
      remindersSent: 5,
      attempt: 2,
    });
    const decided = await seedApproval({
      requestedAt,
      deadlineAt: null,
      status: 'approved',
      attempt: 3,
    });

    const report = await pass(site);
    expect(report).toMatchObject({ reminderFound: 1, reminded: 1 });
    expect((await approvalRow(due))?.reminders_sent).toBe(3);
    expect((await approvalRow(spent))?.reminders_sent).toBe(5);
    expect((await approvalRow(decided))?.reminders_sent).toBe(0);

    const jobs = runtime.snapshot();
    const notify = jobs.filter((job) => job.queue === JOB_QUEUES.pipelineOutbound);
    expect(notify.map((job) => job.data)).toEqual([
      expect.objectContaining({
        duty: 'notify',
        task_id: taskId,
        notification_class: 'reminder',
        cause_event_id: reminderCauseId('approval', due, 3),
        reminder_of: due,
        reminder_aggregate: 'approval',
      }),
    ]);
    const armed = jobs.filter((job) => job.queue === JOB_QUEUES.deadlineSweep);
    expect(armed.map((job) => job.data)).toEqual([
      { aggregate: 'approval', id: due, kind: 'approval_reminder' },
    ]);
    // The fourth is a month overdue too, so its arm is due at once (the store clamps a past
    // `startAfter` to now, as pg-boss runs one).
    const fourth = approvalReminderAt(calendar, requestedAt, '1 working day', 4);
    expect(Date.parse(fourth ?? '')).toBeLessThan(Date.parse(NOW));
    expect(armed[0]?.startAfter.toISOString()).toBe(new Date(NOW).toISOString());

    // So the next pass sends it — under its own cause, and the
    // third is not sent again: the count moved the row on.
    const again = await pass(site);
    expect(again).toMatchObject({ reminderFound: 1, reminded: 1 });
    expect((await approvalRow(due))?.reminders_sent).toBe(4);
    expect(
      runtime
        .snapshot()
        .filter((job) => job.queue === JOB_QUEUES.pipelineOutbound)
        .map((job) => (job.data as { cause_event_id: string }).cause_event_id),
    ).toEqual([reminderCauseId('approval', due, 3), reminderCauseId('approval', due, 4)]);
  });
});
