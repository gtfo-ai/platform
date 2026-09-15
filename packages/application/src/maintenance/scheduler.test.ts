/**
 * The maintenance scheduler: what one pass creates, what it refuses and what stops it (WP-36).
 *
 * Every assertion is on a **row or a count**, never on the report object alone (standing rule 79):
 * a pass that reported `created` and inserted no task, or that inserted two for one period, would be
 * green against the report and wrong in production. The report is read only where it carries the
 * *reason* — which is what a refusal has instead of a row.
 *
 * The one this file exists for most is **the brief on the task row**: a chore's whole input is
 * `tasks.ticket_snapshot`, and a scheduler that created tasks with an empty one would look identical
 * here and start an agent on an identifier (standing rule 82, one ring in from the e2e).
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { choreTicketKey } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { PLATFORM_TICKET_PROVIDER } from '../pipeline/integrations.js';
import { staticProjectSettings } from '../pipeline/settings.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import type { KbHygieneReport, MaintenanceStore, StaleDependency } from './ports.js';
import {
  DEPENDENCY_UNRELEASED_DAYS,
  MAINTENANCE_SCHEDULE_CRON,
  MAINTENANCE_SCHEDULE_QUEUE,
  maintenanceChorePeriod,
  registerMaintenanceSchedule,
  runMaintenancePass,
} from './scheduler.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;

/**
 * A redactor that redacts exactly one planted string, so the brief's redaction is measured rather
 * than assumed (standing rule 31: an optional security dependency is an absent one — this one is
 * required, and this is the test that proves it is *used*).
 */
const PLANTED = 'glpat-notarealtokenatall';
const countingRedactor: SecretRedactor = {
  redactText: (text: string) => {
    const value = text.split(PLANTED).join('[REDACTED:planted]');
    return { value, count: text.split(PLANTED).length - 1 };
  },
  redactJson: (value: unknown) => ({ value, count: 0 }),
} as SecretRedactor;

interface DoubleOptions {
  readonly hygiene?: KbHygieneReport | null;
  readonly stale?: readonly StaleDependency[];
  readonly spentUsd?: number;
}

/**
 * The store double.
 *
 * A double in the test rather than a shared fake, and the reason is stated (standing rule 1): this
 * port has **no writer at all** — three reads of tables other features own — so there is nothing for
 * a contract suite to drive both implementations through. The SQL itself is asserted against a real
 * database by `test/integration/maintenance/maintenance-store.integration.test.ts`.
 */
const storeDouble = (options: DoubleOptions = {}): MaintenanceStore & { spendCalls: number } => {
  let spendCalls = 0;
  return {
    get spendCalls() {
      return spendCalls;
    },
    maintenanceSpendSince: async () => {
      spendCalls += 1;
      return options.spentUsd ?? 0;
    },
    latestKbHygiene: async () => options.hygiene ?? null,
    staleDependencies: async () => options.stale ?? [],
  };
};

const HYGIENE: KbHygieneReport = {
  commitSha: 'a'.repeat(40),
  createdAt: '2026-09-15T03:15:00.000Z' as IsoDateTime,
  documents: 12,
  findings: [
    { kind: 'expired', path: 'lessons/L-2025-01-01-old.md', detail: 'expires: 2025-06-01 passed' },
  ],
};

const STALE: readonly StaleDependency[] = [
  {
    ecosystem: 'npm',
    name: 'left-pad',
    path: 'package.json',
    deprecated: true,
    lastPublishedAt: null,
  },
];

const harnessWith = (config: Record<string, unknown>): PipelineHarness =>
  createPipelineHarness({ projectId: PROJECT, settings: { config: config as never } });

const pass = async (
  harness: PipelineHarness,
  store: MaintenanceStore,
  overrides: { readonly timezone?: string } = {},
) =>
  runMaintenancePass({
    unitOfWork: harness.memory,
    store: harness.store,
    maintenance: store,
    settings: staticProjectSettings(() => harness.settings),
    jobs: harness.jobs,
    ids: harness.ids,
    clock: { now: () => harness.clock.now() as IsoDateTime },
    projects: async () => [PROJECT],
    timezone: overrides.timezone ?? 'UTC',
    baseUrl: 'https://app.example.test',
    redactor: countingRedactor,
  });

const loadChore = async (harness: PipelineHarness, key: string) =>
  harness.memory.transaction(async (scope) =>
    harness.store.tasks.findByTicket(scope.tx, {
      projectId: PROJECT,
      provider: PLATFORM_TICKET_PROVIDER,
      ticketKey: key,
      mode: 'normal',
    }),
  );

describe('one maintenance pass', () => {
  it('creates one ordinary chore task per performable type, with the brief on the row', async () => {
    const harness = harnessWith({
      features: { maintenance: { enabled: true, schedule: 'weekly', chores: ['kb', 'deps'] } },
    });
    const store = storeDouble({ hygiene: HYGIENE, stale: STALE });

    const report = await pass(harness, store);

    const period = maintenanceChorePeriod('weekly', harness.clock.now() as IsoDateTime, 'UTC');
    const kb = await loadChore(harness, choreTicketKey('kb', period));
    const deps = await loadChore(harness, choreTicketKey('deps', period));
    expect(kb).not.toBeNull();
    expect(deps).not.toBeNull();
    // An ordinary task on the project's own `chore` template — no second pipeline, no new state.
    expect(kb?.task.template).toBe('chore');
    expect(kb?.task.mode).toBe('normal');
    expect(kb?.task.ticket.provider).toBe(PLATFORM_TICKET_PROVIDER);
    // The run's whole input. Without this assertion a scheduler that created tasks with no brief
    // would pass every other case in this file (standing rule 82).
    expect(kb?.ticketSnapshot?.title).toContain('Knowledge base hygiene');
    expect(kb?.ticketSnapshot?.description).toContain('lessons/L-2025-01-01-old.md');
    expect(deps?.ticketSnapshot?.description).toContain('npm:left-pad');
    /**
     * …and each task **entered** its pipeline rather than being a row somebody has to start: the
     * chore template's first stage is `intake`, a system stage that `applyDecision` completes in
     * the same transaction, so the task advances on the next dispatch exactly as a ticket's does.
     * There is no `stage.execute` job yet for the same reason — the first agent stage is entered by
     * the saga on `task.stage.completed`.
     */
    expect(kb?.task.currentStage).toBe('intake');
    const types = harness.events().map((event) => event.type);
    expect(types.filter((type) => type === 'task.created')).toHaveLength(2);
    expect(types).toContain('task.stage.entered');
    expect(types).toContain('task.stage.completed');
    expect(report.created).toBe(2);
  });

  it('creates one task when the pass runs twice in the same period', async () => {
    // Criterion 1, asserted by counting rows rather than by reading the second report: the cron is
    // `exclusive` and the period key is the idempotency, so a double fire — a retry, a second
    // replica, an operator running it by hand — converges on one task.
    const harness = harnessWith({
      features: { maintenance: { enabled: true, schedule: 'daily', chores: ['kb'] } },
    });
    const store = storeDouble({ hygiene: HYGIENE });

    const first = await pass(harness, store);
    const second = await pass(harness, store);

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.results[0]?.chores[0]?.outcome.status).toBe('already_created');
    const tasks = harness.store.snapshot().filter((task) => task.task.template === 'chore');
    expect(tasks).toHaveLength(1);
    expect(harness.events().filter((event) => event.type === 'task.created')).toHaveLength(1);
  });

  it('refuses the three chore types this build cannot perform, by name and with no task', async () => {
    const harness = harnessWith({
      features: {
        maintenance: { enabled: true, schedule: 'monthly', chores: ['flaky', 'docs', 'lint'] },
      },
    });
    const store = storeDouble({ hygiene: HYGIENE, stale: STALE });

    const report = await pass(harness, store);

    const outcomes = report.results[0]?.chores ?? [];
    expect(outcomes.map((entry) => entry.chore)).toEqual(['flaky', 'docs', 'lint']);
    for (const entry of outcomes) {
      expect(entry.outcome.status, entry.chore).toBe('refused');
      expect(entry.outcome.status === 'refused' && entry.outcome.detail.length).toBeGreaterThan(0);
    }
    expect(report.refused).toBe(3);
    // The countable half: a refusal is a sentence, never a task (rule 79).
    expect(harness.store.snapshot()).toHaveLength(0);
    expect(harness.jobs.enqueued).toHaveLength(0);
  });

  it('says “nothing to do” when the platform has established nothing, and creates no task', async () => {
    // Distinct from a refusal, and the distinction is the point: the type is performable and there
    // is simply nothing to work on — a hygiene pass that has never run, or a build whose operator
    // declared no registry host so every package is `not_checked` (rule 18).
    const harness = harnessWith({
      features: { maintenance: { enabled: true, chores: ['kb', 'deps'] } },
    });
    const report = await pass(harness, storeDouble({ hygiene: null, stale: [] }));

    const outcomes = report.results[0]?.chores ?? [];
    // The order is the catalogue's rather than the configuration's, so a report reads the same way
    // whatever order an operator wrote the list in.
    expect(outcomes.map((entry) => entry.chore)).toEqual(['deps', 'kb']);
    expect(outcomes.map((entry) => entry.outcome.status)).toEqual([
      'nothing_to_do',
      'nothing_to_do',
    ]);
    expect(outcomes[0]?.outcome.status === 'nothing_to_do' && outcomes[0].outcome.detail).toContain(
      'dependency gate',
    );
    expect(outcomes[1]?.outcome.status === 'nothing_to_do' && outcomes[1].outcome.detail).toContain(
      'hygiene pass has never written a report',
    );
    expect(harness.store.snapshot()).toHaveLength(0);
  });

  /**
   * **At the cap and one past it** (standing rule 42), because the comparison is `spent >= cap` and
   * the docblock beside it now says exactly that: the batch stops at the first chore whose creation
   * would find the month's spend already at or past the cap. A test only at 10.01 would pass a
   * scheduler written `>`, which would create one more chore on the month the cap is hit exactly.
   */
  it.each([[10], [10.01]])(
    'stops the batch when the month’s maintenance spend has reached the cap (%s of 10)',
    async (spentUsd) => {
      const harness = harnessWith({
        features: {
          maintenance: { enabled: true, budget_usd: 10, chores: ['deps', 'kb'] },
        },
      });
      const store = storeDouble({ hygiene: HYGIENE, stale: STALE, spentUsd });

      const report = await pass(harness, store);

      const outcomes = report.results[0]?.chores ?? [];
      // One outcome, not two: the batch **stops** rather than answering the same thing per type.
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.outcome.status).toBe('over_budget');
      expect(harness.store.snapshot()).toHaveLength(0);
    },
  );

  it('creates the chore one cent under the cap, so the cases above are not vacuous', async () => {
    // Standing rule 42's other direction: without this half, a scheduler that refused every chore
    // would pass the ones above and every refusal case in this file.
    const harness = harnessWith({
      features: { maintenance: { enabled: true, budget_usd: 10, chores: ['kb'] } },
    });
    const report = await pass(harness, storeDouble({ hygiene: HYGIENE, spentUsd: 9.99 }));
    expect(report.created).toBe(1);
  });

  it('asks nothing of a project with the feature off, and no query for its spend', async () => {
    const harness = harnessWith({ features: { maintenance: { enabled: false, chores: ['kb'] } } });
    const store = storeDouble({ hygiene: HYGIENE });

    const report = await pass(harness, store);

    expect(report.results[0]?.blocker).toBe('feature_disabled');
    expect(store.spendCalls).toBe(0);
    expect(harness.store.snapshot()).toHaveLength(0);
  });

  it('refuses a project whose settings define no chore template, by name', async () => {
    // A project can delete the template from `.agentic/pipeline.yml`; the scheduler then has no
    // pipeline to run a chore on and says so rather than creating a task that cannot start.
    const harness = createPipelineHarness({
      projectId: PROJECT,
      settings: {
        config: { features: { maintenance: { enabled: true, chores: ['kb'] } } } as never,
        templates: {},
      },
    });
    const report = await pass(harness, storeDouble({ hygiene: HYGIENE }));
    expect(report.results[0]?.blocker).toBe('no_chore_template');
    expect(harness.store.snapshot()).toHaveLength(0);
  });

  it('treats an explicitly empty chore list as “no chore type”, and says which', async () => {
    const harness = harnessWith({ features: { maintenance: { enabled: true, chores: [] } } });
    const report = await pass(harness, storeDouble({ hygiene: HYGIENE }));
    expect(report.results[0]?.blocker).toBe('no_chore_types');
    expect(report.results[0]?.chores).toEqual([]);
  });

  it('briefs an unreleased package as unreleased rather than as deprecated', async () => {
    // The two findings are different sentences and the brief must not collapse them: one is the
    // registry's own flag, the other is an inference from a date this platform chose.
    const harness = harnessWith({
      features: { maintenance: { enabled: true, chores: ['deps'] } },
    });
    await pass(
      harness,
      storeDouble({
        stale: [
          {
            ecosystem: 'pypi',
            name: 'sleepy',
            path: 'requirements.txt',
            deprecated: false,
            lastPublishedAt: '2019-01-01T00:00:00.000Z' as IsoDateTime,
          },
        ],
      }),
    );
    const period = maintenanceChorePeriod('weekly', harness.clock.now() as IsoDateTime, 'UTC');
    const chore = await loadChore(harness, choreTicketKey('deps', period));
    expect(chore?.ticketSnapshot?.description).toContain('- unreleased: pypi:sleepy');
    expect(chore?.ticketSnapshot?.description).toContain('2019-01-01');
    // The *finding line* says which of the two it is; the word appears elsewhere in the brief
    // (the chore's own "what to do" sentence), which is why the assertion is on the line.
    expect(chore?.ticketSnapshot?.description).not.toContain('- deprecated:');
  });

  it('runs the whole walk from the job handler the cron wakes', async () => {
    // The handler is what production actually calls; a pass only ever driven directly would leave
    // the one line between the queue and the work untested.
    const harness = harnessWith({
      features: { maintenance: { enabled: true, chores: ['kb'] } },
    });
    await registerMaintenanceSchedule({
      unitOfWork: harness.memory,
      store: harness.store,
      maintenance: storeDouble({ hygiene: HYGIENE }),
      settings: staticProjectSettings(() => harness.settings),
      jobs: harness.jobs,
      ids: harness.ids,
      clock: { now: () => harness.clock.now() as IsoDateTime },
      projects: async () => [PROJECT],
      timezone: 'UTC',
      baseUrl: 'https://app.example.test',
      redactor: countingRedactor,
    });
    const handler = harness.jobs.handlers.get(MAINTENANCE_SCHEDULE_QUEUE);
    await handler?.({
      id: 'job',
      queue: MAINTENANCE_SCHEDULE_QUEUE,
      data: {},
      signal: new AbortController().signal,
    });
    expect(harness.store.snapshot()).toHaveLength(1);
  });

  it('redacts the brief before it is stored, and counts what it redacted', async () => {
    const harness = harnessWith({
      features: { maintenance: { enabled: true, chores: ['kb'] } },
    });
    const planted: KbHygieneReport = {
      ...HYGIENE,
      findings: [
        {
          kind: 'link',
          path: 'technical/how-to-run.md',
          detail: `the runbook quotes ${PLANTED} in a curl example`,
        },
      ],
    };
    await pass(harness, storeDouble({ hygiene: planted }));

    const period = maintenanceChorePeriod('weekly', harness.clock.now() as IsoDateTime, 'UTC');
    const chore = await loadChore(harness, choreTicketKey('kb', period));
    expect(chore?.ticketSnapshot?.description).not.toContain(PLANTED);
    expect(chore?.ticketSnapshot?.description).toContain('[REDACTED:planted]');
    expect(chore?.ticketSnapshot?.redaction_count).toBe(1);
  });

  it('asks the dependency store for a window a year wide', async () => {
    let asked: string | null = null;
    const harness = harnessWith({
      features: { maintenance: { enabled: true, chores: ['deps'] } },
    });
    const store: MaintenanceStore = {
      maintenanceSpendSince: async () => 0,
      latestKbHygiene: async () => null,
      staleDependencies: async (_tx, _projectId, options) => {
        asked = options.unreleasedSince;
        return STALE;
      },
    };
    await pass(harness, store);
    const days = (Date.parse(harness.clock.now()) - Date.parse(asked as never)) / 86_400_000;
    expect(Math.round(days)).toBe(DEPENDENCY_UNRELEASED_DAYS);
  });
});

/**
 * The **admission** half of the dedicated budget: the scheduler stops creating chores, and the stage
 * executor stops a chore that was already created (WP-36, criterion 5).
 *
 * Both halves are needed and neither implies the other: a batch created before the month's spend
 * reached the cap would otherwise run to the end of the template on a cap that is already gone.
 * This is the fast-tier executioner for the executor's guard — WP-35's canary survey found a
 * one-line guard whose only executioner was a three-minute e2e and called it untested.
 */
describe('a chore run’s admission', () => {
  const REFINED = {
    goal: 'Clear the knowledge-base findings.',
    user_value: 'The knowledge base stays worth reading.',
    in_scope: ['the pages named in the brief'],
    out_of_scope: [],
    acceptance_criteria: [
      {
        id: 'ac1',
        given: 'the expired page',
        when: 'the chore is done',
        // biome-ignore lint/suspicious/noThenProperty: the published acceptance-criterion field name
        then: 'it is refreshed or removed',
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
  };

  const NOTES = {
    summary: 'Refreshed the expired page.',
    deviations_from_plan: [],
    tests_added: [],
    commands_run: [],
    known_gaps: [],
    followup_tickets: [],
    mr: null,
  };

  const choreHarness = (spentUsd: number, capUsd: number): PipelineHarness =>
    createPipelineHarness({
      projectId: PROJECT,
      settings: {
        config: {
          features: { maintenance: { enabled: true, budget_usd: capUsd, chores: ['kb'] } },
        } as never,
      },
      maintenanceSpentUsd: spentUsd,
      runs: {
        refinement: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: REFINED as never,
        },
        implementation: {
          status: 'completed',
          terminalReason: 'success',
          structuredOutput: NOTES as never,
        },
      },
    });

  const choreState = async (harness: PipelineHarness): Promise<string | null> =>
    harness.memory.transaction(async (scope) => {
      const stored = harness.store.snapshot()[0];
      return stored === null || stored === undefined
        ? null
        : ((await harness.store.tasks.load(scope.tx, stored.task.id))?.task.state ?? null);
    });

  it('pauses the chore when the month’s maintenance spend has reached the cap', async () => {
    // 9.80 spent of a 10 cap, and `refinement` may spend 2 (`DEFAULT_STAGE_RUN_BUDGET_USD`): the
    // comparison adds what this run may spend, so the guard fires before the run rather than one
    // run too late.
    const harness = choreHarness(9.8, 10);
    await pass(harness, storeDouble({ hygiene: HYGIENE }));
    await harness.drain();

    expect(await choreState(harness)).toBe('paused');
    expect(harness.specs).toEqual([]);
  });

  it('starts the same chore when the cap has room — the other direction', async () => {
    // A cap with room for the implementation stage too (whose own per-run cap is 15), so the walk
    // stops at the CI gate rather than at this guard — the difference between the two cases is the
    // spend and the cap, and nothing else.
    const harness = choreHarness(0, 100);
    await pass(harness, storeDouble({ hygiene: HYGIENE }));
    await harness.drain();

    expect(await choreState(harness)).not.toBe('paused');
    expect(harness.specs.map((spec) => spec.stage)).toEqual(['refinement', 'implementation']);
    // …and the run really was a chore's: the brief is what the planner put in front of it, which is
    // the whole reason a scheduled chore is not an agent started on an identifier (rule 82).
    expect(harness.specs[0]?.userPrompt).toContain('lessons/L-2025-01-01-old.md');
    // The mode is the ordinary one: a maintenance chore is delivery work (criterion 2).
    expect(harness.specs[0]?.mode).toBe('normal');
  });
});

describe('the period key', () => {
  it('is the day, the ISO week and the month, in the organisation’s zone', () => {
    const at = '2026-09-15T23:30:00.000Z' as IsoDateTime;
    expect(maintenanceChorePeriod('daily', at, 'UTC')).toBe('2026-09-15');
    expect(maintenanceChorePeriod('weekly', at, 'UTC')).toBe('2026-W38');
    expect(maintenanceChorePeriod('monthly', at, 'UTC')).toBe('2026-09');
    // The zone is not decoration: at 23:30 UTC it is already the next day in Auckland, and a
    // schedule that read the host's zone would create two chores for one period after a migration.
    expect(maintenanceChorePeriod('daily', at, 'Pacific/Auckland')).toBe('2026-09-16');
  });

  it('gives the ISO week its own year at a year boundary', () => {
    // 2027-01-01 is a Friday in ISO week 53 **of 2026**; a key of `2027-W53` would collide with the
    // real 2027-W53 eleven months later, which is why the week's year is the Thursday's.
    expect(maintenanceChorePeriod('weekly', '2027-01-01T12:00:00.000Z' as IsoDateTime, 'UTC')).toBe(
      '2026-W53',
    );
    expect(maintenanceChorePeriod('weekly', '2026-01-01T12:00:00.000Z' as IsoDateTime, 'UTC')).toBe(
      '2026-W01',
    );
  });
});

describe('the schedule itself', () => {
  it('registers one daily cron in the organisation’s zone, and a worker on its queue', async () => {
    const harness = harnessWith({ features: { maintenance: { enabled: true } } });
    await registerMaintenanceSchedule({
      unitOfWork: harness.memory,
      store: harness.store,
      maintenance: storeDouble(),
      settings: staticProjectSettings(() => harness.settings),
      jobs: harness.jobs,
      ids: harness.ids,
      clock: { now: () => harness.clock.now() as IsoDateTime },
      projects: async () => [],
      timezone: 'Europe/Prague',
      baseUrl: 'https://app.example.test',
      redactor: countingRedactor,
    });

    const crons = await harness.jobs.listCronSchedules();
    expect(crons).toHaveLength(1);
    expect(crons[0]).toMatchObject({
      queue: MAINTENANCE_SCHEDULE_QUEUE,
      cron: MAINTENANCE_SCHEDULE_CRON,
      // Never the host's zone: "04:35" has to be somebody's 04:35 (Q38).
      timezone: 'Europe/Prague',
    });
    expect(harness.jobs.handlers.has(MAINTENANCE_SCHEDULE_QUEUE)).toBe(true);
  });
});
