/** One answer to "does this task need me", for the board's card and the task page (S-23.9b). */
import { describe, expect, it } from 'vitest';
import { needsYou, taskStatus } from './task-status.js';

describe('needsYou', () => {
  const base = { state: 'active' as const, paused_reason: null, open_asks: 0 };

  it('is true for a waiting state, an open ask, a take-over and a pause only a person ends', () => {
    expect(needsYou(base)).toBe(false);
    for (const state of ['waiting_answers', 'waiting_approval', 'needs_human'] as const) {
      expect(needsYou({ ...base, state }), state).toBe(true);
    }
    expect(needsYou({ ...base, open_asks: 1 })).toBe(true);
    expect(needsYou({ ...base, taken_over: true })).toBe(true);
    expect(needsYou({ ...base, state: 'paused', paused_reason: 'budget' })).toBe(true);
    expect(needsYou({ ...base, state: 'paused', paused_reason: 'taken_over' })).toBe(true);
  });

  it('is false for a pause a person chose', () => {
    expect(needsYou({ ...base, state: 'paused', paused_reason: 'manual' })).toBe(false);
    expect(needsYou({ ...base, state: 'paused', paused_reason: null })).toBe(false);
  });

  it('draws needs-you over the state’s own status, and the state’s otherwise', () => {
    expect(taskStatus({ ...base, state: 'paused', paused_reason: 'budget' })).toBe('needs_you');
    expect(taskStatus({ ...base, state: 'paused', paused_reason: 'manual' })).toBe('paused');
    expect(taskStatus(base)).toBe('running');
  });
});
