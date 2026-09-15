/**
 * The maintenance scheduler — technical/02's `MaintenanceScheduler` saga, product/18:31 (WP-36).
 *
 * > product/18:31 — *"Scheduled chores within a dedicated budget: dependency bumps, flaky-test
 * > hunting, docs drift, lint debt, KB hygiene; **each produces a normal `chore` task**"*, and
 * > product/19:126's feature card names what it touches externally: **merge requests**.
 *
 * ## The schedule has no table, and that is this row's decision
 *
 * technical/02:32 defines a **ScheduledJob** aggregate — *"project, schedule, chore type, budget,
 * last run"* — and nothing in `03-data-model.md` or in `migrations/` has ever carried it. Four of
 * its five fields are already stored: `project` is the row the pass walks, `schedule`, `chore type`
 * and `budget` are `features.maintenance.{schedule, chores, budget_usd}` in the project's own
 * configuration document, which is where product/18 puts them (*"Wizard: schedule, budget, allowed
 * chore types"*). The fifth, **last run**, is the only thing a table would add — and it is derivable
 * from a row the platform already writes, because a chore task's key **is** its period:
 * `chore!<type>-<period>` under `unique (project_id, ticket_key, mode)`. So *"has this period's
 * chore been created?"* is `tasks.findByTicket`, a cron that fires twice creates one task, two
 * replicas racing lose one insert to the index rather than to a lock, and a `scheduled_jobs` table
 * would be a second copy of a schedule a repository owns and could rewrite.
 *
 * technical/02:32's line is **amended** rather than implemented (rule 8; the amendment is at the
 * line in that document). The precedent is TD-004's own *"index rebuilds, maintenance schedules"*
 * family, in which `registerPartitionMaintenance` and `registerPriceListMaintenance` both run on a
 * cron with no state of their own.
 *
 * ## One cron, daily, whatever the project's grain is
 *
 * The tick is daily; the **period key** decides whether anything is due. A weekly project gets one
 * chore per ISO week because the second tick of that week finds the first tick's task, and a
 * monthly project one per calendar month. That is one moving part instead of three schedules, and
 * it is why a missed tick (a process that was down at 04:35) costs nothing: the next tick is inside
 * the same period and creates what the missed one would have.
 *
 * ## A chore is an ordinary task
 *
 * One `tasks` row on the project's **own** `chore` template, `mode: 'normal'`, entered through
 * `applyDecision` exactly as intake enters a ticket's. Everything after that is the machinery every
 * task goes through: the interpreter, the gates, the iteration limits, the escalation, the workpad,
 * the cost ledger and the budget caps. There is no second pipeline and no new task state —
 * `onboarding/discovery.ts`'s argument, taken for the fourth time (`shadow/batch.ts` and
 * `bootstrap/collect.ts` are the second and third).
 *
 * **The WIP limit is honoured here, unlike in those three**, and the difference is the point: a
 * maintenance chore *is* delivery work — it opens a merge request and is dequeued on
 * `task.completed` like any other — so parking it behind a project's limit is the limit doing its
 * job, where parking a shadow batch would have parked it for ever. The chore is created and queued;
 * `schedulerHandler` starts it when the project has room.
 */
import type {
  Id,
  IsoDateTime,
  MaintenanceChoreType,
  MaintenanceSchedule,
  PipelineTemplate,
} from '@platform/contracts';
import { MAINTENANCE_CHORE_TYPES, ticketSnapshotSchema } from '@platform/contracts';
import type { ChoreFinding, CommandContext, MaintenanceConfig } from '@platform/domain';
import {
  choreRefusalOf,
  choreTicketKey,
  compilePipeline,
  createTask,
  interpret,
  maintenanceConfigOf,
  renderChoreBrief,
  resolveIterationLimits,
} from '@platform/domain';
import { PLATFORM_TICKET_PROVIDER } from '../pipeline/integrations.js';
import { enqueueStage } from '../pipeline/jobs.js';
import type { ProjectSettingsPort } from '../pipeline/settings.js';
import { monthStartUtc } from '../pipeline/stage-executor.js';
import {
  INITIAL_TASK_VERSION,
  PIPELINE_ACTOR,
  type PipelineStore,
  type StoredTask,
} from '../pipeline/store.js';
import {
  MAX_TICKET_DESCRIPTION_CHARS,
  MAX_TICKET_TITLE_CHARS,
} from '../pipeline/ticket-snapshot.js';
import { applyDecision } from '../pipeline/transitions.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { CronScheduleDefinition, JobHandler, Jobs, JobWorker } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { isoDateOf, zonedParts } from '../scheduling/zoned-time.js';
import type { MaintenanceStore } from './ports.js';

/** The queue TD-004's *"maintenance schedules"* family gets for this feature. */
export const MAINTENANCE_SCHEDULE_QUEUE = 'maintenance.schedule';

/**
 * 04:35, in the organisation's configured zone.
 *
 * After the knowledge hygiene (03:15), the partition maintenance (03:20) and the price list
 * (04:10), so the four nightly passes never contend, and long before a working day starts — a chore
 * created at 04:35 is queued when the team arrives rather than at lunchtime. The minute is odd for
 * `KNOWLEDGE_HYGIENE_CRON`'s reason.
 *
 * The **order matters for `kb`**: this pass reads the hygiene report the 03:15 pass wrote, so a
 * chore briefed today is briefed from this morning's findings rather than from yesterday's.
 */
export const MAINTENANCE_SCHEDULE_CRON = '35 4 * * *';

/** The cron key, so a second schedule on this queue cannot collide with the daily one. */
export const MAINTENANCE_CRON_KEY = 'daily';

/** Projects one pass considers, bounded like the hygiene pass's walk. */
export const MAX_MAINTENANCE_PROJECTS_PER_PASS = 200;

/** The template a chore task runs on — product/18's own *"a normal `chore` task"*. */
export const MAINTENANCE_TEMPLATE_ID = 'chore';

/**
 * How long since a package's last release before the `deps` chore calls it unmaintained.
 *
 * A year, and it is a *statement about the registry's answer* rather than a judgement about the
 * package: product/04:58 asks for the *"maintenance status"* of a dependency, the registry publishes
 * the last release date, and a package nobody has published for a year is the cheapest honest
 * reading of it. Twelve months rather than six because plenty of good libraries release annually,
 * and a chore that briefed a run on every one of them would be noise a team turns off.
 */
export const DEPENDENCY_UNRELEASED_DAYS = 365;

/** How many stale packages one brief names; the brief's own cap drops the rest (rule 18). */
export const MAX_DEPENDENCY_FINDINGS = 25;

/** What one chore type resolved to on one project, in one period. */
export type ChoreOutcome =
  /** A task was created and queued. */
  | { readonly status: 'created'; readonly taskId: Id; readonly findings: number }
  /** This period's task already exists — the cron fired twice, or two replicas did. */
  | { readonly status: 'already_created'; readonly taskId: Id }
  /** The platform established nothing to work on, which is not the same as a refusal. */
  | { readonly status: 'nothing_to_do'; readonly detail: string }
  /** This build cannot perform the chore type, by name (`MAINTENANCE_CHORES`). */
  | { readonly status: 'refused'; readonly reason: string; readonly detail: string }
  /** The dedicated budget is spent; this and every later chore of the batch is not created. */
  | { readonly status: 'over_budget'; readonly detail: string };

export interface ChoreResult {
  readonly chore: MaintenanceChoreType;
  readonly outcome: ChoreOutcome;
}

/** Why a whole project was skipped, before any chore type was considered. */
export type MaintenanceBlocker = 'feature_disabled' | 'no_chore_types' | 'no_chore_template';

export const MAINTENANCE_BLOCKED_DETAIL: Readonly<Record<MaintenanceBlocker, string>> = {
  feature_disabled:
    'the maintenance pipeline is off for this project (features.maintenance.enabled); nothing was scheduled',
  no_chore_types:
    'this project’s features.maintenance.chores is an empty list, which means “no chore type”; nothing was scheduled',
  no_chore_template:
    'this project’s settings define no "chore" template, so there is no pipeline for a maintenance chore to run on',
};

export interface ProjectMaintenanceReport {
  readonly projectId: Id;
  readonly period: string | null;
  readonly blocker: MaintenanceBlocker | null;
  readonly chores: readonly ChoreResult[];
}

export interface MaintenancePassReport {
  readonly projects: number;
  readonly created: number;
  readonly refused: number;
  readonly results: readonly ProjectMaintenanceReport[];
}

export interface MaintenanceOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly maintenance: MaintenanceStore;
  readonly settings: ProjectSettingsPort;
  readonly jobs: Jobs;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  /** Projects to consider, newest first — the composition root's own query (hygiene's shape). */
  readonly projects: (limit: number) => Promise<readonly Id[]>;
  /** The zone the period is read in: a week has to start at somebody's Monday (Q38). */
  readonly timezone: string;
  /** `APP_BASE_URL`; the project's own page stands in for a ticket URL a chore does not have. */
  readonly baseUrl: string;
  /**
   * TD-012's redactor for the brief this writes.
   *
   * Required, never defaulted (standing rule 31): a brief is built out of repository paths, package
   * names and a registry's own strings, which is third-party text on its way into a column that is
   * read into every prompt of the task.
   */
  readonly redactor: SecretRedactor;
  readonly logger?: Logger;
}

// ── The period ───────────────────────────────────────────────────────────────

/**
 * The period one chore is created once per, as a string that goes into the task's key.
 *
 * Read in the organisation's zone, never the host's: a weekly chore has to start at somebody's
 * Monday, and inheriting the container's zone is how a redeployment moves a schedule (the sentence
 * `CronScheduleDefinition.timezone` is required for).
 *
 *  - `daily` → `2026-09-15`
 *  - `weekly` → `2026-W38`, the **ISO** week, so the year of the key is the week's year and not the
 *    date's: 2027-01-01 is in week 53 of 2026, and a key that said `2027-W53` would collide with the
 *    real one eleven months later.
 *  - `monthly` → `2026-09`
 */
export const maintenanceChorePeriod = (
  schedule: MaintenanceSchedule,
  at: IsoDateTime,
  timezone: string,
): string => {
  const parts = zonedParts(new Date(at), timezone);
  if (schedule === 'daily') {
    return isoDateOf(parts);
  }
  if (schedule === 'monthly') {
    return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}`;
  }
  const { year, week } = isoWeekOf(parts);
  return `${String(year).padStart(4, '0')}-W${String(week).padStart(2, '0')}`;
};

/**
 * ISO-8601 week number of a zoned date, by the Thursday rule.
 *
 * Arithmetic on `Date.UTC` values rather than on a local `Date`: the parts are already the reading
 * in the organisation's zone, so UTC here is *"treat these numbers as a calendar"* and never a
 * second zone conversion.
 */
const isoWeekOf = (parts: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
}): { readonly year: number; readonly week: number } => {
  const dayMs = 24 * 60 * 60 * 1000;
  const date = Date.UTC(parts.year, parts.month - 1, parts.day);
  // The Thursday of this week decides which year the week belongs to.
  const thursday = date + (4 - parts.weekday) * dayMs;
  const year = new Date(thursday).getUTCFullYear();
  const january1 = Date.UTC(year, 0, 1);
  return { year, week: Math.floor((thursday - january1) / dayMs / 7) + 1 };
};

// ── The pass ─────────────────────────────────────────────────────────────────

const contextFor = (options: MaintenanceOptions, correlationId: Id | null): CommandContext => ({
  ids: options.ids,
  // The pipeline actor stamps the events: a scheduled chore is the platform's own, and there is no
  // human command to attribute it to (`bootstrap/collect.ts` takes the same position).
  actor: PIPELINE_ACTOR,
  clock: options.clock as CommandContext['clock'],
  correlationId,
  causeEventId: null,
});

/** One pass over every project. Exported beside the handler so a test can read the report. */
export const runMaintenancePass = async (
  options: MaintenanceOptions,
  input: { readonly projectId?: Id } = {},
): Promise<MaintenancePassReport> => {
  const logger = options.logger ?? silentLogger;
  const projects =
    input.projectId === undefined
      ? await options.projects(MAX_MAINTENANCE_PROJECTS_PER_PASS)
      : [input.projectId];
  const results: ProjectMaintenanceReport[] = [];
  for (const projectId of projects) {
    results.push(await scheduleProject(options, projectId));
  }
  const chores = results.flatMap((result) => result.chores);
  const report: MaintenancePassReport = {
    projects: results.length,
    created: chores.filter((entry) => entry.outcome.status === 'created').length,
    refused: chores.filter((entry) => entry.outcome.status === 'refused').length,
    results,
  };
  logger.info(
    {
      projects: report.projects,
      created: report.created,
      refused: report.refused,
      capped: report.projects >= MAX_MAINTENANCE_PROJECTS_PER_PASS,
    },
    'maintenance pass finished',
  );
  return report;
};

const scheduleProject = async (
  options: MaintenanceOptions,
  projectId: Id,
): Promise<ProjectMaintenanceReport> => {
  const logger = options.logger ?? silentLogger;
  const settings = await options.settings.forProject(projectId);
  const config: MaintenanceConfig = maintenanceConfigOf(settings.config);
  if (!config.enabled) {
    return { projectId, period: null, blocker: 'feature_disabled', chores: [] };
  }
  if (config.chores.length === 0) {
    logger.info({ project_id: projectId }, MAINTENANCE_BLOCKED_DETAIL.no_chore_types);
    return { projectId, period: null, blocker: 'no_chore_types', chores: [] };
  }
  const template = settings.templates[MAINTENANCE_TEMPLATE_ID];
  if (template === undefined) {
    logger.warn({ project_id: projectId }, MAINTENANCE_BLOCKED_DETAIL.no_chore_template);
    return { projectId, period: null, blocker: 'no_chore_template', chores: [] };
  }
  const period = maintenanceChorePeriod(config.schedule, options.clock.now(), options.timezone);

  /**
   * The refusals are decided **before** any transaction opens, so a build that can perform none of
   * a project's chore types opens none at all — and so that the log line naming the refusal is the
   * same whether or not a task was created afterwards (rule 18: the absent case is never quiet).
   */
  const chores: ChoreResult[] = [];
  const performable: MaintenanceChoreType[] = [];
  for (const chore of MAINTENANCE_CHORE_TYPES.filter((type) => config.chores.includes(type))) {
    const refusal = choreRefusalOf(chore);
    if (refusal === null) {
      performable.push(chore);
      continue;
    }
    chores.push({
      chore,
      outcome: { status: 'refused', reason: refusal.reason, detail: refusal.detail },
    });
    logger.warn(
      { project_id: projectId, chore, reason: refusal.reason, period },
      `the ${chore} chore is configured and this build cannot perform it: ${refusal.detail}`,
    );
  }

  const enqueued: { readonly work: Awaited<ReturnType<typeof applyDecision>>['work'] }[] = [];
  for (const chore of performable) {
    const outcome = await options.unitOfWork.transaction(async (scope) => {
      const ticketKey = choreTicketKey(chore, period);
      const existing = await options.store.tasks.findByTicket(scope.tx, {
        projectId,
        provider: PLATFORM_TICKET_PROVIDER,
        ticketKey,
        mode: 'normal',
      });
      if (existing !== null) {
        return {
          status: 'already_created',
          taskId: existing.task.id,
        } satisfies ChoreOutcome;
      }

      /**
       * The dedicated budget, read from the **ledger** rather than from a running total, and asked
       * **once per chore**, so the batch stops at the first chore whose creation would find the
       * month's maintenance spend already **at or past** the cap — `spent >= cap`, and the sentence
       * and the comparison say the same thing (rule 79: the effect is countable — the tasks that
       * were not created).
       *
       * It is deliberately *not* the executor's `spent + runBudgetUsd(stage) > cap`: this side is
       * deciding whether to create a **task**, whose whole template may run several stages over
       * several days, so there is no "what this run may spend" to add. The per-run question is
       * asked where a run is admitted, and the two together are why a batch created just under the
       * cap still stops rather than running to the end of its template.
       *
       * The window is the calendar month in UTC, `monthStartUtc`'s, because this is the same cap
       * mechanism WP-34 built for shadow mode and a second window would be a second thing to
       * explain. What is different is the predicate, and it is this feature's own: the chores this
       * scheduler created, by their platform-issued reference.
       */
      if (config.budgetUsd !== null) {
        const since = monthStartUtc(options.clock.now());
        const spent = await options.maintenance.maintenanceSpendSince(scope.tx, projectId, since);
        if (spent >= config.budgetUsd) {
          return {
            status: 'over_budget',
            detail: `this project’s maintenance budget for the month is spent: ${spent} of ${config.budgetUsd} USD since ${since}`,
          } satisfies ChoreOutcome;
        }
      }

      const evidence = await findingsFor(options, scope.tx, projectId, chore);
      if (evidence.findings.length === 0) {
        return { status: 'nothing_to_do', detail: evidence.empty } satisfies ChoreOutcome;
      }

      const brief = renderChoreBrief({
        type: chore,
        period,
        findings: evidence.findings,
        source: evidence.source,
      });
      const created = createTask(
        {
          id: options.ids.next(),
          projectId,
          ticket: {
            provider: PLATFORM_TICKET_PROVIDER,
            key: ticketKey,
            url: `${options.baseUrl.replace(/\/+$/, '')}/projects/${projectId}`,
          },
          template: MAINTENANCE_TEMPLATE_ID,
          mode: 'normal',
          limits: resolveIterationLimits(settings.config.pipeline?.limits),
        },
        contextFor(options, null),
      );
      const stored: StoredTask = {
        task: created.aggregate,
        template: template as PipelineTemplate,
        // Behind every ticket a human is waiting for: upkeep never jumps the delivery queue.
        priorityRank: 3,
        createdAt: options.clock.now(),
        branch: null,
        mr: null,
        workpad: null,
        costActualUsd: 0,
        estimateUsd: null,
        estimateBasis: null,
        estimateSamples: null,
        version: INITIAL_TASK_VERSION,
        ticketSnapshot: choreSnapshot(options, brief),
        ticketSnapshotAt: options.clock.now(),
        reviewSubject: null,
        historySample: null,
        riskClasses: [],
        coverage: null,
        dependencies: null,
        requiredReviewers: null,
        requestedByUserId: null,
      };
      await options.store.tasks.insert(scope.tx, stored);
      const pipeline = compilePipeline(MAINTENANCE_TEMPLATE_ID, stored.template);
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored,
        decision: interpret(pipeline, { kind: 'start' }),
        context: contextFor(options, stored.task.id),
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append([...created.events, ...applied.events]);
      enqueued.push({ work: applied.work });
      return {
        status: 'created',
        taskId: stored.task.id,
        findings: evidence.findings.length,
      } satisfies ChoreOutcome;
    });
    chores.push({ chore, outcome });
    if (outcome.status === 'over_budget') {
      logger.warn({ project_id: projectId, chore, period }, outcome.detail);
      // The batch stops: every later chore of this project would meet the same answer, and saying
      // it once is the report rather than a line per type.
      break;
    }
    if (outcome.status === 'nothing_to_do') {
      logger.info(
        { project_id: projectId, chore, period },
        `nothing to schedule for the ${chore} chore: ${outcome.detail}`,
      );
    }
    if (outcome.status === 'created') {
      logger.info(
        { project_id: projectId, chore, period, task_id: outcome.taskId },
        'a maintenance chore was scheduled',
      );
    }
  }

  for (const item of enqueued) {
    if (item.work !== null) {
      // After the commit: `Jobs.enqueue` does not join the transaction (TD-004), and the stage job
      // re-validates when it fires.
      await enqueueStage(options.jobs, item.work);
    }
  }
  return { projectId, period, blocker: null, chores };
};

/**
 * The brief as the task row stores it: **redacted, then cut**, like every other external text this
 * platform keeps (`boundTicketSnapshot`'s rule — an exact-match redactor cannot find a secret a cap
 * has already halved).
 *
 * It is stored as `tasks.ticket_snapshot` rather than in a column of its own, and that is a
 * decision worth stating: the column is *the words of the work item this task is about*, the prompt
 * renders it in the `ticket` data block, and a maintenance chore's work item is one the platform
 * itself wrote. The block's identity lines still say `provider: platform` and `key: chore!…`, so a
 * reader of the prompt can tell a scheduled chore from a ticket somebody opened.
 */
const choreSnapshot = (
  options: MaintenanceOptions,
  brief: { readonly title: string; readonly description: string },
) => {
  const title = options.redactor.redactText(brief.title);
  const description = options.redactor.redactText(brief.description);
  const cutTitle = title.value.slice(0, MAX_TICKET_TITLE_CHARS);
  const cutDescription = description.value.slice(0, MAX_TICKET_DESCRIPTION_CHARS);
  return ticketSnapshotSchema.parse({
    title: cutTitle,
    description: cutDescription,
    comments: [],
    truncated:
      cutTitle.length < title.value.length || cutDescription.length < description.value.length,
    comment_count: 0,
    redaction_count: title.count + description.count,
    // There is no ticket, so there is no instant at which one was updated. `null` is the honest
    // answer and never `now()`, which would claim a provider said something.
    ticket_updated_at: null,
  });
};

/**
 * What the platform has established for one chore type.
 *
 * Three strings rather than two, because *"nothing to do"* and *"here is the evidence"* are
 * different sentences and a reader needs the right one: `source` is what the brief cites, `empty`
 * is what the log line and the report say when there is nothing — and it names **why** there is
 * nothing, which is the difference between a clean project and a build that asked nobody
 * (standing rules 16 and 18).
 */
const findingsFor = async (
  options: MaintenanceOptions,
  tx: Parameters<MaintenanceStore['latestKbHygiene']>[0],
  projectId: Id,
  chore: MaintenanceChoreType,
): Promise<{
  readonly findings: readonly ChoreFinding[];
  readonly source: string;
  readonly empty: string;
}> => {
  if (chore === 'kb') {
    const report = await options.maintenance.latestKbHygiene(tx, projectId);
    if (report === null) {
      return {
        findings: [],
        source: 'the nightly knowledge hygiene pass',
        empty:
          'the nightly knowledge hygiene pass has never written a report for this project, so there is nothing it has established',
      };
    }
    return {
      findings: report.findings.map((finding) => ({
        kind: finding.kind,
        subject: finding.path,
        detail: finding.detail,
      })),
      source: `the nightly knowledge hygiene pass of ${report.createdAt}, over ${report.documents} indexed document(s)${
        report.commitSha === null ? '' : ` at ${report.commitSha}`
      }`,
      empty: `the nightly knowledge hygiene pass of ${report.createdAt} found nothing to fix`,
    };
  }
  const unreleasedSince = new Date(
    Date.parse(options.clock.now()) - DEPENDENCY_UNRELEASED_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString() as IsoDateTime;
  const stale = await options.maintenance.staleDependencies(tx, projectId, {
    unreleasedSince,
    limit: MAX_DEPENDENCY_FINDINGS,
  });
  return {
    findings: stale.map((entry) => ({
      kind: entry.deprecated ? 'deprecated' : 'unreleased',
      subject: `${entry.ecosystem}:${entry.name}`,
      detail: entry.deprecated
        ? `the registry reports this package deprecated; it is declared in ${entry.path}`
        : `the registry has published no release since ${entry.lastPublishedAt ?? 'an unknown date'}; it is declared in ${entry.path}`,
    })),
    source: `the package registry answers this project’s dependency gate recorded (WP-38), for packages deprecated or unreleased since ${unreleasedSince.slice(0, 10)}`,
    empty: `no package this project’s dependency gate recorded is reported deprecated or unreleased since ${unreleasedSince.slice(0, 10)} — and a build whose operator declared no registry host (APP_DEPENDENCY_REGISTRY_HOSTS) records none at all, which is a fact about this platform rather than about the packages`,
  };
};

// ── The cron that drives it ──────────────────────────────────────────────────

export const maintenanceSchedule = (timezone: string): CronScheduleDefinition => ({
  queue: MAINTENANCE_SCHEDULE_QUEUE,
  cron: MAINTENANCE_SCHEDULE_CRON,
  timezone,
  key: MAINTENANCE_CRON_KEY,
});

export const maintenancePassHandler =
  (options: MaintenanceOptions): JobHandler =>
  async () => {
    await runMaintenancePass(options);
  };

/**
 * Declares the queue, registers the daily schedule and subscribes the handler.
 *
 * Idempotent: safe on every boot and from every replica — the queue and the schedule are keyed, and
 * `exclusive` keeps two replicas from walking the projects at once (`registerPartitionMaintenance`
 * and `registerPriceListMaintenance` are the two precedents, and this is the third member of
 * TD-004's *"maintenance schedules"* family).
 */
export const registerMaintenanceSchedule = async (
  options: MaintenanceOptions,
): Promise<JobWorker> => {
  await options.jobs.defineQueue({
    name: MAINTENANCE_SCHEDULE_QUEUE,
    policy: 'exclusive',
    retryLimit: 1,
    retryDelaySeconds: 300,
    expireInSeconds: 15 * 60,
  });
  await options.jobs.scheduleCron(maintenanceSchedule(options.timezone));
  return options.jobs.work({
    queue: MAINTENANCE_SCHEDULE_QUEUE,
    handler: maintenancePassHandler(options),
    concurrency: 1,
  });
};
