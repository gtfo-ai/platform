/**
 * **WP-36's acceptance, through a real `apps/server` instance**: the scheduler's own fire creates a
 * chore task, the chore walks the ordinary pipeline to a merge, and nobody's ticket board hears
 * about any of it.
 *
 * What this tier adds to `maintenance/scheduler.test.ts` is the **composition**: the pass runs on
 * the instance's own `maintenance.schedule` worker, the tasks are created by the production
 * `PostgresPipelineStore`, the brief is written to and read back from a real `tasks.ticket_snapshot`,
 * every provider call goes through the production `IntegrationActionExecutor`, and the run's prompt
 * is assembled by the production planner. Every assertion is on a row — `tasks`, `runs`,
 * `integration_actions`, `pgboss.schedule` — never on a return value (standing rule 79).
 *
 * **The fake runner picks its scenario from the prompt** (standing rule 82), and for this row that
 * is not a nicety: a scheduled chore has **no ticket text to dispatch on**, so a stage-keyed table
 * would answer happily for a prompt that said nothing at all. `scenarioFromPrompt` reads the
 * `ticket` data block, refuses a chore whose brief does not name the finding the platform
 * established, and quotes that finding back in the artifacts — so a build that lost the brief, or
 * wrote an empty one, finds no scenario and the run fails by name.
 *
 * Every wait is on the last row the platform writes and the rest is asserted as what that row
 * implies (standing rule 87).
 */
import type { RunSpec } from '@platform/application';
import { readDataBlocks } from '@platform/domain';
import { jobs as jobsAdapters } from '@platform/infrastructure';
import { afterEach, describe, expect, it } from 'vitest';
import { GIT_PROJECT, inboundEvent, type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { featureScenarios } from '../support/scenarios.js';

let harness: PipelineE2E | undefined;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

/** The page the nightly hygiene pass found expired; the brief must name it, and so must the run. */
const EXPIRED_PAGE = 'lessons/L-2025-01-01-rounding.md';

const merged = (pipeline: PipelineE2E) =>
  inboundEvent('mr.merged', {
    project_id: pipeline.projectId,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: GIT_PROJECT,
      iid: pipeline.world.mr.iid,
      url: pipeline.world.mr.url,
      branch: pipeline.world.branch,
      head_sha: pipeline.world.mr.headSha,
    },
    draft: false,
    head_sha: pipeline.world.mr.headSha,
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

/**
 * The chore's own scenarios, **built from the run's own prompt**.
 *
 * `undefined` falls through to the stage map, which is what every non-chore run in this file gets.
 * A chore run whose prompt carries no brief — or a brief that names no finding — gets `undefined`
 * from the guard below **and** no stage-map entry for the quoted path, so it cannot pass by
 * accident: the two refinement scenarios differ, and only the one built here quotes the page.
 */
const scenarioFromPrompt = (
  spec: RunSpec,
  world: { mr: { url: string; iid: number; headSha: string }; branch: string },
) => {
  const block = readDataBlocks(spec.userPrompt).blocks.find((entry) => entry.kind === 'ticket');
  if (block === undefined || !block.body.includes('key: chore!')) {
    return undefined;
  }
  // The finding the platform established, read out of the brief the scheduler wrote. A prompt with
  // no evidence line yields no page and therefore no scenario (rule 82).
  const page = /- expired: (\S+) —/.exec(block.body)?.[1];
  if (page === undefined) {
    return undefined;
  }
  if (spec.stage === 'refinement') {
    return {
      structuredOutput: {
        goal: `Refresh ${page}, which the nightly hygiene pass reported expired.`,
        user_value: 'The knowledge base keeps saying true things.',
        in_scope: [page],
        out_of_scope: ['every other page'],
        acceptance_criteria: [
          {
            id: 'ac1',
            given: 'the expired page',
            when: 'the chore is merged',
            // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
            then: 'it carries a current expiry or is removed',
            validation: { kind: 'manual', value: 'a maintainer reads it' },
          },
        ],
        non_functional: [],
        dependencies: [],
        size: 'S',
        drift: { flag: false, justification: 'in the documented direction' },
        assumptions: [],
        questions: [],
        decision: 'proceed',
        kb_citations: [],
      },
    };
  }
  if (spec.stage === 'implementation') {
    return {
      structuredOutput: {
        summary: `Refreshed ${page}.`,
        deviations_from_plan: [],
        tests_added: [],
        commands_run: [],
        known_gaps: [],
        followup_tickets: [],
        mr: {
          url: world.mr.url,
          iid: world.mr.iid,
          head_sha: world.mr.headSha,
          branch: world.branch,
        },
      },
    };
  }
  return undefined;
};

/** Fires the daily pass, the way a second replica would: the cron itself is at 04:35. */
const fireTheSchedule = async (pipeline: PipelineE2E): Promise<void> => {
  const runtime = jobsAdapters.createPgBossJobs({
    connectionString: pipeline.database.connectionString,
  });
  await runtime.start();
  try {
    await runtime.jobs.enqueue({ queue: 'maintenance.schedule', data: {} });
  } finally {
    await runtime.stop();
  }
};

/** The hygiene report the nightly pass (WP-18b) writes, and the `kb` chore's whole input. */
const seedHygieneReport = async (pipeline: PipelineE2E): Promise<void> => {
  await pipeline.query(
    `insert into kb_health_reports (project_id, commit_sha, documents, findings, source)
     values ($1, $2, 4, $3::jsonb, 'hygiene')`,
    [
      pipeline.projectId,
      'a'.repeat(40),
      JSON.stringify([
        { kind: 'expired', path: EXPIRED_PAGE, detail: 'expires: 2025-06-01 has passed' },
      ]),
    ],
  );
};

const startWith = async (label: string, chores: readonly string[]) => {
  const pipeline = await startPipeline({
    scenarios: featureScenarios,
    scenarioFor: (spec, world) => scenarioFromPrompt(spec, world),
    label,
    config: {
      features: { maintenance: { enabled: true, schedule: 'daily', budget_usd: 50, chores } },
    },
  });
  harness = pipeline;
  await seedHygieneReport(pipeline);
  return pipeline;
};

const choreTask = async (pipeline: PipelineE2E) =>
  (
    await pipeline.query<{
      id: string;
      state: string;
      template: string;
      ticket_provider: string;
      ticket_key: string;
      ticket_snapshot: { title: string; description: string } | null;
      cost_actual: string;
    }>(
      `select id, state, template, ticket_provider, ticket_key, ticket_snapshot, cost_actual
         from tasks where ticket_key like 'chore!%' order by created_at`,
    )
  ).at(0);

describe('a scheduled maintenance chore', () => {
  it('is created by the schedule’s own fire, walks the chore pipeline and merges', async () => {
    const pipeline = await startWith('maintenance', ['kb', 'lint']);

    await fireTheSchedule(pipeline);
    await pipeline.waitFor(
      'the chore task to exist',
      async () => (await choreTask(pipeline)) !== undefined,
    );

    const created = await choreTask(pipeline);
    // An ordinary `chore` task on a **platform-issued** reference: no ticket, and a key that carries
    // the period so a second fire finds it (asserted below).
    expect(created?.template).toBe('chore');
    expect(created?.ticket_provider).toBe('platform');
    expect(created?.ticket_key).toMatch(/^chore!kb-\d{4}-\d{2}-\d{2}$/);
    // The brief the run is started on — the column a chore's whole prompt is built from.
    expect(created?.ticket_snapshot?.title).toContain('Knowledge base hygiene');
    expect(created?.ticket_snapshot?.description).toContain(EXPIRED_PAGE);

    // **The `lint` chore is refused by name**, so the same pass created exactly one task.
    const keys = await pipeline.query<{ ticket_key: string }>(
      "select ticket_key from tasks where ticket_key like 'chore!%'",
    );
    expect(keys.map((row) => row.ticket_key).filter((key) => key.startsWith('chore!lint'))).toEqual(
      [],
    );

    const waiting = await pipeline.settle(
      'ready_for_merge',
      (task) => task.state === 'ready_for_merge',
    );
    expect(waiting.template).toBe('chore');

    await pipeline.publish([merged(pipeline)]);
    const finished = await pipeline.settle('done', (task) => task.state === 'done');
    expect(finished.template).toBe('chore');
    expect(finished.id).toBe(created?.id);

    // The chore template's five agent stages, in order — the ordinary pipeline, no second one.
    expect(pipeline.specs.map((spec) => spec.stage)).toEqual([
      'refinement',
      'implementation',
      'code_review',
      'retrospective',
      'librarian',
    ]);
    // The run really read the brief: the model could only have written the page's name by being
    // shown it (standing rule 82, and the reason `scenarioFor` exists here at all).
    expect(pipeline.specs[0]?.userPrompt).toContain(EXPIRED_PAGE);

    /**
     * **`runs.mode` tells delivery from upkeep** (PROGRESS backlog 57, criterion 4). The three
     * delivery stages of this chore are `normal`; the retrospective and the librarian are the two
     * upkeep runs every finished task produces, and until WP-36 all five said `normal`.
     */
    const runs = await pipeline.query<{ mode: string; role: string }>(
      `select r.mode, r.role from runs r
         join tasks t on t.id = r.task_id
        where t.ticket_key like 'chore!%'
        order by r.created_at`,
    );
    expect(runs.map((row) => row.mode)).toEqual([
      'normal',
      'normal',
      'normal',
      'retro',
      'librarian',
    ]);

    /**
     * **No ticket, in either direction** (criterion 3, PROGRESS backlog 62). The write half has
     * been refused by name since WP-25; the read half is this row's, and it is the one a project
     * with a task-management binding paid for — one doomed `read_ticket` per agent stage, each a
     * `failed` row in the audit.
     */
    const audit = await pipeline.auditRows();
    const choreId = created?.id;
    const choreActions = audit.filter((row) => row.task_id === choreId);
    expect(choreActions.map((row) => row.action)).not.toContain('create_ticket');
    expect(choreActions.map((row) => row.action)).not.toContain('read_ticket');
    expect(choreActions.map((row) => row.action)).not.toContain('upsert_workpad');
    expect(choreActions.map((row) => row.action)).not.toContain('transition');
    // …and the fake board's own store agrees: nothing was written on anybody's ticket. The harness
    // seeds three (`TICKETS`), none of which this chore has anything to do with.
    for (const key of ['ACME-1', 'ACME-2', 'ACME-9']) {
      expect(pipeline.tickets.peek(key)?.comments ?? [], key).toEqual([]);
    }
    /**
     * …and the chore **did** talk to a provider, which is what keeps the four refusals above from
     * being vacuous (standing rule 43): every call it made is a **git** one, because product/19:126
     * says the maintenance pipeline's external touch is merge requests. Asserted as a partition
     * rather than by naming one action: no row whose action belongs to the ticket board.
     */
    expect(choreActions.length).toBeGreaterThan(0);
    const ticketActions = [
      'read_ticket',
      'create_ticket',
      'upsert_workpad',
      'lint_comment',
      'transition',
      'add_comment',
      'set_labels',
      'link_merge_request',
      'match_tickets',
    ];
    expect(
      choreActions.filter((row) => ticketActions.includes(row.action)).map((row) => row.action),
    ).toEqual([]);
  });

  it('creates no second task when the schedule fires again in the same period', async () => {
    const pipeline = await startWith('maintenance-twice', ['kb']);

    await fireTheSchedule(pipeline);
    await pipeline.waitFor(
      'the chore task to exist',
      async () => (await choreTask(pipeline)) !== undefined,
    );
    await pipeline.settle('refinement', (task) => task.current_stage !== 'intake');

    await fireTheSchedule(pipeline);
    // The second pass finds this period's task and creates nothing. Waited on the *pass* rather
    // than on a sleep: the log line it writes is not a row, so the countable effect is the row
    // count itself, read after the queue has drained the second job.
    await pipeline.waitFor('the second pass to finish', async () => {
      const jobs = await pipeline.query<{ count: string }>(
        `select count(*)::text as count from pgboss.job
          where name = 'maintenance.schedule' and state in ('created', 'active', 'retry')`,
      );
      return jobs[0]?.count === '0';
    });

    const rows = await pipeline.query<{ ticket_key: string }>(
      "select ticket_key from tasks where ticket_key like 'chore!%'",
    );
    expect(rows).toHaveLength(1);
  });

  it('registers the daily schedule in the organisation’s zone', async () => {
    const pipeline = await startWith('maintenance-cron', ['kb']);
    const schedules = await pipeline.query<{ name: string; cron: string; timezone: string }>(
      "select name, cron, timezone from pgboss.schedule where name = 'maintenance.schedule'",
    );
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cron).toBe('35 4 * * *');
    // Never the host zone (Q38): a maintenance window has to be somebody's 04:35.
    expect(schedules[0]?.timezone).toBe('UTC');
  });
});
