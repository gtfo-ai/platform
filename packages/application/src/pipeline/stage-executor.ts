/**
 * The stage executor — product/04's "Run": one execution of an agent stage.
 *
 * It is driven by the `stage.execute` job (TD-004, `stately` per task), never by an event handler,
 * for one reason: a run takes minutes and an event handler holds a database transaction. The shape
 * is therefore **transaction, no transaction, transaction**:
 *
 * ```
 * tx  1   load the task, re-validate, check the budget, create the Run  → run.created, run.started
 * ——      start the runner and await its outcome                        (minutes; no connection held)
 * tx  2   store the artifact and the outcome                            → run.finished | run.failed,
 *                                                                          artifact.created,
 *                                                                          task.stage.completed
 * ```
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
 * reporting what it spent is a fault that escalates. This module therefore branches on
 * `data.reason` from the transcript — the structured field — rather than on the status, or on a
 * substring of the human-readable `error`. The runner takes one sink for every run it drives, so
 * the reason arrives through {@link RunStopReasons} rather than through a sink this module wraps.
 *
 * A third reading of `error_max_budget_usd` is not a budget ending here at all. Its status is
 * `completed`: the run delivered a valid artifact in the turn that crossed its cap (product owner,
 * 2026-10-05, PROGRESS backlog 466). It takes the ordinary completed path. The artifact is stored,
 * the stage completes, the run row and `run.finished` carry the reason and the cost, and the spend is
 * added to the task. Nothing pauses the task. The next run's admission still reads the task cap.
 */
import type {
  AgentRole,
  ArtifactRef,
  ContextPackRecord,
  DomainEvent,
  Effort,
  Id,
  IsoDateTime,
  JsonValue,
  MergeRequestRef,
  RunCost,
  RunSavedWork,
  RunStartFailure,
  Slug,
  TokenUsage,
} from '@platform/contracts';
import { stageVerdictSchema } from '@platform/contracts';
import type {
  CommandContext,
  PausedBudgetScope,
  PipelineStage,
  PromptObservabilityExcerpt,
  Run,
} from '@platform/domain';
import {
  askQuestion,
  compilePipeline,
  completeStage,
  createRun,
  DEFAULT_STAGE_RUN_BUDGET_USD,
  escalateTask,
  failRun,
  finishRun,
  HISTORY_BOOTSTRAP_TEMPLATE_ID,
  isCurrentStageAttempt,
  isRunnableTaskState,
  maintenanceBudgetUsdOf,
  markRunning,
  namesAMaintenanceChore,
  openQuestion,
  pauseTask,
  recordArtifact,
  stageOf,
  startRun,
  toQuestionRecord,
} from '@platform/domain';
import {
  ArtifactIdentifierSecretError,
  type RedactedArtifact,
  redactArtifactData,
} from '../artifacts/redaction.js';
import { redactedPromptsWithheld } from '../config/repository-config.js';
import { type BudgetGuard, blockingBudgetDetail, noBudgetGuard } from '../cost/guard.js';
import { type LateCostRecorder, noLateCostRecorder } from '../cost/late.js';
import {
  type CapSpend,
  capIsSpent,
  capSpendDetail,
  type Hold,
  holdDetail,
} from '../cost/pending.js';
import { composeSecretRedactors } from '../integrations/redaction.js';
import { redactTextSearchTerms } from '../knowledge/text-search-record.js';
import type { MaintenanceSpendReader } from '../maintenance/ports.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import {
  type ClaudeRunner,
  describeStartFailure,
  isRetryableStartFailure,
  type RunOutcome,
  type RunSpec,
  runStartFailureOf,
} from '../ports/runner.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import type { WorkingCalendar } from '../scheduling/working-calendar.js';
import {
  cliSpawnNotRequested,
  isStopEnding,
  MEASURED_ZERO_COST,
  NO_RUN_USAGE,
  recordCliSpawn,
  unspawnedStop,
} from './cli-spawn.js';
import { questionDeadlineRule } from './deadline-rules.js';
import {
  leaseExpiryAt,
  RUN_LEASE_TTL_MS,
  type RunLeaseOptions,
  startRunHeartbeat,
} from './lease.js';
import { REFREEZE_PENDING_SENTENCE, refrozen, refrozenColumns } from './refreeze.js';
import { injectedSecretRedactorFor } from './run-redaction.js';
import { type ProjectSettings, settingsAdmission } from './settings.js';
import { runSettingsSnapshot } from './settings-snapshot.js';
import type { RunStopReasons } from './stop-reasons.js';
import type {
  AttachedReturnFeedback,
  EndedRun,
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
import { savedWorkSentence } from './unfinished-work.js';
import { artifactQuestions, rawVerdict, stageVerdict } from './verdicts.js';

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

/** One `ReviewVerdict.checklists_applied` entry, as the planner decides it. */
export interface AppliedChecklistRecord {
  readonly name: string;
  readonly item_count: number;
  readonly required_by: readonly string[];
  readonly truncated: boolean;
}

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
  readonly settings: (projectId: Id) => Promise<ProjectSettings>;
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
   * How many times a run of this stage has failed to **start** for a retryable reason (Q59(a)).
   *
   * On the job rather than in memory, for the same reason `gate_checks` is: the process that retries
   * may not be the process that failed, and a counter a restart forgets is an unbounded retry.
   * Absent is zero — the ordinary first attempt.
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

/**
 * How many times a stage's run may fail to *start* for a transport reason before the task is
 * escalated (Q59(a)).
 *
 * Three, with {@link RUN_START_RETRY_MS} between them: about a minute of flapping absorbed without
 * telling anybody, and a launcher that is genuinely down parks the task about a minute later rather
 * than never. The two numbers are the whole bound, and they are here rather than in the caller so
 * that "what stops an unbounded retry" has one answer.
 */
export const MAX_RUN_START_ATTEMPTS = 3;

/**
 * How many times one stage entry may be **handed back** by a `runner` stop before the next stop
 * escalates it (WP-144 ruling (b)): two. An upgrade or a restart in the middle of a run is the
 * ordinary case and costs nothing but the interrupted work; a third stop of the same entry is a
 * process that keeps being stopped under one stage, and a person is told, with a brief naming the
 * stops. Counted from the entry's runs' end reasons (`RunRepository.shutdownEndings`), not a column.
 */
export const MAX_SHUTDOWN_HAND_BACKS = 2;

export interface StageExecutor {
  execute(job: StageExecutionJob): Promise<StageExecutionOutcome>;
}

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

/** The name WP-12 puts on `run_stopped.data.reason` when the CLI reported no usable cost. */
export const COST_UNREPORTED = 'cost_unreported';

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
  | {
      readonly kind: 'ready';
      /** The settings the run was planned with ({@link Admitted.settings}). */
      readonly settings: ProjectSettings;
      readonly spec: RunSpec;
      readonly stage: PipelineStage;
      readonly stored: StoredTask;
      readonly run: Run;
      /**
       * The run's own TD-012 step-1 redactor, built **once** from the spec this run was started
       * with (WP-52).
       *
       * It is carried rather than rebuilt at each write for the reason the TD-012 amendment gives:
       * the prompt columns (transaction 1b), the artifact (transaction 2) and the transcript (the
       * runner, through `RunSpec.env`/`secretEnvNames`) must name the same secrets, and three
       * constructions are three chances to disagree.
       */
      readonly redactor: SecretRedactor;
      /** {@link StageRunPlan.reviewChecklists}, carried to the artifact write. */
      readonly reviewChecklists: readonly AppliedChecklistRecord[] | null;
    };

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

type Admission = Exclude<Prepared, { kind: 'ready' }> | Admitted;

/**
 * The four questions TD-004 makes the executor re-ask every time a job fires: does the task exist,
 * has it stopped, is this attempt current, and is this stage an agent stage?
 *
 * Factored out because **it is asked twice** since WP-17 — once to admit the job and once after the
 * context pack has been assembled, which happens outside any transaction. Two copies of a
 * re-validation is one copy that drifts (standing rule 41's shape).
 */
const revalidate = (
  stored: StoredTask | null,
  job: StageExecutionJob,
):
  | { readonly kind: 'skipped'; readonly reason: string; readonly supersededBy?: number }
  | {
      readonly kind: 'ok';
      readonly stored: StoredTask;
      readonly stage: PipelineStage;
      readonly role: AgentRole;
    } => {
  if (stored === null) return { kind: 'skipped', reason: 'the task no longer exists' };
  const { task } = stored;
  // Not `state === 'active'`: the retrospective runs in the `retro` state. What disqualifies a
  // run is the task having stopped — paused, parked for a human, waiting, or finished.
  if (!isRunnableTaskState(task.state) || task.currentStage !== job.stage) {
    return {
      kind: 'skipped',
      reason: `the task is "${task.state}" at "${task.currentStage ?? 'no stage'}", not running at "${job.stage}"`,
    };
  }
  if ((task.stageAttempts[job.stage] ?? 0) !== job.attempt) {
    const current = task.stageAttempts[job.stage] ?? 0;
    return {
      kind: 'skipped',
      reason: `attempt ${job.attempt} of "${job.stage}" has been superseded by attempt ${current}`,
      // Only forward: a job for a *later* attempt than the task's is not a wake-up anybody owes.
      ...(current > job.attempt ? { supersededBy: current } : {}),
    };
  }
  const stage = stageOf(
    compilePipeline(task.template, stored.template, stored.pipelineDial),
    job.stage,
  );
  if (stage === null || stage.kind !== 'agent' || stage.role === null) {
    return {
      kind: 'skipped',
      reason: `"${job.stage}" is not an agent stage of template "${task.template}"`,
    };
  }
  return { kind: 'ok', stored, stage, role: stage.role };
};

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
): Promise<ReturnType<typeof revalidate>> => {
  const valid = revalidate(await store.tasks.load(tx, job.taskId), job);
  if (valid.kind === 'skipped') return valid;
  const row = await store.tasks.stageAttemptState(tx, job.taskId, job.stage, job.attempt);
  if (row === 'closed') {
    return {
      kind: 'skipped',
      reason: `attempt ${job.attempt} of "${job.stage}" has already ended (its stage row is closed); a late wake-up starts no second run`,
    };
  }
  return valid;
};

export { REFREEZE_PENDING_SENTENCE, refrozen } from './refreeze.js';

export const createStageExecutor = (options: StageExecutorOptions): StageExecutor => {
  const { unitOfWork, store, runner, planner, stopReasons } = options;
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
      if (valid.kind === 'skipped') return valid;
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
      if (valid.kind === 'skipped') return valid;
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
       * handed on the next line but one, minus the secrets this run was given.
       */
      const redactor = composeSecretRedactors(
        injectedSecretRedactorFor(spec, logger),
        options.redactor,
      );
      const systemPrompt = redactor.redactText(spec.systemPromptAppend);
      const userPrompt = redactor.redactText(spec.userPrompt);
      // The pack's recorded search terms are the prompt's own words in another shape, so the same
      // redactor decides them before they reach `run.started` or `run_context_pack` (WP-44).
      const contextPack = redactTextSearchTerms(plan.contextPack, redactor);

      // `created → starting → running`: two transitions, two catalogue events, and no observable
      // moment between them here — the platform has the spec and is handing it to the runner. The
      // states exist for the runner's own lifecycle (technical/02), not for this seam.
      const created = createRun({
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
      });
      const starting = startRun(created, context);
      // The real record, since WP-17. It was a zeroed literal from WP-15 until the pack had a
      // producer *and* a delimiter (PROGRESS backlog 11 and 12).
      const running = markRunning(starting.aggregate, { contextPack }, context);
      await store.runs.insert(scope.tx, {
        id: runId,
        taskId: task.id,
        projectId: task.projectId,
        stage: job.stage,
        role: created.role,
        mode: created.mode,
        attempt: job.attempt,
        model: spec.model,
        effort: spec.effort,
        promptVersion: spec.promptVersion,
        status: running.aggregate.status,
        terminalReason: null,
        sessionId: null,
        numTurns: 0,
        usage: null,
        cost: null,
        wallMs: 0,
        createdAt: context.clock.now(),
        // The domain's clock, not the database's: the same instant stamps `run.started`, and a
        // run ended from another process computes its wall time from this column (WP-15i).
        startedAt: context.clock.now(),
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
       * The lease, claimed in the **same transaction as the row** (WP-47).
       *
       * Not on the line after, and not from the first heartbeat: a `runs` row that is `running`
       * with no lease is exactly the row the sweep's wall-clock backstop takes an hour to reach, and
       * a process that dies between an insert and a claim would leave one every time. The claim
       * commits with the insert or neither does.
       */
      if (options.lease !== undefined) {
        await store.runs.renewLease(scope.tx, {
          runId,
          owner: options.lease.owner,
          expiresAt: leaseExpiryAt(context.clock.now(), options.lease.ttlMs ?? RUN_LEASE_TTL_MS),
        });
      }
      await scope.events.append([...starting.events, ...running.events]);
      return {
        kind: 'ready',
        settings,
        spec,
        stage: valid.stage,
        stored,
        run: running.aggregate,
        redactor,
        reviewChecklists: plan.reviewChecklists ?? null,
      };
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
    return startTheRun(job, plan, runId, settings);
  };

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
    if (prepared.kind !== 'ready') {
      logger.info(
        {
          task_id: job.taskId,
          stage: job.stage,
          outcome: prepared.kind,
          reason: prepared.reason,
        },
        'stage execution did not start',
      );
      return prepared;
    }

    let outcome: RunOutcome;
    /**
     * The heartbeat runs for exactly as long as the session does (WP-47).
     *
     * It is started **after** the run's own transaction has committed, and it is **awaited to a
     * stop** on both endings — the outcome path and the start-failure path — before either opens a
     * transaction of its own. Awaited rather than merely cancelled: a beat is fired and forgotten
     * so that it can never block the run, so clearing the timer alone would leave at most one
     * narrow `update` in flight beside transaction 2. That overlap is harmless in itself
     * (`renewLease` refuses a terminal row) but it is one pooled connection nobody counted, and
     * `POOL_RESERVATIONS` is arithmetic somebody has to be able to do.
     */
    const stopHeartbeat =
      options.lease === undefined
        ? async (): Promise<void> => {}
        : startRunHeartbeat(
            {
              unitOfWork,
              store,
              clock: { now: () => options.context(job.taskId).clock.now() },
              lease: options.lease,
              ...(options.logger === undefined ? {} : { logger: options.logger }),
            },
            prepared.run.id,
          );
    /**
     * The CLI spawn marker for this run (WP-150): the runner asks it between the shim's `hello.ok`
     * and the `spawn` frame, and this process learns back whether it was written — the one fact
     * that tells a run that may have spent from one that cannot have (`./cli-spawn.ts`).
     */
    const spawn = recordCliSpawn({
      unitOfWork,
      runs: store.runs,
      now: () => options.context(job.taskId).clock.now(),
      runId: prepared.run.id,
      logger,
    });
    try {
      const handle = runner.start(prepared.spec, spawn.hooks);
      outcome = await handle.outcome;
      if (!spawn.requested() && !isStopEnding(outcome)) {
        // Ruling (d): an ending that came back with no marker is a run whose CLI was never asked
        // for — a refused handshake, a connect timeout, a session that ended first. It ends as a
        // start failure, never as the `crash` the runner may have reported.
        throw cliSpawnNotRequested(outcome);
      }
    } catch (error) {
      // **A start that throws used to escape both endings** (WP-15c, Q52/Q59).
      //
      // Transaction 1 has already created the `runs` row and emitted `run.created`/`run.started`,
      // so an error thrown by `start` — or a rejection of `handle.outcome` — left a run `running`
      // for ever, a task sitting at a stage nothing would move, and a `stage.execute` job that
      // exhausted its retries into pg-boss where no screen showed it (an administrator's list does
      // since WP-108, and the stranded-stage recovery finds the task). Nothing told a human.
      //
      // It was not hypothetical from the day a webhook could reach the pipeline, and WP-53 narrowed
      // it twice: the transport exists now (TD-028), and a process that is *not* configured to run
      // agents no longer subscribes this queue at all — so a ticket does not land here on an
      // unconfigured instance, it waits for a process that can perform the job. What still reaches
      // this branch is a start that fails on a configured one: the launcher unreachable, a spec it
      // refuses, or a run image with no CLI at the path the platform named.
      //
      // The ending is the one the executor already has for "the run produced no usable result":
      // the run is failed and the task is **escalated to `needs_human`**, an existing state whose
      // whole meaning is *a human must act*. No new task state — a third spelling of "stuck" that
      // no template, query or screen knows about would be worse than the one that exists. `unavailableClaudeRunner`
      // is unchanged and still refuses rather than fabricating a `RunOutcome`: what changed is
      // that its refusal now has somewhere to land.
      //
      // **WP-15g splits that cost in two** (Q59(a)). A *transport* failure — the runner could not
      // reach the workspace's control socket — is retried a bounded number of times before it
      // escalates, because escalation happens on the first failure and a transport that flaps
      // would otherwise park one task and need one human per flap. Everything else still
      // escalates immediately, which is the fail-closed default: a failure shape nobody has
      // classified tells somebody rather than spinning. `retry-stage` remains the human's answer
      // either way (product/04).
      await stopHeartbeat();
      stopReasons.forget(prepared.spec.runId);
      const startAttempts = (job.startAttempts ?? 0) + 1;
      const retryable = isRetryableStartFailure(error) && startAttempts < MAX_RUN_START_ATTEMPTS;
      logger.error(
        {
          err: error,
          task_id: job.taskId,
          stage: job.stage,
          run_id: prepared.run.id,
          start_attempts: startAttempts,
          retryable,
        },
        retryable
          ? 'the runner could not start this stage; the run is failed and the stage will be retried'
          : 'the runner could not start this stage; the run is failed and the task escalated',
      );
      return writing(job.taskId, 'recording a run that could not start', async (scope) =>
        recordUnstarted(scope, {
          job,
          run: prepared.run,
          options,
          // The **class name and the platform's own diagnosis**, never the message: an error
          // thrown out of a runner may quote a provider, a URL or a credential, and this string is
          // written to `events.payload` (`run.failed`) and into the escalation's blocker brief,
          // both of which TD-012 covers and neither of which passes a redactor here. So what is
          // added is closed vocabulary only — the workspace's error kind and its reason code, and
          // a commit through `shaSchema` (WP-127, backlog 351, `describeStartFailure`). The message
          // is in the log line above.
          startFailure: describeStartFailure(error),
          // Backlog 453: the workspace's own words, beside that sentence and never in it — through
          // this run's redactor, over the whole text before the cut, then bounded. They go to
          // `runs.exit_detail`, `run.failed.start_failure`, the run page and the brief.
          notStarted: runStartFailureOf(error, {
            redactor: prepared.redactor,
            attempt: startAttempts,
            retryable,
          }),
          startAttempts,
          retryable,
          spawnRequested: spawn.requested(),
        }),
      );
    }
    await stopHeartbeat();
    const stopReason = stopReasons.reasonFor(prepared.spec.runId);
    stopReasons.forget(prepared.spec.runId);
    if (!spawn.requested()) {
      // A stop that landed before the CLI was asked for keeps its status and spent nothing (WP-150).
      outcome = unspawnedStop(outcome);
    }

    return writing(job.taskId, "recording a run's result", async (scope) =>
      record(scope, {
        job,
        settings: prepared.settings,
        stage: prepared.stage,
        run: prepared.run,
        outcome,
        stopReason,
        options,
        redactor: prepared.redactor,
        reviewChecklists: prepared.reviewChecklists,
      }),
    );
  };

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
  };
};

/**
 * What a run adds to the task's `cost_actual`: finite, non-negative, and 0 for a run that reported
 * nothing (`cost_unreported`, which is a fault rather than a free run — BD-011, standing rule 16) or
 * that nothing measured (`costUnmeasured`) — adding nothing, which is not the same as recording a
 * zero: the run row and the event carry `null` for the second (`rowCostOf`).
 */
const spendOf = (outcome: RunOutcome): number =>
  outcome.costUnmeasured === true
    ? 0
    : Number.isFinite(outcome.cost.usd)
      ? Math.max(0, outcome.cost.usd)
      : 0;

/**
 * The cost `runs.finish` writes **and the terminal event carries**: the outcome's, or **`null`**
 * when nothing measured it (WP-101 review round 1, standing rule 16) — a stop whose interrupted
 * turn sent no `result` inside the grace: a human's cancel or take-over, and since WP-119 a stall or
 * a wall-clock stop (PROGRESS backlog 334). Both cost columns then stay empty, as for a run the
 * lease sweep ended, `run.finished.cost` is `null` (nullish since WP-119; until then the event said
 * `{ usd: 0 }` while the row said `null`), and the ledger writes no row, rather than a `0` that every
 * later reader would take for a measurement.
 */
const rowCostOf = (outcome: RunOutcome): RunCost | null =>
  outcome.costUnmeasured === true ? null : outcome.cost;

/**
 * Is the outcome's cost the runner's **floor** — a `cost_unreported` stop (WP-131 pre-review round,
 * PROGRESS backlog 407)? WP-119 kept the floor in the cost column and this does not change it; it
 * tells `runs.finish` so, and the caps then hold the run at its reservation and the totals count it
 * as unmeasured, rather than reading a measured `0`.
 */
const costIsFloorOf = (input: { readonly stopReason: string | null }): boolean =>
  input.stopReason === COST_UNREPORTED;

/**
 * What a `run.failed` carries about the spend — both nullish in the event. A `stalled` run whose
 * stop read nothing (WP-119) carries **neither**, which is the lease sweep's shape and what the
 * ledger reads as `no_usage_and_no_cost`; the zeros the outcome holds are the runner's floor.
 */
const failedSpendOf = (
  outcome: RunOutcome,
): { readonly usage?: TokenUsage; readonly cost?: RunCost } =>
  outcome.costUnmeasured === true ? {} : { usage: outcome.usage, cost: outcome.cost };

interface RecordInput {
  readonly job: StageExecutionJob;
  readonly settings: ProjectSettings;
  readonly stage: PipelineStage;
  readonly run: Run;
  readonly outcome: RunOutcome;
  readonly stopReason: string | null;
  readonly options: StageExecutorOptions;
  /** The run's own redactor — TD-012 at the artifact write (WP-52). */
  readonly redactor: SecretRedactor;
  /** What the planner gave a Reviewer run, or `null` when it recorded nothing (WP-45). */
  readonly reviewChecklists: readonly AppliedChecklistRecord[] | null;
}

/**
 * The platform's record on a `ReviewVerdict`, over whatever the model wrote there (WP-45).
 *
 * `checklists_applied` is a fact about the prompt the platform assembled, so a model's value for it
 * is **discarded** rather than trusted or merged — a Reviewer that claimed a checklist it was never
 * given would otherwise put *"stricter"* on the record for free. Every other artifact type is
 * returned untouched.
 */
export const withPlatformReviewRecord = (
  artifactType: string,
  data: JsonValue,
  applied: readonly AppliedChecklistRecord[] | null,
): JsonValue => {
  if (artifactType !== 'ReviewVerdict' || typeof data !== 'object' || data === null) {
    return data;
  }
  if (Array.isArray(data)) {
    return data;
  }
  return {
    ...data,
    checklists_applied:
      applied === null
        ? null
        : applied.map((entry) => ({
            name: entry.name,
            item_count: entry.item_count,
            required_by: [...entry.required_by],
            truncated: entry.truncated,
          })),
  };
};

/**
 * **The platform's merge request, not the model's** (WP-138 ruling (e)).
 *
 * `ImplementationNotes.mr` is the developer's report of the merge request it opened, and until
 * WP-138 the saga recorded it as the task's. The record is now the platform's — written when the
 * `open_mr` tool opened or adopted the merge request — so when the task holds one, the stored
 * artifact carries **the record's** reference, and a report that named another merge request is
 * noted in `known_gaps` with a platform-written line (both iids, nothing else of the model's).
 * A task with no record keeps the report as written: nothing is recorded from it either way.
 * Every other artifact type is returned untouched.
 */
export const withPlatformMergeRequestRecord = (
  artifactType: string,
  data: JsonValue,
  recorded: MergeRequestRef | null,
): JsonValue => {
  if (
    artifactType !== 'ImplementationNotes' ||
    recorded === null ||
    typeof data !== 'object' ||
    data === null ||
    Array.isArray(data)
  ) {
    return data;
  }
  const object = data as { readonly [key: string]: JsonValue | undefined };
  const reported = object.mr;
  const reportedIid =
    typeof reported === 'object' && reported !== null && !Array.isArray(reported)
      ? (reported as { readonly [key: string]: JsonValue | undefined }).iid
      : undefined;
  const gaps: JsonValue[] = Array.isArray(object.known_gaps) ? [...object.known_gaps] : [];
  if (reportedIid !== recorded.iid) {
    gaps.push(
      `The platform recorded merge request !${recorded.iid} for this task; the run reported ${
        typeof reportedIid === 'number' ? `!${reportedIid}` : 'another one'
      }, which was not recorded (WP-138: the platform's record wins).`,
    );
  }
  return { ...object, mr: { ...recorded } as JsonValue, known_gaps: gaps } as JsonValue;
};

/**
 * Transaction 2: everything the run produced, written once.
 *
 * The artifact, the run's terminal event, the task's spend and `task.stage.completed` all commit
 * together — a partial write here would leave a task whose stage completed but whose artifact is
 * missing, and the interpreter would then transition on an artifact nobody can read.
 */
const record = async (
  scope: TransactionScope,
  input: RecordInput,
): Promise<StageExecutionOutcome> => {
  const { options, outcome, run, stage, job } = input;
  const { store } = options;
  const stored = await store.tasks.load(scope.tx, job.taskId);
  if (stored === null) {
    return { kind: 'skipped', reason: 'the task was deleted while its stage was running' };
  }
  const context = options.context(job.taskId);

  const spent = spendOf(outcome);
  /**
   * The spend, carried in memory here and **written by `addSpend`** in each branch below, after
   * that branch has won the run (WP-31).
   *
   * Two things, deliberately. The row's `cost_actual` is moved by an increment the database
   * performs, because the ask executor adds to the same column from a process that runs beside this
   * one and a read-modify-write from either would lose the other's — `save` no longer names the
   * column at all, so there is one writing statement and no arbitration to get wrong. And the
   * *in-memory* snapshot still carries the new total, because the workpad render and the task's own
   * events read it from there.
   *
   * It is **not** written here, before the branches: `runs.finish` is conditional on this caller
   * still owning the run (a human may have cancelled it), and a caller that lost must write nothing
   * — which is the assertion `writes nothing at all when the run was ended by somebody else first`
   * makes.
   */
  const withCost: StoredTask = { ...stored, costActualUsd: stored.costActualUsd + spent };

  /**
   * **The task stopped while this run was in flight** (WP-15i).
   *
   * A human can pause, cancel or send a task back over HTTP at any moment, and the only thing that
   * had ever moved a task out from under a running stage before was the executor itself. Every
   * write below assumes the task is still running at this stage: `completeStage` throws for a
   * paused one and `pauseTask` throws for a task that is already paused, and either exception fails
   * the job into pg-boss's retry — which would re-run the *stage*, not the write, and eventually
   * dead-letter a run that had already produced its answer.
   *
   * So the run is recorded and the stage is not completed. The spend is not lost (it is the
   * platform's own record of money) and the human's decision stands: `revalidate` is what admits
   * the next attempt when they resume.
   */
  if (!isRunnableTaskState(stored.task.state)) {
    return recordOntoStoppedTask(scope, input, withCost, context);
  }

  /**
   * **The task left this run's attempt while it was in flight** (PROGRESS backlog 494).
   *
   * A retry of the stage, a return, a hand-back — every way back into a stage is a new attempt, and
   * a run started for the old one can no longer speak for the stage: it is recorded, and its spend
   * charged, exactly like a run that ended into a stopped task. Until backlog 494 this transaction
   * never asked which attempt it was recording, so a retry pressed during a run was completed by
   * the run it meant to replace — and the new attempt's job found the stage done.
   */
  if (!isCurrentStageAttempt(stored.task, job.stage, job.attempt)) {
    return recordOntoStoppedTask(scope, input, withCost, context);
  }

  if (outcome.status !== 'completed') {
    return recordUnsuccessful(scope, input, withCost, context);
  }

  const finished = finishRun(
    run,
    {
      status: 'completed',
      terminalReason: outcome.terminalReason,
      usage: outcome.usage,
      modelUsage: outcome.modelUsage,
      cost: rowCostOf(outcome),
      numTurns: outcome.numTurns,
    },
    context,
  );
  const owned = await store.runs.finish(scope.tx, {
    runId: run.id,
    status: 'completed',
    terminalReason: outcome.terminalReason,
    sessionId: outcome.sessionId,
    numTurns: outcome.numTurns,
    usage: outcome.usage,
    cost: rowCostOf(outcome),
    wallMs: outcome.wallMs,
    costIsFloor: costIsFloorOf(input),
  });
  if (!owned) {
    return lostTheRun({ ...input, scope });
  }
  await store.tasks.addSpend(scope.tx, job.taskId, spent);

  const events: DomainEvent[] = [...finished.events];
  let artifactRef: ArtifactRef | null = null;
  let data: JsonValue | null = null;
  let task = withCost.task;

  if (stage.produces !== null) {
    if (outcome.structuredOutput === null) {
      // The runner re-validates structured output against the artifact schema and reports
      // `error_max_structured_output_retries` when it never arrived; there is nothing to store and
      // nothing to transition on.
      return escalateOnRun(scope, input, withCost, context, 'the run produced no artifact', [
        ...finished.events,
      ]);
    }
    /**
     * **A developer stage is not done without a merge request the platform recorded** (first local
     * test, 2026-10-06, backlog 472).
     *
     * `ImplementationNotes.mr` is required by the schema, so a run whose `open_mr` failed still has
     * to put *something* there — AUT-6820's second developer attempt could not commit (backlog 468),
     * `open_mr` answered GitLab's 400, and the run reported the ticket number as the iid and a
     * "create merge request" link as the URL. `withPlatformMergeRequestRecord` keeps a report as
     * written when the task holds no record, so the stage completed and the task walked into
     * `ci_gate` with no merge request at all. The record is the platform's (`open_mr` writes it,
     * WP-138), so its absence here means the stage did not do the one thing the rest of the
     * pipeline reads: the task escalates instead, with the run recorded as finished. A shadow task
     * opens nothing by design and is left alone.
     */
    if (
      stage.produces === 'ImplementationNotes' &&
      stored.mr === null &&
      stored.task.mode !== 'shadow'
    ) {
      return escalateOnRun(
        scope,
        input,
        withCost,
        context,
        'the developer stage reported its work done, but no merge request was opened through ' +
          'open_mr, so there is nothing for the CI gate or a review to read; the work is in the ' +
          "run's workspace only if it was committed and pushed to the task's branch",
        [...finished.events],
      );
    }
    /**
     * TD-012 **at the write**, which this line did not do until WP-52 (PROGRESS backlog 35).
     *
     * `data = outcome.structuredOutput` stored the model's answer verbatim, so a credential the
     * platform injected into the run reached `artifacts.data` — and from there `questions.text`
     * below and, through `recordMergeRequest`, the `tasks` row. `artifacts` is append-only, so the
     * redaction has to happen before the insert or not at all.
     *
     * The refusal is the identifier half of the amendment: a field the platform *reads as a name*
     * is never rewritten, because a `[REDACTED:integration:…]` in `mr.head_sha` is a value the
     * platform then queries a provider with (standing rule 70). Nothing is stored, the run is
     * already recorded as finished above, and the task escalates — the ending this branch already
     * has for "the run produced no artifact", reused rather than invented.
     */
    let redacted: RedactedArtifact;
    try {
      redacted = redactArtifactData(
        stage.produces,
        withPlatformMergeRequestRecord(
          stage.produces,
          withPlatformReviewRecord(
            stage.produces,
            outcome.structuredOutput as JsonValue,
            input.reviewChecklists,
          ),
          stored.mr,
        ),
        input.redactor,
      );
    } catch (error) {
      if (!(error instanceof ArtifactIdentifierSecretError)) {
        throw error;
      }
      return escalateOnRun(
        scope,
        input,
        withCost,
        context,
        // The **path**, never the value: this reason is written to `events.payload` and into the
        // blocker brief a human reads.
        `the run wrote a secret this run was given into "${error.path}", which the platform reads ` +
          'as an identifier and therefore refuses to rewrite',
        [...finished.events],
      );
    }
    data = redacted.data;
    const version = await store.artifacts.nextVersion(scope.tx, job.taskId, stage.produces);
    const artifactId = context.ids.next();
    await store.artifacts.insert(scope.tx, {
      id: artifactId,
      taskId: job.taskId,
      type: stage.produces,
      version,
      markdown: null,
      data,
      schemaVersion: '1',
      producedByRunId: run.id,
      redactionCount: redacted.count,
      createdAt: context.clock.now(),
    });
    artifactRef = { id: artifactId, artifact_type: stage.produces, version, url: null };
    const recorded = recordArtifact(
      task,
      { artifact: artifactRef, producedByRunId: run.id },
      context,
    );
    task = recorded.aggregate;
    events.push(...recorded.events);
  }

  const verdictInput = {
    artifactType: stage.produces,
    data,
    attemptOnLowConfidence: false,
  };
  /**
   * An **advisory** stage always advances (`agentStageSchema.advisory`, WP-25).
   *
   * The artifact is still produced, validated and stored; what it does not do is decide the
   * transition. Without this, the ticket readiness linter's own success case — a `RefinedSpec`
   * whose `decision` is `ask`, which is what an unready ticket deserves — would park the lint task
   * in `waiting_answers` on questions nobody can answer, and a `reject` would escalate it to
   * `needs_human`. Measured on the first run of `ticket-lint.test.ts`: *"expected
   * 'waiting_answers' to be 'done'"*.
   *
   * A verdict the platform cannot map is still passed through, capped: the interpreter escalates
   * on it either way, and "the stage said `ship it`" is a far better blocker brief than "the stage
   * said nothing".
   */
  const verdict = stage.advisory
    ? 'approve'
    : (stageVerdict(verdictInput) ?? rawVerdict(verdictInput));

  const completed = completeStage(
    task,
    {
      stage: job.stage,
      artifacts: artifactRef === null ? [] : [artifactRef],
      ...(verdict === null ? {} : { verdict }),
    },
    context,
  );
  events.push(...completed.events);
  task = completed.aggregate;

  const questions =
    verdict === 'questions' ? artifactQuestions(data).filter((draft) => draft.blocking) : [];
  for (const draft of questions) {
    const question = openQuestion(
      {
        id: context.ids.next(),
        taskId: job.taskId,
        projectId: stored.task.projectId,
        stage: job.stage,
        runId: run.id,
        text: draft.text,
        blocking: true,
        ...(draft.options === null ? {} : { options: draft.options }),
        // WP-56: `deadline_at` is written in this transaction, from `questionTimeoutAt` over the
        // organisation's calendar at the project's `question_timeout` (BD-006).
        deadlineFrom: questionDeadlineRule(input.options.calendar, input.settings),
      },
      context,
    );
    await store.questions.insert(scope.tx, question);
    const asked = askQuestion(task, { question: toQuestionRecord(question) }, context);
    task = asked.aggregate;
    events.push(...asked.events);
  }

  await store.tasks.save(scope.tx, { ...withCost, task });
  await store.tasks.recordStageExited(scope.tx, {
    taskId: job.taskId,
    stage: job.stage,
    attempt: job.attempt,
    state: 'completed',
    // The column's vocabulary, not the model's (WP-73, backlog 213): a verdict the interpreter
    // does not know is recorded as `unrecognised` — the model's own word is on the artifact.
    outcome:
      verdict === null ? 'unknown' : (stageVerdictSchema.safeParse(verdict).data ?? 'unrecognised'),
    returnReason: null,
    returnedTo: null,
  });
  await scope.events.append(events);
  return { kind: 'ran', runId: run.id, verdict };
};

/**
 * Somebody else ended this run while it was in flight, so this process writes **only its cost**.
 *
 * `RunRepository.finish` is conditional on the run still being live, and there are two other
 * writers: `POST /api/runs/:run_id/cancel` (WP-15i) and the lease sweep (WP-47). Since WP-101 the
 * cancel is a foreign writer only when no process held the run's lease (TD-028 decision 11); with a
 * live lease it is a `run_commands` row this process applies as the session's stop, and the ending
 * is then this process's own, with its measured cost — this path is not taken. Losing that race is
 * not a failure — the other writer's decision is the one that stands, and this transaction rewrites
 * no status, completes no stage and appends no second terminal event.
 *
 * **What changed at WP-47 is the money** (Q70 (b), PROGRESS backlog 50). Until then the tokens this
 * run had already spent were not recorded at all: the cancel wrote the row's terminal status with
 * the spend *it* knew about — none — the ledger took its `no_spend` branch, and `cost_entries`, the
 * rollup and every budget window stayed where they were. So cancelling was the one human action
 * that spent a project's budget without charging it. This process is the only one that knows the
 * number, so it writes it through the narrow `runs.recordCost` (never a status, never a whole row)
 * and charges the ledger from the same transaction, labelled `late`.
 *
 * The residual is one line down from where it used to be, and it is real: a run whose process
 * **died** has nobody left to make this call, so its spend is genuinely unknown and the platform
 * writes no figure and no ledger row rather than a zero (standing rule 16) — and, since WP-131,
 * every cap holds it at the reservation it was admitted at, so the unknown is not admitted past
 * (`../cost/pending.ts`). This call is what releases that hold, and it moves `cost_actual` with it.
 */
const lostTheRun = async (input: {
  readonly run: Run;
  readonly outcome?: RunOutcome;
  readonly options: StageExecutorOptions;
  readonly scope: TransactionScope;
  /** The transcript's stop reason — a `cost_unreported` outcome's cost is a floor (407). */
  readonly stopReason?: string | null;
}): Promise<StageExecutionOutcome> => {
  const { run, outcome, options } = input;
  const reason = `run ${run.id} was ended by another writer while it was in flight, so its outcome was discarded`;
  if (outcome === undefined) {
    // `recordUnstarted`'s path: the run never started, so there is no spend to record and nothing
    // for the ledger to be late about.
    return { kind: 'skipped', reason };
  }
  if (outcome.costUnmeasured === true) {
    // Stopped with no result inside the grace (WP-101 review round 1): there is no figure to be
    // late with, and a zero would be a claim (rule 16).
    return { kind: 'skipped', reason };
  }
  const recorder = options.lateCost ?? noLateCostRecorder;
  await recorder.record(
    input.scope,
    {
      runId: run.id,
      taskId: run.taskId,
      sessionId: outcome.sessionId,
      numTurns: outcome.numTurns,
      usage: outcome.usage,
      modelUsage: outcome.modelUsage,
      cost: outcome.cost,
      wallMs: outcome.wallMs,
      // WP-131 review round 1: a `cost_unreported` outcome's `usd: 0` is the runner's floor, and the
      // late write must say so, or the row would read as a measured free run and release the hold.
      costIsFloor: costIsFloorOf({ stopReason: input.stopReason ?? null }),
    },
    options.context(run.taskId).clock.now(),
  );
  return { kind: 'skipped', reason };
};

/**
 * The run ended and the task is no longer running at this stage — or no longer on this run's
 * attempt of it (backlog 494): record the run, stop there.
 *
 * The caller's docblock has the reasoning. What this function is careful about is the *order*: the
 * run's row is written first and everything else depends on having won it, so a lost race leaves
 * this transaction with nothing in it.
 */
const recordOntoStoppedTask = async (
  scope: TransactionScope,
  input: RecordInput,
  withCost: StoredTask,
  context: CommandContext,
): Promise<StageExecutionOutcome> => {
  const { options, outcome, run } = input;
  const { store } = options;
  const decision =
    outcome.status === 'failed' || outcome.status === 'stalled'
      ? failRun(
          run,
          {
            status: outcome.status,
            terminalReason: outcome.terminalReason,
            error: outcome.error ?? outcome.terminalReason,
            ...failedSpendOf(outcome),
            ...savedWorkOf(outcome),
          },
          context,
        )
      : finishRun(
          run,
          {
            status: outcome.status,
            terminalReason: outcome.terminalReason,
            usage: outcome.usage,
            modelUsage: outcome.modelUsage,
            cost: rowCostOf(outcome),
            numTurns: outcome.numTurns,
            ...savedWorkOf(outcome),
          },
          context,
        );
  const owned = await store.runs.finish(scope.tx, {
    runId: run.id,
    status: outcome.status,
    terminalReason: outcome.terminalReason,
    sessionId: outcome.sessionId,
    numTurns: outcome.numTurns,
    usage: outcome.usage,
    cost: rowCostOf(outcome),
    wallMs: outcome.wallMs,
    costIsFloor: costIsFloorOf(input),
    ...savedWorkOf(outcome),
  });
  if (!owned) {
    return lostTheRun({ ...input, scope });
  }
  // The spend, and **nothing else**: `withCost.task` is the state the human left the task in, so a
  // `save` here would put back a row nobody changed and bump its version against the human's next
  // command. Since WP-31 the spend is its own narrow write, which is what made that possible.
  await store.tasks.addSpend(scope.tx, input.job.taskId, spendOf(outcome));
  await scope.events.append(decision.events);
  const { task } = withCost;
  return {
    kind: 'skipped',
    reason: `the task is "${task.state}" at "${task.currentStage ?? 'no stage'}" (attempt ${String(
      task.currentStage === null ? 0 : (task.stageAttempts[task.currentStage] ?? 0),
    )}), so the run of attempt ${String(input.job.attempt)} of "${input.job.stage}" was recorded and the stage was not completed`,
  };
};

/** A run that did not complete: budget, fault, timeout, stall or cancellation. */
const recordUnsuccessful = async (
  scope: TransactionScope,
  input: RecordInput,
  stored: StoredTask,
  context: CommandContext,
): Promise<StageExecutionOutcome> => {
  const { options, outcome, run } = input;
  const { store } = options;

  if (outcome.terminalReason === 'shutdown') {
    return recordHandBack(scope, input, stored, context);
  }

  const costUnreported = input.stopReason === COST_UNREPORTED;
  const overspent = outcome.status === 'budget_exceeded' && !costUnreported;

  const decision =
    outcome.status === 'failed' || outcome.status === 'stalled'
      ? failRun(
          run,
          {
            status: outcome.status,
            terminalReason: outcome.terminalReason,
            error: outcome.error ?? outcome.terminalReason,
            ...failedSpendOf(outcome),
            ...savedWorkOf(outcome),
          },
          context,
        )
      : finishRun(
          run,
          {
            status: outcome.status,
            terminalReason: outcome.terminalReason,
            usage: outcome.usage,
            modelUsage: outcome.modelUsage,
            cost: rowCostOf(outcome),
            numTurns: outcome.numTurns,
            ...savedWorkOf(outcome),
          },
          context,
        );

  const owned = await store.runs.finish(scope.tx, {
    runId: run.id,
    status: outcome.status,
    terminalReason: outcome.terminalReason,
    sessionId: outcome.sessionId,
    numTurns: outcome.numTurns,
    usage: outcome.usage,
    cost: rowCostOf(outcome),
    wallMs: outcome.wallMs,
    costIsFloor: costIsFloorOf(input),
    ...savedWorkOf(outcome),
  });
  if (!owned) {
    return lostTheRun({ ...input, scope });
  }
  await store.tasks.addSpend(scope.tx, input.job.taskId, spendOf(outcome));
  // Backlog 467: the branch the run's unfinished work was pushed to is the task's from now on.
  const withBranch = withSavedBranch(stored, outcome);

  if (overspent) {
    // BD-010: a task budget pauses the task; a human may raise the cap and resume it.
    const paused = pauseTask(withBranch.task, { reason: 'budget', budgetScope: 'run' }, context);
    await store.tasks.save(scope.tx, { ...withBranch, task: paused.aggregate });
    await scope.events.append([...decision.events, ...paused.events]);
    return {
      kind: 'paused',
      reason: `the run stopped at its ${outcome.terminalReason} cap`,
    };
  }

  const reason = costUnreported
    ? 'the platform could not tell what the run cost, so it stopped it without verifying the budget'
    : `the run ended as ${outcome.status} (${outcome.terminalReason})`;
  return escalateOnRun(
    scope,
    input,
    withBranch,
    context,
    reason,
    decision.events,
    outcome.savedWork === undefined
      ? undefined
      : `${defaultBlockerBrief(input.job.stage, withBranch.task.ticket.key, reason)} ${savedWorkSentence(outcome.savedWork)}`,
  );
};

/**
 * `outcome.savedWork` as the optional input `failRun`, `finishRun` and `runs.finish` take — absent
 * when the workspace attempted no export (PROGRESS backlog 467).
 */
const savedWorkOf = (outcome: RunOutcome): { readonly savedWork?: RunSavedWork } =>
  outcome.savedWork === undefined ? {} : { savedWork: outcome.savedWork };

/**
 * The task with the branch its run's unfinished work was **pushed** to (PROGRESS backlog 467).
 *
 * `tasks.branch` is `save`'s column (the aggregate's, `tasks-column-ownership.test.ts`), and both
 * callers save the task in this same transaction, so the branch rides that write rather than a
 * narrow one of its own. Filled only while it is `null` — a recorded branch is the merge request's
 * or a rework's, and the export pushed to the spec's checkout, which is that same branch — and only
 * for a push that succeeded: a branch the remote does not hold is not the task's.
 */
const withSavedBranch = (stored: StoredTask, outcome: RunOutcome): StoredTask =>
  outcome.savedWork?.pushed === true && stored.branch === null
    ? { ...stored, branch: outcome.savedWork.branch }
    : stored;

/**
 * **A run its own process stopped** (WP-144, PROGRESS backlog 432): end it `failed`/`shutdown` with
 * whatever the session measured, and hand the stage entry back — or, past the bound, escalate.
 *
 * The run's ending and the decision are one transaction: the count is read **before** this run's
 * row moves (so it is the entry's earlier hand-backs), `finish` is the arbiter with every other
 * writer (a person's cancel that ended the row first wins, and this writes nothing but the late
 * cost — `lostTheRun`), and the spend is added once, by the winner. The reservation is released by
 * the row becoming terminal, as for every ending; a run that measured nothing **after asking for its
 * CLI** keeps both cost columns null and is held at its reservation by the task cap (rule 16,
 * WP-131) — never a `0`. A hand-back that landed before the marker spent nothing and carries the
 * measured zero (`unspawnedStop`, WP-150).
 *
 * **The task is not touched** on the hand-back: still `active` at this stage on this attempt with
 * its stage row open, which is exactly what `revalidateOpen` admits when the re-enqueued job fires
 * — the caller's enqueue, after this commits (`Jobs.enqueue` does not join a transaction; a process
 * that dies between the two leaves the entry to the stranded-stage recovery, which escalates an
 * attempt whose run ended, naming `shutdown`). A task a person moved meanwhile (paused, cancelled,
 * sent elsewhere) is recorded onto and never re-run: the job re-validates on fire (TD-004).
 */
const recordHandBack = async (
  scope: TransactionScope,
  input: RecordInput,
  stored: StoredTask,
  context: CommandContext,
): Promise<StageExecutionOutcome> => {
  const { options, outcome, run, job } = input;
  const { store } = options;
  if (revalidate(stored, job).kind === 'skipped') {
    return recordOntoStoppedTask(scope, input, stored, context);
  }
  const earlier = await store.runs.shutdownEndings(scope.tx, {
    taskId: job.taskId,
    stage: job.stage,
    attempt: job.attempt,
  });
  const handBacks = earlier + 1;
  const failed = failRun(
    run,
    {
      status: 'failed',
      terminalReason: 'shutdown',
      error: outcome.error ?? 'shutdown',
      ...failedSpendOf(outcome),
    },
    context,
  );
  const owned = await store.runs.finish(scope.tx, {
    runId: run.id,
    status: 'failed',
    terminalReason: 'shutdown',
    sessionId: outcome.sessionId,
    numTurns: outcome.numTurns,
    usage: outcome.usage,
    cost: rowCostOf(outcome),
    wallMs: outcome.wallMs,
    costIsFloor: costIsFloorOf(input),
  });
  if (!owned) {
    return lostTheRun({ ...input, scope });
  }
  await store.tasks.addSpend(scope.tx, job.taskId, spendOf(outcome));
  if (handBacks > MAX_SHUTDOWN_HAND_BACKS) {
    const reason = `the platform's runner was stopped during this stage ${String(handBacks)} times`;
    return escalateOnRun(
      scope,
      input,
      stored,
      context,
      reason,
      failed.events,
      `The "${job.stage}" stage of ${stored.task.ticket.key} was interrupted ${String(handBacks)} times ` +
        `because the platform's runner process was stopped while it ran (attempt ${String(job.attempt)}; ` +
        `the last run is ${run.id}). The first ${String(MAX_SHUTDOWN_HAND_BACKS)} were started again ` +
        'automatically; this one is not. Work the interrupted runs had not pushed is lost. Find out ' +
        'why the runner keeps stopping (an upgrade loop, a memory limit, a restart policy), then hand ' +
        'the task back at this stage.',
    );
  }
  await scope.events.append(failed.events);
  return {
    kind: 'handed_back',
    runId: run.id,
    handBacks,
    reason: `the runner was stopped while the run was in flight; hand-back ${String(handBacks)} of ${String(MAX_SHUTDOWN_HAND_BACKS)}`,
  };
};

/**
 * Ends the stage without a verdict. The pipeline's `run.failed` handler is *not* what escalates —
 * the task is parked here, in the same transaction that recorded the run, so there is no window in
 * which a task looks `active` at a stage that has already stopped.
 */
const escalateOnRun = async (
  scope: TransactionScope,
  input: RecordInput,
  stored: StoredTask,
  context: CommandContext,
  reason: string,
  runEvents: readonly DomainEvent[] = [],
  blockerBrief?: string,
): Promise<StageExecutionOutcome> => {
  const { options, run } = input;
  const { job } = input;
  const escalated = escalate(stored, context, job.stage, reason, blockerBrief);
  await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
  await options.store.tasks.recordStageExited(scope.tx, {
    taskId: job.taskId,
    stage: job.stage,
    attempt: job.attempt,
    state: 'failed',
    outcome: 'failed',
    returnReason: reason,
    returnedTo: null,
  });
  await scope.events.append([...runEvents, ...escalated.events]);
  return { kind: 'failed', runId: run.id, reason };
};

/**
 * A run that was created and never started: fail the run, and escalate the task unless the failure
 * is worth another attempt.
 *
 * Deliberately **not** routed through `record`: that function reads a `RunOutcome`, and there is
 * none — fabricating one would make the pipeline transition on a verdict for a run that was never
 * attempted, which is the fail-open direction standing rule 20 names and which
 * `apps/server/src/pipeline.ts` refuses at the runner. The run really exists (transaction 1 wrote
 * it) and really failed to start, so `run.failed` is the honest record of it.
 *
 * **On the retryable path the run is still failed and the task is left alone** (Q59(a)). Both halves
 * matter: a `runs` row left `running` for a run nobody will start is the defect WP-15c closed, and a
 * task moved out of `active` could not be woken by the re-enqueue the caller is about to make. So
 * each flap costs exactly one failed `runs` row, which is what makes a flapping transport visible
 * without a human.
 */
const recordUnstarted = async (
  scope: TransactionScope,
  input: {
    readonly job: StageExecutionJob;
    readonly run: Run;
    readonly options: StageExecutorOptions;
    readonly startFailure: string;
    /** What `runs.exit_detail` and `run.failed.start_failure` record (backlog 453). */
    readonly notStarted: RunStartFailure;
    readonly startAttempts: number;
    /** `true` leaves the task where it is; the caller re-enqueues the stage. */
    readonly retryable: boolean;
    /**
     * Whether the run's CLI spawn marker was written (WP-150). Almost always `false` here. `true` is
     * a runner that failed **after** asking for the CLI, whose spend nobody measured: the run is
     * then recorded with no figure and held at its reservation (WP-131), never the measured zero.
     */
    readonly spawnRequested: boolean;
  },
): Promise<StageExecutionOutcome> => {
  const { job, run, options, startFailure } = input;
  const spend = input.spawnRequested ? {} : { usage: NO_USAGE, cost: NO_COST };
  const stored = await options.store.tasks.load(scope.tx, job.taskId);
  if (stored === null) {
    return { kind: 'skipped', reason: 'the task was deleted before its run could start' };
  }
  const context = options.context(job.taskId);
  const reason = input.retryable
    ? `the run could not be started (${startFailure}); attempt ${input.startAttempts} of ${MAX_RUN_START_ATTEMPTS}`
    : `the run could not be started (${startFailure})`;
  const failed = failRun(
    run,
    {
      status: 'failed',
      terminalReason: 'error_during_execution',
      error: reason,
      ...spend,
      startFailure: input.notStarted,
    },
    context,
  );
  const owned = await options.store.runs.finish(scope.tx, {
    runId: run.id,
    status: 'failed',
    terminalReason: 'error_during_execution',
    sessionId: null,
    numTurns: 0,
    usage: NO_USAGE,
    cost: input.spawnRequested ? null : NO_COST,
    wallMs: 0,
    startFailure: input.notStarted,
  });
  if (!owned) {
    // A human cancelled the run between its insert and this failure (WP-15i), or the lease sweep
    // ended it (WP-47). Neither ending applies: there is nothing to retry and nothing to escalate
    // about a run somebody else stopped — and no spend, because it never started.
    return lostTheRun({ run, options, scope });
  }
  if (input.retryable) {
    // The task is untouched — still `active`, still at this stage, still on this attempt — so the
    // re-enqueue the caller makes finds exactly the state `revalidate` admits. Nothing is written
    // about the task at all: `recordStageExited` would record an exit from a stage the task has not
    // left, and the stage's convergence signature reads those rows.
    await scope.events.append(failed.events);
    return { kind: 'retry', runId: run.id, reason, startAttempts: input.startAttempts };
  }
  const escalated = escalate(
    stored,
    context,
    job.stage,
    reason,
    notStartedBrief(stored.task.ticket.key, job.stage, reason, input.notStarted),
  );
  await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
  await options.store.tasks.recordStageExited(scope.tx, {
    taskId: job.taskId,
    stage: job.stage,
    attempt: job.attempt,
    state: 'failed',
    outcome: 'failed',
    returnReason: reason,
    returnedTo: null,
  });
  await scope.events.append([...failed.events, ...escalated.events]);
  return { kind: 'failed', runId: run.id, reason };
};

/** How much of the launcher's words the brief quotes; the run page has all of them (backlog 453). */
export const NOT_STARTED_BRIEF_QUOTE_CHARS = 600;

/**
 * The blocker brief of a run that **never started** (PROGRESS backlog 453).
 *
 * The default brief sends the reader to *"the run's transcript"*, and a run that never started has
 * none — so this one says the run did not start, gives the platform's diagnosis, and quotes the tail
 * of the launcher's own words, bounded to {@link NOT_STARTED_BRIEF_QUOTE_CHARS}. The quote is marked
 * as the launcher's: the brief also reaches the workpad and chat, and the text is untrusted
 * (BD-022) — redacted twice already, bounded here, and rendered as text by every reader that shows
 * it. With no words to quote the brief says so rather than inventing a reason.
 */
export const notStartedBrief = (
  ticketKey: string,
  stage: Slug,
  reason: string,
  notStarted: RunStartFailure,
): string => {
  const detail = notStarted.detail;
  const cut =
    detail !== null && (detail.length > NOT_STARTED_BRIEF_QUOTE_CHARS || notStarted.truncated);
  const quote =
    detail === null
      ? "The launcher gave no reason of its own; the runner's log has the error under this run's id."
      : `The launcher said${cut ? ' (the end of it)' : ''}: «${detail.slice(-NOT_STARTED_BRIEF_QUOTE_CHARS)}»`;
  return (
    `The "${stage}" stage of ${ticketKey} did not start: ${reason}. ${quote} ` +
    'There is no transcript, because no agent ran; the run page shows the whole reason. ' +
    'Nothing is retried automatically. Fix what stopped the workspace from starting, then hand the ' +
    'task back at this stage.'
  );
};

/** Nothing was spent, because nothing ran — the one zero `./cli-spawn.ts` names (WP-150). */
const NO_USAGE = NO_RUN_USAGE;

/** `is_estimate: false` — "nothing" is a measurement, not a guess (BD-011). */
const NO_COST = MEASURED_ZERO_COST;

/** The blocker brief a stage that stopped without a result gets when its caller wrote none. */
const defaultBlockerBrief = (stage: Slug, ticketKey: string, reason: string): string =>
  `The "${stage}" stage of ${ticketKey} stopped without a result: ${reason}. ` +
  "Nothing is retried automatically. Open the run's transcript, decide what should change, " +
  'and hand the task back at the stage you want it to resume from.';

const escalate = (
  stored: StoredTask,
  context: CommandContext,
  stage: Slug,
  reason: string,
  blockerBrief?: string,
) =>
  escalateTask(
    stored.task,
    {
      reason: `stage "${stage}": ${reason}`,
      blockerBrief: blockerBrief ?? defaultBlockerBrief(stage, stored.task.ticket.key, reason),
    },
    context,
  );
