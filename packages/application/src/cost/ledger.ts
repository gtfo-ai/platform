/**
 * The cost ledger — technical/02's *"`run.finished` / `run.failed` → Cost ledger (10)"*.
 *
 * One handler, in TD-005's core band, doing four things in one transaction: append the
 * `cost_entries` rows, write `run_model_usage`, fold the rollup, and move every budget the spend is
 * charged to. They commit together with the `handler_executions` claim, so a redelivered event
 * cannot double-count and a failure leaves nothing half-written.
 *
 * ## It was declared a loss before it existed, and that is why the backfill exists
 *
 * `EVENT_CONSUMPTION` declared both types `unconsumed` from WP-15a until this work package, so the
 * outbox sweep **completed** them and every run that finished before today is missing from the
 * ledger. `events` is append-only (TD-005 `REVOKE DELETE`) and the payload carries `usage`,
 * `model_usage`, `cost`, `num_turns` and `wall_ms`, so nothing is lost — it has to be read back.
 * `events/replay.ts` is that read-back, and it is a **new** mechanism rather than a re-dispatch:
 * see its docblock for why `handler_executions` is the right idempotency key for it and the
 * `event_dispatch` queue is not.
 *
 * ## What reaches a row
 *
 * Numbers and identifiers. The ledger stores no text from a payload except the **model id**, which
 * is bounded and refused rather than truncated (`MAX_LEDGER_MODEL_ID_LENGTH`); a `run.failed`'s
 * `error` string — the one field that carries a provider's or an agent's own words — is read for
 * nothing and stored nowhere (TD-012, BD-022).
 */
import type { DomainEvent, Id, IsoDateTime, ModelUsage, TokenUsage } from '@platform/contracts';
import type { Budget, CommandContext, PriceRates } from '@platform/domain';
import {
  isStorableModelId,
  ledgerEntriesForRun,
  recordSpend,
  rollupDeltasFor,
  spendTotalUsd,
} from '@platform/domain';
import type { EventHandler, HandlerContext } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { CostStore, StoredBudget } from './ports.js';
import { budgetWindowStart, resolveBudgetTimezone, rollupDay } from './window.js';

/** The handler's name is its `handler_executions` key; renaming it re-runs it over the whole log. */
export const COST_LEDGER_HANDLER = 'cost.ledger';

/** technical/02's "Core consumers" column gives the cost ledger priority 10. */
export const COST_LEDGER_PRIORITY = 10;

export interface CostLedgerOptions {
  readonly store: CostStore;
  /** Builds the `CommandContext` the budget aggregate emits its events with. */
  readonly context: (correlationId: Id, causeEventId: Id | null) => CommandContext;
  readonly logger?: Logger;
}

/** The fields the two events share, after the store has answered what the payload cannot. */
interface RunSpendPayload {
  readonly runId: Id;
  readonly usage: TokenUsage | null;
  readonly modelUsage: readonly ModelUsage[];
  readonly usd: number | null;
  readonly isEstimate: boolean;
  readonly numTurns: number;
  readonly wallMs: number;
}

/**
 * Reads the payload of either event into one shape.
 *
 * `run.failed` carries `usage` and `cost` as **nullish** and has no `model_usage`, `num_turns` or
 * `wall_ms` at all. Absent is not zero (standing rule 16): a missing cost becomes `null` and is
 * priced from the table or refused, never recorded as a free run.
 */
const spendOf = (event: DomainEvent): RunSpendPayload | null => {
  if (event.type === 'run.finished') {
    const { payload } = event;
    return {
      runId: payload.run_id,
      usage: payload.usage,
      modelUsage: payload.model_usage,
      usd: payload.cost.usd,
      isEstimate: payload.cost.is_estimate,
      numTurns: payload.num_turns,
      wallMs: payload.wall_ms,
    };
  }
  if (event.type === 'run.failed') {
    const { payload } = event;
    return {
      runId: payload.run_id,
      usage: payload.usage ?? null,
      modelUsage: [],
      usd: payload.cost?.usd ?? null,
      isEstimate: payload.cost?.is_estimate ?? false,
      numTurns: 0,
      wallMs: 0,
    };
  }
  return null;
};

/**
 * Rehydrates the Budget aggregate from its projection row.
 *
 * `exhaustedNotified` is **derived** rather than stored: `recordSpend` emits `budget.exhausted` the
 * first time `spent >= limit`, and that event and the `spent_usd` it was computed from commit in
 * one transaction — so a stored spend at or over the limit is exactly the state in which the event
 * has already been emitted. The one case where the derivation differs from a stored flag is a human
 * *raising* the cap, which puts the budget back under its limit and should announce the next
 * crossing again (product/09: "a human may raise the cap").
 */
const toBudget = (stored: StoredBudget): Budget => ({
  id: stored.id,
  scope: stored.scope,
  scopeId: stored.scopeId,
  projectId: stored.projectId,
  window: stored.window,
  limitUsd: stored.limitUsd,
  notifyPct: stored.notifyPct,
  spentUsd: stored.spentUsd,
  windowStart: stored.windowStart,
  notifiedPct: stored.notifiedPct,
  exhaustedNotified: stored.spentUsd >= stored.limitUsd,
  sequence: stored.sequence,
});

/**
 * The organisation's zone, or UTC — and it **fails open** (standing rule 20).
 *
 * The substitution itself is `resolveBudgetTimezone` (`./window.js`), shared with the budgets read
 * and the guard so one bad setting cannot produce three different behaviours. What is *this*
 * caller's is the report: a handler that threw would park the run stream behind it and stop charging
 * every project, so an unusable zone is logged **by name** and the spend is recorded in UTC, which is
 * what an unset zone already means (Q12).
 *
 * **The residual, stated rather than implied: no row records that the substitution happened.**
 * `cost_rollup_daily.day` and `budget_windows.window_start` carry the *result* of the calendar and
 * not the calendar, so a reconciliation that finds a day it did not expect has this warning and
 * nothing else to explain it — and a log is not an audit record (BD-003). A column would fix that
 * and is not worth a migration for a state an operator creates by typing an offset into a setting
 * that `assertTimeZone` already rejects everywhere else; the honest mitigation is that the warning
 * is **asserted by name** (`packages/application/src/cost/ledger.test.ts` › "falls back to UTC on a
 * zone it cannot compute in, and says so by name"), so it cannot silently stop being emitted. Filed under discovered work.
 */
const usableTimezone = (configured: string | null, logger: Logger): string => {
  const resolved = resolveBudgetTimezone(configured);
  if (resolved.substituted) {
    logger.warn(
      { timezone: configured, fallback: resolved.timezone },
      'cost ledger: the organisation timezone is not an IANA zone this runtime can do DST arithmetic in; the spend is recorded in UTC',
    );
  }
  return resolved.timezone;
};

/** Folds one run's spend into every applicable budget and emits what that crosses. */
const chargeBudgets = async (
  options: CostLedgerOptions,
  context: HandlerContext,
  subject: { readonly projectId: Id; readonly taskId: Id },
  usd: number,
  at: IsoDateTime,
  timezone: string,
): Promise<number> => {
  const windowStartOf = (window: Parameters<typeof budgetWindowStart>[0]) =>
    budgetWindowStart(window, at, timezone);
  const budgets = await options.store.budgets.applicable(context.scope.tx, subject, windowStartOf);
  const emitted: DomainEvent[] = [];
  for (const stored of budgets) {
    const decision = recordSpend(
      toBudget(stored),
      { usd },
      options.context(subject.taskId, context.event.event.id),
    );
    await options.store.budgets.saveWindow(context.scope.tx, {
      budgetId: stored.id,
      windowStart: stored.windowStart,
      spentUsd: decision.aggregate.spentUsd,
      notifiedPct: decision.aggregate.notifiedPct,
    });
    emitted.push(...decision.events);
  }
  if (emitted.length > 0) {
    await context.emit(emitted);
  }
  return budgets.length;
};

/**
 * `run.finished` / `run.failed` → the ledger, the rollup and the budgets.
 *
 * Finding no run row is a **success**, not an error: a run the platform no longer has is a run
 * whose project was deleted, and failing the handler would park the event's whole stream behind it
 * (the dispatcher blocks a stream on a failed handler, by design).
 */
export const costLedgerHandler = (options: CostLedgerOptions): EventHandler => ({
  name: COST_LEDGER_HANDLER,
  priority: COST_LEDGER_PRIORITY,
  eventTypes: ['run.finished', 'run.failed'],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const spend = spendOf(context.event.event);
    if (spend === null) {
      return;
    }
    const run = await options.store.runContext(context.scope.tx, spend.runId);
    if (run === null) {
      logger.warn(
        { run_id: spend.runId, position: context.event.position },
        'cost ledger: no run row for this event, so nothing is charged',
      );
      return;
    }

    const occurredAt = context.event.event.occurred_at;
    const pricedAt = run.startedAt ?? occurredAt;
    const models = (
      spend.modelUsage.length > 0 ? spend.modelUsage.map((entry) => entry.model) : [run.model]
    ).filter(isStorableModelId);
    const prices = await options.store.pricesAt(context.scope.tx, models, pricedAt);
    const byModel = new Map<string, PriceRates>(prices.map((rate) => [rate.modelId, rate]));

    const derived = ledgerEntriesForRun(
      {
        runId: run.runId,
        taskId: run.taskId,
        projectId: run.projectId,
        orgId: run.orgId,
        template: run.template,
        // A run outside a pipeline stage still belongs in the ledger; the rollup's `stage` column
        // is `not null`, so the absence is spelled once, here, rather than as an empty string.
        stage: run.stage ?? '(none)',
        model: run.model,
      },
      spend,
      (model) => byModel.get(model) ?? null,
    );

    if (derived.modelUsage.length > 0) {
      await options.store.saveModelUsage(
        context.scope.tx,
        derived.modelUsage.map((entry) => ({ runId: run.runId, ...entry })),
      );
    }

    if (derived.unpricedModels.length > 0 || derived.refusedModels.length > 0) {
      logger.warn(
        {
          run_id: run.runId,
          unpriced_models: derived.unpricedModels,
          refused_models: derived.refusedModels.length,
          priced_at: pricedAt,
        },
        'cost ledger: a model could not be charged — no price row, or an id too long to key a row on',
      );
    }

    if (derived.entries.length === 0) {
      logger.debug(
        { run_id: run.runId, reason: derived.reason },
        'cost ledger: this run owes no ledger row',
      );
      return;
    }

    const timezone = usableTimezone(
      await options.store.organisationTimezone(context.scope.tx, run.projectId),
      logger,
    );

    await options.store.appendEntries(context.scope.tx, derived.entries);
    await options.store.applyRollups(
      context.scope.tx,
      rollupDeltasFor(derived.entries, {
        numTurns: spend.numTurns,
        wallMs: spend.wallMs,
        day: rollupDay(occurredAt, timezone),
      }),
    );

    const total = spendTotalUsd(derived.entries);
    const budgets =
      total > 0
        ? await chargeBudgets(
            options,
            context,
            { projectId: run.projectId, taskId: run.taskId },
            total,
            occurredAt,
            timezone,
          )
        : 0;

    logger.debug(
      {
        run_id: run.runId,
        entries: derived.entries.length,
        usd: total,
        is_estimate: derived.entries.some((entry) => entry.isEstimate),
        residual_usd: derived.residualUsd,
        budgets,
      },
      'cost ledger: a run was charged',
    );
  },
});
