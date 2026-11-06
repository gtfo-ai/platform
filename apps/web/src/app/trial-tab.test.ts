/**
 * The Trial tab's rule (S-25.7, product/10's 2026-11-06 IA amendment): shown before the project's
 * first live task or while a trial exists, and while it is the page being shown; otherwise it lives
 * under project Settings. Each branch from both sides (rule 68).
 */
import { describe, expect, it } from 'vitest';
import { isLiveTask, needsTrialCount, trialTabShown } from './trial-tab.js';

const live = { mode: 'normal', ticket: { provider: 'jira' } };
const trialTask = { mode: 'shadow', ticket: { provider: 'jira' } };
const discovery = { mode: 'normal', ticket: { provider: 'platform' } };

describe('a live task', () => {
  it('is a real ticket run for real — not a trial’s task, not a platform one-off', () => {
    expect(isLiveTask(live)).toBe(true);
    expect(isLiveTask(trialTask)).toBe(false);
    expect(isLiveTask(discovery)).toBe(false);
  });
});

describe('the Trial tab', () => {
  it('is not drawn until the tasks read answers, unless it is the current page', () => {
    expect(trialTabShown({ tasks: undefined, trials: 3, current: false })).toBe(false);
    expect(trialTabShown({ tasks: undefined, trials: undefined, current: true })).toBe(true);
  });

  it('is shown before the first live task, whatever the trials read says', () => {
    for (const tasks of [[], [trialTask], [discovery, trialTask]]) {
      expect(trialTabShown({ tasks, trials: undefined, current: false })).toBe(true);
      expect(trialTabShown({ tasks, trials: 0, current: false })).toBe(true);
    }
  });

  it('after a live task, is shown exactly while a trial exists', () => {
    expect(trialTabShown({ tasks: [live], trials: 0, current: false })).toBe(false);
    expect(trialTabShown({ tasks: [live], trials: 1, current: false })).toBe(true);
    // Not known yet: not drawn, rather than drawn and taken away.
    expect(trialTabShown({ tasks: [live, trialTask], trials: undefined, current: false })).toBe(
      false,
    );
  });

  it('asks for the trials only once a live task makes them the question', () => {
    expect(needsTrialCount(undefined)).toBe(false);
    expect(needsTrialCount([trialTask, discovery])).toBe(false);
    expect(needsTrialCount([trialTask, live])).toBe(true);
  });
});
