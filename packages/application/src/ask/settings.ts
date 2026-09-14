/**
 * `features.ask`, resolved once — product/18:34, Q72 (c) and (d) (WP-31).
 *
 * One function rather than four `?? DEFAULT_…` expressions spread over the command, the planner and
 * the mirror duty. The three places that read this key each decide something a human notices — may I
 * ask at all, what may this question cost, does the answer go on the ticket — and a default that was
 * spelled differently in one of them would be a setting that half worked.
 *
 * The values come from the **effective** configuration, so a project that never chose gets
 * `PLATFORM_DEFAULT_CONFIG.features.ask`, which is product/18's own default column: on, Sonnet 5,
 * 0.50 USD a question, mirror off.
 */
import { DEFAULT_ASK_BUDGET_USD, DEFAULT_ASK_MODEL } from '@platform/domain';
import type { ProjectSettings } from '../pipeline/settings.js';

export interface AskFeature {
  readonly enabled: boolean;
  readonly model: string;
  /** The per-question cap, in USD. */
  readonly budgetUsd: number;
  /** Q72 (d): off unless the project asked for it. */
  readonly mirrorToTicket: boolean;
}

export const askFeature = (settings: ProjectSettings): AskFeature => {
  const configured = settings.config.features?.ask;
  return {
    // `?? true` and not `=== true`: product/18's default column is **on**, and a project that has
    // never written the key has not turned the feature off.
    enabled: configured?.enabled ?? true,
    model: configured?.model ?? DEFAULT_ASK_MODEL,
    budgetUsd: configured?.budget_usd ?? DEFAULT_ASK_BUDGET_USD,
    // `=== true` here, because this one decides whether the platform writes in somebody else's
    // ticket tracker: the absent value must be the quiet one (Q72 (d), standing rule 20).
    mirrorToTicket: configured?.mirror_to_ticket === true,
  };
};
