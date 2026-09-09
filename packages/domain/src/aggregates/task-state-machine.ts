/**
 * The Task state machine — technical/02 § "State machines" → Task.
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
 * The table below is the diagram, transcribed. It is data, not `switch` statements, so the model
 * tests can consult the same table the aggregate enforces, and so an illegal transition is
 * rejected rather than silently ignored.
 */
import type { TaskState } from '@platform/contracts';
import { IllegalTransitionError } from '../errors.js';

/**
 * Legal successor states. Notes on the readings the diagram leaves implicit:
 *  - `cancelled` is reachable from every non-terminal state: product/04 lets a human cancel a
 *    task at any point, and an MR closed with "won't do" cancels from `ready_for_merge`.
 *  - `paused` is reachable from the waiting states as well as from `active`, because a budget
 *    exhaustion or a take-over does not care what the task was waiting for.
 *  - `needs_human` is reachable from every non-terminal state: every bounded loop ends there
 *    (BD-008), as does every expired question or approval.
 *  - `active → active` is legal and common: it is a stage transition inside the pipeline.
 *  - `ready_for_merge → returned` is the human-MR-comment path (BD-007).
 */
export const TASK_TRANSITIONS = {
  queued: ['active', 'needs_human', 'cancelled'],
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
  returned: ['active', 'needs_human', 'paused', 'cancelled'],
  waiting_answers: ['active', 'paused', 'needs_human', 'cancelled'],
  waiting_approval: ['active', 'paused', 'needs_human', 'cancelled'],
  paused: ['active', 'needs_human', 'cancelled'],
  needs_human: ['active', 'paused', 'cancelled'],
  ready_for_merge: ['merged', 'returned', 'paused', 'needs_human', 'cancelled'],
  merged: ['retro', 'needs_human'],
  retro: ['done', 'needs_human'],
  done: [],
  cancelled: [],
} as const satisfies Record<TaskState, readonly TaskState[]>;

/** States from which nothing more can happen. */
export const TERMINAL_TASK_STATES = ['done', 'cancelled'] as const satisfies readonly TaskState[];

export const isTerminalTaskState = (state: TaskState): boolean =>
  (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);

export const canTransitionTask = (from: TaskState, to: TaskState): boolean =>
  (TASK_TRANSITIONS[from] as readonly TaskState[]).includes(to);

export const assertTaskTransition = (from: TaskState, to: TaskState): void => {
  if (!canTransitionTask(from, to)) {
    throw new IllegalTransitionError('Task', from, to);
  }
};
