/**
 * The New project wizard's steps, and what each one being *done* means (TD-033 decision 9,
 * research/19 § 6).
 *
 * Pure and dependency-free, so the route tree can validate `?step=` against {@link WIZARD_STEP_IDS}
 * without pulling the wizard's chunk into the initial bundle, and so the rules below are unit-tested
 * as rules rather than through a rendered screen only.
 *
 * ## Done-ness is the server's
 *
 * Nothing here is stored on the client: every fact is a read the wizard already makes.
 *
 * | step | done when |
 * |---|---|
 * | connect | the project exists and has a ticket tracker **and** a git binding |
 * | discovery | a readiness evaluation exists (the readiness read answers 200, not 409) |
 * | business *(optional)* | a business proposal exists in the knowledge queue |
 * | history *(optional)* | a history bootstrap batch exists |
 * | autonomy | the operating mode has been saved (`autonomy.materialised`) |
 * | finish | every required step is done and no knowledge proposal waits for a review |
 *
 * A *Skip for now* records nothing, so a skipped optional step is not done — it simply never gates.
 * A fact that has not been read yet is `null`, never `false`: a wizard that treated "not loaded" as
 * "not done" would resume somebody at a step they finished. A read that **failed** is `false` (the
 * caller's choice, `onboarding.tsx`): it can hold *Continue*, never skip anybody past a step.
 *
 * ## Navigation
 *
 * - **Forward is gated by required steps** (NN/g): a step is reachable once every *required* step
 *   before it is done; the optional ones never gate. Done steps are freely revisitable.
 * - **Resume** (no `?step=`) lands on the first step that is not done — an optional step counts as
 *   passed once any later step is done, so a skipped interview does not pull a person back to it
 *   after they have moved on.
 */

export const WIZARD_STEP_IDS = [
  'connect',
  'discovery',
  'business',
  'history',
  'autonomy',
  'finish',
] as const;

export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export const WIZARD_STEPS: Readonly<
  Record<WizardStepId, { readonly label: string; readonly optional: boolean }>
> = {
  connect: { label: 'Connect', optional: false },
  discovery: { label: 'Technical discovery', optional: false },
  business: { label: 'Business context', optional: true },
  history: { label: 'History', optional: true },
  autonomy: { label: 'How autonomous', optional: false },
  finish: { label: 'Review and finish', optional: false },
};

/** What the wizard knows about the project; `null` is "not read yet". */
export interface WizardFacts {
  readonly projectExists: boolean;
  readonly trackerBound: boolean | null;
  readonly gitBound: boolean | null;
  readonly readinessEvaluated: boolean | null;
  readonly businessProposed: boolean | null;
  readonly historyStarted: boolean | null;
  readonly operatingModeSaved: boolean | null;
  /** No knowledge proposal waits for a maintainer's decision. */
  readonly proposalsReviewed: boolean | null;
}

export type WizardDoneness = Readonly<Record<WizardStepId, boolean | null>>;

/** `a && b` where `null` is unknown: false wins, then unknown. */
const and = (...values: readonly (boolean | null)[]): boolean | null =>
  values.includes(false) ? false : values.includes(null) ? null : true;

export const donenessOf = (facts: WizardFacts): WizardDoneness => {
  if (!facts.projectExists) {
    return {
      connect: false,
      discovery: false,
      business: false,
      history: false,
      autonomy: false,
      finish: false,
    };
  }
  const connect = and(facts.trackerBound, facts.gitBound);
  const discovery = facts.readinessEvaluated;
  const autonomy = facts.operatingModeSaved;
  return {
    connect,
    discovery,
    business: facts.businessProposed,
    history: facts.historyStarted,
    autonomy,
    finish: and(connect, discovery, autonomy, facts.proposalsReviewed),
  };
};

const indexOf = (step: WizardStepId): number => WIZARD_STEP_IDS.indexOf(step);

/** The step before and after `step`, or `null` at either end. */
export const previousStep = (step: WizardStepId): WizardStepId | null =>
  WIZARD_STEP_IDS[indexOf(step) - 1] ?? null;
export const nextStep = (step: WizardStepId): WizardStepId | null =>
  WIZARD_STEP_IDS[indexOf(step) + 1] ?? null;

/**
 * The first required step before `step` that is not done — what keeps `step` closed — or `null`
 * when nothing does. `undefined` while one of them has not been read yet.
 */
export const blockingStepOf = (
  step: WizardStepId,
  done: WizardDoneness,
): WizardStepId | null | undefined => {
  for (const earlier of WIZARD_STEP_IDS.slice(0, indexOf(step))) {
    if (WIZARD_STEPS[earlier].optional) {
      continue;
    }
    if (done[earlier] === null) {
      return undefined;
    }
    if (done[earlier] === false) {
      return earlier;
    }
  }
  return null;
};

/** Where a person who opens the wizard with no `?step=` continues; `null` while unknown. */
export const resumeStepOf = (done: WizardDoneness): WizardStepId | null => {
  if (WIZARD_STEP_IDS.some((step) => done[step] === null)) {
    return null;
  }
  const lastDone = WIZARD_STEP_IDS.reduce(
    (last, step, index) => (done[step] === true ? index : last),
    -1,
  );
  const first = WIZARD_STEP_IDS.find(
    (step, index) => done[step] !== true && !(WIZARD_STEPS[step].optional && index < lastDone),
  );
  return first ?? 'finish';
};

/**
 * Why *Continue* is off on `step`, in the step's own words — or `null` when it may be pressed.
 * An optional step never holds it.
 */
export const continueBlockerOf = (step: WizardStepId, facts: WizardFacts): string | null => {
  if (WIZARD_STEPS[step].optional || step === 'finish') {
    return null;
  }
  if (!facts.projectExists) {
    return 'Create the project first.';
  }
  const done = donenessOf(facts)[step];
  if (done === true) {
    return null;
  }
  if (done === null) {
    return 'Checking what is already set up…';
  }
  switch (step) {
    case 'connect': {
      const missing = [
        facts.trackerBound === false ? 'a ticket tracker' : null,
        facts.gitBound === false ? 'a git integration' : null,
      ].filter((item) => item !== null);
      return `Bind ${missing.join(' and ')} to continue.`;
    }
    case 'discovery':
      return 'Continue opens once discovery has recorded a readiness evaluation.';
    case 'autonomy':
      return 'Save the operating mode to continue.';
    default:
      return null;
  }
};
