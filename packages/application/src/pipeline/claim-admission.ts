/**
 * **The admission re-check at the claim** — TD-031 §2 (backlog 744): *"the admission re-check
 * (`cost/guard.ts` and the task cap) — an admission refused at the claim withdraws the offer and
 * pauses the task exactly as today's admission does."*
 *
 * The stage executor admits a run when it **offers** it; an offer can then wait — for a worker of the
 * assignee, for the fallback, for a claimant with a free slot — while the organisation, the project
 * or the task spends. Both claimants (the server's, `claimant.ts`, and a remote worker's,
 * `remote-runs.ts`) ask {@link ClaimAdmission.recheck} inside the claim's own transaction, after the
 * claim statement, and **roll the claim back** when it refuses; {@link ClaimAdmission.refuse} then,
 * in a transaction of its own, closes the stage's offer (`closeStageOffer`: still open, so it is
 * withdrawn and its run ends `cancelled` at the measured zero) and pauses the task `Paused: budget`
 * with the scope that refused — the stage executor's own pause.
 *
 * ## The same questions, without counting the run twice
 *
 * - **The task cap** is the executor's formula unchanged: `tasks.cost_actual` plus the task's hold
 *   (`RunRepository.heldFor`, ended runs nobody measured) plus this stage's per-run cap. The run being
 *   claimed is live, so neither term contains it — the formula asks exactly what it asked at the offer.
 * - **The organisation and project budgets** (`BudgetGuard.blockingFor`) count every **live** run's
 *   reservation in their pending term (`../cost/pending.ts`), and the run being claimed is live
 *   (`created`), so it is asked with a reserve of **0**: its own reservation is in already.
 *
 * Only a **stage** offer is re-checked: an ask's admission is the ask executor's, and an ask is never
 * paused for a budget (it is refused, `ask/executor.ts`). A project whose configuration cannot be read
 * is not this check's to refuse — its offer was admitted against the configuration it could read, and
 * the stage executor's next admission refuses it by name.
 */
import type { Id, Slug } from '@platform/contracts';
import { type CommandContext, IllegalTransitionError, pauseTask } from '@platform/domain';
import { type BudgetGuard, blockingBudgetDetail } from '../cost/guard.js';
import type { EventStore } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import { closeStageOffer } from './offer-withdrawal.js';
import { type ProjectSettings, settingsAdmission } from './settings.js';
import {
  runBudgetUsd,
  taskBudgetDetail,
  taskBudgetExhausted,
  withTaskCap,
} from './stage-executor.js';
import type { PipelineStore } from './store.js';

/** Why a claim was refused: the platform's sentence and the cap that refused it. */
export interface ClaimRefusal {
  readonly reason: string;
  readonly budgetScope: 'task' | 'organization' | 'project';
}

/** The claimed run, as the claim's transaction knows it. */
export interface ClaimedForAdmission {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly kind: 'stage' | 'ask';
  readonly stage: Slug | null;
}

/** Thrown inside a claim's transaction to roll it back; carries what refused it. */
export class ClaimAdmissionRefused extends Error {
  override readonly name = 'ClaimAdmissionRefused';
  readonly claimed: ClaimedForAdmission;
  readonly refusal: ClaimRefusal;
  constructor(claimed: ClaimedForAdmission, refusal: ClaimRefusal) {
    super(`the claim of run ${claimed.runId} was refused at admission: ${refusal.reason}`);
    this.claimed = claimed;
    this.refusal = refusal;
  }
}

export interface ClaimAdmission {
  /** Inside the claim's transaction: `null` admits, a refusal is the caller's to roll back. */
  recheck(tx: Transaction, claimed: ClaimedForAdmission): Promise<ClaimRefusal | null>;
  /**
   * In a transaction of its own, after the claim rolled back: the offer closed and the task paused.
   * Answers whether it paused the task (`false`: the task had already moved — a person's command,
   * another claimant's refusal — and nothing was written).
   */
  refuse(
    scope: TransactionScope,
    claimed: ClaimedForAdmission,
    refusal: ClaimRefusal,
  ): Promise<boolean>;
}

export interface ClaimAdmissionOptions {
  readonly store: Pick<PipelineStore, 'tasks' | 'runs' | 'offers' | 'runCommands'>;
  readonly settings: (projectId: Id, tx?: Transaction) => Promise<ProjectSettings>;
  readonly budgets: BudgetGuard;
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly context: (taskId: Id) => CommandContext;
  readonly logger?: Logger;
}

export const createClaimAdmission = (options: ClaimAdmissionOptions): ClaimAdmission => {
  const logger = options.logger ?? silentLogger;
  return {
    recheck: async (tx, claimed) => {
      if (claimed.kind !== 'stage' || claimed.stage === null) return null;
      const stored = await options.store.tasks.load(tx, claimed.taskId);
      if (stored === null) return null;
      const readable = settingsAdmission(await options.settings(claimed.projectId, tx));
      if (readable.kind === 'refused') return null;
      const { settings } = readable;
      const reserve = runBudgetUsd(settings, claimed.stage);
      const held = await options.store.runs.heldFor(tx, claimed.taskId, reserve);
      const capped = withTaskCap(settings, await options.store.tasks.budgetCap(tx, claimed.taskId));
      if (taskBudgetExhausted(stored, capped, claimed.stage, held)) {
        return {
          reason: taskBudgetDetail(stored, capped, claimed.stage, held),
          budgetScope: 'task',
        };
      }
      // Reserve 0: the run being claimed is live, so the pending term holds its reservation already.
      const blocker = await options.budgets.blockingFor(
        tx,
        claimed.projectId,
        options.context(claimed.taskId).clock.now(),
        0,
      );
      if (blocker === null) return null;
      return {
        reason: blockingBudgetDetail(blocker),
        budgetScope: blocker.scope === 'org' ? 'organization' : 'project',
      };
    },

    refuse: async (scope, claimed, refusal) => {
      const stored = await options.store.tasks.load(scope.tx, claimed.taskId);
      if (stored === null) return false;
      const context = options.context(claimed.taskId);
      let decision: ReturnType<typeof pauseTask>;
      try {
        decision = pauseTask(
          stored.task,
          { reason: 'budget', budgetScope: refusal.budgetScope },
          context,
        );
      } catch (error) {
        if (error instanceof IllegalTransitionError) return false;
        throw error;
      }
      // `run_offers` → `runs` → `tasks` (TD-031's lock order): the offer is closed before the save.
      const closing = await closeStageOffer(
        { store: options.store, eventStore: options.eventStore },
        scope,
        {
          taskId: claimed.taskId,
          code: 'budget_at_claim',
          reason: `the task was paused at the claim: ${refusal.reason}`,
          context,
        },
      );
      await options.store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
      await scope.events.append([...closing.events, ...decision.events]);
      logger.info(
        { task_id: claimed.taskId, run_id: claimed.runId, budget_scope: refusal.budgetScope },
        'a claim was refused at admission: the offer is withdrawn and the task paused (budget)',
      );
      return true;
    },
  };
};
