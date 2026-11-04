/**
 * Offers and the claim — WP-274, TD-031 decisions 1–3 (migration 0094); the asynchronous hand-off
 * since WP-276.
 *
 * Every agent run is an **offer** (`run_offers`, one row per run) written in the run's creation
 * transaction ({@link offerRun}), and becomes a claimant's only through **one claim**:
 * {@link claimRunOffer}, the single function every claimant calls, over the repository's one SQL
 * statement (`for update of o, r skip locked`, the epoch incremented, the run's
 * `lease_owner`/`lease_expires_at`/`lease_epoch` written with it, the run `created → starting`).
 * Every later write the claimant makes carries the claim's {@link RunLeaseFence}.
 *
 * ## The job ends at the offer (WP-276)
 *
 * Until WP-276 the job that wrote the offer claimed it in the same transaction and ran the session
 * itself. Now `stage.execute` (and `task.ask`) **end after the offer**: the run waits, `created`, for
 * a claimant — the server's claimant loop (`./claimant.ts`, composed by configuration, TD-031
 * decision 13) or, from WP-281, a remote worker. The offer is announced on {@link RUN_OFFERS_TOPIC}
 * when its transaction commits, so a claimant that is listening wakes at once; a claimant's own poll
 * is the guarantee for a notification sent while nothing listened.
 *
 * ## Who closes the offer
 *
 * `RunRepository.finish` closes it, in the terminal writer's transaction, because every terminal
 * writer goes through `finish` (`run-terminal-writers.test.ts` holds that) — and a task transition
 * that leaves the stage entry while the offer is still open **withdraws** it (`./offer-withdrawal.ts`).
 * An offer nobody claims by its `expires_at` is withdrawn by the offer-timeout recovery row
 * (`../recovery/offer-timeout.ts`, WP-278), and its task escalated.
 *
 * ## Who may claim it, and from when (WP-278)
 *
 * {@link offerRun} routes the offer as it writes it (TD-031 decision 8): it reads the project's
 * execution settings (`project_execution_settings`; none stored is TD-031 §8's defaults), whether the
 * candidate assignee has a worker online, and whether the instance has a server claimant running
 * (`server_claimants`), and writes `routeOffer`'s four timestamps and `expires_at`
 * (`@platform/domain`'s `workers/execution-routing.ts` carries the rules). The server's claim takes
 * an offer only from its `server_from` — or at once for an offer written before WP-278, which has
 * neither `*_from` (`postgres-run-offers.ts`).
 */
import type { Id, IsoDateTime, RunOfferKind } from '@platform/contracts';
import {
  type CommandContext,
  claimRun,
  DEFAULT_EXECUTION_SETTINGS,
  type OfferRouting,
  type Run,
  offerRun as recordRunOffered,
  routeOffer,
} from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import type {
  ClaimedRunOffer,
  ExecutionRoutingRepository,
  RunLeaseFence,
  RunOfferClaim,
  RunOfferRepository,
} from './store.js';

/** The `lease_owner` the server's runner writes: `server:<process>` (TD-031 §2). */
export const serverLeaseOwner = (process: string): string => `server:${process}`;

/**
 * The broadcast topic an offer is announced on when its transaction commits — TD-031's
 * `pg_notify('run_offers')`. The payload names the offer's kind and run, and a claimant needs
 * neither: it wakes and claims through the one claim, which picks the oldest eligible offer.
 */
export const RUN_OFFERS_TOPIC = 'run_offers';

/**
 * **The one claim** (TD-031 §2). Every claimant calls this and nothing else touches an offer's
 * `open → claimed` edge; it answers `null` when no eligible offer was open.
 */
export const claimRunOffer = async (
  offers: RunOfferRepository,
  tx: Transaction,
  claim: RunOfferClaim,
): Promise<ClaimedRunOffer | null> => offers.claim(tx, claim);

export interface OfferRunInput {
  /** The run as `recordRunCreated` left it — its row already inserted in this transaction. */
  readonly run: Run;
  readonly kind: RunOfferKind;
  readonly offerId: Id;
  readonly now: IsoDateTime;
  /**
   * Who plays the assignee (TD-031 §8, §13): for an ask, the **asking** user; for a stage, the
   * ticket's assignee's platform user. `null` when there is none — and always for a stage until
   * the ticket's assignee is stored (the ticket read keeps it for intake's one question and drops
   * it, `ticket-snapshot.ts`; BACKLOG 730). The head start goes to this user only while a worker of
   * theirs is online.
   */
  readonly assigneeUserId: Id | null;
}

/**
 * TD-031 decision 8 at offer time: the project's settings (the defaults when none is stored), the
 * assignee's worker, and the instance's server claimant, through `routeOffer`.
 */
export const routeNewOffer = async (
  execution: ExecutionRoutingRepository,
  tx: Transaction,
  input: { readonly projectId: Id; readonly assigneeUserId: Id | null; readonly now: IsoDateTime },
): Promise<OfferRouting> => {
  const settings = (await execution.settings(tx, input.projectId)) ?? DEFAULT_EXECUTION_SETTINGS;
  const online =
    input.assigneeUserId !== null &&
    settings.mode !== 'server_only' &&
    (await execution.assigneeOnline(tx, {
      projectId: input.projectId,
      userId: input.assigneeUserId,
      now: input.now,
    }));
  return routeOffer({
    settings,
    now: input.now,
    onlineAssigneeUserId: online ? input.assigneeUserId : null,
    serverClaimant: await execution.serverClaimantRunning(tx),
  });
};

/**
 * Writes the run's offer `open` in its creation transaction, routed (WP-278, {@link routeNewOffer}),
 * records `run.offered` on the run's stream, and announces it on {@link RUN_OFFERS_TOPIC} at commit (WP-276). The caller appends the
 * returned events with the run's own. **No claim**: the run waits, `created`, for a claimant.
 */
export const offerRun = async (
  store: { readonly offers: RunOfferRepository; readonly execution: ExecutionRoutingRepository },
  scope: Pick<TransactionScope, 'tx' | 'broadcast'>,
  input: OfferRunInput,
  context: CommandContext,
): Promise<ReturnType<typeof recordRunOffered>> => {
  const routing = await routeNewOffer(store.execution, scope.tx, {
    projectId: input.run.projectId,
    assigneeUserId: input.assigneeUserId,
    now: input.now,
  });
  await store.offers.insert(scope.tx, {
    id: input.offerId,
    runId: input.run.id,
    taskId: input.run.taskId,
    projectId: input.run.projectId,
    stage: input.run.stage,
    attempt: input.run.attempt,
    kind: input.kind,
    offeredAt: input.now,
    routing,
  });
  await scope.broadcast.publish({
    topic: RUN_OFFERS_TOPIC,
    payload: { run_id: input.run.id, kind: input.kind },
  });
  return recordRunOffered(input.run, { offerId: input.offerId, kind: input.kind }, context);
};

/** What {@link recordClaim} answers: the run `starting` and the fence every later write carries. */
export interface RecordedClaim {
  readonly run: Run;
  readonly events: ReturnType<typeof claimRun>['events'];
  readonly fence: RunLeaseFence;
}

/** `run.claimed` for a claim the repository granted — the run `created → starting` in the log. */
export const recordClaim = (
  run: Run,
  claimed: ClaimedRunOffer,
  context: CommandContext,
): RecordedClaim => {
  const recorded = claimRun(
    run,
    {
      offerId: claimed.offerId,
      claimantKind: 'server',
      workerId: null,
      epoch: claimed.epoch,
    },
    context,
  );
  return {
    run: recorded.aggregate,
    events: recorded.events,
    fence: { epoch: claimed.epoch, owner: claimed.owner },
  };
};
