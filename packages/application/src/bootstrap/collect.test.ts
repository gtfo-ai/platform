/**
 * The collection: what it reads, how it chunks it, and what it refuses (WP-35).
 *
 * The assertions are on the **rows and the tasks** the collection leaves behind, and on the
 * **audit log** for what actually reached a provider — a test that read the report object would be
 * green on a collection that made no call and created no task (standing rule 79's shape).
 *
 * The one that matters most is the **task's own `history_sample`**: the mining run's whole input is
 * that column, so a collection that created tasks with an empty one would look identical here and
 * produce nothing in production (standing rule 82, one ring in).
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { HISTORY_BOOTSTRAP_TEMPLATE_ID } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import { staticProjectSettings } from '../pipeline/settings.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { IntegrationError, IntegrationUnsupportedError } from '../ports/integrations/common.js';
import type {
  Discussion,
  GitProviderPort,
  MergedMergeRequest,
} from '../ports/integrations/git-provider.js';
import type { Ticket, TicketMatch } from '../ports/integrations/task-management.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { collectHistory } from './collect.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const AT = '2026-09-14T10:00:00.000Z';

const noopRedactor: SecretRedactor = {
  redactText: (text: string) => ({ value: text, count: 0 }),
  redactJson: (value: unknown) => ({ value, count: 0 }),
} as SecretRedactor;

const mergedMr = (iid: number): MergedMergeRequest =>
  ({
    ref: {
      provider: 'fake-git',
      project_path: 'acme/api',
      iid,
      url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
      branch: `feature/${iid}`,
      head_sha: 'a'.repeat(40),
    },
    author: {
      provider: 'fake-git',
      external_id: 'dana',
      email: null,
      display_name: 'Dana Reviewer',
      verified: true,
    },
    merged_at: '2026-05-29T09:12:00.000Z',
    title: `Merge request ${iid}`,
    diff_stats: null,
    discussion_count: 1,
  }) as MergedMergeRequest;

const note = (body: string): Discussion =>
  ({
    id: 'd1',
    resolvable: true,
    resolved: false,
    notes: [
      {
        id: 'n1',
        author: {
          provider: 'fake-git',
          external_id: 'dana',
          email: null,
          display_name: 'Dana Reviewer',
          verified: true,
        },
        body,
        created_at: '2026-05-28T09:00:00.000Z',
        system: false,
      },
    ],
  }) as Discussion;

interface WorldOptions {
  readonly merged?: number;
  readonly commits?: readonly string[];
  readonly commitsUnsupported?: boolean;
  readonly matches?: readonly string[];
  readonly statusMapping?: Readonly<Record<string, string>> | undefined;
  /** Scripts the mining stage, so a chunk's run actually happens and its prompt can be read. */
  readonly runsMining?: boolean;
  /** Extra git behaviour over the defaults below (WP-59: the diff-stats read). */
  readonly git?: Partial<GitProviderPort>;
}

const world = (options: WorldOptions = {}) => {
  const merged = Array.from({ length: options.merged ?? 3 }, (_, index) => mergedMr(index + 1));
  return createPipelineHarness({
    projectId: PROJECT,
    settings: {
      config: {
        features: { history_bootstrap: { enabled: true } },
        status_mapping:
          options.statusMapping === undefined ? { done: 'Done' } : options.statusMapping,
      },
    },
    runs:
      options.runsMining === true
        ? {
            history_mining: {
              status: 'completed' as const,
              terminalReason: 'success' as const,
              structuredOutput: {
                proposals: [],
                merge_requests_read: 2,
                summary: 'nothing repeatable in this slice',
              } as never,
            },
          }
        : {},
    git: {
      listMergedMergeRequests: async () => merged,
      listDiscussions: async () => [note('Use the money helper.')],
      listCommits: async () => {
        if (options.commitsUnsupported === true) {
          throw new IntegrationUnsupportedError('fake-git', 'list_commits');
        }
        return (options.commits ?? ['fix(totals): round once']).map((message) => ({
          sha: 'b'.repeat(40),
          message,
          author: 'Dana Reviewer',
          committed_at: '2026-05-29T09:12:00.000Z',
          url: null,
        }));
      },
      ...options.git,
    },
    taskManagement: {
      matchTickets: async () =>
        (options.matches ?? ['ACME-3']).map(
          (key) =>
            ({
              ref: {
                provider: 'fake-jira',
                key,
                url: `https://jira.example.test/browse/${key}`,
              },
              issue_type: 'Story',
              links: [],
              updated_at: AT,
            }) as TicketMatch,
        ),
      readTicket: async (ref: { key: string; url: string; provider: string }) =>
        ({
          ref,
          issue_type: 'Story',
          title: `Closed ${ref.key}`,
          description: 'Rounding happens twice.',
          status: 'Done',
          priority: null,
          labels: [],
          comments: [],
          links: [],
          epic: null,
          siblings: [],
          attachments_text: [],
          assignee: null,
          reporter: null,
          updated_at: AT,
        }) as Ticket,
    },
  });
};

/** Creates the batch row the collection expects to find, at the size this test wants. */
const seedBatch = async (
  harness: PipelineHarness,
  input: {
    readonly mergeRequests: number;
    readonly batchSize: number;
    readonly capUsd?: number;
  },
): Promise<Id> => {
  const id = harness.ids.next();
  await harness.memory.transaction(async (scope) => {
    await harness.bootstrap.createBatch(scope.tx, {
      id,
      projectId: PROJECT,
      requestedBy: null,
      mergeRequests: input.mergeRequests,
      batchSize: input.batchSize,
      days: 183,
      capUsd: input.capUsd ?? 20,
      estimatedUsd: 4,
    });
  });
  return id;
};

const collect = async (harness: PipelineHarness, batchId: Id) =>
  collectHistory(
    {
      unitOfWork: harness.memory,
      store: harness.store,
      bootstrap: harness.bootstrap,
      settings: staticProjectSettings(() => harness.settings),
      integrations: staticPipelineIntegrations(harness.integrations),
      jobs: harness.jobs,
      ids: harness.ids,
      clock: { now: () => harness.clock.now() as IsoDateTime },
      baseUrl: 'https://app.example.test',
      redactor: noopRedactor,
    },
    { batchId, projectId: PROJECT },
  );

const tasksOf = async (harness: PipelineHarness) =>
  harness.memory.transaction(async (scope) => {
    const rows = [];
    for (const chunk of harness.bootstrap.chunksOf(harness.bootstrap.batches[0]?.id as Id)) {
      const stored = await harness.store.tasks.load(scope.tx, chunk.taskId);
      if (stored !== null) rows.push(stored);
    }
    return rows;
  });

describe('collecting a project’s merged history', () => {
  it('chunks the merge requests into one task each, with the sample on the task row', async () => {
    const harness = world({ merged: 5 });
    const batchId = await seedBatch(harness, { mergeRequests: 5, batchSize: 2 });
    const report = await collect(harness, batchId);

    expect(report.status).toBe('collected');
    // Five merge requests at two per run is three runs — the last one short, which is a run.
    expect(report.chunks).toBe(3);
    const chunks = harness.bootstrap.chunksOf(batchId);
    expect(chunks.map((chunk) => chunk.mergeRequests)).toEqual([2, 2, 1]);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual([0, 1, 2]);

    const tasks = await tasksOf(harness);
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task.task.template).toBe(HISTORY_BOOTSTRAP_TEMPLATE_ID);
      // The whole input of a mining run. A collection that created tasks with no sample would be
      // indistinguishable here without this assertion (standing rule 82).
      expect(task.historySample).not.toBeNull();
      expect(task.historySample?.merge_requests.length).toBeGreaterThan(0);
      expect(task.historySample?.evidence_links.length).toBeGreaterThan(0);
    }
    // …and every ticket key is distinct, because `unique (project_id, ticket_key, mode)` decides.
    expect(new Set(tasks.map((task) => task.task.ticket.key)).size).toBe(3);

    // The batch moves to `mining` in the same transaction as the chunks.
    expect(harness.bootstrap.batches[0]?.status).toBe('mining');
  });

  it('reads the provider once per merge request for its discussions, and says so in the audit', async () => {
    const harness = world({ merged: 3 });
    const batchId = await seedBatch(harness, { mergeRequests: 3, batchSize: 20 });
    await collect(harness, batchId);

    const actions = harness.audit.entries.map((entry) => entry.action);
    // `1 + N` — the shape PROGRESS backlog 64 records, made visible rather than described.
    expect(actions.filter((action) => action === 'list_merged_merge_requests')).toHaveLength(1);
    expect(actions.filter((action) => action === 'list_discussions')).toHaveLength(3);
    expect(actions.filter((action) => action === 'list_commits')).toHaveLength(1);
    expect(actions.filter((action) => action === 'match_tickets')).toHaveLength(1);
    expect(actions.filter((action) => action === 'read_ticket')).toHaveLength(1);
    // WP-59: one diff-stats read per merge request whose listing carried none — every one of these
    // three, as on GitLab (backlog 113).
    expect(actions.filter((action) => action === 'get_merge_request_diff_stats')).toHaveLength(3);
  });

  it('fills a mined merge request’s size from the diff-stats read, and says how many it lost', async () => {
    // Merge request 1 answers stats, the others answer "not computed": the sample carries the one
    // size it was given and the batch says, by count, what it did not get (backlog 113).
    const harness = world({
      merged: 3,
      git: {
        getMergeRequestDiffStats: async (ref) =>
          ref.iid === 1 ? { files_changed: 4, insertions: 30, deletions: 5 } : null,
      },
    });
    const batchId = await seedBatch(harness, { mergeRequests: 3, batchSize: 20 });
    const report = await collect(harness, batchId);

    const [task] = await tasksOf(harness);
    const sizes = Object.fromEntries(
      (task?.historySample?.merge_requests ?? []).map((mr) => [mr.ref, mr.files_changed]),
    );
    expect(sizes).toEqual({ '!1': 4, '!2': null, '!3': null });
    expect(report.reason).toContain('published no diff stats for 2 of 3 merge request(s)');
  });

  it('mines without sizes rather than failing when the provider refuses the diff-stats read', async () => {
    const harness = world({
      merged: 2,
      git: {
        getMergeRequestDiffStats: async () => {
          throw new IntegrationError('forbidden', 'fake-git', 'no GraphQL here');
        },
      },
    });
    const batchId = await seedBatch(harness, { mergeRequests: 2, batchSize: 20 });
    const report = await collect(harness, batchId);
    expect(report.status).toBe('collected');
    expect(harness.bootstrap.batches[0]?.status).toBe('mining');
    expect(report.reason).toContain('published no diff stats for 2 of 2');
  });

  it('marks a batch empty when nothing was merged in the window, and creates no task', async () => {
    const harness = world({ merged: 0 });
    const batchId = await seedBatch(harness, { mergeRequests: 20, batchSize: 20 });
    const report = await collect(harness, batchId);

    expect(report.status).toBe('empty');
    expect(harness.bootstrap.batches[0]?.status).toBe('empty');
    expect(harness.bootstrap.batches[0]?.detail).toContain('no merge request');
    expect(harness.bootstrap.batches[0]?.completedAt).not.toBeNull();
    expect(harness.bootstrap.chunksOf(batchId)).toEqual([]);
  });

  it('carries on without the commit half when the provider does not list commits', async () => {
    // Standing rule 20: this is a read the bootstrap can do without, so it is recorded as absent
    // rather than failing a collection that has merge requests and tickets in hand.
    const harness = world({ commitsUnsupported: true });
    const batchId = await seedBatch(harness, { mergeRequests: 20, batchSize: 20 });
    const report = await collect(harness, batchId);

    expect(report.status).toBe('collected');
    expect(report.commits).toBe(0);
    expect(report.reason).toContain('does not list commits');
    const tasks = await tasksOf(harness);
    expect(tasks[0]?.historySample?.commits).toEqual([]);
    expect(tasks[0]?.historySample?.merge_requests.length).toBeGreaterThan(0);
  });

  it('mines no tickets when the project maps no status to done, and names the reason', async () => {
    // The platform has no definition of "closed" that is not a project's own status mapping
    // (`shadow/batch.ts` states it), so guessing would mine whatever a project calls its last
    // column. The refusal is a **note on the batch**, not a failure.
    const harness = world({ statusMapping: {} });
    const batchId = await seedBatch(harness, { mergeRequests: 20, batchSize: 20 });
    const report = await collect(harness, batchId);

    expect(report.status).toBe('collected');
    expect(report.tickets).toBe(0);
    expect(report.reason).toContain('no ticket status to `done`');
    expect(harness.audit.entries.map((entry) => entry.action)).not.toContain('match_tickets');
  });

  it('does nothing on a redelivery once the batch has moved past collecting', async () => {
    // pg-boss is at-least-once. A redelivery after the write transaction must not create a second
    // set of tasks for the same history.
    const harness = world({ merged: 2 });
    const batchId = await seedBatch(harness, { mergeRequests: 2, batchSize: 20 });
    await collect(harness, batchId);
    const first = harness.bootstrap.chunksOf(batchId).length;

    const again = await collect(harness, batchId);
    expect(again.status).toBe('skipped');
    expect(again.reason).toContain('already mining');
    expect(harness.bootstrap.chunksOf(batchId)).toHaveLength(first);
  });

  it('stops a mining run when the batch’s cap is spent, and admits one when it is not', async () => {
    /**
     * The per-batch cap at admission (product/19 §18's *"budget cap default $20"*), **both
     * directions in one case** (standing rule 42): the guard adds what this run *may* spend to what
     * the batch *has*, so a cap of 2.2 against a run budget of 2 admits a batch that has spent
     * nothing and refuses one that has spent 0.40.
     *
     * It is here rather than only in the e2e because the e2e is a three-minute tier and this is a
     * one-line guard — and because a canary that disables it must die somewhere fast (rule 3). The
     * e2e still owns the **composition**: this store is a double, and the production
     * `createPipelineRuntime` call is what a `bootstrap:` it forgot to pass would break (it did).
     */
    const admitted = world({ merged: 2, runsMining: true });
    const openBatch = await seedBatch(admitted, { mergeRequests: 2, batchSize: 20, capUsd: 2.2 });
    await collect(admitted, openBatch);
    await admitted.publish([]);
    expect(admitted.specs.filter((spec) => spec.stage === 'history_mining')).toHaveLength(1);

    const spent = world({ merged: 2, runsMining: true });
    const spentBatch = await seedBatch(spent, { mergeRequests: 2, batchSize: 20, capUsd: 2.2 });
    await collect(spent, spentBatch);
    // The ledger's own number, seeded before the run is admitted — `capForTask` reads it.
    spent.bootstrap.seedSpend(spentBatch, 0.4);
    await spent.publish([]);
    expect(spent.specs.filter((spec) => spec.stage === 'history_mining')).toEqual([]);
    // …and the ending is the ordinary one: the task is **paused**, so a human raising the cap is
    // the way out rather than a state of its own.
    expect(spent.store.snapshot().map((task) => task.task.state)).toEqual(['paused']);
  });

  it('stops a mining run on a run of the batch the ledger has not recorded yet', async () => {
    /**
     * **The race the cap had, measured on WP-40's tree and closed here** (`../cost/pending.ts`).
     *
     * The ledger writes `cost_entries` from a handler on `run.finished`, *after* the run's own
     * transaction, so the second chunk of a batch is admitted while the first chunk's spend is
     * still invisible: with the handler delayed by 8 s, the batch's e2e admitted **two** runs
     * against a cap that allows **one**, three times out of three. `capForTask` therefore answers a
     * second number — the batch's runs with no ledger row, valued at what a run of this stage may
     * spend — and this case is that number doing the stopping with the ledger at **zero**.
     *
     * The other direction is the case above: the same cap with nothing spent and nothing in flight
     * admits the run (standing rule 42).
     */
    const harness = world({ merged: 2, runsMining: true });
    const batchId = await seedBatch(harness, { mergeRequests: 2, batchSize: 20, capUsd: 2.2 });
    await collect(harness, batchId);
    // Nothing charged, one run of this batch still unaccounted for: 0 + 2 + 2 > 2.2.
    harness.bootstrap.seedSpend(batchId, 0);
    harness.bootstrap.seedPendingRuns(batchId, 1);
    await harness.publish([]);

    expect(harness.specs.filter((spec) => spec.stage === 'history_mining')).toEqual([]);
    expect(harness.store.snapshot().map((task) => task.task.state)).toEqual(['paused']);
  });

  it('runs one mining stage per chunk, each on its own slice of the history', async () => {
    /**
     * The assertion rule 82 asks for, one ring below the e2e: the run's **prompt** is what this
     * work package produces, so the test reads it rather than counting jobs.
     *
     * `intake` is a system stage that completes inside the collection's own transaction, so the
     * agent stage is enqueued by the saga on the next dispatch — which is why this settles the
     * harness first (`discovery.test.ts` states the same ordering).
     */
    const harness = world({ merged: 4, runsMining: true });
    const batchId = await seedBatch(harness, { mergeRequests: 4, batchSize: 2 });
    await collect(harness, batchId);
    await harness.publish([]);

    const mining = harness.specs.filter((spec) => spec.stage === 'history_mining');
    expect(mining).toHaveLength(2);
    // Each run was shown its **own** two merge requests and not the batch's four: the sample is a
    // window on the history, and a collection that handed every run the whole list would cost four
    // times the tokens and produce four copies of the same proposals.
    const first = mining[0]?.userPrompt ?? '';
    const second = mining[1]?.userPrompt ?? '';
    expect(first).toContain('--- merge request !1 ---');
    expect(first).toContain('--- merge request !2 ---');
    expect(first).not.toContain('--- merge request !3 ---');
    expect(second).toContain('--- merge request !3 ---');
    expect(second).toContain('--- merge request !4 ---');
    // …and the review comments are in the prompt, which is the half `MergedMergeRequest` has not.
    expect(first).toContain('Use the money helper.');
    // Every run is a `bootstrap` run, which is the column a screen and the statistics read.
    expect(new Set(mining.map((spec) => spec.mode))).toEqual(new Set(['bootstrap']));
  });
});
