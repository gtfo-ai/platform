import { taskStateSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '../errors.js';
import {
  assertTaskTransition,
  canTransitionTask,
  isTerminalTaskState,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
} from './task-state-machine.js';

/**
 * The edge list, transcribed by hand from technical/02 § "State machines" → Task. Every row cites
 * the line of the document it comes from, so `TASK_TRANSITIONS` is checked against the *document*
 * rather than against itself — a wrong row in the table under test fails here.
 *
 * ```
 * queued ─► active(stage=…) ─► … ─► ready_for_merge ─► merged ─► retro ─► done
 *    │           │  ▲                     │
 *    │           │  └── returned(stage) ◄─┘ (human comments / rework)
 *    │           ├─► waiting_answers ─► active
 *    │           ├─► waiting_approval ─► active | needs_human
 *    │           ├─► paused(budget|manual|taken_over) ─► active
 *    │           └─► needs_human ─► active | cancelled
 *    └─► cancelled
 * ```
 *
 * Three edges the prose adds to the picture, and one the picture adds to the prose:
 *  - `needs_human` is reachable from everywhere: "Exceeding any limit moves the task to
 *    `Needs human`" (BD-008) and an expired question or approval does the same (product/04 S1).
 *  - `cancelled` is reachable from everywhere alive: product/04 S7, "MR close/decline →
 *    `Needs human`… a closed MR after a human comment 'won't do' → task `Cancelled`".
 *  - `paused` is reachable from the waiting states: a budget exhaustion or a take-over does not
 *    care what the task was waiting for (product/09, product/19 §19).
 *  - `active → active` is the ordinary stage-to-stage move inside the pipeline.
 */
const EXPECTED_TASK_EDGES = {
  // "queued ─► active" and "queued └─► cancelled"; plus escalation, which is universal.
  queued: ['active', 'needs_human', 'cancelled'],
  // "active ─► …" plus the four branches under it, and the stage-to-stage self edge.
  active: [
    'active',
    'returned',
    'waiting_answers',
    'waiting_approval',
    'paused',
    'needs_human',
    'ready_for_merge',
    'cancelled',
  ],
  // "returned(stage) ─► active" (the return lands and the stage is re-entered).
  returned: ['active', 'needs_human', 'paused', 'cancelled'],
  // "waiting_answers ─► active".
  waiting_answers: ['active', 'paused', 'needs_human', 'cancelled'],
  // "waiting_approval ─► active | needs_human".
  waiting_approval: ['active', 'paused', 'needs_human', 'cancelled'],
  // "paused(budget|manual|taken_over) ─► active".
  paused: ['active', 'needs_human', 'cancelled'],
  // "needs_human ─► active | cancelled".
  needs_human: ['active', 'paused', 'cancelled'],
  // "ready_for_merge ─► merged" and "returned(stage) ◄─┘ (human comments / rework)".
  ready_for_merge: ['merged', 'returned', 'paused', 'needs_human', 'cancelled'],
  // "merged ─► retro"; a merged task can still escalate but can never be cancelled.
  merged: ['retro', 'needs_human'],
  // "retro ─► done".
  retro: ['done', 'needs_human'],
  done: [],
  cancelled: [],
};

describe('Task transition table', () => {
  it('matches the edge list transcribed from technical/02', () => {
    expect(TASK_TRANSITIONS).toEqual(EXPECTED_TASK_EDGES);
  });

  it('covers every state the contracts define, and only those', () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...taskStateSchema.options].sort());
    for (const targets of Object.values(TASK_TRANSITIONS)) {
      for (const target of targets) {
        expect(taskStateSchema.options).toContain(target);
      }
    }
  });

  it('has no duplicate targets', () => {
    for (const [state, targets] of Object.entries(TASK_TRANSITIONS)) {
      expect(new Set(targets).size, state).toBe(targets.length);
    }
  });

  it('leaves the terminal states terminal', () => {
    for (const state of TERMINAL_TASK_STATES) {
      expect(TASK_TRANSITIONS[state]).toEqual([]);
      expect(isTerminalTaskState(state)).toBe(true);
    }
    expect(isTerminalTaskState('active')).toBe(false);
  });

  it('makes every state reachable from `queued`', () => {
    const seen = new Set<string>(['queued']);
    const queue = ['queued'];
    while (queue.length > 0) {
      const state = queue.shift() as keyof typeof TASK_TRANSITIONS;
      for (const target of TASK_TRANSITIONS[state]) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    expect([...seen].sort()).toEqual([...taskStateSchema.options].sort());
  });

  it('lets a task be cancelled from anywhere it is still alive', () => {
    for (const state of taskStateSchema.options) {
      if (isTerminalTaskState(state) || state === 'merged' || state === 'retro') {
        continue;
      }
      expect(canTransitionTask(state, 'cancelled')).toBe(true);
    }
  });

  it('throws a typed error for an illegal transition', () => {
    expect(() => assertTaskTransition('done', 'active')).toThrow(IllegalTransitionError);
    try {
      assertTaskTransition('done', 'active');
      expect.unreachable('should have thrown');
    } catch (error) {
      const illegal = error as IllegalTransitionError;
      expect(illegal.code).toBe('illegal_transition');
      expect(illegal.aggregate).toBe('Task');
      expect(illegal.from).toBe('done');
      expect(illegal.to).toBe('active');
    }
    expect(() => assertTaskTransition('queued', 'active')).not.toThrow();
  });
});
