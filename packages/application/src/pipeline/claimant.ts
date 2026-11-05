/**
 * **The server's claimant loop** — WP-276, TD-031 decisions 2, 3 and 13.
 *
 * Since WP-276 the `stage.execute` job (and `task.ask`) end at the **offer**: they plan, store the
 * sealed plan and write the `run_offers` row, and the run waits `created` for a claimant. This module
 * is the claimant the server composes **by configuration** — a process with a launcher URL and token
 * (or the in-process provisioner) runs it, a process without one runs none (TD-028's 2026-11-04
 * amendment) — and it does what the job did after the plan, from **stored state only**:
 *
 * ```
 * tx     claim the oldest open offer (the one claim, `./offers.ts`)       → run.claimed
 *        read the run row and its stored context pack back (backlog 709)
 * ——     read the sealed plan back (`loadRunPackage`), start the runner,   (minutes; no connection held)
 *        heartbeat with the claim's epoch
 *        (the CLI spawn marker, its own transaction)                       → run.started
 * tx     `settleRun` in process — the four-field request                   → run.finished | run.failed …
 *        (an ask's offer settles through the ask's own ending)
 * ```
 *
 * It never re-plans: a run whose plan cannot be read back settles `not_started` (a terminal
 * `RunStartError` from `loadRunPackage`). A provision failure settles `not_started` too — the server
 * claimant never **releases** an offer (TD-031 §6 as amended is a remote worker's: `remote-runs.ts`, WP-281). An open offer with **no**
 * plan row is withdrawn before any claim by {@link RunClaimantOptions.unplanned} (once per poll, and
 * first in every drain), its task escalated naming `run_plan_missing`; one claimed between two such
 * passes settles `not_started` with the same name (`loadRunPackage`), which escalates its task too.
 *
 * ## When the claimant stops a run itself
 *
 * TD-031 §2 for every claimant: an answered `lease_lost` stops the session and destroys the workspace
 * at once (its settle then answers `lease_lost`, or `already_settled` for a row another writer ended,
 * whose measured spend reaches the ledger once as a late cost); a single failed beat does not; and
 * **self-termination** — no successful renewal for `TTL − ½·renew` on the monotonic clock — stops the
 * session and **pushes nothing more**: no settle is attempted, and the row is left to the lease sweep,
 * which acts only after `lease_expires_at + APP_LEASE_SKEW_GRACE` (`./lease.ts`). Stopping the handle
 * is what destroys the workspace: the workspace runner releases it when the outcome resolves.
 *
 * ## Wake-ups
 *
 * `pg_notify('run_offers')` (`RUN_OFFERS_TOPIC`, published at the offer's commit) and a poll every
 * {@link DEFAULT_CLAIM_POLL_MS}. It claims while it has a free slot (`APP_RUNNER_CONCURRENCY`), and
 * each slot is one run from claim to settle. {@link RunClaimant.drain} is the test harness's worker.
 * Since WP-278 the claim takes an offer only from its `server_from` (TD-031 decision 8), so an offer
 * whose project prefers workers waits here for its fallback; the poll is what finds it then.
 *
 * ## Saying that it is running (WP-278)
 *
 * A started claimant with a lease writes its `server_claimants` row (`server:<process>`) at start,
 * renews it every {@link SERVER_CLAIMANT_RENEW_MS} from its poll with a {@link SERVER_CLAIMANT_TTL_MS}
 * expiry on the database's clock, and deletes it at stop. That row is how **any** process writing an
 * offer knows whether the instance has a server claimant (TD-031 §8) — in the compose topology the
 * process that offers is often not the one that claims. A renewal that fails is logged and retried
 * on the next poll; the worst a stale answer does is let workers claim as early as the server
 * (`routeOffer`'s third reading), never keep the server from a run.
 */
import type { ContextPackRecord, Id, IsoDateTime, RunOfferKind } from '@platform/contracts';
import type { CommandContext, Run } from '@platform/domain';
import type { Broadcast, BroadcastSubscription } from '../ports/broadcast.js';
import type { EventStore } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { RunPlanSealer } from '../ports/run-plan-sealer.js';
import {
  type ClaudeRunner,
  notStartedReportOf,
  type RunHandle,
  type RunOutcome,
  RunStartError,
  runStoppedReasonOf,
} from '../ports/runner.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { type ClaimAdmission, ClaimAdmissionRefused } from './claim-admission.js';
import {
  cliSpawnNotRequested,
  isStopEnding,
  recordCliSpawn,
  stopEndingOf,
  stoppedBeforeCliSpawn,
  unspawnedStepOf,
  unspawnedStop,
} from './cli-spawn.js';
import {
  leaseExpiryAt,
  RUN_LEASE_TTL_MS,
  type RunLeaseLoss,
  type RunLeaseOptions,
  startRunHeartbeat,
} from './lease.js';
import { claimRunOffer, RUN_OFFERS_TOPIC, recordClaim } from './offers.js';
import { toRunAggregate } from './run-aggregate.js';
import { loadRunPackage } from './run-package.js';
import type { RunSecretEnvironment } from './run-redaction.js';
import type { SettleRunRequest } from './settle.js';
import type { RunStopReasons } from './stop-reasons.js';
import { LeaseLostError, type PipelineStore, type RunLeaseFence } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';

/** How often the loop asks for an offer when no notification woke it (TD-031: a 5 s poll). */
export const DEFAULT_CLAIM_POLL_MS = 5_000;

/** `APP_RUNNER_CONCURRENCY`'s default: one run at a time per server claimant. */
export const DEFAULT_RUNNER_CONCURRENCY = 1;

/** How long a `server_claimants` row is fresh after a renewal: three renewals (WP-278). */
export const SERVER_CLAIMANT_TTL_MS = 60_000;
/** How often a started claimant renews its row, at the latest; checked on every poll. */
export const SERVER_CLAIMANT_RENEW_MS = 20_000;

/** How a run's ending answered — the slice of `SettleRunResult` (or the ask's) the claimant reads. */
export interface ClaimantSettled {
  readonly kind: 'settled' | 'already_settled' | 'task_gone';
}

export interface RunClaimantOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly runner: ClaudeRunner;
  readonly stopReasons: RunStopReasons;
  readonly context: (correlationId: Id) => CommandContext;
  /** The claim's instant — the lease's `now`. */
  readonly clock: { now(): IsoDateTime };
  /** The seal the stored plan is opened with (WP-275a). */
  readonly runPlans: RunPlanSealer;
  /** This process's `agentRunEnvironment` — the secret values re-attached to the read-back spec. */
  readonly runEnvironment?: RunSecretEnvironment;
  /** The run stream's next sequence — what `run.claimed` is appended at. */
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  /**
   * The lease this claimant writes at the claim and renews (`server:<process>`). Absent is a
   * composition that runs no heartbeat — the claim still increments the epoch.
   */
  readonly lease?: RunLeaseOptions;
  /**
   * The run's ending, by its offer's kind: a stage run through `settleRun`, an ask's through the
   * ask's own ending (TD-031 decision 13). Both throw `LeaseLostError` for a stale fence.
   */
  readonly settle: Readonly<
    Record<RunOfferKind, (request: SettleRunRequest) => Promise<ClaimantSettled>>
  >;
  /**
   * Withdraws every open offer that has **no** stored plan and escalates (or refuses) what it served,
   * naming `run_plan_missing` (TD-031's 2026-11-04 amendment §2). Asked once per poll and first in
   * every drain; answers how many it found.
   */
  readonly unplanned?: () => Promise<number>;
  /**
   * TD-031 §2's admission re-check at the claim (backlog 744, `claim-admission.ts`): asked inside
   * the claim's transaction; a refusal rolls the claim back, withdraws the offer and pauses the
   * task. Absent asks nothing — every production composition passes one.
   */
  readonly admission?: ClaimAdmission;
  /** `APP_RUNNER_CONCURRENCY`. @default DEFAULT_RUNNER_CONCURRENCY */
  readonly concurrency?: number;
  /** @default DEFAULT_CLAIM_POLL_MS */
  readonly pollIntervalMs?: number;
  readonly logger?: Logger;
}

export interface RunClaimant {
  /**
   * Claims and runs offers until none is claimable, and resolves when every run it started has
   * settled — answering how many it ran. The test harness's worker; production runs {@link start}.
   */
  drain(): Promise<number>;
  /** Wakes the loop: claim while a slot is free. */
  wake(): void;
  /** Listens on `RUN_OFFERS_TOPIC` and polls. Idempotent. */
  start(broadcast?: Broadcast): Promise<void>;
  /** Stops claiming; resolves when the runs in flight have settled (their stop is the runtime's). */
  stop(): Promise<void>;
  /** Runs in flight now. */
  readonly active: number;
}

/** What the claim transaction hands the session. */
interface Claimed {
  readonly runId: Id;
  readonly taskId: Id;
  readonly kind: RunOfferKind;
  readonly run: Run;
  readonly fence: RunLeaseFence;
  readonly contextPack: ContextPackRecord | null;
  /** The monotonic instant the claim's transaction began — the first renewal's send. */
  readonly claimedAt: number;
}

/** No model credential in this process — the default of a composition that names none. */
const NO_RUN_ENVIRONMENT: RunSecretEnvironment = { env: {}, secretEnvNames: [] };

export const createRunClaimant = (options: RunClaimantOptions): RunClaimant => {
  const { unitOfWork, store, runner, stopReasons } = options;
  const logger = options.logger ?? silentLogger;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_RUNNER_CONCURRENCY);
  const pollMs = options.pollIntervalMs ?? DEFAULT_CLAIM_POLL_MS;
  const monotonic = options.lease?.monotonicNow ?? (() => performance.now());
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  /** Every claim this claimant has made — what `drain` answers the difference of. */
  let claimedSoFar = 0;
  let filling: Promise<number> | null = null;
  let subscription: BroadcastSubscription | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  /** WP-278: the `server_claimants` holder — the lease owner — or `null` with no lease. */
  const holder = options.lease?.owner ?? null;
  let renewedAt: number | null = null;

  /** Writes or renews this claimant's liveness row when it is due; a failure waits for the next poll. */
  const renewLiveness = async (): Promise<void> => {
    if (holder === null || stopping) return;
    if (renewedAt !== null && monotonic() - renewedAt < SERVER_CLAIMANT_RENEW_MS) return;
    try {
      await unitOfWork.transaction(async (scope) =>
        store.execution.renewServerClaimant(scope.tx, { holder, ttlMs: SERVER_CLAIMANT_TTL_MS }),
      );
      renewedAt = monotonic();
    } catch (error) {
      logger.warn(
        { err: error, holder },
        'the server claimant could not renew its liveness row; offers written meanwhile may open to workers at once (TD-031 decision 8)',
      );
    }
  };

  /** One claim, in a transaction of its own: the offer, `run.claimed`, and what the session reads. */
  const claimOne = async (): Promise<Claimed | null> => {
    const claimedAt = monotonic();
    return unitOfWork.transaction(async (scope) => {
      const now = options.clock.now();
      const claimed = await claimRunOffer(store.offers, scope.tx, {
        eligibility: {},
        claimantKind: 'server',
        owner: options.lease?.owner ?? null,
        expiresAt:
          options.lease === undefined
            ? null
            : leaseExpiryAt(now, options.lease.ttlMs ?? RUN_LEASE_TTL_MS),
        now,
      });
      if (claimed === null) return null;
      const row = await store.runs.load(scope.tx, claimed.runId);
      if (row === null) return null;
      const context = options.context(row.taskId);
      // The row as it was offered: the claim's own statement already moved it to `starting`.
      const offered = toRunAggregate(
        { ...row, status: 'created' },
        await options.eventStore.nextStreamSequence('run', row.id),
      );
      const forAdmission = {
        runId: row.id,
        taskId: row.taskId,
        projectId: row.projectId,
        kind: claimed.kind,
        stage: row.stage,
      };
      const refusal = (await options.admission?.recheck(scope.tx, forAdmission)) ?? null;
      if (refusal !== null) {
        // Rolls the claim back: the offer is open again for `refuse` to withdraw.
        throw new ClaimAdmissionRefused(forAdmission, refusal);
      }
      const recorded = recordClaim(offered, claimed, context);
      await scope.events.append(recorded.events);
      return {
        runId: row.id,
        taskId: row.taskId,
        kind: claimed.kind,
        run: recorded.run,
        fence: recorded.fence,
        // Backlog 709: `run.started`'s record is read back from what transaction 1b stored.
        contextPack: await store.runs.contextPack(scope.tx, row.id),
        claimedAt,
      };
    });
  };

  /** The run's ending through its kind's settle; a stale fence is logged, never thrown on. */
  const settle = async (claimed: Claimed, request: Omit<SettleRunRequest, 'runId' | 'fence'>) => {
    try {
      const settled = await options.settle[claimed.kind]({
        runId: claimed.runId,
        fence: claimed.fence,
        ...request,
      });
      logger.info(
        {
          run_id: claimed.runId,
          task_id: claimed.taskId,
          kind: claimed.kind,
          settled: settled.kind,
        },
        'run settled by this claimant',
      );
      if (settled.kind === 'task_gone') {
        logger.info(
          { run_id: claimed.runId, task_id: claimed.taskId },
          'the run’s task was deleted while it ran (task_gone); its workspace is destroyed and nothing is written',
        );
      }
    } catch (error) {
      if (!(error instanceof LeaseLostError)) throw error;
      logger.warn(
        { run_id: claimed.runId, task_id: claimed.taskId, lease_epoch: claimed.fence.epoch },
        'the run is held under another claim (lease_lost); this claimant wrote nothing about it',
      );
    }
  };

  /** One run, from the claim to its settle — the session the job ran until WP-276. */
  const session = async (claimed: Claimed): Promise<void> => {
    const { runId } = claimed;
    let handle: RunHandle | null = null;
    let lost: RunLeaseLoss | null = null;
    const stopForLoss = (): void => {
      // The stop destroys the workspace: the workspace runner releases it when the outcome resolves.
      handle?.stop({ reason: 'cancelled' }).catch((error: unknown) => {
        logger.warn(
          { err: error, run_id: runId },
          'a run that lost its lease could not be stopped',
        );
      });
    };
    const stopHeartbeat =
      options.lease === undefined
        ? async (): Promise<void> => {}
        : startRunHeartbeat(
            {
              unitOfWork,
              store,
              clock: { now: () => options.context(claimed.taskId).clock.now() },
              lease: options.lease,
              logger,
              claimedAt: claimed.claimedAt,
              onLost: (loss) => {
                lost = loss;
                logger.warn(
                  { run_id: runId, task_id: claimed.taskId, loss },
                  'this claimant lost the run; its session is stopped and its workspace destroyed',
                );
                stopForLoss();
              },
            },
            runId,
            claimed.fence.epoch,
          );
    const spawn = recordCliSpawn({
      unitOfWork,
      runs: store.runs,
      now: () => options.context(claimed.taskId).clock.now(),
      run: claimed.run,
      contextPack: claimed.contextPack ?? EMPTY_UNRECORDED_PACK,
      fence: claimed.fence,
      context: options.context(claimed.taskId),
      logger,
    });
    let outcome: RunOutcome;
    try {
      if (claimed.contextPack === null) {
        throw new RunStartError(
          `run ${runId} cannot be started: its stored context pack could not be read back`,
          {
            retryable: false,
            diagnosis: { kind: 'invalid_spec', reason: 'run_plan_unreadable', commit: null },
          },
        );
      }
      const spec = await unitOfWork.transaction(
        async (scope) =>
          (
            await loadRunPackage(
              { runPlans: store.runPlans, sealer: options.runPlans },
              scope.tx,
              runId,
              options.runEnvironment ?? NO_RUN_ENVIRONMENT,
            )
          ).spec,
      );
      handle = runner.start(spec, spawn.hooks);
      if (lost !== null) stopForLoss();
      outcome = await handle.outcome;
      if (!spawn.mayHaveReachedCli() && !isStopEnding(outcome)) {
        throw cliSpawnNotRequested(outcome, spawn);
      }
    } catch (error) {
      await stopHeartbeat();
      stopReasons.forget(runId);
      if (lost === 'self_terminated') return;
      const report = notStartedReportOf(error, { spawnRequested: spawn.mayHaveReachedCli() });
      logger.error(
        { err: error, run_id: runId, task_id: claimed.taskId, transient: report.transient },
        'the claimant could not start this run; it is settled as not started',
      );
      await settle(claimed, { outcome: report, stopReason: null });
      return;
    }
    await stopHeartbeat();
    const stopReason = runStoppedReasonOf(stopReasons.reasonFor(runId));
    stopReasons.forget(runId);
    if (lost === 'self_terminated') {
      // Pushes nothing more (TD-031 §2): the row is the sweep's, after the skew grace.
      return;
    }
    if (!spawn.mayHaveReachedCli()) {
      outcome = unspawnedStop(
        outcome,
        stoppedBeforeCliSpawn({
          ending: stopEndingOf(outcome),
          step: unspawnedStepOf(spawn),
          attempt: 1,
          retryable: false,
        }),
      );
    }
    await settle(claimed, { outcome, stopReason });
  };

  /** Claims while a slot is free; answers how many it claimed this pass. */
  const fillOnce = async (): Promise<number> => {
    let claimedCount = 0;
    while (!stopping && inFlight.size < concurrency) {
      let claimed: Claimed | null;
      try {
        claimed = await claimOne();
      } catch (error) {
        if (error instanceof ClaimAdmissionRefused && options.admission !== undefined) {
          // A refusal that paused its task closed its offer, so the next claim finds another; one
          // that did not would find the same offer again, so the loop waits for the next wake-up.
          if (await refuseAtClaim(options.admission, error)) continue;
          break;
        }
        logger.error(
          { err: error },
          'the claimant could not claim an offer; the next wake-up tries again',
        );
        break;
      }
      if (claimed === null) break;
      claimedCount += 1;
      claimedSoFar += 1;
      const running = session(claimed)
        .catch((error: unknown) => {
          logger.error(
            { err: error, run_id: claimed.runId, task_id: claimed.taskId },
            'a claimed run ended with an error the claimant could not record; the lease sweep ends its row',
          );
        })
        .finally(() => {
          inFlight.delete(running);
          if (!stopping) wake();
        });
      inFlight.add(running);
    }
    return claimedCount;
  };

  /** The refused claim's ending, in its own transaction: the offer withdrawn, the task paused. */
  const refuseAtClaim = async (
    admission: ClaimAdmission,
    refused: ClaimAdmissionRefused,
  ): Promise<boolean> => {
    try {
      return await retryOnTaskConflict(
        { taskId: refused.claimed.taskId, what: 'refusing a claim', logger },
        () =>
          unitOfWork.transaction((scope) =>
            admission.refuse(scope, refused.claimed, refused.refusal),
          ),
      );
    } catch (error) {
      logger.error(
        { err: error, run_id: refused.claimed.runId, task_id: refused.claimed.taskId },
        'a claim refused at admission could not pause its task; the offer stays open and the next wake-up asks again',
      );
      return false;
    }
  };

  const fill = (): Promise<number> => {
    filling ??= fillOnce().finally(() => {
      filling = null;
    });
    return filling;
  };

  const wake = (): void => {
    void fill();
  };

  const sweepUnplanned = async (): Promise<void> => {
    if (options.unplanned === undefined) return;
    try {
      await options.unplanned();
    } catch (error) {
      logger.error({ err: error }, 'the claimant could not withdraw an offer that has no plan');
    }
  };

  return {
    get active() {
      return inFlight.size;
    },
    drain: async () => {
      const before = claimedSoFar;
      await sweepUnplanned();
      for (;;) {
        await filling;
        const claimed = await fill();
        if (inFlight.size === 0 && claimed === 0) return claimedSoFar - before;
        await Promise.all([...inFlight]);
      }
    },
    wake,
    start: async (broadcast) => {
      if (stopping || poll !== null) return;
      if (broadcast !== undefined) {
        subscription = await broadcast.subscribe([RUN_OFFERS_TOPIC], () => wake());
      }
      await renewLiveness();
      const timer = setInterval(() => {
        void renewLiveness().then(sweepUnplanned).then(wake);
      }, pollMs);
      (timer as { unref?: () => void }).unref?.();
      poll = timer;
      void sweepUnplanned().then(wake);
    },
    stop: async () => {
      stopping = true;
      if (poll !== null) clearInterval(poll);
      poll = null;
      const held = subscription;
      subscription = null;
      await held?.close();
      await filling;
      await Promise.all([...inFlight]);
      if (holder !== null && renewedAt !== null) {
        try {
          await unitOfWork.transaction(async (scope) =>
            store.execution.releaseServerClaimant(scope.tx, holder),
          );
        } catch (error) {
          logger.warn(
            { err: error, holder },
            'the server claimant could not delete its liveness row; it expires on its own',
          );
        }
      }
    },
  };
};

/**
 * Handed to the spawn record only when the stored pack could not be read — and then the run never
 * reaches its marker: the session throws a terminal start failure before `runner.start`.
 */
const EMPTY_UNRECORDED_PACK: ContextPackRecord = {
  tier0: [],
  tier1: [],
  budget_tokens: 0,
  total_tokens: 0,
};
