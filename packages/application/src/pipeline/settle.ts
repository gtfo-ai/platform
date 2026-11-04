/**
 * `settleRun` — the stage executor's **transaction 2** as an application command (WP-275, TD-031
 * decision 3).
 *
 * Everything a run produced is written here, once: the artifact (validated and redacted,
 * `../artifacts/redaction.ts`), the run's terminal row and event (`finishRun`/`failRun` through the
 * fenced `RunRepository.finish`, which closes the run's offer), the task's spend, the stage's
 * completion, a shutdown hand-back, an escalation or a budget pause. The functions are the ones
 * `stage-executor.ts` held until WP-275 — `record`, `recordUnsuccessful`, `recordHandBack`,
 * `escalateOnRun`, `lostTheRun`, `recordOntoStoppedTask` — moved without a change of behaviour, and
 * the `stage.execute` job now calls {@link settleRun} where it called `record` inside its own
 * `writing`. Transaction 1, the plan and the session stay the job's; WP-276 moves the session out of
 * the job, and its claimant calls this command in process (a remote worker reaches it over HTTP,
 * WP-281).
 *
 * ## Idempotent on `(run_id, epoch)`
 *
 * The command's first statement locks the run row (`RunRepository.lockSettlement`, `for update`),
 * and two questions decide what it does, both answered before anything is written:
 *
 * 1. **Is the row under this settle's claim?** `lease_epoch` and `lease_owner` must be the fence the
 *    claim granted. Otherwise the answer is `lease_lost`: {@link LeaseLostError} is thrown before any
 *    write, so nothing changes — in PostgreSQL *and* in the memory store, whose unit of work keeps
 *    the writes a failed transaction made (backlog 698): there are none to keep. A stale epoch is
 *    `lease_lost` whether the row is still live under the newer claim or already ended by it.
 * 2. **Has the row already ended?** Then this is a repeat — the same settle delivered twice (a
 *    retried job, a worker's re-sent `finish`), or another writer that ended the run at this epoch (a
 *    person's cancel ended in place, the lease sweep). Either way the ending stands and this command
 *    appends **nothing**: it answers `already_settled` with the **stored result**. It needs no branch
 *    of its own to do so. Every path of transaction 2 makes the conditional `finish` its **first
 *    write**, `finish` answers `false` for a row that has ended, and the loser then takes
 *    `lostTheRun` — which appends no event and writes a late cost only where the row carries no
 *    figure and the ledger has not charged the run (Q70 (b)), so a repeat of a settle that recorded
 *    a figure writes nothing at all. That is the path transaction 2 already had, unchanged.
 *
 * **Where the stored result lives**, without a migration: on the run row. `status`,
 * `terminal_reason` and `lease_epoch` are what the first settle's `finish` left there, and
 * {@link RunEnding} is exactly those, read under the lock after the transaction's writes — by the
 * first settle and by every repeat alike, so the answers are one read of one row and cannot
 * disagree. What is **not** stored is the job's own {@link StageExecutionOutcome} (`ran` with its
 * verdict, `paused`, `handed_back`…): a repeat answers the stored ending beside the `skipped`
 * outcome transaction 2 always gave a row it found ended, so nothing a repeat answers re-enqueues or
 * re-decides anything.
 *
 * The lock is what makes the answer exact under concurrency in PostgreSQL: a second settle of the
 * same run waits on the first one's row lock, then finds the row ended at its `finish`. Which answer
 * a settle gives is read off `lostTheRun`'s marked result, never off a second spelling of it.
 */
import type {
  ArtifactRef,
  DomainEvent,
  Id,
  JsonValue,
  MergeRequestRef,
  RunCost,
  RunSavedWork,
  RunStartFailure,
  RunStatus,
  RunTerminalReason,
  Slug,
  TokenUsage,
} from '@platform/contracts';
import { stageVerdictSchema } from '@platform/contracts';
import type { CommandContext, PipelineStage, Run } from '@platform/domain';
import {
  askQuestion,
  completeStage,
  escalateTask,
  failRun,
  finishRun,
  isActiveRunStatus,
  isCurrentStageAttempt,
  isRunnableTaskState,
  openQuestion,
  pauseTask,
  recordArtifact,
  toQuestionRecord,
} from '@platform/domain';
import {
  ArtifactIdentifierSecretError,
  type RedactedArtifact,
  redactArtifactData,
} from '../artifacts/redaction.js';
import { noLateCostRecorder } from '../cost/late.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { RunOutcome } from '../ports/runner.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { questionDeadlineRule } from './deadline-rules.js';
import type { ProjectSettings } from './settings.js';
import type {
  AppliedChecklistRecord,
  StageExecutionJob,
  StageExecutionOutcome,
  StageExecutorOptions,
} from './stage-executor.js';
import { revalidate } from './stage-revalidation.js';
import {
  LeaseLostError,
  type RunLeaseFence,
  type RunSettlement,
  type StoredTask,
} from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';
import { savedWorkSentence } from './unfinished-work.js';
import { artifactQuestions, rawVerdict, stageVerdict } from './verdicts.js';

/**
 * The slice of the executor's composition transaction 2 reads: the store, a command context per
 * task, the calendar a blocking question's deadline is computed on, and the late-cost port.
 */
export type SettleOptions = Pick<
  StageExecutorOptions,
  'store' | 'context' | 'calendar' | 'lateCost'
>;

/**
 * How many times one stage entry may be **handed back** by a `runner` stop before the next stop
 * escalates it (WP-144 ruling (b)): two. An upgrade or a restart in the middle of a run is the
 * ordinary case and costs nothing but the interrupted work; a third stop of the same entry is a
 * process that keeps being stopped under one stage, and a person is told, with a brief naming the
 * stops. Counted from the entry's runs' end reasons (`RunRepository.shutdownEndings`), not a column.
 */
export const MAX_SHUTDOWN_HAND_BACKS = 2;

/** The name WP-12 puts on `run_stopped.data.reason` when the CLI reported no usable cost. */
export const COST_UNREPORTED = 'cost_unreported';

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

export interface RecordInput {
  readonly job: StageExecutionJob;
  readonly settings: ProjectSettings;
  readonly stage: PipelineStage;
  readonly run: Run;
  readonly outcome: RunOutcome;
  readonly stopReason: string | null;
  readonly options: SettleOptions;
  /** The run's own redactor — TD-012 at the artifact write (WP-52). */
  readonly redactor: SecretRedactor;
  /** What the planner gave a Reviewer run, or `null` when it recorded nothing (WP-45). */
  readonly reviewChecklists: readonly AppliedChecklistRecord[] | null;
  /** The claim's fence (WP-274): the run's `finish` is conditional on it. */
  readonly fence: RunLeaseFence;
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
    lease: input.fence,
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
export const lostTheRun = async (input: {
  readonly run: Run;
  readonly outcome?: RunOutcome;
  readonly options: SettleOptions;
  readonly scope: TransactionScope;
  /** The transcript's stop reason — a `cost_unreported` outcome's cost is a floor (407). */
  readonly stopReason?: string | null;
}): Promise<StageExecutionOutcome> => {
  const { run, outcome, options } = input;
  const reason = `run ${run.id} was ended by another writer while it was in flight, so its outcome was discarded`;
  // WP-275: the same answer as before, marked, so `settleRun` can tell a settle that lost the row
  // from one that wrote the ending without a second spelling of the reason.
  const skipped: StageExecutionOutcome = { kind: 'skipped', reason };
  LOST_THE_RUN.add(skipped);
  if (outcome === undefined) {
    // `recordUnstarted`'s path: the run never started, so there is no spend to record and nothing
    // for the ledger to be late about.
    return skipped;
  }
  if (outcome.costUnmeasured === true) {
    // Stopped with no result inside the grace (WP-101 review round 1): there is no figure to be
    // late with, and a zero would be a claim (rule 16).
    return skipped;
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
  return skipped;
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
            ...endingDetailOf(outcome),
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
            ...endingDetailOf(outcome),
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
    ...endingDetailOf(outcome),
    lease: input.fence,
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
            ...endingDetailOf(outcome),
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
            ...endingDetailOf(outcome),
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
    ...endingDetailOf(outcome),
    lease: input.fence,
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
 * {@link savedWorkOf} plus the cause of a stop that landed before the CLI spawn marker (WP-154
 * (b′)): `outcome.startFailure`, onto `runs.exit_detail` and the terminal event's `start_failure` —
 * absent for every other ending, which leaves both unset.
 */
const endingDetailOf = (
  outcome: RunOutcome,
): { readonly savedWork?: RunSavedWork; readonly startFailure?: RunStartFailure } => ({
  ...savedWorkOf(outcome),
  ...(outcome.startFailure === undefined ? {} : { startFailure: outcome.startFailure }),
});

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
 * WP-131) — never a `0`. A hand-back that landed before the marker, or whose `spawn` frame was
 * withheld after it (WP-163), spent nothing and carries the measured zero (`unspawnedStop`, WP-150).
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
  // A hand-back before the CLI spawn marker records why it did not start (WP-154 (b′)); whether
  // the stage goes again is decided only here, so the cause's `retryable` is set here too.
  const notStarted =
    outcome.startFailure === undefined
      ? {}
      : {
          startFailure: {
            ...outcome.startFailure,
            retryable: handBacks <= MAX_SHUTDOWN_HAND_BACKS,
          },
        };
  const failed = failRun(
    run,
    {
      status: 'failed',
      terminalReason: 'shutdown',
      error: outcome.error ?? 'shutdown',
      ...failedSpendOf(outcome),
      ...notStarted,
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
    ...notStarted,
    lease: input.fence,
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

/** The blocker brief a stage that stopped without a result gets when its caller wrote none. */
const defaultBlockerBrief = (stage: Slug, ticketKey: string, reason: string): string =>
  `The "${stage}" stage of ${ticketKey} stopped without a result: ${reason}. ` +
  "Nothing is retried automatically. Open the run's transcript, decide what should change, " +
  'and hand the task back at the stage you want it to resume from.';

export const escalate = (
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

/** {@link settleRun}'s collaborators: transaction 2's slice, plus the transaction it opens. */
export interface SettleRunDeps extends SettleOptions {
  readonly unitOfWork: UnitOfWork;
  readonly logger?: Logger;
}

/**
 * What a settle carries: the run, its claim's fence, the outcome, and what the plan knew about it.
 * The last group (settings, stage, redactor, review checklists) is the job's memory in WP-275; a
 * settle that arrives in another process (WP-276's claimant, WP-281's worker) reads it back from
 * the run row instead.
 */
export type SettleRunRequest = Omit<RecordInput, 'options'>;

/** **The stored result** of a settle — the run row's ending, read under its lock (module docblock). */
export interface RunEnding {
  readonly runId: Id;
  readonly epoch: number;
  readonly status: RunStatus;
  readonly terminalReason: RunTerminalReason | null;
}

export interface SettleRunResult {
  /**
   * `settled`: this call wrote the run's ending. `already_settled`: the row was ended at this epoch
   * before this call could — a repeat, or another writer — and this call appended nothing.
   */
  readonly kind: 'settled' | 'already_settled';
  /**
   * The run's ending as the row stores it. `null` only where transaction 2 never reaches `finish`:
   * a task deleted while its run was in flight (`record`'s first answer), which leaves the row live.
   */
  readonly ending: RunEnding | null;
  /** What the job does next — transaction 2's own answer, unchanged. */
  readonly outcome: StageExecutionOutcome;
}

/** `lostTheRun`'s answers, so a settle that lost the row is told apart without a second spelling. */
const LOST_THE_RUN = new WeakSet<StageExecutionOutcome>();

const fenceHolds = (row: RunSettlement, fence: RunLeaseFence): boolean =>
  row.leaseEpoch === fence.epoch && row.leaseOwner === fence.owner;

const endingOf = (row: RunSettlement | null): RunEnding | null =>
  row === null || isActiveRunStatus(row.status)
    ? null
    : {
        runId: row.runId,
        epoch: row.leaseEpoch,
        status: row.status,
        terminalReason: row.terminalReason,
      };

/**
 * **Settles a run** — transaction 2, as a command (module docblock): `lease_lost` (thrown) for a
 * stale fence, `already_settled` with the stored result for a row that has ended, and otherwise the
 * run's result written once.
 *
 * The transaction is the command's own, on the executor's bound: a refused task write re-runs the
 * whole unit in a new transaction (`retryOnTaskConflict`), and a spent bound escapes as
 * `TaskConflictExhaustedError` for the caller's ending, exactly as the job's `writing` did.
 *
 * @throws {LeaseLostError} when the row is held under another claim, before anything is written.
 */
export const settleRun = async (
  deps: SettleRunDeps,
  request: SettleRunRequest,
): Promise<SettleRunResult> =>
  retryOnTaskConflict(
    {
      taskId: request.job.taskId,
      what: "recording a run's result",
      logger: deps.logger ?? silentLogger,
    },
    async () =>
      deps.unitOfWork.transaction(async (scope) => {
        const runId = request.run.id;
        const before = await deps.store.runs.lockSettlement(scope.tx, runId);
        if (before !== null && !fenceHolds(before, request.fence)) {
          throw new LeaseLostError(runId, request.fence);
        }
        // No short cut for a row that has ended: every branch of `record` writes the conditional
        // `finish` first, which answers `false` for it, and then `lostTheRun` — the path transaction 2
        // always had, taken unchanged (the memory store's missing rollback, divergence 4, is why a
        // short cut here would answer a retried attempt from its own abandoned write).
        const outcome = await record(scope, { ...request, options: deps });
        const ending = endingOf(await deps.store.runs.lockSettlement(scope.tx, runId));
        return {
          kind: LOST_THE_RUN.has(outcome) ? 'already_settled' : 'settled',
          ending,
          outcome,
        };
      }),
  );
