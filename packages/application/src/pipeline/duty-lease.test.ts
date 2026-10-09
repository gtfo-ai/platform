/**
 * WP-184 — the task duty lease's own behaviour over the memory store: one holder at a time, the
 * renewal while the work runs, the release at the end whatever the work did, and the refusal by
 * name when the lease stays held. The store half of the lease (claim, renewal, take-over, release)
 * is the shared contract in `test/contract/support/pipeline-store-concurrency-suite.ts`, run
 * against PostgreSQL too.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import {
  REVIEW_CONVERSATION_LEASE,
  TaskDutyLeaseBusyError,
  type TaskDutyLeaseOptions,
  withTaskDutyLease,
} from './duty-lease.js';

const TASK = '00000000-0000-4000-8000-0000000184d1' as Id;
const NOW = '2026-06-01T09:00:00.000Z';

const setup = () => {
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  const warnings: string[] = [];
  const beats: (() => void)[] = [];
  let stopped = 0;
  let counter = 0;
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (_fields, message) => warnings.push(message),
    error: () => {},
  };
  const options: TaskDutyLeaseOptions = {
    unitOfWork: memory,
    store,
    ids: {
      next: () => {
        counter += 1;
        return `00000000-0000-4000-9000-${counter.toString(16).padStart(12, '0')}` as Id;
      },
    },
    clock: { now: () => NOW },
    logger,
    dutyLease: {
      pollMs: 1,
      // The case drives the renewal beat by hand rather than waiting for it.
      schedule: (_everyMs, beat) => {
        beats.push(beat);
        return () => {
          stopped += 1;
        };
      },
    },
  };
  const holdBy = async (holder: string) =>
    memory.transaction(async (scope) =>
      store.dutyLeases.claim(scope.tx, {
        taskId: TASK,
        lease: REVIEW_CONVERSATION_LEASE,
        holder,
        now: NOW as IsoDateTime,
        expiresAt: '2026-06-01T09:02:00.000Z' as IsoDateTime,
      }),
    );
  return { memory, store, options, warnings, beats, holdBy, stopped: () => stopped };
};

const input = { taskId: TASK, lease: REVIEW_CONVERSATION_LEASE, waitMs: 20 };

describe('withTaskDutyLease (WP-184)', () => {
  it('runs the work holding the lease, and releases it afterwards', async () => {
    const w = setup();
    const during = await withTaskDutyLease(w.options, input, async () => w.holdBy('duty:other'));
    // While the work ran, another performer could not take the lease…
    expect(during).toBe(false);
    // …and once it returned, it could.
    expect(await w.holdBy('duty:other')).toBe(true);
    expect(w.stopped()).toBe(1);
  });

  it('releases the lease when the work throws, and the error comes out unchanged', async () => {
    const w = setup();
    const failure = new Error('the provider refused');
    await expect(
      withTaskDutyLease(w.options, input, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await w.holdBy('duty:other')).toBe(true);
  });

  it('waits for the holder and then runs', async () => {
    const w = setup();
    expect(await w.holdBy('duty:first')).toBe(true);
    const release = setTimeout(() => {
      void w.memory.transaction(async (scope) =>
        w.store.dutyLeases.release(scope.tx, {
          taskId: TASK,
          lease: REVIEW_CONVERSATION_LEASE,
          holder: 'duty:first',
        }),
      );
    }, 5);
    const ran = await withTaskDutyLease(w.options, { ...input, waitMs: 1_000 }, async () => 'ran');
    clearTimeout(release);
    expect(ran).toBe('ran');
  });

  it('refuses by name when the lease stays held for the whole wait, and runs nothing', async () => {
    const w = setup();
    expect(await w.holdBy('duty:first')).toBe(true);
    let ran = false;
    const refusal = await withTaskDutyLease(w.options, input, async () => {
      ran = true;
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TaskDutyLeaseBusyError);
    expect(refusal).toMatchObject({ taskId: TASK, lease: REVIEW_CONVERSATION_LEASE });
    expect(ran).toBe(false);
  });

  it('renews on each beat, and says so when another performer has taken the lease over', async () => {
    const w = setup();
    await withTaskDutyLease(w.options, input, async () => {
      const [beat] = w.beats;
      beat?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(w.warnings).toEqual([]);
      // The lease lapses and another performer takes it over (the memory store's expiry is the
      // caller's instant, so a release stands in for it here); the next beat cannot renew.
      await w.memory.transaction(async (scope) =>
        w.store.dutyLeases.release(scope.tx, {
          taskId: TASK,
          lease: REVIEW_CONVERSATION_LEASE,
          holder: 'duty:00000000-0000-4000-9000-000000000001',
        }),
      );
      expect(await w.holdBy('duty:other')).toBe(true);
      beat?.();
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
    expect(w.warnings).toEqual([
      'a duty lease was taken over while its holder still worked; the next performer may repeat a call',
    ]);
  });

  it('never lets a renewal still in flight bring a released lease back (review round 1)', async () => {
    const w = setup();
    // Every lease write after the first claim — the renewal — is held open until `open()`.
    let writes = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const held =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        writes += 1;
        if (writes > 1) await gate;
        return fn(...args);
      };
    const leases = w.store.dutyLeases;
    const options: TaskDutyLeaseOptions = {
      ...w.options,
      store: {
        dutyLeases: {
          claim: held(leases.claim),
          renew: held(leases.renew),
          release: leases.release,
        },
      },
    };
    const opening = setTimeout(open, 20);
    await withTaskDutyLease(options, input, async () => {
      // The renewal starts and is still in flight when the work ends.
      w.beats[0]?.();
    });
    clearTimeout(opening);
    open();
    // Whatever the renewal did, it has landed by now.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      await w.holdBy('duty:next'),
      'the next performer takes the lease the finished holder released',
    ).toBe(true);
  });

  it('is disarmed only by the seam: the work runs and nothing is claimed', async () => {
    const w = setup();
    expect(await w.holdBy('duty:first')).toBe(true);
    const ran = await withTaskDutyLease(
      { ...w.options, dutyLease: { disarmed: true } },
      input,
      async () => 'ran',
    );
    expect(ran).toBe('ran');
  });
});
