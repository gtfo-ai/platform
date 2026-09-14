/**
 * Starting the Discovery agent — product/06 § "Step 2 — Technical discovery" (WP-21).
 *
 * ## Where the discovery run lives, decided
 *
 * **It is a stage of a one-off task**, on `DISCOVERY_TEMPLATE`, and not a job carrying a `RunSpec`
 * of its own. The reason is structural before it is aesthetic: `runs.task_id` is `not null`
 * (migration 0004) and `RunSpec.taskId` is required, so a discovery run needs a task whatever else
 * is decided — the only question is whether the platform builds a second path to create the run,
 * charge it, transcribe it, re-validate it and end it, or reuses the one every other run goes
 * through. Reusing it means the WP-19 admission guard, the cost ledger, the `run:<id>` stream, the
 * budget cap, the conflict retry and the `needs_human` escalation all apply with no second entry
 * point; `createStageRunPlanner` already carries a `discovery` row in each of BD-021's three
 * least-privilege tables. WP-18b's `librarian` stage is the precedent for a stage entered outside
 * the ticket flow's own decisions.
 *
 * **WP-31 built the second path this paragraph weighed against, and did not change this decision**
 * (standing rule 83: the sentence nearest a new mechanism is the one that goes stale). Ask-the-task
 * is a run with a task and **no stage** — `packages/application/src/ask/executor.ts`, its own
 * admission and its own transaction 2 — so a stage-less run is expressible now, and a reader could
 * reasonably ask why discovery is not one. The answer is what the two runs *produce*. A discovery
 * run writes a `DiscoveryDraft` that **transitions a pipeline**: the stage completes, the
 * interpreter reads the verdict, the task moves, and the `onboarding.discovery` job records the
 * readiness evaluation off `artifact.created`. An ask transitions nothing — it deliberately never
 * writes the `tasks` row at all, because it runs beside whatever the pipeline is doing. So this is
 * still the choice that reuses a mechanism rather than adding one: the ask has an executor because
 * there was no stage to reuse, not because a stage was in the way.
 *
 * ## The ticket that does not exist
 *
 * `tasks` requires a ticket provider, key and URL, and a project being onboarded has no ticket. The
 * task therefore carries a **platform-issued** reference: provider {@link DISCOVERY_TICKET_PROVIDER},
 * key {@link DISCOVERY_TICKET_KEY} and the project's own page as the URL. Two consequences worth
 * knowing. First, `unique (project_id, ticket_key, mode)` is what makes this command idempotent —
 * a second call finds the row and starts nothing, which is the answer product/06 needs because
 * re-running discovery would spend a second budget for the same question. Second, no
 * task-management adapter is ever asked about this key: the ticket snapshot stays `null`, which
 * `ensureTicketSnapshot` already treats as "the platform has not read this ticket" rather than as
 * an error.
 *
 * ## The shape
 *
 * Read, decide, write, enqueue — the same as `runIntakeCheck` minus its two provider calls, which
 * is why this is not a `pipeline.outbound` duty: there is nothing outside the database to ask.
 * `enqueueStage` runs after the transaction commits, because `Jobs.enqueue` does not join it
 * (TD-004), and the stage job re-validates when it fires.
 */
import type { Id, IsoDateTime, PipelineTemplate } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { compilePipeline, createTask, interpret, resolveIterationLimits } from '@platform/domain';
import { enqueueStage } from '../pipeline/jobs.js';
import type { ProjectSettingsPort } from '../pipeline/settings.js';
import {
  INITIAL_TASK_VERSION,
  PIPELINE_ACTOR,
  type PipelineStore,
  type StoredTask,
} from '../pipeline/store.js';
import { applyDecision } from '../pipeline/transitions.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The template id `DISCOVERY_TEMPLATE` is registered under in `SHIPPED_TEMPLATES`. */
export const DISCOVERY_TEMPLATE_ID = 'discovery';

/**
 * The ticket reference a discovery task carries.
 *
 * `platform` is not a provider this build ships, deliberately: nothing may resolve it to an
 * adapter and try to transition a ticket that does not exist.
 */
export const DISCOVERY_TICKET_PROVIDER = 'platform';
export const DISCOVERY_TICKET_KEY = 'onboarding-discovery';

export interface StartDiscoveryOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly settings: ProjectSettingsPort;
  readonly jobs: Jobs;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  /** `APP_BASE_URL`; the project's own page stands in for the ticket's URL. */
  readonly baseUrl: string;
  readonly logger?: Logger;
}

export type StartDiscoveryResult =
  /** A discovery task was created and its stage enqueued. */
  | { readonly status: 'started'; readonly taskId: Id; readonly detail: string }
  /** The project already has one; nothing was created and no budget was spent. */
  | { readonly status: 'already_started'; readonly taskId: Id; readonly detail: string }
  /** The project's settings carry no `discovery` template — a deployment problem, named. */
  | { readonly status: 'unavailable'; readonly detail: string };

const ticketFor = (baseUrl: string, projectId: Id) => ({
  provider: DISCOVERY_TICKET_PROVIDER,
  key: DISCOVERY_TICKET_KEY,
  url: `${baseUrl.replace(/\/+$/, '')}/projects/${projectId}`,
});

const contextFor = (
  options: StartDiscoveryOptions,
  correlationId: Id | null,
  actorUserId: Id | null,
): CommandContext => ({
  ids: options.ids,
  // A human asked for it through the wizard, and the *command* is audited in `human_actions` by the
  // route. The pipeline actor is what stamps the events, because the task is the pipeline's from
  // the moment it exists — the same answer `runIntakeCheck` gives for a ticket a rule matched.
  actor: actorUserId === null ? PIPELINE_ACTOR : { kind: 'user' as const, user_id: actorUserId },
  clock: options.clock as CommandContext['clock'],
  correlationId,
  causeEventId: null,
});

/**
 * Creates the project's discovery task and enqueues its one agent stage.
 *
 * Idempotent on the project: a second call returns the existing task with `already_started`.
 *
 * ## The residual: a lost enqueue is not recovered, and the retry cannot tell
 *
 * `enqueueStage` runs **after** the transaction commits, because `Jobs.enqueue` does not join it
 * (TD-004). A process that dies in that window leaves a discovery task `active` at a stage no job
 * will ever run — and because the command is idempotent on `(project_id, ticket_key, mode)`, every
 * later call answers `already_started` with that task's id **for ever**. The wizard shows a run
 * that never finishes and offers no way out; nothing escalates, because nothing has failed.
 *
 * It is the shape PROGRESS backlog **20** describes for a matched ticket, and the fix has the same
 * shape as that one's: a pass that finds a task sitting at its first stage with no `runs` row and
 * re-enqueues it, bounded to one attempt by the system actor it stamps
 * (`pipeline/intake-reconcile.ts` is the worked example, down to why the recovery is task-shaped
 * rather than a replay). It is **not** built here — one more reconciler is a maintenance schedule
 * with its own queue, interval and pool reservation — and it is in `PROGRESS.md` under Discovered
 * work so it can be scheduled rather than remembered.
 */
export const startProjectDiscovery = async (
  options: StartDiscoveryOptions,
  input: { readonly projectId: Id; readonly requestedByUserId: Id | null },
): Promise<StartDiscoveryResult> => {
  const logger = options.logger ?? silentLogger;
  const { projectId } = input;
  const ticket = ticketFor(options.baseUrl, projectId);

  const settings = await options.settings.forProject(projectId);
  const template = settings.templates[DISCOVERY_TEMPLATE_ID];
  if (template === undefined) {
    // Named rather than silently falling back to `feature`, which would run a whole delivery
    // pipeline on a project that has no ticket (standing rule 20: fail closed on a mutation).
    return {
      status: 'unavailable',
      detail: `this project's settings define no "${DISCOVERY_TEMPLATE_ID}" template, so there is no pipeline to run the Discovery agent on`,
    };
  }

  const existing = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.findByTicket(scope.tx, {
      projectId,
      provider: ticket.provider,
      ticketKey: ticket.key,
      mode: 'normal',
    }),
  );
  if (existing !== null) {
    return {
      status: 'already_started',
      taskId: existing.task.id,
      detail:
        'this project already has a discovery task; re-running discovery would spend a second budget for the same question',
    };
  }

  const outcome = await options.unitOfWork.transaction(async (scope) => {
    // Re-read inside the transaction: two wizard clicks race, and the unique index
    // `(project_id, ticket_key, mode)` is what actually decides — this read is what turns the
    // loser into an answer rather than into a constraint violation.
    const raced = await options.store.tasks.findByTicket(scope.tx, {
      projectId,
      provider: ticket.provider,
      ticketKey: ticket.key,
      mode: 'normal',
    });
    if (raced !== null) {
      return { started: false, taskId: raced.task.id, work: null };
    }

    const created = createTask(
      {
        id: options.ids.next(),
        projectId,
        ticket,
        template: DISCOVERY_TEMPLATE_ID,
        mode: 'normal',
        limits: resolveIterationLimits(settings.config.pipeline?.limits),
      },
      contextFor(options, null, input.requestedByUserId),
    );
    const stored: StoredTask = {
      task: created.aggregate,
      template: template as PipelineTemplate,
      // Discovery blocks the wizard, so it goes to the front of the queue when the WIP policy
      // orders one. Zero is the most urgent rank `priorityRankOf` produces.
      priorityRank: 0,
      createdAt: options.clock.now() as IsoDateTime,
      branch: null,
      mr: null,
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      version: INITIAL_TASK_VERSION,
      // There is no ticket to read, so there is no snapshot. `null` is exactly what
      // `ensureTicketSnapshot` reads as "the platform has not read this ticket".
      ticketSnapshot: null,
      reviewSubject: null,
      ticketSnapshotAt: null,
      // No merge request, so nothing to classify, and no requester on the row: the wizard's actor
      // is recorded in `human_actions` by the route (WP-37 reads both and says so).
      riskClasses: [],
      coverage: null,
      requestedByUserId: null,
    };
    await options.store.tasks.insert(scope.tx, stored);

    /**
     * **No WIP admission check, and that is a decision rather than an omission.**
     *
     * `evaluateTaskAdmission` parks a task behind `max_parallel_runs` so that a busy project does
     * not start an eleventh delivery. Discovery is not a delivery: it is the step that makes the
     * project usable at all, it runs once per project, and a queued discovery task would leave the
     * wizard waiting on a dequeue that only a *ticket* finishing can trigger. The cost is one
     * Sonnet run over the WIP limit, capped at `DEFAULT_STAGE_RUN_BUDGET_USD.discovery`, and the
     * org and project **budgets** still apply — the admission guard the stage executor consults
     * before creating the run is untouched.
     */
    const pipeline = compilePipeline(DISCOVERY_TEMPLATE_ID, stored.template);
    const applied = await applyDecision({
      store: options.store,
      pipeline,
      tx: scope.tx,
      stored,
      decision: interpret(pipeline, { kind: 'start' }),
      context: contextFor(options, stored.task.id, input.requestedByUserId),
      causedByEventId: null,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await scope.events.append([...created.events, ...applied.events]);
    return { started: true, taskId: stored.task.id, work: applied.work };
  });

  if (outcome.work !== null) {
    await enqueueStage(options.jobs, outcome.work);
  }
  if (!outcome.started) {
    return {
      status: 'already_started',
      taskId: outcome.taskId,
      detail: 'another request created this project’s discovery task first',
    };
  }
  logger.info(
    { project_id: projectId, task_id: outcome.taskId },
    'the onboarding wizard started a discovery run',
  );
  return {
    status: 'started',
    taskId: outcome.taskId,
    detail: 'the Discovery agent is queued; follow the task for its draft',
  };
};
