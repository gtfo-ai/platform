/**
 * **A run that ended says why, wherever it is listed** (S-25.19 (2)): the task's Runs tab, the board
 * card's activity, the Agents rows and Home all read *Failed* — and now the reason's short form beside
 * it, from the one word table (`ui/words/terminal-reasons.ts`), with *Did not start* for a run whose
 * workspace was never created.
 *
 * In a file of its own rather than inside `board-card.test.tsx`, which another open change edits.
 */
import type { RunRecord, RunStartFailure, TaskListItem } from '@platform/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { activityOf } from '../ui/activity.js';
import { agentItem, EMPTY_INBOX, NOW, runRecord } from '../viz/fleet/fleet.test-fixture.js';
import { activityWords, fleetOf } from '../viz/fleet/model.js';
import { type AgentEntry, cardActivity } from './board-card.js';
import { runStatusWords, TaskRuns } from './task-runs.js';

afterEach(() => {
  cleanup();
});

const NOT_STARTED: RunStartFailure = {
  kind: 'not_started',
  diagnosis: 'RunStartError: workspace_failed',
  detail: null,
  truncated: false,
  attempt: 1,
  retryable: false,
};

const ended = (n: number, over: Partial<RunRecord>): RunRecord =>
  runRecord(n, { ended_at: '2026-11-05T16:44:30.000Z', ...over });

describe('the task’s Runs tab', () => {
  it.each([
    [{ status: 'failed', terminal_reason: 'lease_expired' }, 'Failed · Lost its worker'],
    [{ status: 'failed', terminal_reason: 'crash' }, 'Failed · Crashed'],
    [{ status: 'failed', terminal_reason: 'permission_denied' }, 'Failed · Permission denied'],
    [{ status: 'failed', terminal_reason: 'shutdown' }, 'Failed · Handed back on shutdown'],
    [{ status: 'cancelled', terminal_reason: 'cancelled' }, 'Cancelled'],
    // The status already says it: never *Timed out · Timed out*.
    [{ status: 'timed_out', terminal_reason: 'timed_out' }, 'Timed out'],
    [{ status: 'completed', terminal_reason: 'success' }, 'Completed'],
    [
      { status: 'failed', terminal_reason: 'error_during_execution', start_failure: NOT_STARTED },
      'Failed · Did not start',
    ],
  ] as const)('reads %j as %j', (over, words) => {
    expect(runStatusWords(ended(1, over))).toBe(words);
  });

  it('shows the words on each row', async () => {
    const runs = [
      ended(1, { status: 'failed', terminal_reason: 'lease_expired' }),
      ended(2, {
        status: 'failed',
        terminal_reason: 'error_during_execution',
        start_failure: NOT_STARTED,
      }),
    ];
    // The rows link to their run pages, so they render inside a router.
    const root = createRootRoute({ component: () => <Outlet /> });
    const page = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => <TaskRuns runs={runs} nowMs={NOW} />,
    });
    const run = createRoute({ getParentRoute: () => root, path: '/runs/$runId' });
    const router = createRouter({
      routeTree: root.addChildren([page, run]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    render(<RouterProvider router={router} />);
    await screen.findByRole('img', { name: 'Failed · Lost its worker' });
    expect(
      [...document.querySelectorAll('[data-run-status]')].map((element) => element.textContent),
    ).toEqual(['Failed · Lost its worker', 'Failed · Did not start']);
  });
});

describe('the board card’s activity', () => {
  /** What `cardActivity` reads of a task: its state, its asks and whether it waits for a machine. */
  const TASK = {
    state: 'active',
    open_questions: 0,
    pending_approvals: 0,
    waiting: null,
  } as unknown as TaskListItem;

  it('says the reason beside Failed, and Did not start for a workspace never created', () => {
    const agent = (run: Partial<RunRecord>): AgentEntry =>
      agentItem(1, { run: { ended_at: '2026-11-05T16:44:30.000Z', ...run }, activity: null });
    expect(
      cardActivity(TASK, agent({ status: 'failed', terminal_reason: 'lease_expired' }), NOW),
    ).toEqual({ activity: 'failed', detail: 'Lost its worker' });
    expect(
      cardActivity(
        TASK,
        agent({
          status: 'failed',
          terminal_reason: 'error_during_execution',
          start_failure: NOT_STARTED,
        }),
        NOW,
      ),
    ).toEqual({ activity: 'failed', detail: 'Did not start' });
    // Without the start failure the same run is an error while running — the field is read.
    expect(
      cardActivity(
        TASK,
        agent({ status: 'failed', terminal_reason: 'error_during_execution' }),
        NOW,
      ).detail,
    ).toBe('Error while running');
  });
});

describe('the Agents rows and Home', () => {
  it('reads an ended run by its reason on the Agents screen', () => {
    const fleet = fleetOf({
      agents: [],
      workers: [],
      inbox: EMPTY_INBOX,
      now: NOW,
      endings: [
        {
          entry: agentItem(1),
          run: ended(1, { status: 'failed', terminal_reason: 'lease_expired' }),
        },
        {
          entry: agentItem(2),
          run: ended(2, {
            status: 'failed',
            terminal_reason: 'error_during_execution',
            start_failure: NOT_STARTED,
          }),
        },
      ],
    });
    const rows = fleet.seats.flatMap((seat) => seat.endings);
    expect(rows.map((run) => activityWords(run))).toEqual([
      'failed: Lost its worker',
      'failed: Did not start',
    ]);
  });

  it('gives Home’s Running now the same words (the one activity function)', () => {
    expect(
      activityOf({
        run: {
          status: 'stalled',
          terminal_reason: 'stalled',
          started_at: null,
          start_failure: null,
        },
        now: NOW,
      }),
    ).toEqual({ activity: 'failed', detail: 'Stalled' });
  });
});
