/**
 * Composing the statistics projection: the handlers a bus registers (WP-41).
 *
 * The same shape as `cost/runtime.ts` and `human-time/runtime.ts`, and for the same reason — which
 * handler listens to which event at which priority is the *product*, not a detail of a composition
 * root. The list exists although it holds one handler so that `EVENT_CONSUMPTION` can be held to it
 * by a test reading the types **off the handler** rather than from a second list written in the
 * test (standing rule 7).
 *
 * It costs **no extra pooled connection**: the projector runs inside the dispatcher's own handler
 * transaction, which `CONNECTIONS_PER_DISPATCH` already counts.
 */
import type { EventHandler } from '../events/handler.js';
import { type StatsProjectorOptions, statsProjector } from './projector.js';

export type StatsRuntimeOptions = StatsProjectorOptions;

export const statsHandlers = (options: StatsRuntimeOptions): readonly EventHandler[] => [
  statsProjector(options),
];
