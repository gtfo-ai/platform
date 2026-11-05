/**
 * **One primary per wizard step** (S-23.23, the UX audit's § 2; research/19 rule 1): the tone a
 * step's own action takes, decided by the New project wizard rather than by each step.
 *
 * Several steps carry an action of their own — *Save the ticket lifecycle*, *Run discovery*,
 * *Propose the pages*, *Mine the history*, *Save operating mode* — under a footer whose *Continue*
 * was also the beacon, so the step drew two. The rule is the audit's: **the step's action is primary
 * until the step is done, then *Continue* is**. The wizard provides the tone (`primary` while its
 * step is not done, `default` once it is) and gives the footer the other one; a step reads it here.
 *
 * Outside the wizard the same components sit in a project's settings, one per section with no
 * footer, so the default is `primary`: there the section's own action is the one thing to do.
 */
import { createContext, useContext } from 'react';
import type { ButtonTone } from '../ui/button.js';

export const StepActionToneContext =
  createContext<Extract<ButtonTone, 'primary' | 'default'>>('primary');

/** The tone this step's own main action takes. */
export const useStepActionTone = (): Extract<ButtonTone, 'primary' | 'default'> =>
  useContext(StepActionToneContext);
