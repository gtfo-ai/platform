/**
 * What the onboarding wizard needs from the outside world — product/06, product/17 (WP-21).
 *
 * Three ports, each named for the question it answers rather than for the table it happens to sit
 * on. Nothing here reads a repository or calls a provider: the *evaluation* is a pure fold over
 * answers somebody else obtained, which is what makes it testable without a database and what
 * keeps the ring rule intact.
 */
import type { Id, IntegrationType, IsoDateTime, RiskClass } from '@platform/contracts';
import type { ReadinessDetector } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';

/** One criterion of a stored evaluation — product/17's row, with who answered it. */
export interface StoredReadinessCriterion {
  readonly id: string;
  readonly passed: boolean;
  /**
   * Why. **Untrusted for the eleven criteria the Discovery agent answers** (BD-022): it is model
   * prose about a repository the platform does not control, so it is redacted and bounded on the
   * way in and rendered as text on the way out.
   */
  readonly evidence: string;
  /** Platform text from `READINESS_CRITERIA`, copied at write time so a read needs no join. */
  readonly unlocks: string;
  readonly detectedBy: ReadinessDetector;
}

export interface ReadinessEvaluation {
  readonly id: Id;
  readonly projectId: Id;
  readonly level: number;
  readonly criteria: readonly StoredReadinessCriterion[];
  readonly evaluatedAt: IsoDateTime;
  /** `readiness_evaluations.source` — which producer wrote it (`discovery`, `recheck`). */
  readonly source: string;
}

/**
 * The writer `readiness_evaluations` never had.
 *
 * Two writes, and they are deliberately one method: the row is the history and
 * `projects.readiness_level` is the projection every board badge reads, so a build that wrote one
 * without the other would show a level no evaluation supports. It takes a transaction like every
 * other store in this ring, because the pair has to land together.
 *
 * The `projects` write is **narrow** — one column — for the reason `tasks.saveWorkpad` is
 * (standing rule 79): this writer runs in a job, beside whatever else is editing the project row,
 * and a whole-row `update projects set …` from here would put back a name, a config or an autonomy
 * dial that a wizard step changed a moment ago.
 */
export interface ReadinessStore {
  record(tx: Transaction, evaluation: ReadinessEvaluation): Promise<void>;
  /** The project's most recent evaluation, or `null` when it has never been evaluated. */
  latest(projectId: Id): Promise<ReadinessEvaluation | null>;
  /**
   * Stores the risk classes a discovery run proposed — `projects.proposed_risk_classes`, migration
   * 0026 (WP-37).
   *
   * On this store rather than on one of its own because it is written by the same job, in the same
   * transaction, from the same artifact: one wake-up records what the Discovery agent found, and a
   * second port for a second column of the same row would be a second thing to compose.
   *
   * **It is a proposal and writing it changes no behaviour.** `policies.risk_classes` is untouched;
   * the wizard reads this column and the operator's acceptance goes through the configuration write
   * (product/06: nothing is committed without acceptance). The value is config-shaped so acceptance
   * is a copy rather than a translation.
   *
   * The `projects` write is **narrow**, for the reason `readiness_level`'s is (standing rule 79).
   */
  saveRiskClassProposal(
    tx: Transaction,
    projectId: Id,
    classes: Readonly<Record<string, RiskClass>>,
  ): Promise<void>;
}

/**
 * The three criteria the **platform** answers for itself — see `READINESS_CRITERIA`'s docblock.
 *
 * Every field is nullable and `null` means *"the platform could not find out"*, which is not the
 * same fact as `false` and is reported as such in the evidence. A git provider that is down must
 * not make a protected branch look unprotected in a stored record a human then reads.
 */
export interface PlatformReadinessSignals {
  /** R9 — `isBranchProtected` on the project's default branch, through the git binding. */
  readonly defaultBranchProtected: boolean | null;
  /** R11 — the integration types this project is bound to; `logs` or `errors` satisfies it. */
  readonly boundIntegrationTypes: readonly IntegrationType[];
  /** R12 — vault-relative paths of the indexed knowledge documents, for `knowledgeCompleteness`. */
  readonly indexedKnowledgePaths: readonly string[] | null;
}

/** Reads {@link PlatformReadinessSignals}. Performs I/O, so it is never called in a transaction. */
export interface PlatformReadinessProbe {
  read(projectId: Id): Promise<PlatformReadinessSignals>;
}
