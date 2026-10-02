/**
 * The merge-request poller (WP-110, PROGRESS backlog 297) — everything the application ring
 * decides: which transition a listing is given what the log holds, the window a poll asks for, the
 * key a listing is deduplicated on, the redaction before any of it, where the cursor moves, and
 * which job re-arms which.
 *
 * The SQL half — `listPolling` over git bindings, the forward-only `mr_poll_cursor` and the
 * PostgreSQL lifecycle read — is asserted against PostgreSQL in
 * `test/integration/pipeline/mr-poll.integration.test.ts`, with a webhook of the same merge request
 * through the real ingress; the whole path — a review started by a poll, a task finished by a polled
 * merge — in `test/e2e/pipeline/mr-poll.e2e.test.ts`.
 */
import type { DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import {
  createStreamMergeRequestLifecycle,
  type MergeRequestLifecycleEvent,
} from '../integrations/merge-request-lifecycle.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type {
  Discussion,
  GitProviderPort,
  MergeRequestListing,
  MergeRequestPollPlan,
} from '../ports/integrations/git-provider.js';
import type { InboxDelivery, InboxStore } from '../ports/integrations/inbox.js';
import type { EnqueueRequest, JobContext, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import { type PipelineIntegrations, staticPipelineIntegrations } from './integrations.js';
import {
  type MergeRequestPollerOptions,
  type MergeRequestPollStore,
  MR_POLL_REVIEW_TASKS_LIMIT,
  MR_POLL_SWEEP_KEY,
  mergeRequestPollHandler,
  mrPollKey,
  polledMergeRequestDrafts,
  pollMergeRequestBinding,
  REVIEW_NOTE_SKEW_MS,
  type ReadyMergeRequest,
} from './mr-poll.js';
import type { PolledBinding } from './ticket-poll.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000000a1' as Id;
const NOW = '2026-06-01T10:00:00.000Z' as IsoDateTime;
/** Obviously fake, and what every redaction assertion looks for. */
const PLANTED = 'FAKE-PLANTED-gitlab-token-0123456789';
const BINDING: PolledBinding = { projectId: PROJECT, integrationId: INTEGRATION };
/** Poll-only, as a GitLab binding with neither webhook secret is (WP-123). */
const PLAN: MergeRequestPollPlan = { interval_seconds: 60, receives_webhooks: false };
const HEAD = 'a'.repeat(40);
/** WP-123: three heads of the default branch. */
const SHA_A = '1'.repeat(40);
const SHA_B = '2'.repeat(40);
const SHA_C = '3'.repeat(40);

const listing = (
  iid: number,
  state: MergeRequestListing['state'],
  at: {
    readonly created: string;
    readonly updated: string;
    readonly merged?: string;
    readonly closed?: string;
  },
  overrides: Partial<MergeRequestListing> = {},
): MergeRequestListing => ({
  ref: {
    provider: 'gitlab',
    project_path: 'acme/api',
    iid,
    url: `https://gitlab.example.test/acme/api/-/merge_requests/${iid}`,
    branch: `feature/${iid}`,
    head_sha: HEAD,
  },
  state,
  draft: false,
  head_sha: HEAD,
  created_at: at.created,
  updated_at: at.updated,
  merged_at: at.merged ?? null,
  closed_at: at.closed ?? null,
  merge_commit_sha: state === 'merged' ? 'c'.repeat(40) : null,
  ...overrides,
});

/** A lifecycle event the log already holds — a webhook's, recorded at `at`. */
const lifecycleEvent = (type: string, iid: number, at: string): DomainEvent =>
  ({
    type,
    stream_id: PROJECT,
    occurred_at: at,
    payload: {
      project_id: PROJECT,
      mr: {
        provider: 'gitlab',
        project_path: 'acme/api',
        iid,
        url: `https://gitlab.example.test/acme/api/-/merge_requests/${iid}`,
      },
    },
  }) as unknown as DomainEvent;

interface World {
  listings: MergeRequestListing[];
  plan: MergeRequestPollPlan | null;
  asked: { updatedAfter: string; limit: number }[];
  failNext: Error | null;
  /**
   * What the provider says of a merge request **now**, when the poller reads it again (review round
   * 2) — by iid; absent means the state of its newest listing.
   */
  current: Map<number, MergeRequestListing['state']>;
  /** Every iid the poller read again. */
  reread: number[];
  /** Thrown by the next re-read, then cleared (review round 3). */
  rereadFails: Error | null;
  /** WP-123: the default branch as the provider says it is now, and how often it was read. */
  head: { branch: string; sha: string };
  headReads: number;
  /** Thrown by the next head read, then cleared. */
  headFails: Error | null;
  /** WP-123: each merge request's threads, by iid, and every iid whose threads were read. */
  discussions: Map<number, Discussion[]>;
  discussionReads: number[];
  /** Thrown by the threads read of this iid, every time. */
  discussionFails: Map<number, Error>;
}

const portFor = (world: World): GitProviderPort =>
  ({
    ref: { integrationId: INTEGRATION, provider: 'gitlab', type: 'git', host: null },
    pollPlan: () => world.plan,
    listMergeRequests: (async (_project, options) => {
      world.asked.push({ updatedAfter: options.updatedAfter, limit: options.limit });
      if (world.failNext !== null) {
        const error = world.failNext;
        world.failNext = null;
        throw error;
      }
      return world.listings
        .filter((entry) => Date.parse(entry.updated_at) >= Date.parse(options.updatedAfter))
        .toSorted((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at))
        .slice(0, options.limit);
    }) satisfies GitProviderPort['listMergeRequests'],
    getMergeRequest: (async (ref: { readonly iid: number }) => {
      world.reread.push(ref.iid);
      if (world.rereadFails !== null) {
        const error = world.rereadFails;
        world.rereadFails = null;
        throw error;
      }
      const listed = world.listings.findLast((entry) => entry.ref.iid === ref.iid);
      return { state: world.current.get(ref.iid) ?? listed?.state ?? 'opened' };
    }) as unknown as GitProviderPort['getMergeRequest'],
    getDefaultBranchHead: (async () => {
      world.headReads += 1;
      if (world.headFails !== null) {
        const error = world.headFails;
        world.headFails = null;
        throw error;
      }
      return { ...world.head };
    }) satisfies GitProviderPort['getDefaultBranchHead'],
    listDiscussions: (async (ref) => {
      world.discussionReads.push(ref.iid);
      const failure = world.discussionFails.get(ref.iid);
      if (failure !== undefined) {
        throw failure;
      }
      return world.discussions.get(ref.iid) ?? [];
    }) satisfies GitProviderPort['listDiscussions'],
  }) as unknown as GitProviderPort;

const integrationsFor = (world: World, integrationId: Id = INTEGRATION): PipelineIntegrations => {
  const redactor = exactSecretRedactor([{ name: 'gitlab_token', value: PLANTED }]);
  return {
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor,
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => NOW },
    }),
    git: {
      port: portFor(world),
      ref: { integrationId, provider: 'gitlab', type: 'git', host: null },
      project: 'acme/api',
      redactor,
    },
    communication: null,
    taskManagement: null,
  };
};

interface Harness {
  readonly options: MergeRequestPollerOptions;
  readonly world: World;
  readonly rows: Map<string, InboxDelivery>;
  readonly events: DomainEvent[];
  readonly cursor: { value: IsoDateTime | null };
  readonly enqueued: EnqueueRequest[];
  /** Fail `inbox.record` once this many rows exist; `null` never fails (review round 1). */
  readonly recordFailure: { after: number | null };
  /**
   * Runs once, right after the poller's own lifecycle read returns — the moment a webhook's record
   * can land between the poller's pre-read and its record (review round 1).
   */
  readonly afterPollerRead: { run: (() => void) | null };
  /** WP-123: `bindings.mr_poll_default_head`, and a write that fails once when armed. */
  readonly defaultHead: { value: string | null; failNextWrite: boolean };
  /** WP-123: the tasks the store says wait at Ready, oldest entry first. */
  readonly ready: ReadyMergeRequest[];
  /** WP-123: the `limit` each `readyMergeRequests` call asked with. */
  readonly readyLimits: number[];
}

const harnessFor = (
  overrides: {
    readonly integrations?: (world: World) => PipelineIntegrations;
    readonly polling?: readonly PolledBinding[];
  } = {},
): Harness => {
  const world: World = {
    listings: [],
    plan: PLAN,
    asked: [],
    failNext: null,
    current: new Map(),
    reread: [],
    rereadFails: null,
    head: { branch: 'main', sha: SHA_A },
    headReads: 0,
    headFails: null,
    discussions: new Map(),
    discussionReads: [],
    discussionFails: new Map(),
  };
  const rows = new Map<string, InboxDelivery>();
  const events: DomainEvent[] = [];
  const cursor: { value: IsoDateTime | null } = { value: null };
  const enqueued: EnqueueRequest[] = [];
  const recordFailure: { after: number | null } = { after: null };
  const afterPollerRead: { run: (() => void) | null } = { run: null };
  const inbox: InboxStore = {
    find: async (provider, deliveryId) => rows.get(`${provider}\0${deliveryId}`) ?? null,
    record: async (_tx, delivery) => {
      if (recordFailure.after !== null && rows.size >= recordFailure.after) {
        throw new Error('the database went away mid-poll');
      }
      const key = `${delivery.provider}\0${delivery.deliveryId}`;
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, delivery);
      return true;
    },
  };
  const unitOfWork: UnitOfWork = {
    transaction: async (fn) =>
      fn({
        tx: {} as never,
        events: {
          append: async (appended: readonly DomainEvent[]) => {
            events.push(...appended);
            return [];
          },
        },
      } as unknown as TransactionScope),
  };
  const defaultHead: { value: string | null; failNextWrite: boolean } = {
    value: null,
    failNextWrite: false,
  };
  const ready: ReadyMergeRequest[] = [];
  const readyLimits: number[] = [];
  const store: MergeRequestPollStore = {
    listPolling: async () => overrides.polling ?? [BINDING],
    cursorOf: async () => cursor.value,
    advanceCursor: async (_binding, to) => {
      if (cursor.value === null || Date.parse(to) > Date.parse(cursor.value)) {
        cursor.value = to;
      }
    },
    defaultHeadOf: async () => defaultHead.value,
    recordDefaultHead: async (_binding, sha) => {
      if (defaultHead.failNextWrite) {
        defaultHead.failNextWrite = false;
        throw new Error('the database went away before the head was written');
      }
      defaultHead.value = sha;
    },
    readyMergeRequests: async (_binding, limit) => {
      readyLimits.push(limit);
      return ready.slice(0, limit);
    },
  };
  const jobs: Jobs = {
    defineQueue: async () => {},
    enqueue: async (request) => {
      enqueued.push(request as EnqueueRequest);
      return { status: 'enqueued', jobId: `j-${enqueued.length}` };
    },
    scheduleCron: async () => {},
    unscheduleCron: async () => {},
    listCronSchedules: async () => [],
    work: async (request): Promise<JobWorker> => ({ queue: request.queue, stop: async () => {} }),
  };
  let nextId = 0;
  const options: MergeRequestPollerOptions = {
    jobs,
    store,
    integrations: staticPipelineIntegrations(
      (overrides.integrations ?? ((w) => integrationsFor(w)))(world),
    ),
    recorder: {
      inbox,
      unitOfWork,
      eventStore: { nextStreamSequence: async () => events.length + 1 },
      // The production reader over this harness's own log, so the dedup is the real one. Its
      // first call is the poller's pre-read (the recorder's own read follows it).
      mergeRequests: {
        latest: async (key) => {
          const answer = await createStreamMergeRequestLifecycle({
            readStream: async () =>
              events.map((event, index) => ({
                position: index + 1,
                causeEventPosition: null,
                event,
              })),
          }).latest(key);
          const run = afterPollerRead.run;
          afterPollerRead.run = null;
          run?.();
          return answer;
        },
      },
      ids: {
        next: () => {
          nextId += 1;
          return `00000000-0000-4000-9000-${String(nextId).padStart(12, '0')}` as Id;
        },
      },
      clock: { now: () => NOW },
    },
    clock: { now: () => NOW },
    sweepIntervalMs: 60_000,
  };
  return {
    options,
    world,
    rows,
    events,
    cursor,
    enqueued,
    recordFailure,
    afterPollerRead,
    defaultHead,
    ready,
    readyLimits,
  };
};

const context = (data: unknown): JobContext =>
  ({
    id: 'j',
    queue: JOB_QUEUES.mrPoll,
    data,
    signal: new AbortController().signal,
  }) as JobContext;

describe('what a listed merge request is, given what the log holds (WP-110)', () => {
  const WINDOW_START = Date.parse('2026-06-01T09:00:00.000Z');
  const BEFORE = '2026-05-01T09:00:00.000Z';
  const INSIDE = '2026-06-01T09:30:00.000Z';
  const drafts = (entry: MergeRequestListing, latest: MergeRequestLifecycleEvent | null) =>
    polledMergeRequestDrafts(
      {
        projectId: PROJECT,
        integrationId: INTEGRATION,
        git: {
          project: 'acme/api',
          ref: { integrationId: INTEGRATION, provider: 'gitlab', type: 'git', host: null },
        },
        windowStartMs: WINDOW_START,
      },
      entry,
      HEAD,
      latest,
    ).map((draft) => draft.type);

  const table: readonly [
    string,
    MergeRequestListing,
    MergeRequestLifecycleEvent | null,
    string[],
  ][] = [
    [
      'opened inside the window, unknown to the log',
      listing(1, 'opened', { created: INSIDE, updated: INSIDE }),
      null,
      ['mr.opened', 'mr.updated'],
    ],
    [
      'opened long ago and touched now, unknown to the log — an update, never a new open',
      listing(1, 'opened', { created: BEFORE, updated: INSIDE }),
      null,
      ['mr.updated'],
    ],
    [
      'open again after the log’s close — a reopen',
      listing(1, 'opened', { created: BEFORE, updated: INSIDE }),
      'mr.closed',
      ['mr.opened', 'mr.updated'],
    ],
    [
      'open, and the log already says so',
      listing(1, 'opened', { created: INSIDE, updated: INSIDE }),
      'mr.opened',
      ['mr.updated'],
    ],
    [
      'merged inside the window, unknown to the log',
      listing(1, 'merged', { created: BEFORE, updated: INSIDE, merged: INSIDE }),
      null,
      ['mr.merged'],
    ],
    [
      'merged long ago and touched now, unknown to the log',
      listing(1, 'merged', { created: BEFORE, updated: INSIDE, merged: BEFORE }),
      null,
      [],
    ],
    [
      'merged while the log still says open, whenever it was',
      listing(1, 'merged', { created: BEFORE, updated: INSIDE, merged: BEFORE }),
      'mr.opened',
      ['mr.merged'],
    ],
    [
      'merged, and the log already says so',
      listing(1, 'merged', { created: BEFORE, updated: INSIDE, merged: INSIDE }),
      'mr.merged',
      [],
    ],
    [
      'merged with no instant, unknown to the log — never invented',
      listing(1, 'merged', { created: BEFORE, updated: INSIDE }),
      null,
      [],
    ],
    [
      'closed while the log says open',
      listing(1, 'closed', { created: BEFORE, updated: INSIDE, closed: BEFORE }),
      'mr.opened',
      ['mr.closed'],
    ],
    [
      'closed inside the window, unknown to the log',
      listing(1, 'closed', { created: BEFORE, updated: INSIDE, closed: INSIDE }),
      null,
      ['mr.closed'],
    ],
    [
      'closed, and the log already says so',
      listing(1, 'closed', { created: BEFORE, updated: INSIDE, closed: INSIDE }),
      'mr.closed',
      [],
    ],
    [
      'locked — GitLab mid-merge',
      listing(1, 'locked', { created: BEFORE, updated: INSIDE }),
      'mr.opened',
      [],
    ],
  ];
  it.each(table)('%s', (_name, entry, latest, expected) => {
    expect(drafts(entry, latest)).toEqual(expected);
  });

  it('carries the provider’s instant on the update and the merge commit on the merge', () => {
    const [opened, updated] = polledMergeRequestDrafts(
      {
        projectId: PROJECT,
        integrationId: INTEGRATION,
        git: {
          project: 'acme/api',
          ref: { integrationId: INTEGRATION, provider: 'gitlab', type: 'git', host: null },
        },
        windowStartMs: WINDOW_START,
      },
      listing(7, 'opened', { created: INSIDE, updated: INSIDE }),
      HEAD,
      null,
    );
    expect(opened?.payload).toMatchObject({
      project_id: PROJECT,
      task_id: null,
      mr: { provider: 'gitlab', project_path: 'acme/api', iid: 7, head_sha: HEAD },
      head_sha: HEAD,
      diff_stats: null,
    });
    expect(updated?.payload).toMatchObject({ updated_at: INSIDE });
    expect(opened?.actor).toEqual({
      kind: 'integration',
      integration_id: INTEGRATION,
      provider: 'gitlab',
    });
  });
});

describe('a poll of one git binding', () => {
  it('records a new merge request as mr.opened and mr.updated, on an inbox row keyed by its state', async () => {
    const harness = harnessFor();
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({ kind: 'polled', listed: 1, recorded: 1, duplicates: 0 });
    expect(harness.events.map((event) => event.type)).toEqual(['mr.opened', 'mr.updated']);
    expect(harness.events.every((event) => event.stream_id === PROJECT)).toBe(true);
    expect([...harness.rows.values()].map((row) => row.deliveryId)).toEqual([
      `gitlab:poll:${PROJECT}:acme/api!7@2026-06-01T09:59:30.000Z`,
    ]);
    expect([...harness.rows.values()][0]).toMatchObject({
      integrationId: INTEGRATION,
      verified: true,
      headers: {},
      payload: { source: 'poll' },
    });
    expect(harness.cursor.value).toBe('2026-06-01T09:59:30.000Z');
  });

  it('appends nothing on a second poll of an untouched merge request — the inbox key collides', async () => {
    const harness = harnessFor();
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];
    await pollMergeRequestBinding(harness.options, BINDING);
    const before = harness.events.length;

    const second = await pollMergeRequestBinding(harness.options, BINDING);

    expect(second).toMatchObject({ kind: 'polled', listed: 1, recorded: 0, duplicates: 1 });
    expect(harness.events).toHaveLength(before);
    expect(harness.rows.size).toBe(1);
  });

  it('turns a later merge into one mr.merged, and a merge the webhook already reported into none', async () => {
    const harness = harnessFor();
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];
    await pollMergeRequestBinding(harness.options, BINDING);
    harness.world.listings = [
      listing(7, 'merged', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T10:02:00.000Z',
        merged: '2026-06-01T10:02:00.000Z',
      }),
    ];
    await pollMergeRequestBinding(harness.options, BINDING);
    expect(harness.events.map((event) => event.type)).toEqual([
      'mr.opened',
      'mr.updated',
      'mr.merged',
    ]);

    // A comment on the merged merge request moves its `updated_at`: a new key, and nothing new.
    harness.world.listings = [
      listing(7, 'merged', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T10:04:00.000Z',
        merged: '2026-06-01T10:02:00.000Z',
      }),
    ];
    const third = await pollMergeRequestBinding(harness.options, BINDING);
    expect(third).toMatchObject({ unchanged: 1, recorded: 0 });
    expect(harness.events.map((event) => event.type)).toEqual([
      'mr.opened',
      'mr.updated',
      'mr.merged',
    ]);
  });

  it('does not move the cursor when recording a listing fails part-way (review round 1)', async () => {
    const harness = harnessFor();
    harness.world.listings = [
      listing(6, 'opened', {
        created: '2026-06-01T09:59:00.000Z',
        updated: '2026-06-01T09:59:00.000Z',
      }),
      listing(7, 'opened', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];
    harness.recordFailure.after = 1;

    await expect(pollMergeRequestBinding(harness.options, BINDING)).rejects.toThrow(
      'the database went away',
    );
    expect(harness.rows.size).toBe(1);
    expect(harness.cursor.value).toBeNull();

    // The retry re-reads the same window: the first listing collides on its key, the second lands.
    harness.recordFailure.after = null;
    const retry = await pollMergeRequestBinding(harness.options, BINDING);
    expect(retry).toMatchObject({ recorded: 1, duplicates: 1 });
    expect(harness.cursor.value).toBe('2026-06-01T09:59:30.000Z');
  });

  it('records nothing for a listing the log has overtaken — no reopen of a closed merge request (review round 1)', async () => {
    const harness = harnessFor();
    // Listed as open; a webhook's close was recorded after the list, and GitLab now says closed.
    harness.events.push(lifecycleEvent('mr.opened', 7, '2026-06-01T09:59:20.000Z'));
    harness.events.push(lifecycleEvent('mr.closed', 7, '2026-06-01T09:59:45.000Z'));
    harness.world.current.set(7, 'closed');
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T09:59:00.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({ stale: 1, recorded: 0 });
    expect(harness.events.map((event) => event.type)).toEqual(['mr.opened', 'mr.closed']);
    expect(harness.rows.size).toBe(0);
  });

  it('records nothing for a closed listing the log’s later reopen has overtaken — no spurious close (review round 1)', async () => {
    const harness = harnessFor();
    harness.events.push(lifecycleEvent('mr.closed', 7, '2026-06-01T09:59:10.000Z'));
    harness.events.push(lifecycleEvent('mr.opened', 7, '2026-06-01T09:59:45.000Z'));
    harness.world.current.set(7, 'opened');
    harness.world.listings = [
      listing(7, 'closed', {
        created: '2026-06-01T09:00:00.000Z',
        updated: '2026-06-01T09:59:05.000Z',
        closed: '2026-06-01T09:59:05.000Z',
      }),
    ];

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({ stale: 1, recorded: 0 });
    expect(harness.events.map((event) => event.type)).toEqual(['mr.closed', 'mr.opened']);
  });

  it('records a merge GitLab stamped before the platform recorded the open, on a poll-only binding (review round 2)', async () => {
    // The reviewer's scenario: poll 1 records the open at 10:00:00 platform time; the merge
    // happened at 09:59:50 GitLab time (between the list and the record). Two clocks must not lose it.
    const harness = harnessFor();
    harness.events.push(lifecycleEvent('mr.opened', 7, '2026-06-01T10:00:00.000Z'));
    harness.world.listings = [
      listing(7, 'merged', {
        created: '2026-06-01T09:00:00.000Z',
        updated: '2026-06-01T09:59:50.000Z',
        merged: '2026-06-01T09:59:50.000Z',
      }),
    ];

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({ recorded: 1, stale: 0 });
    expect(harness.events.map((event) => event.type)).toEqual(['mr.opened', 'mr.merged']);
    expect(harness.world.reread).toEqual([7]);
  });

  it('fails the poll and keeps the cursor when the re-read fails, so a merge it could not confirm is listed again (review round 3)', async () => {
    // Swallowing the failure would count a true merge as stale and move the cursor past it: on a
    // poll-only binding that merge would never be recorded.
    const harness = harnessFor();
    harness.events.push(lifecycleEvent('mr.opened', 7, '2026-06-01T10:00:00.000Z'));
    harness.world.listings = [
      listing(7, 'merged', {
        created: '2026-06-01T09:00:00.000Z',
        updated: '2026-06-01T10:05:00.000Z',
        merged: '2026-06-01T10:05:00.000Z',
      }),
    ];
    harness.world.rereadFails = new Error('the provider answered 502');

    await expect(pollMergeRequestBinding(harness.options, BINDING)).rejects.toThrow('502');
    expect(harness.cursor.value).toBeNull();
    expect(harness.events.map((event) => event.type)).toEqual(['mr.opened']);

    // The next poll lists it again, the re-read answers, and the merge is recorded.
    await pollMergeRequestBinding(harness.options, BINDING);
    expect(harness.events.map((event) => event.type)).toEqual(['mr.opened', 'mr.merged']);
  });

  it('loses nothing when GitLab’s clock is a minute behind the platform’s (review round 2)', async () => {
    const harness = harnessFor();
    // The platform recorded the open at 10:00:00; GitLab stamps everything a minute early.
    harness.events.push(lifecycleEvent('mr.opened', 7, '2026-06-01T10:00:00.000Z'));
    harness.world.listings = [
      listing(7, 'closed', {
        created: '2026-06-01T08:59:00.000Z',
        updated: '2026-06-01T09:59:30.000Z',
        closed: '2026-06-01T09:59:30.000Z',
      }),
    ];

    await pollMergeRequestBinding(harness.options, BINDING);
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T08:59:00.000Z',
        updated: '2026-06-01T09:59:40.000Z',
      }),
    ];
    await pollMergeRequestBinding(harness.options, BINDING);

    expect(harness.events.map((event) => event.type)).toEqual([
      'mr.opened',
      'mr.closed',
      'mr.opened',
      'mr.updated',
    ]);
  });

  it('reads nothing again for a merge request the log has never heard of, or for an update alone (review round 2)', async () => {
    const harness = harnessFor();
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];
    await pollMergeRequestBinding(harness.options, BINDING);
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T10:03:00.000Z',
      }),
    ];
    await pollMergeRequestBinding(harness.options, BINDING);

    expect(harness.events.map((event) => event.type)).toEqual([
      'mr.opened',
      'mr.updated',
      'mr.updated',
    ]);
    expect(harness.world.reread).toEqual([]);
  });

  it('still records a reopen whose listing is newer than the log’s close (review round 1)', async () => {
    const harness = harnessFor();
    harness.events.push(lifecycleEvent('mr.closed', 7, '2026-06-01T09:59:10.000Z'));
    harness.world.listings = [
      listing(7, 'opened', {
        created: '2026-06-01T09:00:00.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];

    await pollMergeRequestBinding(harness.options, BINDING);

    expect(harness.events.map((event) => event.type)).toEqual([
      'mr.closed',
      'mr.opened',
      'mr.updated',
    ]);
  });

  it('appends one merge when a webhook’s merge lands between the poll’s pre-read and its record (review round 1)', async () => {
    const harness = harnessFor();
    harness.world.listings = [
      listing(7, 'merged', {
        created: '2026-06-01T09:00:00.000Z',
        updated: '2026-06-01T09:59:30.000Z',
        merged: '2026-06-01T09:59:30.000Z',
      }),
    ];
    // The poller has read the log (nothing) and drafted `mr.merged`; the webhook's record lands now.
    harness.afterPollerRead.run = () => {
      harness.events.push(lifecycleEvent('mr.merged', 7, '2026-06-01T09:59:40.000Z'));
    };

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    // The poll's delivery is recorded (its own key), and the recorder's own read drops the repeat.
    expect(report).toMatchObject({ recorded: 1 });
    expect(harness.events.filter((event) => event.type === 'mr.merged')).toHaveLength(1);
  });

  it('reads the last interval on a first poll and the cursor after that', async () => {
    const harness = harnessFor();
    await pollMergeRequestBinding(harness.options, BINDING);
    harness.cursor.value = '2026-06-01T09:30:00.000Z' as IsoDateTime;
    await pollMergeRequestBinding(harness.options, BINDING);

    expect(harness.world.asked).toEqual([
      // NOW minus the plan's 60 seconds, minus the overlap (TICKET_POLL_OVERLAP_MS, five minutes).
      { updatedAfter: '2026-06-01T09:54:00.000Z', limit: 50 },
      { updatedAfter: '2026-06-01T09:25:00.000Z', limit: 50 },
    ]);
  });

  it('redacts the listing before the key, the row and the events are built from it', async () => {
    const harness = harnessFor();
    const planted = listing(
      7,
      'opened',
      { created: '2026-06-01T09:59:30.000Z', updated: '2026-06-01T09:59:30.000Z' },
      {
        ref: {
          provider: 'gitlab',
          project_path: 'acme/api',
          iid: 7,
          url: 'https://gitlab.example.test/acme/api/-/merge_requests/7',
          branch: `feature/${PLANTED}`,
          head_sha: HEAD,
        },
      },
    );
    harness.world.listings = [planted];

    await pollMergeRequestBinding(harness.options, BINDING);

    const stored = JSON.stringify([...harness.rows.values()]);
    expect(stored).not.toContain(PLANTED);
    expect(JSON.stringify(harness.events)).not.toContain(PLANTED);
    expect(JSON.stringify(harness.events)).toContain('[REDACTED');
  });

  it('drops by name a listing with no head, and still records the rest (rule 20)', async () => {
    const harness = harnessFor();
    harness.world.listings = [
      listing(
        6,
        'opened',
        { created: '2026-06-01T09:59:00.000Z', updated: '2026-06-01T09:59:00.000Z' },
        { head_sha: null },
      ),
      listing(7, 'opened', {
        created: '2026-06-01T09:59:30.000Z',
        updated: '2026-06-01T09:59:30.000Z',
      }),
    ];

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({ listed: 2, recorded: 1, skipped: 1 });
    expect(
      harness.events.map((event) => (event.payload as { mr: { iid: number } }).mr.iid),
    ).toEqual([7, 7]);
    expect(harness.cursor.value).toBe('2026-06-01T09:59:30.000Z');
  });

  it('ends the chain for a binding that is gone, re-pointed, or no longer polls', async () => {
    const off = harnessFor();
    off.world.plan = null;
    expect(await pollMergeRequestBinding(off.options, BINDING)).toEqual({ kind: 'off' });

    const repointed = harnessFor({
      integrations: (world) => integrationsFor(world, '00000000-0000-4000-8000-00000000ffff' as Id),
    });
    expect(await pollMergeRequestBinding(repointed.options, BINDING)).toEqual({ kind: 'unbound' });

    const gone = harnessFor({
      integrations: (world) => ({ ...integrationsFor(world), git: null }),
    });
    expect(await pollMergeRequestBinding(gone.options, BINDING)).toEqual({ kind: 'unbound' });
    expect(gone.world.asked).toEqual([]);
  });
});

describe('a poll-only binding: the default branch (WP-123, backlog 373 (a))', () => {
  const movedEvents = (harness: Harness) =>
    harness.events.filter((event) => event.type === 'default_branch.moved');

  it('records nothing on the first read, then one default_branch.moved under the new head, and nothing for an unchanged head', async () => {
    const harness = harnessFor();

    const first = await pollMergeRequestBinding(harness.options, BINDING);
    expect(first).toMatchObject({ kind: 'polled', defaultBranch: 'first_read' });
    expect(harness.events).toEqual([]);
    expect(harness.defaultHead.value).toBe(SHA_A);

    harness.world.head = { branch: 'main', sha: SHA_B };
    const second = await pollMergeRequestBinding(harness.options, BINDING);
    expect(second).toMatchObject({ defaultBranch: 'moved' });
    expect(movedEvents(harness).map((event) => event.payload)).toEqual([
      { project_id: PROJECT, branch: 'main', new_head: SHA_B },
    ]);
    expect(movedEvents(harness)[0]?.actor).toEqual({
      kind: 'integration',
      integration_id: INTEGRATION,
      provider: 'gitlab',
    });
    expect([...harness.rows.values()].map((row) => row.deliveryId)).toEqual([
      `gitlab:poll:${PROJECT}:acme/api@default:${SHA_A}..${SHA_B}`,
    ]);
    expect([...harness.rows.values()][0]?.payload).toMatchObject({
      source: 'poll',
      default_branch: { branch: 'main', sha: SHA_B, previous: SHA_A },
    });
    expect(harness.defaultHead.value).toBe(SHA_B);

    const third = await pollMergeRequestBinding(harness.options, BINDING);
    expect(third).toMatchObject({ defaultBranch: 'unchanged' });
    expect(movedEvents(harness)).toHaveLength(1);
    expect(harness.world.headReads).toBe(3);
  });

  it('appends nothing twice when the poll that recorded a move died before writing the head', async () => {
    const harness = harnessFor();
    harness.defaultHead.value = SHA_A;
    harness.world.head = { branch: 'main', sha: SHA_B };
    harness.defaultHead.failNextWrite = true;

    await expect(pollMergeRequestBinding(harness.options, BINDING)).rejects.toThrow(
      'before the head was written',
    );
    expect(movedEvents(harness)).toHaveLength(1);
    expect(harness.defaultHead.value).toBe(SHA_A);

    const retry = await pollMergeRequestBinding(harness.options, BINDING);
    expect(retry).toMatchObject({ defaultBranch: 'duplicate' });
    expect(movedEvents(harness)).toHaveLength(1);
    expect(harness.defaultHead.value).toBe(SHA_B);
  });

  const moveThrough = async (harness: Harness, heads: readonly string[]) => {
    harness.defaultHead.value = SHA_A;
    for (const sha of heads) {
      harness.world.head = { branch: 'main', sha };
      await pollMergeRequestBinding(harness.options, BINDING);
    }
    return movedEvents(harness).map((event) => event.payload.new_head);
  };

  it('records a move back to a head the branch had before, because the key names both heads', async () => {
    // A → B → C → B: a key of the new head alone would collide on the second B.
    expect(await moveThrough(harnessFor(), [SHA_B, SHA_C, SHA_B])).toEqual([SHA_B, SHA_C, SHA_B]);
  });

  it('records nothing for a move that repeats an earlier pair of heads exactly — the stated residual', async () => {
    // A → B → A → B: the second A..B collides with the first on the inbox key. Reaching it needs the
    // default branch force-pushed back to an exact earlier commit twice, which the protected default
    // branch the platform requires (GitLab setup guide, step 4) forbids.
    expect(await moveThrough(harnessFor(), [SHA_B, SHA_A, SHA_B])).toEqual([SHA_B, SHA_A]);
  });

  it('fails open: a refused head read is a warn, the stored head stays, and the next poll records the move (rule 20)', async () => {
    const harness = harnessFor();
    harness.defaultHead.value = SHA_A;
    harness.world.head = { branch: 'main', sha: SHA_B };
    harness.world.headFails = new IntegrationError(
      'forbidden',
      'gitlab',
      'the token lost its scope',
    );

    const failed = await pollMergeRequestBinding(harness.options, BINDING);
    expect(failed).toMatchObject({ kind: 'polled', defaultBranch: 'failed' });
    expect(harness.defaultHead.value).toBe(SHA_A);
    expect(movedEvents(harness)).toEqual([]);

    const next = await pollMergeRequestBinding(harness.options, BINDING);
    expect(next).toMatchObject({ defaultBranch: 'moved' });
    expect(movedEvents(harness)).toHaveLength(1);
  });
});

describe('a poll-only binding: review notes on a task waiting at Ready (WP-123, backlog 373 (b))', () => {
  const ENTERED = '2026-06-01T09:00:00.000Z' as IsoDateTime;
  const at = (minutes: number): string =>
    new Date(Date.parse(ENTERED) + minutes * 60_000).toISOString();
  const waiting = (iid: number, taskSuffix: string): ReadyMergeRequest => ({
    taskId: `00000000-0000-4000-8000-0000000c${taskSuffix.padStart(4, '0')}` as Id,
    mr: {
      provider: 'gitlab',
      project_path: 'acme/api',
      iid,
      url: `https://gitlab.example.test/acme/api/-/merge_requests/${iid}`,
      branch: `agentic/${iid}`,
      head_sha: HEAD,
    },
    enteredAt: ENTERED,
  });
  const thread = (
    id: string,
    note: { id: string; body: string; at: string; system?: boolean },
    resolved = false,
  ): Discussion => ({
    id,
    resolvable: note.system !== true,
    resolved,
    notes: [
      {
        id: note.id,
        author: {
          provider: 'gitlab',
          external_id: '77',
          display_name: 'Dana Reviewer',
          verified: false,
        },
        body: note.body,
        created_at: note.at,
        path: null,
        line: null,
        system: note.system === true,
      },
    ],
  });
  const comments = (harness: Harness) =>
    harness.events.filter((event) => event.type === 'mr.review.comment');

  it('records a person’s note written after the task entered Ready as mr.review.comment, once — and no system or platform note', async () => {
    const harness = harnessFor();
    harness.ready.push(waiting(7, '1'));
    harness.world.discussions.set(7, [
      thread('d-human', { id: '1101', body: 'Please rename totals.', at: at(1) }),
      thread('d-system', { id: '1102', body: 'added 1 commit', at: at(2), system: true }),
      thread('d-platform', {
        id: '1103',
        body: '<!-- agentic:conflict-warning:task-1 -->\nThis merge request overlaps another.',
        at: at(3),
      }),
    ]);

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({
      kind: 'polled',
      review: { tasks: 1, capped: false, recorded: 1, failed: 0 },
    });
    expect(comments(harness).map((event) => event.payload)).toEqual([
      {
        project_id: PROJECT,
        task_id: null,
        mr: waiting(7, '1').mr,
        thread_id: 'd-human',
        author: {
          provider: 'gitlab',
          external_id: '77',
          display_name: 'Dana Reviewer',
          verified: false,
        },
        text: 'Please rename totals.',
        resolved: false,
      },
    ]);
    expect([...harness.rows.values()].map((row) => row.deliveryId)).toContain(
      `gitlab:poll:${PROJECT}:acme/api!7#note:1101`,
    );

    const again = await pollMergeRequestBinding(harness.options, BINDING);
    expect(again).toMatchObject({ review: { recorded: 0 } });
    expect(comments(harness)).toHaveLength(1);
    expect(harness.world.discussionReads).toEqual([7, 7]);
  });

  it('reads a note written up to the clock allowance before the entry, and none before that', async () => {
    const allowance = REVIEW_NOTE_SKEW_MS / 60_000;
    const harness = harnessFor();
    harness.ready.push(waiting(7, '1'));
    harness.world.discussions.set(7, [
      thread('d-inside', { id: '1', body: 'Inside the allowance.', at: at(1 - allowance) }),
      thread('d-before', { id: '2', body: 'Before the allowance.', at: at(-1 - allowance) }),
    ]);

    await pollMergeRequestBinding(harness.options, BINDING);

    expect(comments(harness).map((event) => event.payload.thread_id)).toEqual(['d-inside']);
  });

  it('carries a resolved thread’s resolution, as the webhook does', async () => {
    const harness = harnessFor();
    harness.ready.push(waiting(7, '1'));
    harness.world.discussions.set(7, [
      thread('d-done', { id: '9', body: 'Fixed, thanks.', at: at(1) }, true),
    ]);

    await pollMergeRequestBinding(harness.options, BINDING);

    expect(comments(harness).map((event) => event.payload.resolved)).toEqual([true]);
  });

  it('redacts a planted credential before the event and the row are built from the note', async () => {
    const harness = harnessFor();
    harness.ready.push(waiting(7, '1'));
    harness.world.discussions.set(7, [
      thread('d-leak', { id: '5', body: `the job printed ${PLANTED}`, at: at(1) }),
    ]);

    await pollMergeRequestBinding(harness.options, BINDING);

    expect(comments(harness)).toHaveLength(1);
    expect(JSON.stringify(harness.events)).not.toContain(PLANTED);
    expect(JSON.stringify([...harness.rows.values()])).not.toContain(PLANTED);
    expect(JSON.stringify(comments(harness)[0]?.payload)).toContain('[REDACTED');
  });

  it('fails open per task: a refused notes read is counted, and the next task is still read (rule 20)', async () => {
    const harness = harnessFor();
    harness.ready.push(waiting(7, '1'), waiting(8, '2'));
    harness.world.discussionFails.set(
      7,
      new IntegrationError('forbidden', 'gitlab', 'the token lost its scope'),
    );
    harness.world.discussions.set(8, [
      thread('d-8', { id: '81', body: 'One more thing.', at: at(1) }),
    ]);

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({ review: { tasks: 2, failed: 1, recorded: 1 } });
    expect(comments(harness).map((event) => event.payload.mr.iid)).toEqual([8]);
  });

  it('reads at most the cap of waiting tasks, oldest entry first, and says it was capped', async () => {
    const harness = harnessFor();
    for (let index = 0; index < MR_POLL_REVIEW_TASKS_LIMIT + 2; index += 1) {
      harness.ready.push(waiting(100 + index, String(index)));
    }

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(harness.readyLimits).toEqual([MR_POLL_REVIEW_TASKS_LIMIT + 1]);
    expect(report).toMatchObject({ review: { tasks: MR_POLL_REVIEW_TASKS_LIMIT, capped: true } });
    expect(harness.world.discussionReads).toHaveLength(MR_POLL_REVIEW_TASKS_LIMIT);
    expect(harness.world.discussionReads[0]).toBe(100);
  });
});

describe('a binding a webhook can reach (WP-123)', () => {
  it('makes neither the default-branch read nor the notes read', async () => {
    const harness = harnessFor();
    harness.world.plan = { interval_seconds: 60, receives_webhooks: true };
    harness.defaultHead.value = SHA_A;
    harness.world.head = { branch: 'main', sha: SHA_B };
    harness.ready.push({
      taskId: '00000000-0000-4000-8000-0000000c0001' as Id,
      mr: { iid: 7, url: 'https://gitlab.example.test/acme/api/-/merge_requests/7' },
      enteredAt: '2026-06-01T09:00:00.000Z' as IsoDateTime,
    });

    const report = await pollMergeRequestBinding(harness.options, BINDING);

    expect(report).toMatchObject({ kind: 'polled', defaultBranch: 'webhook', review: null });
    expect(harness.world.headReads).toBe(0);
    expect(harness.world.discussionReads).toEqual([]);
    expect(harness.readyLimits).toEqual([]);
    expect(harness.events).toEqual([]);
  });
});

describe('the mr.poll queue', () => {
  it('re-arms a binding’s poll at its own interval', async () => {
    const harness = harnessFor();
    await mergeRequestPollHandler(harness.options)(
      context({ kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION }),
    );

    expect(harness.enqueued).toEqual([
      {
        queue: JOB_QUEUES.mrPoll,
        data: { kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION },
        singletonKey: mrPollKey(BINDING),
        startAfter: new Date('2026-06-01T10:01:00.000Z'),
      },
    ]);
  });

  it('re-arms a poll whose provider read failed, and still fails the job (rule 20)', async () => {
    const harness = harnessFor();
    harness.world.failNext = new Error('the provider is down');

    await expect(
      mergeRequestPollHandler(harness.options)(
        context({ kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION }),
      ),
    ).rejects.toThrow();

    expect(harness.enqueued.map((request) => request.singletonKey)).toEqual([mrPollKey(BINDING)]);
    expect(harness.cursor.value).toBeNull();
  });

  it('arms nothing for a binding that no longer polls', async () => {
    const harness = harnessFor();
    harness.world.plan = null;
    await mergeRequestPollHandler(harness.options)(
      context({ kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION }),
    );
    expect(harness.enqueued).toEqual([]);
  });

  it('sweeps: a poll for every polling git binding, then the next sweep', async () => {
    const other: PolledBinding = {
      projectId: '00000000-0000-4000-8000-0000000000b2' as Id,
      integrationId: INTEGRATION,
    };
    const harness = harnessFor({ polling: [BINDING, other] });

    await mergeRequestPollHandler(harness.options)(context({ kind: 'sweep' }));

    expect(harness.enqueued.map((request) => [request.queue, request.singletonKey])).toEqual([
      [JOB_QUEUES.mrPoll, mrPollKey(BINDING)],
      [JOB_QUEUES.mrPoll, mrPollKey(other)],
      [JOB_QUEUES.mrPoll, MR_POLL_SWEEP_KEY],
    ]);
    expect(harness.enqueued[2]?.startAfter).toEqual(new Date('2026-06-01T10:01:00.000Z'));
  });

  it('refuses a job payload it does not understand, rather than polling a guess', async () => {
    const harness = harnessFor();
    await expect(
      mergeRequestPollHandler(harness.options)(context({ kind: 'poll', project_id: 'nope' })),
    ).rejects.toThrow();
    expect(harness.enqueued).toEqual([]);
  });
});
