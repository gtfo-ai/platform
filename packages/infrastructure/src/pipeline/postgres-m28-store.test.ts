/**
 * The M28 store methods over a recording `SqlExecutor`: what the adapter sends and what it does with
 * the rows PostgreSQL answers — S-28.10's out-of-sync record (`task_provider_sync`, migration 0116),
 * S-28.5's one-off sweep and reverse-sync stop (migration 0115), S-28.6's per-person admission
 * (migration 0114), S-28.1's resume in place and S-28.2's forward sighting (migration 0111). The
 * statements themselves run against PostgreSQL 18 in the pipeline-store contract suite
 * (`test/contract/support/pipeline-store-suite.ts`, through the integration tier); this tier holds
 * the parameters, the parse and each answer's mapping.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { POSTGRES_ADAPTER, type PostgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { createPostgresPipelineStore } from './postgres-pipeline-store.js';

const TASK = '00000000-0000-4000-8000-0000000028a1' as Id;
const OWNER = '00000000-0000-4000-8000-0000000028a2' as Id;
const AT = '2026-11-10T09:00:00.000Z' as IsoDateTime;

const recording = (rows: readonly Record<string, unknown>[], rowCount = rows.length) => {
  const calls: { text: string; values: unknown[] }[] = [];
  const client: SqlExecutor = {
    query: async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: rows as R[], rowCount };
    },
  };
  const tx: PostgresTransaction = { adapter: POSTGRES_ADAPTER, client };
  return { tx, calls };
};

// No task row is loaded here, so no template is needed to read one.
const store = () => createPostgresPipelineStore({ templates: {} });

const STATUS_FAILURE = {
  subject: 'ticket_status' as const,
  slot: 'in_progress',
  target: 'In Progress',
  observed: 'To Do',
  available: ['To Do', 'Done'],
  reason: 'the tracker refused the move',
  reason_code: 'transition_refused',
  failed_at: AT,
};

describe('task_provider_sync (S-28.10, migration 0116)', () => {
  it('reads every row parsed with the published shape, and refuses one that does not parse', async () => {
    const read = recording([{ ...STATUS_FAILURE, attempts: 2 }]);
    expect(await store().tasks.providerSync(read.tx, TASK)).toEqual([
      { ...STATUS_FAILURE, attempts: 2 },
    ]);
    expect(read.calls[0]?.values).toEqual([TASK]);
    expect(read.calls[0]?.text).toContain('from task_provider_sync where task_id = $1');

    const bad = recording([{ ...STATUS_FAILURE, attempts: 0 }]);
    await expect(store().tasks.providerSync(bad.tx, TASK)).rejects.toThrow();
  });

  it('upserts a failure, the offered statuses as JSON or null', async () => {
    const offered = recording([], 1);
    await store().tasks.recordProviderSyncFailure(offered.tx, TASK, STATUS_FAILURE);
    expect(offered.calls[0]?.text).toContain('on conflict (task_id, subject) do update');
    expect(offered.calls[0]?.values).toEqual([
      TASK,
      'ticket_status',
      'in_progress',
      'In Progress',
      'To Do',
      JSON.stringify(['To Do', 'Done']),
      'the tracker refused the move',
      'transition_refused',
      AT,
    ]);

    const none = recording([], 1);
    await store().tasks.recordProviderSyncFailure(none.tx, TASK, {
      ...STATUS_FAILURE,
      subject: 'merge_request_draft',
      slot: null,
      available: null,
    });
    expect(none.calls[0]?.values[5]).toBeNull();
  });

  it('answers whether a clear removed a row', async () => {
    const cleared = recording([], 1);
    expect(await store().tasks.clearProviderSync(cleared.tx, TASK, 'ticket_status')).toBe(true);
    expect(cleared.calls[0]?.values).toEqual([TASK, 'ticket_status']);
    const nothing = recording([], 0);
    expect(await store().tasks.clearProviderSync(nothing.tx, TASK, 'merge_request_draft')).toBe(
      false,
    );
  });
});

describe('the ticket-status sweep and stop (S-28.5, migration 0115)', () => {
  it('maps the due tasks, with the bound and the limit as parameters', async () => {
    const due = recording([{ id: TASK, project_id: OWNER }]);
    expect(
      await store().tasks.ticketStatusSweepDue(due.tx, {
        olderThan: AT,
        limit: 25,
        revisionAt: AT,
      }),
    ).toEqual([{ taskId: TASK, projectId: OWNER }]);
    expect(due.calls[0]?.values).toEqual([AT, 25, AT]);
  });

  it('claims a task once: a returned row is a claim, none is somebody else’s', async () => {
    const won = recording([{ task_id: TASK }]);
    expect(await store().tasks.claimTicketStatusSweep(won.tx, TASK, AT, AT)).toBe(true);
    expect(won.calls[0]?.values).toEqual([TASK, AT, AT]);
    const lost = recording([]);
    expect(await store().tasks.claimTicketStatusSweep(lost.tx, TASK, AT, AT)).toBe(false);
  });

  it('reads the status a stop acted on, null without one, and upserts a new one', async () => {
    expect(await store().tasks.ticketStatusStopOf(recording([{ status: 'Done' }]).tx, TASK)).toBe(
      'Done',
    );
    expect(await store().tasks.ticketStatusStopOf(recording([]).tx, TASK)).toBeNull();
    const write = recording([], 1);
    await store().tasks.recordTicketStatusStop(write.tx, TASK, 'Done', AT);
    expect(write.calls[0]?.values).toEqual([TASK, 'Done', AT]);
    expect(write.calls[0]?.text).toContain('on conflict (task_id) do update');
  });
});

describe('the per-person admission (S-28.6, migration 0114)', () => {
  it('takes the person’s lock, then counts, and reads a missing limit as null', async () => {
    const limited = recording([{ in_flight: '3', personal_limit: 4 }]);
    expect(await store().tasks.ownerAdmission(limited.tx, OWNER)).toEqual({
      inFlight: 3,
      personalLimit: 4,
    });
    expect(limited.calls[0]?.text).toContain('pg_advisory_xact_lock');
    expect(limited.calls).toHaveLength(2);

    const open = recording([{ in_flight: '0', personal_limit: null }]);
    expect(await store().tasks.ownerAdmission(open.tx, OWNER)).toEqual({
      inFlight: 0,
      personalLimit: null,
    });
    const empty = recording([]);
    expect(await store().tasks.ownerAdmission(empty.tx, OWNER)).toEqual({
      inFlight: 0,
      personalLimit: null,
    });
  });

  it('asks nothing for no owners, and lists the projects of the named owners’ queued tasks', async () => {
    const none = recording([]);
    expect(await store().tasks.queuedProjectsOfOwners(none.tx, [])).toEqual([]);
    expect(none.calls).toHaveLength(0);
    const some = recording([{ project_id: 'p1' }, { project_id: 'p2' }]);
    expect(await store().tasks.queuedProjectsOfOwners(some.tx, [OWNER])).toEqual(['p1', 'p2']);
    expect(some.calls[0]?.values).toEqual([[OWNER]]);
  });
});

describe('the attempt reads and writes of S-28.1 and S-28.2', () => {
  it('counts an attempt’s runs, zero when nothing answers', async () => {
    expect(
      await store().tasks.stageAttemptRuns(recording([{ count: 2 }]).tx, TASK, 'implementation', 1),
    ).toBe(2);
    expect(await store().tasks.stageAttemptRuns(recording([]).tx, TASK, 'implementation', 1)).toBe(
      0,
    );
  });

  it('re-enters only an open row, and says whether it did', async () => {
    const entry = { taskId: TASK, stage: 'implementation', attempt: 1, causedByEventId: null };
    const open = recording([], 1);
    expect(await store().tasks.reenterOpenStage(open.tx, entry)).toBe(true);
    expect(open.calls[0]?.values).toEqual([TASK, 'implementation', 1, null]);
    expect(await store().tasks.reenterOpenStage(recording([], 0).tx, entry)).toBe(false);
  });

  it('answers the first forward sighting as an instant, null when no row answered', async () => {
    const entry = { taskId: TASK, stage: 'qa', attempt: 1, at: AT };
    expect(
      await store().tasks.observeTicketForward(
        recording([{ ticket_forward_seen_at: new Date(AT) }]).tx,
        entry,
      ),
    ).toBe(AT);
    expect(await store().tasks.observeTicketForward(recording([]).tx, entry)).toBeNull();
  });
});

describe('task_merges and the merge decision (S-28.15, migration 0119)', () => {
  const ROW = {
    task_id: TASK,
    head_sha: 'b'.repeat(40),
    outcome: 'merged',
    provider_status: null,
    merge_commit_sha: 'd'.repeat(40),
    plan_decision: 'approved_by_person',
    plan_approval_id: OWNER,
    change_digest: null,
    commit_count: null,
    rebased_to: null,
    attempted_at: AT,
    signal_passes: 0,
  };

  it('records an attempt once per (task, head, kind), the kind read off the outcome', async () => {
    const wrote = recording([{ task_id: TASK }]);
    expect(
      await store().tasks.recordMerge(wrote.tx, {
        taskId: TASK,
        headSha: 'b'.repeat(40),
        outcome: 'rebased',
        providerStatus: null,
        mergeCommitSha: null,
        planDecision: 'not_required',
        planApprovalId: null,
        changeDigest: 'a'.repeat(64),
        commitCount: 2,
        rebasedTo: null,
        attemptedAt: AT,
        signalPasses: 0,
      }),
    ).toBe(true);
    expect(wrote.calls[0]?.text).toContain("case when $3::text like 'rebase%' then 'rebase'");
    expect(wrote.calls[0]?.text).toContain('on conflict (task_id, head_sha, kind) do nothing');
    const lost = recording([]);
    expect(
      await store().tasks.recordMerge(lost.tx, {
        taskId: TASK,
        headSha: 'b'.repeat(40),
        outcome: 'merged',
        providerStatus: null,
        mergeCommitSha: null,
        planDecision: 'not_required',
        planApprovalId: null,
        changeDigest: null,
        commitCount: null,
        rebasedTo: null,
        attemptedAt: AT,
        signalPasses: 0,
      }),
    ).toBe(false);
  });

  it('maps a row for one head, the newest, and every attempt; and counts signal passes on a merge only', async () => {
    const one = recording([ROW]);
    expect(await store().tasks.mergeFor(one.tx, TASK, 'b'.repeat(40))).toMatchObject({
      outcome: 'merged',
      planDecision: 'approved_by_person',
      planApprovalId: OWNER,
      mergeCommitSha: 'd'.repeat(40),
    });
    expect(one.calls[0]?.text).toContain("order by (kind = 'merge') desc limit 1");
    expect(await store().tasks.mergeFor(recording([]).tx, TASK, 'c'.repeat(40))).toBeNull();
    expect((await store().tasks.latestMerge(recording([ROW]).tx, TASK))?.headSha).toBe(
      'b'.repeat(40),
    );
    expect(await store().tasks.latestMerge(recording([]).tx, TASK)).toBeNull();
    expect(await store().tasks.mergesOf(recording([ROW, ROW]).tx, TASK)).toHaveLength(2);
    const passes = recording([{ signal_passes: 2 }]);
    expect(await store().tasks.countMergeSignalPass(passes.tx, TASK, 'b'.repeat(40))).toBe(2);
    expect(passes.calls[0]?.text).toContain("outcome = 'merged'");
    expect(await store().tasks.countMergeSignalPass(recording([]).tx, TASK, 'b'.repeat(40))).toBe(
      0,
    );
  });

  it('settles only a rebase row still in flight', async () => {
    const settled = recording([], 1);
    expect(
      await store().tasks.settleRebase(settled.tx, TASK, 'b'.repeat(40), {
        outcome: 'rebase_changed',
        providerStatus: 'digest_changed',
        rebasedTo: 'c'.repeat(40),
      }),
    ).toBe(true);
    expect(settled.calls[0]?.text).toContain("kind = 'rebase' and outcome = 'rebased'");
    expect(
      await store().tasks.settleRebase(recording([], 0).tx, TASK, 'b'.repeat(40), {
        outcome: 'rebase_conflict',
        providerStatus: null,
        rebasedTo: null,
      }),
    ).toBe(false);
  });

  it('upserts and reads who merges and what the platform waited for', async () => {
    const write = recording([], 1);
    await store().tasks.recordMergeDecision(write.tx, TASK, {
      mergeBy: 'platform',
      wait: 'person_words',
    });
    expect(write.calls[0]?.values).toEqual([TASK, 'platform', 'person_words']);
    expect(
      await store().tasks.mergeDecisionOf(
        recording([{ merge_by: 'person', merge_wait: 'setting_person' }]).tx,
        TASK,
      ),
    ).toEqual({ mergeBy: 'person', wait: 'setting_person' });
    expect(await store().tasks.mergeDecisionOf(recording([]).tx, TASK)).toBeNull();
  });
});
