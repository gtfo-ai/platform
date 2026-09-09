import { describe, expect, it } from 'vitest';
import * as domain from './index.js';

describe('@platform/domain', () => {
  it('is wired into the workspace', () => {
    expect(domain.packageId).toBe('@platform/domain');
  });

  it('exports the aggregates, the state machines, the policies and `can`', () => {
    // A smoke check that the barrel really re-exports each area, so a missing `export *` is
    // caught here rather than by the first consumer in the application ring.
    for (const name of [
      'createTask',
      'returnToStage',
      'TASK_TRANSITIONS',
      'createRun',
      'RUN_TRANSITIONS',
      'openQuestion',
      'QUESTION_TRANSITIONS',
      'createApproval',
      'APPROVAL_TRANSITIONS',
      'createBudget',
      'recordSpend',
      'mergeProjectConfig',
      'PLATFORM_DEFAULT_CONFIG',
      'evaluateIteration',
      'evaluateTaskAdmission',
      'blockingBudget',
      'AUTONOMY_PRESETS',
      'evaluateCommand',
      'can',
      'assertCan',
      'fixedClock',
      'sequentialIds',
      'buildEvent',
      'DomainError',
    ]) {
      expect(domain, name).toHaveProperty(name);
    }
  });
});
