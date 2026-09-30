/**
 * The orphaned-workspace pass (WP-103, PROGRESS backlog 286, TD-028 decision 12): what it removes,
 * what it keeps, and what it says about each.
 *
 * The launcher's two verbs are a double here — their round trip is
 * `apps/launcher/src/control-plane.test.ts`'s, and what they do to a daemon is
 * `scripts/launcher-control-plane-check.mjs`'s — and so is the row read, whose SQL is
 * `test/integration/recovery/orphan-workspace-store.integration.test.ts`'s. What is asserted is the
 * decision and its countable effects: which ids reached `destroy`, the counter, and the log line
 * naming the run id (criterion 3). Every removal is paired with the keep it must not become
 * (standing rule 42): a live run's container is kept however old it is.
 */
import type { Id, IsoDateTime, RunStatus } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import {
  decideOrphanWorkspaces,
  type ListedRunWorkspace,
  ORPHAN_UNKNOWN_RUN_GRACE_MS,
  type OrphanReapReason,
  type OrphanWorkspaceRunState,
  runOrphanWorkspaceReap,
  startOrphanWorkspaceReaper,
} from './orphan-workspaces.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const GRACE_MS = 60_000;
const LONG_AGO = new Date(NOW - 2 * ORPHAN_UNKNOWN_RUN_GRACE_MS).toISOString();
const JUST_NOW = new Date(NOW - 5_000).toISOString();

const ENDED = 'aaaaaaaa-0000-4000-8000-000000000001';
const ENDED_RECENTLY = 'aaaaaaaa-0000-4000-8000-000000000002';
const LIVE = 'aaaaaaaa-0000-4000-8000-000000000003';
const UNKNOWN_OLD = 'aaaaaaaa-0000-4000-8000-000000000004';
const UNKNOWN_YOUNG = 'aaaaaaaa-0000-4000-8000-000000000005';

const listed = (runId: string, createdAt = LONG_AGO, running = true): ListedRunWorkspace => ({
  runId,
  createdAt,
  running,
});

const state = (
  runId: string,
  status: RunStatus,
  endedAt: string | null = null,
): OrphanWorkspaceRunState => ({
  runId: runId as Id,
  status,
  endedAt: endedAt as IsoDateTime | null,
});

const STATES = [
  state(ENDED, 'failed', new Date(NOW - 10 * 60_000).toISOString()),
  state(ENDED_RECENTLY, 'completed', new Date(NOW - 10_000).toISOString()),
  state(LIVE, 'running'),
];

interface Recorded {
  readonly destroyed: string[];
  readonly counted: string[];
  readonly lines: { level: string; fields: Record<string, unknown>; message: string }[];
  readonly asked: (readonly string[])[];
}

const harness = (input: {
  readonly listing: readonly ListedRunWorkspace[] | Error;
  readonly states?: readonly OrphanWorkspaceRunState[];
  readonly failDestroy?: ReadonlySet<string>;
}) => {
  const recorded: Recorded = { destroyed: [], counted: [], lines: [], asked: [] };
  const logAt =
    (level: string) =>
    (fields: Record<string, unknown>, message: string): void => {
      recorded.lines.push({ level, fields, message });
    };
  const logger: Logger = {
    debug: logAt('debug'),
    info: logAt('info'),
    warn: logAt('warn'),
    error: logAt('error'),
  } as Logger;
  const options = {
    inventory: {
      list: async () => {
        if (input.listing instanceof Error) {
          throw input.listing;
        }
        return input.listing;
      },
      destroy: async (runId: string) => {
        recorded.destroyed.push(runId);
        if (input.failDestroy?.has(runId) === true) {
          throw new Error('the launcher could not be reached');
        }
        return { found: true };
      },
    },
    store: {
      runStates: async (_tx: unknown, runIds: readonly Id[]) => {
        recorded.asked.push(runIds);
        return (input.states ?? STATES).filter((row) => runIds.includes(row.runId));
      },
    },
    unitOfWork: new MemoryEventing(),
    clock: { now: () => NOW },
    graceMs: GRACE_MS,
    metrics: {
      reaped: (reason: OrphanReapReason) => recorded.counted.push(`removed_${reason}`),
      failed: () => recorded.counted.push('remove_failed'),
    },
    logger,
  };
  return { options, recorded };
};

describe('the decision', () => {
  it('removes a terminal run past the grace and an unknown one past the hour, and keeps the rest', () => {
    const decisions = decideOrphanWorkspaces({
      listed: [
        listed(ENDED),
        listed(ENDED_RECENTLY),
        listed(LIVE),
        listed(UNKNOWN_OLD),
        listed(UNKNOWN_YOUNG, JUST_NOW),
        listed('not-a-run-id'),
      ],
      states: STATES,
      now: NOW,
      graceMs: GRACE_MS,
      unknownGraceMs: ORPHAN_UNKNOWN_RUN_GRACE_MS,
      limit: 50,
    });
    expect(decisions).toEqual([
      { runId: ENDED, action: 'reap', reason: 'terminal', status: 'failed' },
      { runId: ENDED_RECENTLY, action: 'keep', reason: 'ended_within_grace' },
      { runId: LIVE, action: 'keep', reason: 'run_live' },
      { runId: UNKNOWN_OLD, action: 'reap', reason: 'unknown', status: null },
      { runId: UNKNOWN_YOUNG, action: 'keep', reason: 'unknown_within_grace' },
      { runId: 'not-a-run-id', action: 'keep', reason: 'not_a_run_id' },
    ]);
  });

  it.each(['created', 'starting', 'running'] as const)(
    'keeps a live run’s container however old it is (%s)',
    (status) => {
      // The negative the whole pass turns on: age is never a reason to stop a run somebody drives;
      // the lease sweep ends a dead one's row first, and only then is its container an orphan.
      const [decision] = decideOrphanWorkspaces({
        listed: [listed(LIVE, new Date(0).toISOString())],
        states: [state(LIVE, status)],
        now: NOW,
        graceMs: GRACE_MS,
        unknownGraceMs: ORPHAN_UNKNOWN_RUN_GRACE_MS,
        limit: 50,
      });
      expect(decision).toEqual({ runId: LIVE, action: 'keep', reason: 'run_live' });
    },
  );

  it('treats a container it cannot date as young, and a terminal row with no ended_at as ended', () => {
    const decisions = decideOrphanWorkspaces({
      listed: [listed(UNKNOWN_OLD, 'not a date'), listed(ENDED)],
      states: [state(ENDED, 'cancelled', null)],
      now: NOW,
      graceMs: GRACE_MS,
      unknownGraceMs: ORPHAN_UNKNOWN_RUN_GRACE_MS,
      limit: 50,
    });
    expect(decisions.map((decision) => decision.reason)).toEqual([
      'unknown_within_grace',
      'terminal',
    ]);
  });

  it('decides each run id once however often it is listed, and defers what is past the limit', () => {
    const decisions = decideOrphanWorkspaces({
      listed: [listed(ENDED), listed(ENDED), listed(UNKNOWN_OLD)],
      states: STATES,
      now: NOW,
      graceMs: GRACE_MS,
      unknownGraceMs: ORPHAN_UNKNOWN_RUN_GRACE_MS,
      limit: 1,
    });
    expect(decisions).toEqual([
      { runId: ENDED, action: 'reap', reason: 'terminal', status: 'failed' },
      { runId: UNKNOWN_OLD, action: 'keep', reason: 'over_limit' },
    ]);
  });
});

describe('one pass (criteria 2 and 3)', () => {
  it('destroys exactly the orphans, counts each, and logs each with its run id', async () => {
    const { options, recorded } = harness({
      listing: [listed(ENDED), listed(LIVE), listed(UNKNOWN_OLD), listed(ENDED_RECENTLY)],
    });
    const report = await runOrphanWorkspaceReap(options);
    expect(recorded.destroyed).toEqual([ENDED, UNKNOWN_OLD]);
    expect(recorded.counted).toEqual(['removed_terminal', 'removed_unknown']);
    expect(report).toEqual({
      listed: 4,
      reaped: { terminal: 1, unknown: 1 },
      kept: {
        run_live: 1,
        ended_within_grace: 1,
        unknown_within_grace: 0,
        not_a_run_id: 0,
        over_limit: 0,
      },
      failed: 0,
    });
    const removals = recorded.lines.filter((line) => line.message.includes('removed'));
    expect(
      removals.map((line) => [line.level, line.fields['run_id'], line.fields['reason']]),
    ).toEqual([
      ['warn', ENDED, 'terminal'],
      ['warn', UNKNOWN_OLD, 'unknown'],
    ]);
    // The rows were read once, in one transaction, for exactly the listed uuids.
    expect(recorded.asked).toEqual([[ENDED, LIVE, UNKNOWN_OLD, ENDED_RECENTLY]]);
  });

  it('tries every orphan once even when one destroy fails, and counts the failure', async () => {
    const { options, recorded } = harness({
      listing: [listed(ENDED), listed(UNKNOWN_OLD)],
      failDestroy: new Set([ENDED]),
    });
    const report = await runOrphanWorkspaceReap(options);
    expect(recorded.destroyed).toEqual([ENDED, UNKNOWN_OLD]);
    expect(recorded.counted).toEqual(['remove_failed', 'removed_unknown']);
    expect(report.failed).toBe(1);
    expect(
      recorded.lines.some((line) => line.level === 'error' && line.fields['run_id'] === ENDED),
    ).toBe(true);
  });

  it('throws when the launcher cannot list, rather than reporting a pass that found nothing', async () => {
    const { options, recorded } = harness({ listing: new Error('connect ECONNREFUSED') });
    await expect(runOrphanWorkspaceReap(options)).rejects.toThrow(/ECONNREFUSED/);
    expect(recorded.destroyed).toEqual([]);
    expect(recorded.asked).toEqual([]);
  });

  it('asks no rows and removes nothing when the launcher labelled nothing', async () => {
    const { options, recorded } = harness({ listing: [] });
    const report = await runOrphanWorkspaceReap(options);
    expect(report.listed).toBe(0);
    expect(recorded.asked).toEqual([]);
    expect(recorded.destroyed).toEqual([]);
  });
});

describe('the timer', () => {
  const manualClock = () => {
    const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
    return {
      timers,
      clock: {
        now: () => NOW,
        setTimer: (ms: number, fire: () => void) => {
          const timer = { ms, fire, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      },
    };
  };

  it('arms nothing when the recovery interval is 0', () => {
    const { options } = harness({ listing: [] });
    const { clock, timers } = manualClock();
    expect(startOrphanWorkspaceReaper({ ...options, clock, intervalMs: 0 })).toBeNull();
    expect(timers).toEqual([]);
  });

  it('runs a pass per interval, with the interval as the grace, and re-arms until stopped', async () => {
    const { options, recorded } = harness({
      listing: [listed(ENDED), listed(ENDED_RECENTLY)],
    });
    const { clock, timers } = manualClock();
    // A 5-second interval is a 5-second grace: the run that ended 10 s ago is past it, so it is
    // removed beside the one that ended ten minutes ago — at the harness's 60 s it was kept.
    const reaper = startOrphanWorkspaceReaper({ ...options, clock, intervalMs: 5_000 });
    expect(timers.map((timer) => timer.ms)).toEqual([5_000]);
    timers[0]?.fire();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(recorded.destroyed).toEqual([ENDED, ENDED_RECENTLY]);
    expect(timers).toHaveLength(2);
    reaper?.stop();
    expect(timers[1]?.cancelled).toBe(true);
  });

  it('keeps its chain when a pass throws, and says so', async () => {
    const { options, recorded } = harness({ listing: new Error('the launcher is restarting') });
    const { clock, timers } = manualClock();
    startOrphanWorkspaceReaper({ ...options, clock, intervalMs: 60_000 });
    timers[0]?.fire();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers).toHaveLength(2);
    expect(recorded.lines.some((line) => line.level === 'warn')).toBe(true);
  });
});
