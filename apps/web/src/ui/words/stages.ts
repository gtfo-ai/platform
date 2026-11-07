/**
 * **The stage words** (TD-033 decision 6): every stage the platform ships, and a project's own stage title-cased rather than printed raw.
 *
 * A module of its own, re-exported unchanged by `ui/humanize.ts` (the screens import it from there):
 * the worker's local page imports **this** module and never `humanize.ts`, so its 120 kB entry
 * carries only the words it shows — `worker/import-graph.test.ts` holds that (BACKLOG 1455).
 */
import type { BUILTIN_STAGE_IDS } from '@platform/contracts';

/** The ticket flow's stages plus the four the one-off templates add (discovery, lint, history, spike). */
export type ShippedStageId =
  | (typeof BUILTIN_STAGE_IDS)[number]
  | 'discovery'
  | 'ticket_lint'
  | 'history_mining'
  | 'human_review';

export const STAGE_LABEL: Readonly<Record<ShippedStageId, string>> = {
  intake: 'Intake',
  refinement: 'Refinement',
  investigation: 'Investigation',
  architecture: 'Architecture',
  implementation: 'Implementation',
  conflict_resolution: 'Conflict resolution',
  ci_gate: 'CI',
  code_review: 'Code review',
  business_review: 'Business review',
  rebase_gate: 'Up-to-date check',
  qa: 'QA',
  ready_for_merge: 'Ready to merge',
  merged_gate: 'Merge check',
  retrospective: 'Retrospective',
  librarian: 'Librarian',
  done: 'Done',
  discovery: 'Discovery',
  ticket_lint: 'Ticket check',
  history_mining: 'History mining',
  human_review: 'Human review',
};

/** `foo_bar-baz` → `Foo Bar Baz`: a project's own stage slug, never printed raw. */
export const titleCase = (slug: string): string =>
  slug
    .split(/[_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');

/** A stage's human name: the shipped word, or the slug title-cased for a project's own stage. */
export const stageLabel = (id: string): string =>
  Object.hasOwn(STAGE_LABEL, id) ? STAGE_LABEL[id as ShippedStageId] : titleCase(id);
