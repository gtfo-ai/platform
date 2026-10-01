/**
 * The ticket poller (WP-87, PROGRESS backlog 187) — everything the application ring decides: which
 * window a poll asks for, what a match becomes, the key it is deduplicated on, that the key and the
 * row are redacted, where the cursor moves, and which job re-arms which.
 *
 * The SQL half — `listPolling` over the merged config and the forward-only cursor — is asserted
 * against PostgreSQL in `test/integration/pipeline/ticket-poll.integration.test.ts`, and the whole
 * path, a real instance starting a task from a poll and deduplicating it against a webhook in both
 * orders, in `test/e2e/pipeline/ticket-poll.e2e.test.ts`.
 */
import type { DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { InboxDelivery, InboxStore } from '../ports/integrations/inbox.js';
import type {
  TaskManagementPort,
  TicketMatch,
  TicketMatchRule,
  TicketPollPlan,
} from '../ports/integrations/task-management.js';
import type { EnqueueRequest, JobContext, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import { type PipelineIntegrations, staticPipelineIntegrations } from './integrations.js';
import {
  type PolledBinding,
  pollTicketBinding,
  runTicketPollSweep,
  TICKET_POLL_LIVE_KEYS_LIMIT,
  TICKET_POLL_MAX_LIMIT,
  TICKET_POLL_SWEEP_KEY,
  type TicketPollerOptions,
  type TicketPollStore,
  ticketMatchRuleText,
  ticketPollHandler,
  ticketPollKey,
} from './ticket-poll.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000000a2' as Id;
const NOW = '2026-06-01T10:00:00.000Z' as IsoDateTime;
/** Obviously fake, and what every redaction assertion looks for. */
const PLANTED = 'FAKE-PLANTED-jira-token-0123456789';
const BINDING: PolledBinding = { projectId: PROJECT, integrationId: INTEGRATION };
const PLAN: TicketPollPlan = { rule: { kind: 'label', label: 'agentic' }, interval_seconds: 60 };

const match = (key: string, updatedAt: string, url?: string): TicketMatch => ({
  ref: { provider: 'jira-cloud', key, url: url ?? `https://acme.example.test/browse/${key}` },
  issue_type: 'Story',
  priority: 'High',
  epic: null,
  links: [],
  updated_at: updatedAt,
});

interface World {
  matches: TicketMatch[];
  plan: TicketPollPlan | null;
  asked: { rule: TicketMatchRule; since: string | null | undefined; limit: number | undefined }[];
  failNext: Error | null;
  /** Keys the provider's search has not indexed yet — Jira's lag, modelled (review round 1). */
  unindexed: Set<string>;
  /** WP-110: tickets the pick-up rule no longer matches — reachable by a `keys` rule only. */
  others: TicketMatch[];
  /** WP-110: the binding's live tasks' ticket keys, as the store answers them. */
  live: string[];
  /** WP-110: the `keys` read throws this, once. */
  failKeys: Error | null;
}

const portFor = (world: World): TaskManagementPort =>
  ({
    ref: {
      integrationId: INTEGRATION,
      provider: 'jira-cloud',
      type: 'task_management',
      host: null,
    },
    pollPlan: () => world.plan,
    matchTickets: (async (rule, options) => {
      world.asked.push({ rule, since: options?.since, limit: options?.limit });
      if (rule.kind === 'keys' && world.failKeys !== null) {
        const error = world.failKeys;
        world.failKeys = null;
        throw error;
      }
      if (world.failNext !== null) {
        const error = world.failNext;
        world.failNext = null;
        throw error;
      }
      // Jira's window: `buildJql` rounds the relative minutes **up**, so the search starts up to a
      // minute before `since`. Modelled as the minute boundary at or before it (review round 2).
      const asked = options?.since ?? null;
      const since =
        asked === null
          ? null
          : new Date(Math.floor(Date.parse(asked) / 60_000) * 60_000).toISOString();
      const searched =
        rule.kind === 'keys'
          ? [...world.matches, ...world.others].filter((entry) => rule.keys.includes(entry.ref.key))
          : world.matches;
      return searched
        .filter((entry) => !world.unindexed.has(entry.ref.key))
        .filter((entry) => since === null || Date.parse(entry.updated_at) >= Date.parse(since))
        .slice(0, options?.limit ?? 50);
    }) satisfies TaskManagementPort['matchTickets'],
  }) as unknown as TaskManagementPort;

const integrationsFor = (world: World, integrationId: Id = INTEGRATION): PipelineIntegrations => {
  const redactor = exactSecretRedactor([{ name: 'jira_api_token', value: PLANTED }]);
  return {
    executor: createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog: createMemoryAuditLog(),
      redactor,
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => NOW },
    }),
    git: null,
    communication: null,
    taskManagement: {
      port: portFor(world),
      ref: { integrationId, provider: 'jira-cloud', type: 'task_management', host: null },
      redactor,
    },
  };
};

interface Harness {
  options: TicketPollerOptions;
  readonly world: World;
  readonly rows: Map<string, InboxDelivery>;
  readonly events: DomainEvent[];
  readonly cursor: { value: IsoDateTime | null };
  /** Fail `inbox.record` once this many rows exist; `null` never fails. */
  readonly recordFailure: { after: number | null };
  readonly enqueued: EnqueueRequest[];
}

const harnessFor = (
  overrides: {
    readonly integrations?: (world: World) => PipelineIntegrations;
    readonly polling?: readonly PolledBinding[];
  } = {},
): Harness => {
  const world: World = {
    matches: [],
    plan: PLAN,
    asked: [],
    failNext: null,
    unindexed: new Set(),
    others: [],
    live: [],
    failKeys: null,
  };
  const rows = new Map<string, InboxDelivery>();
  const recordFailure: { after: number | null } = { after: null };
  const events: DomainEvent[] = [];
  const cursor: { value: IsoDateTime | null } = { value: null };
  const enqueued: EnqueueRequest[] = [];
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
  const store: TicketPollStore = {
    listPolling: async () => overrides.polling ?? [BINDING],
    cursorOf: async () => cursor.value,
    advanceCursor: async (_binding, to) => {
      if (cursor.value === null || Date.parse(to) > Date.parse(cursor.value)) {
        cursor.value = to;
      }
    },
    liveTicketKeys: async (_binding, _provider, limit) => world.live.slice(0, limit),
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
  const options: TicketPollerOptions = {
    jobs,
    store,
    integrations: staticPipelineIntegrations(
      (overrides.integrations ?? ((w) => integrationsFor(w)))(world),
    ),
    recorder: {
      inbox,
      unitOfWork,
      eventStore: { nextStreamSequence: async () => events.length + 1 },
      // Ticket deliveries carry no merge-request lifecycle event; the reader is never asked.
      mergeRequests: {
        latest: async () => {
          throw new Error('a ticket poll asked the merge-request lifecycle');
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
  return { options, world, rows, events, cursor, recordFailure, enqueued };
};

const context = (data: unknown): JobContext =>
  ({
    id: 'j',
    queue: JOB_QUEUES.ticketPoll,
    data,
    signal: new AbortController().signal,
  }) as JobContext;

describe('a poll of one binding', () => {
  it('records a match as the pair a webhook match is, on an inbox row keyed by the ticket’s state', async () => {
    const harness = harnessFor();
    harness.world.matches = [match('ACME-1', '2026-06-01T09:59:30.000Z')];

    const report = await pollTicketBinding(harness.options, BINDING);

    expect(report).toMatchObject({ kind: 'polled', matched: 1, recorded: 1, duplicates: 0 });
    expect(harness.events.map((event) => event.type)).toEqual(['ticket.matched', 'ticket.updated']);
    expect(harness.events[0]?.payload).toMatchObject({
      project_id: PROJECT,
      ticket: { provider: 'jira-cloud', key: 'ACME-1' },
      rule: 'label = "agentic"',
      issue_type: 'Story',
      priority: 'High',
    });
    // No changelog in a search result: the empty list, never an invented one.
    expect(harness.events[1]?.payload).toMatchObject({
      updated_at: '2026-06-01T09:59:30.000Z',
      changed_fields: [],
      truncated: false,
    });
    expect(harness.events.every((event) => event.stream_id === PROJECT)).toBe(true);
    expect([...harness.rows.values()].map((row) => row.deliveryId)).toEqual([
      `jira-cloud:poll:${PROJECT}:ACME-1@2026-06-01T09:59:30.000Z`,
    ]);
    expect([...harness.rows.values()][0]).toMatchObject({
      integrationId: INTEGRATION,
      verified: true,
      headers: {},
      payload: { source: 'poll', rule: 'label = "agentic"' },
    });
    expect(harness.cursor.value).toBe('2026-06-01T09:59:30.000Z');
  });

  it('appends nothing for a ticket nobody touched since the last poll — the inbox key collides', async () => {
    const harness = harnessFor();
    harness.world.matches = [match('ACME-1', '2026-06-01T09:59:30.000Z')];
    await pollTicketBinding(harness.options, BINDING);
    const before = harness.events.length;

    const second = await pollTicketBinding(harness.options, BINDING);

    expect(second).toMatchObject({ kind: 'polled', matched: 1, recorded: 0, duplicates: 1 });
    expect(harness.events).toHaveLength(before);
    expect(harness.rows.size).toBe(1);
  });

  it('records an edit found by a later poll as ticket.updated (WP-87 criterion 2)', async () => {
    const harness = harnessFor();
    harness.world.matches = [match('ACME-1', '2026-06-01T09:59:30.000Z')];
    await pollTicketBinding(harness.options, BINDING);

    harness.world.matches = [match('ACME-1', '2026-06-01T10:05:00.000Z')];
    await pollTicketBinding(harness.options, BINDING);

    const updates = harness.events.filter((event) => event.type === 'ticket.updated');
    expect(updates.map((event) => (event.payload as { updated_at: string }).updated_at)).toEqual([
      '2026-06-01T09:59:30.000Z',
      '2026-06-01T10:05:00.000Z',
    ]);
    expect(harness.cursor.value).toBe('2026-06-01T10:05:00.000Z');
  });

  it('reads the last interval on a first poll and the cursor after that', async () => {
    const harness = harnessFor();
    await pollTicketBinding(harness.options, BINDING);
    harness.cursor.value = '2026-06-01T09:30:00.000Z' as IsoDateTime;
    await pollTicketBinding(harness.options, BINDING);

    expect(harness.world.asked.map((entry) => entry.since)).toEqual([
      // NOW minus the plan's 60 seconds, minus the overlap: never "every ticket that ever carried
      // the label".
      '2026-06-01T09:54:00.000Z',
      // The cursor minus the overlap (TICKET_POLL_OVERLAP_MS, five minutes).
      '2026-06-01T09:25:00.000Z',
    ]);
    expect(harness.world.asked[0]?.rule).toEqual(PLAN.rule);
    expect(harness.world.asked[0]?.limit).toBe(50);
  });

  it('reads a ticket the provider indexed late, though it was updated before the cursor', async () => {
    const harness = harnessFor();
    // ACME-1 was updated first but is not in the search index yet; ACME-2, a moment later, is.
    harness.world.matches = [
      match('ACME-1', '2026-06-01T09:59:40.000Z'),
      match('ACME-2', '2026-06-01T09:59:45.000Z'),
    ];
    harness.world.unindexed.add('ACME-1');
    await pollTicketBinding(harness.options, BINDING);
    expect(harness.cursor.value).toBe('2026-06-01T09:59:45.000Z');

    harness.world.unindexed.clear();
    const next = await pollTicketBinding(harness.options, BINDING);

    // The overlap reaches back past the cursor: ACME-1 is recorded, ACME-2 collides on its key.
    expect(next).toMatchObject({ recorded: 1, duplicates: 1 });
    expect([...harness.rows.values()].map((row) => row.deliveryId)).toContain(
      `jira-cloud:poll:${PROJECT}:ACME-1@2026-06-01T09:59:40.000Z`,
    );
    expect(harness.world.asked[1]?.since).toBe('2026-06-01T09:54:45.000Z');
  });

  it('makes progress through a bulk edit larger than a page inside one minute', async () => {
    const harness = harnessFor();
    // Sixty tickets edited within one minute: more than the first page (50), all in the minute the
    // provider's window rounds to — so re-asking from the cursor returns the same first fifty.
    harness.world.matches = Array.from({ length: 60 }, (_, index) =>
      match(`ACME-${index + 1}`, `2026-06-01T09:59:${String(index % 60).padStart(2, '0')}.000Z`),
    );
    await pollTicketBinding(harness.options, BINDING);
    expect(harness.rows.size).toBe(50);

    const second = await pollTicketBinding(harness.options, BINDING);

    expect(second).toMatchObject({ kind: 'polled', recorded: 10, stalled: false });
    expect(harness.rows.size).toBe(60);
    expect(harness.cursor.value).toBe('2026-06-01T09:59:59.000Z');
    expect(harness.world.asked.map((entry) => entry.limit)).toEqual([50, 50, 200]);
  });

  it('says it is stalled, rather than stalling silently, past the widest page', async () => {
    const harness = harnessFor();
    harness.cursor.value = '2026-06-01T09:59:59.000Z' as IsoDateTime;
    harness.world.matches = Array.from({ length: TICKET_POLL_MAX_LIMIT + 5 }, (_, index) =>
      match(`ACME-${index + 1}`, '2026-06-01T09:59:30.000Z'),
    );
    harness.world.matches.push(match('ACME-NEW', '2026-06-01T10:00:30.000Z'));

    const report = await pollTicketBinding(harness.options, BINDING);

    expect(report).toMatchObject({ kind: 'polled', stalled: true });
    expect(harness.world.asked.map((entry) => entry.limit)).toEqual([50, 200, 800, 1000, 1000]);
    expect(harness.cursor.value).toBe('2026-06-01T09:59:59.000Z');
  });

  it('does not move the cursor when recording a match fails part-way', async () => {
    const harness = harnessFor();
    harness.world.matches = [
      match('ACME-1', '2026-06-01T09:59:10.000Z'),
      match('ACME-2', '2026-06-01T09:59:20.000Z'),
    ];
    harness.recordFailure.after = 1;

    await expect(pollTicketBinding(harness.options, BINDING)).rejects.toThrow(/went away/);

    expect(harness.rows.size).toBe(1);
    expect(harness.cursor.value, 'the window must be read again, not skipped').toBeNull();

    // And the retry records the rest, the first match colliding on its key.
    harness.recordFailure.after = null;
    expect(await pollTicketBinding(harness.options, BINDING)).toMatchObject({
      recorded: 1,
      duplicates: 1,
    });
    expect(harness.cursor.value).toBe('2026-06-01T09:59:20.000Z');
  });

  it('redacts the match before the key, the row and the events are built from it', async () => {
    const harness = harnessFor();
    harness.world.matches = [
      match(
        `ACME-${PLANTED}`,
        '2026-06-01T09:59:30.000Z',
        `https://acme.example.test/browse/x?t=${PLANTED}`,
      ),
    ];

    await pollTicketBinding(harness.options, BINDING);

    const stored = JSON.stringify([...harness.rows.entries()]);
    expect(stored).not.toContain(PLANTED);
    expect(JSON.stringify(harness.events)).not.toContain(PLANTED);
    const row = [...harness.rows.values()][0];
    expect(row?.deliveryId).toContain('[REDACTED');
    expect(row?.redactionCount).toBeGreaterThan(0);
  });

  it('drops by name a match redaction left unreadable, and still records the rest (rule 20)', async () => {
    const harness = harnessFor();
    harness.world.matches = [
      // The planted credential *is* the host: its placeholder leaves no URL behind.
      match('ACME-2', '2026-06-01T09:59:10.000Z', `https://${PLANTED}/browse/ACME-2`),
      match('ACME-3', '2026-06-01T09:59:20.000Z'),
    ];

    const report = await pollTicketBinding(harness.options, BINDING);

    expect(report).toMatchObject({ kind: 'polled', matched: 2, recorded: 1, skipped: 1 });
    expect([...harness.rows.values()].map((row) => row.deliveryId)).toEqual([
      `jira-cloud:poll:${PROJECT}:ACME-3@2026-06-01T09:59:20.000Z`,
    ]);
    // The window still moves past it: a poison match must not wedge the cursor.
    expect(harness.cursor.value).toBe('2026-06-01T09:59:20.000Z');
  });

  it('ends the chain for a binding that is gone, re-pointed, or no longer polls', async () => {
    const off = harnessFor();
    off.world.plan = null;
    expect(await pollTicketBinding(off.options, BINDING)).toEqual({ kind: 'off' });

    const repointed = harnessFor({
      integrations: (world) => integrationsFor(world, '00000000-0000-4000-8000-00000000ffff' as Id),
    });
    expect(await pollTicketBinding(repointed.options, BINDING)).toEqual({ kind: 'unbound' });

    const gone = harnessFor({
      integrations: (world) => ({ ...integrationsFor(world), taskManagement: null }),
    });
    expect(await pollTicketBinding(gone.options, BINDING)).toEqual({ kind: 'unbound' });
    expect(gone.world.asked).toEqual([]);
  });
});

/**
 * WP-110, PROGRESS backlog 298: a status rule stops matching a ticket the moment the platform's
 * status mapping moves it on, so the poll also re-reads the binding's live tasks' tickets — and a
 * ticket found that way is an edit, never a pick-up.
 */
describe('the live tasks’ tickets, whatever the rule says (WP-110)', () => {
  const STATUS_PLAN: TicketPollPlan = {
    rule: { kind: 'status', status: 'Ready for agent' },
    interval_seconds: 60,
  };

  it('records an edit to a ticket that left the rule as ticket.updated only', async () => {
    const harness = harnessFor();
    harness.world.plan = STATUS_PLAN;
    harness.cursor.value = '2026-06-01T09:58:00.000Z' as IsoDateTime;
    // The platform moved ACME-1 to In Progress: the rule finds nothing; a human then edited it.
    harness.world.others = [match('ACME-1', '2026-06-01T09:59:30.000Z')];
    harness.world.live = ['ACME-1'];

    const report = await pollTicketBinding(harness.options, BINDING);

    expect(harness.world.asked.map((entry) => entry.rule)).toEqual([
      STATUS_PLAN.rule,
      { kind: 'keys', keys: ['ACME-1'] },
    ]);
    // The same window as the rule's read, and a limit of the key count: a search answers each
    // ticket once, so it is never a cut.
    expect(harness.world.asked[1]).toMatchObject({ since: '2026-06-01T09:53:00.000Z', limit: 1 });
    expect(harness.events.map((event) => event.type)).toEqual(['ticket.updated']);
    expect(harness.events[0]?.payload).toMatchObject({
      ticket: { key: 'ACME-1' },
      updated_at: '2026-06-01T09:59:30.000Z',
    });
    expect([...harness.rows.values()].map((row) => row.deliveryId)).toEqual([
      `jira-cloud:poll:${PROJECT}:ACME-1@2026-06-01T09:59:30.000Z`,
    ]);
    expect(report).toMatchObject({
      kind: 'polled',
      matched: 0,
      live: { asked: 1, omitted: 0, matched: 1, recorded: 1, failed: false },
    });
    // The cursor is the rule read's alone: a live ticket must not move the window past rule
    // matches not read yet.
    expect(harness.cursor.value).toBe('2026-06-01T09:58:00.000Z');
  });

  it('records a ticket both reads return once — by the rule read, as the pair', async () => {
    const harness = harnessFor();
    harness.world.matches = [match('ACME-1', '2026-06-01T09:59:30.000Z')];
    harness.world.live = ['ACME-1'];

    const report = await pollTicketBinding(harness.options, BINDING);

    expect(harness.events.map((event) => event.type)).toEqual(['ticket.matched', 'ticket.updated']);
    expect(report).toMatchObject({ live: { matched: 1, recorded: 0, duplicates: 1 } });
  });

  it('asks nothing more when the binding has no live task', async () => {
    const harness = harnessFor();
    harness.world.matches = [match('ACME-1', '2026-06-01T09:59:30.000Z')];

    const report = await pollTicketBinding(harness.options, BINDING);

    expect(harness.world.asked).toHaveLength(1);
    expect(report).toMatchObject({ live: { asked: 0, matched: 0, failed: false } });
  });

  it('reads at most a hundred live tickets, one request, and says how many it left out', async () => {
    const harness = harnessFor();
    harness.world.live = Array.from({ length: 101 }, (_, index) => `ACME-${index + 1}`);

    const report = await pollTicketBinding(harness.options, BINDING);

    const keysRead = harness.world.asked.filter((entry) => entry.rule.kind === 'keys');
    expect(keysRead).toHaveLength(1);
    const rule = keysRead[0]?.rule;
    expect(rule?.kind === 'keys' ? rule.keys : []).toHaveLength(TICKET_POLL_LIVE_KEYS_LIMIT);
    expect(report).toMatchObject({ live: { asked: 100, omitted: 1 } });
  });

  it('fails open: a refused live read leaves the rule half recorded and the cursor moved (rule 20)', async () => {
    const harness = harnessFor();
    harness.world.matches = [match('ACME-2', '2026-06-01T09:59:30.000Z')];
    harness.world.live = ['ACME-1'];
    harness.world.failKeys = new Error('An issue with key ACME-1 does not exist');

    const report = await pollTicketBinding(harness.options, BINDING);

    expect(harness.events.map((event) => event.type)).toEqual(['ticket.matched', 'ticket.updated']);
    expect(harness.cursor.value).toBe('2026-06-01T09:59:30.000Z');
    expect(report).toMatchObject({ live: { asked: 1, failed: true } });
  });
});

describe('the ticket.poll queue', () => {
  it('re-arms a binding’s poll at its own interval', async () => {
    const harness = harnessFor();
    await ticketPollHandler(harness.options)(
      context({ kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION }),
    );

    expect(harness.enqueued).toEqual([
      {
        queue: JOB_QUEUES.ticketPoll,
        data: { kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION },
        singletonKey: ticketPollKey(BINDING),
        startAfter: new Date('2026-06-01T10:01:00.000Z'),
      },
    ]);
  });

  it('re-arms a poll whose provider read failed, and still fails the job (rule 20: the next tick retries)', async () => {
    const harness = harnessFor();
    harness.world.failNext = new Error('the provider is down');

    await expect(
      ticketPollHandler(harness.options)(
        context({ kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION }),
      ),
    ).rejects.toThrow();

    expect(harness.enqueued.map((request) => request.singletonKey)).toEqual([
      ticketPollKey(BINDING),
    ]);
    expect(harness.cursor.value).toBeNull();
  });

  it('arms nothing for a binding that no longer polls — the sweep starts it again if it is switched back on', async () => {
    const harness = harnessFor();
    harness.world.plan = null;
    await ticketPollHandler(harness.options)(
      context({ kind: 'poll', project_id: PROJECT, integration_id: INTEGRATION }),
    );
    expect(harness.enqueued).toEqual([]);
  });

  it('sweeps: a poll for every polling binding, then the next sweep', async () => {
    const other: PolledBinding = {
      projectId: '00000000-0000-4000-8000-0000000000b2' as Id,
      integrationId: INTEGRATION,
    };
    const harness = harnessFor({ polling: [BINDING, other] });

    await ticketPollHandler(harness.options)(context({ kind: 'sweep' }));

    expect(harness.enqueued.map((request) => request.singletonKey)).toEqual([
      ticketPollKey(BINDING),
      ticketPollKey(other),
      TICKET_POLL_SWEEP_KEY,
    ]);
    // The polls start now (a live chain's queued job absorbs them); the sweep comes back later.
    expect(harness.enqueued[0]?.startAfter).toBeUndefined();
    expect(harness.enqueued[2]?.startAfter).toEqual(new Date('2026-06-01T10:01:00.000Z'));
    expect(await runTicketPollSweep(harness.options)).toEqual({ bindings: 2 });
  });

  it('refuses a job payload it does not understand, rather than polling a guess', async () => {
    const harness = harnessFor();
    await expect(
      ticketPollHandler(harness.options)(context({ kind: 'poll', project_id: 'not-a-uuid' })),
    ).rejects.toThrow();
    expect(harness.enqueued).toEqual([]);
  });
});

describe('the rule a polled match names', () => {
  it('spells each rule the way the webhook does', () => {
    expect(ticketMatchRuleText({ kind: 'label', label: 'agentic' })).toBe('label = "agentic"');
    expect(ticketMatchRuleText({ kind: 'status', status: 'Ready for agent' })).toBe(
      'status = "Ready for agent"',
    );
    expect(ticketMatchRuleText({ kind: 'epic', epic_key: 'ACME-100' })).toBe('epic = "ACME-100"');
    expect(ticketMatchRuleText({ kind: 'query', query: 'project = ACME' })).toBe('project = ACME');
    // WP-110: the live tasks' read, which no webhook announces — spelled so the inbox row says it.
    expect(ticketMatchRuleText({ kind: 'keys', keys: ['ACME-1', 'ACME-2'] })).toBe(
      'key in ("ACME-1", "ACME-2")',
    );
  });
});
