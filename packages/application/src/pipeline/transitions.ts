/**
 * Turning a {@link PipelineDecision} into aggregate commands, events and follow-up work.
 *
 * The interpreter decides *what* should happen; this decides *how the task records it*. The split
 * matters because the two have different failure modes: the interpreter is pure and total, while
 * every command here can refuse — `assertTaskTransition` rejects a move the state machine does not
 * have — and a refusal must not become a poisoned event.
 *
 * ## Which command a stage entry becomes
 *
 * product/04's task states are not one per stage: most stages are `active`, and five of them are
 * their own state (`ready_for_merge`, `merged`, `retro` — which both `retrospective` and
 * `librarian` run in — and `done`). The mapping is by stage id,
 * which is why those four ids are listed in `BUILTIN_STAGE_IDS` — a template that renames
 * `ready_for_merge` gets a task that stays `active` through the human wait, and the board would
 * show it as running.
 *
 * ## What happens when the template and the state machine disagree
 *
 * An `IllegalTransitionError` here means the pipeline asked for a move technical/02's table does
 * not have — a hand-edited template that jumps from `merged_gate` to `done` with no retrospective,
 * say. Letting it throw would fail the handler, and the dispatcher would retry it behind its stream
 * for the twenty minutes `DEFAULT_MAX_DISPATCH_ATTEMPTS` allows and then dead-letter the event
 * (WP-49; before that, for ever — WP-04's note). Either way the ending would be about a *dispatch*
 * rather than about the template, so it is caught here and turned into an escalation, which is the
 * same ending every other unrecoverable pipeline state has: the task is parked in `Needs human`
 * with a brief, and its stream keeps moving. Catching it also keeps the failure off the queue
 * entirely, which is what makes the brief say what actually went wrong.
 */
import type { DomainEvent, Id, Slug, TaskStageOutcome } from '@platform/contracts';
import type {
  CommandContext,
  CompiledPipeline,
  IterationLoop,
  PipelineDecision,
  PipelineSignal,
  Task,
} from '@platform/domain';
import {
  completeStage,
  completeTask,
  enterStage,
  escalateTask,
  evaluateIteration,
  IllegalTransitionError,
  incrementIteration,
  LIBRARIAN_STAGE,
  MERGED_GATE_STAGE,
  markReadyForMerge,
  READY_FOR_MERGE_STAGE,
  RETROSPECTIVE_STAGE,
  recordMerge,
  returnToStage,
  stageOf,
  startLibrarianCuration,
  startRetrospective,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import type { StageExecutionJob } from './stage-executor.js';
import type { PipelineStore, StoredTask } from './store.js';

/** The stage id a `system` stage uses to mean "the pipeline is over". */
export const DONE_STAGE = 'done' as const;

export interface AppliedDecision {
  readonly stored: StoredTask;
  readonly events: readonly DomainEvent[];
  /**
   * Work to enqueue **after the transaction commits** — an agent stage to run or a gate to
   * evaluate. Never enqueued inline: see `HandlerContext.afterCommit`.
   */
  readonly work: StageExecutionJob | null;
}

const totalsOf = async (options: ApplyOptions) => {
  const totals = await options.store.runs.totalsFor(options.tx, options.stored.task.id);
  return {
    cost_usd: totals.costUsd,
    is_estimate: totals.isEstimate,
    runs: totals.runs,
    wall_ms: totals.wallMs,
  };
};

/** Entering these stages is a state change of its own (product/04 § "Task states"). */
const enterCommand = (
  stage: Slug,
):
  | ((task: Task, context: CommandContext) => { aggregate: Task; events: readonly DomainEvent[] })
  | null => {
  switch (stage) {
    case READY_FOR_MERGE_STAGE:
      return markReadyForMerge;
    case MERGED_GATE_STAGE:
      return recordMerge;
    case RETROSPECTIVE_STAGE:
      return startRetrospective;
    case LIBRARIAN_STAGE:
      // WP-18b: the second stage of the retrospective phase. It keeps the task in `retro` — the
      // default `enterStage` would set `active`, which `retro` has no edge to, so every task would
      // escalate one stage short of `done`.
      return startLibrarianCuration;
    default:
      return null;
  }
};

export interface ApplyOptions {
  readonly store: PipelineStore;
  /** The task's own template, compiled: what decides whether an entered stage needs a job. */
  readonly pipeline: CompiledPipeline;
  readonly tx: import('../ports/transaction.js').Transaction;
  readonly stored: StoredTask;
  readonly decision: PipelineDecision;
  readonly context: CommandContext;
  readonly causedByEventId: Id | null;
  readonly logger?: Logger;
  /**
   * What to do when the state machine refuses the move — `escalate` (the default) or `throw`.
   *
   * The default is the module docblock's argument and it is right for every caller that is
   * reacting to an **event**: letting the error out would fail the handler, and the dispatcher
   * retries it behind its stream for ever. A **human command** is the other case (WP-15i): there is
   * a caller waiting for an answer, and parking the task in `needs_human` because somebody pressed
   * a button the task was not in a state for would be the platform inventing an escalation nobody
   * asked for. Those callers pass `throw`, catch the error and answer `409` naming the transition —
   * so the task is exactly where the human found it.
   */
  readonly onIllegalTransition?: 'escalate' | 'throw';
  /**
   * The signal `decision` was interpreted from, when the caller has one. Read for one thing: a
   * decision that walks the task **forward** out of the stage the signal was about closes that
   * stage's `task_stages` row — a `gate_settled` signal with the gate's verdict (WP-55), an `event`
   * signal at a human stage with the event's name (WP-46, backlog 158). See {@link closeLeftStage}.
   * Optional because most callers build a decision that no signal produced — a human command, a
   * dependency block, a batch.
   */
  readonly signal?: PipelineSignal;
  /**
   * The `outcome` word an **escalation** closes the parked stage's open row with (WP-46, backlog
   * 160) — `undecided`, `unsupported` and `converged` from the gate settlement, `escalated` when the
   * caller does not say. Read only when the decision escalates; see {@link closeParkedStageRow}.
   */
  readonly escalationOutcome?: TaskStageOutcome;
  /**
   * The branch head a gate judged, recorded as `tasks.ready_head_sha` **if** this decision enters
   * `ready_for_merge` (WP-79, PROGRESS backlog 267) — the gate settlement's head, or the
   * `ready_head_check` duty's when it found the branch unmoved. Every entry into Ready writes the
   * column, `null` when this is absent, so the value always describes the latest entry; every other
   * move ignores it. `enter` below is the column's one writer.
   */
  readonly readyHeadSha?: string | null;
  /**
   * The `task.resumed` reason when this decision takes a stopped task into an **agent or gate**
   * stage (`enterStage`'s `resumeReason`) — the `ready_head_check` duty's sentence for re-entering
   * `ci_gate` from a pause at Ready (WP-79). Absent is `null` on the event, as before.
   */
  readonly resumeReason?: string;
  /**
   * A bounded loop an **entry** spends without being a return (WP-79 review round 2): the rebase
   * gate's re-entry of `ci_gate` for a head CI never passed spends `rebase_rechecks`. Checked and
   * spent together in {@link enter}, so a counter never passes its limit: a spent loop escalates the
   * task with `spentBrief` instead of entering. Absent is no loop, as before.
   */
  readonly spendLoop?: {
    readonly loop: IterationLoop;
    readonly reason: string;
    readonly spentBrief: string;
  };
}

/**
 * Applies one decision to the task: commands, events, `task_stages` bookkeeping and the follow-up
 * job. Everything it writes goes through the transaction it was handed.
 */
export const applyDecision = async (options: ApplyOptions): Promise<AppliedDecision> => {
  try {
    return await apply(options);
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) {
      throw error;
    }
    if (options.onIllegalTransition === 'throw') {
      throw error;
    }
    return applyEscalation(
      options,
      `the pipeline asked for a transition the task's state machine does not have: ${error.message}`,
      `The pipeline tried to move ${options.stored.task.ticket.key} in a way its state machine does not allow (${error.message}). This is a template that does not match the platform's task states. Fix the template, then hand the task back.`,
    );
  }
};

const applyEscalation = async (
  options: ApplyOptions,
  reason: string,
  blockerBrief: string,
): Promise<AppliedDecision> => {
  const { stored, context, logger } = options;
  try {
    const escalated = escalateTask(stored.task, { reason, blockerBrief }, context);
    // The saved snapshot, not the one that went in: `save` advances `tasks.version`, and the
    // caller may write the task again in this same transaction (WP-15e).
    const saved = await options.store.tasks.save(options.tx, {
      ...stored,
      task: escalated.aggregate,
    });
    await closeParkedStageRow(
      options.store,
      options.tx,
      escalated,
      options.escalationOutcome ?? ESCALATED_OUTCOME,
    );
    return { stored: saved, events: escalated.events, work: null };
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) {
      throw error;
    }
    // A finished task cannot be escalated, and there is nothing left to record on it. Consuming
    // the event is the only ending that does not park it in the queue for ever.
    logger?.warn(
      { task_id: stored.task.id, state: stored.task.state, reason },
      'a pipeline decision arrived for a task that has already finished; ignoring it',
    );
    return { stored, events: [], work: null };
  }
};

const apply = async (options: ApplyOptions): Promise<AppliedDecision> => {
  const { decision, stored, context, store, tx } = options;
  switch (decision.kind) {
    case 'wait':
      return { stored, events: [], work: null };

    case 'escalate':
      return applyEscalation(options, decision.reason, decision.blockerBrief);

    case 'complete': {
      await closeLeftStage(options, null);
      await closeCurrentStageRow(
        store,
        tx,
        stored.task,
        TASK_COMPLETED_OUTCOME,
        'the task completed',
      );
      const finished = completeTask(
        stored.task,
        { outcome: 'completed', totals: await totalsOf(options) },
        context,
      );
      const next = { ...stored, task: finished.aggregate };
      return { stored: await store.tasks.save(tx, next), events: finished.events, work: null };
    }

    case 'return': {
      const returned = returnToStage(
        stored.task,
        {
          fromStage: decision.from,
          toStage: decision.to,
          loop: decision.loop,
          reason: decision.reason,
          escalationBrief: decision.escalationBrief,
        },
        context,
      );
      // The reason stays on the attempt that produced it, and `returned_to` names the stage it is
      // for — which is what `lastReturnReason` reads the next run's feedback by (WP-55, backlog
      // 67). Written even when `returnToStage` escalates below: the return was the stage's
      // decision, and the stage a human hands the task back to is where its finding belongs.
      await store.tasks.recordStageExited(tx, {
        taskId: stored.task.id,
        stage: decision.from,
        attempt: stored.task.stageAttempts[decision.from] ?? 1,
        state: 'returned',
        outcome: 'returned',
        returnReason: decision.reason,
        returnedTo: decision.to,
      });
      if (returned.aggregate.state !== 'returned') {
        // `returnToStage` escalated instead: the loop is spent (BD-008). The counter stays where
        // it is, which is what makes "counters never exceed their limits" true.
        const next = { ...stored, task: returned.aggregate };
        return { stored: await store.tasks.save(tx, next), events: returned.events, work: null };
      }
      const entered = await enter(
        { ...options, stored: { ...stored, task: returned.aggregate } },
        decision.to,
      );
      return {
        stored: entered.stored,
        events: [...returned.events, ...entered.events],
        work: entered.work,
      };
    }

    case 'enter':
      await closeLeftStage(options, decision.stage);
      return enter(options, decision.stage);
  }
};

/**
 * **The invariant every `task_stages` writer is held to** (WP-46, PROGRESS backlogs 158, 160 and
 * 212):
 *
 * > *A row is open (`running`) exactly while its attempt can still resume.*
 *
 * An attempt can resume while the task is at that stage, on that attempt, and neither parked
 * (`needs_human`), cancelled nor done. `paused` and `waiting_answers` do **not** end an attempt by
 * themselves — the row stays open — but nothing resumes an attempt either: every way back in
 * (`resume`, `retry-stage`, a hand-back after a take-over, a question answered) enters the stage as
 * a **new** attempt, so the old one is ended by that entry. Review round 1 measured the gap the
 * first wording (*"a paused task keeps its row because the attempt resumes where it stopped"*) hid:
 * take over at `ci_gate`, hand back, and attempt 1 stayed `running` for ever. Each ending closes
 * the row with an `outcome` that says which, and this is the census of them, so a new ending has
 * somewhere to be written down:
 *
 *  - **an agent stage** ends inside the stage executor, which closes its row with the verdict (or
 *    `failed`) in the transaction that ends the run; the lease sweep does the same for a run
 *    nothing is driving;
 *  - **a return** closes the returning row `returned`, with its target (`apply`'s `return` case);
 *  - **a `system` stage** closes on entry (`enter`);
 *  - **a gate the platform settled** and **a human stage an event moved forward** close in
 *    {@link closeLeftStage} — the gate with its verdict (WP-55), the human stage with the event's
 *    name (WP-46; before it, `ready_for_merge` was published `running` on every merged task);
 *  - **an escalation** closes the parked stage's row `failed` in {@link closeParkedStageRow};
 *  - **any entry** closes the row the task was still at in {@link closeCurrentStageRow} —
 *    `superseded` when the entry is a new attempt of the same stage, `left` when it is another
 *    stage — and so does **completion** (`task.completed`) and **cancellation** (`cancelled`,
 *    paused or not).
 *
 * Every close of the last three kinds is conditional on the row still being `running` (the store's
 * `closeOpenStage`), so it never overwrites what a stage decided; and every site that ends a task
 * or enters a stage calls one — `task-save-sites.test.ts` counts them off disk, so a new ending
 * that forgets fails a test rather than a reader. The converse — a row the task *is* at is open —
 * holds because every entry opens one (`recordStageEntered` upserts `running`).
 */
const closeLeftStage = async (options: ApplyOptions, next: Slug | null): Promise<void> => {
  const { signal, stored } = options;
  if (
    signal === undefined ||
    (signal.kind !== 'gate_settled' && signal.kind !== 'event') ||
    stored.task.currentStage !== signal.stage ||
    next === signal.stage
  ) {
    return;
  }
  if (signal.kind === 'event' && stageOf(options.pipeline, signal.stage)?.kind !== 'human') {
    // The interpreter escalates an event for a stage that is not human, so this is unreachable
    // through `apply`; guarded rather than trusted, because closing an agent stage's row here would
    // overwrite the verdict its executor wrote.
    return;
  }
  await options.store.tasks.recordStageExited(options.tx, {
    taskId: stored.task.id,
    stage: signal.stage,
    attempt: stored.task.stageAttempts[signal.stage] ?? 1,
    state: 'completed',
    // A gate's outcome is `stageVerdictSchema`'s gate word, the one the interpreter decided on (a
    // gate whose `fail_to` points *forward* closes `completed` with `fail`, which is what
    // happened). A human stage's is the event that moved it — `mr.merged` on every shipped
    // template — because a human stage has no verdict, and the event is what the reader of the row
    // needs to know (WP-46, backlog 158).
    outcome: signal.kind === 'gate_settled' ? (signal.passed ? 'pass' : 'fail') : signal.event,
    returnReason: null,
    returnedTo: null,
  });
};

/** A new attempt of the same stage was entered while the old one was still open (WP-46). */
export const SUPERSEDED_OUTCOME = 'superseded' as const;
/** Another stage was entered while this one's attempt was still open (WP-46). */
export const LEFT_OUTCOME = 'left' as const;
/** The task completed while this attempt was still open (WP-46). */
export const TASK_COMPLETED_OUTCOME = 'task.completed' as const;
/** The task was cancelled while this attempt was still open (WP-46, backlog 212). */
export const CANCELLED_OUTCOME = 'cancelled' as const;

/** The `outcome` an escalation writes when its caller names no more specific word (WP-46). */
export const ESCALATED_OUTCOME = 'escalated' as const;

/**
 * Closes the row of the stage a task was **parked** at, if it is still open (WP-46, backlog 160):
 * the escalation half of the invariant stated at {@link closeLeftStage}.
 *
 * Call it with the escalation's decision — the task after it and the `task.escalated` it emitted,
 * whose `reason` becomes the row's. It does nothing unless that task is `needs_human` at a stage,
 * and the store closes the row only while it is `running` — so an agent
 * stage whose executor already wrote its verdict, and a gate that settled before its move was
 * refused, keep what they decided. What is left is exactly the rows nothing else closes: a gate
 * the platform could not decide (`undecided`), could not evaluate (`unsupported`) or stopped on a
 * repeated failure (`converged`), and a human stage whose merge request was closed (`mr.closed`).
 * Before WP-46 all of those stayed `running` under a `needs_human` task, and the task screen told
 * the person reading the stage list that the gate was still working.
 *
 * The reason is recorded as the row's `return_reason` with no target — what the executor's
 * `failed` rows already do — and it is the escalation's own `reason`, read off its event.
 */
export const closeParkedStageRow = async (
  store: PipelineStore,
  tx: import('../ports/transaction.js').Transaction,
  escalation: { readonly aggregate: Task; readonly events: readonly DomainEvent[] },
  outcome: TaskStageOutcome,
): Promise<void> => {
  const task = escalation.aggregate;
  if (task.state !== 'needs_human' || task.currentStage === null) {
    return;
  }
  const escalated = escalation.events.find((event) => event.type === 'task.escalated');
  await store.tasks.closeOpenStage(tx, {
    taskId: task.id,
    stage: task.currentStage,
    attempt: task.stageAttempts[task.currentStage] ?? 1,
    outcome,
    reason: escalated?.type === 'task.escalated' ? escalated.payload.reason : outcome,
  });
};

/**
 * Closes the row of the stage `task` is at — its current attempt — if it is still open (WP-46,
 * review round 1 and PROGRESS backlog 212): the half of the invariant at {@link closeLeftStage}
 * that no stage decides. Pass the task **as it was before** the command that ends the attempt; the
 * store writes `failed` with `outcome` only while the row is `running`.
 */
export const closeCurrentStageRow = async (
  store: PipelineStore,
  tx: import('../ports/transaction.js').Transaction,
  task: Task,
  outcome: TaskStageOutcome,
  reason: string,
): Promise<void> => {
  if (task.currentStage === null) {
    return;
  }
  await store.tasks.closeOpenStage(tx, {
    taskId: task.id,
    stage: task.currentStage,
    attempt: task.stageAttempts[task.currentStage] ?? 1,
    outcome,
    reason,
  });
};

/** Enters a stage, choosing the command its id implies and scheduling whatever it needs. */
const enter = async (options: ApplyOptions, stage: Slug): Promise<AppliedDecision> => {
  const { stored, context, store, tx } = options;
  if (stage === DONE_STAGE) {
    await closeCurrentStageRow(
      store,
      tx,
      stored.task,
      TASK_COMPLETED_OUTCOME,
      'the task completed',
    );
    const finished = completeTask(
      stored.task,
      { outcome: 'completed', totals: await totalsOf(options) },
      context,
    );
    const next = { ...stored, task: finished.aggregate };
    return { stored: await store.tasks.save(tx, next), events: finished.events, work: null };
  }

  const spend = options.spendLoop;
  if (spend !== undefined) {
    const iteration = evaluateIteration(
      stored.task.iterationCounters,
      spend.loop,
      stored.task.limits,
    );
    if (!iteration.allowed) {
      return applyEscalation(
        options,
        `${spend.loop} iteration limit of ${iteration.limit} reached: ${spend.reason}`,
        spend.spentBrief,
      );
    }
  }
  const command = enterCommand(stage);
  const decision =
    command === null
      ? enterStage(
          stored.task,
          {
            stage,
            ...(stored.task.state === 'queued' ? { dequeueReason: 'wip' as const } : {}),
            ...(options.resumeReason === undefined ? {} : { resumeReason: options.resumeReason }),
          },
          context,
        )
      : command(stored.task, context);

  const attempt = decision.aggregate.stageAttempts[stage] ?? 1;
  // The attempt the task is leaving can no longer resume: every way back into a stage is a new
  // attempt. A row something already closed — a verdict, a return, a settled gate — is kept.
  await closeCurrentStageRow(
    store,
    tx,
    stored.task,
    stored.task.currentStage === stage ? SUPERSEDED_OUTCOME : LEFT_OUTCOME,
    `the task entered ${stage} (attempt ${String(attempt)})`,
  );
  await store.tasks.recordStageEntered(tx, {
    taskId: stored.task.id,
    stage,
    attempt,
    causedByEventId: options.causedByEventId,
  });

  const entered = stageOf(options.pipeline, stage);
  const events = [...decision.events];
  let task =
    spend === undefined
      ? decision.aggregate
      : {
          ...decision.aggregate,
          iterationCounters: incrementIteration(decision.aggregate.iterationCounters, spend.loop),
        };

  if (entered?.kind === 'system') {
    // A system stage is bookkeeping: it completes the moment it is entered, in the same
    // transaction, so the pipeline advances on the next dispatch rather than on a job that would
    // have nothing to run.
    const completed = completeSystemStage(task, stage, context);
    task = completed.aggregate;
    events.push(...completed.events);
    await store.tasks.recordStageExited(tx, {
      taskId: stored.task.id,
      stage,
      attempt,
      state: 'completed',
      outcome: 'system',
      returnReason: null,
      returnedTo: null,
    });
  }

  const next = { ...stored, task };
  let saved = await store.tasks.save(tx, next);
  if (stage === READY_FOR_MERGE_STAGE) {
    /**
     * **The head the task entered Ready with** (WP-79, PROGRESS backlog 267) — the one write of
     * `tasks.ready_head_sha`, in the entry's own transaction and after the aggregate's `save`
     * (narrow, no version bump). `null` when the caller judged no head, so an entry that judged
     * nothing never inherits an earlier entry's head; `ready-head.ts` is the reader.
     */
    const readyHeadSha = options.readyHeadSha ?? null;
    await store.tasks.saveReadyHead(tx, stored.task.id, readyHeadSha);
    saved = { ...saved, readyHeadSha };
  }
  return {
    stored: saved,
    events,
    work:
      entered?.kind === 'agent' || entered?.kind === 'gate'
        ? { taskId: stored.task.id, projectId: stored.task.projectId, stage, attempt }
        : null,
  };
};

/**
 * A `system` stage completes the moment it is entered: it is bookkeeping, not work. Emitted as a
 * real `task.stage.completed` so the transition is in the log rather than being a gap in it.
 */
export const completeSystemStage = (
  task: Task,
  stage: Slug,
  context: CommandContext,
): { aggregate: Task; events: readonly DomainEvent[] } =>
  completeStage(task, { stage, artifacts: [] }, context);
