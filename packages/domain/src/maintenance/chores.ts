/**
 * The maintenance pipeline's five chore types, what each one can establish on this build, and the
 * brief a scheduled chore hands its run — product/18:31, product/04:120, product/19:126 (WP-36).
 *
 * > product/18:31 — *"Scheduled chores within a dedicated budget: dependency bumps, flaky-test
 * > hunting, docs drift, lint debt, KB hygiene; each produces a normal `chore` task"*.
 *
 * ## Two of the five can be performed and three are refused **by name**
 *
 * `features.maintenance.chores` has shipped with all five values since the key existed, and a
 * schedule that accepted a type it cannot perform would spend a run producing nothing — or, worse,
 * skip it silently, which is the quiet absent case standing rule 18 exists for. So the catalogue
 * below is the decision, stated per type with its evidence, and {@link choreRefusalOf} is the one
 * reader:
 *
 *  - **`kb`** — performed. The nightly hygiene pass (WP-18b) already computes a project's knowledge
 *    findings into `kb_health_reports`; this chore turns the latest report into a task's brief. It
 *    does **not** compute them a second time.
 *  - **`deps`** — performed. WP-38's dependency gate records what a task's diff added into
 *    `tasks.dependencies`, with the registry's licence and last release beside each package; this
 *    chore briefs a task on the ones the registry called deprecated or has not published in a year.
 *    A build whose operator declared no registry host (`APP_DEPENDENCY_REGISTRY_HOSTS`, empty by
 *    default) has `status: 'not_checked'` on every package and therefore nothing established — that
 *    is *nothing to do*, not a finding, and the scheduler says which.
 *  - **`docs`** — refused. Drift detection does not exist: `policies.drift_without_direction` is a
 *    configuration key with no reader anywhere in the tree, and nothing else compares a repository's
 *    documentation with its code.
 *  - **`flaky`** — refused. product/04:65 says it in the platform's own words: *"The tamper check,
 *    the reproduction gate and flaky detection are not implemented"*, so no signal exists to brief a
 *    run on.
 *  - **`lint`** — refused. PROGRESS backlog **49**: no run of any role may execute a project
 *    command on this build — `DEFAULT_IMPLEMENTATION_ALLOW` grants no test, lint, format or build
 *    command, a project may only *narrow* the maximum (BD-025 §2), and an unmatched command falls to
 *    `ask`, which an unattended run denies. Q69 is the product half. A lint-debt chore is exactly a
 *    task whose whole content is running the project's linter, so this one is refused rather than
 *    started to produce a list of refusals.
 *
 * A refusal here is **not** a silent skip anywhere: the scheduler logs it by name, reports it, and
 * the wizard's own feature card names which chore types this build performs.
 *
 * ## The reference a chore task carries is platform-issued, and the period is in it
 *
 * `tasks.ticket_*` is `not null` and `unique (project_id, ticket_key, mode)`, so the identity of a
 * scheduled chore is its key: `chore!<type>-<period>` where the period is the schedule's own grain
 * ({@link maintenanceChorePeriod}'s callers). That makes the unique index the idempotency — a cron
 * that fires twice in a period creates **one** task — and it means the platform needs no "last run"
 * column to know whether this period's chore exists. The provider is `platform`, which every ticket
 * read and every ticket write refuses by name, so no maintenance task ever asks a provider about a
 * key nobody issued (PROGRESS backlog **62**).
 */
import type { MaintenanceChoreType, MaintenanceSchedule } from '@platform/contracts';
import {
  DEFAULT_MAINTENANCE_SCHEDULE,
  MAINTENANCE_CHORE_TYPES,
  maintenanceChoreSchema,
  maintenanceScheduleSchema,
} from '@platform/contracts';
import type { ConfigValues } from '../config/effective-config.js';

export type { MaintenanceChoreType };
export { MAINTENANCE_CHORE_TYPES };

/** Why a chore type this build ships a switch for cannot be performed by it. */
export type MaintenanceChoreRefusal =
  | 'no_drift_detector'
  | 'no_flaky_detection'
  | 'no_project_command';

export interface MaintenanceChoreEntry {
  /** What a task of this type is briefed to do, in one sentence. */
  readonly does: string;
  /** `null` when this build can perform it; otherwise the named refusal. */
  readonly refusal: MaintenanceChoreRefusal | null;
  /** The sentence a human reads — a log line's `detail`, and the report's. */
  readonly detail: string;
}

/**
 * The five types, each with its answer. A `satisfies Record<MaintenanceChoreType, …>` rather than a
 * lookup with a fallback: a sixth chore type added to the configuration schema must fail the
 * typecheck here rather than fall through to *"performed"*, which is the direction that would put a
 * run on a signal that does not exist.
 */
export const MAINTENANCE_CHORES = {
  deps: {
    does: 'bump or replace the packages the registry reports deprecated or unmaintained',
    refusal: null,
    detail:
      'briefed from what WP-38’s dependency gate recorded on this project’s tasks, with the registry’s licence and last release',
  },
  flaky: {
    does: 'hunt flaky tests',
    refusal: 'no_flaky_detection',
    detail:
      'this build detects no flaky test: product/04 says the CI gate is pass/fail on the pipeline’s status and that flaky detection is not implemented, so a flaky-test chore would be a run with no findings to work from',
  },
  docs: {
    does: 'fix documentation that has drifted from the code',
    refusal: 'no_drift_detector',
    detail:
      'this build detects no documentation drift: `policies.drift_without_direction` is a configuration key with no reader, and nothing compares a repository’s documentation with its code',
  },
  lint: {
    does: 'pay down lint debt',
    refusal: 'no_project_command',
    detail:
      'no run of any role may execute a project command on this build (PROGRESS backlog 49, Q69): the shipped command maximum grants no lint, test, format or build command and a project may only narrow it, so a lint-debt run could not run the linter it exists for',
  },
  kb: {
    does: 'clear the knowledge-base findings the nightly hygiene pass recorded',
    refusal: null,
    detail:
      'briefed from the latest `kb_health_reports` row the nightly hygiene pass wrote (WP-18b), which this chore reads rather than recomputes',
  },
} as const satisfies Readonly<Record<MaintenanceChoreType, MaintenanceChoreEntry>>;

/** The refusal for a chore type this build cannot perform, or `null`. One reader, one table. */
export const choreRefusalOf = (
  type: MaintenanceChoreType,
): { readonly reason: MaintenanceChoreRefusal; readonly detail: string } | null => {
  const entry = MAINTENANCE_CHORES[type];
  return entry.refusal === null ? null : { reason: entry.refusal, detail: entry.detail };
};

/** The chore types this build performs, in the configuration schema's own order. */
export const PERFORMABLE_CHORE_TYPES: readonly MaintenanceChoreType[] =
  MAINTENANCE_CHORE_TYPES.filter((type) => MAINTENANCE_CHORES[type].refusal === null);

/** The separator `mr!<iid>` and `lint!<key>` use: no provider issues a key containing one. */
export const MAINTENANCE_TICKET_PREFIX = 'chore!';

/**
 * `chore!<type>-<period>` — the platform-issued reference of one scheduled chore.
 *
 * The period is part of the key rather than a column, which is what makes the schedule idempotent
 * without storing it: `unique (project_id, ticket_key, mode)` admits one task per type per period,
 * so a cron that fires twice, two replicas that fire at once, and a pass that is retried after a
 * crash all converge on the same single task.
 */
export const choreTicketKey = (type: MaintenanceChoreType, period: string): string =>
  `${MAINTENANCE_TICKET_PREFIX}${type}-${period}`;

/**
 * Does this reference name a chore **the platform scheduled**?
 *
 * The predicate the dedicated budget is measured over, and the reason it is not `tasks.template`:
 * a chore ticket a human filed is a `chore` template task too, and charging their delivery to the
 * maintenance cap would stop the maintenance batch for work maintenance never did. It is not
 * `runs.mode` either — a maintenance chore's runs are ordinary delivery runs, which is criterion 2
 * of this row ("no second pipeline") — so the honest filter is the platform-issued reference, which
 * only this scheduler writes.
 */
export const namesAMaintenanceChore = (ticket: {
  readonly provider: string;
  readonly key: string;
}): boolean => ticket.provider === 'platform' && ticket.key.startsWith(MAINTENANCE_TICKET_PREFIX);

/** The chore type a maintenance reference names, or `null` for anything else. */
export const choreTypeOfTicketKey = (key: string): MaintenanceChoreType | null => {
  if (!key.startsWith(MAINTENANCE_TICKET_PREFIX)) {
    return null;
  }
  const rest = key.slice(MAINTENANCE_TICKET_PREFIX.length);
  return (
    MAINTENANCE_CHORE_TYPES.find((type) => rest === type || rest.startsWith(`${type}-`)) ?? null
  );
};

// ── What the project configured ──────────────────────────────────────────────

export interface MaintenanceConfig {
  readonly enabled: boolean;
  readonly schedule: MaintenanceSchedule;
  /** `features.maintenance.budget_usd`, or `null` for *"no dedicated cap"*. */
  readonly budgetUsd: number | null;
  readonly chores: readonly MaintenanceChoreType[];
  /** True when the project named no list at all, so the platform chose one. */
  readonly choresDefaulted: boolean;
}

/**
 * `features.maintenance`, **parsed rather than cast**.
 *
 * `ConfigValues` is typed from a schema the *repository* wrote, so a value that somehow failed it
 * must not reach a scheduler decision: an unparseable schedule falls back to product/18's own
 * default and an unparseable chore entry is dropped, which is the fail-quiet direction because the
 * only thing it can cost is a chore that is not created (standing rule 20 — nothing here is a
 * mutation).
 *
 * An **absent** `chores` list means the types this build can perform; an **explicitly empty** one
 * means no chore type, which is the fail-closed reading of *"the types I named"* and the same
 * answer `review_only.paths` gives. The shipped default is neither — `PLATFORM_DEFAULT_CONFIG`
 * carries technical/12's `[deps, flaky, docs]`, of which two are refused by name.
 */
export const maintenanceConfigOf = (config: ConfigValues): MaintenanceConfig => {
  const raw = (
    config.features as
      | {
          readonly maintenance?: {
            readonly enabled?: unknown;
            readonly schedule?: unknown;
            readonly budget_usd?: unknown;
            readonly chores?: unknown;
          };
        }
      | undefined
  )?.maintenance;
  const schedule = maintenanceScheduleSchema.safeParse(raw?.schedule);
  const budget = raw?.budget_usd;
  const declared = Array.isArray(raw?.chores) ? raw.chores : null;
  return {
    enabled: raw?.enabled === true,
    schedule: schedule.success ? schedule.data : DEFAULT_MAINTENANCE_SCHEDULE,
    budgetUsd: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : null,
    chores:
      declared === null
        ? PERFORMABLE_CHORE_TYPES
        : declared.flatMap((entry) => {
            const parsed = maintenanceChoreSchema.safeParse(entry);
            return parsed.success ? [parsed.data] : [];
          }),
    choresDefaulted: declared === null,
  };
};

/**
 * The *"dedicated budget"*, or `null` — `features.maintenance.budget_usd`.
 *
 * Here rather than beside the scheduler because **two** rings read it: the scheduler, which stops a
 * batch at the chore that would pass the cap, and the stage executor, which refuses a maintenance
 * run's admission when the month's chore spend plus what this stage may spend would pass it. Two
 * readings of one key drift apart (standing rule 41), so there is one function.
 */
export const maintenanceBudgetUsdOf = (config: ConfigValues): number | null =>
  maintenanceConfigOf(config).budgetUsd;

// ── The brief ────────────────────────────────────────────────────────────────

/**
 * How many findings one brief carries, and how long each line may be.
 *
 * Derived rather than chosen, from the caps the same prompt already applies: a brief is the task's
 * *ticket* as far as the prompt is concerned, so it is bounded like one —
 * `MAX_TICKET_DESCRIPTION_CHARS` is 20 000 characters and the whole brief is cut to it at the write
 * (`application/maintenance/scheduler.ts`). These two keep a single hostile path or detail from
 * consuming the brief before the cut does: 20 findings × 400 characters is 8 000, comfortably
 * inside it, and the same order as the twenty comments a ticket snapshot carries.
 */
export const MAX_CHORE_FINDINGS = 20;
export const MAX_CHORE_FINDING_CHARS = 400;

/** One line of evidence the platform established, and can point at. */
export interface ChoreFinding {
  /** A short platform word for the kind of finding (`expired`, `deprecated`, …). */
  readonly kind: string;
  /** The repository path or package the finding is about — untrusted external text (BD-022). */
  readonly subject: string;
  /** What the platform observed — untrusted external text where a registry or a page supplied it. */
  readonly detail: string;
}

export interface ChoreBrief {
  readonly title: string;
  readonly description: string;
  /** Findings the cap dropped, so *"nothing else"* is never mistaken for *"nothing more"*. */
  readonly dropped: number;
}

const CHORE_TITLES: Readonly<Record<MaintenanceChoreType, string>> = {
  deps: 'Dependency maintenance',
  flaky: 'Flaky test hunt',
  docs: 'Documentation drift',
  lint: 'Lint debt',
  kb: 'Knowledge base hygiene',
};

const line = (finding: ChoreFinding): string => {
  const text = `- ${finding.kind}: ${finding.subject} — ${finding.detail}`;
  return text.length <= MAX_CHORE_FINDING_CHARS
    ? text
    : `${text.slice(0, MAX_CHORE_FINDING_CHARS)}…`;
};

/**
 * The brief a scheduled chore hands its first stage, as a title and a description.
 *
 * It is **the task's own words**, written by the platform, and it is what stops a maintenance run
 * being *"an agent started on an identifier"* (standing rule 82): the run reads what it is for out
 * of its own prompt, which is also why the e2e's fake runner can pick its scenario from the prompt
 * rather than from the stage id.
 *
 * Pure, so the shape is unit-testable without a database. The *bounding and redaction* of the
 * result belong to the caller, beside every other write of external text into `tasks`
 * (`boundTicketSnapshot`'s rule: redact, then cut).
 */
export const renderChoreBrief = (input: {
  readonly type: MaintenanceChoreType;
  readonly period: string;
  readonly findings: readonly ChoreFinding[];
  /** What produced the findings, in the platform's own words — never a model's claim. */
  readonly source: string;
}): ChoreBrief => {
  const kept = input.findings.slice(0, MAX_CHORE_FINDINGS);
  const dropped = input.findings.length - kept.length;
  const entry = MAINTENANCE_CHORES[input.type];
  return {
    title: `${CHORE_TITLES[input.type]} (${input.period})`,
    description: [
      `This is a maintenance chore the platform scheduled for the ${input.period} period. There is no ticket and no reporter: the work below is what the platform itself observed.`,
      '',
      `What to do: ${entry.does}.`,
      '',
      `Evidence (${input.source}):`,
      ...kept.map(line),
      ...(dropped === 0
        ? []
        : ['', `…and ${dropped} more finding(s) the platform did not list here.`]),
      '',
      'Keep the change small and mechanical, in one merge request, and do not change behaviour that is not named above. If nothing above still holds, say so in the implementation notes and change nothing.',
    ].join('\n'),
    dropped,
  };
};
