/**
 * The lost-wake-up table: what each row finds, what it enqueues, and what bounds it (WP-36).
 *
 * The assertions are on the **enqueue** each row makes — the queue, the payload and the singleton
 * key — because that is the countable effect of a recovery (standing rule 79): a pass that found the
 * row and enqueued nothing is spelled identically to one that found nothing, and the second is what
 * every build before this one did.
 *
 * Since review round 2 they are also on the **bound** (PROGRESS backlog 105): the mark this pass
 * writes before it enqueues, and the ending it gives a row whose one attempt did not take. A pass
 * that re-enqueues for ever is spelled identically to one that recovers, for exactly as long as
 * nobody counts the attempts.
 *
 * The *end-to-end* half — dropping the enqueue and reading the recovery back from the row's own
 * status — is the e2e's, per PROGRESS backlog 20's reproduction repeated at both sites.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { EnqueueRequest, JobData } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import type { StrandedAsk, StrandedBootstrapBatch, StrandedQuery } from './stranded.js';
import { runStrandedRecovery, STRANDED_ENDING_AFTER_MS } from './stranded.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const BATCH = '00000000-0000-4000-8000-0000000000b1' as Id;
const ASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000d1' as Id;
const NOW = '2026-09-15T10:00:00.000Z' as IsoDateTime;
/** When a previous pass spent this row's one attempt. */
const LAST_PASS = '2026-09-15T08:00:00.000Z' as IsoDateTime;

/** One write the pass made on the store — a mark or an ending. */
interface Written {
  readonly call: string;
  readonly id: Id;
  readonly reason?: string;
  readonly at?: IsoDateTime;
}

interface Recorded {
  readonly asked: StrandedQuery[];
  /** Marks, endings and enqueues in the order they happened, which is load-bearing. */
  readonly calls: string[];
  readonly written: Written[];
}

const strandedBatch = (recoveryAttemptedAt: IsoDateTime | null): StrandedBootstrapBatch => ({
  batchId: BATCH,
  projectId: PROJECT,
  recoveryAttemptedAt,
});

const strandedAsk = (recoveryAttemptedAt: IsoDateTime | null): StrandedAsk => ({
  askId: ASK,
  taskId: TASK,
  projectId: PROJECT,
  recoveryAttemptedAt,
});

const passOver = async (
  rows: {
    readonly bootstraps?: readonly StrandedBootstrapBatch[];
    readonly asks?: readonly StrandedAsk[];
  },
  graceMs = 60_000,
) => {
  const recorded: Recorded = { asked: [], calls: [], written: [] };
  const jobs = recordingJobs();
  const observed = {
    ...jobs,
    enqueue: async <TData extends JobData = JobData>(request: EnqueueRequest<TData>) => {
      recorded.calls.push(`enqueue:${request.queue}`);
      return jobs.enqueue(request);
    },
  };
  const report = await runStrandedRecovery({
    store: {
      strandedBootstraps: async (_tx, query) => {
        recorded.asked.push(query);
        return rows.bootstraps ?? [];
      },
      markBootstrapAttempt: async (_tx, mark) => {
        recorded.calls.push('markBootstrapAttempt');
        recorded.written.push({ call: 'markBootstrapAttempt', id: mark.batchId, at: mark.at });
      },
      endBootstrap: async (_tx, ending) => {
        recorded.calls.push('endBootstrap');
        recorded.written.push({
          call: 'endBootstrap',
          id: ending.batchId,
          reason: ending.reason,
          at: ending.at,
        });
      },
      strandedAsks: async (_tx, query) => {
        recorded.asked.push(query);
        return rows.asks ?? [];
      },
      markAskAttempt: async (_tx, mark) => {
        recorded.calls.push('markAskAttempt');
        recorded.written.push({ call: 'markAskAttempt', id: mark.askId, at: mark.at });
      },
      endAsk: async (_tx, ending) => {
        recorded.calls.push('endAsk');
        recorded.written.push({ call: 'endAsk', id: ending.askId, reason: ending.reason });
      },
    },
    unitOfWork: new MemoryEventing(),
    jobs: observed,
    clock: { now: () => NOW },
    graceMs,
  });
  return { jobs, report, recorded };
};

describe('the stranded-work pass', () => {
  it('re-enqueues the collect job of a batch left collecting, with the batch’s own payload', async () => {
    const { jobs, report, recorded } = await passOver({ bootstraps: [strandedBatch(null)] });

    const enqueued = jobs.enqueued.filter((job) => job.queue === JOB_QUEUES.historyBootstrap);
    expect(enqueued).toHaveLength(1);
    // The payload is the one `startHistoryBootstrap` would have sent — a different shape would be a
    // job the handler answers `skipped` to, which reads exactly like a recovery that worked.
    expect(enqueued[0]?.data).toEqual({
      kind: 'collect',
      batch_id: BATCH,
      project_id: PROJECT,
    });
    expect(report.find((site) => site.site === 'history_bootstrap')).toEqual({
      site: 'history_bootstrap',
      found: 1,
      reEnqueued: 1,
      ended: 0,
    });
    // The bound is written **before** the enqueue, which is the order the module argues for: a
    // crash between the two costs this row its one attempt, where the reverse order would restore
    // the unbounded re-enqueue this bound exists to stop (backlog 105).
    expect(recorded.calls).toEqual([
      'markBootstrapAttempt',
      `enqueue:${JOB_QUEUES.historyBootstrap}`,
    ]);
    expect(recorded.written).toEqual([{ call: 'markBootstrapAttempt', id: BATCH, at: NOW }]);
  });

  it('re-enqueues a pending ask on its own singleton key, so a wake-up in flight collapses', async () => {
    const { jobs, report, recorded } = await passOver({ asks: [strandedAsk(null)] });

    const enqueued = jobs.enqueued.filter((job) => job.queue === JOB_QUEUES.taskAsk);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.data).toEqual({ ask_id: ASK, task_id: TASK, project_id: PROJECT });
    // What makes a blind re-enqueue safe here, asserted rather than described: `stately` plus this
    // key is why a redelivered wake-up cannot start a second paid run (backlog 84's second bullet).
    expect(enqueued[0]?.singletonKey).toBe(`ask:${ASK}`);
    expect(report.find((site) => site.site === 'task_ask')?.reEnqueued).toBe(1);
    expect(recorded.calls).toEqual(['markAskAttempt', `enqueue:${JOB_QUEUES.taskAsk}`]);
    expect(recorded.written).toEqual([{ call: 'markAskAttempt', id: ASK, at: NOW }]);
  });

  it('enqueues nothing when nothing is stranded, and says so rather than silently', async () => {
    const { jobs, report } = await passOver({});
    expect(jobs.enqueued).toEqual([]);
    expect(report).toEqual([
      { site: 'history_bootstrap', found: 0, reEnqueued: 0, ended: 0 },
      { site: 'task_ask', found: 0, reEnqueued: 0, ended: 0 },
    ]);
  });

  it('asks both sites for rows older than the grace, which is the pass interval', async () => {
    const { recorded } = await passOver({}, 90_000);
    // One knob rather than two (`intake-reconcile.ts`'s sentence): the age a row must reach is the
    // interval between passes, so a row younger than that still has its own job in flight.
    expect(recorded.asked).toHaveLength(2);
    for (const query of recorded.asked) {
      expect(Date.parse(NOW) - Date.parse(query.olderThan)).toBe(90_000);
      // …and the **ending** window is deliberately not that number: being early there ends work
      // that was about to happen, where being late only delays a row that is already stuck.
      expect(Date.parse(NOW) - Date.parse(query.endingBefore)).toBe(STRANDED_ENDING_AFTER_MS);
      expect(query.limit).toBeGreaterThan(0);
    }
  });

  it('never lets the ending window fall inside the grace, however long the interval is', async () => {
    const interval = STRANDED_ENDING_AFTER_MS * 2;
    const { recorded } = await passOver({}, interval);
    // An operator who sets the pass interval longer than an hour would otherwise get an ending
    // before the pass that reads the mark — an ending with no attempt behind it.
    for (const query of recorded.asked) {
      expect(Date.parse(NOW) - Date.parse(query.endingBefore)).toBe(interval);
    }
  });

  describe('the bound: one attempt per stranded row, then that row’s own ending', () => {
    it('does not re-enqueue a batch it has already attempted; it closes it with the reason', async () => {
      const { jobs, report, recorded } = await passOver({ bootstraps: [strandedBatch(LAST_PASS)] });

      // The defect this closes: the same row re-enqueued every minute for ever, each one a provider
      // fan-out, with the batch still holding `history_bootstrap_batches_one_live` against the
      // project so the operator's own retry answers `already_running`.
      expect(jobs.enqueued).toEqual([]);
      expect(recorded.written).toHaveLength(1);
      expect(recorded.written[0]).toMatchObject({ call: 'endBootstrap', id: BATCH, at: NOW });
      // The reason is what an operator reads off the batch row, so it names the attempt that did
      // not take rather than only the fact of failure.
      expect(recorded.written[0]?.reason).toContain(LAST_PASS);
      expect(report.find((site) => site.site === 'history_bootstrap')).toEqual({
        site: 'history_bootstrap',
        found: 1,
        reEnqueued: 0,
        ended: 1,
      });
    });

    it('does not re-enqueue an ask it has already attempted; it records the failure', async () => {
      const { jobs, report, recorded } = await passOver({ asks: [strandedAsk(LAST_PASS)] });

      expect(jobs.enqueued).toEqual([]);
      expect(recorded.written).toHaveLength(1);
      expect(recorded.written[0]).toMatchObject({ call: 'endAsk', id: ASK });
      expect(recorded.written[0]?.reason).toContain(LAST_PASS);
      expect(report.find((site) => site.site === 'task_ask')).toEqual({
        site: 'task_ask',
        found: 1,
        reEnqueued: 0,
        ended: 1,
      });
    });

    it('acts once per row on a mixed pass: one attempt, one ending, and two writes', async () => {
      const { jobs, report, recorded } = await passOver({
        bootstraps: [strandedBatch(null)],
        asks: [strandedAsk(LAST_PASS)],
      });

      expect(jobs.enqueued.map((job) => job.queue)).toEqual([JOB_QUEUES.historyBootstrap]);
      expect(recorded.written.map((write) => write.call)).toEqual([
        'markBootstrapAttempt',
        'endAsk',
      ]);
      expect(report).toEqual([
        { site: 'history_bootstrap', found: 1, reEnqueued: 1, ended: 0 },
        { site: 'task_ask', found: 1, reEnqueued: 0, ended: 1 },
      ]);
    });
  });
});
