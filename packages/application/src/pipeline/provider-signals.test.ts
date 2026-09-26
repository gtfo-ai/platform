/**
 * The two provider signals the pipeline writes down (WP-60): `ticket.updated` →
 * `tasks.ticket_signal_at`, and `mr.updated` → `tasks.mr_ref.head_sha`.
 *
 * Driven through the composed runtime (`createPipelineHarness`), so the handlers are the ones
 * `createPipelineRuntime` registers and the bus is the real one. The end-to-end halves — the stage
 * that re-reads the ticket, the gate that reads the diff again — are in `saga.test.ts` and
 * `conflict-warning.test.ts`; this file is the handlers' own edges.
 */
import type { DomainEvent, Id, IsoDateTime, TaskState } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { INITIAL_TASK_VERSION, type StoredTask } from './store.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const LIVE = '00000000-0000-4000-8000-0000000000c1' as Id;
const DONE = '00000000-0000-4000-8000-0000000000c2' as Id;
const OTHER = '00000000-0000-4000-8000-0000000000c3' as Id;
const PROVIDER = 'fake-jira';
const HEAD = 'a'.repeat(40);

let sequence = 0;

const stored = (
  id: Id,
  key: string,
  state: TaskState,
  options: { readonly mode?: 'normal' | 'shadow'; readonly iid?: number | null } = {},
): StoredTask => ({
  task: {
    id,
    projectId: PROJECT,
    ticket: { provider: PROVIDER, key, url: `https://jira.example.test/browse/${key}` },
    template: 'feature',
    mode: options.mode ?? 'normal',
    state,
    currentStage: state === 'done' ? null : 'implementation',
    stageAttempts: {},
    iterationCounters: {},
    limits: {
      code_review: 3,
      business_review: 2,
      ci_fix: 3,
      human_rounds: 3,
      refinement_questions: 2,
      architecture_revisions: 2,
      rebase: 2,
      rebase_rechecks: 10,
      dependency_policy: 2,
    },
    sequence: 1,
  },
  template: { stages: [{ id: 'intake', kind: 'system' }] },
  priorityRank: 3,
  createdAt: '2026-06-01T08:00:00.000Z' as IsoDateTime,
  branch: 'agentic/acme-1',
  mr:
    options.iid === null || options.iid === undefined
      ? null
      : {
          provider: 'fake-git',
          project_path: 'acme/api',
          iid: options.iid,
          url: `https://git.example.test/acme/api/-/merge_requests/${options.iid}`,
          branch: 'agentic/acme-1',
          head_sha: HEAD,
        },
  workpad: null,
  costActualUsd: 0,
  estimateUsd: null,
  estimateBasis: null,
  estimateSamples: null,
  ticketSnapshot: null,
  ticketSnapshotAt: null,
  ticketSignalAt: null,
  reviewSubject: null,
  historySample: null,
  riskClasses: [],
  coverage: null,
  dependencies: null,
  requiredReviewers: null,
  requestedByUserId: null,
  version: INITIAL_TASK_VERSION,
});

const signal = <T extends 'ticket.updated' | 'mr.updated'>(
  type: T,
  occurredAt: string,
  payload: Extract<DomainEvent, { type: T }>['payload'],
): DomainEvent => {
  sequence += 1;
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${sequence.toString(16).padStart(12, '0')}`,
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: sequence,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'test' },
    occurred_at: occurredAt,
    type,
    payload,
  }) as DomainEvent;
};

const edited = (key: string, occurredAt: string, provider = PROVIDER): DomainEvent =>
  signal('ticket.updated', occurredAt, {
    project_id: PROJECT,
    ticket: { provider, key, url: `https://jira.example.test/browse/${key}` },
    updated_at: occurredAt,
    changed_fields: ['description'],
    truncated: false,
  });

const pushed = (
  iid: number,
  headSha: string,
  updatedAt: string | null = '2026-06-01T09:30:00.000Z',
): DomainEvent =>
  signal('mr.updated', '2026-06-01T09:30:00.000Z', {
    project_id: PROJECT,
    task_id: null,
    mr: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid,
      url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
      branch: 'agentic/acme-1',
      head_sha: headSha,
    },
    draft: false,
    head_sha: headSha,
    updated_at: updatedAt,
  });

const harnessWith = async (rows: readonly StoredTask[]): Promise<PipelineHarness> => {
  sequence = 0;
  const harness = createPipelineHarness({ projectId: PROJECT, runs: {} });
  await harness.memory.transaction(async (scope) => {
    for (const row of rows) {
      await harness.store.tasks.insert(scope.tx, row);
    }
  });
  return harness;
};

const row = (harness: PipelineHarness, id: Id): StoredTask => {
  const found = harness.store.snapshot().find((entry) => entry.task.id === id);
  if (found === undefined) {
    throw new Error(`no task ${id}`);
  }
  return found;
};

describe('ticket.updated marks the live tasks of its ticket (Q61 (b))', () => {
  it('stamps the receipt time on a live task of the ticket, and on nothing else', async () => {
    const harness = await harnessWith([
      stored(LIVE, 'ACME-1', 'active'),
      stored(DONE, 'ACME-1', 'done', { mode: 'shadow' }),
      stored(OTHER, 'ACME-2', 'active'),
    ]);
    await harness.publish([edited('ACME-1', '2026-06-01T09:05:00.000Z')]);

    expect(row(harness, LIVE).ticketSignalAt).toBe('2026-06-01T09:05:00.000Z');
    // A finished task's prompt is never built again; another ticket's edit is not this one's.
    expect(row(harness, DONE).ticketSignalAt).toBeNull();
    expect(row(harness, OTHER).ticketSignalAt).toBeNull();
    // A different provider's ticket with the same key is a different ticket.
    await harness.publish([edited('ACME-2', '2026-06-01T09:06:00.000Z', 'other-tracker')]);
    expect(row(harness, OTHER).ticketSignalAt).toBeNull();
  });

  it('never moves the signal backwards, so a late redelivery cannot make a stale snapshot fresh', async () => {
    const harness = await harnessWith([stored(LIVE, 'ACME-1', 'active')]);
    await harness.publish([edited('ACME-1', '2026-06-01T09:10:00.000Z')]);
    await harness.publish([edited('ACME-1', '2026-06-01T09:05:00.000Z')]);
    expect(row(harness, LIVE).ticketSignalAt).toBe('2026-06-01T09:10:00.000Z');
    await harness.publish([edited('ACME-1', '2026-06-01T09:20:00.000Z')]);
    expect(row(harness, LIVE).ticketSignalAt).toBe('2026-06-01T09:20:00.000Z');
  });

  it('moves no aggregate column and no version, because `save` does not own the signal', async () => {
    const harness = await harnessWith([stored(LIVE, 'ACME-1', 'active')]);
    const before = row(harness, LIVE);
    await harness.publish([edited('ACME-1', '2026-06-01T09:05:00.000Z')]);
    const after = row(harness, LIVE);
    expect(after.version).toBe(before.version);
    expect({ ...after, ticketSignalAt: null }).toEqual(before);
  });

  it('settles a signal for a ticket no task has, rather than failing the dispatch', async () => {
    const harness = await harnessWith([]);
    await harness.publish([edited('ACME-404', '2026-06-01T09:05:00.000Z')]);
    expect(harness.store.snapshot()).toEqual([]);
  });
});

describe('mr.updated moves the recorded head (PROGRESS backlog 182)', () => {
  it('moves the head of the task that owns the merge request, and bumps its version', async () => {
    const harness = await harnessWith([
      stored(LIVE, 'ACME-1', 'active', { iid: 7 }),
      stored(OTHER, 'ACME-2', 'active', { iid: 9 }),
    ]);
    const before = row(harness, LIVE);
    await harness.publish([pushed(7, 'e'.repeat(40))]);

    const after = row(harness, LIVE);
    expect(after.mr?.head_sha).toBe('e'.repeat(40));
    // Only the head: the rest of the reference is what the row held (`jsonb_set`, one key).
    expect({ ...after.mr, head_sha: HEAD }).toEqual(before.mr);
    // The token moved, so a `save` over a snapshot read before this is refused (rule 79).
    expect(after.version).toBe(before.version + 1);
    expect(row(harness, OTHER).mr?.head_sha).toBe(HEAD);
  });

  it('refuses a stale whole-row save after it, instead of letting the old head back', async () => {
    const harness = await harnessWith([stored(LIVE, 'ACME-1', 'active', { iid: 7 })]);
    const stale = row(harness, LIVE);
    await harness.publish([pushed(7, 'e'.repeat(40))]);
    await expect(
      harness.memory.transaction(async (scope) => harness.store.tasks.save(scope.tx, stale)),
    ).rejects.toThrow(/modified concurrently/);
    expect(row(harness, LIVE).mr?.head_sha).toBe('e'.repeat(40));
  });

  it('moves nothing for the revision already recorded, a merge request no task owns, or a done task', async () => {
    const harness = await harnessWith([
      stored(LIVE, 'ACME-1', 'active', { iid: 7 }),
      stored(DONE, 'ACME-3', 'done', { iid: 11 }),
    ]);
    const live = row(harness, LIVE);
    const done = row(harness, DONE);
    await harness.publish([
      pushed(7, HEAD),
      pushed(42, 'f'.repeat(40)),
      pushed(11, 'f'.repeat(40)),
    ]);
    expect(row(harness, LIVE)).toEqual(live);
    expect(row(harness, DONE)).toEqual(done);
  });

  /**
   * Review round 1, the reviewer's measurement reproduced through the bus: `c…` then a late `b…`.
   * The CI gate asks the pipeline status of this head, so moving it back would pass CI on a green
   * pipeline for a commit that is no longer the branch's.
   */
  it('never moves the head back for a delivery stamped earlier, or for one with no instant', async () => {
    const harness = await harnessWith([stored(LIVE, 'ACME-1', 'active', { iid: 7 })]);
    await harness.publish([pushed(7, 'c'.repeat(40), '2026-06-01T09:20:00.000Z')]);
    await harness.publish([pushed(7, 'b'.repeat(40), '2026-06-01T09:10:00.000Z')]);
    expect(row(harness, LIVE).mr?.head_sha).toBe('c'.repeat(40));
    await harness.publish([pushed(7, 'd'.repeat(40), null)]);
    expect(row(harness, LIVE).mr?.head_sha).toBe('c'.repeat(40));
    await harness.publish([pushed(7, 'e'.repeat(40), '2026-06-01T09:21:00.000Z')]);
    expect(row(harness, LIVE).mr?.head_sha).toBe('e'.repeat(40));
  });
});
