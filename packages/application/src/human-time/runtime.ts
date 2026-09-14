/**
 * Composing the human-time projection: the handlers a bus registers.
 *
 * The same shape as `cost/runtime.ts` and for the same reason — which handler listens to which
 * event at which priority is the *product*, not a detail of a composition root. It is one handler,
 * and the list exists anyway so that `EVENT_CONSUMPTION` can be held to it by a test reading the
 * types **off the handler** rather than from a second list written in the test (standing rule 7).
 *
 * It costs **no extra pooled connection**: the handler runs inside the dispatcher's own handler
 * transaction, which `CONNECTIONS_PER_DISPATCH` already counts.
 */
import type { EventHandler } from '../events/handler.js';
import { type HumanTimeProjectorOptions, humanTimeProjector } from './projector.js';

export type HumanTimeRuntimeOptions = HumanTimeProjectorOptions;

export const humanTimeHandlers = (options: HumanTimeRuntimeOptions): readonly EventHandler[] => [
  humanTimeProjector(options),
];
