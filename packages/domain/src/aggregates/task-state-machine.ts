/**
 * The Task state machine — technical/02 § "State machines" → Task.
 *
 * ```
 * queued ─► active(stage=…) ─► … ─► ready_for_merge ─► merged ─► retro ─► retro ─► done
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
 *  - `retro → retro` is the same edge one phase later, added at WP-18b: the retrospective phase has
 *    **two** stages now — the facilitator's report and the Librarian's curation of the proposals it
 *    produced — and both run with the task in `retro`. Without the self edge the Librarian stage
 *    would either have to move the task back to `active` (which `retro` has no edge to, by design:
 *    a merged task never goes back to work) or run outside the pipeline entirely.
 *  - `ready_for_merge → returned` is the human-MR-comment path (BD-007).
 *  - **`active → done` was added at WP-21**, and it closes a gap rather than widening a guarantee.
 *    Until then the only edge into `done` was `retro → done`, so a template that finishes without a
 *    merge could not finish at all: the pipeline asked for `complete`, the machine refused, and
 *    `applyDecision` escalated the task to `needs_human` with a blocker brief blaming the template.
 *    Two shipped shapes need it — the **discovery** template (product/06 § "Step 2": one read-only
 *    agent stage that drafts a knowledge base, with no ticket, no branch and no merge request) and
 *    product/04's **spike** template, which "ends at a human with no MR" and has therefore never
 *    been shippable. It takes nothing away from BD-007: *which* stage a task ends at is the
 *    **interpreter's** decision from the template, and every ticket template (`TICKET_TEMPLATES`)
 *    still runs `ready_for_merge → merged → retro → done`, so no ticket can reach `done` without a
 *    human merge. technical/02's diagram is amended with the same sentence (standing rule 8: docs
 *    win, so the doc changes rather than the code being written around it).
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
    'done',
    'cancelled',
  ],
  returned: ['active', 'needs_human', 'paused', 'cancelled'],
  waiting_answers: ['active', 'paused', 'needs_human', 'cancelled'],
  waiting_approval: ['active', 'paused', 'needs_human', 'cancelled'],
  paused: ['active', 'needs_human', 'cancelled'],
  needs_human: ['active', 'paused', 'cancelled'],
  ready_for_merge: ['merged', 'returned', 'paused', 'needs_human', 'cancelled'],
  merged: ['retro', 'needs_human'],
  retro: ['retro', 'done', 'needs_human'],
  done: [],
  cancelled: [],
} as const satisfies Record<TaskState, readonly TaskState[]>;

/** States from which nothing more can happen. */
export const TERMINAL_TASK_STATES = ['done', 'cancelled'] as const satisfies readonly TaskState[];

export const isTerminalTaskState = (state: TaskState): boolean =>
  (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);

/**
 * States in which the pipeline may still act on a task by itself.
 *
 * Everything this excludes is a stop a **human** owns: `paused` (budget or take-over),
 * `needs_human`, and the two waiting states, plus the terminal pair. It is not the complement of
 * `active`: `ready_for_merge`, `merged` and `retro` are states the pipeline moves through under
 * its own power, and a guard written as `state === 'active'` silently strands a task at the
 * retrospective — which is exactly where WP-15 first found it.
 */
export const isRunnableTaskState = (state: TaskState): boolean =>
  !isTerminalTaskState(state) &&
  state !== 'paused' &&
  state !== 'needs_human' &&
  state !== 'waiting_answers' &&
  state !== 'waiting_approval';

export const canTransitionTask = (from: TaskState, to: TaskState): boolean =>
  (TASK_TRANSITIONS[from] as readonly TaskState[]).includes(to);

export const assertTaskTransition = (from: TaskState, to: TaskState): void => {
  if (!canTransitionTask(from, to)) {
    throw new IllegalTransitionError('Task', from, to);
  }
};
