/**
 * A maintainer's **re-evaluate** — discovery run again on a project that already had it
 * (WP-94, PROGRESS backlog 230, Q107 answered (a) per its recommendation, reversible by the founder).
 *
 * ## Why this exists
 *
 * The post-merge re-check (`recheck.ts`) re-answers seven of product/17's fourteen criteria without
 * a run; the other seven (R1, R2, R4–R7, R14) need a workspace and keep the answer the first
 * discovery gave. Every rung of the ladder needs at least one of them, so before this command a
 * project that fixed what onboarding found could not rise past the rung discovery left it on:
 * `startProjectDiscovery` is idempotent on the project, and a second start answers
 * `already_started`. Readiness was a snapshot, not a measurement.
 *
 * ## What it is: a new one-off discovery task, with every guard the first had
 *
 * Q107 (a): a **new** task on the same `discovery` template, created by the same code as the first
 * (`openDiscoveryTask`), so its one agent stage is admitted by the stage executor's guard, charged
 * to the cost ledger, transcribed, capped by the stage's run budget and the task budget, and
 * escalated like any run — there is no second entry point to any of those. The first run's task and
 * its evaluation stand: the new task has a ticket key of its own ({@link REDISCOVERY_TICKET_KEY_PREFIX})
 * and the evaluation it records is written with `source: 'rediscovery'` (`record.ts`), beside
 * `discovery` and `recheck`. It spends money only on a human's click and needs no scheduler.
 *
 * ## The key, and the three things it decides
 *
 * `rediscoveryTicketKeyFor(basis, attempt)` — the project's **latest evaluation** id (the question
 * this run re-asks) and an attempt number from 1 to {@link MAX_REDISCOVERY_ATTEMPTS}. Under
 * `unique (project_id, ticket_key, mode)`:
 *
 *  1. two maintainers clicking at once compute the same key, so one task is created and the other
 *     click is answered from it (the same in-transaction re-read the first discovery uses — the
 *     index decides, the re-read turns the loser into an answer);
 *  2. a re-evaluation that **recorded** something changes the latest evaluation, so the next click
 *     has a fresh key — there is no counter to keep;
 *  3. a re-evaluation that recorded **nothing** (its run failed, or its draft did not parse) leaves
 *     the basis unchanged, so the next click takes the next attempt; after
 *     {@link MAX_REDISCOVERY_ATTEMPTS} such runs on one basis the command refuses by name, because
 *     a third run that records nothing is a fault for a human to read, not a button to press again.
 *
 * ## One discovery at a time
 *
 * Any discovery task of the project that is not `done` or `cancelled` — the first one or an earlier
 * re-evaluation, running or parked in `needs_human` — blocks a new one, and the answer names that
 * task. A parked run is a human's decision in progress, and a second run beside it would spend a
 * second budget on the same question.
 *
 * ## The gate is published on the read
 *
 * {@link readRediscoveryGate} answers the blocker and the estimate from the same reads the command
 * makes, so the screen states *why* the button is off rather than offering one that answers 409
 * (`historyBootstrapBlocker`'s rule, standing rule 9). The estimate is the **ceiling** — the
 * `discovery` stage's run budget, which is what the admission guard reserves — beside what the
 * project's previous discovery actually cost, when it has one. The ceiling is a cap, not a
 * prediction, and the screen says so.
 *
 * ## The residual, stated
 *
 * A race between two clicks that both pass the in-transaction re-read loses one insert to the
 * unique index, which surfaces as a failed request rather than an answer — the first discovery has
 * the same residual. And a re-evaluation drafts knowledge pages again, like the first run: they
 * reach the proposal queue as `bootstrap` proposals (a page the index already holds becomes an
 * update), never a commit.
 */
import type { Id, IsoDateTime, PipelineTemplate, TaskState } from '@platform/contracts';
import { DISCOVERY_TEMPLATE_ID } from '@platform/domain';
import { enqueueStage } from '../pipeline/jobs.js';
import type { ProjectSettings } from '../pipeline/settings.js';
import { runBudgetUsd } from '../pipeline/stage-executor.js';
import type { PipelineStore, StoredTask } from '../pipeline/store.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import {
  DISCOVERY_TICKET_KEY,
  DISCOVERY_TICKET_PROVIDER,
  openDiscoveryTask,
  type StartDiscoveryOptions,
} from './discovery.js';
import type { ReadinessStore } from './ports.js';

/** Every re-evaluation's ticket key starts with this; `record.ts` reads it to name the source. */
export const REDISCOVERY_TICKET_KEY_PREFIX = 'onboarding-rediscovery-';

/** `readiness_evaluations.source` for an evaluation a re-evaluation recorded (Q107 (a)). */
export const REDISCOVERY_SOURCE = 'rediscovery';

/**
 * How many re-evaluations may record nothing on one basis before the command refuses by name.
 *
 * Three, because one failed run is weather, two is a pattern, and a third spent on the same
 * question with nothing recorded is a fault a human should read before the platform spends again.
 */
export const MAX_REDISCOVERY_ATTEMPTS = 3;

/** The stage every discovery task runs, which is what the estimate is the run budget of. */
const DISCOVERY_STAGE = 'discovery';

/** Whether a task's ticket key is a re-evaluation's (as opposed to the first discovery's). */
export const isRediscoveryTicketKey = (key: string): boolean =>
  key.startsWith(REDISCOVERY_TICKET_KEY_PREFIX);

/**
 * The key for one re-evaluation of `basis` (the latest evaluation's id, or `null` when the project
 * has none — a first discovery that never recorded) at `attempt` (1-based).
 */
export const rediscoveryTicketKeyFor = (basis: Id | null, attempt: number): string =>
  `${REDISCOVERY_TICKET_KEY_PREFIX}${basis ?? 'unevaluated'}${attempt === 1 ? '' : `-${attempt}`}`;

/** Why a re-evaluation may not start now — each a sentence the screen shows as it is. */
export type RediscoveryBlocker =
  | { readonly code: 'discovery_unavailable'; readonly detail: string }
  | { readonly code: 'discovery_not_started'; readonly detail: string }
  | { readonly code: 'discovery_in_flight'; readonly taskId: Id; readonly detail: string }
  | { readonly code: 'rediscovery_attempts_spent'; readonly detail: string };

export interface RediscoveryGate {
  /** The `discovery` stage's run budget — the ceiling the admission guard reserves, in USD. */
  readonly ceilingUsd: number;
  /**
   * The project's most recent discovery task this gate found — an earlier re-evaluation on the
   * current basis, else the first discovery — with what it cost. `null` before the first one.
   */
  readonly lastDiscovery: {
    readonly taskId: Id;
    readonly state: TaskState;
    readonly costUsd: number;
    /**
     * Why this task's findings were never recorded, when the recovery pass gave up on them (WP-124,
     * PROGRESS backlog 366, `recovery/discovery-record.ts`) — platform text and its instant. Absent
     * or `null` when nothing was lost.
     */
    readonly findingsUnrecorded?: { readonly at: IsoDateTime; readonly reason: string } | null;
  } | null;
  readonly blocker: RediscoveryBlocker | null;
  /** The key the next re-evaluation would take; `null` exactly when {@link blocker} is set. */
  readonly ticketKey: string | null;
}

export interface RediscoveryReadOptions {
  readonly unitOfWork: StartDiscoveryOptions['unitOfWork'];
  readonly store: PipelineStore;
  readonly settings: StartDiscoveryOptions['settings'];
  readonly readiness: Pick<ReadinessStore, 'latest'>;
  /** What "how long ago the live discovery task started" is measured against (WP-108). */
  readonly clock: StartDiscoveryOptions['clock'];
  /**
   * The recovery pass's ending for a discovery task whose findings were never recorded (WP-124),
   * or `null`. Optional: a composition without it publishes `null`, which is every build before.
   */
  readonly findingsUnrecorded?: (
    taskId: Id,
  ) => Promise<{ readonly at: IsoDateTime; readonly reason: string } | null>;
}

/**
 * "12 minutes", "3 hours", "2 days" — whole units, rounded down, never below one minute.
 *
 * Platform text built from two instants the platform wrote, so it may sit in a refusal's detail.
 */
export const elapsedSince = (from: string, now: string): string => {
  const minutes = Math.max(0, Math.floor((Date.parse(now) - Date.parse(from)) / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 120) return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} hours`;
  return `${String(Math.floor(hours / 24))} days`;
};

/**
 * The *active* sentence (WP-108, PROGRESS backlog 320): how long ago the task started, and the way
 * out. Before WP-108 it said only *"follow it"*, which is the wrong advice for a task whose stage
 * job was lost — nothing runs, so there is nothing to follow. The recovery pass now re-enqueues such
 * a stage once and then escalates it, but a maintainer reading the gate should not have to know
 * that to leave: cancel is a maintainer's command (`task.cancel`) and it ends the in-flight claim.
 */
export const discoveryInFlightDetail = (live: StoredTask, now: string): string =>
  `discovery task ${live.task.id} started ${elapsedSince(live.createdAt, now)} ago (at ${live.createdAt}) and has not finished; follow it on its task page, or — if its run never started or is no longer wanted — cancel it there (POST /api/tasks/${live.task.id}/cancel), which frees the project for a new evaluation`;

/** States in which a discovery task is over: it holds nothing and blocks nothing. */
const ENDED: readonly TaskState[] = ['done', 'cancelled'];

const summaryOf = (stored: StoredTask) => ({
  taskId: stored.task.id,
  state: stored.task.state,
  costUsd: stored.costActualUsd,
});

/**
 * The decision, inside a transaction the caller owns — so the command decides and inserts under
 * one snapshot, and the read endpoint decides the same way without inserting.
 */
const decide = async (
  store: PipelineStore,
  tx: Transaction,
  input: {
    readonly projectId: Id;
    readonly settings: ProjectSettings;
    readonly basis: Id | null;
    readonly now: string;
  },
): Promise<Omit<RediscoveryGate, 'ceilingUsd'>> => {
  const { projectId } = input;
  if (input.settings.templates[DISCOVERY_TEMPLATE_ID] === undefined) {
    return {
      lastDiscovery: null,
      blocker: {
        code: 'discovery_unavailable',
        detail: `this project's settings define no "${DISCOVERY_TEMPLATE_ID}" template, so there is no pipeline to run the Discovery agent on`,
      },
      ticketKey: null,
    };
  }
  const first = await store.tasks.findByTicket(tx, {
    projectId,
    provider: DISCOVERY_TICKET_PROVIDER,
    ticketKey: DISCOVERY_TICKET_KEY,
    mode: 'normal',
  });
  if (first === null) {
    return {
      lastDiscovery: null,
      blocker: {
        code: 'discovery_not_started',
        detail:
          'this project has never run discovery; start it from the wizard’s technical discovery step (POST /api/projects/:id/discovery), which records the first evaluation',
      },
      ticketKey: null,
    };
  }
  // A discovery task that has not ended sits at its one agent stage (or, for a moment inside its
  // creating transaction, at `intake`). Both are read, and only the discovery template counts.
  const live = [
    ...(await store.tasks.listAtStage(tx, projectId, 'intake')),
    ...(await store.tasks.listAtStage(tx, projectId, DISCOVERY_STAGE)),
  ].find(
    (stored) =>
      stored.task.template === DISCOVERY_TEMPLATE_ID && !ENDED.includes(stored.task.state),
  );
  if (live !== undefined) {
    return {
      lastDiscovery: summaryOf(live),
      blocker: {
        code: 'discovery_in_flight',
        taskId: live.task.id,
        detail:
          live.task.state === 'needs_human'
            ? `discovery task ${live.task.id} is parked for a human; resolve or cancel it before running discovery again`
            : discoveryInFlightDetail(live, input.now),
      },
      ticketKey: null,
    };
  }
  let last: StoredTask = first;
  for (let attempt = 1; attempt <= MAX_REDISCOVERY_ATTEMPTS; attempt += 1) {
    const ticketKey = rediscoveryTicketKeyFor(input.basis, attempt);
    const existing = await store.tasks.findByTicket(tx, {
      projectId,
      provider: DISCOVERY_TICKET_PROVIDER,
      ticketKey,
      mode: 'normal',
    });
    if (existing === null) {
      return { lastDiscovery: summaryOf(last), blocker: null, ticketKey };
    }
    last = existing;
  }
  return {
    lastDiscovery: summaryOf(last),
    blocker: {
      code: 'rediscovery_attempts_spent',
      detail: `${MAX_REDISCOVERY_ATTEMPTS} re-evaluations since the latest evaluation ended without recording one; read their tasks before running discovery again (the next merge's re-check, or a recorded run, opens a new round)`,
    },
    ticketKey: null,
  };
};

/**
 * Whether a re-evaluation may start, and what it may cost — the read endpoint's half.
 *
 * The settings and the latest evaluation are read before the transaction (the settings port refuses
 * to run inside one); the task reads happen inside it.
 */
export const readRediscoveryGate = async (
  options: RediscoveryReadOptions,
  projectId: Id,
): Promise<RediscoveryGate> => {
  const settings = await options.settings.forProject(projectId);
  const latest = await options.readiness.latest(projectId);
  const decided = await options.unitOfWork.transaction(async (scope) =>
    decide(options.store, scope.tx, {
      projectId,
      settings,
      basis: latest?.id ?? null,
      now: options.clock.now(),
    }),
  );
  const last = decided.lastDiscovery;
  const lost =
    last === null || options.findingsUnrecorded === undefined
      ? null
      : await options.findingsUnrecorded(last.taskId);
  return {
    ceilingUsd: runBudgetUsd(settings, DISCOVERY_STAGE),
    ...decided,
    lastDiscovery: last === null ? null : { ...last, findingsUnrecorded: lost },
  };
};

export type StartRediscoveryResult =
  /** A new discovery task was created and its stage enqueued. */
  | {
      readonly status: 'started';
      readonly taskId: Id;
      readonly ceilingUsd: number;
      readonly detail: string;
    }
  /** A discovery task is already live; nothing was created and no budget was spent. */
  | { readonly status: 'in_flight'; readonly taskId: Id; readonly detail: string }
  /** Refused by name — see {@link RediscoveryBlocker}. Nothing was created. */
  | {
      readonly status: 'refused';
      readonly code: Exclude<RediscoveryBlocker['code'], 'discovery_in_flight'>;
      readonly detail: string;
    };

/**
 * Creates a new discovery task for a project that already had one, and enqueues its stage.
 * Decided and created under one transaction; enqueued after the commit (TD-004).
 */
export const startProjectRediscovery = async (
  options: StartDiscoveryOptions & { readonly readiness: Pick<ReadinessStore, 'latest'> },
  input: { readonly projectId: Id; readonly requestedByUserId: Id },
): Promise<StartRediscoveryResult> => {
  const logger = options.logger ?? silentLogger;
  const { projectId } = input;
  const settings = await options.settings.forProject(projectId);
  const latest = await options.readiness.latest(projectId);
  const ceilingUsd = runBudgetUsd(settings, DISCOVERY_STAGE);

  const outcome = await options.unitOfWork.transaction(async (scope) => {
    const decided = await decide(options.store, scope.tx, {
      projectId,
      settings,
      basis: latest?.id ?? null,
      now: options.clock.now(),
    });
    if (decided.blocker !== null || decided.ticketKey === null) {
      return { blocker: decided.blocker, taskId: null, work: null };
    }
    const opened = await openDiscoveryTask(options, scope, {
      projectId,
      ticket: {
        provider: DISCOVERY_TICKET_PROVIDER,
        key: decided.ticketKey,
        url: `${options.baseUrl.replace(/\/+$/, '')}/projects/${projectId}`,
      },
      template: settings.templates[DISCOVERY_TEMPLATE_ID] as PipelineTemplate,
      settings,
      requestedByUserId: input.requestedByUserId,
    });
    return { blocker: null, taskId: opened.taskId, work: opened.work };
  });

  if (outcome.blocker !== null) {
    const blocker = outcome.blocker;
    if (blocker.code === 'discovery_in_flight') {
      return { status: 'in_flight', taskId: blocker.taskId, detail: blocker.detail };
    }
    return { status: 'refused', code: blocker.code, detail: blocker.detail };
  }
  if (outcome.work !== null) {
    await enqueueStage(options.jobs, outcome.work);
  }
  const taskId = outcome.taskId as Id;
  logger.info(
    { project_id: projectId, task_id: taskId, basis_evaluation_id: latest?.id ?? null },
    'a maintainer started discovery again (re-evaluate)',
  );
  return {
    status: 'started',
    taskId,
    ceilingUsd,
    detail: `the Discovery agent is queued again, at most ${ceilingUsd} USD for its run; its evaluation is recorded as a rediscovery beside the earlier ones`,
  };
};
