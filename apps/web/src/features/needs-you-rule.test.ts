/**
 * One "needs you" (S-25.4, product/10's 2026-11-06 Board amendment, research/21 F5): the board's
 * column, the card's ◆ and the task header's state read **one** rule, `ui/task-status.ts`'
 * `needsYou`. Before it, the column read the state alone, so a task with an open question and a
 * pending approval sat under *Active* while its card said "Needs you 2" and its header "Active".
 *
 * Parameterised over the set the code branches on (checklist 6): every published task state ×
 * {nothing open, an open question, a pending approval}, and for `paused` every pause reason — and
 * `needs_human` is one of those states. A done or cancelled task never needs you, whatever it left
 * open. Each case asks all three readers and the expected answer
 * written out independently, so a reader that drifts from the rule fails here by name.
 */
import {
  type GateWait,
  type TaskListItem,
  type TaskState,
  taskStateSchema,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { NEEDS_YOU_LABEL, needsYou, taskStateLabel, taskStatus } from '../ui/task-status.js';
import { boardColumnOf, columnFor, NEEDS_YOU_COLUMN } from './board.js';
import { needsYou as cardNeedsYou, cardSetback, cardStateLabel } from './board-card.js';
import { gateWaitHeld } from './gate-wait.js';

type Item = 'none' | 'question' | 'approval';
type PausedReason = TaskListItem['paused_reason'];

const ITEMS: readonly Item[] = ['none', 'question', 'approval'];

/** A pipeline held at the manual job `deploy` — the read only a person can end. */
const HELD: GateWait = {
  pipeline_id: '41',
  pipeline_url: null,
  status: 'manual',
  held_job: 'deploy',
  held_job_url: null,
  draft: false,
  checked_at: '2026-11-07T10:05:00.000Z',
  waiting_since: '2026-11-07T10:00:00.000Z',
  timeout_minutes: 60,
};
const PAUSED_REASONS: readonly PausedReason[] = [null, 'manual', 'budget', 'taken_over'];

/** Written out rather than derived from the module under test. */
const WAITING_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'waiting_answers',
  'waiting_approval',
  'needs_human',
]);

/** A task that has ended never needs you, whatever it left open (review of PR #80). */
const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'cancelled']);

const expected = (state: TaskState, reason: PausedReason, item: Item): boolean =>
  !TERMINAL_STATES.has(state) &&
  (item !== 'none' ||
    WAITING_STATES.has(state) ||
    (state === 'paused' && (reason === 'budget' || reason === 'taken_over')));

/** Only the fields the three readers look at; the rest of the row is irrelevant to the rule. */
const listItem = (state: TaskState, reason: PausedReason, item: Item): TaskListItem =>
  ({
    state,
    paused_reason: reason,
    open_questions: item === 'question' ? 1 : 0,
    pending_approvals: item === 'approval' ? 1 : 0,
  }) as TaskListItem;

const cases = taskStateSchema.options.flatMap((state) =>
  (state === 'paused' ? PAUSED_REASONS : [null]).flatMap((reason) =>
    ITEMS.map((item) => ({ state, reason, item })),
  ),
);

describe('one needs-you rule for the column, the card and the header', () => {
  it('covers every state, every pause reason and every pending item', () => {
    // 12 states, `paused` four times over, three items each.
    expect(cases).toHaveLength((taskStateSchema.options.length + 3) * 3);
  });

  it.each(cases)(
    '$state ($reason) with $item: all three readers agree',
    ({ state, reason, item }) => {
      const row = listItem(state, reason, item);
      // The header's own input: the task page counts the open rows of its questions and approvals.
      const header = { state, paused_reason: reason, open_asks: item === 'none' ? 0 : 1 };
      const want = expected(state, reason, item);

      expect(needsYou(header)).toBe(want);
      expect(cardNeedsYou(row), 'the card’s ◆').toBe(want);
      expect(boardColumnOf(row) === NEEDS_YOU_COLUMN, 'the board column').toBe(want);
      expect(taskStatus(header) === 'needs_you', 'the header’s icon').toBe(want);
      // Not waiting: the state's own column, never Needs you.
      if (!want) {
        expect(boardColumnOf(row)).toBe(columnFor(state));
        expect(columnFor(state)).not.toBe(NEEDS_YOU_COLUMN);
      }
      // The word beside the icon never says a stage's word for a task that waits on a person.
      const word = taskStateLabel(header);
      expect(cardStateLabel(row)).toBe(word);
      if (want && !WAITING_STATES.has(state) && state !== 'paused') {
        expect(word).toBe(NEEDS_YOU_LABEL);
      }
      if (!want) {
        expect(word).not.toBe(NEEDS_YOU_LABEL);
      }
    },
  );

  it.each(['done', 'cancelled'] as const)(
    'never puts a %s task in Needs you, even with a question and an approval left open',
    (state) => {
      const row = { ...listItem(state, null, 'none'), open_questions: 1, pending_approvals: 1 };
      expect(cardNeedsYou(row)).toBe(false);
      expect(boardColumnOf(row)).toBe('done');
      expect(needsYou({ state, paused_reason: null, open_asks: 2, taken_over: true })).toBe(false);
      expect(cardStateLabel(row)).not.toBe(NEEDS_YOU_LABEL);
    },
  );

  /**
   * S-25.12 (product/10's 2026-11-07 amendment): a CI check held at a manual job waits for a
   * person, so it is *Needs you* at once — not after the wait times out — and only while the task
   * is `active` (review of PR #101: a paused task's CI check is not checking). Since S-26.8b part 2
   * the board's item carries `gate_wait` too (BACKLOG 1300), so the card, the column and the header
   * all read it through the one rule.
   */
  it.each(taskStateSchema.options)(
    'puts a %s task whose CI check is held at a manual job in Needs you only while it is active',
    (state) => {
      const header = { state, paused_reason: null, open_asks: 0, gate_wait: HELD };
      const row = { ...listItem(state, null, 'none'), gate_wait: HELD };
      const want = state === 'active' || expected(state, null, 'none');
      expect(needsYou(header)).toBe(want);
      expect(taskStatus(header) === 'needs_you').toBe(want);
      expect(cardNeedsYou(row), 'the card’s ◆').toBe(want);
      expect(boardColumnOf(row) === NEEDS_YOU_COLUMN, 'the board column').toBe(want);
      expect(cardStateLabel(row)).toBe(taskStateLabel(header));
      if (state === 'active') {
        expect(taskStateLabel(header)).toBe(NEEDS_YOU_LABEL);
        // The card's short form of the held job (S-26.8b part 2), in the setback's slot.
        expect(cardSetback(row)).toBe('CI held · start the job');
      }
    },
  );

  it('reads a CI check that is running, not held, as no reason at all', () => {
    const running = { ...HELD, status: 'running' as const, held_job: null, held_job_url: null };
    expect(
      needsYou({ state: 'active', paused_reason: null, open_asks: 0, gate_wait: running }),
    ).toBe(false);
    expect(cardNeedsYou({ ...listItem('active', null, 'none'), gate_wait: running })).toBe(false);
    expect(needsYou({ state: 'active', paused_reason: null, open_asks: 0, gate_wait: null })).toBe(
      false,
    );
    expect(gateWaitHeld(null)).toBe(false);
    expect(
      gateWaitHeld({
        pipeline_id: '41',
        pipeline_url: null,
        status: 'running',
        held_job: null,
        held_job_url: null,
        draft: true,
        checked_at: '2026-11-07T10:05:00.000Z',
        waiting_since: '2026-11-07T10:00:00.000Z',
        timeout_minutes: 60,
      }),
    ).toBe(false);
  });

  it('moves an Active task with an open question and a pending approval to Needs you', () => {
    // research/21 S03's own example, both items at once.
    const row = { ...listItem('active', null, 'none'), open_questions: 1, pending_approvals: 1 };
    expect(columnFor('active')).toBe('active');
    expect(boardColumnOf(row)).toBe(NEEDS_YOU_COLUMN);
    expect(cardStateLabel(row)).toBe('Needs you');
  });
});
