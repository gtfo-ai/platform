import { WORKER_IDLE_REASONS, workerIdleReasonSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WIP_LIMITS } from './wip.js';
import { type ServedProject, type WorkerIdleFacts, workerIdleReasonOf } from './worker-idle.js';

const AUT = '00000000-0000-4000-8000-0000000000a1';
const OPS = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';

/** A project with `inPipeline` tasks waiting for a person and `queued` it would take. */
const project = (
  key: string,
  id: string,
  patch: { readonly waiting?: number; readonly active?: number; readonly queued?: number } = {},
  bounded: ServedProject['bounded'] = [],
): ServedProject => ({
  projectId: id,
  projectKey: key,
  states: [
    { state: 'active', count: patch.active ?? 0, takes: patch.active ?? 0 },
    { state: 'waiting_approval', count: patch.waiting ?? 0, takes: patch.waiting ?? 0 },
    { state: 'queued', count: patch.queued ?? 0, takes: patch.queued ?? 0 },
  ],
  limits: DEFAULT_WIP_LIMITS,
  bounded,
});

/** A ready machine with a free place, nothing open, nothing queued: `nothing_queued`. */
const idle: WorkerIdleFacts = {
  blocked: false,
  running: 0,
  concurrency: 2,
  takeableOffers: 0,
  policySkippedOffers: 0,
  claimPolicy: 'mine_and_unassigned',
  projects: [project('AUT', AUT)],
};

describe('why a ready machine runs nothing — one cause, in a stated precedence (S-28.6)', () => {
  it('says nothing while a blocker stands: the blocker’s words win', () => {
    expect(workerIdleReasonOf({ ...idle, blocked: true, running: 2 })).toBeNull();
    expect(workerIdleReasonOf({ ...idle, blocked: true })).toBeNull();
  });

  it('slots_busy: every place is taken — before anything waiting is asked', () => {
    expect(workerIdleReasonOf({ ...idle, running: 2, takeableOffers: 3 })).toEqual({
      kind: 'slots_busy',
      running: 2,
      concurrency: 2,
    });
    // One place free is not busy.
    expect(workerIdleReasonOf({ ...idle, running: 1 })?.kind).toBe('nothing_queued');
  });

  it('says nothing when an offer its claim would take is open: it takes it next', () => {
    expect(
      workerIdleReasonOf({
        ...idle,
        takeableOffers: 1,
        policySkippedOffers: 4,
        projects: [project('AUT', AUT, { waiting: 5, queued: 3 })],
      }),
    ).toBeNull();
  });

  it('says nothing when a queued task it would take is admitted: the scheduler starts it', () => {
    expect(
      workerIdleReasonOf({
        ...idle,
        projects: [
          project('AUT', AUT, { waiting: 5, queued: 1 }),
          project('OPS', OPS, { queued: 1 }),
        ],
      }),
    ).toBeNull();
  });

  it('owner_limit: the person’s own limit holds their queued tasks — before a full project', () => {
    const reason = workerIdleReasonOf({
      ...idle,
      projects: [project('AUT', AUT, { waiting: 5, queued: 2 })],
      ownerLimit: {
        userId: USER,
        name: 'Jan',
        count: 3,
        limit: 3,
        queued: 2,
        holders: [{ taskId: TASK, ticketKey: 'AUT-1' }],
      },
      ownerHeldByProject: new Map([[AUT, 2]]),
    });
    expect(reason).toEqual({
      kind: 'owner_limit',
      owner: { user_id: USER, name: 'Jan' },
      count: 3,
      limit: 3,
      queued: 2,
      holders: [{ task_id: TASK, ticket_key: 'AUT-1' }],
    });
  });

  it('project_limit: a full project with tasks it would take queued, the one with most first', () => {
    expect(
      workerIdleReasonOf({
        ...idle,
        policySkippedOffers: 3,
        claimPolicy: 'mine',
        projects: [
          project('OPS', OPS, { waiting: 5, queued: 1 }),
          project('AUT', AUT, { waiting: 5, queued: 4 }, ['pipeline.wip.max_tasks_in_pipeline']),
        ],
      }),
    ).toEqual({
      kind: 'project_limit',
      project_id: AUT,
      project_key: 'AUT',
      limit_kind: 'max_tasks_in_pipeline',
      count: 5,
      limit: 5,
      queued: 4,
      organisation_bound: true,
    });
    // The parallel limit is named as such.
    expect(
      workerIdleReasonOf({ ...idle, projects: [project('AUT', AUT, { active: 2, queued: 1 })] }),
    ).toMatchObject({
      kind: 'project_limit',
      limit_kind: 'max_parallel_tasks',
      count: 2,
      limit: 2,
    });
  });

  it('a project whose queued tasks are all held by the person’s limit is not the cause', () => {
    expect(
      workerIdleReasonOf({
        ...idle,
        projects: [project('AUT', AUT, { waiting: 5, queued: 2 })],
        ownerHeldByProject: new Map([[AUT, 2]]),
      })?.kind,
    ).toBe('nothing_queued');
  });

  it('policy_skips: waiting runs its policy leaves for others, only for a policy that leaves any', () => {
    expect(workerIdleReasonOf({ ...idle, policySkippedOffers: 3, claimPolicy: 'mine' })).toEqual({
      kind: 'policy_skips',
      skipped: 3,
      claim_policy: 'mine',
    });
    expect(
      workerIdleReasonOf({ ...idle, policySkippedOffers: 3, claimPolicy: 'everything' })?.kind,
    ).toBe('nothing_queued');
  });

  it('nothing_queued: nothing above holds', () => {
    expect(workerIdleReasonOf(idle)).toEqual({ kind: 'nothing_queued' });
    expect(workerIdleReasonOf({ ...idle, projects: [] })).toEqual({ kind: 'nothing_queued' });
  });

  it('every answer is the wire’s, and the vocabulary is the precedence', () => {
    const answers = [
      workerIdleReasonOf({ ...idle, running: 2 }),
      workerIdleReasonOf({ ...idle, projects: [project('AUT', AUT, { waiting: 5, queued: 1 })] }),
      workerIdleReasonOf({ ...idle, policySkippedOffers: 1 }),
      workerIdleReasonOf(idle),
    ];
    for (const answer of answers) {
      expect(workerIdleReasonSchema.safeParse(answer).success).toBe(true);
    }
    expect(WORKER_IDLE_REASONS).toEqual([
      'slots_busy',
      'owner_limit',
      'project_limit',
      'policy_skips',
      'nothing_queued',
    ]);
  });
});
