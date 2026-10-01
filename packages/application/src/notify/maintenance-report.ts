/**
 * The nightly maintenance pass's report, published in the project's **daily digest** (WP-65,
 * PROGRESS backlog 107).
 *
 * `runMaintenanceSchedule` has always computed a per-project report — which chores it created,
 * which it refused, whether it stopped on the dedicated budget — and returned it to a log line.
 * Every configured chore type this build cannot perform was then logged at `warn` on every daily
 * pass: two lines a day on a stock project that turns maintenance on (`[deps, flaky, docs]`), about
 * 730 a year, in the channel an operator watches for real failures, while *"what did last night's
 * pass do?"* had no answer anywhere.
 *
 * The report is published where an operator already looks, at the pass's own grain: one
 * notification row per project, class `maintenance_report`, **planned for the digest**. The digest
 * then carries it with the day's other lines — and because it now has a reader, the scheduler logs a
 * refusal it has reported at `info` rather than `warn`. Where the report has **no** reader — the
 * project's digest is off, or it has no chat binding — nothing is recorded (a row nothing can
 * deliver would be counted by the undelivered gauge for ever) and the refusal stays a `warn`.
 *
 * Refusing the value in the configuration schema was the other way to stop the noise, and it is
 * explicitly not taken: `features.maintenance.chores` has accepted all five types since the key
 * existed, the schema is strict, and a project whose whole `.agentic/config.yml` failed to parse on
 * a value it has always parsed would lose every other setting in it — since WP-63 that includes the
 * repository's own file.
 *
 * ## One report per project per period, and a new one only when there is news
 *
 * The row's identity (`cause_event_id`) is a name-derived id over the project, the chore period and
 * the **news** — the chore types that have a task this period, and the budget stop — so:
 *
 *  - the first pass of a period records the report, refusals included;
 *  - a later pass in the same period with nothing new (its chores `already_created`, the same
 *    refusals) lands on the same identity, and the unique key answers `already_reported` — the
 *    refusal is not re-announced, which is what backlog 107 asked for;
 *  - a later pass that **creates** a chore (a `deps` finding that appeared on Wednesday of a weekly
 *    period) is news, gets a new identity, and is reported.
 *
 * For a daily schedule the period is the day, so the report is daily — and so is the pass's work.
 *
 * ## A pause at Observe: one line when it begins, one when it ends (Q111 (c), WP-113)
 *
 * A project skipped before any chore type was considered has no period and no news, and is
 * `nothing_to_report` — every day it is skipped. The one skip that is reported is a **change** in the
 * pause at Observe, which the pass works out from the blocker it recorded last time
 * (`maintenanceTransitionOf`, `projects.maintenance_last_blocker`): a row of its own, in the digest,
 * when the pause begins and when it ends, and nothing on the days between
 * ({@link maintenanceTransitionDetail}). The founder's answer to Q111, reversible.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  MAINTENANCE_BLOCKED_DETAIL,
  type ProjectMaintenanceReport,
} from '../maintenance/scheduler.js';
import { integrationsForProject, noRunScopedSecrets } from '../pipeline/integrations.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { NotifyOptions } from './options.js';
import { digestSettingsOf } from './policy.js';
import { notificationDraft } from './render.js';

export type MaintenanceReportPublication =
  /** A row was recorded; the project's next digest carries it. */
  | 'recorded'
  /** This period's report with the same news is already recorded. */
  | 'already_reported'
  /**
   * Nothing to say: the project was skipped before any chore type was considered, and the pass
   * neither began nor ended a pause at Observe (WP-113).
   */
  | 'nothing_to_report'
  /** The project's digest is off or it has no chat binding — nobody would read the row. */
  | 'no_reader';

/** Where the scheduler publishes a project's report. The scheduler's only notify dependency. */
export interface MaintenanceReportSink {
  publish(report: ProjectMaintenanceReport): Promise<MaintenanceReportPublication>;
}

/**
 * A stable uuid-shaped identity for a name — **not** cryptographic, and it need not be.
 *
 * It is one half of `notifications`' unique key, the other halves being this project and this
 * class, so it has to be distinct only across one project's maintenance reports: a handful per
 * period. The application ring has no hash port, and a platform identity must never need redacting
 * (the rule `idempotencyScopeFor` states), which a digest of platform text satisfies. cyrb53-style
 * mixing over four independent 32-bit lanes, laid out as an RFC 9562 version-8 (custom) uuid.
 */
export const nameDerivedId = (name: string): Id => {
  const lanes = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    for (let lane = 0; lane < lanes.length; lane += 1) {
      lanes[lane] = Math.imul((lanes[lane] as number) ^ code, 0x01000193 + lane * 0x10);
    }
  }
  for (let lane = 0; lane < lanes.length; lane += 1) {
    let value = lanes[lane] as number;
    value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
    lanes[lane] = (value ^ (value >>> 16)) >>> 0;
  }
  const hex = lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}` as Id;
};

/**
 * What in a report is news — the part of its identity beyond the period: the chore types that have
 * a task **in this period** (created now or by an earlier pass — `already_created` counts, so the
 * second day of a weekly period has the same news as the first), and whether the budget stopped the
 * batch. Refusals and *nothing to do* are not news: they are what the first report of the period
 * already said.
 */
const newsOf = (report: ProjectMaintenanceReport): string =>
  report.chores
    .flatMap((entry) =>
      entry.outcome.status === 'created' || entry.outcome.status === 'already_created'
        ? [`${entry.chore}:task`]
        : entry.outcome.status === 'over_budget'
          ? ['budget:stopped']
          : [],
    )
    .sort()
    .join(',');

/**
 * The report as one digest line's detail — platform text throughout: chore type names, the
 * refusal codes of `MAINTENANCE_CHORES`, counts and the period.
 */
export const maintenanceReportDetail = (report: ProjectMaintenanceReport): string | null => {
  const named = (status: string): string[] =>
    report.chores.filter((entry) => entry.outcome.status === status).map((entry) => entry.chore);
  const parts: string[] = [];
  if (report.blocker === 'no_chore_template') {
    parts.push('No chore was scheduled: the project defines no "chore" template.');
  }
  const created = report.chores.flatMap((entry) =>
    entry.outcome.status === 'created'
      ? [
          `${entry.chore} (${entry.outcome.findings} finding${entry.outcome.findings === 1 ? '' : 's'})`,
        ]
      : [],
  );
  if (created.length > 0) {
    parts.push(`Created: ${created.join(', ')}.`);
  }
  const already = named('already_created');
  if (already.length > 0) {
    parts.push(`Already created this period: ${already.join(', ')}.`);
  }
  const nothing = named('nothing_to_do');
  if (nothing.length > 0) {
    parts.push(`Nothing to do: ${nothing.join(', ')}.`);
  }
  const refused = report.chores.flatMap((entry) =>
    entry.outcome.status === 'refused' ? [`${entry.chore} (${entry.outcome.reason})`] : [],
  );
  if (refused.length > 0) {
    parts.push(
      `Refused — configured, and this build cannot perform them: ${refused.join(', ')}. Remove them from features.maintenance.chores to stop this line.`,
    );
  }
  if (named('over_budget').length > 0) {
    parts.push('Stopped: the maintenance budget for the month is spent.');
  }
  return parts.length === 0 ? null : `Period ${report.period ?? 'none'}. ${parts.join(' ')}`;
};

/**
 * Q111 (c), WP-113: the one digest line a pause at Observe gets when it **begins**, and the one it
 * gets when it **ends** — platform text throughout; `null` for a pass that changed neither.
 *
 * Its own row, not a sentence inside the period's report: the period report's identity is its period
 * and its news (`newsOf`), and a pause has no period (`period: null` while paused), so a transition
 * folded into it would either have no identity to land on or change the one the report has. The
 * pause is the project's **level in force**, which the organisation's maximum can lower too
 * (WP-93) — so the line names both causes, because the maintainer reading it may not be the person
 * who moved either.
 */
export const maintenanceTransitionDetail = (report: ProjectMaintenanceReport): string | null => {
  if (report.transition === 'pause_began') {
    return 'Maintenance is paused at Observe: the autonomy level in force for this project is Observe — its own dial, or an organisation maximum of Observe — and Observe means no agent merge requests, so the nightly pass creates no chore. This is said once; the next line is when the pause ends.';
  }
  if (report.transition === 'pause_ended') {
    return report.blocker === null
      ? 'Maintenance is no longer paused at Observe: the nightly pass schedules this project’s chores again.'
      : `Maintenance is no longer paused at Observe, and the nightly pass still schedules nothing: ${MAINTENANCE_BLOCKED_DETAIL[report.blocker]}.`;
  }
  return null;
};

/** What the sink needs — the notify band's collaborators the scheduler's composition also holds. */
export type MaintenanceReportSinkOptions = Pick<
  NotifyOptions,
  'settings' | 'integrations' | 'unitOfWork' | 'notifications' | 'ids' | 'clock' | 'logger'
>;

export const createMaintenanceReportSink = (
  options: MaintenanceReportSinkOptions,
): MaintenanceReportSink => ({
  publish: async (report) => {
    const logger: Logger = options.logger ?? silentLogger;
    const periodDetail = maintenanceReportDetail(report);
    const detail = report.period === null ? null : periodDetail;
    const transition = maintenanceTransitionDetail(report);
    if (detail === null && transition === null) {
      return 'nothing_to_report';
    }
    const settings = await options.settings.forProject(report.projectId);
    if (!digestSettingsOf(settings.config).enabled) {
      return 'no_reader';
    }
    let integrations: Awaited<ReturnType<typeof integrationsForProject>>;
    try {
      // Outside every transaction, like every other resolution of a project's bindings.
      integrations = await integrationsForProject(
        options.integrations,
        report.projectId,
        noRunScopedSecrets(),
      );
    } catch (cause) {
      /**
       * A chat binding that cannot be built is the notify duty's failure to raise, and it will, on
       * the project's next notification. Here it costs the report its reader and nothing else, so
       * it is named and the scheduler keeps its refusals at `warn`.
       */
      logger.warn(
        { project_id: report.projectId, err: cause },
        'maintenance report: the project’s chat binding could not be loaded, so the report was not recorded',
      );
      return 'no_reader';
    }
    const chat = integrations.communication;
    if (chat === null) {
      return 'no_reader';
    }
    const record = async (text: string, identity: string): Promise<boolean> => {
      const redacted = chat.redactor.redactText(text);
      const draft = notificationDraft({
        notificationClass: 'maintenance_report',
        subject: { name: 'this project', url: null },
        detail: redacted.value,
      });
      return options.unitOfWork.transaction(async (scope) =>
        options.notifications.record(scope.tx, {
          id: options.ids.next(),
          projectId: report.projectId,
          taskId: null,
          notificationClass: 'maintenance_report',
          causeEventId: nameDerivedId(identity),
          title: draft.title,
          detail: draft.detail,
          url: null,
          urgent: false,
          // Always the digest: the report is the pass's, and the digest is the surface at its grain.
          plannedDelivery: 'digest',
          mode: 'normal',
          createdAt: options.clock.now() as IsoDateTime,
          redactionCount: redacted.count,
        }),
      );
    };
    /**
     * The period report first and the transition second, so a failure in either leaves the
     * recorded blocker unmoved (the scheduler writes it only after a publication that did not
     * throw) and the next pass announces the transition again. The transition's identity is the
     * project, the transition, the blocker it moved to and the **day**, so a second announcement
     * the same day lands on the same row (`already_reported`) rather than a second line.
     */
    const periodRecorded =
      detail === null
        ? null
        : await record(
            detail,
            `maintenance-report:${report.projectId}:${report.period}:${newsOf(report)}`,
          );
    const transitionRecorded =
      transition === null
        ? null
        : await record(
            transition,
            `maintenance-transition:${report.projectId}:${report.transition}:${report.blocker ?? 'none'}:${options.clock.now().slice(0, 10)}`,
          );
    return periodRecorded === true || transitionRecorded === true ? 'recorded' : 'already_reported';
  },
});
