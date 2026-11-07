/**
 * **The agent roles' words** (TD-033 decision 6).
 *
 * A module of its own, re-exported unchanged by `ui/humanize.ts` (the screens import it from there):
 * the worker's local page imports **this** module and never `humanize.ts`, so its 120 kB entry
 * carries only the words it shows — `worker/import-graph.test.ts` holds that (BACKLOG 1455).
 */
import type { AgentRole } from '@platform/contracts';

export const ROLE_LABEL: Readonly<Record<AgentRole, string>> = {
  triager: 'Triager',
  product_manager: 'Product manager',
  investigator: 'Investigator',
  architect: 'Architect',
  developer: 'Developer',
  reviewer: 'Reviewer',
  acceptance_tester: 'Acceptance tester',
  facilitator: 'Facilitator',
  librarian: 'Librarian',
  discovery: 'Discovery',
  ask: 'Ask',
  historian: 'Historian',
};
