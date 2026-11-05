/**
 * **A task that leaves a stage entry closes its offer** — WP-276, TD-031 decision 3 (item 3 of what
 * replaces the job singleton for a run's duration).
 *
 * Since WP-276 the `stage.execute` job ends at the offer, so a run can sit `created` — offered, not
 * yet claimed — while the task it serves moves: a person pauses, cancels, takes over or returns it,
 * a gate or a handler escalates it, a retry enters a new attempt. Every such transition closes the
 * stage entry's offer **in its own transaction**, through {@link closeStageOffer}, by **one
 * conditional statement** (`RunOfferRepository.withdraw`): `update run_offers set state =
 * 'withdrawn' … where … and state = 'open'`.
 *
 * - **One row touched** — the offer was still open, so no claimant holds the run. It is withdrawn and
 *   the run ends `created → cancelled` in the same transaction (`withdrawRunOffer`, `run.offer.withdrawn`
 *   then `run.finished`), at the measured zero: nothing ran, so nothing was spent (WP-150's rule).
 * - **Zero rows** — a claim won the row lock first (or there is no offer). If the task's stage offer
 *   is `claimed`, a `cancel` run command is recorded for its holder (TD-028 decision 11) — the same rule
 *   cancel and take-over follow — unless a stop is already pending; the run then ends through its own
 *   settle, and the next stage entry's offer waits for it (`stage-executor.ts`, the per-task index).
 *
 * No read-then-write decides between the two: the conditional update is the decision, and the
 * claim's `for update … skip locked` either took the row before it (zero rows) or finds it withdrawn.
 *
 * **Lock order** (TD-031's 2026-11-04 amendment §5): the offer first (the conditional update, or the
 * claimed offer under `lockRun`), then the run (`finish`, or the cancel's row lock), and the task's
 * `save` **after** this returns — which is why every call site calls this before it saves the task.
 * `offer-closing-census.test.ts` holds every `tasks.save` site to that.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { type CommandContext, isActiveRunStatus, withdrawRunOffer } from '@platform/domain';
import type { TransactionScope } from '../ports/unit-of-work.js';
import { MEASURED_ZERO_COST, NO_RUN_USAGE, stoppedBeforeCliSpawn } from './cli-spawn.js';
import { toRunAggregate } from './run-aggregate.js';
import { type RunCommandWakeUp, runCommandsTopic } from './run-commands.js';
import {
  type OfferWithdrawalCode,
  type PipelineStore,
  STOPPING_RUN_COMMAND_KINDS,
} from './store.js';

/** What a stage transition's closing did with the task's stage offer. */
export type StageOfferClosing =
  /** The task had no open or claimed stage offer. */
  | { readonly kind: 'none' }
  /** The offer was open: withdrawn, its run ended `cancelled`. */
  | { readonly kind: 'withdrawn'; readonly runId: Id; readonly offerId: Id }
  /** The offer was claimed: a `cancel` is recorded for the holder (or one already was). */
  | { readonly kind: 'cancel_recorded'; readonly runId: Id; readonly commandId: Id | null };

export interface StageOfferClosingDeps {
  readonly store: Pick<PipelineStore, 'offers' | 'runs' | 'runCommands'>;
}

/**
 * Closes the task's stage offer before a transition that leaves its stage entry (module docblock).
 * Answers what it did and the events the caller appends with the transition's own. Call it
 * **before** `tasks.save`.
 */
export const closeStageOffer = async (
  deps: StageOfferClosingDeps,
  scope: Pick<TransactionScope, 'tx' | 'broadcast' | 'events'>,
  input: {
    readonly taskId: Id;
    /** The code `run_offers.withdrawn_reason` stores (WP-278 review, BACKLOG 731). */
    readonly code: OfferWithdrawalCode;
    /** Platform text: the transition that leaves the stage entry — `run.offer.withdrawn`'s reason. */
    readonly reason: string;
    readonly context: CommandContext;
    /** The person whose command this is, recorded on a `cancel`; `null` for the platform. */
    readonly actorUserId?: Id | null;
  },
): Promise<{ readonly closing: StageOfferClosing; readonly events: readonly DomainEvent[] }> => {
  const { store } = deps;
  const now = input.context.clock.now();
  const withdrawn = await store.offers.withdraw(scope.tx, {
    by: { taskId: input.taskId },
    reason: input.code,
    now,
  });
  if (withdrawn !== null) {
    return {
      closing: { kind: 'withdrawn', runId: withdrawn.runId, offerId: withdrawn.offerId },
      events: await endWithdrawnRun(deps, scope, withdrawn, input),
    };
  }
  const live = await store.offers.liveStageOffer(scope.tx, input.taskId);
  if (live === null || live.state !== 'claimed') {
    return { closing: { kind: 'none' }, events: [] };
  }
  // `lockRun` with `forUpdate` locks the offer and then the run — the one order (§5).
  const locked = await store.runCommands.lockRun(scope.tx, live.runId, { forUpdate: true });
  if (locked === null || !isActiveRunStatus(locked.status)) {
    return { closing: { kind: 'none' }, events: [] };
  }
  const stopPending =
    locked.leaseOwner !== null &&
    (
      await store.runCommands.pending(scope.tx, {
        owner: locked.leaseOwner,
        runId: locked.runId,
        limit: 50,
      })
    ).some((row) => (STOPPING_RUN_COMMAND_KINDS as readonly string[]).includes(row.kind));
  if (stopPending) {
    return {
      closing: { kind: 'cancel_recorded', runId: locked.runId, commandId: null },
      events: [],
    };
  }
  const commandId = input.context.ids.next();
  await store.runCommands.insert(scope.tx, {
    id: commandId,
    runId: locked.runId,
    taskId: locked.taskId,
    actorUserId: input.actorUserId ?? null,
    instruction: { kind: 'cancel' },
  });
  if (locked.leaseOwner !== null) {
    const wakeUp: RunCommandWakeUp = { lease_owner: locked.leaseOwner, run_id: locked.runId };
    await scope.broadcast.publish({ topic: runCommandsTopic(locked.leaseOwner), payload: wakeUp });
  }
  return { closing: { kind: 'cancel_recorded', runId: locked.runId, commandId }, events: [] };
};

/**
 * The withdrawn offer's run, `created → cancelled`, at the measured zero, through `finish` — after
 * the offer's conditional update, so the run is the second row locked (§5). Answers the events.
 */
export const endWithdrawnRun = async (
  deps: StageOfferClosingDeps,
  scope: Pick<TransactionScope, 'tx' | 'events'>,
  withdrawn: { readonly offerId: Id; readonly runId: Id },
  input: { readonly reason: string; readonly context: CommandContext },
): Promise<readonly DomainEvent[]> => {
  const row = await deps.store.runs.load(scope.tx, withdrawn.runId);
  if (row === null) return [];
  const startFailure = stoppedBeforeCliSpawn({
    ending: 'cancelled',
    step: 'unheld',
    attempt: 1,
    retryable: false,
  });
  const won = await deps.store.runs.finish(scope.tx, {
    runId: withdrawn.runId,
    status: 'cancelled',
    terminalReason: 'cancelled',
    sessionId: null,
    numTurns: 0,
    usage: NO_RUN_USAGE,
    cost: MEASURED_ZERO_COST,
    wallMs: 0,
    startFailure,
  });
  if (!won) return [];
  const decision = withdrawRunOffer(
    toRunAggregate(row, await scope.events.lockStreamSequence('run', withdrawn.runId)),
    {
      offerId: withdrawn.offerId,
      reason: input.reason,
      usage: NO_RUN_USAGE,
      cost: MEASURED_ZERO_COST,
      startFailure,
    },
    input.context,
  );
  return decision.events;
};
