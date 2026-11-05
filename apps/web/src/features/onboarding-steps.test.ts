/**
 * The wizard's rules as rules (S-23.8): what is done, what is open, where a person resumes and why
 * *Continue* is off. The screen's own tests (`onboarding.test.tsx`) drive the same rules through the
 * router; these hold the edges a rendered screen reaches only by timing — an unread fact.
 */
import { describe, expect, it } from 'vitest';
import {
  blockingStepOf,
  continueBlockerOf,
  donenessOf,
  nextStep,
  previousStep,
  resumeStepOf,
  WIZARD_STEP_IDS,
  WIZARD_STEPS,
  type WizardFacts,
} from './onboarding-steps.js';

const ALL_DONE: WizardFacts = {
  projectExists: true,
  trackerBound: true,
  gitBound: true,
  readinessEvaluated: true,
  businessProposed: true,
  historyStarted: true,
  operatingModeSaved: true,
  proposalsReviewed: true,
};

describe('the wizard’s steps', () => {
  it('are six, in order, two of them optional', () => {
    expect(WIZARD_STEP_IDS).toEqual([
      'connect',
      'discovery',
      'business',
      'history',
      'autonomy',
      'finish',
    ]);
    expect(WIZARD_STEP_IDS.filter((step) => WIZARD_STEPS[step].optional)).toEqual([
      'business',
      'history',
    ]);
    expect(previousStep('connect')).toBeNull();
    expect(nextStep('finish')).toBeNull();
    expect(nextStep('discovery')).toBe('business');
  });

  it('knows nothing is done for a project that does not exist, whatever else is claimed', () => {
    const done = donenessOf({ ...ALL_DONE, projectExists: false });
    expect(Object.values(done)).toEqual([false, false, false, false, false, false]);
    expect(blockingStepOf('discovery', done)).toBe('connect');
    expect(continueBlockerOf('connect', { ...ALL_DONE, projectExists: false })).toBe(
      'Create the project first.',
    );
  });

  it('needs both a tracker and a git binding for Connect, and names what is missing', () => {
    expect(donenessOf({ ...ALL_DONE, gitBound: false }).connect).toBe(false);
    expect(
      continueBlockerOf('connect', { ...ALL_DONE, trackerBound: false, gitBound: false }),
    ).toBe('Bind a ticket tracker and a git integration to continue.');
    expect(continueBlockerOf('connect', { ...ALL_DONE, gitBound: false })).toBe(
      'Bind a git integration to continue.',
    );
    expect(continueBlockerOf('connect', ALL_DONE)).toBeNull();
  });

  it('treats an unread fact as unknown — never as done, never as not done', () => {
    const unread = { ...ALL_DONE, readinessEvaluated: null };
    const done = donenessOf(unread);
    expect(done.discovery).toBeNull();
    expect(done.finish).toBeNull();
    // Unknown holds the steps behind it and the resume point until it is read.
    expect(blockingStepOf('business', done)).toBeUndefined();
    expect(blockingStepOf('discovery', done)).toBeNull();
    expect(resumeStepOf(done)).toBeNull();
    expect(continueBlockerOf('discovery', unread)).toBe('Checking what is already set up…');
  });

  it('never lets an optional step gate, and lets every step through when all are done', () => {
    const done = donenessOf({ ...ALL_DONE, businessProposed: false, historyStarted: false });
    expect(blockingStepOf('autonomy', done)).toBeNull();
    expect(continueBlockerOf('business', { ...ALL_DONE, businessProposed: false })).toBeNull();
    expect(resumeStepOf(donenessOf(ALL_DONE))).toBe('finish');
  });

  it('is not finished while a drafted page waits, though every other step is done', () => {
    const done = donenessOf({ ...ALL_DONE, proposalsReviewed: false });
    expect(done.finish).toBe(false);
    expect(resumeStepOf(done)).toBe('finish');
    // The ending is the next action: the last step never holds anything.
    expect(continueBlockerOf('finish', { ...ALL_DONE, proposalsReviewed: false })).toBeNull();
  });

  it('resumes at a required step not done even after later steps were done', () => {
    // A saved operating mode does not skip a person past a discovery that never recorded.
    const done = donenessOf({ ...ALL_DONE, readinessEvaluated: false });
    expect(resumeStepOf(done)).toBe('discovery');
    expect(blockingStepOf('finish', done)).toBe('discovery');
  });
});
