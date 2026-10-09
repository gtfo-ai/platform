/**
 * **The production planners, which offer a run only the tools this build performs** (PROGRESS
 * backlog 476; WP-180's review asked for this as a behaviour, WP-181 built it).
 *
 * `createStageRunPlanner` and `createAskRunPlanner` take `availablePlatformTools`, and a planner
 * composed without it offers every tool in the role's `PLATFORM_TOOLS_BY_ROLE` row — including the
 * four this build only refuses (`ask_human`, `notify_human`, `add_ticket_comment`,
 * `create_followup_ticket`). Until WP-181 the composition root was held to passing it by a text
 * census over `pipeline.ts`, which a spread or a renamed variable walks past.
 *
 * So the option is fixed **here**, where the type forbids a caller to pass another
 * (`Omit<…, 'availablePlatformTools'>`), and `run-planners.test.ts` plans a stage run and an ask
 * through these two functions and asserts the spec's `platformTools` — a behaviour, not a spelling.
 * What is left to text is only that `pipeline.ts` builds its planners through these two and through
 * nothing else (`platform-tools.test.ts`).
 */
import { createAskRunPlanner, createStageRunPlanner } from '@platform/application';
import { IMPLEMENTED_PLATFORM_TOOLS } from './platform-tools.js';

type StagePlannerOptions = Parameters<typeof createStageRunPlanner>[0];
type AskPlannerOptions = Parameters<typeof createAskRunPlanner>[0];

/** The stage planner production composes: every option but the tool list, which is this build's. */
export const createProductionStagePlanner = (
  options: Omit<StagePlannerOptions, 'availablePlatformTools'>,
): ReturnType<typeof createStageRunPlanner> =>
  createStageRunPlanner({ ...options, availablePlatformTools: IMPLEMENTED_PLATFORM_TOOLS });

/** The ask planner production composes, held the same way. */
export const createProductionAskPlanner = (
  options: Omit<AskPlannerOptions, 'availablePlatformTools'>,
): ReturnType<typeof createAskRunPlanner> =>
  createAskRunPlanner({ ...options, availablePlatformTools: IMPLEMENTED_PLATFORM_TOOLS });
