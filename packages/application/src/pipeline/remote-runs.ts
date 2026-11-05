/**
 * **The core's half of the worker protocol** — WP-281, TD-031 decisions 2, 3, 6, 7, 8 and 14, and its
 * 2026-11-04 amendments §§1, 3 and 4.
 *
 * A remote worker (BD-032) claims an offer over HTTP (`apps/server/src/routes/worker/`), and every
 * write it makes afterwards goes through one of these commands, each fenced on the claim's
 * `(run_id, epoch)` and the owner `worker:<id>` derived from the **authenticated** worker — never
 * from a request body:
 *
 * | command | what it writes | refused as |
 * |---|---|---|
 * | {@link RemoteRuns.claim} | the one claim (`RunOfferRepository.claim`, worker eligibility in the statement), `run.claimed`, the run token's hash; **after the commit** the package — the stored plan opened, the git credential minted | — (`none`) |
 * | {@link RemoteRuns.heartbeat} | the lease renewed (`now + 10 min`), acks stamped; answers pending commands | `lease_lost` |
 * | {@link RemoteRuns.release} | the claim undone (offer `claimed → open`, run `starting → created`), `run.offer.released`; the minted credential revoked after the commit | `run_started`, `lease_lost` |
 * | {@link RemoteRuns.spawn} | the CLI spawn marker and `run.started` (WP-275b's transaction) | `lease_lost` |
 * | {@link RemoteRuns.finish} | `settleRun` with the four-field request; the minted credential revoked after it | `lease_lost`, `run_gone` |
 * | {@link RemoteRuns.lateCost} | `cost/late.ts`'s narrow write and ledger rows | `lease_lost`, `run_live` |
 *
 * ## After the claim commits
 *
 * The git credential is minted **after** the claim's transaction commits (`assertOutsideTransaction`,
 * TD-028's WP-76 amendment) and before the package is answered (TD-031 §2). Two endings:
 *
 * - the package — answered;
 * - **the run cannot be packaged** — the credential could not be minted, the plan cannot be read
 *   back, a writing run's binding can mint nothing, the package the schema refuses — and the run
 *   **settles as `not_started`** under the worker's claim, exactly as the server's claimant settles a
 *   start that threw. A mint failure is **never a release** (TD-031's 2026-11-05 amendment, backlog
 *   740): it is retryable as the mint error says (`IntegrationError.retryable`), so Q59(a)'s bound —
 *   `RUN_START_RETRY_MS` apart, `MAX_RUN_START_ATTEMPTS` per stage entry, then `needs_human` — ends a
 *   provider that refuses every mint, and no worker is excluded for the provider's fault.
 *
 * ## The run token
 *
 * 32 random bytes minted per claim ({@link RunTokens}), stored only as its SHA-256 on the offer with
 * its epoch. {@link RemoteRuns.authenticate} accepts it while the offer's last remote claimant may
 * still act (not revoked, its user not banned or disabled) and until fifteen minutes after the run's
 * terminal write (`WORKER_RUN_TOKEN_AFTER_END_MS`, for `late-cost`). It never names the epoch a call
 * may use — every command checks the epoch it is given against the run row.
 */
import type {
  Id,
  IsoDateTime,
  JsonObject,
  ModelUsage,
  RunCost,
  RunReleaseReason,
  RunSpec,
  RunStatus,
  RunTerminalReason,
  TokenUsage,
  RunPackage as WorkerRunPackage,
} from '@platform/contracts';
import {
  WORKER_REMOTE_LEASE_TTL_MS,
  WORKER_RUN_TOKEN_AFTER_END_MS,
  type workerFinishRequestSchema,
} from '@platform/contracts';
import {
  type CommandContext,
  isActiveRunStatus,
  markRunning,
  releaseRunClaim,
} from '@platform/domain';
import type * as z from 'zod';
import type { LateCostRecorder } from '../cost/late.js';
import type { EventStore } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { RunPlanSealer } from '../ports/run-plan-sealer.js';
import {
  type NotStartedReport,
  notStartedReportOf,
  type RunOutcome,
  type RunStoppedReason,
} from '../ports/runner.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { type ClaimAdmission, ClaimAdmissionRefused } from './claim-admission.js';
import { leaseExpiryAt } from './lease.js';
import { claimRunOffer, RUN_OFFERS_TOPIC, recordClaim, workerLeaseOwner } from './offers.js';
import { toRunAggregate } from './run-aggregate.js';
import { openRunPlan } from './run-package.js';
import type { SettleRunRequest, SettleRunResult } from './settle.js';
import {
  LeaseLostError,
  type PendingRunCommand,
  type PipelineStore,
  type RunCommandRefusal,
} from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';

/** How many pending commands one heartbeat answers (the wire schema's bound). */
export const REMOTE_COMMANDS_PER_HEARTBEAT = 256;

/** The run token and its stored form (TD-031 decision 7). */
export interface RunTokens {
  /** 32 fresh random bytes, unpadded base64url, and the SHA-256 hex that is stored. */
  mint(): { readonly token: string; readonly hash: string };
  /** The stored form of a presented token. */
  hashOf(token: string): string;
  /** Constant-time comparison of two stored forms. */
  same(a: string, b: string): boolean;
}

/** The run and egress images by digest (TD-031 decision 4). */
export interface RemoteRunImages {
  readonly run: string;
  readonly egress: string;
}

/**
 * What {@link RemoteRunPackager.build} answers: the package. Every failure is **thrown** — a mint
 * failure as a `RunStartError` whose `retryable` is the mint error's own (TD-031's 2026-11-05
 * amendment), a refusal as a terminal `WorkspaceError` — and settles the run `not_started`.
 */
export type RemotePackageAnswer = { readonly kind: 'package'; readonly package: WorkerRunPackage };

/**
 * Builds a claimed run's package after the claim committed (TD-031 decision 4): the stored spec with
 * no secret value, the launcher's `WorkspaceSpec`, the skills' content, the images and the minted
 * credential. A terminal refusal is **thrown** (a `RunStartError` or a `WorkspaceError`), and the
 * packager revokes whatever it minted before it throws.
 */
export interface RemoteRunPackager {
  build(input: {
    /** The plan as stored — `storedRunSpecSchema`, no secret value in its environment. */
    readonly spec: RunSpec;
    readonly epoch: number;
    readonly runToken: string;
    readonly images: RemoteRunImages;
    readonly leaseTtlMs: number;
  }): Promise<RemotePackageAnswer>;
}

/**
 * Revokes a run's minted git credentials from what is stored (the mint's audit row's address), from
 * any process — the one that minted may not be the one a release or a finish reaches. Never throws:
 * a failure is logged, and the WP-77 recovery pass reaches a terminal run's credential again.
 */
export interface RemoteRunCredentials {
  /**
   * `mintedBefore` scopes a release's revoke to the mints recorded by then — the released claim's —
   * so a credential a later claimant of the reopened offer minted is never revoked with it.
   */
  revoke(runId: Id, scope?: { readonly mintedBefore?: IsoDateTime }): Promise<void>;
}

export interface RemoteRunsOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly context: (correlationId: Id) => CommandContext;
  readonly runPlans: RunPlanSealer;
  readonly packager: RemoteRunPackager;
  readonly credentials: RemoteRunCredentials;
  readonly tokens: RunTokens;
  /** `settleRun` over this process's settle collaborators — a stage run's ending. */
  readonly settle: (request: SettleRunRequest) => Promise<SettleRunResult>;
  /**
   * An **ask** run's ending — the ask's own (`AskExecutor.settle`, TD-031 decision 13), WP-283
   * (backlog 741): a worker claims ask offers too, so `finish` of a run that serves an ask settles
   * here. Every production composition supplies it (`apps/server/src/worker-protocol.ts`); a test
   * composition without one has its ask run's `finish` throw by name rather than settle it as a stage.
   */
  readonly settleAsk?: (
    request: SettleRunRequest,
  ) => Promise<{ readonly kind: 'settled' | 'already_settled' | 'task_gone' }>;
  readonly lateCost: LateCostRecorder;
  /** @default WORKER_REMOTE_LEASE_TTL_MS */
  readonly leaseTtlMs?: number;
  /**
   * TD-031 §2's admission re-check at the claim (backlog 744, `claim-admission.ts`): a refusal rolls
   * the claim back, withdraws the offer and pauses the task, and the worker is answered `none`.
   * Absent asks nothing — the production composition passes one.
   */
  readonly admission?: ClaimAdmission;
  readonly logger?: Logger;
}

/** A run-scoped call's authenticated subject. */
export interface RunTokenSubject {
  readonly runId: Id;
  readonly workerId: Id;
}

/** A pending command as the heartbeat delivers it (TD-031 §14). */
export interface DeliveredRunCommand {
  readonly id: Id;
  readonly kind: 'steer' | 'take_over' | 'cancel';
  readonly payload: JsonObject;
}

/** An ack of a delivered command, as the heartbeat's body carries it. */
export type RunCommandAck =
  | { readonly commandId: Id; readonly outcome: 'applied' }
  | {
      readonly commandId: Id;
      readonly outcome: 'refused';
      readonly reason: RunCommandRefusal;
    };

export type RemoteClaimAnswer =
  | { readonly kind: 'claimed'; readonly runId: Id; readonly package: WorkerRunPackage }
  /** No eligible offer was open. */
  | { readonly kind: 'none' }
  /**
   * An offer was claimed and could not be packaged — settled `not_started`, its retry (if any)
   * Q59(a)'s. The caller ends its hold rather than claiming again at once.
   */
  | { readonly kind: 'not_packaged'; readonly runId: Id };

export type RemoteHeartbeatAnswer =
  | {
      readonly kind: 'renewed';
      readonly leaseExpiresAt: IsoDateTime;
      readonly commands: readonly DeliveredRunCommand[];
    }
  | { readonly kind: 'lease_lost' };

export type RemoteSpawnAnswer =
  | { readonly kind: 'spawned' | 'already_spawned'; readonly startedAt: IsoDateTime }
  | { readonly kind: 'lease_lost' }
  /** The run recorded no context pack, so `run.started` cannot be written: nothing was. */
  | { readonly kind: 'not_startable' };

export type RemoteFinishAnswer =
  | {
      readonly kind: 'settled' | 'already_settled';
      readonly ending: {
        readonly status: RunStatus;
        readonly terminalReason: RunTerminalReason | null;
        readonly epoch: number;
      };
    }
  | { readonly kind: 'lease_lost' }
  | { readonly kind: 'run_gone' };

export type RemoteLateCostAnswer =
  | { readonly kind: 'recorded'; readonly recorded: boolean }
  | { readonly kind: 'lease_lost' }
  /** The run is still live under this claim: its own `finish` carries its cost. */
  | { readonly kind: 'run_live' }
  | { readonly kind: 'run_gone' };

export interface RemoteLateSpend {
  readonly sessionId: string | null;
  readonly numTurns: number;
  readonly wallMs: number;
  readonly cost: RunCost;
  readonly usage: TokenUsage;
  readonly modelUsage: readonly ModelUsage[];
}

export interface RemoteRuns {
  claim(input: {
    readonly workerId: Id;
    readonly heldImageDigests: readonly string[];
    readonly images: RemoteRunImages;
    readonly now: IsoDateTime;
  }): Promise<RemoteClaimAnswer>;
  /** The run token's subject, or `null` — a wrong token, a worker that may not act, an old run. */
  authenticate(input: {
    readonly runId: Id;
    readonly token: string;
    readonly now: IsoDateTime;
  }): Promise<RunTokenSubject | null>;
  heartbeat(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly acks: readonly RunCommandAck[];
    readonly now: IsoDateTime;
  }): Promise<RemoteHeartbeatAnswer>;
  /** The pending commands again, without renewing — what a held heartbeat re-reads when woken. */
  pending(input: {
    readonly runId: Id;
    readonly workerId: Id;
  }): Promise<readonly DeliveredRunCommand[]>;
  release(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly reason: RunReleaseReason;
    readonly now: IsoDateTime;
  }): Promise<'released' | 'already_released' | 'run_started' | 'lease_lost'>;
  spawn(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly now: IsoDateTime;
  }): Promise<RemoteSpawnAnswer>;
  finish(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly outcome: RunOutcome | NotStartedReport;
    readonly stopReason: RunStoppedReason | null;
  }): Promise<RemoteFinishAnswer>;
  lateCost(input: {
    readonly runId: Id;
    readonly workerId: Id;
    readonly epoch: number;
    readonly spend: RemoteLateSpend;
    readonly now: IsoDateTime;
  }): Promise<RemoteLateCostAnswer>;
}

/** The two release reasons that keep the releasing worker off the offer (TD-031 decision 6). */
const EXCLUDING_RELEASES: readonly RunReleaseReason[] = ['usage_limited', 'provision_failed'];

/** A stored instruction as the wire's payload (snake_case, the house rule for DTOs). */
const deliveredCommandOf = (command: PendingRunCommand): DeliveredRunCommand | null => {
  const instruction = command.instruction;
  if (instruction === null) {
    return null;
  }
  switch (instruction.kind) {
    case 'steer':
      return {
        id: command.id,
        kind: 'steer',
        payload: {
          text: instruction.text,
          author_user_id: instruction.authorUserId,
          author_label: instruction.authorLabel,
        },
      };
    case 'take_over':
      return {
        id: command.id,
        kind: 'take_over',
        payload: {
          branch: instruction.branch,
          commit_message: instruction.commitMessage,
          tarball: instruction.tarball,
          keep_until: instruction.keepUntil,
        },
      };
    case 'cancel':
      return { id: command.id, kind: 'cancel', payload: {} };
  }
};

export const createRemoteRuns = (options: RemoteRunsOptions): RemoteRuns => {
  const { unitOfWork, store } = options;
  const logger = options.logger ?? silentLogger;
  const leaseTtlMs = options.leaseTtlMs ?? WORKER_REMOTE_LEASE_TTL_MS;

  /**
   * The pending commands of the run this owner holds, in the caller's transaction — and a row whose
   * stored payload this build cannot read is refused `undecodable` here, as the in-process holder
   * refuses it (WP-85 review round 1), so it is never handed out again.
   */
  const pendingIn = async (
    tx: Parameters<PipelineStore['runCommands']['pending']>[0],
    owner: string,
    runId: Id,
  ): Promise<readonly DeliveredRunCommand[]> => {
    const rows = await store.runCommands.pending(tx, {
      owner,
      runId,
      limit: REMOTE_COMMANDS_PER_HEARTBEAT,
    });
    const delivered: DeliveredRunCommand[] = [];
    for (const row of rows) {
      const command = deliveredCommandOf(row);
      if (command === null) {
        await store.runCommands.markRefused(tx, { id: row.id, reason: 'undecodable' });
        continue;
      }
      delivered.push(command);
    }
    return delivered;
  };

  /** A claimed run that cannot be packaged settles `not_started` under the worker's claim. */
  const settleUnpackaged = async (
    claimed: { readonly runId: Id; readonly epoch: number; readonly owner: string },
    error: unknown,
  ): Promise<void> => {
    logger.error(
      { err: error, run_id: claimed.runId, lease_epoch: claimed.epoch },
      'a remote claim could not be packaged; the run is settled as not started',
    );
    try {
      await options.settle({
        runId: claimed.runId,
        fence: { epoch: claimed.epoch, owner: claimed.owner },
        outcome: notStartedReportOf(error, { spawnRequested: false }),
        stopReason: null,
      });
    } catch (settleError) {
      logger.error(
        { err: settleError, run_id: claimed.runId },
        'a remote claim that could not be packaged could not be settled either; the lease sweep ends its row',
      );
    }
  };

  /** Whether the run serves an ask (its row names one) — its ending is then the ask's (backlog 741). */
  const isAskRun = async (runId: Id): Promise<boolean> =>
    unitOfWork.transaction(async (scope) => {
      const row = await store.runs.load(scope.tx, runId);
      return row !== null && row.stage === null && (row.askId ?? null) !== null;
    });

  /** An ask's ending, and the run's as its row then stores it — what `finish` answers. */
  const settleAskRun = async (
    request: SettleRunRequest,
  ): Promise<Pick<SettleRunResult, 'kind' | 'ending'>> => {
    if (options.settleAsk === undefined) {
      throw new Error(
        `run ${request.runId} serves an ask and this process composed no ask settle (backlog 741)`,
      );
    }
    const settled = await options.settleAsk(request);
    if (settled.kind === 'task_gone') {
      return { kind: 'task_gone', ending: null };
    }
    const row = await unitOfWork.transaction(async (scope) =>
      store.runs.lockSettlement(scope.tx, request.runId),
    );
    return {
      kind: settled.kind,
      ending:
        row === null || isActiveRunStatus(row.status)
          ? null
          : {
              runId: request.runId,
              epoch: row.leaseEpoch,
              status: row.status,
              terminalReason: row.terminalReason,
            },
    };
  };

  const release: RemoteRuns['release'] = async (input) => {
    const owner = workerLeaseOwner(input.workerId);
    const result = await unitOfWork.transaction(async (scope) => {
      const released = await store.offers.release(scope.tx, {
        runId: input.runId,
        epoch: input.epoch,
        owner,
        reason: input.reason,
        excludeWorkerId: EXCLUDING_RELEASES.includes(input.reason) ? input.workerId : null,
        now: input.now,
      });
      if (released.kind !== 'released') {
        return released.kind;
      }
      const row = await store.runs.load(scope.tx, input.runId);
      if (row === null) {
        throw new Error(`run ${input.runId} was released and then not found in one transaction`);
      }
      // The row as it was claimed: the release's own statement already moved it to `created`.
      const claimed = toRunAggregate(
        { ...row, status: 'starting' },
        await options.eventStore.nextStreamSequence('run', row.id),
      );
      const recorded = releaseRunClaim(
        claimed,
        {
          offerId: released.offerId,
          workerId: input.workerId,
          epoch: input.epoch,
          reason: input.reason,
        },
        options.context(row.taskId),
      );
      await scope.events.append(recorded.events);
      // The offer is open again: a listening claimant wakes at the commit (TD-031 §8).
      await scope.broadcast.publish({
        topic: RUN_OFFERS_TOPIC,
        payload: { run_id: input.runId, kind: 'stage' },
      });
      return 'released' as const;
    });
    if (result === 'released') {
      logger.info(
        {
          run_id: input.runId,
          worker_id: input.workerId,
          lease_epoch: input.epoch,
          reason: input.reason,
        },
        'a remote claim was released unspent; the offer is open again',
      );
      // TD-031 decision 6: the minted credential is revoked — after the commit, outside any
      // transaction, and from what is stored, because this process may not be the one that minted.
      await options.credentials.revoke(input.runId, { mintedBefore: input.now });
    }
    return result;
  };

  return {
    claim: async (input) => {
      const owner = workerLeaseOwner(input.workerId);
      const { token, hash } = options.tokens.mint();
      const claimOnce = () =>
        unitOfWork.transaction(async (scope) => {
          const offer = await claimRunOffer(store.offers, scope.tx, {
            eligibility: {},
            claimantKind: 'worker',
            owner,
            expiresAt: leaseExpiryAt(input.now, leaseTtlMs),
            now: input.now,
            worker: {
              workerId: input.workerId,
              heldImageDigests: input.heldImageDigests,
              images: input.images,
              runTokenHash: hash,
            },
          });
          if (offer === null) {
            return null;
          }
          const row = await store.runs.load(scope.tx, offer.runId);
          if (row === null) {
            throw new Error(`run ${offer.runId} was claimed and then not found in one transaction`);
          }
          // The row as it was offered: the claim's own statement already moved it to `starting`.
          const offered = toRunAggregate(
            { ...row, status: 'created' },
            await options.eventStore.nextStreamSequence('run', row.id),
          );
          const forAdmission = {
            runId: row.id,
            taskId: row.taskId,
            projectId: row.projectId,
            kind: offer.kind,
            stage: row.stage,
          };
          const refusal = (await options.admission?.recheck(scope.tx, forAdmission)) ?? null;
          if (refusal !== null) {
            // Rolls the claim back: the offer is open again for `refuse` to withdraw.
            throw new ClaimAdmissionRefused(forAdmission, refusal);
          }
          const recorded = recordClaim(offered, offer, options.context(row.taskId), input.workerId);
          await scope.events.append(recorded.events);
          return {
            runId: row.id,
            epoch: offer.epoch,
            owner,
            images: offer.images ?? input.images,
          };
        });
      let claimed: Awaited<ReturnType<typeof claimOnce>>;
      try {
        claimed = await claimOnce();
      } catch (error) {
        if (!(error instanceof ClaimAdmissionRefused) || options.admission === undefined) {
          throw error;
        }
        const admission = options.admission;
        try {
          await retryOnTaskConflict(
            { taskId: error.claimed.taskId, what: 'refusing a remote claim', logger },
            () =>
              unitOfWork.transaction((scope) =>
                admission.refuse(scope, error.claimed, error.refusal),
              ),
          );
        } catch (refusalError) {
          // The claim is rolled back whatever happens here, so the worker took nothing: it is told
          // `none`, never a 500, and the offer stays open for the next claim to refuse again.
          logger.error(
            { err: refusalError, run_id: error.claimed.runId, task_id: error.claimed.taskId },
            'a remote claim refused at admission could not pause its task; the offer stays open and the next claim asks again',
          );
        }
        // The worker asks again; the next offer, if any, is its next claim's.
        return { kind: 'none' };
      }
      if (claimed === null) {
        return { kind: 'none' };
      }
      let answer: RemotePackageAnswer;
      try {
        const { stored } = await unitOfWork.transaction(async (scope) =>
          openRunPlan(
            { runPlans: store.runPlans, sealer: options.runPlans },
            scope.tx,
            claimed.runId,
          ),
        );
        answer = await options.packager.build({
          spec: stored,
          epoch: claimed.epoch,
          runToken: token,
          images: claimed.images,
          leaseTtlMs,
        });
      } catch (error) {
        await settleUnpackaged(claimed, error);
        return { kind: 'not_packaged', runId: claimed.runId };
      }
      logger.info(
        { run_id: claimed.runId, worker_id: input.workerId, lease_epoch: claimed.epoch },
        'a remote worker claimed a run; its package is answered',
      );
      return { kind: 'claimed', runId: claimed.runId, package: answer.package };
    },

    authenticate: async (input) => {
      const holder = await unitOfWork.transaction(async (scope) =>
        store.offers.runTokenHolder(scope.tx, input.runId),
      );
      if (
        holder === null ||
        holder.tokenHash === null ||
        holder.workerId === null ||
        !options.tokens.same(holder.tokenHash, options.tokens.hashOf(input.token)) ||
        !holder.workerUsable
      ) {
        return null;
      }
      if (
        !isActiveRunStatus(holder.runStatus) &&
        (holder.endedAt === null ||
          Date.parse(input.now) - Date.parse(holder.endedAt) > WORKER_RUN_TOKEN_AFTER_END_MS)
      ) {
        return null;
      }
      return { runId: input.runId, workerId: holder.workerId };
    },

    heartbeat: async (input) => {
      const owner = workerLeaseOwner(input.workerId);
      const leaseExpiresAt = leaseExpiryAt(input.now, leaseTtlMs);
      return unitOfWork.transaction(async (scope): Promise<RemoteHeartbeatAnswer> => {
        // The renewal is fenced on the epoch, the owner and the worker still able to act, in one
        // statement (backlog 714): a revoke committed before it is seen here.
        const renewed = await store.runs.renewLease(scope.tx, {
          runId: input.runId,
          owner,
          epoch: input.epoch,
          expiresAt: leaseExpiresAt,
        });
        if (!renewed) {
          return { kind: 'lease_lost' };
        }
        if (input.acks.length > 0) {
          // Only a command pending for this run and this holder is stamped: an id the worker names
          // that is not one is ignored, so no worker can settle another run's command.
          const pending = new Set(
            (
              await store.runCommands.pending(scope.tx, {
                owner,
                runId: input.runId,
                limit: REMOTE_COMMANDS_PER_HEARTBEAT,
              })
            ).map((row) => row.id),
          );
          for (const ack of input.acks) {
            if (!pending.has(ack.commandId)) continue;
            if (ack.outcome === 'applied') {
              await store.runCommands.markApplied(scope.tx, { id: ack.commandId, owner });
            } else {
              await store.runCommands.markRefused(scope.tx, {
                id: ack.commandId,
                reason: ack.reason,
              });
            }
          }
        }
        return {
          kind: 'renewed',
          leaseExpiresAt,
          commands: await pendingIn(scope.tx, owner, input.runId),
        };
      });
    },

    pending: async (input) =>
      unitOfWork.transaction(async (scope) =>
        pendingIn(scope.tx, workerLeaseOwner(input.workerId), input.runId),
      ),

    release,

    spawn: async (input) => {
      const fence = { epoch: input.epoch, owner: workerLeaseOwner(input.workerId) };
      return unitOfWork.transaction(async (scope): Promise<RemoteSpawnAnswer> => {
        const before = await store.runs.load(scope.tx, input.runId);
        if (before === null) {
          return { kind: 'lease_lost' };
        }
        const contextPack = await store.runs.contextPack(scope.tx, input.runId);
        let marked: boolean;
        try {
          marked =
            contextPack !== null &&
            (await store.runs.markCliSpawnRequested(scope.tx, {
              runId: input.runId,
              at: input.now,
              lease: fence,
            }));
        } catch (error) {
          if (error instanceof LeaseLostError) {
            return { kind: 'lease_lost' };
          }
          throw error;
        }
        if (!marked) {
          // A repeat under the same live claim answers the instant the first call recorded.
          const settlement = await store.runs.lockSettlement(scope.tx, input.runId);
          const marker = before.cliSpawnRequestedAt ?? null;
          if (
            settlement !== null &&
            isActiveRunStatus(settlement.status) &&
            settlement.leaseEpoch === fence.epoch &&
            settlement.leaseOwner === fence.owner
          ) {
            if (marker !== null) {
              return { kind: 'already_spawned', startedAt: marker };
            }
            if (contextPack === null) {
              return { kind: 'not_startable' };
            }
          }
          return { kind: 'lease_lost' };
        }
        const claimed = toRunAggregate(
          { ...before, status: 'starting' },
          await options.eventStore.nextStreamSequence('run', input.runId),
        );
        const running = markRunning(
          claimed,
          { contextPack: contextPack as NonNullable<typeof contextPack> },
          options.context(before.taskId),
        );
        await scope.events.append(running.events);
        return { kind: 'spawned', startedAt: input.now };
      });
    },

    finish: async (input) => {
      const request: SettleRunRequest = {
        runId: input.runId,
        fence: { epoch: input.epoch, owner: workerLeaseOwner(input.workerId) },
        outcome: input.outcome,
        stopReason: input.stopReason,
      };
      let settled: Pick<SettleRunResult, 'kind' | 'ending'>;
      try {
        settled = (await isAskRun(input.runId))
          ? await settleAskRun(request)
          : await options.settle(request);
      } catch (error) {
        if (error instanceof LeaseLostError) {
          return { kind: 'lease_lost' };
        }
        throw error;
      }
      if (settled.kind === 'task_gone') {
        return { kind: 'run_gone' };
      }
      const ending = settled.ending;
      if (ending === null) {
        // A settle answers a stored ending for every kind but `task_gone`; a live row here is a
        // fence the settle did not hold, and saying so is the honest answer.
        return { kind: 'lease_lost' };
      }
      // TD-031 decision 5: a minted credential is revoked at the settle. The worker exported
      // everything it owed before it finished (WP-283), so nothing pushes with it afterwards.
      await options.credentials.revoke(input.runId);
      return {
        kind: settled.kind,
        ending: {
          status: ending.status,
          terminalReason: ending.terminalReason,
          epoch: ending.epoch,
        },
      };
    },

    lateCost: async (input) => {
      const owner = workerLeaseOwner(input.workerId);
      return unitOfWork.transaction(async (scope): Promise<RemoteLateCostAnswer> => {
        const row = await store.runs.lockSettlement(scope.tx, input.runId);
        if (row === null) {
          return { kind: 'run_gone' };
        }
        if (row.leaseEpoch !== input.epoch || row.leaseOwner !== owner) {
          return { kind: 'lease_lost' };
        }
        if (isActiveRunStatus(row.status)) {
          return { kind: 'run_live' };
        }
        const run = await store.runs.load(scope.tx, input.runId);
        if (run === null) {
          return { kind: 'run_gone' };
        }
        const outcome = await options.lateCost.record(
          scope,
          {
            runId: input.runId,
            taskId: run.taskId,
            sessionId: input.spend.sessionId,
            numTurns: input.spend.numTurns,
            usage: input.spend.usage,
            modelUsage: input.spend.modelUsage,
            cost: input.spend.cost,
            wallMs: input.spend.wallMs,
          },
          input.now,
        );
        return { kind: 'recorded', recorded: outcome.recorded };
      });
    },
  };
};

/** `finish`'s body as `settleRun` reads it (TD-031's 2026-11-04 amendment §1). */
export const settleOutcomeOfFinish = (
  runId: Id,
  body: z.output<typeof workerFinishRequestSchema>,
): RunOutcome | NotStartedReport => {
  const outcome = body.outcome;
  if (outcome.kind === 'not_started') {
    return {
      kind: 'not_started',
      failure: outcome.failure,
      detail: outcome.detail,
      detailTruncated: outcome.detail_truncated,
      transient: outcome.transient,
      spawnRequested: outcome.spawn_requested,
    };
  }
  return {
    runId,
    status: outcome.status,
    terminalReason: outcome.terminal_reason,
    sessionId: outcome.session_id,
    numTurns: outcome.num_turns,
    usage: outcome.usage,
    modelUsage: outcome.model_usage,
    // Rule 16: `null` is a run nothing measured — the floor the column holds, flagged unmeasured,
    // never a zero that reads as a free run.
    cost: outcome.cost ?? { usd: 0, is_estimate: false, price_list_id: null },
    ...(outcome.cost === null ? { costUnmeasured: true } : {}),
    wallMs: outcome.wall_ms,
    structuredOutput: outcome.structured_output,
    error: outcome.error,
    redactionCount: outcome.redaction_count,
    ...(outcome.saved_work === undefined ? {} : { savedWork: outcome.saved_work }),
    ...(outcome.start_failure === undefined ? {} : { startFailure: outcome.start_failure }),
  };
};
