/**
 * Composing the pipeline: the handlers a bus registers, the workers a process starts.
 *
 * This is the seam an `apps/*` composition root uses. It is in the application ring rather than in
 * `apps/server` because the wiring is the *product* — which handler listens to which event, at
 * which priority, and which queue drives which job — and a composition root that re-derived it
 * would be a second copy of technical/02's table.
 *
 * ## Pool arithmetic, stated once
 *
 * The dispatcher needs `2 × APP_DISPATCH_MAX_CONCURRENCY + 1` connections
 * (`InsufficientPoolError`), and since WP-15d the pipeline's term is **flat**: one per job worker
 * this runtime starts — `stage.execute`, `mr.comment.debounce`, `pipeline.outbound`, `notify.digest`
 * (WP-32) and `task.ask` (WP-31) — each holding one connection during each of its transactions.
 *
 * That is the whole of it because **no handler calls a provider any more**. Until WP-15d three did
 * (the intake branch check, the workpad, the status mapping), and each made its dispatch hold a
 * *third* connection: the executor's audit row commits in a transaction of its own (BD-003), which
 * nests inside the caller's, so the term was proportional to the dispatch concurrency rather than
 * flat. `apps/server/src/config.ts` counted it as `POOL_RESERVATIONS.auditPerDispatch`; that
 * constant is **0** now, and it is the receipt — while it is 1, the shape is back.
 *
 * So a process running the pipeline needs
 * `2 × dispatchConcurrency + 1 + stageConcurrency + reviewConcurrency + outboundConcurrency +
 * digestConcurrency + askConcurrency + 1` at least, and the number is a floor rather than a budget — the HTTP layer and the projections
 * draw on the same pool.
 *
 * That trailing `+ 1` is the **sixth** worker, and it is not started here: WP-15c's
 * `pipeline.intake.reconcile` pass is composed by `apps/server/src/pipeline.ts`, because it is a
 * maintenance schedule the process owns rather than a queue this runtime drives. It is counted
 * unconditionally — including when `APP_INTAKE_RECONCILE_INTERVAL_MS=0` starts no worker at all —
 * because a reservation that shrank with a setting would be a floor an operator could lower by
 * accident. `POOL_RESERVATIONS.pipeline` is therefore **6** (4 until WP-32 added the digest tick, 5
 * until WP-31 added the `task.ask` worker), and this sentence is the reason a
 * reader of *this* file can reach that number: the term is the process's, not this function's
 * (standing rule 63 — an arithmetic claim cannot be maintained from inside one file).
 *
 * **One thing a handler still does inside its transaction is read `ProjectSettingsPort`**, which in
 * `apps/server` is a `projects` query on a connection borrowed inside the handler's. It is a
 * transient borrow of the local database rather than a connection held across a third party's
 * latency, so it contends where a provider call stalled — every other borrower releases without
 * waiting on a dispatch, so there is no hold-and-wait cycle — and the reservations below cover it.
 * It is filed as discovered work rather than fixed here: the honest fix is for the port to take the
 * caller's transaction.
 */

import { type AskRuntimeOptions, composeAsk } from '../ask/runtime.js';
import type { EventHandler } from '../events/handler.js';
import { markTransactions } from '../events/open-transaction.js';
import type { MaintenanceSpendReader } from '../maintenance/ports.js';
import { startDigestRuntime } from '../notify/digest.js';
import { notifyHandlers } from '../notify/handlers.js';
import type { NotifyOptions } from '../notify/options.js';
import type { DependencyMetadataPort } from '../ports/dependency-metadata.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { ShadowStore } from '../shadow/ports.js';
import { type ShadowReportOptions, shadowHandlers } from '../shadow/report.js';
import { conflictWarningHandlers } from './conflict-warning.js';
import { coverageHandlers } from './coverage.js';
import { dependencyGateHandlers } from './dependency-gate.js';
import { epicSplitHandlers } from './epic-split.js';
import {
  declarePipelineQueues,
  type PipelineJobOptions,
  type PipelineOutboundData,
  type ReviewWindowData,
  reviewWindowHandler,
  type StageExecuteData,
  stageExecuteHandler,
} from './jobs.js';
import { type PipelineOutboundOptions, pipelineOutboundHandler } from './outbound.js';
import { reviewOnlyHandlers } from './review-only.js';
import { riskRoutingHandlers } from './risk-routing.js';
import { type PipelineSagaOptions, pipelineHandlers } from './saga.js';
import {
  createStageExecutor,
  type StageExecutor,
  type StageExecutorBootstrapPort,
  type StageExecutorOptions,
} from './stage-executor.js';
import { ticketLintHandlers } from './ticket-lint.js';

export interface PipelineRuntimeOptions extends PipelineSagaOptions, NotifyOptions {
  readonly unitOfWork: UnitOfWork;
  /** `APP_BASE_URL` — the link an ask's mirrored ticket comment points back at (WP-31). */
  readonly baseUrl: string;
  /**
   * Ask-the-task (WP-31): the store, the identity map, the runner and the planner.
   *
   * Required rather than optional, like `execution`: a process that runs the pipeline answers asks,
   * and a composition that could omit it is a deployment where `POST /api/tasks/:id/ask` writes a
   * row nothing ever picks up (standing rule 31 — an optional collaborator is an absent one).
   */
  readonly ask: AskRuntimeOptions;
  /** Everything the stage executor needs that the saga does not. */
  readonly execution: Omit<
    StageExecutorOptions,
    'unitOfWork' | 'store' | 'settings' | 'logger' | 'context'
  > &
    Pick<StageExecutorOptions, 'context'>;
  /** How many stages this process runs at once. @default 1 */
  readonly stageConcurrency?: number;
  /**
   * The package-registry client the dependency gate asks for a licence (WP-38, Q84).
   *
   * Optional, and the only optional collaborator here that is **not** standing rule 31's absent
   * one: the shipped answer for an instance with no declared registry host is a *stated*
   * `not_checked` (`UNCONFIGURED_DEPENDENCY_METADATA`), which the panel prints, and the gate works
   * identically without it. `apps/server` composes the real client only when
   * `APP_DEPENDENCY_REGISTRY_HOSTS` names a host.
   */
  readonly dependencyMetadata?: DependencyMetadataPort;
  /**
   * Shadow mode's store (WP-34) — `shadow_batches`, `shadow_batch_tickets` and `shadow_reports`.
   *
   * Required rather than optional, unlike {@link PipelineRuntimeOptions.dependencyMetadata}: the
   * report handler is registered unconditionally and `EVENT_CONSUMPTION` declares
   * `shadow.report.created` **handled**, so a runtime composed without it would sweep an event it
   * had promised a consumer for (the sweeper completeness property `consumption.ts` exists to
   * keep). A deployment that runs no shadow batch simply never produces the event.
   */
  readonly shadow: ShadowStore;
  /**
   * The history bootstrap's store (WP-35) — `history_bootstrap_batches`, `_chunks`.
   *
   * **Optional**, unlike {@link PipelineRuntimeOptions.shadow}, and the difference is a real one
   * rather than an inconsistency: the bootstrap registers **no handler here** (its
   * `artifact.created` trigger belongs to `createHistoryBootstrapRuntime`), so a runtime composed
   * without it promises no consumer for anything. What it changes is the stage executor's
   * admission: absent means the batch cap is **not asked**, which is safe because nothing can
   * create a mining task on a build with no bootstrap store — `collectHistory` takes the writer.
   */
  readonly bootstrap?: StageExecutorBootstrapPort;
  /**
   * The maintenance scheduler's spend reader (WP-36) — `features.maintenance.budget_usd`'s carrier.
   *
   * **Optional** for {@link PipelineRuntimeOptions.bootstrap}'s reason and with the same pairing:
   * this runtime registers no maintenance handler (the schedule is a cron the composition root
   * starts, beside `registerPartitionMaintenance`), so its absence promises no consumer for
   * anything; what it changes is the stage executor's admission, and a build with no scheduler
   * creates no chore to admit.
   */
  readonly maintenance?: MaintenanceSpendReader;
  /**
   * TD-012 step 2 over the untrusted text this runtime's handlers **store** (WP-40 round 2).
   *
   * Today that is the epic split's queue — a model's proposed child tickets, written inside the
   * dispatcher's transaction where no binding can be resolved, so the platform's own pattern rules
   * are the redaction available (`epic-split.ts`'s module note has the division and the residual).
   * Required rather than optional, because an optional security dependency is an absent one
   * (standing rule 31) and this is the same redactor `routes/commands.ts` and the ask executor are
   * given.
   */
  readonly redactor: SecretRedactor;
}

export interface PipelineRuntime {
  /** Registered on the `EventBus` by the composition root, in TD-005's core band. */
  readonly handlers: readonly EventHandler[];
  readonly executor: StageExecutor;
  /** Declares the queues and starts the workers. Idempotent. */
  start(): Promise<void>;
  /** Stops the workers; the handlers stop with the bus. */
  stop(): Promise<void>;
}

export const createPipelineRuntime = (options: PipelineRuntimeOptions): PipelineRuntime => {
  const logger: Logger | undefined = options.logger;
  /**
   * Every transaction the pipeline opens is marked as open (WP-15d).
   *
   * The dispatcher marks the handler path itself; this covers the job path, so a stage executor or
   * a job that reaches a provider from inside its own transaction is refused rather than reviewed
   * for. A decorator, because there are several `UnitOfWork` implementations and a rule maintained
   * in each of them drifts (standing rule 7).
   */
  const unitOfWork = markTransactions(options.unitOfWork);
  const executor = createStageExecutor({
    ...options.execution,
    unitOfWork,
    store: options.store,
    settings: async (projectId) => options.settings.forProject(projectId),
    // WP-34: the separate shadow budget and the comparison base. Supplied here rather than left to
    // the composition root's `execution` block, because the same store is what makes a shadow task
    // exist at all — see `StageExecutorOptions.shadow`.
    shadow: options.shadow,
    // WP-35: the history bootstrap's per-batch cap, asked only for a task on that template.
    ...(options.bootstrap === undefined ? {} : { bootstrap: options.bootstrap }),
    // WP-36: the maintenance budget, asked only for a chore this platform scheduled.
    ...(options.maintenance === undefined ? {} : { maintenance: options.maintenance }),
    ...(logger === undefined ? {} : { logger }),
  });

  const jobOptions: PipelineJobOptions = { ...options, unitOfWork, executor };
  const ask = composeAsk({
    ...options.ask,
    unitOfWork,
    store: options.store,
    settings: options.settings,
    stopReasons: options.execution.stopReasons,
    jobs: options.jobs,
    ids: options.ids,
    clock: options.clock,
    context: options.execution.context,
    // WP-48 (backlog 120): the **same** lease the stage executor was given, so an ask's run is held
    // by this process's one owner string and is swept at the lease bound rather than an hour later
    // by the wall-clock backstop. Taken from `execution` rather than added to `AskRuntimeOptions`,
    // so a composition root cannot pass one and forget the other.
    ...(options.execution.lease === undefined ? {} : { lease: options.execution.lease }),
    ...(logger === undefined ? {} : { logger }),
  });
  // The outbound queue's duties include the notification band's, which needs the store and the
  // organisation's zone; `PipelineJobOptions` is the stage executor's shape and does not carry them.
  const outboundOptions: PipelineOutboundOptions = {
    ...options,
    unitOfWork,
    asks: options.ask.asks,
    // WP-37: the same identity map the ask handler resolves an author with, read in the other
    // direction by the reviewer fallback. One collaborator rather than two of the same table.
    identities: options.ask.identities,
    // WP-38: absent unless an operator declared a registry host, in which case every lookup
    // answers `not_checked` and the gate still gates.
    ...(options.dependencyMetadata === undefined
      ? {}
      : { dependencyMetadata: options.dependencyMetadata }),
    shadow: options.shadow,
  };
  // WP-34: the two shadow handlers and the `shadow_report` duty share one options object, because
  // they are the deciding and the calling halves of the same feature (WP-15d's shape).
  const shadowOptions: ShadowReportOptions = { ...options, unitOfWork, shadow: options.shadow };
  const workers: JobWorker[] = [];

  return {
    /**
     * The saga's handlers, plus review-only mode's three (WP-24), the ticket linter's two (WP-25)
     * and the rebase gate's conflict warning (WP-26).
     *
     * Registered here rather than inside `pipelineHandlers` because `review-only.ts` and
     * `ticket-lint.ts` import from `saga.ts` (`priorityRankOf`, `PipelineSagaOptions`), and the
     * reverse import would close a module cycle — backlog 21's shape, which this repository has
     * already paid for once.
     */
    handlers: [
      ...pipelineHandlers(options),
      ...reviewOnlyHandlers(options),
      ...ticketLintHandlers(options),
      ...conflictWarningHandlers(options),
      // WP-37: the rebase gate's other duty — classify the diff, route the reviewers.
      ...riskRoutingHandlers(options),
      // WP-39: the coverage delta, on `ci.pipeline.finished` rather than on a stage transition.
      ...coverageHandlers(options),
      // WP-38: the dependency gate, on the Developer stage's own completion (product/04:58).
      ...dependencyGateHandlers(options),
      // WP-34: the shadow report at the human stage, and the batch's own completion.
      ...shadowHandlers(shadowOptions),
      // The notify band (WP-32), TD-005 priority 210 — the one handler outside the core and
      // integrations bands, and the reason `EVENT_CONSUMPTION`'s two budget entries are `handled`.
      ...notifyHandlers(options),
      // Ask-the-task (WP-31), TD-005 core band at 60: `ticket.comment.added`'s first consumer.
      ...ask.handlers,
      // WP-40: the spike's report duty, the epic split's queue, and the decision that ends the wait.
      ...epicSplitHandlers({ ...options, unitOfWork }),
    ],
    executor,
    start: async () => {
      await declarePipelineQueues(options.jobs);
      await ask.declareQueue();
      workers.push(
        await options.jobs.work<StageExecuteData>({
          queue: JOB_QUEUES.stageExecute,
          handler: stageExecuteHandler(jobOptions),
          concurrency: options.stageConcurrency ?? 1,
        }),
      );
      workers.push(
        await options.jobs.work<ReviewWindowData>({
          queue: JOB_QUEUES.mrCommentDebounce,
          handler: reviewWindowHandler(jobOptions),
          concurrency: 1,
        }),
      );
      // WP-32: the digest tick. It is started here rather than by the composition root because it
      // is the pipeline's own schedule — `createPipelineRuntime` is where "which queue drives which
      // job" is written down, and a composition root that started it separately would be a second
      // copy of that decision. One more pooled connection, counted in `POOL_RESERVATIONS.pipeline`.
      workers.push(await startDigestRuntime(outboundOptions));
      // WP-31: one ask at a time, one more pooled connection (`POOL_RESERVATIONS.pipeline`).
      workers.push(await ask.startWorker());
      workers.push(
        await options.jobs.work<PipelineOutboundData>({
          queue: JOB_QUEUES.pipelineOutbound,
          handler: pipelineOutboundHandler(outboundOptions),
          /**
           * One, and the trade is stated rather than assumed.
           *
           * One worker keeps a task's outbound calls in the order its handlers decided on, and
           * costs one pooled connection. What it buys the *dispatcher* is the whole of this work
           * package — a slow provider no longer stops every project's events — and what it does
           * not buy is isolation between projects on this queue: a provider that takes ten seconds
           * delays the ticket writes of everything behind it. That is a throughput knob, not a
           * correctness one, and it is deliberately not exposed until something measures a need
           * for it: each unit of concurrency is another connection in `requiredPoolConnections`.
           */
          concurrency: 1,
        }),
      );
    },
    stop: async () => {
      const stopping = workers.splice(0, workers.length);
      for (const worker of stopping) {
        await worker.stop();
      }
    },
  };
};
