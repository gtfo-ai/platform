/**
 * The shadow batch, driven through the real command over the in-memory doubles (WP-34).
 *
 * Three families of assertion, and each is a **countable effect** rather than a return value
 * (standing rule 79):
 *
 *  - **which tasks exist**, and in which mode — the batch's whole product;
 *  - **which provider calls were made**, read from the audit log the executor writes, because the
 *    criterion is that a shadow task issues *zero* mutating requests and the guard is only worth
 *    what something drives through it;
 *  - **which refusal** was recorded, by name, on the batch's own ticket rows.
 *
 * Both directions on every gate (standing rule 42): an Observe project runs the batch and refuses a
 * new ticket, a Supervised project does the opposite.
 */
import type { DomainEvent, Id, IsoDateTime, MergeRequestRef } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { AUTONOMY_PRESETS, materialiseAutonomy } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import { staticProjectSettings } from '../pipeline/settings.js';
import type { MergedMergeRequest, MergeRequest } from '../ports/integrations/git-provider.js';
import type { Ticket } from '../ports/integrations/task-management.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { startShadowBatch } from './batch.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const USER = '00000000-0000-4000-8000-0000000000e2' as Id;
const AT = '2026-09-14T10:00:00.000Z' as IsoDateTime;
const HOST = 'https://git.example.test/acme/api/-/merge_requests';

const MR_REF: MergeRequestRef = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: `${HOST}/7`,
  branch: 'feature/acme-1',
  head_sha: 'a'.repeat(40),
};

const ticket = (key: string): Ticket =>
  ({
    ref: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
    issue_type: 'Story',
    title: `Sum the totals (${key})`,
    description: 'The footer shows the wrong number.',
    status: 'Done',
    priority: 'High',
    labels: [],
    comments: [],
    links: [],
    epic: null,
    siblings: [],
    attachments_text: [],
    assignee: null,
    reporter: null,
    updated_at: AT,
  }) as Ticket;

const mergedMr = (key: string): MergedMergeRequest => ({
  ref: MR_REF,
  author: { provider: 'fake-git', external_id: 'dana', email: null, verified: false },
  merged_at: '2026-04-01T09:00:00.000Z',
  title: `Sum the totals (${key})`,
  diff_stats: null,
  discussion_count: 1,
});

const fullMr = (baseSha: string | null): MergeRequest =>
  ({
    ref: MR_REF,
    state: 'merged' as const,
    draft: false,
    title: 'Sum the totals',
    description: '',
    source_branch: MR_REF.branch,
    target_branch: 'main',
    head_sha: 'a'.repeat(40),
    base_sha: baseSha,
    mergeable: true,
    has_conflicts: false,
    coverage_pct: null,
    labels: [],
    reviewers: [],
    web_url: MR_REF.url,
    merged_at: '2026-04-01T09:00:00.000Z',
  }) as MergeRequest;

interface WorldOptions {
  readonly level?: 'observe' | 'assist' | 'supervised' | 'autonomous';
  readonly enabled?: boolean;
  readonly budgetUsd?: number;
  readonly baseSha?: string | null;
  readonly knownTickets?: readonly string[];
  readonly merged?: readonly MergedMergeRequest[];
}

const world = (options: WorldOptions = {}) => {
  const known = new Set(options.knownTickets ?? ['ACME-1', 'ACME-2']);
  return createPipelineHarness({
    projectId: PROJECT,
    settings: {
      config: {
        features: {
          shadow_mode: {
            enabled: options.enabled ?? true,
            ...(options.budgetUsd === undefined ? {} : { budget_usd: options.budgetUsd }),
          },
        },
      },
      autonomy: materialiseAutonomy({
        level: options.level ?? 'observe',
        at: AT,
        appliedBy: null,
      }),
    },
    // Every stage answers, so a shadow task walks its whole template and reaches the point where
    // its mutating writes would happen.
    runs: {},
    git: {
      getMergeRequest: async () =>
        fullMr(options.baseSha === undefined ? 'b'.repeat(40) : options.baseSha),
      listMergedMergeRequests: async () =>
        options.merged ?? [mergedMr('ACME-1'), mergedMr('ACME-2')],
    },
    taskManagement: {
      readTicket: async (ref: { key: string }) => {
        if (!known.has(ref.key)) {
          throw new Error(`no ticket ${ref.key}`);
        }
        return ticket(ref.key);
      },
    },
  });
};

const run = async (harness: PipelineHarness, keys: readonly string[]) =>
  startShadowBatch(
    {
      unitOfWork: harness.memory,
      store: harness.store,
      shadow: harness.shadow,
      settings: staticProjectSettings(() => harness.settings),
      integrations: staticPipelineIntegrations(harness.integrations),
      jobs: harness.jobs,
      ids: harness.ids,
      clock: { now: () => harness.clock.now() as IsoDateTime },
    },
    { projectId: PROJECT, ticketKeys: keys, requestedByUserId: USER },
  );

const tasksOf = async (harness: PipelineHarness) =>
  harness.memory.transaction(async (scope) => {
    const rows = [] as { mode: string; key: string }[];
    for (const event of harness.events()) {
      if (event.type !== 'task.created') continue;
      const taskId = (event as { payload: { task_id: Id } }).payload.task_id;
      const stored = await harness.store.tasks.load(scope.tx, taskId);
      if (stored !== null) {
        rows.push({ mode: stored.task.mode, key: stored.task.ticket.key });
      }
    }
    return rows;
  });

/**
 * The mutating actions a ticket task's walk reaches, by name.
 *
 * A **list** rather than a flag on the audit row, because `IntegrationActionEntry` carries no
 * `mutating` field: a read and a mutation both record `ok`, so a test that asserted `status === 'ok'`
 * over every row would be green on a walk that made only reads. These are the three the workpad and
 * the status mapping produce.
 */
const MUTATING = new Set([
  'upsert_workpad',
  'transition',
  'create_discussion',
  'open_merge_request',
]);

const ticketMatched = (key: string): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: `00000000-0000-4000-9000-${key.length.toString(16).padStart(12, '0')}`,
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'test' },
    occurred_at: AT,
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: { provider: 'fake-jira', key, url: `https://jira.example.test/browse/${key}` },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

describe('startShadowBatch — the gate', () => {
  it('runs on an Observe project with the feature on', async () => {
    const harness = world();
    const result = await run(harness, ['ACME-1']);
    expect(result.status).toBe('started');
  });

  it('refuses a project whose dial is past Observe, by name', async () => {
    // product/19 §11: `shadowMode` is true at `observe` and false at the other three, so this is
    // the other direction of the same read (standing rule 42) — and the reason the read is the
    // dial's rather than only the feature key's.
    expect(AUTONOMY_PRESETS.supervised.shadowMode).toBe(false);
    const result = await run(world({ level: 'supervised' }), ['ACME-1']);
    expect(result).toEqual(
      expect.objectContaining({ status: 'blocked', blocker: 'shadow_not_allowed' }),
    );
  });

  it('refuses a project with the feature off, by a different name', async () => {
    const result = await run(world({ enabled: false }), ['ACME-1']);
    expect(result).toEqual(
      expect.objectContaining({ status: 'blocked', blocker: 'feature_disabled' }),
    );
  });

  it('creates nothing at all when it is blocked', async () => {
    const harness = world({ level: 'autonomous' });
    await run(harness, ['ACME-1', 'ACME-2']);
    expect(await tasksOf(harness)).toEqual([]);
    expect(harness.shadow.batches).toEqual([]);
  });
});

describe('startShadowBatch — the tickets', () => {
  it('creates one shadow task per ticket and records the batch’s rows', async () => {
    const harness = world();
    const result = await run(harness, ['ACME-1', 'ACME-2']);
    expect(result.status).toBe('started');

    const tasks = await tasksOf(harness);
    expect(tasks).toHaveLength(2);
    // The bit the whole feature rests on, asserted on the stored row rather than on the argument.
    expect(tasks.every((task) => task.mode === 'shadow')).toBe(true);
    expect(tasks.map((task) => task.key).sort()).toEqual(['ACME-1', 'ACME-2']);

    expect(harness.shadow.batches).toHaveLength(1);
    const batchId = harness.shadow.batches[0]?.id as Id;
    const rows = harness.shadow.ticketsOf(batchId);
    expect(rows.map((row) => row.ticketKey)).toEqual(['ACME-1', 'ACME-2']);
    expect(rows.every((row) => row.baseSha === 'b'.repeat(40))).toBe(true);
    expect(rows.every((row) => row.humanMrSource === 'title_scan')).toBe(true);
    expect(rows.every((row) => row.refusedReason === null)).toBe(true);
    // The two the **report** reads later, written by this command because the match is made here:
    // the merge instant product/19 §16's window runs to, and how many merge requests matched. A
    // resolver that computes them and a writer that drops them passes every other assertion in
    // this file — which is exactly what a round-2 canary found (standing rule 86).
    expect(rows.every((row) => row.mergedAt === '2026-04-01T09:00:00.000Z')).toBe(true);
    // `[2, 1]` rather than `[1, 1]`, and the asymmetry is the fixture's own: both merged merge
    // requests carry `branch: 'feature/acme-1'`, and the scan reads the title **or** the branch —
    // so ACME-1 matches both and ACME-2 only its own title. A count that ignored the branch would
    // read `[1, 1]` here.
    expect(rows.map((row) => row.candidates)).toEqual([2, 1]);
  });

  it('records the newest match and how many there were, when a ticket has several', async () => {
    // "The most recently merged wins" understates the human's size, and the count is what lets the
    // report say so. Both halves are asserted on the row: the winner *and* the number.
    const harness = world({
      merged: [
        mergedMr('ACME-1'),
        { ...mergedMr('ACME-1'), merged_at: '2026-05-01T09:00:00.000Z' },
      ],
    });
    await run(harness, ['ACME-1']);
    const batchId = harness.shadow.batches[0]?.id as Id;
    const row = harness.shadow.ticketsOf(batchId)[0];
    expect(row?.candidates).toBe(2);
    expect(row?.mergedAt).toBe('2026-05-01T09:00:00.000Z');
  });

  it('refuses a ticket whose human merge request publishes no merge base — Q82 (a)', async () => {
    const harness = world({ baseSha: null });
    const result = await run(harness, ['ACME-1']);
    expect(result.status).toBe('started');
    // Refused, with **no** task: comparing against today's default branch would measure drift.
    expect(await tasksOf(harness)).toEqual([]);
    const batchId = harness.shadow.batches[0]?.id as Id;
    expect(harness.shadow.ticketsOf(batchId)[0]?.refusedReason).toContain('no merge base');
  });

  it('runs a ticket with **no** human merge request at all — Q82 (b), the other direction', async () => {
    // Explicitly not a refusal: such a ticket still produces a report, with `human_mr: null` and no
    // overlap block. Nothing has to match, so the default branch is the right base.
    const harness = world({ merged: [] });
    const result = await run(harness, ['ACME-1']);
    expect(result.status).toBe('started');
    expect(await tasksOf(harness)).toHaveLength(1);
    const batchId = harness.shadow.batches[0]?.id as Id;
    const row = harness.shadow.ticketsOf(batchId)[0];
    expect(row?.refusedReason).toBeNull();
    expect(row?.humanMr).toBeNull();
    expect(row?.baseSha).toBeNull();
  });

  it('refuses a key the provider does not know, and still runs the others', async () => {
    const harness = world({ knownTickets: ['ACME-1'] });
    const result = await run(harness, ['ACME-1', 'ACME-404']);
    expect(result.status).toBe('started');
    expect(await tasksOf(harness)).toHaveLength(1);
    const outcomes = result.status === 'started' ? result.tickets : [];
    expect(outcomes.find((entry) => entry.ticketKey === 'ACME-404')?.refusedReason).toContain(
      'does not know this ticket',
    );
  });

  it('performs nothing twice: a second batch on the same key creates no second task', async () => {
    const harness = world();
    await run(harness, ['ACME-1']);
    await run(harness, ['ACME-1']);
    // The countable effect (standing rule 79): one task, two batch rows, and the second batch's
    // ticket carries the refusal rather than a silent success.
    expect(await tasksOf(harness)).toHaveLength(1);
    expect(harness.shadow.batches).toHaveLength(2);
    const second = harness.shadow.batches[1]?.id as Id;
    expect(harness.shadow.ticketsOf(second)[0]?.refusedReason).toContain('already has a shadow');
  });
});

describe('a shadow task’s outbound writes', () => {
  /** Every mutating action the executor was asked to perform, with what it did about it. */
  const mutations = (harness: PipelineHarness): readonly [string, string][] =>
    harness.audit.entries
      .filter((entry) => MUTATING.has(entry.action))
      .map((entry) => [entry.action, entry.status] as [string, string]);

  it('records every mutating provider call as would_have and calls nobody', async () => {
    const harness = world();
    await run(harness, ['ACME-1']);
    await harness.drain();

    // Positive first (standing rules 10 and 29): the walk really did reach a mutating write, so
    // "nothing was performed" is a statement about a path that was taken rather than about a task
    // that never got there.
    const made = mutations(harness);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every(([, status]) => status === 'would_have')).toBe(true);
    // …and the provider itself was never asked. `ok` on a mutating action would be a real comment
    // on somebody's board.
    expect(made.filter(([, status]) => status === 'ok')).toEqual([]);
  });

  it('a normal task in the same harness still performs its writes', async () => {
    // Rule 42's other half, and the reason it matters: a build that recorded `would_have` for
    // *every* task would pass the case above and would have broken the product. Supervised,
    // because an Observe project picks no new ticket up at all — the *other* policy this work
    // package gave a reader, asserted on its own below.
    const harness = world({ level: 'supervised', knownTickets: ['ACME-9'] });
    await harness.publish([ticketMatched('ACME-9')]);
    await harness.drain();

    const made = mutations(harness);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every(([, status]) => status === 'ok')).toBe(true);
    expect(made.filter(([, status]) => status === 'would_have')).toEqual([]);
  });
});

describe('picksUpNewTickets — the other half of Observe', () => {
  it('creates no task for a new ticket on an Observe project', async () => {
    const harness = world();
    await harness.publish([ticketMatched('ACME-9')]);
    expect(await tasksOf(harness)).toEqual([]);
  });

  it('creates one on a Supervised project — the same event, the other dial position', async () => {
    const harness = world({ level: 'supervised' });
    await harness.publish([ticketMatched('ACME-9')]);
    const tasks = await tasksOf(harness);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.mode).toBe('normal');
  });
});

describe('the separate shadow budget', () => {
  /** The stored state of the batch's one task. */
  const taskState = async (harness: PipelineHarness): Promise<string | null> =>
    harness.memory.transaction(async (scope) => {
      const created = harness.events().find((event) => event.type === 'task.created');
      if (created === undefined) return null;
      const taskId = (created as { payload: { task_id: Id } }).payload.task_id;
      const stored = await harness.store.tasks.load(scope.tx, taskId);
      return stored?.task.state ?? null;
    });

  it('stops a shadow run when the month’s shadow spend has reached the cap', async () => {
    const harness = world({ budgetUsd: 10 });
    // What this project's shadow tasks have already spent this month, as the ledger reports it.
    harness.shadow.seedShadowSpend(PROJECT, 10);
    await run(harness, ['ACME-1']);
    await harness.drain();
    // `Paused: budget` — product/09's answer to a cap, whichever scope reached it.
    expect(await taskState(harness)).toBe('paused');
    expect(harness.specs).toEqual([]);
  });

  /**
   * The same cap, stopped by the spend the **ledger has not recorded** (`../cost/pending.ts`).
   *
   * `cost_entries` is written by a handler on `run.finished`, after the run's own transaction, so a
   * cap read from it alone lets a second admission through inside that window — measured on WP-40's
   * tree, where a delayed ledger handler let a batch run twice against a cap that allows one. Here
   * the ledger reports **nothing** and a single shadow run in flight, holding the 2 a `refinement`
   * may spend, is what reaches the 3.
   */
  it('stops a shadow run on a run the ledger has not recorded yet', async () => {
    const harness = world({ budgetUsd: 3 });
    harness.shadow.seedShadowSpend(PROJECT, 0);
    harness.shadow.seedPendingShadowRuns(PROJECT, 1);
    await run(harness, ['ACME-1']);
    await harness.drain();
    expect(await taskState(harness)).toBe('paused');
    expect(harness.specs).toEqual([]);
  });

  it('lets the same run start when the cap is not reached — the other direction', async () => {
    const harness = world({ budgetUsd: 1000 });
    harness.shadow.seedShadowSpend(PROJECT, 10);
    await run(harness, ['ACME-1']);
    await harness.drain();
    expect(await taskState(harness)).not.toBe('paused');
    expect(harness.specs.length).toBeGreaterThan(0);
  });

  it('does not apply the cap to a normal task, however much shadow spend there is', async () => {
    // The cap is a statement about shadow runs, not about the project: a build that read it for
    // every task would stop delivery the first time somebody demoed the feature.
    const harness = world({ level: 'supervised', budgetUsd: 1, knownTickets: ['ACME-9'] });
    harness.shadow.seedShadowSpend(PROJECT, 500);
    await harness.publish([ticketMatched('ACME-9')]);
    await harness.drain();
    expect(await taskState(harness)).not.toBe('paused');
  });

  it('makes no shadow-spend query at all for a project with no cap configured', async () => {
    // A project that set no `features.shadow_mode.budget_usd` pays nothing for the feature: the
    // executor never asks. Asserted by counting, because a guard that always queried would be
    // invisible to a state assertion.
    let asked = 0;
    const harness = world();
    const original = harness.shadow.shadowSpendSince.bind(harness.shadow);
    (harness.shadow as { shadowSpendSince: typeof original }).shadowSpendSince = async (
      ...args
    ) => {
      asked += 1;
      return original(...args);
    };
    await run(harness, ['ACME-1']);
    await harness.drain();
    expect(asked).toBe(0);
  });
});
