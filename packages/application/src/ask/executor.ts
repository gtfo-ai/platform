/**
 * The ask executor — one run with a task and **no stage** (WP-31, Q72 (a)).
 *
 * It is the stage executor's shape and not its code: **transaction / plan / transaction**, with the
 * run never in flight while a connection is held.
 *
 * ```
 * tx 1a  load the ask and the task, ask the five admission questions   → nothing, or a refusal row
 *        plan the prompt (retrieval; no transaction open)
 * tx 1b  ask the same five again, then create the Run (stage null)     → run.created, run.started
 * ——     run                                                           (a minute; no connection held)
 * tx 2   store the AskAnswer artifact and the answer on the ask row    → run.finished | run.failed
 * ```
 *
 * ## Three things it deliberately does *not* do, and each is the point
 *
 * **It never writes the `tasks` row through `save`.** An ask runs *beside* whatever the pipeline is
 * doing, by design — product/10:57 lets anyone ask at any moment — so a whole-row save from here
 * would be the lost update WP-15e measured, on a task another transaction owns. The one column it
 * has to move is `cost_actual`, and it moves it through the **narrow** `TaskRepository.addSpend`,
 * whose statement is an atomic increment rather than a read-modify-write.
 *
 * **It never moves the task's state.** A spent budget refuses the *ask*; it does not pause the task,
 * because the person who asked a question is not the person whose stage would be paused, and pausing
 * a delivery because somebody asked why is a side effect nobody asked for. A failed ask escalates
 * nothing: the ask row carries the failure, the thread shows it, and the remedy is to ask again.
 *
 * **It never completes a stage.** There is no stage, so there is no verdict, no transition and no
 * interpreter call. `run.finished` is the only pipeline event an ask produces, which is what carries
 * its cost into the ledger exactly like any other run's (criterion 9).
 */
import type {
  AskAnswerCitation,
  AskAnswerData,
  ContextPackRecord,
  DomainEvent,
  Id,
  JsonValue,
} from '@platform/contracts';
import {
  askAnswerDataSchema,
  MAX_ASK_CITATION_DETAIL_CHARS,
  MAX_ASK_CITATION_REFERENCE_CHARS,
  MAX_ASK_UNANSWERED_CHARS,
} from '@platform/contracts';
import type { CommandContext, Run } from '@platform/domain';
import {
  ASK_ROLE,
  createRun,
  failRun,
  finishRun,
  MAX_ASK_ANSWER_CHARS,
  markRunning,
  startRun,
} from '@platform/domain';
import {
  ArtifactIdentifierSecretError,
  findArtifactIdentifierSecret,
} from '../artifacts/redaction.js';
import { type BudgetGuard, noBudgetGuard } from '../cost/guard.js';
import { composeSecretRedactors } from '../integrations/redaction.js';
import {
  leaseExpiryAt,
  RUN_LEASE_TTL_MS,
  type RunLeaseOptions,
  startRunHeartbeat,
} from '../pipeline/lease.js';
import { injectedSecretRedactorFor } from '../pipeline/run-redaction.js';
import type { ProjectSettings } from '../pipeline/settings.js';
import type { RunStopReasons } from '../pipeline/stop-reasons.js';
import type { PipelineStore, StoredTask } from '../pipeline/store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { ClaudeRunner, RunOutcome } from '../ports/runner.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import {
  ASK_RECORD_AUDIT_LIMIT,
  ASK_RECORD_RUN_LIMIT,
  type AskRunPlan,
  type AskRunPlanner,
} from './planner.js';
import { askFeature } from './settings.js';
import type { AskStore, StoredAsk } from './store.js';

/** `task.ask` job payload — snake_case, like every other payload on the wire. */
export interface AskExecuteData {
  readonly ask_id: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly [key: string]: unknown;
}

export type AskExecutionOutcome =
  /** The run happened and its answer is stored. */
  | { readonly kind: 'answered'; readonly askId: Id; readonly runId: Id }
  /** Nothing to do: the ask is gone or has already been answered (a duplicate wake-up). */
  | { readonly kind: 'skipped'; readonly reason: string }
  /** Admission said no; the ask row says why, and no run was created. */
  | { readonly kind: 'refused'; readonly askId: Id; readonly reason: string }
  /** A run happened and produced nothing usable; the ask row says so. */
  | { readonly kind: 'failed'; readonly askId: Id; readonly reason: string };

export interface AskExecutorOptions {
  readonly unitOfWork: UnitOfWork;
  readonly asks: AskStore;
  readonly store: PipelineStore;
  readonly runner: ClaudeRunner;
  readonly planner: AskRunPlanner;
  readonly stopReasons: RunStopReasons;
  readonly settings: (projectId: Id) => Promise<ProjectSettings>;
  readonly context: (correlationId: Id) => CommandContext;
  /** The organisation and project caps (BD-010), asked in the admission transaction like a stage. */
  readonly budgets?: BudgetGuard;
  /**
   * TD-012 step 2 over what the model wrote.
   *
   * Required and not defaulted: the answer is stored, published on a read endpoint and — when the
   * project asked for it — posted into somebody else's ticket tracker, and an optional redactor is
   * an absent one (standing rule 31). The composition root passes the same pattern redactor
   * `routes/commands.ts` gets.
   */
  readonly redactor: SecretRedactor;
  /** How the thread labels the asker; the composition root resolves a display name. */
  readonly askedByLabel: (userId: Id) => Promise<string>;
  /**
   * Where the ticket mirror is enqueued — `pipeline.outbound`, duty `ask_answer` (WP-31).
   *
   * The executor **decides** and the duty **calls**, which is WP-15d's rule and is refused
   * mechanically on both paths (`events/open-transaction.ts`). The enqueue happens after the
   * answer's transaction has committed, for the reason `HandlerContext.afterCommit` exists:
   * `Jobs.enqueue` does not join a transaction, so an enqueue written inside one is durable even
   * when the write rolls back.
   */
  readonly jobs: Jobs;
  /**
   * The run **lease** this process holds while an ask is in flight (WP-48, PROGRESS backlog 120).
   *
   * An ask's run is an ordinary `runs` row started by a different composition from the stage
   * executor's, and until this option it claimed no lease — so the only thing that could ever end
   * it was the sweep's **wall-clock backstop**, about an hour rather than about six minutes. For
   * that hour the row held a reservation valued at the *admitting* caller's reserve, which is up to
   * $15 when the next admission is an implementation stage rather than another question.
   *
   * **Absent is "this process claims no lease"**, which is what every build before WP-48 did: the
   * run is still swept, by the backstop, which is also what covers every `runs` row written before
   * migration 0035. The composition root passes the **same** `RunLeaseOptions` the stage executor
   * gets, so one process has one owner string (`createPipelineRuntime`).
   */
  readonly lease?: RunLeaseOptions;
  readonly logger?: Logger;
}

export interface AskExecutor {
  execute(job: AskExecuteData): Promise<AskExecutionOutcome>;
}

/**
 * Has this task spent its cap, counting what the ask is about to spend?
 *
 * The same comparison `taskBudgetExhausted` makes for a stage and for the same reason — a cap
 * checked only against past spend is a cap discovered one run too late — with the ask's own
 * per-question figure as the "about to spend" term. Exported so criterion 9's *"at the cap and one
 * unit under it"* can be asserted directly rather than through a run.
 */
export const askBudgetExhausted = (
  stored: StoredTask,
  settings: ProjectSettings,
  askBudgetUsd: number,
): boolean => stored.costActualUsd + askBudgetUsd > settings.taskBudgetUsd;

/**
 * Citations that resolve **inside this task**, and how many did not (product/11:30, criterion 6).
 *
 * A model may name a run id or an artifact version that belongs to another task or another project.
 * The entry is **dropped** rather than the whole answer refused, and that asymmetry is deliberate
 * (standing rule 20): refusing the answer throws away a run the project paid for and loses the
 * ninety per cent of it that was right, while dropping one citation costs the claim it supported and
 * is visible — `droppedCitations` is counted, stored and published.
 *
 * A `knowledge` or `audit` citation is kept: the first names a vault path, which retrieval already
 * scoped to this project, and the second names a `human_actions` row the ask was shown from this
 * task's own audit block.
 */
export const scopeCitations = (
  citations: readonly AskAnswerCitation[],
  known: { readonly runIds: ReadonlySet<string>; readonly auditIds: ReadonlySet<string> },
): { readonly kept: readonly AskAnswerCitation[]; readonly dropped: number } => {
  const kept = citations.filter((citation) => {
    if (citation.kind === 'run') {
      return typeof citation.run_id === 'string' && known.runIds.has(citation.run_id);
    }
    if (citation.kind === 'audit') {
      return typeof citation.reference === 'string' && known.auditIds.has(citation.reference);
    }
    return true;
  });
  return { kept, dropped: citations.length - kept.length };
};

/**
 * Every model-authored string the answer carries, redacted and then cut (WP-31 round 2).
 *
 * **Which strings, and why it is all of them.** `answer` was the only one that passed the redactor
 * until this round, and it is not the only one that is published: `citations[].detail` and
 * `citations[].reference` are stored in `task_asks.citations` **and** in `artifacts.data`, served by
 * `GET /api/tasks/:id/asks`, rendered by the thread, and — for a `knowledge` or an `audit` citation
 * — written into somebody else's ticket tracker by the mirror duty (`renderAskComment`);
 * `unanswered[]` is stored and published the same way. A redactor applied to one of four fields is
 * a redactor whose `redaction_count` under-reports the row it sits beside, which is the one signal
 * a redactor that stopped working would leave (migration 0024's note).
 *
 * **Which are deliberately left alone, so the omission is a decision.** `run_id`, `artifact_type`
 * and `version` are not free text and `run_id` is a **key**: the thread builds the link to a run
 * from it and {@link scopeCitations} has already checked it against this task's own runs, so
 * redacting it would trade a leak that cannot exist for a link that resolves to nothing (standing
 * rule 70). `kind` and `confidence` are enums the contract fixes.
 *
 * **WP-52 changed none of that, and the check it added is why.** TD-012's WP-52 amendment makes an
 * *identifier* — a field the platform **addresses something with** — refused rather than rewritten,
 * and the shared table (`ARTIFACT_FIELD_POLICIES.AskAnswer`) declares exactly one for this type:
 * `citations[].run_id`, which is the paragraph above turned into data that a check keeps complete.
 * `reference` stays **prose** and keeps passing the redactor, because the worst a redacted one
 * produces is a citation that points nowhere, while refusing it would fail a whole ask over a
 * citation — and an `audit` reference has already been *dropped* by {@link scopeCitations} if it is
 * not one of this task's own rows. What the amendment adds here is the refusal above: an identifier
 * carrying an injected secret ends the ask by name instead of storing a rewritten key.
 *
 * **Redact, then cut — in that order, and the cut is not optional.** WP-30 measured the order: a
 * truncation applied first can publish `glpat-FAKE`, a prefix no rule matches, while redacting
 * first publishes the placeholder and cuts *that*. The cut afterwards is what keeps the row
 * publishable — a placeholder is often longer than the value it replaced, so a `detail` that
 * arrived exactly at `MAX_ASK_CITATION_DETAIL_CHARS` comes out of the redactor past it and the read
 * endpoint's own response schema would refuse to serialise the thread.
 *
 * The count is the **sum** over every field, which is what `task_asks.redaction_count` adds to the
 * question's own count.
 */
export const redactAskAnswer = (
  answer: AskAnswerData,
  citations: readonly AskAnswerCitation[],
  redactor: SecretRedactor,
): { readonly data: AskAnswerData; readonly count: number } => {
  // The identifier half of the artifact policy, asked of the **same** table the stage executor
  // asks, over the citations that survived scoping.
  const offending = findArtifactIdentifierSecret(
    'AskAnswer',
    { ...answer, citations: [...citations] } as unknown as JsonValue,
    redactor,
  );
  if (offending !== null) {
    throw new ArtifactIdentifierSecretError('AskAnswer', offending);
  }
  let count = 0;
  const clean = (value: string, cap: number): string => {
    const redacted = redactor.redactText(value);
    count += redacted.count;
    return redacted.value.slice(0, cap);
  };
  const data: AskAnswerData = {
    answer: clean(answer.answer, MAX_ASK_ANSWER_CHARS),
    citations: citations.map((citation) => ({
      ...citation,
      detail: clean(citation.detail, MAX_ASK_CITATION_DETAIL_CHARS),
      // Only when there is one: `reference` is `nullish`, and writing `null` over an absent key
      // would change the shape of the row for a `run` citation that never had it.
      ...(typeof citation.reference === 'string'
        ? { reference: clean(citation.reference, MAX_ASK_CITATION_REFERENCE_CHARS) }
        : {}),
    })),
    unanswered: answer.unanswered.map((line) => clean(line, MAX_ASK_UNANSWERED_CHARS)),
    confidence: answer.confidence,
  };
  return { data, count };
};

export const createAskExecutor = (options: AskExecutorOptions): AskExecutor => {
  const logger = options.logger ?? silentLogger;
  const budgets = options.budgets ?? noBudgetGuard;

  /**
   * The five questions admission asks, in one place because **they are asked twice** (WP-31 round 2).
   *
   * TD-004's rule is that a job re-validates on fire, and the stage executor's `revalidate` is the
   * same idea one level over: the prompt is assembled with **no transaction open**, so everything
   * these questions read can move while it is being built. Until this round only the first two were
   * re-asked, and the gap was measurable rather than theoretical — a stage that commits its spend
   * during retrieval let an ask start and run up to `features.ask.budget_usd` **past** the task cap
   * it had just been checked against, because `cost_actual` is exactly the column a stage finishing
   * beside an ask increments (`TaskRepository.addSpend`).
   *
   * It answers a verdict rather than writing one: `skipped` writes nothing (there is nothing to
   * write on), `refused` is written by the caller through {@link refuse}, so both call sites
   * produce the same row for the same reason and neither can drift into writing a different one.
   * `settings` is the caller's, read once outside the transaction: a project that changed its
   * configuration mid-retrieval is not what this guards, and a second read would be a second
   * connection's worth of work for a value the run was planned against.
   */
  const admissionVerdict = async (
    scope: TransactionScope,
    askId: Id,
    settings: ProjectSettings,
  ): Promise<
    | { readonly kind: 'skipped'; readonly reason: string }
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'ok'; readonly ask: StoredAsk; readonly task: StoredTask }
  > => {
    const feature = askFeature(settings);
    const ask = await options.asks.load(scope.tx, askId);
    if (ask === null) {
      return { kind: 'skipped', reason: 'the ask no longer exists' };
    }
    // A job is a wake-up, not a message (TD-004): a second delivery finds the ask answered. On the
    // second asking this is also "another worker answered it while this one built a prompt".
    if (ask.status !== 'pending') {
      return { kind: 'skipped', reason: `the ask is already "${ask.status}"` };
    }
    const task = await options.store.tasks.load(scope.tx, ask.taskId);
    if (task === null) {
      return { kind: 'refused', reason: 'the task no longer exists' };
    }
    if (!feature.enabled) {
      return {
        kind: 'refused',
        reason: 'this project has turned ask-the-task off (`features.ask.enabled`)',
      };
    }
    if (askBudgetExhausted(task, settings, feature.budgetUsd)) {
      return {
        kind: 'refused',
        reason:
          `the task has spent ${task.costActualUsd} USD of its ${settings.taskBudgetUsd} USD cap ` +
          `and one question may spend ${feature.budgetUsd} more`,
      };
    }
    /**
     * BD-010's organisation and project caps, asked exactly where a stage asks them.
     *
     * An ask is a *new* run, so *"prevents new runs; running runs finish"* applies to it
     * unchanged — and criterion 1 asks for this case to be asserted by reading `cost_entries`
     * rather than a status code, which is what a refusal before any run exists guarantees: there
     * is no entry to read.
     */
    const blocker = await budgets.blockingFor(
      scope.tx,
      ask.projectId,
      options.context(ask.id).clock.now(),
      // What *this* run may spend, which is what the guard puts on a run of the scope that is live
      // and therefore not in the ledger yet (`../cost/pending.ts`). For an ask it is the
      // per-question budget rather than a stage's — the same figure `askBudgetExhausted` uses.
      feature.budgetUsd,
    );
    if (blocker !== null) {
      return {
        kind: 'refused',
        reason:
          `the ${blocker.scope} budget for this ${blocker.window} is exhausted: ` +
          `${blocker.spentUsd} of ${blocker.limitUsd} USD since ${blocker.windowStart}` +
          (blocker.pendingUsd > 0
            ? `, plus ${blocker.pendingUsd} committed by runs the ledger has not recorded yet`
            : ''),
      };
    }
    return { kind: 'ok', ask, task };
  };

  /** tx 1a: may this ask run, and what does the planner need? */
  const admit = async (
    job: AskExecuteData,
  ): Promise<
    | { readonly kind: 'skipped' | 'refused'; readonly reason: string }
    | {
        readonly kind: 'ready';
        readonly ask: StoredAsk;
        readonly task: StoredTask;
        readonly settings: ProjectSettings;
        readonly runs: Awaited<ReturnType<AskStore['runsForTask']>>;
        readonly audit: Awaited<ReturnType<AskStore['auditForTask']>>;
        readonly artifacts: Awaited<ReturnType<PipelineStore['artifacts']['listFor']>>;
      }
  > => {
    const settings = await options.settings(job.project_id as Id);
    return options.unitOfWork.transaction(async (scope) => {
      const verdict = await admissionVerdict(scope, job.ask_id as Id, settings);
      if (verdict.kind === 'skipped') {
        return verdict;
      }
      if (verdict.kind === 'refused') {
        return await refuse(scope, job.ask_id as Id, verdict.reason);
      }
      const { ask, task } = verdict;
      return {
        kind: 'ready' as const,
        ask,
        task,
        settings,
        runs: await options.asks.runsForTask(scope.tx, ask.taskId, ASK_RECORD_RUN_LIMIT),
        audit: await options.asks.auditForTask(scope.tx, ask.taskId, ASK_RECORD_AUDIT_LIMIT),
        artifacts: await options.store.artifacts.listFor(scope.tx, ask.taskId),
      };
    });
  };

  const refuse = async (
    scope: TransactionScope,
    askId: Id,
    reason: string,
  ): Promise<{ readonly kind: 'refused'; readonly reason: string }> => {
    await options.asks.recordRefusal(scope.tx, { askId, status: 'refused', reason });
    return { kind: 'refused', reason };
  };

  /**
   * tx 1b: create the run, now that the prompt exists.
   *
   * It re-asks **all** of {@link admissionVerdict}'s questions, not just "is it still pending" —
   * the pack was assembled with no transaction open, and in that window a second worker can answer
   * the ask, a stage can commit its spend past the task cap, an organisation budget can be
   * exhausted by another project's run, and the task can be deleted. Finding that one of them moved
   * is a success, exactly as it is in 1a: the work thrown away is one retrieval, and the
   * alternative is a paid run the caps had already refused.
   */
  const startTheRun = async (
    ask: StoredAsk,
    plan: AskRunPlan,
    runId: Id,
    settings: ProjectSettings,
  ): Promise<
    | { readonly kind: 'started'; readonly run: Run; readonly redactor: SecretRedactor }
    | { readonly kind: 'skipped'; readonly reason: string }
    | { readonly kind: 'refused'; readonly reason: string }
  > =>
    options.unitOfWork.transaction(async (scope) => {
      const verdict = await admissionVerdict(scope, ask.id, settings);
      if (verdict.kind === 'skipped') {
        return verdict;
      }
      if (verdict.kind === 'refused') {
        return await refuse(scope, ask.id, verdict.reason);
      }
      const context = options.context(ask.taskId);
      /**
       * The run's own TD-012 redactor and the two prompt columns (Q64, WP-52) — the stage
       * executor's rule at the second `runs.insert` call site, which standing rule 49 is the reason
       * this row swept for.
       *
       * Composed with `options.redactor` (TD-012 step 2, the pattern rules) because an ask's
       * *answer* already passes that one: the prompt is model input rather than model output, but
       * it carries the ticket's own words and the context pack, so it gets both halves rather than
       * the weaker of the two. **Step 1 first**, which is TD-012's own order and
       * `createClaudeRunner`'s — it decides which placeholder an injected credential ends up
       * carrying, and `[REDACTED:integration:anthropic_api_key]` names the credential while
       * `[REDACTED sha256:…]` does not.
       */
      const runRedactor = composeSecretRedactors(
        injectedSecretRedactorFor(plan.spec, logger),
        options.redactor,
      );
      const systemPrompt = runRedactor.redactText(plan.spec.systemPromptAppend);
      const userPrompt = runRedactor.redactText(plan.spec.userPrompt);
      const created = createRun({
        id: runId,
        taskId: ask.taskId,
        projectId: ask.projectId,
        // Criterion 1, in the aggregate rather than only in the column.
        stage: null,
        role: ASK_ROLE,
        mode: plan.spec.mode,
        attempt: 1,
        model: plan.spec.model,
        effort: plan.spec.effort,
        promptVersion: plan.spec.promptVersion,
      });
      const starting = startRun(created, context);
      const running = markRunning(
        starting.aggregate,
        { contextPack: plan.contextPack satisfies ContextPackRecord },
        context,
      );
      await options.store.runs.insert(scope.tx, {
        id: runId,
        taskId: ask.taskId,
        projectId: ask.projectId,
        stage: null,
        role: ASK_ROLE,
        mode: plan.spec.mode,
        attempt: 1,
        model: plan.spec.model,
        effort: plan.spec.effort,
        promptVersion: plan.spec.promptVersion,
        status: running.aggregate.status,
        terminalReason: null,
        sessionId: null,
        numTurns: 0,
        usage: null,
        cost: null,
        wallMs: 0,
        createdAt: context.clock.now(),
        startedAt: context.clock.now(),
        systemPrompt: systemPrompt.value,
        userPrompt: userPrompt.value,
        redactionCount: systemPrompt.count + userPrompt.count,
      });
      /**
       * The lease, claimed in the **same transaction as the row** — the stage executor's rule and
       * its reason, one composition across (WP-48): a `runs` row that is `running` with no lease is
       * exactly the row the sweep's wall-clock backstop takes an hour to reach.
       */
      if (options.lease !== undefined) {
        await options.store.runs.renewLease(scope.tx, {
          runId,
          owner: options.lease.owner,
          expiresAt: leaseExpiryAt(context.clock.now(), options.lease.ttlMs ?? RUN_LEASE_TTL_MS),
        });
      }
      await options.asks.attachRun(scope.tx, ask.id, runId);
      await scope.events.append([...starting.events, ...running.events]);
      return { kind: 'started' as const, run: running.aggregate, redactor: runRedactor };
    });

  /** tx 2: the answer, the artifact, the spend and the run's ending, in one write. */
  const record = async (input: {
    readonly ask: StoredAsk;
    readonly run: Run;
    readonly outcome: RunOutcome;
    readonly stopReason: string | null;
    /**
     * The run's own redactor — `options.redactor` (TD-012 step 2) composed with the injected-secret
     * redactor built from this run's spec (step 1), which {@link startTheRun} also used for the two
     * prompt columns. One construction per run, so the prompt, the answer and the transcript cannot
     * name different secrets.
     */
    readonly redactor: SecretRedactor;
    readonly knownRunIds: ReadonlySet<string>;
    readonly knownAuditIds: ReadonlySet<string>;
  }): Promise<AskExecutionOutcome> =>
    options.unitOfWork.transaction(async (scope) => {
      const { ask, run, outcome } = input;
      const context = options.context(ask.taskId);
      const spent = Number.isFinite(outcome.cost.usd) ? Math.max(0, outcome.cost.usd) : 0;

      const parsed =
        outcome.status === 'completed' && outcome.structuredOutput !== null
          ? askAnswerDataSchema.safeParse(outcome.structuredOutput)
          : null;

      /**
       * Scope, then redact — **before** the ending is chosen, so that TD-012's identifier refusal
       * has somewhere to land (WP-52).
       *
       * Scoping first because `run_id` and an `audit` `reference` are the keys the check is made
       * of: a redacted key would answer one row's citation with another's, or with none (standing
       * rule 70). Redaction then runs over what survived — and if it *refuses*, the ask ends as a
       * failure with the field named, rather than throwing out of the transaction and leaving the
       * run `running` and the ask `pending` for the lease sweep to find an hour later.
       */
      let refusedPath: string | null = null;
      const prepared = ((): {
        readonly safe: ReturnType<typeof redactAskAnswer>;
        readonly dropped: number;
      } | null => {
        if (parsed === null || !parsed.success) return null;
        const { kept, dropped } = scopeCitations(parsed.data.citations, {
          runIds: input.knownRunIds,
          auditIds: input.knownAuditIds,
        });
        try {
          return { safe: redactAskAnswer(parsed.data, kept, input.redactor), dropped };
        } catch (error) {
          if (!(error instanceof ArtifactIdentifierSecretError)) {
            throw error;
          }
          refusedPath = error.path;
          return null;
        }
      })();

      if (prepared === null) {
        const reason =
          refusedPath !== null
            ? // The **path**, never the value: this string is stored on the ask row, published by
              // `GET /api/tasks/:id/asks` and rendered in the thread.
              `the answer put a secret this run was given in "${refusedPath}", which the platform ` +
              'reads as an identifier and therefore refuses to rewrite'
            : outcome.status === 'completed'
              ? 'the run produced no answer the AskAnswer contract accepts'
              : `the run ended "${outcome.status}"${input.stopReason === null ? '' : ` (${input.stopReason})`}`;
        const failed = failRun(
          run,
          {
            // `failRun` takes the two statuses a *failure* may end in. Every other terminal
            // status — cancelled, budget_exceeded, timed_out — is reported through the same
            // `run.failed` path with the aggregate's own `failed`, because for an ask there is no
            // second ending: nothing transitions on it, and the ask row carries the real reason.
            status: outcome.status === 'stalled' ? 'stalled' : 'failed',
            terminalReason: outcome.terminalReason,
            // The redactor, because `RunOutcome.error` is the runner's own text about a failure and
            // this string is written to `events.payload` (`run.failed`) and to the ask row.
            error: options.redactor.redactText(outcome.error ?? reason).value,
            // Not `outcome.usage === null ? {} : …`: `RunOutcome.usage` and `.cost` are required by
            // the port, so the guard the stage executor writes here would be a branch the type
            // forbids — and therefore one no test can reach (standing rule 22).
            usage: outcome.usage,
            cost: outcome.cost,
          },
          context,
        );
        const owned = await options.store.runs.finish(scope.tx, {
          runId: run.id,
          status: failed.aggregate.status,
          terminalReason: outcome.terminalReason,
          sessionId: outcome.sessionId,
          numTurns: outcome.numTurns,
          usage: outcome.usage,
          cost: outcome.cost,
          wallMs: outcome.wallMs,
        });
        if (!owned) {
          return { kind: 'skipped' as const, reason: 'another writer ended this run first' };
        }
        // The spend is recorded even for a failed ask: it is the platform's own record of money
        // (the stage executor's rule, and the reason the cap cannot be walked around by failing).
        await options.store.tasks.addSpend(scope.tx, ask.taskId, spent);
        await options.asks.recordRefusal(scope.tx, {
          askId: ask.id,
          status: 'failed',
          reason,
        });
        await scope.events.append([...failed.events] as DomainEvent[]);
        return { kind: 'failed' as const, askId: ask.id, reason };
      }

      const { safe, dropped } = prepared;

      const finished = finishRun(
        run,
        {
          status: 'completed',
          terminalReason: outcome.terminalReason,
          usage: outcome.usage,
          modelUsage: outcome.modelUsage,
          cost: outcome.cost,
          numTurns: outcome.numTurns,
        },
        context,
      );
      const owned = await options.store.runs.finish(scope.tx, {
        runId: run.id,
        status: 'completed',
        terminalReason: outcome.terminalReason,
        sessionId: outcome.sessionId,
        numTurns: outcome.numTurns,
        usage: outcome.usage,
        cost: outcome.cost,
        wallMs: outcome.wallMs,
      });
      if (!owned) {
        return { kind: 'skipped' as const, reason: 'another writer ended this run first' };
      }

      /**
       * The answer is a real `artifacts` row — versioned, attached to the run that produced it —
       * which is what makes a citation to it resolve through the read endpoints WP-15h shipped.
       *
       * What it is **not** is a `recordArtifact` on the Task aggregate: that would write the `tasks`
       * row from a process that runs beside the stage executor, which is the lost update WP-15e
       * closed. So there is no `artifact.created` event for an ask, and the audit's record of it is
       * the `run.finished` above plus the row itself. `PROMPT_EXCLUDED_ARTIFACT_TYPES` is what keeps
       * it out of a later stage's prompt.
       */
      const version = await options.store.artifacts.nextVersion(scope.tx, ask.taskId, 'AskAnswer');
      const artifactId = context.ids.next();
      await options.store.artifacts.insert(scope.tx, {
        id: artifactId,
        taskId: ask.taskId,
        type: 'AskAnswer',
        version,
        markdown: null,
        data: safe.data,
        schemaVersion: '1',
        producedByRunId: run.id,
        // The same number the ask row records, and for the same reason: it is the sum over every
        // model-authored string in the answer, not the `answer` field's alone (WP-52 wires it to
        // `artifacts.redaction_count`, which had no column at all before migration 0038).
        redactionCount: safe.count,
        createdAt: context.clock.now(),
      });
      await options.store.tasks.addSpend(scope.tx, ask.taskId, spent);
      await options.asks.recordAnswer(scope.tx, {
        askId: ask.id,
        answer: safe.data.answer,
        citations: safe.data.citations,
        droppedCitations: dropped,
        answerArtifactId: artifactId,
        // The sum over every model-authored string, not the answer's alone: a count that named one
        // of four fields would read as "nothing else needed redacting" (see {@link redactAskAnswer}).
        redactionCount: safe.count,
        answeredAt: context.clock.now(),
      });
      await scope.events.append([...finished.events] as DomainEvent[]);
      return { kind: 'answered' as const, askId: ask.id, runId: run.id };
    });

  return {
    execute: async (job: AskExecuteData): Promise<AskExecutionOutcome> => {
      const admitted = await admit(job);
      if (admitted.kind !== 'ready') {
        logger.info(
          {
            ask_id: job.ask_id,
            task_id: job.task_id,
            outcome: admitted.kind,
            reason: admitted.reason,
          },
          'an ask did not start',
        );
        return admitted.kind === 'skipped'
          ? { kind: 'skipped', reason: admitted.reason }
          : { kind: 'refused', askId: job.ask_id as Id, reason: admitted.reason };
      }

      const runId = options.context(admitted.ask.taskId).ids.next();
      const plan = await options.planner.plan({
        runId,
        ask: admitted.ask,
        task: admitted.task,
        settings: admitted.settings,
        artifacts: admitted.artifacts,
        runs: admitted.runs,
        audit: admitted.audit,
        askedByLabel: await options.askedByLabel(admitted.ask.askedByUserId),
      });

      const started = await startTheRun(admitted.ask, plan, runId, admitted.settings);
      if (started.kind !== 'started') {
        logger.info(
          {
            ask_id: admitted.ask.id,
            task_id: admitted.ask.taskId,
            outcome: started.kind,
            reason: started.reason,
          },
          'an ask did not start after its prompt was built',
        );
        return started.kind === 'skipped'
          ? { kind: 'skipped', reason: started.reason }
          : { kind: 'refused', askId: admitted.ask.id, reason: started.reason };
      }

      let outcome: RunOutcome;
      /**
       * The heartbeat runs for exactly as long as the session does (WP-48).
       *
       * Started **after** the run's own transaction has committed and **awaited to a stop** before
       * either ending opens one of its own — the stage executor's shape and its reason: a beat is
       * fired and forgotten so it can never block the run, so clearing the timer alone would leave
       * at most one narrow `update` borrowing a connection beside the ending's transaction.
       */
      const stopHeartbeat =
        options.lease === undefined
          ? async (): Promise<void> => {}
          : startRunHeartbeat(
              {
                unitOfWork: options.unitOfWork,
                store: options.store,
                clock: { now: () => options.context(admitted.ask.taskId).clock.now() },
                lease: options.lease,
                ...(options.logger === undefined ? {} : { logger: options.logger }),
              },
              runId,
            );
      try {
        const handle = options.runner.start(plan.spec);
        outcome = await handle.outcome;
      } catch (error) {
        await stopHeartbeat();
        options.stopReasons.forget(runId);
        // The **class name**, never the message: it is written to `events.payload` and to the ask
        // row, and neither passes a redactor at the point it is read (the stage executor's rule).
        const reason = `the runner could not start this ask: ${error instanceof Error ? error.name : 'unknown error'}`;
        logger.error({ err: error, ask_id: admitted.ask.id, run_id: runId }, reason);
        return await options.unitOfWork.transaction(async (scope) => {
          const failed = failRun(
            started.run,
            { status: 'failed', terminalReason: 'error_during_execution', error: reason },
            options.context(admitted.ask.taskId),
          );
          await options.store.runs.finish(scope.tx, {
            runId,
            status: 'failed',
            terminalReason: 'error_during_execution',
            sessionId: null,
            numTurns: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_write_5m_tokens: 0,
              cache_write_1h_tokens: 0,
              cache_read_tokens: 0,
            },
            cost: { usd: 0, is_estimate: false },
            wallMs: 0,
          });
          await options.asks.recordRefusal(scope.tx, {
            askId: admitted.ask.id,
            status: 'failed',
            reason,
          });
          await scope.events.append([...failed.events] as DomainEvent[]);
          return { kind: 'failed' as const, askId: admitted.ask.id, reason };
        });
      }
      await stopHeartbeat();
      const stopReason = options.stopReasons.reasonFor(runId);
      options.stopReasons.forget(runId);

      const recorded = await record({
        ask: admitted.ask,
        run: started.run,
        outcome,
        stopReason,
        redactor: started.redactor,
        knownRunIds: new Set(admitted.runs.map((line) => line.runId)),
        knownAuditIds: new Set(admitted.audit.map((line) => line.id)),
      });
      if (recorded.kind === 'answered') {
        await options.jobs.enqueue({
          queue: JOB_QUEUES.pipelineOutbound,
          data: {
            duty: 'ask_answer',
            project_id: admitted.ask.projectId,
            task_id: admitted.ask.taskId,
            ask_id: recorded.askId,
            // The run that produced the answer is the cause: an ask has no event of its own, and
            // the duty's replay identity is the ask's id rather than this.
            cause_event_id: recorded.runId,
          },
        });
      }
      return recorded;
    },
  };
};
