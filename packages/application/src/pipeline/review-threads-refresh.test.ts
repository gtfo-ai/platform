/**
 * The review-thread count after a resolution — WP-90, PROGRESS backlog 210, criterion 3.
 *
 * Driven through the real handlers, the real `pipeline.outbound` duty and the real
 * `IntegrationActionExecutor` over the in-memory doubles. Every assertion is on a countable effect:
 * the `review_threads` column, the `list_discussions` audit rows, the `task.stage.returned` events
 * — never on a return value.
 *
 * The proving case is a **resolution-only** delivery: no comment arrives, so BD-007's window never
 * opens, and the count can only have moved because the resolution signal re-read it.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { markTransactions } from '../events/open-transaction.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { staticPipelineIntegrations } from './integrations.js';
import type { PipelineOutboundData } from './jobs.js';
import { runReviewThreadsRefresh } from './review-threads-refresh.js';
import { staticProjectSettings } from './settings.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as Id;
const IID = 7;
const HEAD = 'b'.repeat(40);
const MR_URL = `https://git.example.test/acme/api/-/merge_requests/${IID}`;

const REFINED_SPEC = {
  goal: 'Show the totals.',
  user_value: 'Finance can read an invoice.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac1',
      given: 'an invoice',
      when: 'it renders',
      // biome-ignore lint/suspicious/noThenProperty: the published field name
      then: 'the footer sums the lines',
      validation: { kind: 'test', value: 'totals.test.ts' },
    },
  ],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: 'documented' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const PLAN = {
  approach: 'Sum the model.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'sum the model' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'no flag',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};

const NOTES = {
  summary: 'Summed the model.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [],
  known_gaps: [],
  followup_tickets: [],
  mr: { url: MR_URL, iid: IID, head_sha: HEAD, branch: 'agentic/acme-1' },
};

const completedRun = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

const mergeRequest = () => ({
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid: IID,
    url: MR_URL,
    branch: 'agentic/acme-1',
    head_sha: HEAD,
  },
  state: 'opened' as const,
  draft: true,
  title: 'Draft: totals',
  description: '',
  source_branch: 'agentic/acme-1',
  target_branch: 'main',
  head_sha: HEAD,
  mergeable: true,
  has_conflicts: false,
  labels: [],
  reviewers: [],
  web_url: MR_URL,
});

const HUMAN = {
  provider: 'fake-git',
  external_id: '42',
  email: null,
  display_name: 'A human',
  verified: true,
};

const thread = (id: string, resolved: boolean, body = 'please rename this') => ({
  id,
  resolvable: true,
  resolved,
  notes: [
    {
      id: `${id}-note`,
      author: HUMAN,
      body,
      created_at: '2026-06-01T09:00:00.000Z',
      path: null,
      line: null,
      system: false,
    },
  ],
});

interface World {
  readonly harness: PipelineHarness;
  /** What `listDiscussions` answers — replaced by a case to stage the reviewer's resolution. */
  threads: ReturnType<typeof thread>[];
}

const startWorld = (): World => {
  const world = { threads: [thread('t1', false), thread('t2', false)] } as World;
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: completedRun(REFINED_SPEC),
      architecture: completedRun(PLAN),
      implementation: completedRun(NOTES),
      code_review: completedRun({
        verdict: 'approve',
        findings: [],
        summary: 'Reviewed.',
        protected_path_changes_confirmed: [],
      }),
      business_review: completedRun({
        verdict: 'approve',
        criteria: [{ id: 'ac1', status: 'met', evidence: 'test' }],
        scope_creep: [],
        missing: [],
        ux_notes: [],
      }),
    },
    git: {
      getPipelineStatus: async () => ({
        id: 'pipeline-1',
        head_sha: HEAD,
        status: 'success',
        url: null,
        jobs: [],
        coverage_pct: null,
        finished_at: '2026-06-01T09:30:00.000Z',
      }),
      getMergeRequest: async () => mergeRequest(),
      listDiscussions: async () => world.threads,
    } as never,
  });
  return Object.assign(world, { harness });
};

let stream = 0;
const event = (type: string, payload: Record<string, unknown>): DomainEvent => {
  stream += 1;
  const suffix = stream.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type as keyof typeof domainEventSchemasByType].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-git' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const ticketMatched = () =>
  event('ticket.matched', {
    project_id: PROJECT,
    ticket: {
      provider: 'fake-jira',
      key: 'ACME-1',
      url: 'https://jira.example.test/browse/ACME-1',
    },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const updated = (flag: boolean | undefined, iid = IID) =>
  event('mr.updated', {
    project_id: PROJECT,
    task_id: null,
    mr: { ...mergeRequest().ref, iid },
    draft: false,
    head_sha: HEAD,
    diff_stats: null,
    updated_at: '2026-06-01T10:00:00.000Z',
    ...(flag === undefined ? {} : { blocking_threads_resolved: flag }),
  });

const comment = (resolved: boolean, text = 'looks good now') =>
  event('mr.review.comment', {
    project_id: PROJECT,
    task_id: null,
    mr: mergeRequest().ref,
    thread_id: 't1',
    author: HUMAN,
    text,
    resolved,
  });

const taskOf = (harness: PipelineHarness) => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const listReads = (harness: PipelineHarness) =>
  harness.audit.entries.filter((entry) => entry.action === 'list_discussions').length;

const returns = (harness: PipelineHarness) =>
  harness.types().filter((type) => type === 'task.stage.returned').length;

/** A task at `ready_for_merge` whose count a window already wrote as two open threads. */
const atReadyWithTwoOpen = async (): Promise<World> => {
  const world = startWorld();
  await world.harness.publish([ticketMatched()]);
  expect(taskOf(world.harness).task.state).toBe('ready_for_merge');
  // The window's own first reading, so there is a stale number for the refresh to replace.
  const task = taskOf(world.harness).task;
  await world.harness.memory.transaction(async (scope) =>
    world.harness.store.tasks.saveReviewThreads(scope.tx, task.id, {
      open: 2,
      resolved: 0,
      checked_at: '2026-06-01T09:05:00.000Z',
    }),
  );
  return world;
};

describe('the review-thread count after a resolution (backlog 210)', () => {
  it('re-counts on a resolution-only delivery, and never returns the task', async () => {
    const world = await atReadyWithTwoOpen();
    const readsBefore = listReads(world.harness);
    const returnsBefore = returns(world.harness);
    // The reviewer resolves both threads without a note: GitLab's merge-request hook, nothing else.
    world.threads = [thread('t1', true), thread('t2', true)];
    await world.harness.publish([updated(true)]);
    await world.harness.drain();

    expect(taskOf(world.harness).reviewThreads).toMatchObject({ open: 0, resolved: 2 });
    expect(taskOf(world.harness).reviewThreads?.checked_at).not.toBe('2026-06-01T09:05:00.000Z');
    expect(listReads(world.harness) - readsBefore).toBe(1);
    expect(returns(world.harness)).toBe(returnsBefore);
    expect(taskOf(world.harness).task.state).toBe('ready_for_merge');
  });

  it('counts a thread re-opened without a comment, and still leaves the decision to the window', async () => {
    const world = await atReadyWithTwoOpen();
    world.threads = [thread('t1', false), thread('t2', false), thread('t3', false)];
    const returnsBefore = returns(world.harness);
    await world.harness.publish([updated(false)]);
    await world.harness.drain();
    expect(taskOf(world.harness).reviewThreads).toMatchObject({ open: 3, resolved: 0 });
    expect(returns(world.harness)).toBe(returnsBefore);
  });

  it('re-counts on a note written into a resolved thread, which the window ignores', async () => {
    const world = await atReadyWithTwoOpen();
    world.threads = [thread('t1', true), thread('t2', false)];
    const readsBefore = listReads(world.harness);
    await world.harness.publish([comment(true)]);
    await world.harness.drain();
    expect(taskOf(world.harness).reviewThreads).toMatchObject({ open: 1, resolved: 1 });
    expect(listReads(world.harness) - readsBefore).toBe(1);
  });

  it('reads nothing for an update that did not change the resolution, or a platform note', async () => {
    const world = await atReadyWithTwoOpen();
    world.threads = [thread('t1', true), thread('t2', true)];
    const readsBefore = listReads(world.harness);
    await world.harness.publish([
      updated(undefined),
      comment(true, '<!-- agentic:conflict-warning:abc --> overlaps with another task'),
    ]);
    await world.harness.drain();
    expect(listReads(world.harness)).toBe(readsBefore);
    expect(taskOf(world.harness).reviewThreads).toMatchObject({ open: 2, resolved: 0 });
  });

  it('reads nothing for a merge request no waiting task owns', async () => {
    const world = await atReadyWithTwoOpen();
    const readsBefore = listReads(world.harness);
    await world.harness.publish([updated(true, 99)]);
    await world.harness.drain();
    expect(listReads(world.harness)).toBe(readsBefore);
  });

  it('re-validates on fire: a task that moved on, or a merge request it no longer waits on, is not read', async () => {
    const world = await atReadyWithTwoOpen();
    const task = taskOf(world.harness).task;
    const options = {
      store: world.harness.store,
      settings: staticProjectSettings(() => world.harness.settings),
      jobs: world.harness.jobs,
      calendar: world.harness.calendar,
      integrations: staticPipelineIntegrations(world.harness.integrations),
      ids: world.harness.ids,
      clock: { now: () => world.harness.clock.now() },
      unitOfWork: markTransactions(world.harness.memory),
    };
    const data = (iid: number): PipelineOutboundData => ({
      duty: 'review_threads_refresh',
      project_id: PROJECT,
      task_id: task.id,
      cause_event_id: '00000000-0000-4000-9000-00000000ffff',
      iid,
    });
    const readsBefore = listReads(world.harness);
    // A rework moved `mr_ref` to another merge request between the signal and the job.
    await runReviewThreadsRefresh(options, data(IID + 1));
    expect(listReads(world.harness)).toBe(readsBefore);
    // The same wake-up for the merge request it does wait on reads once — the boundary's other side.
    await runReviewThreadsRefresh(options, data(IID));
    expect(listReads(world.harness)).toBe(readsBefore + 1);
    // No git binding: nothing read, nothing written — `{open: 0}` would claim a reading.
    const before = taskOf(world.harness).reviewThreads;
    await runReviewThreadsRefresh(
      {
        ...options,
        integrations: staticPipelineIntegrations({ ...world.harness.integrations, git: null }),
      },
      data(IID),
    );
    expect(taskOf(world.harness).reviewThreads).toEqual(before);
  });
});
