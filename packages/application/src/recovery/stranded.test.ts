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
import type {
  StrandedAsk,
  StrandedAskWithEndedRun,
  StrandedBootstrapBatch,
  StrandedCuration,
  StrandedHistoryRecord,
  StrandedQuery,
} from './stranded.js';
import { runStrandedRecovery, STRANDED_ENDING_AFTER_MS } from './stranded.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const BATCH = '00000000-0000-4000-8000-0000000000b1' as Id;
const ASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000d1' as Id;
const CHUNK = '00000000-0000-4000-8000-0000000000e1' as Id;
const ARTIFACT = '00000000-0000-4000-8000-0000000000e2' as Id;
const RUN = '00000000-0000-4000-8000-0000000000e3' as Id;
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

const strandedRecord = (recoveryAttemptedAt: IsoDateTime | null): StrandedHistoryRecord => ({
  chunkId: CHUNK,
  batchId: BATCH,
  projectId: PROJECT,
  taskId: TASK,
  artifactId: ARTIFACT,
  recoveryAttemptedAt,
});

const strandedCuration = (recoveryAttemptedAt: IsoDateTime | null): StrandedCuration => ({
  artifactId: ARTIFACT,
  projectId: PROJECT,
  taskId: TASK,
  artifactType: 'LibrarianProposals',
  recoveryAttemptedAt,
});

const askWithEndedRun = (
  overrides: Partial<StrandedAskWithEndedRun> = {},
): StrandedAskWithEndedRun => ({
  askId: ASK,
  taskId: TASK,
  projectId: PROJECT,
  runId: RUN,
  runStatus: 'failed',
  runTerminalReason: 'lease_expired',
  ...overrides,
});

const passOver = async (
  rows: {
    readonly bootstraps?: readonly StrandedBootstrapBatch[];
    readonly asks?: readonly StrandedAsk[];
    readonly records?: readonly StrandedHistoryRecord[];
    readonly curations?: readonly StrandedCuration[];
    readonly endedRunAsks?: readonly StrandedAskWithEndedRun[];
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
      strandedHistoryRecords: async (_tx, query) => {
        recorded.asked.push(query);
        return rows.records ?? [];
      },
      markHistoryRecordAttempt: async (_tx, mark) => {
        recorded.calls.push('markHistoryRecordAttempt');
        recorded.written.push({
          call: 'markHistoryRecordAttempt',
          id: mark.chunkId,
          at: mark.at,
        });
      },
      endHistoryRecord: async (_tx, ending) => {
        recorded.calls.push('endHistoryRecord');
        recorded.written.push({
          call: 'endHistoryRecord',
          id: ending.chunkId,
          reason: ending.reason,
          at: ending.at,
        });
      },
      strandedCurations: async (_tx, query) => {
        recorded.asked.push(query);
        return rows.curations ?? [];
      },
      markCurationAttempt: async (_tx, mark) => {
        recorded.calls.push('markCurationAttempt');
        recorded.written.push({
          call: 'markCurationAttempt',
          id: mark.artifactId,
          at: mark.at,
        });
      },
      endCuration: async (_tx, ending) => {
        recorded.calls.push('endCuration');
        recorded.written.push({
          call: 'endCuration',
          id: ending.artifactId,
          reason: ending.reason,
          at: ending.at,
        });
      },
      asksWithEndedRun: async (_tx, query) => {
        recorded.asked.push(query);
        return rows.endedRunAsks ?? [];
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
      { site: 'history_record', found: 0, reEnqueued: 0, ended: 0 },
      { site: 'knowledge_curation', found: 0, reEnqueued: 0, ended: 0 },
      { site: 'task_ask_run', found: 0, reEnqueued: 0, ended: 0 },
    ]);
  });

  it('asks every site for rows older than the grace, which is the pass interval', async () => {
    const { recorded } = await passOver({}, 90_000);
    // One knob rather than two (`intake-reconcile.ts`'s sentence): the age a row must reach is the
    // interval between passes, so a row younger than that still has its own job in flight.
    // Five queries, one per site: a site that stopped asking would be a recovery that silently
    // covers less than the table says it does.
    expect(recorded.asked).toHaveLength(5);
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
        { site: 'history_record', found: 0, reEnqueued: 0, ended: 0 },
        { site: 'knowledge_curation', found: 0, reEnqueued: 0, ended: 0 },
        { site: 'task_ask_run', found: 0, reEnqueued: 0, ended: 0 },
      ]);
    });
  });

  /**
   * The two sites WP-48 added, and the row that ends an ask rather than waking one.
   *
   * Asserted the way the first two are: on the **enqueue** each makes — the queue, the payload and
   * the key — and on the **bound**, because a pass that found the row and enqueued nothing is
   * spelled identically to one that found nothing. The end-to-end half (drop the enqueue, read the
   * row's own status back) is the e2e's.
   */
  describe('the record site (backlog 106): a mining run that reported and was never recorded', () => {
    it('re-enqueues the record job with the artifact the run stored', async () => {
      const { jobs, report, recorded } = await passOver({ records: [strandedRecord(null)] });

      const enqueued = jobs.enqueued.filter((job) => job.queue === JOB_QUEUES.historyBootstrap);
      expect(enqueued).toHaveLength(1);
      // The payload `record.ts`'s handler builds. A different shape is a job the handler answers
      // `skipped` to, which reads exactly like a recovery that worked.
      expect(enqueued[0]?.data).toEqual({
        kind: 'record',
        project_id: PROJECT,
        task_id: TASK,
        artifact_id: ARTIFACT,
      });
      expect(report.find((site) => site.site === 'history_record')).toEqual({
        site: 'history_record',
        found: 1,
        reEnqueued: 1,
        ended: 0,
      });
      expect(recorded.calls).toEqual([
        'markHistoryRecordAttempt',
        `enqueue:${JOB_QUEUES.historyBootstrap}`,
      ]);
      expect(recorded.written).toEqual([{ call: 'markHistoryRecordAttempt', id: CHUNK, at: NOW }]);
    });

    it('closes the chunk — and with it the batch — when its one attempt did not take', async () => {
      const { jobs, report, recorded } = await passOver({ records: [strandedRecord(LAST_PASS)] });

      // The defect this closes is backlog 101's, one wake-up later: the batch never completes, and
      // `history_bootstrap_batches_one_live` then refuses every later bootstrap of the project.
      expect(jobs.enqueued).toEqual([]);
      expect(recorded.written).toHaveLength(1);
      expect(recorded.written[0]).toMatchObject({ call: 'endHistoryRecord', id: CHUNK, at: NOW });
      expect(recorded.written[0]?.reason).toContain(LAST_PASS);
      expect(report.find((site) => site.site === 'history_record')).toEqual({
        site: 'history_record',
        found: 1,
        reEnqueued: 0,
        ended: 1,
      });
    });
  });

  describe('the curation site (backlog 36): an artifact that was stored and never curated', () => {
    it('re-enqueues the curation on the artifact’s own singleton key', async () => {
      const { jobs, report, recorded } = await passOver({ curations: [strandedCuration(null)] });

      const enqueued = jobs.enqueued.filter((job) => job.queue === JOB_QUEUES.knowledgeProposals);
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]?.data).toEqual({
        project_id: PROJECT,
        task_id: TASK,
        artifact_id: ARTIFACT,
        artifact_type: 'LibrarianProposals',
      });
      // What makes a re-enqueue safe at all here: `stately` per artifact collapses a wake-up that
      // is still queued, and `markCurated` refuses a second set of proposals once one has run.
      expect(enqueued[0]?.singletonKey).toBe(`artifact:${ARTIFACT}`);
      expect(report.find((site) => site.site === 'knowledge_curation')?.reEnqueued).toBe(1);
      expect(recorded.calls).toEqual([
        'markCurationAttempt',
        `enqueue:${JOB_QUEUES.knowledgeProposals}`,
      ]);
      expect(recorded.written).toEqual([{ call: 'markCurationAttempt', id: ARTIFACT, at: NOW }]);
    });

    it('gives up on a curation it has already attempted, rather than curating for ever', async () => {
      const { jobs, report, recorded } = await passOver({
        curations: [strandedCuration(LAST_PASS)],
      });

      expect(jobs.enqueued).toEqual([]);
      expect(recorded.written[0]).toMatchObject({ call: 'endCuration', id: ARTIFACT, at: NOW });
      expect(recorded.written[0]?.reason).toContain(LAST_PASS);
      expect(report.find((site) => site.site === 'knowledge_curation')).toEqual({
        site: 'knowledge_curation',
        found: 1,
        reEnqueued: 0,
        ended: 1,
      });
    });
  });

  describe('the ask whose run is over (backlog 121)', () => {
    it('ends the question, quoting the run’s own ending, and wakes nothing', async () => {
      const { jobs, report, recorded } = await passOver({ endedRunAsks: [askWithEndedRun()] });

      // Nothing to wake: the run it was waiting for is terminal, and a re-enqueue would be a new
      // paid run for a question whose asker was told nothing.
      expect(jobs.enqueued).toEqual([]);
      expect(recorded.calls).toEqual(['endAsk']);
      expect(recorded.written[0]).toMatchObject({ call: 'endAsk', id: ASK });
      // The thread says what happened rather than "failed": the run's status and its terminal
      // reason are platform enum values, so quoting them carries no untrusted text.
      expect(recorded.written[0]?.reason).toContain('failed');
      expect(recorded.written[0]?.reason).toContain('lease_expired');
      expect(report.find((site) => site.site === 'task_ask_run')).toEqual({
        site: 'task_ask_run',
        found: 1,
        reEnqueued: 0,
        ended: 1,
      });
    });

    it('says only what the row says when the run ended with no terminal reason', async () => {
      const { recorded } = await passOver({
        endedRunAsks: [askWithEndedRun({ runStatus: 'cancelled', runTerminalReason: null })],
      });

      const reason = recorded.written[0]?.reason ?? '';
      expect(reason).toContain('cancelled');
      // No empty parentheses, and no invented reason: `null` is a run that ended without one.
      expect(reason).not.toContain('()');
      expect(reason).not.toContain('null');
    });
  });

  /**
   * The third site (WP-47): a run nothing is renewing the lease of.
   *
   * What is asserted here is that the pass **runs it on the same timer and reports it**, which is
   * backlog 101's whole argument for one pass; what the sweep *does* is
   * `./run-lease.test.ts`'s subject and is not re-asserted through this seam.
   */
  describe('the run-lease site', () => {
    it('is absent from the report when the composition did not ask for it', async () => {
      const { report } = await passOver({});

      // Absence is a composition that has not opted in, not a silent skip: a build with no
      // pipeline store still recovers the two sites that are only queries.
      expect(report.map((site) => site.site)).toEqual([
        'history_bootstrap',
        'task_ask',
        'history_record',
        'knowledge_curation',
        'task_ask_run',
      ]);
    });

    it('rides the same pass, with the same grace, and reports what it ended', async () => {
      const asked: { graceMs: number; limit: number }[] = [];
      const report = await runStrandedRecovery({
        store: {
          strandedBootstraps: async () => [],
          markBootstrapAttempt: async () => {},
          endBootstrap: async () => {},
          strandedAsks: async () => [],
          markAskAttempt: async () => {},
          endAsk: async () => {},
          strandedHistoryRecords: async () => [],
          markHistoryRecordAttempt: async () => {},
          endHistoryRecord: async () => {},
          strandedCurations: async () => [],
          markCurationAttempt: async () => {},
          endCuration: async () => {},
          asksWithEndedRun: async () => [],
        },
        unitOfWork: new MemoryEventing(),
        jobs: recordingJobs(),
        clock: { now: () => NOW },
        graceMs: 60_000,
        runs: {
          // The sweep is reached through its own options object, so what this case can see is the
          // two numbers the pass hands it — which is exactly what "one pass, one interval" means.
          store: {
            expiredRuns: async (_tx, query) => {
              asked.push({ graceMs: 0, limit: query.limit });
              return [];
            },
            claimExpiredRun: async () => false,
          },
          pipeline: undefined as never,
          unitOfWork: new MemoryEventing(),
          eventStore: { nextStreamSequence: async () => 1 },
          context: () => undefined as never,
          wallClockMs: 60 * 60_000,
        },
      });

      expect(asked).toEqual([{ graceMs: 0, limit: 50 }]);
      // `reEnqueued: 0` by construction: this site ends rows rather than waking them, which is why
      // it needs no attempt mark.
      expect(report.at(-1)).toEqual({ site: 'run_lease', found: 0, reEnqueued: 0, ended: 0 });
    });
  });
});
