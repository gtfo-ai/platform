/**
 * The stage executor — product/04's "Run": one execution of an agent stage.
 *
 * It is driven by the `stage.execute` job (TD-004, `stately` per task), never by an event handler,
 * for one reason: a run takes minutes and an event handler holds a database transaction. The shape
 * is therefore **transaction, no transaction, transaction**:
 *
 * ```
 * tx  1   load the task, re-validate, check the budget, create the Run,   → run.created, run.offered
 *         store its sealed plan, offer it — and the job ends here (WP-276)
 * ——      a claimant claims the offer (`./claimant.ts`), reads the plan   → run.claimed
 *         back, starts the runner (the CLI spawn marker)                   → run.started
 * tx  2   store the artifact and the outcome                            → run.finished | run.failed,
 *         (`settleRun`, `./settle.ts`, since WP-275)                       artifact.created,
 *                                                                          task.stage.completed
 * ```
 *
 * **Since WP-276 the job ends at the offer** (TD-031 decision 3): this module is transaction 1 only.
 * The run waits `created` for a claimant — the server's claimant loop, composed by configuration, or
 * (WP-281) a remote worker — which runs it from the stored plan and settles it through `settleRun`.
 * What replaced the job's singleton for the run's duration is three things: the per-task partial
 * unique index over open or claimed stage offers; {@link revalidateOpen}'s question *does this stage
 * entry already have a live run?* (a duplicate wake-up succeeds doing nothing, and a wake-up for a
 * **new** entry whose previous run is still being stopped answers `waiting` and is fired again); and
 * every task transition that leaves the stage closing the offer in its own transaction
 * (`./offer-withdrawal.ts`).
 *
 * Transaction 2 is the `settleRun` command since WP-275 (TD-031 decision 3): the same writes, moved
 * out of this module so that a run settled outside the job (WP-276's claimant, a remote worker) is
 * settled by the same code, idempotent on the run and its claim's epoch. Since WP-275a it is given
 * only `{ runId, fence, outcome, stopReason }` and reads the rest back, the start failure's ending
 * is its `not_started` branch, and the session runs from the plan transaction 1 stored
 * (`./run-package.ts`), never from this module's memory of it. Since WP-275b the run is `created`
 * when its row is written, `starting` at the claim and `running` — with `run.started` — only at the
 * CLI spawn marker (`./cli-spawn.ts`).
 *
 * Neither transaction is nested and neither is open while the run is. The job worker's own
 * concurrency is therefore **additive** to the dispatcher's `2 × concurrency + 1` pool floor rather
 * than covered by it — see {@link StageExecutorOptions.concurrency}.
 *
 * ## Re-validation, because the enqueue is not in the handler's transaction
 *
 * The job that brought us here was enqueued *after* the handler that decided to run this stage
 * committed, and the port has no cancel (TD-004: "every timer job re-validates state when it
 * fires"). So the first thing tx 1 does is check that the task still exists, is still `active`, is
 * still at this stage and is still on this attempt. Finding nothing to do is a **success**: a
 * duplicate wake-up, a task a human paused in the meantime, and a stage that has already moved on
 * all land here, and none of them is an error.
 *
 * ## `budget_exceeded` is two different endings
 *
 * WP-12 stops a run whose result carried no usable `total_cost_usd` with status `budget_exceeded`
 * and terminal reason `error_max_budget_usd`, because `RunTerminalReason` is a closed contract with
 * no name for the fault — and it carries the distinct name in the `run_stopped` transcript row's
 * `data.reason`. A blind stop is **not** an overspend, and the two need different endings: an
 * overspend pauses the task so a human can raise the cap (product/09), while a CLI that stopped
 * reporting what it spent is a fault that escalates. Transaction 2 (`./settle.ts`) therefore branches on
 * `data.reason` from the transcript — the structured field — rather than on the status, or on a
 * substring of the human-readable `error`. The runner takes one sink for every run it drives, so
 * the reason arrives through {@link RunStopReasons} rather than through a sink this module wraps,
 * and this module hands it to `settleRun` as the request's `stopReason`.
 *
 * A third reading of `error_max_budget_usd` is not a budget ending here at all. Its status is
 * `completed`: the run delivered a valid artifact in the turn that crossed its cap (product owner,
 * 2026-10-05, PROGRESS backlog 466). It takes the ordinary completed path. The artifact is stored,
 * the stage completes, the run row and `run.finished` carry the reason and the cost, and the spend is
 * added to the task. Nothing pauses the task. The next run's admission still reads the task cap.
 */
import type { ContextPackRecord, Effort, Id, IsoDateTime, Slug } from '@platform/contracts';
import type {
  CommandContext,
  PausedBudgetScope,
  PipelineStage,
  PromptObservabilityExcerpt,
} from '@platform/domain';
import {
  canTransitionTask,
  createRun,
  DEFAULT_STAGE_RUN_BUDGET_USD,
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
  maintenanceBudgetUsdOf,
  namesAMaintenanceChore,
  pauseTask,
  recordRunCreated,
} from '@platform/domain';
import { redactedPromptsWithheld } from '../config/repository-config.js';
import { type BudgetGuard, blockingBudgetDetail, noBudgetGuard } from '../cost/guard.js';
import type { LateCostRecorder } from '../cost/late.js';
import {
  type CapSpend,
  capIsSpent,
  capSpendDetail,
  type Hold,
  holdDetail,
} from '../cost/pending.js';
import { redactTextSearchTerms } from '../knowledge/text-search-record.js';
import type { MaintenanceSpendReader } from '../maintenance/ports.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { RunPlanSealer } from '../ports/run-plan-sealer.js';
import type { ClaudeRunner, RunSpec } from '../ports/runner.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import type { WorkingCalendar } from '../scheduling/working-calendar.js';
import { questionTimeoutOf } from './deadline-rules.js';
import type { RunLeaseOptions } from './lease.js';
import { endWithdrawnRun } from './offer-withdrawal.js';
import { offerRun } from './offers.js';
import { REFREEZE_PENDING_SENTENCE, refrozen, refrozenColumns } from './refreeze.js';
import { RUN_PLAN_MAX_BYTES, RunPlanTooLargeError, sealRunPlan } from './run-package.js';
import { type RunSecretEnvironment, runRedactorFor } from './run-redaction.js';
import { type ProjectSettings, settingsAdmission } from './settings.js';
import { runSettingsSnapshot } from './settings-snapshot.js';
import { escalate, type SettleRunRequest, type SettleRunResult, settleRun } from './settle.js';
import { revalidate } from './stage-revalidation.js';
import type { RunStopReasons } from './stop-reasons.js';
import type {
  AppliedChecklistRecord,
  AttachedReturnFeedback,
  EndedRun,
  OfferWithdrawalReason,
  PipelineStore,
  ReturnCause,
  SavedAttempt,
  StoredArtifact,
  StoredTask,
} from './store.js';
import {
  escalateTaskAfterConflict,
  retryOnTaskConflict,
  TaskConflictExhaustedError,
} from './task-conflict.js';
import { closeParkedStageRow } from './transitions.js';

export interface StageRunRequest {
  readonly runId: Id;
  readonly stage: PipelineStage;
  readonly attempt: number;
  readonly task: StoredTask;
  readonly artifacts: readonly StoredArtifact[];
  readonly settings: ProjectSettings;
  /** Why the task came back to this stage, when it did (`task.stage.returned.reason`). */
  readonly returnFeedback: string | null;
  /**
   * The length {@link returnFeedback} had before its producer cut it (WP-81: the CI gate's log
   * excerpt), or `null`/absent — the prompt's `return_feedback` marker announces the cut.
   */
  readonly returnFeedbackOriginalChars?: number | null;
  /**
   * The artifact that caused this attempt's return, when one did (WP-83: the returning attempt's
   * own verdict, `ReturnFeedback.cause`) — absent for a first entry, a forward entry, and a return
   * no artifact caused. The planner shows a returned stage this verdict and no other.
   */
  readonly returnCause?: ReturnCause | null;
  /**
   * The gate's last failure a person attached to this attempt's return (WP-152,
   * `ReturnFeedback.attached`) — absent or `null` for every other return. When present,
   * {@link returnFeedback} is the person's note and the prompt carries both, as two blocks.
   */
  readonly attachedFeedback?: AttachedReturnFeedback | null;
  /**
   * The commit a **shadow** run's workspace is checked out at — Q82 (a), PROGRESS backlog 71.
   *
   * `null` means *"this run has no comparison base"*, which is every ordinary task and a shadow
   * task whose ticket had no human merge request. `checkoutRefOf` in the planner is what turns it
   * (or the task's own branch) into `RunSpec.checkoutRef`.
   */
  readonly checkoutBase: string | null;
  /** This attempt's model and effort, when a human chose them ({@link StageExecutionJob}). */
  readonly overrides?: {
    readonly model?: string;
    readonly effort?: Effort;
  };
  /**
   * The paths the task's own merge request changes, read by the `stage.execute` job before a
   * **Reviewer** run of a pipeline task (WP-73, PROGRESS backlog 218), redacted. `undefined` when no
   * read was made — any other role, a task with no merge request, or a review of a merge request the
   * platform already holds (`reviewSubject`). {@link reviewChecklistsOf} matches risk classes on
   * them beside the Implementation Plan's paths.
   */
  readonly mergeRequestPaths?: readonly string[];
  /**
   * The bug pre-fetch's excerpts, read by the `stage.execute` job before an **Investigator** run
   * (WP-89, `observability-prefetch.ts`), bounded and redacted. `undefined` when no read was made —
   * any other role, or a project with neither observability binding — and the prompt then carries
   * no observability block at all.
   */
  readonly observability?: readonly PromptObservabilityExcerpt[];
  /**
   * The latest ended run of this stage, when it saved unfinished work (PROGRESS backlog 467) — read
   * at admission by `RunRepository.lastSavedWork`. The planner tells the run about it when the branch
   * it pushed is the branch this run checks out (`previousAttemptFor`). Absent or `null` otherwise.
   */
  readonly previousAttempt?: SavedAttempt | null;
  /**
   * How the latest ended run of this stage ended, however it ended (PROGRESS backlog 476) — read at
   * admission by `RunRepository.lastEnded`, for the sentence that says why this attempt exists.
   * Absent or `null` when the stage has no ended run.
   */
  readonly previousRun?: EndedRun | null;
}

/** What a planner returns: the spec the runner is given, and the audit record of what went in. */
export interface StageRunPlan {
  readonly spec: RunSpec;
  /**
   * `run.started.context_pack` — technical/12's per-run record of the knowledge the prompt was
   * built from.
   *
   * It travels **beside** the spec rather than inside it because the two have different audiences:
   * the runner needs paths to write into the workspace, and the audit needs scores, token counts
   * and the `validated` flag of every document that did *not* make it. A record derived from the
   * spec could not carry the second.
   */
  readonly contextPack: ContextPackRecord;
  /**
   * The review checklists this run's prompt carried — `ReviewVerdict.checklists_applied` (WP-45,
   * Q83).
   *
   * Set by a planner for a **Reviewer** run and absent for every other: the executor stamps it onto
   * the verdict the run returns, replacing whatever the model wrote there, because *"which
   * checklist was applied"* is a fact about the prompt the platform built and not something a
   * model may report about itself. Absent means *not recorded* (the field is stored as `null`),
   * which is a different fact from `[]`, *"the Reviewer was given no checklist"*.
   */
  readonly reviewChecklists?: readonly AppliedChecklistRecord[];
}

/** One `ReviewVerdict.checklists_applied` entry — defined beside the run plan that stores it. */
export type { AppliedChecklistRecord } from './store.js';

/**
 * Builds the `RunSpec` for one stage.
 *
 * A port rather than a function, because what a spec contains belongs to other work packages: the
 * prompt layers and the pack are `createStageRunPlanner` (`./planner.js`) and the workspace is
 * WP-14's. **It performs I/O** — retrieval reads the knowledge index — which is why the executor
 * calls it between its two transactions and not inside either.
 */
export interface StageRunPlanner {
  plan(request: StageRunRequest): Promise<StageRunPlan>;
}

export type StageExecutionOutcome =
  /**
   * The run is **offered** (WP-276): its row, its sealed plan and its offer are committed, and the job
   * has ended — a claimant runs it and settles it.
   */
  | { readonly kind: 'offered'; readonly runId: Id }
  /**
   * The task's **previous** stage entry still has a live run — claimed, its stop recorded by the
   * transition that left it — so this entry's offer would break the per-task index (WP-276). The
   * caller fires the job again after {@link STAGE_WAIT_FOR_PREVIOUS_RUN_MS}.
   */
  | { readonly kind: 'waiting'; readonly reason: string; readonly runId: Id }
  /** The run happened and its result has been recorded. */
  | { readonly kind: 'ran'; readonly runId: Id; readonly verdict: string | null }
  /**
   * Nothing to do: the task moved on, was paused, or the job is a duplicate.
   *
   * `supersededBy` is set when the only thing wrong with the job is its **attempt**: the task is
   * running at this stage on a newer one (PROGRESS backlog 494). The caller forwards the wake-up to
   * that attempt, because `stage.execute` is `stately` per task and the newer attempt's own enqueue
   * may have been coalesced onto this very job.
   */
  | { readonly kind: 'skipped'; readonly reason: string; readonly supersededBy?: number }
  /** A budget stopped it; the task is `paused` and a human may raise the cap. */
  | { readonly kind: 'paused'; readonly reason: string }
  /** The run ended without a usable result; the pipeline escalates on the event. */
  | { readonly kind: 'failed'; readonly runId: Id; readonly reason: string }
  /**
   * Every attempt to write the task lost a race, so the task is parked for a human (WP-15e).
   *
   * An **outcome** kind and not a task state: the task is in `needs_human`, which is the state that
   * already means "a human must act" (Q59's answer, reused rather than re-spelled). The caller logs
   * it and does not re-enqueue — the escalation is the ending.
   */
  | { readonly kind: 'escalated'; readonly reason: string }
  /**
   * The run could not be **started** for a transport reason and the task is untouched: the caller
   * re-enqueues the stage (Q59(a), WP-15g).
   *
   * Distinct from `failed` because the task is still `active` at this stage on this attempt — only
   * the `runs` row was failed — so the caller owes it a wake-up. {@link StageExecutor} deliberately
   * does not enqueue one itself: it holds no `Jobs`, and the queue policy (`stately`, the singleton
   * key, the delay) belongs to `pipeline/jobs.ts`, which already owns the same shape for a gate that
   * answers "not yet".
   */
  /**
   * **The run was handed back by its process's own stop** (WP-144, PROGRESS backlog 432): the run is
   * ended `failed`/`shutdown`, the task is untouched — still at this stage, on this attempt, its
   * stage row open — and the caller re-enqueues the **same stage entry** after
   * `SHUTDOWN_HAND_BACK_DELAY_MS`. `handBacks` is this entry's count including this one, read off
   * the runs' end reasons (`RunRepository.shutdownEndings`); the one past
   * {@link MAX_SHUTDOWN_HAND_BACKS} is a `failed` escalation instead, never this kind.
   */
  | {
      readonly kind: 'handed_back';
      readonly runId: Id;
      readonly reason: string;
      readonly handBacks: number;
    }
  | {
      readonly kind: 'retry';
      readonly runId: Id;
      readonly reason: string;
      /** Start attempts spent so far, this failure included. Bounded by {@link MAX_RUN_START_ATTEMPTS}. */
      readonly startAttempts: number;
    }
  /**
   * **The stage entry is planned once more** (WP-285, WP-286, TD-031 §§11–12): its run ended
   * `rate_limited` (`cause: 'usage_limited'`) or the lease sweep ended it `lease_expired`
   * (`cause: 'lost'`), and it was the entry's first such ending (`task_stages.usage_limited_runs`,
   * `lost_runs`). The task is untouched — still at this stage, on this attempt, its stage row open —
   * and the stage's `stage.execute` is enqueued after the commit; its offer carries the limited or
   * lost worker in its exclusions. The second such ending escalates instead, never this kind.
   */
  | {
      readonly kind: 'replanned';
      readonly runId: Id;
      readonly reason: string;
      readonly cause: 'usage_limited' | 'lost';
    };

export interface StageExecutorOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly runner: ClaudeRunner;
  readonly planner: StageRunPlanner;
  /** Where `run_stopped.data.reason` comes from; see `./stop-reasons.js`. */
  readonly stopReasons: RunStopReasons;
  /** A fresh `CommandContext` per command: ids, clock and the pipeline's system actor. */
  readonly context: (correlationId: Id) => CommandContext;
  /** The project's settings; `tx` when asked inside a transaction (settle's `run_plan_missing`). */
  readonly settings: (projectId: Id, tx?: Transaction) => Promise<ProjectSettings>;
  /**
   * The organisation's working calendar (WP-56) — what a blocking question's `deadline_at` is
   * computed on. Required: a question stored without one is a question nothing ever expires, which
   * is exactly PROGRESS backlog 74, and `PipelineRuntimeOptions.calendar` hands it down.
   */
  readonly calendar: WorkingCalendar;
  /**
   * **TD-012 step 2** — the gitleaks-derived pattern rules — over what this executor *stores*
   * (WP-52 round 2).
   *
   * Required, not optional: an optional security dependency is an absent one (standing rule 31),
   * and it is the same redactor `routes/commands.ts`, the epic split and the ask executor are
   * given (`PipelineRuntimeOptions.redactor` hands it down).
   *
   * **It is composed with step 1 rather than replacing it, because the decision is not optional
   * about either.** TD-012 reads *"Before any write to … artifacts: (1) replace every secret value
   * the platform injected … (2) apply a curated subset of gitleaks' rule set"*, and round 1 of this
   * row shipped step 1 alone at the artifact write while `claude-runner.ts` composed **both** for
   * the transcript of the very same model message. So a credential the model *read out of the
   * repository* — one the platform never injected and step 1 therefore cannot know — was redacted
   * in `run_messages` and stored verbatim in `artifacts.data`. The permission direction made that
   * worse rather than neutral: `transcript.read` is `member` and `artifact.read` is `viewer`, so
   * the weaker-redacted copy was the one served to the lower role, through the route this very work
   * package added.
   *
   * The order is TD-012's own — step 1, then step 2 — which is also `createClaudeRunner`'s
   * (`composeRedactors(deps.injectedSecretRedactorFor(spec), patternRedactor())`). It matters for
   * the placeholder a value ends up carrying: an injected credential should read
   * `[REDACTED:integration:anthropic_api_key]`, which names *which* credential, rather than the
   * pattern rules' `[REDACTED sha256:…]`, which does not.
   */
  readonly redactor: SecretRedactor;
  /**
   * The organisation and project budgets (BD-010, WP-19), asked inside the admission transaction.
   *
   * **Absent is `noBudgetGuard`**, which never blocks: a deployment that has no `budgets` rows
   * behaves exactly as it did before this port existed, and a test that asserts a task is *not*
   * paused must therefore say which guard it composed (standing rule 10). The task scope is not
   * here — it is {@link taskBudgetExhausted} against the project's configuration, which is where
   * product/09's "$50 default, per template" lives.
   */
  readonly budgets?: BudgetGuard;
  /**
   * Shadow mode's own two questions, both answered from `shadow_batches` / `cost_entries` (WP-34).
   *
   * **Absent is "neither is asked"**, which is what a process composed without shadow mode should
   * do: `features.shadow_mode.budget_usd` is the *separate* cap product/18 promises, so a build
   * that cannot read shadow spend must not pretend it is unspent — but it also cannot start a
   * shadow task, because `startShadowBatch` is the only thing that creates one and it takes the
   * same port. The pairing is what makes the absence safe, and it is stated rather than assumed
   * (standing rule 31's question: what is this guarantee worth when the collaborator is missing).
   */
  readonly shadow?: StageExecutorShadowPort;
  /**
   * What the stage executor asks about a **history bootstrap** task, and about nothing else (WP-35).
   *
   * **Absent is "not asked"**, which is what a process composed without the bootstrap should do:
   * `features.history_bootstrap.budget_usd` is product/19 §18's *"budget cap default $20, shown
   * before start"*, and a build that cannot read a batch's spend must not pretend it is unspent —
   * but it also cannot start a mining task, because `collectHistory` is the only thing that creates
   * one and it takes this port's writer.
   */
  readonly bootstrap?: StageExecutorBootstrapPort;
  /**
   * What the stage executor asks about a **maintenance chore**, and about nothing else (WP-36).
   *
   * **Absent is "not asked"**, the same bargain the two ports above make:
   * `features.maintenance.budget_usd` is product/18:31's *"dedicated budget"*, and a build that
   * cannot read what the month's chores have spent must not pretend it is unspent. Unlike them, the
   * pairing that makes the absence safe is a **schedule** rather than a command — a process without
   * this port also composes no `registerMaintenanceSchedule`, so it creates no chore to admit.
   *
   * The question is asked only for a task whose reference `namesAMaintenanceChore` recognises, so
   * an ordinary delivery pays no query for it.
   */
  readonly maintenance?: MaintenanceSpendReader;
  /**
   * The run **lease** this process holds while a stage is in flight (WP-47, `./lease.js`).
   *
   * **Absent is "this process claims no lease"**, and the consequence is stated rather than
   * implied: a run it starts and then dies inside is invisible to the lease half of the sweep and
   * is caught only by the wall-clock backstop, about an hour later. That is the behaviour of every
   * build before WP-47, so absence is a composition that has not opted in rather than a regression
   * — and `apps/server/src/pipeline.ts` opts in.
   */
  readonly lease?: RunLeaseOptions;
  /**
   * What a run's spend does when **another writer ended the run first** (Q70 (b), `../cost/late.js`).
   *
   * **Absent is `noLateCostRecorder`**, which writes nothing — the behaviour of every build before
   * WP-47, where a cancelled run's tokens reached no `cost_entries` row, no rollup and no budget.
   * It is a port rather than a `CostStore` because this module must not know what a price list is,
   * which is the argument {@link StageExecutorOptions.budgets} already makes one field up.
   */
  readonly lateCost?: LateCostRecorder;
  /**
   * The seal over a run's stored plan (WP-275a, TD-031's 2026-11-04 amendment §2): the envelope
   * under `APP_SECRET_KEY` in production (`createEnvelopeRunPlanSealer`). Required: the session runs
   * from the read-back plan, so a composition without it could run nothing.
   */
  readonly runPlans: RunPlanSealer;
  /**
   * This process's `agentRunEnvironment` — the secret **values** a run is given, re-attached to the
   * read-back spec (`loadRunPackage`) and redacted by settle (`runRedactorFor`), the names coming
   * from the plan. **Absent is an empty environment**: a run whose plan names a secret then settles
   * `not_started`, `credential_unavailable`, rather than running without it.
   */
  readonly runEnvironment?: RunSecretEnvironment;
  /** Where `settleRun` enqueues a start failure's retry and a hand-back's re-run, after its commit. */
  readonly jobs: Jobs;
  readonly logger?: Logger;
  /**
   * How many stages this process runs at once. Stated here because it is a **pool** number: each
   * concurrent execution holds one connection during each of its two transactions, on top of the
   * dispatcher's `2 × concurrency + 1`. A composition root that raises this and not
   * `APP_DB_POOL_MAX` gets a pipeline that stalls waiting for connections it is holding itself.
   */
  readonly concurrency?: number;
}

export interface StageExecutionJob {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug;
  readonly attempt: number;
  /**
   * **Read by nothing** since WP-275a (TD-031's 2026-11-04 amendment §3): the start-failure count is
   * read off the stage entry's stored runs (`RunRepository.startFailures`) under the settle's lock.
   * Kept on the type for one release beside the payload's `start_attempts`, which a job queued by the
   * previous build still carries; then removed.
   */
  readonly startAttempts?: number;
  /**
   * The model and effort a human chose for **this attempt** (WP-15i, `POST /api/runs/:id/retry`).
   *
   * Per attempt rather than per task: it rides the `stage.execute` payload and is gone the next
   * time the stage is entered, so one operator's "try this on the bigger model" does not become the
   * project's configuration. `undefined` is the ordinary case and the planner falls back to the
   * project's stage configuration and then to the template's defaults.
   */
  readonly overrides?: {
    readonly model?: string;
    readonly effort?: Effort;
  };
  /**
   * {@link StageRunRequest.mergeRequestPaths}, read by the job that fires this attempt (WP-73,
   * backlog 218). **Never in the queue payload**: it is read fresh on every fire, outside every
   * transaction, and a re-enqueued attempt reads again.
   */
  readonly mergeRequestPaths?: readonly string[];
  /**
   * {@link StageRunRequest.observability}, read by the job that fires this attempt (WP-89). Never in
   * the queue payload, for `mergeRequestPaths`' reason: read fresh on every fire, outside every
   * transaction.
   */
  readonly observability?: readonly PromptObservabilityExcerpt[];
}

export interface StageExecutor {
  /** Transaction 1 — admit, plan, offer (WP-276: the job ends at the offer). */
  execute(job: StageExecutionJob): Promise<StageExecutionOutcome>;
  /**
   * **Transaction 2**, for the claimant that ran the run (WP-276): `settleRun` over this executor's
   * own collaborators — the four-field request, everything else read back under the settle's lock.
   */
  settle(request: SettleRunRequest): Promise<SettleRunResult>;
  /** Withdraws an open stage offer with no stored plan, escalating `run_plan_missing` (WP-276). */
  withdrawUnplanned(runId: Id): Promise<boolean>;
  /**
   * Withdraws an open stage offer — one conditional update, so a claim that won the row first
   * leaves it alone and this answers `false` — ends its run `cancelled` and escalates the task with
   * the brief (WP-278: an offer nobody claimed by its `expires_at`).
   */
  withdrawOffer(runId: Id, reason: OfferWithdrawalReason): Promise<boolean>;
}

export { STAGE_WAIT_FOR_PREVIOUS_RUN_MS } from './stage-enqueue.js';

/**
 * The start of the current calendar month, in **UTC**, as an ISO instant.
 *
 * The shadow budget's window. UTC rather than the organisation's zone, for the reason stated at the
 * call site; `cost/window.ts` is what does it properly for a `budgets` row, and this is not one.
 */
export const monthStartUtc = (at: string): IsoDateTime => {
  const now = new Date(at);
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  ).toISOString() as IsoDateTime;
};

/**
 * What the stage executor asks about a **shadow** task, and about nothing else.
 *
 * A narrow view of `ShadowStore` rather than the store itself: this module has no business reading
 * a batch or writing a report, and a port that offered it either would be an invitation.
 */
export interface StageExecutorShadowPort {
  /**
   * This project's shadow spend since an instant — the ledger's, and what the ledger cannot see
   * yet (WP-34 criterion 7, and `../cost/pending.ts` for the second number).
   */
  shadowSpendSince(
    tx: Transaction,
    projectId: Id,
    since: IsoDateTime,
    reserveUsd: number,
  ): Promise<CapSpend>;
  /** Q82 (a): the commit this shadow task's workspace should start from (PROGRESS backlog 71). */
  checkoutBaseFor(tx: Transaction, taskId: Id): Promise<string | null>;
}

/**
 * What the stage executor asks about a **history bootstrap** task (WP-35).
 *
 * One query, keyed by the task, answering the cap the batch recorded, what its tasks have spent
 * from `cost_entries` and what its runs have committed that the ledger has not recorded yet. It is
 * asked **only** for a task on `HISTORY_BOOTSTRAP_TEMPLATE_ID`, so an ordinary delivery pays
 * nothing for it — the same bargain the shadow port makes with `tasks.mode`.
 */
export interface StageExecutorBootstrapPort {
  capForTask(
    tx: Transaction,
    taskId: Id,
    reserveUsd: number,
  ): Promise<({ readonly capUsd: number } & CapSpend) | null>;
}

/**
 * The separate shadow budget — product/18:24's *"a budget cap … settings: shadow budget per
 * month"*, and product/19 §12's *"~$5–15 per ticket, separate budget"* (WP-34, criterion 7).
 *
 * **It is the executor's own check against project configuration**, exactly like
 * {@link taskBudgetExhausted}, and deliberately **not** a `budgets` row with a fifth `budget_scope`
 * value. Three reasons, in the order they decide it. The cap lives in `.agentic/config.yml`
 * (`features.shadow_mode.budget_usd`), so a `budgets` row would be a second copy of a number a
 * repository owns and could rewrite. The window is **the month**, fixed by product/18's own wording,
 * where a `budgets` row carries a `window` an operator chooses. And `budget_scope` is a scope over
 * *rows the ledger already groups by* — org, project, task, run — while this one groups by
 * `tasks.mode`, which is not a scope at all but a filter across every task of a project.
 *
 * The comparison adds what *this* run may spend to what shadow tasks have already spent, for
 * {@link taskBudgetExhausted}'s reason: a budget checked only against past spend is a budget
 * discovered one run too late.
 */
export const shadowBudgetUsdOf = (settings: ProjectSettings): number | null => {
  const features = settings.config.features as
    | { readonly shadow_mode?: { readonly budget_usd?: number } }
    | undefined;
  const value = features?.shadow_mode?.budget_usd;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
};

/** Per-run cap: the project's `stages.<id>.budget_usd`, else product/04's table (BD-013). */
export const runBudgetUsd = (settings: ProjectSettings, stage: Slug): number =>
  settings.config.stages?.[stage]?.budget_usd ?? DEFAULT_STAGE_RUN_BUDGET_USD[stage] ?? 5;

/**
 * Has the task spent its cap? product/09: the task scope "pauses the task rather than blocking
 * silently, and a human may raise the cap".
 *
 * **The one cap that needs no pending term** (`../cost/pending.ts`): `costActualUsd` is
 * `tasks.cost_actual`, which `record`'s own transaction increments beside `runs.finish` and
 * `run.finished`, so it cannot lag the run the way the ledger's projections do.
 *
 * **It does need the hold** (WP-131, PROGRESS backlog 402). A run nobody measured moves
 * `cost_actual` by nothing, ever — `spendOf` adds `0` for it, rightly, because a zero there would be
 * published as money spent — so until WP-131 a task whose runs kept ending unmeasured (a stall, the
 * wall clock, a crash, a cancel or a sweep that read no `result`) was admitted retry after retry at
 * `0 + reserve`, and only a human's re-try after the escalation braked it. `held` is the task's ended
 * runs nobody measured, each at the reservation it was admitted at (`RunRepository.heldFor`),
 * compared beside the spend and **never** written into `cost_actual`. It ends when `cost/late.ts`
 * writes the run's figure (which moves `cost_actual` in the same transaction); it never rolls over,
 * so the task stays paused until a human raises the cap.
 *
 * The comparison adds what *this* run may spend to what the task has already spent, because a
 * budget checked only against past spend is a budget discovered one run too late.
 */
export const taskBudgetExhausted = (
  stored: StoredTask,
  settings: ProjectSettings,
  stage: Slug,
  held: Hold,
): boolean =>
  stored.costActualUsd + held.heldUsd + runBudgetUsd(settings, stage) > settings.taskBudgetUsd;

/**
 * The settings with the task's **own** cap in place of the default, when a maintainer raised it —
 * `tasks.budget_cap_usd`, `POST /api/tasks/:id/budget` (WP-131 review round 1). `null` is "the
 * default applies"; the settings are then returned as they are.
 */
export const withTaskCap = (settings: ProjectSettings, capUsd: number | null): ProjectSettings =>
  capUsd === null ? settings : { ...settings, taskBudgetUsd: capUsd };

/**
 * The task cap's pause, with the spend and the hold apart (standing rule 16): *"the task has spent
 * 0 USD of its 20 USD cap, with 1 run nobody measured, held at its cap: 15 USD, and …"*.
 */
export const taskBudgetDetail = (
  stored: StoredTask,
  settings: ProjectSettings,
  stage: Slug,
  held: Hold,
): string =>
  `the task has spent ${stored.costActualUsd} USD of its ${settings.taskBudgetUsd} USD cap` +
  (held.heldRuns > 0 ? `, with ${holdDetail(held)},` : '') +
  ` and "${stage}" may spend ${runBudgetUsd(settings, stage)} more`;

type Prepared =
  | { readonly kind: 'skipped'; readonly reason: string; readonly supersededBy?: number }
  | { readonly kind: 'paused'; readonly reason: string }
  /** Refused before any run exists, the task parked for a human (WP-63, WP-106: bad config). */
  | { readonly kind: 'escalated'; readonly reason: string }
  /** WP-276: the task's previous stage entry still has a live run; fired again later. */
  | { readonly kind: 'waiting'; readonly reason: string; readonly runId: Id }
  /** WP-276: the run is written and offered; the job ends here. */
  | { readonly kind: 'offered'; readonly runId: Id };

type Admitted = {
  readonly kind: 'admitted';
  /** The settings admission read and found readable — what the plan and the run are made from. */
  readonly settings: ProjectSettings;
  readonly stored: StoredTask;
  readonly stage: PipelineStage;
  readonly artifacts: readonly StoredArtifact[];
  readonly returnFeedback: string | null;
  readonly returnFeedbackOriginalChars: number | null;
  readonly returnCause: ReturnCause | null;
  /** WP-152: the gate's last failure a person attached to the return, `null` when none. */
  readonly attachedFeedback: AttachedReturnFeedback | null;
  /** WP-34 / backlog 71: a shadow task's comparison base, `null` for every other task. */
  readonly checkoutBase: string | null;
  /** Backlog 467: the stage's previous attempt, when it saved unfinished work. */
  readonly previousAttempt: SavedAttempt | null;
  /** Backlog 476: how the stage's latest ended run ended, however it ended. */
  readonly previousRun: EndedRun | null;
};

type Admission = Exclude<Prepared, { kind: 'offered' }> | Admitted;

/**
 * {@link revalidate}, plus the one question it cannot ask of the aggregate (WP-108 review round 1,
 * PROGRESS backlog 365): **is this attempt's `task_stages` row still open?**
 *
 * A run that completed closes its attempt's row in transaction 2, and the task stays at the same
 * stage on the same attempt until the saga dispatches `task.stage.completed` and enters the next
 * one. A duplicate or late `stage.execute` for that attempt — a redelivery, a recovery re-enqueue
 * that met a slow live path — passed `revalidate` in that window and started a **second paid run**
 * of a stage that had already decided. A closed row is now a skip. A row that is **absent** (a task
 * entered before every entry opened one) is treated as open: nothing could have closed it.
 */
const revalidateOpen = async (
  store: PipelineStore,
  tx: Transaction,
  job: StageExecutionJob,
): Promise<
  | ReturnType<typeof revalidate>
  | { readonly kind: 'waiting'; readonly reason: string; readonly runId: Id }
> => {
  const valid = revalidate(await store.tasks.load(tx, job.taskId), job);
  if (valid.kind === 'skipped') return valid;
  const row = await store.tasks.stageAttemptState(tx, job.taskId, job.stage, job.attempt);
  if (row === 'closed') {
    return {
      kind: 'skipped',
      reason: `attempt ${job.attempt} of "${job.stage}" has already ended (its stage row is closed); a late wake-up starts no second run`,
    };
  }
  /**
   * **Does this stage entry already have a live run?** (WP-276, TD-031 decision 3, item 2.) The job
   * no longer holds its singleton for the run's duration, so a duplicate wake-up — a redelivery, a
   * recovery re-enqueue, a person's second press — finds the entry's offer open or claimed and
   * succeeds doing nothing. A live offer of **another** entry is a run whose stop the transition
   * that left it recorded (`./offer-withdrawal.ts`): this entry waits for its ending rather than
   * break the per-task index.
   */
  const live = await store.offers.liveStageOffer(tx, job.taskId);
  if (live !== null) {
    if (live.stage === job.stage && live.attempt === job.attempt) {
      return {
        kind: 'skipped',
        reason: `attempt ${job.attempt} of "${job.stage}" already has a live run (${live.runId}, its offer ${live.state}); a duplicate wake-up starts nothing`,
      };
    }
    return {
      kind: 'waiting',
      runId: live.runId,
      reason: `the task's previous run ${live.runId} (attempt ${live.attempt} of "${live.stage ?? 'no stage'}") is still ${live.state}; attempt ${job.attempt} of "${job.stage}" is offered once it has ended`,
    };
  }
  return valid;
};

export { REFREEZE_PENDING_SENTENCE, refrozen } from './refreeze.js';
// Moved to `./settle.ts` with transaction 2 (WP-275); still exported from here, where every
// importer has always found them.
export {
  COST_UNREPORTED,
  MAX_RUN_START_ATTEMPTS,
  MAX_SHUTDOWN_HAND_BACKS,
  NOT_STARTED_BRIEF_QUOTE_CHARS,
  notStartedBrief,
  withPlatformMergeRequestRecord,
  withPlatformReviewRecord,
} from './settle.js';

export const createStageExecutor = (options: StageExecutorOptions): StageExecutor => {
  const { unitOfWork, store, planner } = options;
  const logger = options.logger ?? silentLogger;
  const budgets = options.budgets ?? noBudgetGuard;

  /**
   * Every transaction this executor opens that writes the task, on a bound (WP-15e).
   *
   * The executor owns its transactions, so it owns the retry: a refused `save` re-runs the whole
   * unit in a *new* transaction, which rolls the previous attempt's writes back and re-reads the
   * task — the property a retry inside one transaction could not give, because `record` inserts an
   * artifact and a question before it saves.
   */
  const writing = async <T>(
    taskId: Id,
    what: string,
    fn: (scope: TransactionScope) => Promise<T>,
  ): Promise<T> =>
    retryOnTaskConflict({ taskId, what, logger }, async () => unitOfWork.transaction(fn));

  /** `Paused: budget` — product/09's answer to a cap, whichever scope reached it. */
  const pause = async (
    scope: TransactionScope,
    stored: StoredTask,
    reason: string,
    /** Which cap refused the run — recorded on `task.paused` (WP-131 review round 2). */
    budgetScope: PausedBudgetScope,
  ): Promise<Admission> => {
    const decision = pauseTask(
      stored.task,
      { reason: 'budget', budgetScope },
      options.context(stored.task.id),
    );
    await store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
    await scope.events.append(decision.events);
    return { kind: 'paused', reason };
  };

  /** Transaction 1a: may this job run at all, and what does the planner need to plan it? */
  const admit = async (job: StageExecutionJob, read: ProjectSettings): Promise<Admission> =>
    writing(job.taskId, 'admitting a stage run', async (scope): Promise<Admission> => {
      const valid = await revalidateOpen(store, scope.tx, job);
      if (valid.kind === 'skipped' || valid.kind === 'waiting') return valid;
      const loaded = valid.stored;
      const { task } = loaded;

      /**
       * **A configuration this release cannot read refuses the run** (`settingsAdmission`), asked
       * first, before any budget question, because no answer to those makes this run's rules
       * knowable. Two layers: the project's stored settings (WP-106, PROGRESS backlog 311 —
       * parsed by the settings port, which answers `configRefusal` rather than handing the
       * planner a cast; `settings_config_invalid`) and the repository's
       * `.agentic/config.yml` on the default branch (WP-63 criterion 4,
       * `repository_config_invalid`), which is not run on the settings alone or on an older
       * reading. No `runs` row is created — the run never existed — and the task is parked where a
       * human is asked to act, naming the key paths and the `PUT` that fixes them, which is the
       * escalation every other unrunnable stage already ends in. One escalation (and one `save`)
       * for both; WP-83's context-budget ceiling is one of the settings' schema failures since
       * WP-106 rather than a refusal of its own.
       */
      const readable = settingsAdmission(read);
      if (readable.kind === 'refused') {
        const reason =
          loaded.settingsRefreezePending === true
            ? `${readable.reason}. ${REFREEZE_PENDING_SENTENCE}`
            : readable.reason;
        const escalated = escalate(loaded, options.context(task.id), job.stage, reason);
        await store.tasks.save(scope.tx, { ...loaded, task: escalated.aggregate });
        await closeParkedStageRow(store, scope.tx, escalated, readable.word);
        await scope.events.append(escalated.events);
        return { kind: 'escalated', reason };
      }
      const { settings } = readable;
      // WP-106 (backlog 311, migration 0066): a task created under a `configRefusal` froze the
      // platform's defaults; the first run admitted after the document parses takes its limits and
      // dial again from the parsed document, so it never runs on what it was created with.
      const stored = refrozen(loaded, settings);
      if (stored !== loaded) {
        await store.tasks.refreezeSettings(scope.tx, task.id, refrozenColumns(stored));
        logger.info(
          { task_id: task.id, stage: job.stage },
          'this task was created while its project’s stored configuration could not be read; its iteration limits and autonomy dial were taken again from the parsed configuration before its first run',
        );
      }

      const held = await store.runs.heldFor(scope.tx, task.id, runBudgetUsd(settings, job.stage));
      // The task's own cap when a maintainer raised it (WP-131 review round 1), else the default.
      const capped = withTaskCap(settings, await store.tasks.budgetCap(scope.tx, task.id));
      if (taskBudgetExhausted(stored, capped, job.stage, held)) {
        return pause(scope, stored, taskBudgetDetail(stored, capped, job.stage, held), 'task');
      }

      /**
       * BD-010: an organisation or project budget "prevents *new* runs; running runs finish".
       *
       * Asked here because this is the only moment the question has an answer — a handler on
       * `budget.exhausted` would have to guess which tasks are about to start a run. The spend it
       * reads is the ledger's own `budget_windows` projection (WP-19) **plus** what the scope's
       * runs have committed that the projection cannot see yet (`../cost/pending.ts`), which is
       * why it is told what a run of this stage may spend.
       */
      const blocker = await budgets.blockingFor(
        scope.tx,
        task.projectId,
        options.context(task.id).clock.now(),
        runBudgetUsd(settings, job.stage),
      );
      if (blocker !== null) {
        return pause(
          scope,
          stored,
          blockingBudgetDetail(blocker),
          blocker.scope === 'org' ? 'organization' : 'project',
        );
      }

      /**
       * The **separate** shadow budget (WP-34), asked only for a shadow task.
       *
       * Here rather than in `BudgetGuard` for the reason {@link shadowBudgetUsdOf} states: the cap
       * is a configuration key rather than a `budgets` row, and the spend it is measured against is
       * grouped by `tasks.mode` rather than by a scope. An ordinary delivery pays no query for it.
       *
       * The comparison is `capIsSpent`, so it counts the shadow runs the ledger has not recorded
       * yet beside the ones it has (`../cost/pending.ts`).
       *
       * The window is the calendar month **in UTC**, which is stated rather than hidden: the
       * organisation's own zone decides a `budgets` window (`cost/window.ts`), and reading it here
       * would mean a second query on every shadow admission for a cap whose whole purpose is "stop
       * the demo before it costs more than the demo is worth". The consequence is bounded — the
       * window turns over at most a few hours away from the organisation's midnight.
       */
      const shadowCap = task.mode === 'shadow' ? shadowBudgetUsdOf(settings) : null;
      if (shadowCap !== null && options.shadow !== undefined) {
        const since = monthStartUtc(options.context(task.id).clock.now());
        const reserveUsd = runBudgetUsd(settings, job.stage);
        const spend = await options.shadow.shadowSpendSince(
          scope.tx,
          task.projectId,
          since,
          reserveUsd,
        );
        const admission = { ...spend, capUsd: shadowCap, reserveUsd };
        if (capIsSpent(admission)) {
          return pause(
            scope,
            stored,
            `this project’s shadow budget for the month since ${since} is spent: ` +
              capSpendDetail(admission, job.stage),
            'shadow',
          );
        }
      }

      /**
       * The maintenance pipeline's **dedicated budget** (WP-36, product/18:31), asked only for a
       * chore this platform scheduled.
       *
       * The *mechanism* is the shadow cap's above, deliberately: WP-34 built it, and two features
       * with two answers to "what stops a feature spending" would be two things to keep true. What
       * differs is the **predicate**, and it is this feature's own — `namesAMaintenanceChore` reads
       * the platform-issued reference, because `tasks.template` would charge a `chore` ticket a
       * *human* filed to the maintenance cap, and `runs.mode` would too: a maintenance chore's runs
       * are ordinary delivery runs, which is what "an ordinary `chore` task" means.
       *
       * Month in UTC, from the same `monthStartUtc` the shadow cap uses, for the same stated
       * reason; the comparison adds what this run may spend, for {@link taskBudgetExhausted}'s, and
       * what the month's chore runs have committed that the ledger has not recorded
       * (`../cost/pending.ts`).
       */
      if (options.maintenance !== undefined && namesAMaintenanceChore(task.ticket)) {
        const cap = maintenanceBudgetUsdOf(settings.config);
        if (cap !== null) {
          const since = monthStartUtc(options.context(task.id).clock.now());
          const reserveUsd = runBudgetUsd(settings, job.stage);
          const spend = await options.maintenance.maintenanceSpendSince(
            scope.tx,
            task.projectId,
            since,
            reserveUsd,
          );
          const admission = { ...spend, capUsd: cap, reserveUsd };
          if (capIsSpent(admission)) {
            return pause(
              scope,
              stored,
              `this project’s maintenance budget for the month since ${since} is spent: ` +
                capSpendDetail(admission, job.stage),
              'maintenance',
            );
          }
        }
      }

      /**
       * The **history bootstrap's** cap (WP-35), asked only for a task on that template.
       *
       * Per **batch** rather than per month, which is the difference from the two monthly caps
       * above (shadow mode's and maintenance's) and is product/19 §18's own shape: a bootstrap is a
       * one-off operation an operator starts and is shown a figure for before it runs, so the cap
       * belongs to the thing they started.
       * The cap is read from the batch row (copied at creation) and the spend from `cost_entries`,
       * so what stops the batch is the ledger rather than a running total — and the comparison adds
       * what *this* run may spend, for {@link taskBudgetExhausted}'s reason: a budget checked only
       * against past spend is discovered one run too late.
       *
       * **It also adds what the batch's other runs have committed and the ledger has not recorded**
       * (`cap.pendingUsd`). The ledger is a handler on `run.finished`, so between a mining run's own
       * transaction and its ledger row the batch's spend reads lower than it is — and with the
       * handler delayed the batch admitted two runs against a cap that allows one, three times out
       * of three. `../cost/pending.ts` states the rule, the measurement and the residual.
       *
       * The ending is the ordinary one: the task is **paused** with the reason, exactly as an
       * exhausted task or project budget pauses it. So a bootstrap whose cap is spent leaves some
       * chunks mined and the rest paused, which is what "stops when it is spent" means, and a human
       * raising the cap is the way out.
       */
      if (task.template === HISTORY_BOOTSTRAP_TEMPLATE_ID && options.bootstrap !== undefined) {
        const reserveUsd = runBudgetUsd(settings, job.stage);
        const cap = await options.bootstrap.capForTask(scope.tx, task.id, reserveUsd);
        if (cap !== null && capIsSpent({ ...cap, reserveUsd })) {
          return pause(
            scope,
            stored,
            `this history bootstrap’s budget is spent: ` +
              `${capSpendDetail({ ...cap, reserveUsd }, job.stage)}`,
            'bootstrap',
          );
        }
      }

      const feedback = await store.tasks.lastReturnReason(
        scope.tx,
        job.taskId,
        job.stage,
        job.attempt,
      );
      return {
        kind: 'admitted',
        settings,
        stored,
        stage: valid.stage,
        artifacts: await store.artifacts.listFor(scope.tx, job.taskId),
        returnFeedback: feedback?.reason ?? null,
        returnFeedbackOriginalChars: feedback?.originalChars ?? null,
        returnCause: feedback?.cause ?? null,
        attachedFeedback: feedback?.attached ?? null,
        /**
         * Q82 (a) / PROGRESS backlog **71**: the commit this run's workspace starts from.
         *
         * Read inside the admission transaction because that is where a transaction already is; the
         * planner runs between the two and has none. `null` for every ordinary task, which
         * `checkoutRefOf` turns into the task's own branch.
         */
        checkoutBase:
          task.mode === 'shadow' && options.shadow !== undefined
            ? await options.shadow.checkoutBaseFor(scope.tx, task.id)
            : null,
        // Backlog 467: read here for `checkoutBase`'s reason — the planner has no transaction.
        previousAttempt: await store.runs.lastSavedWork(scope.tx, {
          taskId: job.taskId,
          stage: job.stage,
        }),
        // Backlog 476: the same row, whatever it saved — what the next prompt's stage line says.
        previousRun: await store.runs.lastEnded(scope.tx, { taskId: job.taskId, stage: job.stage }),
      };
    });

  /**
   * Transaction 1b: create the Run, now that the prompt and its pack exist.
   *
   * It re-asks {@link revalidate}'s four questions, because the pack was assembled with **no
   * transaction open** and a task can be paused, returned or superseded in that window. Finding
   * that it moved is a success, exactly as it is in 1a: the work thrown away is one retrieval, and
   * the alternative is a `runs` row for a stage the task has left.
   */
  const startTheRun = async (
    job: StageExecutionJob,
    plan: StageRunPlan,
    runId: Id,
    settings: ProjectSettings,
  ): Promise<Prepared> =>
    unitOfWork.transaction(async (scope): Promise<Prepared> => {
      const valid = await revalidateOpen(store, scope.tx, job);
      if (valid.kind === 'skipped' || valid.kind === 'waiting') return valid;
      const { spec } = plan;
      const { stored } = valid;
      const { task } = stored;
      const context = options.context(task.id);
      /**
       * The run's redactor and the two prompt columns — Q64, implemented at WP-52.
       *
       * **Written here and never re-derived.** The nonce `assemblePrompt` draws is per prompt and
       * the context pack is a point-in-time read, so re-assembling the prompt later would produce a
       * different document answering a different question — the argument `tasks.template_snapshot`
       * and `ticket_snapshot` have already won. What is stored is exactly the bytes the runner is
       * handed, minus the secrets this run was given. The redactor is `runRedactorFor` (WP-275a):
       * the one factory settle builds the artifact's redactor with too.
       */
      const redactor = runRedactorFor(
        { env: spec.env, secretEnvNames: spec.secretEnvNames },
        options.redactor,
        logger,
        { runId: spec.runId },
      );
      const systemPrompt = redactor.redactText(spec.systemPromptAppend);
      const userPrompt = redactor.redactText(spec.userPrompt);
      // The pack's recorded search terms are the prompt's own words in another shape, so the same
      // redactor decides them before they reach `run.started` or `run_context_pack` (WP-44).
      const contextPack = redactTextSearchTerms(plan.contextPack, redactor);
      // Sealed before the first write, so an oversized plan (`RunPlanTooLargeError`) leaves no row —
      // in the memory store too, which keeps a failed transaction's writes (divergence 4).
      const sealedPlan = sealRunPlan(options.runPlans, {
        spec,
        reviewChecklists: plan.reviewChecklists ?? null,
        questionTimeout: questionTimeoutOf(settings),
      });

      // The run enters the log here, **in `created`** (WP-275b, TD-031's 2026-11-04 amendment §4):
      // `run.created` with its row and its offer, `created → starting` at the claim below, and
      // `starting → running` with `run.started` only at the CLI spawn marker (`./cli-spawn.ts`).
      const created = recordRunCreated(
        createRun({
          id: runId,
          taskId: task.id,
          projectId: task.projectId,
          stage: job.stage,
          role: valid.role,
          // The planner already decided it from the task and the template (WP-24's `runModeFor`);
          // deriving it a second time here is how the two would come apart.
          mode: spec.mode,
          attempt: job.attempt,
          model: spec.model,
          effort: spec.effort,
          promptVersion: spec.promptVersion,
        }),
        context,
      );
      await store.runs.insert(scope.tx, {
        id: runId,
        taskId: task.id,
        projectId: task.projectId,
        stage: job.stage,
        role: created.aggregate.role,
        mode: created.aggregate.mode,
        attempt: job.attempt,
        model: spec.model,
        effort: spec.effort,
        promptVersion: spec.promptVersion,
        // `created`: the claim below moves it to `starting` in this transaction, and only the CLI
        // spawn marker moves it to `running` (WP-275b) — so `started_at` is null until then.
        status: 'created',
        terminalReason: null,
        sessionId: null,
        numTurns: 0,
        usage: null,
        cost: null,
        wallMs: 0,
        createdAt: context.clock.now(),
        startedAt: null,
        systemPrompt: systemPrompt.value,
        userPrompt: userPrompt.value,
        // The sum over both columns, which is what `runs.redaction_count` means from migration
        // 0038 onwards — not the run's total. The transcript's count is the runner's and the
        // artifact's is on the artifact row; a column that mixed the three could not be read back
        // as "the redactor ran over this prompt and replaced nothing".
        redactionCount: systemPrompt.count + userPrompt.count,
        // WP-57 (PROGRESS backlog 31): the record `run.started` carries, stored as rows in the
        // transaction that commits the run — the pack was planned between the two transactions,
        // so this is the first moment the row it belongs to exists.
        contextPack,
        // WP-91 (backlog 227): the settings this plan was made from — the ones `prepare` read and
        // handed the planner — frozen with the run, through the run's own redactor.
        // WP-131 review round 2: with the task's **own** cap in it when a maintainer raised it, so
        // the run records the cap it ran under, not the default it did not.
        settings: runSettingsSnapshot(
          withTaskCap(settings, await store.tasks.budgetCap(scope.tx, task.id)),
          redactor,
        ),
        // WP-131 (migration 0072): the per-run cap this run was admitted at — the figure every cap
        // holds it at if it ends with nobody measuring it.
        reserveUsd: runBudgetUsd(settings, job.stage),
        // WP-121 (backlog 363): why the plan carried no project prompt file, frozen with the run
        // through its own redactor — so a missing convention-append file says why on `/prompt`.
        promptsWithheld: redactedPromptsWithheld(settings.repositoryPromptsWithheld, redactor),
        // Backlog 454: the mode the planner planned this run with, not the column's default.
        providerMode: spec.providerMode,
      });
      /**
       * **The run plan** (WP-275a, TD-031's 2026-11-04 amendment §2), in the run row's transaction:
       * the spec without its secret values, **sealed, never redacted**, beside the checklists the
       * planner applied and the question timeout it was planned with. The session below runs from
       * what is read back (`loadRunPackage`), never from this process's memory of the plan.
       */
      await store.runPlans.insert(scope.tx, sealedPlan);
      /**
       * **The offer, in the same transaction as the row — and the job ends here** (WP-274, WP-276,
       * TD-031 decision 3). The run is `created` and holds no lease: nothing is driving it until a
       * claimant takes it through the one claim (`./offers.ts`), which writes the lease, the epoch
       * and `created → starting` in one statement. The offer is announced on `run_offers` at commit.
       * A `created` row is not the sweep's (it has no lease to lose); an offer nobody claims waits
       * for one until its `expires_at` (WP-278's `offer_timeout`), when the offer-timeout recovery
       * row withdraws it and escalates the task (`../recovery/offer-timeout.ts`).
       */
      const offered = await offerRun(
        store,
        scope,
        {
          run: created.aggregate,
          kind: 'stage',
          offerId: context.ids.next(),
          now: context.clock.now(),
          // WP-278: the ticket's assignee is not stored, so a stage offer has none yet (BACKLOG 730).
          assigneeUserId: null,
          /**
           * WP-286 (TD-031 §12): a re-planned entry carries its previous offer's exclusions, plus
           * the worker that lost the run — so the second run goes to another claimant. A usage
           * limit excludes nobody: the limited worker's own pause keeps it off until its reset
           * (TD-031's 2026-11-05 amendment). An entry's first offer carries nothing.
           */
          excludedWorkerIds: await store.offers.carriedExclusions(scope.tx, {
            taskId: job.taskId,
            stage: job.stage,
            attempt: job.attempt,
          }),
        },
        context,
      );
      await scope.events.append([...created.events, ...offered.events]);
      return { kind: 'offered', runId };
    });

  /**
   * Transaction, **plan**, transaction — and the middle step is why this is three calls and not
   * one.
   *
   * Assembling a context pack is four to six queries and a code map (`planner.ts`), and doing it
   * inside transaction 1 would hold one pooled connection while borrowing a second, which is
   * PROGRESS backlog 19's shape at the one site that could afford it least. Between the two, the
   * connection it borrows *replaces* the worker's — the same argument `POOL_RESERVATIONS.pipeline`
   * already makes for every other pipeline job worker.
   */
  const prepare = async (job: StageExecutionJob, read: ProjectSettings): Promise<Prepared> => {
    const admission = await admit(job, read);
    if (admission.kind !== 'admitted') return admission;
    const { settings } = admission;
    const runId = options.context(job.taskId).ids.next();
    const plan = await planner.plan({
      runId,
      stage: admission.stage,
      attempt: job.attempt,
      task: admission.stored,
      artifacts: admission.artifacts,
      settings,
      returnFeedback: admission.returnFeedback,
      returnFeedbackOriginalChars: admission.returnFeedbackOriginalChars,
      returnCause: admission.returnCause,
      attachedFeedback: admission.attachedFeedback,
      checkoutBase: admission.checkoutBase,
      previousAttempt: admission.previousAttempt,
      previousRun: admission.previousRun,
      ...(job.overrides === undefined ? {} : { overrides: job.overrides }),
      ...(job.mergeRequestPaths === undefined ? {} : { mergeRequestPaths: job.mergeRequestPaths }),
      ...(job.observability === undefined ? {} : { observability: job.observability }),
    });
    try {
      return await startTheRun(job, plan, runId, settings);
    } catch (error) {
      if (!(error instanceof RunPlanTooLargeError)) throw error;
      return refuseOversizedPlan(job, error);
    }
  };

  /**
   * A plan past `RUN_PLAN_MAX_BYTES` is **refused, never cut** (WP-275a): transaction 1b rolled
   * back, so no run exists, and the task is parked for a human with the size — the ending a
   * configuration the platform cannot run already has.
   */
  const refuseOversizedPlan = async (
    job: StageExecutionJob,
    error: RunPlanTooLargeError,
  ): Promise<Prepared> =>
    writing(job.taskId, 'refusing an oversized run plan', async (scope): Promise<Prepared> => {
      const valid = await revalidateOpen(store, scope.tx, job);
      if (valid.kind === 'skipped' || valid.kind === 'waiting') return valid;
      const reason = `the run's plan is ${error.bytes} bytes, over the ${RUN_PLAN_MAX_BYTES}-byte bound a stored plan may have; it is refused rather than cut`;
      const escalated = escalate(valid.stored, options.context(job.taskId), job.stage, reason);
      await store.tasks.save(scope.tx, { ...valid.stored, task: escalated.aggregate });
      await closeParkedStageRow(store, scope.tx, escalated, 'failed');
      await scope.events.append(escalated.events);
      return { kind: 'escalated', reason };
    });

  /**
   * The ending for a write that lost every race (WP-15e, criterion 4).
   *
   * The executor has no outer retry that would re-read for it — `stage.execute` re-fires into
   * pg-boss's own limit, whose exhaustion is a failed job only an administrator's list shows
   * (Settings → Failed jobs since WP-108) and which tells nobody about the task — so the bound ends
   * here, in the state whose whole meaning is *a human must act*. Never a silent drop: what was
   * lost is a run's recorded result, which is the platform's own record of spend.
   */
  const escalateOnConflict = async (
    failure: TaskConflictExhaustedError,
  ): Promise<StageExecutionOutcome> => {
    logger.error(
      { task_id: failure.taskId, attempts: failure.attempts, what: failure.what, err: failure },
      'a stage write lost every race against another writer; the task is escalated',
    );
    await escalateTaskAfterConflict(
      { unitOfWork, store, context: options.context, logger },
      failure,
    );
    return { kind: 'escalated', reason: failure.message };
  };

  const runStage = async (job: StageExecutionJob): Promise<StageExecutionOutcome> => {
    // WP-106: a stored settings document this release cannot parse is answered by the port as
    // `configRefusal`, and admission refuses the run by that name (`settingsAdmission`).
    const prepared = await prepare(job, await options.settings(job.projectId));
    logger.info(
      {
        task_id: job.taskId,
        stage: job.stage,
        outcome: prepared.kind,
        ...(prepared.kind === 'offered' ? { run_id: prepared.runId } : { reason: prepared.reason }),
      },
      prepared.kind === 'offered'
        ? 'the stage run is offered; a claimant runs it'
        : 'stage execution did not start',
    );
    return prepared;
  };

  /**
   * **An offer withdrawn by the platform, not by a transition** — WP-278's generalisation of
   * WP-276's withdrawal of an unplanned offer: one conditional update on the offer (a claim that won
   * the row first leaves it `claimed` and this answers `false`), its run ended `cancelled` at the
   * measured zero, and its task escalated with the brief. The offer's `withdrawn_reason` is the
   * short code (the column's bound is 64 characters); the brief is the escalation's sentence.
   */
  const withdrawOffer = async (runId: Id, why: OfferWithdrawalReason): Promise<boolean> => {
    const row = await unitOfWork.transaction(async (scope) => store.runs.load(scope.tx, runId));
    if (row === null) return false;
    const reason = why.brief;
    return writing(row.taskId, `withdrawing an offer (${why.withdrawnReason})`, async (scope) => {
      const context = options.context(row.taskId);
      const withdrawn = await store.offers.withdraw(scope.tx, {
        by: { runId },
        reason: why.withdrawnReason,
        now: context.clock.now(),
      });
      if (withdrawn === null) return false;
      const ended = await endWithdrawnRun({ store }, scope, withdrawn, {
        reason: why.withdrawnReason,
        context,
      });
      const events = [...ended];
      const stored = await store.tasks.load(scope.tx, row.taskId);
      if (
        stored !== null &&
        row.stage !== null &&
        canTransitionTask(stored.task.state, 'needs_human')
      ) {
        const escalated = escalate(stored, context, row.stage, reason);
        await store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
        await closeParkedStageRow(store, scope.tx, escalated, 'failed');
        events.push(...escalated.events);
      }
      await scope.events.append(events);
      return true;
    });
  };

  /**
   * **An open offer with no stored plan** (TD-031's 2026-11-04 amendment §2): never claimable (the
   * claim requires a plan), so it is withdrawn, its run ended `cancelled` and its task escalated
   * naming `run_plan_missing`. Reachable only for a run offered by a build before WP-275a and claimed
   * by none; the claimant asks once per poll.
   */
  const withdrawUnplanned = async (runId: Id): Promise<boolean> =>
    withdrawOffer(runId, {
      withdrawnReason: 'run_plan_missing',
      brief:
        'run_plan_missing: the run was offered without a stored plan, so no claimant can run it',
    });

  return {
    execute: async (job) => {
      try {
        return await runStage(job);
      } catch (error) {
        if (!(error instanceof TaskConflictExhaustedError)) {
          throw error;
        }
        return escalateOnConflict(error);
      }
    },
    settle: async (request) => {
      try {
        return await settleRun({ ...options, logger }, request);
      } catch (error) {
        if (!(error instanceof TaskConflictExhaustedError)) throw error;
        // A settle whose task write lost every race parks the task (WP-15e) — the ending the job
        // gave it when transaction 2 ran inside the job.
        return { kind: 'settled', ending: null, outcome: await escalateOnConflict(error) };
      }
    },
    withdrawUnplanned,
    withdrawOffer,
  };
};
