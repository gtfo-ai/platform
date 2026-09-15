/**
 * What the maintenance scheduler reads, as a port — WP-36.
 *
 * Three reads, and none of them is a provider call: a scheduled chore is briefed entirely from what
 * the platform has already recorded about the project (WP-18b's nightly hygiene report and WP-38's
 * dependency records), and its cap is measured against the ledger. That is why the whole pass runs
 * inside its own transaction with no `assertOutsideTransaction` to honour — there is nothing outside
 * to call.
 *
 * The **spend** half is separated into {@link MaintenanceSpendReader} because the stage executor
 * needs exactly that one method and has no business reading a hygiene report: a port that offered
 * it either would be an invitation (`StageExecutorShadowPort`'s argument, taken again).
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';

/**
 * This project's spend on chores **the maintenance scheduler created**, since an instant.
 *
 * The predicate is the platform-issued reference (`namesAMaintenanceChore`), not `tasks.template`
 * and not `runs.mode`: a `chore` ticket a human filed runs on the same template, and a maintenance
 * chore's runs are ordinary delivery runs. Measured from `cost_entries` — the ledger, where
 * lagging would be a defect — rather than from `tasks.cost_actual`, which the workpad job can lag
 * (WP-34's assumption (e), taken again for the same reason).
 */
export interface MaintenanceSpendReader {
  maintenanceSpendSince(tx: Transaction, projectId: Id, since: IsoDateTime): Promise<number>;
}

/** The latest nightly hygiene report for a project — WP-18b's `kb_health_reports`. */
export interface KbHygieneReport {
  /** The vault commit the pass read, or `null` when it could read none. */
  readonly commitSha: string | null;
  readonly createdAt: IsoDateTime;
  readonly documents: number;
  readonly findings: readonly {
    readonly kind: string;
    readonly path: string;
    readonly detail: string;
  }[];
}

/** One package a task added that the registry reports deprecated or long unreleased (WP-38). */
export interface StaleDependency {
  readonly ecosystem: string;
  readonly name: string;
  /** The manifest or lockfile it was read out of — repository text, redacted at WP-38's write. */
  readonly path: string;
  readonly deprecated: boolean;
  readonly lastPublishedAt: IsoDateTime | null;
}

export interface MaintenanceStore extends MaintenanceSpendReader {
  /**
   * The newest `kb_health_reports` row for this project, or `null` when the hygiene pass has never
   * run on it. `null` is *"nothing has been established"*, never *"the knowledge base is clean"* —
   * the two are different sentences and the scheduler prints a different one for each (rule 18).
   */
  latestKbHygiene(tx: Transaction, projectId: Id): Promise<KbHygieneReport | null>;
  /**
   * Packages this project's tasks added whose recorded registry metadata says *deprecated*, or
   * whose last release predates `unreleasedSince`.
   *
   * Only rows the registry actually answered for are considered: a package whose metadata status is
   * `not_checked` (the shipped state, with no `APP_DEPENDENCY_REGISTRY_HOSTS` declared) establishes
   * nothing, and briefing a run on it would be publishing a non-answer as a finding.
   */
  staleDependencies(
    tx: Transaction,
    projectId: Id,
    options: { readonly unreleasedSince: IsoDateTime; readonly limit: number },
  ): Promise<readonly StaleDependency[]>;
}
