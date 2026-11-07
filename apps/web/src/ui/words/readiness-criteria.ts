/**
 * **The readiness criteria's names** — the onboarding wizard's readiness panel and the readiness
 * popover.
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */
/**
 * The fourteen readiness criteria (`R1` … `R14`), each as a short human name for the wizard's
 * readiness panel — the id itself moves behind *Details*. The ids are the domain's
 * `READINESS_CRITERION_IDS`; the readiness record carries them as plain strings, so the map is held
 * equal to the domain's list by `humanize.test.ts` rather than by the type, and an id this build
 * does not know is shown as itself (`readinessCriterionLabel`) rather than dropped.
 */
export const READINESS_CRITERION_LABEL: Readonly<Record<string, string>> = {
  R1: 'Tests run green',
  R2: 'Tests are fast',
  R3: 'CI runs on merge requests',
  R4: 'CI is reliable',
  R5: 'Lint and formatting in CI',
  R6: 'One-command setup',
  R7: 'Type checks in CI',
  R8: 'Instructions for agents',
  R9: 'Protected default branch',
  R10: 'Merge request template and commit convention',
  R11: 'Logs and errors connected',
  R12: 'Knowledge base mostly complete',
  R13: 'Secret scanning',
  R14: 'Installable lockfile',
};

/** A readiness criterion's human name, or its id when this build has no word for it. */
export const readinessCriterionLabel = (id: string): string =>
  Object.hasOwn(READINESS_CRITERION_LABEL, id) ? (READINESS_CRITERION_LABEL[id] ?? id) : id;
