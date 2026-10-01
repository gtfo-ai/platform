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
import type {
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
  MR_POLL_SWEEP_KEY,
  mergeRequestPollHandler,
  mrPollKey,
  polledMergeRequestDrafts,
  pollMergeRequestBinding,
} from './mr-poll.js';
import type { PolledBinding } from './ticket-poll.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000000a1' as Id;
const NOW = '2026-06-01T10:00:00.000Z' as IsoDateTime;
/** Obviously fake, and what every redaction assertion looks for. */
const PLANTED = 'FAKE-PLANTED-gitlab-token-0123456789';
const BINDING: PolledBinding = { projectId: PROJECT, integrationId: INTEGRATION };
const PLAN: MergeRequestPollPlan = { interval_seconds: 60 };
const HEAD = 'a'.repeat(40);

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
  const store: MergeRequestPollStore = {
    listPolling: async () => overrides.polling ?? [BINDING],
    cursorOf: async () => cursor.value,
    advanceCursor: async (_binding, to) => {
      if (cursor.value === null || Date.parse(to) > Date.parse(cursor.value)) {
        cursor.value = to;
      }
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
  return { options, world, rows, events, cursor, enqueued, recordFailure, afterPollerRead };
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
