/**
 * Composing the cost ledger: the handlers a bus registers.
 *
 * The same shape as `pipeline/runtime.ts` and for the same reason — which handler listens to which
 * event at which priority is the *product*, not a detail of a composition root — but far smaller,
 * because the ledger owns no queue and no worker. The one scheduled job it needs (price-table
 * maintenance) belongs to the adapter that can read the table, and is registered beside the
 * partition maintenance in `@platform/infrastructure`.
 *
 * It costs **no extra pooled connection**: both handlers run inside the dispatcher's own handler
 * transaction, which is already counted by `CONNECTIONS_PER_DISPATCH`.
 */
import type { EventHandler } from '../events/handler.js';
import { costEstimateHandler } from './estimate.js';
import { type CostLedgerOptions, costLedgerHandler } from './ledger.js';

export type CostRuntimeOptions = CostLedgerOptions;

/**
 * The ledger and the estimate, in priority order.
 *
 * Exported as one list so that `EVENT_CONSUMPTION` can be held to it by a test rather than by a
 * second hand-written list of event types (standing rule 7): `consumption.test.ts` reads the types
 * off these handlers and fails if any of them is still declared `unconsumed`.
 */
export const costHandlers = (options: CostRuntimeOptions): readonly EventHandler[] => [
  costLedgerHandler(options),
  costEstimateHandler({
    store: options.store,
    ...(options.logger ? { logger: options.logger } : {}),
  }),
];
