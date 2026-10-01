/**
 * The stage nobody runs — PROGRESS backlog **320**, a row of `./stranded.ts`'s table (WP-108).
 *
 * ## What is lost
 *
 * Every entry into an agent or gate stage commits the task at that stage and then enqueues its
 * `stage.execute` job **on the next line**, because `Jobs.enqueue` does not join a transaction
 * (TD-004). A process that dies in that window leaves the task at its stage with no job and no run.
 * Nothing re-emits the entry, nothing escalates it (nothing has failed), and the task reads
 * `active` for ever. Backlog 320 found it at the discovery task, where WP-94 made it worse: the
 * re-evaluate button counts a discovery task that has not ended as in flight and refuses a second
 * one, so the project could never be re-evaluated.
 *
 * **It is a class, not a site.** WP-108 read every `enqueueStage` call site before choosing the row
 * (the list, with each one's exposure, is under backlog 320): eighteen sites in eleven modules,
 * every one of them a commit followed by an enqueue — event handlers' `afterCommit` (the saga, at
 * every stage transition), the human commands, the `pipeline.outbound` duties, the bootstrap and
 * shadow batches, the maintenance scheduler and the two discovery starts. A job that dies after its
 * commit is redelivered by pg-boss, but the redelivery re-validates against a task that has already
 * moved and enqueues nothing. So the row covers the class: any task at a stage `stage.execute`
 * drives. The other way to reach the same state is a `stage.execute` job that spent every pg-boss
 * retry (PROGRESS backlog 325) — its failed job is not `created`, `retry` or `active` — and this
 * row finds that too.
 *
 * ## The predicate, and why each half
 *
 *  - the task is in a state a stage runs in (`active`, `merged`, `retro`) at a stage that is an
 *    **agent** or **gate** stage of its own compiled pipeline — the two kinds `stage.execute` drives
 *    (`transitions.ts`'s `enter` schedules work for exactly those). A `human` stage — the spike's
 *    breakdown decision is entered `active` — waits for a person by design and is never found;
 *  - its **open** `task_stages` row for the current attempt (state `running`) was entered more than
 *    the pass's grace ago. A run that finished closes that row in its own transaction, so a task
 *    whose run is over and whose next stage is being decided by the saga is not found;
 *  - **no live run** of the task (`created`, `starting`, `running`). A run nothing is driving is the
 *    `run_lease` row's;
 *  - **no `stage.execute` job** keyed `task:<id>` that is `created`, `retry` or `active` — asked of
 *    pg-boss's own table, because that is the only place the answer is. A run-start retry and a gate
 *    re-check each wait as a `created` job with a `startAfter`, so neither is found.
 *
 * ## What it does: once, then an ending
 *
 * The shape every re-enqueuing row of the table has (backlog 105): the **mark** —
 * `tasks.stage_recovery_attempted_at`, migration 0067 — is committed before the enqueue, and it is
 * read against the open row's `entered_at`, so the pass attempts **once per stage entry**. The mark
 * is conditional on the predicate still holding for that entry, which is the arbiter with the live
 * path (standing rule 9): a job enqueued between the pass's read and its mark makes the mark write
 * nothing, and nothing is enqueued. The re-enqueued job is the entry's own (`enqueueStage` with the
 * task's stage and attempt), and `stage.execute` re-validates it on fire like any other.
 *
 * **An attempt whose run already ended is never re-enqueued** (WP-108 review round 1). A run
 * cancelled with no live lease pauses its task — except from `merged` and `retro`, which have no
 * edge to `paused`, so such a task stayed at its stage with a `cancelled` run and an open row, and
 * the first version of this row re-enqueued it a minute later: a fresh **paid** run of a stage a
 * person had just cancelled. The same question for every other ending: a failed run escalates in
 * its own transaction, the lease sweep escalates its task, a budget refusal pauses before any run
 * exists, and a retryable start failure keeps its `stage.execute` job active while it enqueues the
 * retry — so what remains with an ended run is a task nothing moved, and the right ending is the
 * escalation, at once (a pass interval after the run ended), with a brief naming the run's ending.
 *
 * When the one attempt has not taken a whole ending window later, the task is **escalated** to
 * `needs_human` with a brief — the stage executor's own ending for a stage that produced nothing, so
 * no new task state. The ending re-asks the predicate inside its own transaction, so a stage that
 * started meanwhile is left alone. Its `save` is under {@link retryOnTaskConflict}; a spent bound is
 * logged and the next pass tries again, because the task is still stranded and still marked.
 */
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { canTransitionTask, compilePipeline, escalateTask, stageOf } from '@platform/domain';
import type { PipelineStore, StoredTask } from '../pipeline/store.js';
import { retryOnTaskConflict, TaskConflictExhaustedError } from '../pipeline/task-conflict.js';
import { closeParkedStageRow, ESCALATED_OUTCOME } from '../pipeline/transitions.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** A task at a stage `stage.execute` drives, with no job and no run (backlog 320). */
export interface StrandedStage {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug;
  readonly attempt: number;
  /** The open `task_stages` row's `entered_at`. */
  readonly enteredAt: IsoDateTime;
  /**
   * The mark **for this stage entry** — `null` when this entry has not been attempted, including
   * when the column holds a mark older than the entry, which belongs to an earlier one.
   */
  readonly recoveryAttemptedAt: IsoDateTime | null;
  /**
   * The newest run this attempt already had, when it has **ended** — `null` when the attempt never
   * had one (WP-108 review round 1). An attempt with an ended run is **never re-enqueued**: its run
   * was cancelled by a person, failed, or was ended by the lease sweep, and starting the stage
   * again would be a fresh paid run nobody asked for. It is escalated instead, naming the ending.
   */
  readonly endedRun: {
    /** `run_status`, a platform enum value. */
    readonly status: string;
    /** `run_terminal_reason`, a platform enum value, or `null`. */
    readonly terminalReason: string | null;
  } | null;
}

/** The query the pass asks, `./stranded.ts`'s `StrandedQuery` by another name. */
export interface StrandedStageQuery {
  /** An entry younger than this still has its own job in flight. */
  readonly olderThan: IsoDateTime;
  /** A mark older than this has had its one attempt and did not take. */
  readonly endingBefore: IsoDateTime;
  readonly limit: number;
}

export interface StrandedStageRecoveryStore {
  /**
   * The module docblock's predicate: an unattempted entry older than `olderThan`, or an attempted
   * one whose mark is older than `endingBefore`. Oldest entry first, at most `limit`. A candidate
   * still has to pass {@link isDrivenStage}: the stage's kind is the compiled pipeline's.
   */
  strandedStages(tx: Transaction, query: StrandedStageQuery): Promise<readonly StrandedStage[]>;
  /**
   * Writes the mark for this entry **only while the predicate still holds for it** (same stage,
   * same attempt, the row still open, no job, no live run), and answers whether it wrote. `false`
   * means the live path got there first, and the pass enqueues nothing.
   */
  markStageAttempt(
    tx: Transaction,
    input: { readonly row: StrandedStage; readonly at: IsoDateTime },
  ): Promise<boolean>;
  /** The predicate for one entry, asked again inside the ending's transaction. */
  isStillStranded(tx: Transaction, row: StrandedStage): Promise<boolean>;
}

export interface StrandedStageRecoverySite {
  readonly store: StrandedStageRecoveryStore;
  /** Where the task is read, compiled and — for the ending — escalated. */
  readonly pipeline: PipelineStore;
  /** The ending's command context: a system actor, so the escalation says who parked the task. */
  readonly context: (taskId: Id) => CommandContext;
}

/** The component the ending's system actor names. */
export const STRANDED_STAGE_COMPONENT = 'stranded-stage-recovery';

/** Task states a stage runs in — `revalidate`'s runnable states that can hold an agent or gate. */
const STAGE_STATES: ReadonlySet<string> = new Set(['active', 'merged', 'retro']);

/**
 * The half of the predicate SQL cannot ask: the stage is an agent or gate stage of the task's own
 * compiled pipeline, and the task is still at that stage on that attempt.
 */
export const isDrivenStage = (stored: StoredTask | null, row: StrandedStage): boolean => {
  if (stored === null) return false;
  const { task } = stored;
  if (!STAGE_STATES.has(task.state) || task.currentStage !== row.stage) return false;
  if ((task.stageAttempts[row.stage] ?? 1) !== row.attempt) return false;
  const stage = stageOf(
    compilePipeline(task.template, stored.template, stored.pipelineDial),
    row.stage,
  );
  return stage !== null && (stage.kind === 'agent' || stage.kind === 'gate');
};

/** The read, filtered by the compiled pipeline inside the same transaction. */
export const strandedStagesIn = async (
  site: StrandedStageRecoverySite,
  tx: Transaction,
  query: StrandedStageQuery,
): Promise<readonly StrandedStage[]> => {
  const candidates = await site.store.strandedStages(tx, query);
  const driven: StrandedStage[] = [];
  for (const row of candidates) {
    if (isDrivenStage(await site.pipeline.tasks.load(tx, row.taskId), row)) {
      driven.push(row);
    }
  }
  return driven;
};

/** Why the task was parked — stored on `task.escalated` and on the stage row (platform text only). */
export const strandedStageReason = (row: StrandedStage, attemptedAt: IsoDateTime): string =>
  `the "${row.stage}" stage (attempt ${String(row.attempt)}) was entered at ${row.enteredAt} and never started: no job was queued for it and no run was created; the platform re-enqueued it once at ${attemptedAt} and it still did not start (PROGRESS backlog 320)`;

/**
 * Why a task whose attempt already **ended a run** was parked rather than re-run (WP-108 review
 * round 1). Both strings are platform enum values, never model or provider text.
 */
export const endedRunReason = (
  row: StrandedStage,
  ended: NonNullable<StrandedStage['endedRun']>,
): string =>
  `the "${row.stage}" stage (attempt ${String(row.attempt)}) is still open, but its run ended “${ended.status}”${
    ended.terminalReason === null ? '' : ` (${ended.terminalReason})`
  } and nothing moved the task on; the platform does not start a stage again after its run ended (PROGRESS backlog 320)`;

/** The brief for an attempt whose run ended — a person's cancel named as such. */
export const endedRunBrief = (
  row: StrandedStage,
  ended: NonNullable<StrandedStage['endedRun']>,
  ticketKey: string,
): string =>
  `${ticketKey} is at "${row.stage}", and ${
    ended.status === 'cancelled'
      ? 'a person cancelled the run of this attempt'
      : `the run of this attempt ended “${ended.status}”`
  }, but the task was left at the stage with nothing to move it. The platform does not start the stage again on its own — that would be a new paid run nobody asked for. Hand the task back at the stage you want it to resume from to run it again, or cancel the task.`;

/** What the person who picks the task up is told to do. */
export const strandedStageBrief = (row: StrandedStage, ticketKey: string): string =>
  `${ticketKey} was entered at "${row.stage}" and nothing ever ran it: the job that runs a stage was lost (a process stopped between the task's commit and the enqueue, or the job spent every retry), and one re-enqueue by the platform did not start it either. Nothing ran, so nothing was spent on this attempt. Check that a runner is serving agent stages (/readyz's agent_runs line), then hand the task back at the stage it should resume from — or cancel it if it is no longer wanted.`;

export interface StrandedStageEndingOptions {
  readonly unitOfWork: UnitOfWork;
  readonly site: StrandedStageRecoverySite;
  readonly logger?: Logger;
}

/**
 * The ending: escalate the task, if the entry is still stranded when its own transaction looks.
 * `true` when it escalated; `false` when the stage moved, started, or the task was finished.
 */
export const endStrandedStage = async (
  options: StrandedStageEndingOptions,
  row: StrandedStage,
  /** The pass's one attempt for this entry; `null` for an entry whose run ended (never attempted). */
  attemptedAt: IsoDateTime | null,
): Promise<boolean> => {
  const logger = options.logger ?? silentLogger;
  const { site } = options;
  try {
    return await retryOnTaskConflict(
      { taskId: row.taskId, what: 'escalating a stage nothing ever ran', logger },
      async () =>
        options.unitOfWork.transaction(async (scope) => {
          const stored = await site.pipeline.tasks.load(scope.tx, row.taskId);
          if (
            stored === null ||
            !isDrivenStage(stored, row) ||
            !canTransitionTask(stored.task.state, 'needs_human') ||
            !(await site.store.isStillStranded(scope.tx, row))
          ) {
            return false;
          }
          const ended = row.endedRun;
          const escalated = escalateTask(
            stored.task,
            ended !== null
              ? {
                  reason: endedRunReason(row, ended),
                  blockerBrief: endedRunBrief(row, ended, stored.task.ticket.key),
                }
              : {
                  reason: strandedStageReason(row, attemptedAt ?? row.enteredAt),
                  blockerBrief: strandedStageBrief(row, stored.task.ticket.key),
                },
            site.context(row.taskId),
          );
          await site.pipeline.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
          await closeParkedStageRow(site.pipeline, scope.tx, escalated, ESCALATED_OUTCOME);
          await scope.events.append(escalated.events);
          return true;
        }),
    );
  } catch (error) {
    if (!(error instanceof TaskConflictExhaustedError)) {
      throw error;
    }
    // Not escalated through `escalateTaskAfterConflict`: that would be a second writer racing the
    // same writers. The task is still stranded and still marked, so the next pass ends it.
    logger.error(
      { task_id: row.taskId, stage: row.stage, err: error },
      'a stage nothing ever ran could not be escalated: every write lost a race; the next recovery pass tries again (PROGRESS backlog 320)',
    );
    return false;
  }
};
