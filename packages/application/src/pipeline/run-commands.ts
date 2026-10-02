/**
 * A human command reaches a live run **through the database** — TD-028 decision 9 (M5 amendment),
 * WP-85, PROGRESS backlog 134.
 *
 * The live-run register (`./live-runs.ts`) is per process, and the shipped topology pins the process
 * that serves the API never to hold a run. So the command is not delivered by the process that
 * answers it: `./commands.ts` **records** it as a `run_commands` row in the command's own
 * transaction and wakes the run's lease holder with `pg_notify`; this module is the holder's half.
 *
 * ```
 *   api:    lock run (for share) ─ insert run_commands ─ pg_notify(run.commands:<owner>) ─ commit ─▶ 202
 *                                                                │
 *   holder: LISTEN ◀─────────────────────────────────────────────┘   (latency)
 *           heartbeat, per leased run ───────────────────────────────  (the guarantee)
 *           runner.start of a run ───────────────────────────────────  (the start window)
 *             └─▶ pending rows for my leased runs ─▶ markApplied (conditional) ─▶ handle.steer / stop
 * ```
 *
 * ## Five decisions
 *
 *  1. **The notification is latency; the heartbeat poll is the guarantee.** A notification is not
 *     delivered to a connection that was reconnecting, so the lease heartbeat (`./lease.ts`) drains
 *     its own run's pending rows on every beat that renewed the lease. A command recorded while the
 *     holder's `LISTEN` was down is applied within one heartbeat.
 *  2. **`markApplied` is the arbiter** (standing rule 9). Three paths can find one pending row — the
 *     notification, the beat and a run's start — and they may run concurrently in this process or,
 *     in a scaled-out deployment, never agree on anything but the database. The stamp is a
 *     conditional `update` under a `for share` lock on the run: whichever path stamps first delivers,
 *     every other one reads `false` and does nothing. **The stamp commits before the delivery**, so a
 *     delivery that throws leaves an `applied` row whose turn the session did not take; the other
 *     order would let two paths deliver one turn twice, which the run pays for and nobody can take
 *     back. A delivery that throws (a session closing near its end) turns the stamp into the
 *     refusal `delivery_failed` — conditionally, and never back to pending — so the run screen does
 *     not state a turn the session did not take, and the command is not retried (review round 1).
 *     A stop — a take-over's or, since WP-101, a cancel's — is not awaited (it resolves with the
 *     run's outcome), so its later rejection is logged and the row keeps `applied`: the stop *was*
 *     delivered.
 *  3. **A register miss is not always a refusal.** A run's row is `running` and leased to this
 *     process from the transaction that created it, a moment **before** `runner.start` registers its
 *     handle; a notification that lands in that window finds no handle for a run that is about to
 *     have one. So a miss on the notification and start paths leaves the row pending (the start
 *     path drains again once the handle exists), and only the **heartbeat** — which beats long after
 *     the start and stops the moment the outcome settles — stamps `register_miss`. A row still
 *     pending when the run ends is closed `run_ended` by the run's own ending
 *     (`RunRepository.finish`), so no row waits for ever. A **stop** (cancel, take-over) refused
 *     `register_miss` while its run still reads `running` and leased here is logged at `error`
 *     (WP-119, PROGRESS backlog 336): the session it was meant to stop, if it still runs, runs on
 *     unseen, bounded by its wall clock and budget. The reach is stated at `MAX_LIVE_RUNS`.
 *  4. **One drain at a time per process.** Drains are chained, so two wake-ups cannot interleave
 *     their deliveries out of the order the rows were recorded in, and `stop()` waits for the one in
 *     flight — the composition root closes the pool on the lines after it.
 *  5. **A steer behind a stop is never handed out** (WP-101). Once a run has a `cancel` or a
 *     `take_over` row that is not refused, `RunCommandRepository.pending` stops listing its steers,
 *     so a turn is not pushed into a session that is being stopped — a turn the run would pay for
 *     and nobody would read — and the run's own ending closes them `run_ended`, like any command
 *     still pending when a run ends. A steer recorded *before* the stop is included: the stop is the
 *     later instruction and it is the one that stands.
 *
 * Nothing here is a network route: the holder has no listener and no address, which is what
 * decision 2 of TD-028 exists to keep (the alternatives the amendment rejected are recorded there).
 */
import type { Id } from '@platform/contracts';
import type { Broadcast, BroadcastSubscription } from '../ports/broadcast.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { ClaudeRunner } from '../ports/runner.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { LiveRun, LiveRuns } from './live-runs.js';
import type { PendingRunCommand, PipelineStore, RunCommandInstruction } from './store.js';

/** The dotted prefix of the topic a holder listens on; the suffix is keyed by its lease owner. */
export const RUN_COMMANDS_TOPIC = 'run.commands';

/** The most pending rows one drain pass reads; a burst beyond it is taken by the next pass. */
export const RUN_COMMAND_DRAIN_BATCH = 50;

/**
 * FNV-1a over UTF-16 code units, 32 bits, as eight hex digits. Not a security property: the topic
 * only routes a wake-up, the payload carries the owner verbatim and the listener compares it, and a
 * collision costs one drain that finds nothing.
 */
const fnv1a = (text: string, seed: number): string => {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

/**
 * The broadcast topic a lease holder listens on — TD-028 decision 9's *"a channel keyed by
 * `runs.lease_owner`"*.
 *
 * A lease owner is `hostname:suffix` and a topic's key admits `[A-Za-z0-9_-]{1,64}` only
 * (`TOPIC_PATTERN`), so the key is a digest of the owner rather than the owner itself. The Postgres
 * adapter carries every topic on one `LISTEN` and filters in the process, so keying costs nothing.
 */
export const runCommandsTopic = (owner: string): string =>
  `${RUN_COMMANDS_TOPIC}:${fnv1a(owner, 0x811c9dc5)}${fnv1a(owner, 0x01000193)}`;

/** The notification's payload. A `type` so it is assignable to the broadcast's `JsonObject`. */
export type RunCommandWakeUp = {
  readonly lease_owner: string;
  readonly run_id: string;
};

/** What a drain does with a pending row whose run has no handle in this process's register. */
export type RegisterMiss = 'wait' | 'refuse';

export interface RunCommandInboxDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: Pick<PipelineStore, 'runCommands'>;
  /** The same register the runner is wrapped with, so a handle found here is the live session. */
  readonly liveRuns: LiveRuns;
  /** This process's lease owner — the one `./lease.ts` claims runs under. */
  readonly owner: string;
  readonly logger?: Logger;
  /** @default RUN_COMMAND_DRAIN_BATCH */
  readonly batchSize?: number;
}

export interface RunCommandInbox {
  readonly owner: string;
  /**
   * Applies what is pending for this holder — every leased run, or one. Resolves when the pass is
   * done and **never rejects**: every caller is a wake-up with nobody to tell, so a failure is
   * logged and the next wake-up (at the latest, the next beat) tries again.
   */
  drain(request?: { readonly runId?: Id; readonly onMiss?: RegisterMiss }): Promise<void>;
  /**
   * Wraps a runner so that a run's start drains that run's pending rows once its handle is
   * registered — the other end of decision 3's start window. Wrap **outside** `liveRuns.observe`,
   * so the handle is in the register by the time the drain looks.
   */
  observe(runner: ClaudeRunner): ClaudeRunner;
  /** Subscribes to this owner's topic on the broadcast; a wake-up drains every leased run. */
  listen(broadcast: Broadcast): Promise<void>;
  /** Stops listening and waits for the drain in flight. Idempotent. */
  stop(): Promise<void>;
}

export const createRunCommandInbox = (deps: RunCommandInboxDependencies): RunCommandInbox => {
  const logger = deps.logger ?? silentLogger;
  const batchSize = deps.batchSize ?? RUN_COMMAND_DRAIN_BATCH;
  const topic = runCommandsTopic(deps.owner);
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;
  let subscription: BroadcastSubscription | null = null;
  /** A drain of every leased run that is queued and has not started: a second one adds nothing. */
  let allQueued = false;

  const deliver = (
    row: PendingRunCommand,
    instruction: RunCommandInstruction,
    live: LiveRun,
  ): Promise<void> => {
    if (instruction.kind === 'steer') {
      return live.handle.steer({
        text: instruction.text,
        authorUserId: instruction.authorUserId,
        authorLabel: instruction.authorLabel,
      });
    }
    // Not awaited, as the take-over always was (`./commands.ts`): the stop resolves with the run's
    // outcome — interrupt, grace, the export, teardown — and the drain must not hold every other
    // command behind one run's wind-down. A cancel (WP-101, TD-028 decision 11) is the same stop
    // without the export: the run then ends `cancelled` in this process, with the cost its session
    // measured, through the stage executor's own ending.
    const stop =
      instruction.kind === 'cancel'
        ? live.handle.stop({ reason: 'cancelled' })
        : live.handle.stop({
            reason: 'taken_over',
            workspaceExport: {
              branch: instruction.branch,
              commitMessage: instruction.commitMessage,
              tarball: instruction.tarball,
              keepUntil: instruction.keepUntil,
            },
          });
    void stop.catch((error: unknown) => {
      logger.error(
        {
          err: error,
          run_id: row.runId,
          task_id: row.taskId,
          command_id: row.id,
          kind: instruction.kind,
        },
        instruction.kind === 'cancel'
          ? 'the cancelled run could not be stopped; its session may still be running'
          : 'the taken-over run could not be stopped; its workspace may not have been exported',
      );
    });
    return Promise.resolve();
  };

  /** Settles one row; answers whether it did (applied or refused), for the pass's progress test. */
  const settle = async (row: PendingRunCommand, onMiss: RegisterMiss): Promise<boolean> => {
    const instruction = row.instruction;
    if (instruction === null) {
      // Refused by itself (review round 1): a row this build cannot read would otherwise be read,
      // fail and be read again on every wake-up until the run ended, holding up nothing but itself.
      const refused = await deps.unitOfWork.transaction(async (scope) =>
        deps.store.runCommands.markRefused(scope.tx, { id: row.id, reason: 'undecodable' }),
      );
      if (refused) {
        logger.error(
          { run_id: row.runId, command_id: row.id, kind: row.kind },
          'a run command’s stored payload is not a shape this build can deliver; it was refused undecodable',
        );
      }
      return true;
    }
    const live = deps.liveRuns.forRun(row.runId);
    if (live === null) {
      if (onMiss === 'wait') {
        return false;
      }
      const { refused, leakedSession } = await deps.unitOfWork.transaction(async (scope) => {
        // A stop refused here leaves a session nobody will stop, if one still runs (PROGRESS backlog
        // 336). The run row says whether one may: still `running` and still leased to this process.
        // Read **first**, under the run's `for share` lock — the order `markApplied` takes and the
        // one `RunRepository.finish` meets (run row, then its commands), so the refusal and an
        // ending cannot wait on each other in opposite orders.
        const run =
          instruction.kind === 'steer'
            ? null
            : await deps.store.runCommands.lockRun(scope.tx, row.runId);
        const marked = await deps.store.runCommands.markRefused(scope.tx, {
          id: row.id,
          reason: 'register_miss',
        });
        return {
          refused: marked,
          leakedSession: marked && run?.status === 'running' && run.leaseOwner === deps.owner,
        };
      });
      if (leakedSession) {
        // Option (a) of backlog 336's ruling (M7, WP-119): a register miss on a live lease is a
        // leaked handle — see `MAX_LIVE_RUNS` for the one route there is to it — and the stop the
        // human asked for is not delivered, so the session spends until its own wall clock or
        // budget ends it. Logged once: `markRefused` stamps a pending row exactly once.
        //
        // **One benign route reads the same, and the line names it** (read off the tree, not
        // measured): a beat's drain that read the row pending just before the session's outcome
        // settled finds the handle already dropped, while the run row still reads `running` —
        // the stage executor records the ending only after the beat in flight (`stopHeartbeat`).
        // That session has ended, so nothing leaked; its run ends within the same job.
        logger.error(
          {
            run_id: row.runId,
            task_id: row.taskId,
            command_id: row.id,
            kind: instruction.kind,
            lease_owner: deps.owner,
          },
          'a stop for a run this process still leases and still reads running found no live session in its register and was refused register_miss: the handle leaked (evicted past MAX_LIVE_RUNS) and the session runs on until its own wall clock or budget ends it — unless the session ended during this very drain, in which case the run records its own ending next',
        );
      } else if (refused) {
        logger.warn(
          { run_id: row.runId, command_id: row.id, kind: instruction.kind },
          'a command for a run this process holds the lease of found no live session in its register, and was refused register_miss',
        );
      }
      return refused;
    }
    const applied = await deps.unitOfWork.transaction(async (scope) =>
      deps.store.runCommands.markApplied(scope.tx, { id: row.id, owner: deps.owner }),
    );
    if (!applied) {
      // Another path stamped it, the run ended, or the lease is not ours: nothing to deliver.
      return true;
    }
    try {
      await deliver(row, instruction, live);
    } catch (error) {
      // The stamp stays the arbiter; what it says is corrected (review round 1). Conditional on it
      // still reading applied, and never back to pending, so no wake-up can deliver it again.
      const corrected = await deps.unitOfWork
        .transaction(async (scope) =>
          deps.store.runCommands.markDeliveryFailed(scope.tx, { id: row.id }),
        )
        .catch((markError: unknown) => {
          logger.error(
            { err: markError, run_id: row.runId, command_id: row.id },
            'a failed delivery could not be recorded; the command still reads applied',
          );
          return false;
        });
      logger.error(
        { err: error, run_id: row.runId, command_id: row.id, kind: instruction.kind, corrected },
        'a run command’s delivery to the live session failed; it is refused delivery_failed and not retried',
      );
    }
    return true;
  };

  const pass = async (runId: Id | undefined, onMiss: RegisterMiss): Promise<void> => {
    for (;;) {
      if (stopped) {
        return;
      }
      const rows = await deps.unitOfWork.transaction(async (scope) =>
        deps.store.runCommands.pending(scope.tx, {
          owner: deps.owner,
          ...(runId === undefined ? {} : { runId }),
          limit: batchSize,
        }),
      );
      let settled = 0;
      for (const row of rows) {
        if (stopped) {
          return;
        }
        if (await settle(row, onMiss)) {
          settled += 1;
        }
      }
      // A full page that settled nothing would be read again unchanged: stop, the next wake-up
      // (the start, the beat or the ending) is what moves those rows.
      if (rows.length < batchSize || settled === 0) {
        return;
      }
    }
  };

  const drain: RunCommandInbox['drain'] = (request = {}) => {
    const onMiss = request.onMiss ?? 'wait';
    if (stopped) {
      return Promise.resolve();
    }
    const all = request.runId === undefined && onMiss === 'wait';
    if (all && allQueued) {
      return tail;
    }
    if (all) {
      allQueued = true;
    }
    tail = tail.then(async () => {
      if (all) {
        allQueued = false;
      }
      try {
        await pass(request.runId, onMiss);
      } catch (error) {
        logger.warn(
          { err: error, run_id: request.runId ?? null, lease_owner: deps.owner },
          'draining pending run commands failed; the next wake-up or heartbeat will try again',
        );
      }
    });
    return tail;
  };

  return {
    owner: deps.owner,
    drain,
    observe: (runner) => ({
      start: (spec) => {
        const handle = runner.start(spec);
        void drain({ runId: spec.runId });
        return handle;
      },
    }),
    listen: async (broadcast) => {
      if (stopped || subscription !== null) {
        return;
      }
      subscription = await broadcast.subscribe([topic], (message) => {
        // The topic is a digest of the owner, so the payload's owner is what decides (a collision
        // is another process's wake-up). Anything malformed is dropped: nobody to refuse to.
        const wakeUp = message.payload as Partial<RunCommandWakeUp>;
        if (wakeUp.lease_owner !== deps.owner) {
          return;
        }
        void drain();
      });
      // A wake-up sent while this process was not yet listening is exactly the one the poll exists
      // for; one pass now covers the commands recorded before the subscription came up.
      void drain();
    },
    stop: async () => {
      if (stopped) {
        await tail;
        return;
      }
      stopped = true;
      const held = subscription;
      subscription = null;
      await held?.close();
      await tail;
    },
  };
};
