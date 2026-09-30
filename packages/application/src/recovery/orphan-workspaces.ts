/**
 * The run workspace nobody owns — PROGRESS backlog **286** (with **136**'s question about a
 * production producer), WP-103, built per TD-028 decision 12.
 *
 * ## What is wrong without this
 *
 * The launcher's only record of a run it created was its memory and the handle it answered. A run
 * container whose handle never reached the runner kept running, and nothing reconciled the daemon
 * with `runs`. WP-103 **measured** three producers against a daemon
 * (`scripts/launcher-control-plane-check.mjs`, Docker Engine 29.8.1, `linux/arm64`; the numbers are
 * in backlog 286):
 *
 *  - a create that outlives the client's timeout with the launcher alive **completes**, so the
 *    stage executor's three start attempts — each a new run id, because `recordUnstarted` fails the
 *    run row and the stage is re-enqueued — left **three** running run containers, three sidecars,
 *    three networks and three control directories holding a live shim token;
 *  - a launcher stopped (`docker stop`) or killed during a create left the helper container it was
 *    running (`clone-<run-id>`, `prep-<run-id>`), the run's network and its workspace volume — no run
 *    container, but a labelled helper that marks the run *alive* to the retention sweep for ever, so
 *    neither the control directory nor the volume is ever reclaimed;
 *  - an unattached shim does not exit: nothing arms a timer on a socket nobody connects to.
 *
 * ## Why the reaper is here and not in the launcher
 *
 * Deciding that a container is an orphan needs `runs`, and the launcher reads no database
 * (TD-021's amendment; `compose.yml`'s launcher joins neither the default network nor `db`). So the
 * launcher answers **what it labelled** — one authenticated read verb, read off the daemon rather
 * than its memory — and destroys **by run id** whatever carries that label; the decision stays with
 * the process that can see the runs, which is the runner, the one process composed with a launcher
 * client (TD-028 decision 5).
 *
 * ## What is an orphan, exactly
 *
 * A listed run id is destroyed when its run is
 *
 *  - **terminal**, and ended at least one pass interval ago — the grace every recovery row uses,
 *    and here it has a second job: a run's own release (`endRun`, a take-over's export) happens
 *    after its row is finished, and a pass that raced it would stop an export mid-push. The
 *    launcher also serialises a destroy behind an end of the same run, so the grace is the first
 *    line and the launcher the second;
 *  - **unknown** — no `runs` row — and its oldest container is older than
 *    {@link ORPHAN_UNKNOWN_RUN_GRACE_MS}. Both sites that insert a run (the stage executor and the
 *    ask executor) commit the row **before** they provision, so a labelled run id with no row is a
 *    row that is gone, or a run of a database this runner does not read. The second is the reason
 *    for the grace and for the instance label the launcher filters by (see the verb's docblock).
 *
 * A **live** run (`created`, `starting`, `running`) is always kept, whatever its container's age:
 * that is the negative case, and the lease sweep — not this — is what ends a live row nobody
 * drives. Once it has, the run is terminal and the next pass here removes its container.
 *
 * ## What bounds it
 *
 * **One attempt per run id per pass**, and at most {@link DEFAULT_ORPHAN_REAP_LIMIT} per pass; a
 * destroy that fails is counted and logged, and the next pass — which lists again from the daemon —
 * tries again. There is no attempt mark, for the reason `./run-lease.ts` gives: the thing being
 * recovered is not a row that a query could find twice, it is a container that is either still
 * listed or not.
 *
 * ## Why it has a timer of its own rather than a row on `./stranded.ts`'s
 *
 * The stranded pass rides the `intake.reconcile` job, which **any** worker takes; this pass needs the
 * launcher client, which only a process configured to run agents holds. A site that was present on
 * some workers and absent on others would reap on whichever process happened to win the job. So it
 * is an in-process timer in the runner, on the same interval and the same grace as that pass
 * (`APP_INTAKE_RECONCILE_INTERVAL_MS`), and a deployment with two runners on one launcher runs it
 * twice — harmless, because `destroy` is idempotent and a run is either an orphan or not.
 */
import type { Id, IsoDateTime, RunStatus } from '@platform/contracts';
import { isActiveRunStatus } from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { RunnerClock } from '../ports/runner.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** One run id the launcher labelled a container for, as the daemon answers it. */
export interface ListedRunWorkspace {
  readonly runId: string;
  /** When the run's **oldest** labelled container was created, per the daemon. */
  readonly createdAt: string;
  /** Whether any of its containers is running — reported, never decisive. */
  readonly running: boolean;
}

/**
 * The launcher's two verbs this pass uses (TD-028 decision 12) — the control-plane client in
 * production, a fake in the unit tier.
 */
export interface RunWorkspaceInventory {
  list(): Promise<readonly ListedRunWorkspace[]>;
  /** Idempotent; `found: false` when nothing carried the run's label. */
  destroy(runId: string): Promise<{ readonly found: boolean }>;
}

/** A run row, as much of it as the decision needs. */
export interface OrphanWorkspaceRunState {
  readonly runId: Id;
  readonly status: RunStatus;
  readonly endedAt: IsoDateTime | null;
}

export interface OrphanWorkspaceRunStore {
  /** The rows among `runIds` that exist; an id with no row is simply absent from the answer. */
  runStates(tx: Transaction, runIds: readonly Id[]): Promise<readonly OrphanWorkspaceRunState[]>;
}

/**
 * How old an **unknown** run's container must be before it is removed: an hour.
 *
 * Longer than any create can take — the runner's client gives up at ten minutes
 * (`launcher/client.ts`), and the launcher's create is bounded by the daemon calls it makes — with
 * slack, and short enough that an orphan does not hold a container, a sidecar and a network for a
 * day. The row is committed before the create is sent, so this is not a race with a starting run;
 * it is the margin for a run id this runner cannot see.
 */
export const ORPHAN_UNKNOWN_RUN_GRACE_MS = 60 * 60_000;

/** Destroys one pass may attempt; each is several helper containers on the launcher's side. */
export const DEFAULT_ORPHAN_REAP_LIMIT = 50;

export type OrphanReapReason = 'terminal' | 'unknown';
export type OrphanKeepReason =
  | 'run_live'
  | 'ended_within_grace'
  | 'unknown_within_grace'
  | 'not_a_run_id'
  | 'over_limit';

export type OrphanWorkspaceDecision =
  | {
      readonly runId: string;
      readonly action: 'reap';
      readonly reason: OrphanReapReason;
      readonly status: RunStatus | null;
    }
  | { readonly runId: string; readonly action: 'keep'; readonly reason: OrphanKeepReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The decision, pure: what the listing and the rows say about each run id.
 *
 * Ordered as listed, one decision per distinct id; a reap past `limit` is kept as `over_limit`, so
 * the report still accounts for every id the launcher answered.
 */
export const decideOrphanWorkspaces = (input: {
  readonly listed: readonly ListedRunWorkspace[];
  readonly states: readonly OrphanWorkspaceRunState[];
  readonly now: number;
  readonly graceMs: number;
  readonly unknownGraceMs: number;
  readonly limit: number;
}): readonly OrphanWorkspaceDecision[] => {
  const byId = new Map(input.states.map((state) => [state.runId as string, state]));
  const seen = new Set<string>();
  const decisions: OrphanWorkspaceDecision[] = [];
  let reaps = 0;
  for (const entry of input.listed) {
    if (seen.has(entry.runId)) {
      continue;
    }
    seen.add(entry.runId);
    const decided = decideOne(entry, byId.get(entry.runId), input);
    if (decided.action === 'reap') {
      if (reaps >= input.limit) {
        decisions.push({ runId: entry.runId, action: 'keep', reason: 'over_limit' });
        continue;
      }
      reaps += 1;
    }
    decisions.push(decided);
  }
  return decisions;
};

const decideOne = (
  entry: ListedRunWorkspace,
  state: OrphanWorkspaceRunState | undefined,
  input: { readonly now: number; readonly graceMs: number; readonly unknownGraceMs: number },
): OrphanWorkspaceDecision => {
  const runId = entry.runId;
  if (!UUID.test(runId)) {
    return { runId, action: 'keep', reason: 'not_a_run_id' };
  }
  if (state === undefined) {
    const created = Date.parse(entry.createdAt);
    // An instant the daemon did not give is treated as young: removing a container this runner
    // cannot date and cannot find a row for is the direction that destroys somebody's run.
    const old = Number.isFinite(created) && created < input.now - input.unknownGraceMs;
    return old
      ? { runId, action: 'reap', reason: 'unknown', status: null }
      : { runId, action: 'keep', reason: 'unknown_within_grace' };
  }
  if (isActiveRunStatus(state.status)) {
    return { runId, action: 'keep', reason: 'run_live' };
  }
  const ended = state.endedAt === null ? Number.NaN : Date.parse(state.endedAt);
  // A terminal row with no `ended_at` is terminal all the same; there is no instant to wait from.
  if (Number.isFinite(ended) && ended >= input.now - input.graceMs) {
    return { runId, action: 'keep', reason: 'ended_within_grace' };
  }
  return { runId, action: 'reap', reason: 'terminal', status: state.status };
};

/** What one pass did, every listed id accounted for. */
export interface OrphanWorkspaceReapReport {
  readonly listed: number;
  readonly reaped: Readonly<Record<OrphanReapReason, number>>;
  readonly kept: Readonly<Record<OrphanKeepReason, number>>;
  /** Destroys that threw; the run id is listed again next pass and tried again. */
  readonly failed: number;
}

/** The counted half (criterion 3): `apps/server` wires these to its Prometheus registry. */
export interface OrphanWorkspaceMetrics {
  reaped(reason: OrphanReapReason): void;
  failed(): void;
}

export interface OrphanWorkspaceReapOptions {
  readonly inventory: RunWorkspaceInventory;
  readonly store: OrphanWorkspaceRunStore;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Pick<RunnerClock, 'now'>;
  /** Equal to the pass interval, as for every recovery row. */
  readonly graceMs: number;
  /** @default ORPHAN_UNKNOWN_RUN_GRACE_MS */
  readonly unknownGraceMs?: number;
  /** @default DEFAULT_ORPHAN_REAP_LIMIT */
  readonly limit?: number;
  readonly metrics?: OrphanWorkspaceMetrics;
  readonly logger?: Logger;
}

const emptyKept = (): Record<OrphanKeepReason, number> => ({
  run_live: 0,
  ended_within_grace: 0,
  unknown_within_grace: 0,
  not_a_run_id: 0,
  over_limit: 0,
});

/**
 * One pass: list from the launcher, read the rows in **one** transaction, then destroy outside it —
 * a destroy is a network call to another process that runs helper containers, and no connection is
 * held across it (the shape every outbound call in this platform has).
 *
 * A listing that fails **throws**: a pass that could not list is not a pass that found nothing, and
 * the timer logs it as the failure it is.
 */
export const runOrphanWorkspaceReap = async (
  options: OrphanWorkspaceReapOptions,
): Promise<OrphanWorkspaceReapReport> => {
  const logger = options.logger ?? silentLogger;
  const listed = await options.inventory.list();
  const ids = [...new Set(listed.map((entry) => entry.runId))].filter((id) => UUID.test(id));
  const states =
    ids.length === 0
      ? []
      : await options.unitOfWork.transaction(async (scope) =>
          options.store.runStates(scope.tx, ids as Id[]),
        );
  const decisions = decideOrphanWorkspaces({
    listed,
    states,
    now: options.clock.now(),
    graceMs: Math.max(0, options.graceMs),
    unknownGraceMs: options.unknownGraceMs ?? ORPHAN_UNKNOWN_RUN_GRACE_MS,
    limit: options.limit ?? DEFAULT_ORPHAN_REAP_LIMIT,
  });
  const created = new Map(listed.map((entry) => [entry.runId, entry.createdAt]));
  const reaped: Record<OrphanReapReason, number> = { terminal: 0, unknown: 0 };
  const kept = emptyKept();
  let failed = 0;
  for (const decision of decisions) {
    if (decision.action === 'keep') {
      kept[decision.reason] += 1;
      continue;
    }
    const fields = {
      run_id: decision.runId,
      reason: decision.reason,
      run_status: decision.status,
      container_created_at: created.get(decision.runId) ?? null,
    };
    try {
      const { found } = await options.inventory.destroy(decision.runId);
      reaped[decision.reason] += 1;
      options.metrics?.reaped(decision.reason);
      logger.warn(
        { ...fields, found },
        decision.reason === 'terminal'
          ? 'removed the run workspace of a run that has ended: its container, sidecar, network and control directory had no process holding a handle for them (PROGRESS backlog 286)'
          : 'removed a run workspace whose run id has no runs row, an hour after its container was created (PROGRESS backlog 286)',
      );
    } catch (error) {
      failed += 1;
      options.metrics?.failed();
      logger.error(
        { ...fields, err: error },
        'could not remove an orphaned run workspace; the next pass lists it again and tries once more (PROGRESS backlog 286)',
      );
    }
  }
  return { listed: new Set(listed.map((entry) => entry.runId)).size, reaped, kept, failed };
};

export interface OrphanWorkspaceReaper {
  stop(): void;
}

/**
 * Arms the pass on the injected clock and re-arms it after each one, so a slow pass cannot stack
 * on itself — the launcher's retention sweep has the same shape. `intervalMs <= 0` arms nothing
 * and answers `null`, which is how `APP_INTAKE_RECONCILE_INTERVAL_MS=0` switches every recovery
 * off; the composition root logs which it did.
 */
export const startOrphanWorkspaceReaper = (
  options: Omit<OrphanWorkspaceReapOptions, 'graceMs' | 'clock'> & {
    readonly intervalMs: number;
    readonly clock: RunnerClock;
  },
): OrphanWorkspaceReaper | null => {
  if (options.intervalMs <= 0) {
    return null;
  }
  const logger = options.logger ?? silentLogger;
  let cancel: (() => void) | null = null;
  let stopped = false;
  const arm = (): void => {
    cancel = options.clock.setTimer(options.intervalMs, () => {
      void runOrphanWorkspaceReap({ ...options, graceMs: options.intervalMs })
        .then((report) => {
          if (report.reaped.terminal + report.reaped.unknown + report.failed > 0) {
            logger.info(
              {
                listed: report.listed,
                reaped_terminal: report.reaped.terminal,
                reaped_unknown: report.reaped.unknown,
                failed: report.failed,
                kept_live: report.kept.run_live,
                kept_over_limit: report.kept.over_limit,
              },
              'the orphaned-workspace pass removed run workspaces no process owned',
            );
          }
        })
        .catch((error: unknown) => {
          logger.warn(
            { err: error },
            'the orphaned-workspace pass could not list the launcher’s run containers; nothing was removed and the next pass tries again',
          );
        })
        .finally(() => {
          if (!stopped) {
            arm();
          }
        });
    });
  };
  arm();
  return {
    stop: () => {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
};
