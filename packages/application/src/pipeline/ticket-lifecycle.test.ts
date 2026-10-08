/**
 * WP-177 — the claim, the release, the intake skip, the lifecycle moments and `status_mapping`
 * superseded (BD-031 rulings 2, 3 and 5; TD-029 decisions 1, 3, 4, 5 and 9).
 *
 * Driven through the real handlers, the real interpreter and the real stage executor over the
 * harness, with a small tracker double that keeps one ticket's assignee, status and comments, so
 * every criterion is asserted as calls on a tracker and rows the platform wrote.
 *
 * Every status name here is an invented fixture value (BD-031 ruling 1).
 */
import type {
  DomainEvent,
  ExternalIdentity,
  Id,
  Slug,
  StoredTicketClaim,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { resolveIterationLimits } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { IntegrationError } from '../ports/integrations/common.js';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import type { BindingLifecycle } from './binding-lifecycle.js';
import { cancelTaskCommand, reworkStageCommand } from './commands.js';
import { staticPipelineIntegrations } from './integrations.js';
import { staticProjectSettings } from './settings.js';
import { INITIAL_TASK_VERSION, type StoredTask } from './store.js';
import { CLAIM_REFUSED_COMMENT, ensureTicketClaim } from './ticket-claim.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const USER = '00000000-0000-4000-8000-0000000000e9' as Id;
const SELF_ID = 'agentic-bot';

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
} as const;

const identity = (external_id: string): ExternalIdentity => ({
  provider: 'fake-jira',
  external_id,
  verified: false,
});

// ── The tracker double ──────────────────────────────────────────────────────

interface TrackerOptions {
  readonly assignee?: string | null;
  readonly status?: string;
  /** Somebody assigns the ticket to themselves right after the platform's assign (the race). */
  readonly stealAfterAssign?: string;
  /** The assign is refused, as Jira refuses it without *Assign Issues*. */
  readonly forbidAssign?: boolean;
  /** Runs right after the platform's assign lands — a person's action racing the claim's record. */
  readonly afterAssign?: () => Promise<void>;
  /** Runs before the platform's unassign reads the assignee — a release racing a re-claim. */
  readonly beforeUnassign?: () => Promise<void>;
}

/** One ticket's assignee, status and comments, and every lifecycle call made on it, in order. */
const tracker = (options: TrackerOptions = {}) => {
  const state = {
    assignee: options.assignee ?? null,
    status: options.status ?? 'Ready for the agent',
    comments: [] as { readonly markerId: string | null; readonly body: string }[],
  };
  const calls: string[] = [];
  /** Every `readTicket`, kept apart from `calls` because the snapshot and the planner read too. */
  const reads: string[] = [];
  const port: Partial<TaskManagementPort> = {
    readTicket: async (ref: TicketRefInput) => {
      reads.push(ref.key);
      return {
        ref,
        issue_type: 'Story',
        title: 'Show the totals in the invoice footer',
        description: 'The footer sums the visible rows rather than all of them.',
        status: state.status,
        priority: null,
        labels: [],
        comments: [],
        links: [],
        epic: null,
        siblings: [],
        attachments_text: [],
        assignee: state.assignee === null ? null : identity(state.assignee),
        reporter: null,
        updated_at: '2026-06-01T09:00:00.000Z',
      };
    },
    selfIdentity: async () => {
      calls.push('selfIdentity');
      return identity(SELF_ID);
    },
    assignToSelf: async () => {
      calls.push('assignToSelf');
      if (options.forbidAssign === true) {
        throw new IntegrationError('forbidden', 'fake-jira', 'the account may not assign issues', {
          action: 'assign_to_self',
        });
      }
      const changed = state.assignee !== SELF_ID;
      state.assignee = options.stealAfterAssign ?? SELF_ID;
      await options.afterAssign?.();
      return { changed, assignee: identity(SELF_ID) };
    },
    unassign: async () => {
      calls.push('unassign');
      await options.beforeUnassign?.();
      if (state.assignee !== SELF_ID) {
        return { changed: false };
      }
      state.assignee = null;
      return { changed: true };
    },
    transition: async (_ref: TicketRefInput, to: string) => {
      calls.push(`transition:${to}`);
      const from = state.status;
      state.status = to;
      return { changed: from !== to, from, to };
    },
    addComment: async (
      _ref: TicketRefInput,
      body: string,
      commentOptions?: { readonly markerId?: string | null },
    ) => {
      state.comments.push({ markerId: commentOptions?.markerId ?? null, body });
      return {
        provider: 'fake-jira',
        ticket_key: TICKET.key,
        comment_id: `c-${String(state.comments.length)}`,
        url: null,
        marker_id: commentOptions?.markerId ?? null,
      };
    },
  };
  return {
    state,
    calls,
    reads,
    port,
    /** The lifecycle calls only — the claim's and the moments' writes, never the workpad. */
    lifecycleCalls: () =>
      calls.filter(
        (call) =>
          call === 'selfIdentity' ||
          call === 'assignToSelf' ||
          call === 'unassign' ||
          call.startsWith('transition:'),
      ),
  };
};

// ── Fixtures: the feature template, every stage approving ──────────────────

const REFINED_SPEC = {
  goal: 'Show the totals in the invoice footer.',
  user_value: 'Finance can read the invoice without a calculator.',
  in_scope: ['the footer'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac1',
      given: 'an invoice with three lines',
      when: 'it is rendered',
      // biome-ignore lint/suspicious/noThenProperty: it is the published field name
      then: 'the footer shows the sum',
      validation: { kind: 'test', value: 'totals.test.ts' },
    },
  ],
  non_functional: [],
  dependencies: [],
  size: 'M',
  drift: { flag: false, justification: 'in the documented direction' },
  assumptions: [],
  questions: [],
  decision: 'proceed',
  kb_citations: [],
};

const PLAN = {
  approach: 'Sum the lines in the renderer.',
  alternatives_considered: [],
  affected_modules: ['invoices'],
  files_to_change: [{ path: 'src/totals.ts', change: 'add the sum' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [{ criterion_id: 'ac1', check: { kind: 'test', value: 'totals.test.ts' } }],
  test_plan: ['totals.test.ts'],
  rollout_notes: 'none',
  risks: [],
  estimated_size: 'M',
  decisions_to_record: [],
  protected_path_changes: [],
};

const NOTES = {
  summary: 'Added the footer sum.',
  deviations_from_plan: [],
  tests_added: ['totals.test.ts'],
  commands_run: [{ command: 'npm test', exit_code: 0, summary: 'green' }],
  known_gaps: [],
  followup_tickets: [],
  mr: {
    url: 'https://git.example.test/acme/api/-/merge_requests/7',
    iid: 7,
    head_sha: 'b'.repeat(40),
    branch: 'agentic/acme-1',
  },
};

const REVIEW = (verdict: 'approve' | 'request_changes') => ({
  verdict,
  findings:
    verdict === 'approve'
      ? []
      : [
          {
            id: 'f1',
            severity: 'major',
            category: 'correctness',
            file: 'src/totals.ts',
            line: 3,
            explanation: 'the footer sums the visible rows',
            suggestion: 'sum the model',
          },
        ],
  summary: 'Reviewed.',
  protected_path_changes_confirmed: [],
});

const ACCEPTANCE = {
  verdict: 'approve',
  criteria: [{ id: 'ac1', status: 'met', evidence: 'test' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
};

const RETRO = {
  what_went_well: ['the plan held'],
  returns: [],
  human_corrections: [],
  cost_summary: { total_usd: 1.25, is_estimate: false, by_stage: [] },
  proposals: [],
};

const LIBRARIAN = { proposals: [], health: [], summary: 'nothing to add' };

const completed = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

const happyRuns = () => ({
  refinement: completed(REFINED_SPEC),
  architecture: completed(PLAN),
  implementation: completed(NOTES),
  code_review: completed(REVIEW('approve')),
  business_review: completed(ACCEPTANCE),
  retrospective: completed(RETRO),
  librarian: completed(LIBRARIAN),
});

const mergeRequest = {
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid: 7,
    url: 'https://git.example.test/acme/api/-/merge_requests/7',
    branch: 'agentic/acme-1',
    head_sha: 'b'.repeat(40),
  },
  state: 'opened' as const,
  draft: true,
  title: 'Draft: totals',
  description: '',
  source_branch: 'agentic/acme-1',
  target_branch: 'main',
  head_sha: 'b'.repeat(40),
  mergeable: true,
  has_conflicts: false,
  labels: [],
  reviewers: [],
  web_url: 'https://git.example.test/acme/api/-/merge_requests/7',
};

/** The binding's lifecycle, as the settings port reads it off the binding. */
const lifecycle = (
  slots: BindingLifecycle['slots'],
  pickUpFrom: string | null = 'Ready for the agent',
): BindingLifecycle => ({ pickUpFrom, slots });

const harnessFor = (
  ticket: ReturnType<typeof tracker>,
  ticketLifecycle: BindingLifecycle | null,
  options: HarnessOptions = {},
): PipelineHarness =>
  createPipelineHarness({
    projectId: PROJECT,
    runs: happyRuns(),
    git: {
      getPipelineStatus: async () => ({
        id: 'pipeline-1',
        head_sha: 'b'.repeat(40),
        status: 'success',
        url: null,
        jobs: [],
        coverage_pct: null,
        finished_at: '2026-06-01T09:30:00.000Z',
      }),
      getMergeRequest: async () => mergeRequest,
      // A rework closes the merge request it lets go of (WP-59): its comment and its close.
      closeMergeRequest: async (ref: { iid: number }) =>
        ({ ...mergeRequest, ref, state: 'closed' }) as never,
      createDiscussion: async () =>
        ({ id: 'd-1', resolvable: true, resolved: false, notes: [] }) as never,
    },
    taskManagement: ticket.port,
    ticketAssignPermission: 'Assign Issues',
    ...options,
    settings: { ticketLifecycle, ...options.settings },
  });

let streamCounter = 0;
const event = <T extends DomainEvent['type']>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>['payload'],
): DomainEvent => {
  streamCounter += 1;
  const suffix = streamCounter.toString(16).padStart(12, '0');
  return domainEventSchemasByType[type].parse({
    id: `00000000-0000-4000-9000-${suffix}`,
    stream_type: 'project',
    stream_id: `00000000-0000-4000-8000-${suffix}`,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'integration', integration_id: PROJECT, provider: 'fake-jira' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type,
    payload,
  }) as DomainEvent;
};

const ticketMatched = () =>
  event('ticket.matched', {
    project_id: PROJECT,
    ticket: { ...TICKET },
    rule: 'label:agentic',
    priority: 'High',
    issue_type: 'Story',
    epic: null,
    links: [],
  });

const merged = () =>
  event('mr.merged', {
    project_id: PROJECT,
    task_id: null,
    mr: mergeRequest.ref,
    draft: false,
    head_sha: 'b'.repeat(40),
    diff_stats: null,
    merge_commit_sha: 'c'.repeat(40),
  });

const taskOf = (harness: PipelineHarness): StoredTask => {
  const [stored] = harness.store.snapshot();
  if (stored === undefined) {
    throw new Error('no task was created');
  }
  return stored;
};

const claimOf = async (harness: PipelineHarness): Promise<StoredTicketClaim | null> =>
  harness.memory.transaction(async (scope) =>
    harness.store.tasks.ticketClaim(scope.tx, taskOf(harness).task.id),
  );

const eventsOf = (harness: PipelineHarness, type: string) =>
  harness.events().filter((entry) => entry.type === type);

const runsCreated = (harness: PipelineHarness): number => eventsOf(harness, 'run.created').length;

// ── (1)–(4): the claim ──────────────────────────────────────────────────────

describe('the claim before the first agent run (TD-029 decision 5)', () => {
  it('(1) assigns, moves to in_progress, re-reads, records ticket.claimed and starts the run', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }), {
      runs: { ...happyRuns(), architecture: completed(PLAN) },
    });
    await harness.publish([ticketMatched()]);

    // The claim's four steps, in order, before the first run: who am I, assign, in_progress.
    expect(ticket.lifecycleCalls().slice(0, 3)).toEqual([
      'selfIdentity',
      'assignToSelf',
      'transition:Doing',
    ]);
    expect(ticket.state.assignee).toBe(SELF_ID);
    const claimed = eventsOf(harness, 'ticket.claimed');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload).toMatchObject({
      account_id: SELF_ID,
      in_progress_written: true,
      shadow: false,
    });
    // `ticket.claimed` precedes the first run.
    const types = harness.types();
    expect(types.indexOf('ticket.claimed')).toBeLessThan(types.indexOf('run.created'));
    expect(await claimOf(harness)).toMatchObject({
      account_id: SELF_ID,
      status: 'confirmed',
      in_progress_written: true,
      stale: false,
      released_at: null,
    });
    // One claim for the whole task: later agent stages find it held and claim nothing.
    expect(ticket.calls.filter((call) => call === 'assignToSelf')).toHaveLength(1);
    expect(runsCreated(harness)).toBeGreaterThan(1);
  });

  it('(2) escalates ticket_assigned_elsewhere when the re-read shows another assignee: one marked comment, no run row', async () => {
    const ticket = tracker({ stealAfterAssign: 'jane' });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);

    const stored = taskOf(harness);
    expect(stored.task.state).toBe('needs_human');
    expect(stored.task.currentStage).toBe('refinement');
    const escalated = eventsOf(harness, 'task.escalated');
    expect(escalated).toHaveLength(1);
    expect((escalated[0]?.payload as { reason: string } | undefined)?.reason).toBe(
      'ticket_assigned_elsewhere',
    );
    expect(eventsOf(harness, 'ticket.claim.refused')[0]?.payload).toMatchObject({
      reason: 'ticket_assigned_elsewhere',
      assignee: { external_id: 'jane' },
    });
    // Canary (criterion 2): without the re-read the claim would be held and the run would start.
    expect(runsCreated(harness)).toBe(0);
    expect(harness.specs).toHaveLength(0);
    expect(ticket.state.comments).toEqual([
      { markerId: `agentic:claim-refused:${stored.task.id}`, body: CLAIM_REFUSED_COMMENT },
    ]);
    expect(eventsOf(harness, 'ticket.claimed')).toHaveLength(0);
    expect(await claimOf(harness)).toBeNull();
  });

  it('(3) escalates ticket_claim_failed with a brief naming Assign Issues when the assign is forbidden', async () => {
    const ticket = tracker({ forbidAssign: true });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);

    const stored = taskOf(harness);
    expect(stored.task.state).toBe('needs_human');
    const escalated = eventsOf(harness, 'task.escalated')[0]?.payload as {
      reason: string;
      blocker_brief: string;
    };
    expect(escalated.reason).toBe('ticket_claim_failed');
    expect(escalated.blocker_brief).toContain('Assign Issues');
    expect(escalated.blocker_brief).toContain('forbidden');
    expect(runsCreated(harness)).toBe(0);
    // A refused write is not somebody else's ticket: no comment on it.
    expect(ticket.state.comments).toEqual([]);
    expect(harness.audit.entriesFor('assign_to_self').map((entry) => entry.status)).toEqual([
      'failed',
    ]);
  });

  it('(4) in shadow mode the writes are would_have, the claim is recorded shadow, and the run proceeds', async () => {
    const ticket = tracker({ assignee: 'jane' });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness, { mode: 'shadow' });
    const taskId = stored.task.id;
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId,
      stage: 'refinement' as Slug,
      attempt: 1,
    });

    expect(outcome).toEqual({ kind: 'proceed' });
    // Nothing was written to the tracker: the ticket is still somebody else's, in its status.
    expect(ticket.state.assignee).toBe('jane');
    expect(ticket.state.status).toBe('Ready for the agent');
    expect(ticket.calls).toEqual(['selfIdentity']);
    expect(harness.audit.entriesFor('assign_to_self').map((entry) => entry.status)).toEqual([
      'would_have',
    ]);
    expect(harness.audit.entriesFor('transition_ticket').map((entry) => entry.status)).toEqual([
      'would_have',
    ]);
    const claim = await harness.memory.transaction(async (scope) =>
      harness.store.tasks.ticketClaim(scope.tx, taskId),
    );
    expect(claim).toMatchObject({ status: 'shadow', in_progress_written: false });
  });
});

/** A task inserted by hand at `refinement` attempt 1 — the claim asked directly, as `stage.execute` asks it. */
const insertTask = async (
  harness: PipelineHarness,
  overrides: Partial<StoredTask['task']> = {},
): Promise<StoredTask> => {
  const stored: StoredTask = {
    task: {
      id: '00000000-0000-4000-8000-00000000c0de' as Id,
      projectId: PROJECT,
      ticket: { ...TICKET },
      template: 'feature',
      mode: 'normal',
      state: 'active',
      currentStage: 'refinement',
      stageAttempts: { intake: 1, refinement: 1 },
      iterationCounters: {},
      limits: resolveIterationLimits(),
      sequence: 1,
      ...overrides,
    },
    template: harness.settings.templates.feature as StoredTask['template'],
    pipelineDial: null,
    qaStage: false,
    priorityRank: 2,
    createdAt: '2026-06-01T09:00:00.000Z',
    branch: null,
    mr: null,
    workpad: null,
    costActualUsd: 0,
    estimateUsd: null,
    estimateBasis: null,
    estimateSamples: null,
    version: INITIAL_TASK_VERSION,
    ticketSnapshot: null,
    ticketSnapshotAt: null,
    ticketSignalAt: null,
    reviewSubject: null,
    historySample: null,
    riskClasses: [],
    coverage: null,
    dependencies: null,
    requiredReviewers: null,
    reviewThreads: null,
    readyHeadSha: null,
    ciHeadSha: null,
    ciExcusedPaths: [],
    requestedByUserId: null,
  };
  await harness.memory.transaction(async (scope) => {
    await harness.store.tasks.insert(scope.tx, stored);
  });
  return stored;
};

const REFINEMENT_1 = { stage: 'refinement' as Slug, attempt: 1 };

const claimRecordOf = async (harness: PipelineHarness, taskId: Id) =>
  harness.memory.transaction(async (scope) => harness.store.tasks.ticketClaim(scope.tx, taskId));

describe('the WP-177 review amendment to TD-029 decision 5', () => {
  it('(c) gives a real assign back when the task is cancelled between the assign and the record', async () => {
    let harness: PipelineHarness | null = null;
    let taskId: Id | null = null;
    const ticket = tracker({
      afterAssign: async () => {
        const of = harness as PipelineHarness;
        await of.memory.transaction(async (scope) => {
          const current = (await of.store.tasks.load(scope.tx, taskId as Id)) as StoredTask;
          await of.store.tasks.save(scope.tx, {
            ...current,
            task: { ...current.task, state: 'cancelled' },
          });
        });
      },
    });
    harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }, null));
    const stored = await insertTask(harness);
    taskId = stored.task.id;
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'proceed' });
    await harness.drain();

    // Canary (amendment (c)): without the record transaction's check the claim is recorded held
    // and nothing gives the ticket back.
    expect(eventsOf(harness, 'ticket.claimed')).toHaveLength(0);
    expect(ticket.calls.filter((call) => call === 'unassign')).toHaveLength(1);
    expect(ticket.state.assignee).toBeNull();
    const released = eventsOf(harness, 'ticket.released');
    expect(released).toHaveLength(1);
    expect(released[0]?.payload).toMatchObject({ unassigned: true, cause: 'stopped' });
    expect(await claimRecordOf(harness, taskId)).toMatchObject({
      stale: true,
      release_cause: 'stopped',
    });
  });

  it('(c) treats a claim the Rework released as a first claim: a person who took the ticket since is refused, no assign', async () => {
    const ticket = tracker({ assignee: 'jane' });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness);
    await harness.memory.transaction(async (scope) => {
      await harness.store.tasks.saveTicketClaim(scope.tx, stored.task.id, {
        account_id: SELF_ID,
        claimed_at: '2026-06-01T08:00:00.000Z' as StoredTicketClaim['claimed_at'],
        status: 'confirmed',
        in_progress_written: true,
        stale: true,
        released_at: '2026-06-01T08:30:00.000Z' as StoredTicketClaim['claimed_at'],
        release_cause: 'rework',
      });
    });
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId: stored.task.id,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'ticket_assigned_elsewhere' });
    expect(ticket.calls).toEqual(['selfIdentity']);
    expect(ticket.state.assignee).toBe('jane');
  });

  it('(c) after a real Rework release, a person who assigns themselves is not overwritten by the next claim', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    const id = taskOf(harness).task.id;
    const assignsBefore = ticket.calls.filter((call) => call === 'assignToSelf').length;
    // Since WP-178 the Rework enqueues no release: it marks the claim stale (`rework`), and the
    // reworked stage's own job releases and then claims (backlog 541).
    await reworkStageCommand(harness.humanCommands, {
      taskId: id,
      userId: USER,
      stage: 'implementation' as Slug,
      instructions: 'take the other approach',
    });
    expect(
      harness.jobs.enqueued.filter(
        (job) => (job.data as { duty?: string }).duty === 'ticket_release',
      ),
    ).toEqual([]);
    expect(await claimOf(harness)).toMatchObject({ stale: true, stale_cause: 'rework' });
    // A person takes the ticket before the reworked stage's job runs.
    ticket.state.assignee = 'jane';
    await harness.drain();

    expect(ticket.calls.filter((call) => call === 'assignToSelf')).toHaveLength(assignsBefore);
    expect(eventsOf(harness, 'ticket.released').at(-1)?.payload).toMatchObject({
      cause: 'rework',
      unassigned: false,
    });
    expect(ticket.state.assignee).toBe('jane');
    expect(taskOf(harness).task.state).toBe('needs_human');
    const refused = eventsOf(harness, 'ticket.claim.refused');
    expect(refused.at(-1)?.payload).toMatchObject({ reason: 'ticket_assigned_elsewhere' });
  });

  it('(b) claims nothing for a cancelled, a paused or an escalated task: zero tracker calls, no claim recorded', async () => {
    for (const state of ['cancelled', 'paused', 'needs_human'] as const) {
      const ticket = tracker();
      const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
      const stored = await insertTask(harness, { state });
      const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
        taskId: stored.task.id,
        ...REFINEMENT_1,
      });
      expect(outcome, state).toEqual({ kind: 'proceed' });
      // Zero tracker calls, reads included: `calls` holds every lifecycle member and write the
      // double implements, `reads` every `readTicket`.
      expect(ticket.calls, state).toEqual([]);
      expect(ticket.reads, state).toEqual([]);
      expect(ticket.state.assignee, state).toBeNull();
      expect(await claimRecordOf(harness, stored.task.id), state).toBeNull();
      expect(eventsOf(harness, 'ticket.claimed'), state).toHaveLength(0);
    }
  });

  it('(b) claims nothing for a superseded attempt', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness, { stageAttempts: { intake: 1, refinement: 2 } });
    await ensureTicketClaim(claimOptions(harness), stored, {
      taskId: stored.task.id,
      ...REFINEMENT_1,
    });
    expect(ticket.calls).toEqual([]);
  });

  it('(a) refuses a first claim when a person holds the ticket, without the assign: one marked comment, no run', async () => {
    const ticket = tracker({ assignee: 'jane' });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness);
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId: stored.task.id,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'ticket_assigned_elsewhere' });
    expect(ticket.calls).toEqual(['selfIdentity']);
    expect(ticket.state.assignee).toBe('jane');
    expect(ticket.state.comments).toEqual([
      { markerId: `agentic:claim-refused:${stored.task.id}`, body: CLAIM_REFUSED_COMMENT },
    ]);
    expect(harness.store.snapshot()[0]?.task.state).toBe('needs_human');
    expect(runsCreated(harness)).toBe(0);
    expect(await claimRecordOf(harness, stored.task.id)).toBeNull();
  });

  it('(a) takes a first claim from a person when the binding takes assigned tickets', async () => {
    const ticket = tracker({ assignee: 'jane' });
    const harness = harnessFor(
      ticket,
      lifecycle({ in_progress: 'Doing', take_assigned_tickets: true }),
    );
    const stored = await insertTask(harness);
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId: stored.task.id,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'proceed' });
    expect(ticket.state.assignee).toBe(SELF_ID);
    expect(await claimRecordOf(harness, stored.task.id)).toMatchObject({ status: 'confirmed' });
  });

  it('(a) takes the ticket back on a re-claim after a human return, from the QA person who holds it', async () => {
    const ticket = tracker({ assignee: 'qa-person' });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness);
    await harness.memory.transaction(async (scope) => {
      await harness.store.tasks.saveTicketClaim(scope.tx, stored.task.id, {
        account_id: SELF_ID,
        claimed_at: '2026-06-01T08:00:00.000Z' as StoredTicketClaim['claimed_at'],
        status: 'confirmed',
        in_progress_written: true,
        stale: true,
        released_at: null,
        release_cause: null,
      });
    });
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId: stored.task.id,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'proceed' });
    expect(ticket.calls).toEqual(['selfIdentity', 'assignToSelf', 'transition:Doing']);
    expect(ticket.state.assignee).toBe(SELF_ID);
    expect(await claimRecordOf(harness, stored.task.id)).toMatchObject({
      status: 'confirmed',
      stale: false,
    });
  });
});

/** What `ensureTicketClaim` needs, from the harness's own parts. */
const claimOptions = (harness: PipelineHarness) => ({
  store: harness.store,
  settings: staticProjectSettings(() => harness.settings),
  jobs: harness.jobs,
  integrations: staticPipelineIntegrations(harness.integrations),
  ids: harness.ids,
  clock: harness.clock,
  calendar: harness.calendar,
  unitOfWork: harness.memory,
});

// ── (5) and (8): status_mapping, as before and superseded ───────────────────

describe('status_mapping and the lifecycle (TD-029 decisions 1 and 3)', () => {
  it('(5) with no lifecycle block: no assign, no unassign, no lifecycle transition, and status_mapping applies as before', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, null, {
      settings: { config: { status_mapping: { refinement: 'Doing' } } },
    });
    await harness.publish([ticketMatched()]);
    await harness.publish([merged()]);

    expect(ticket.calls.filter((call) => call !== 'transition:Doing')).toEqual([]);
    expect(ticket.calls).toEqual(['transition:Doing']);
    expect(eventsOf(harness, 'ticket.claimed')).toHaveLength(0);
    expect(harness.audit.entriesFor('assign_to_self')).toHaveLength(0);
    expect(harness.audit.entriesFor('unassign')).toHaveLength(0);
    expect(harness.audit.entriesFor('self_identity')).toHaveLength(0);
    expect(taskOf(harness).task.state).toBe('done');
    expect(await claimOf(harness)).toBeNull();
  });

  it('(8) with any slot mapped, the status mapping enqueues nothing', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ in_review: 'Waiting for review' }), {
      settings: { config: { status_mapping: { refinement: 'Doing', code_review: 'Sent back' } } },
    });
    await harness.publish([ticketMatched()]);

    // Canary (criterion 8): without the early return the mapping's `status` duty is enqueued.
    expect(
      harness.jobs.history.filter((job) => (job.data as { duty?: string }).duty === 'status'),
    ).toEqual([]);
    expect(ticket.calls).not.toContain('transition:Sent back');
    expect(ticket.calls).toContain('transition:Waiting for review');
  });

  it('keeps applying status_mapping when only pick_up_from is mapped (and the block claims)', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({}), {
      settings: { config: { status_mapping: { refinement: 'Doing' } } },
    });
    await harness.publish([ticketMatched()]);
    expect(ticket.calls).toContain('transition:Doing');
    // The block claims by default even with nothing mapped (TD-029 decision 1).
    expect(ticket.calls).toContain('assignToSelf');
  });
});

// ── (7): the moments ────────────────────────────────────────────────────────

describe('the lifecycle moments through the tracker (TD-029 decision 4)', () => {
  it('(7) in_review on code_review, approved on the last review’s approval, done on merged_gate, in_progress at the claim and on implementation', async () => {
    const ticket = tracker();
    const harness = harnessFor(
      ticket,
      lifecycle({
        in_progress: 'Doing',
        in_review: 'Waiting for review',
        approved: 'Reviewed',
        done: 'Finished',
      }),
    );
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    await harness.publish([merged()]);

    expect(ticket.lifecycleCalls()).toEqual([
      'selfIdentity',
      'assignToSelf',
      'transition:Doing',
      // entry into implementation (a developer stage) — the ticket is already there.
      'transition:Doing',
      'transition:Waiting for review',
      // business_review's approval: the last enabled agent review stage.
      'transition:Reviewed',
      'transition:Finished',
    ]);
  });

  it('(7) moves to in_progress again on re-entry into implementation after a review return', async () => {
    const ticket = tracker();
    let implementations = 0;
    let harness: PipelineHarness | null = null;
    harness = harnessFor(
      ticket,
      lifecycle({ in_progress: 'Doing', in_review: 'Waiting for review' }),
      {
        runs: { ...happyRuns(), code_review: completed(REVIEW('request_changes')) },
        whileRunning: async (spec) => {
          if (spec.stage === 'implementation') {
            implementations += 1;
            if (implementations === 2) {
              harness?.script('code_review', completed(REVIEW('approve')));
            }
          }
        },
      },
    );
    await harness.publish([ticketMatched()]);

    expect(implementations).toBe(2);
    expect(ticket.lifecycleCalls().filter((call) => call.startsWith('transition:'))).toEqual([
      'transition:Doing',
      'transition:Doing',
      'transition:Waiting for review',
      'transition:Doing',
      'transition:Waiting for review',
    ]);
  });

  it('(7) qa on entry into qa, when the binding maps it — frozen on the task at intake', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ qa: 'Testing' }));
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).qaStage).toBe(true);
    expect(taskOf(harness).task.currentStage).toBe('qa');
    expect(ticket.lifecycleCalls().filter((call) => call.startsWith('transition:'))).toEqual([
      'transition:Testing',
    ]);
  });

  it('(7) an unmapped slot makes no call and the stage still runs', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ done: 'Finished' }));
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).qaStage).toBe(false);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(ticket.lifecycleCalls()).toEqual(['selfIdentity', 'assignToSelf']);
    expect(harness.specs.map((spec) => spec.stage)).toContain('code_review');
  });

  it('a failed lifecycle write does not block the stage', async () => {
    const ticket = tracker();
    const failing = {
      ...ticket.port,
      transition: async (_ref: TicketRefInput, to: string) => {
        ticket.calls.push(`transition:${to}`);
        throw new IntegrationError('invalid_request', 'fake-jira', `no transition to ${to}`);
      },
    };
    const harness = harnessFor({ ...ticket, port: failing }, lifecycle({ in_review: 'Gone' }));
    await harness.publish([ticketMatched()]);
    expect(ticket.calls).toContain('transition:Gone');
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(harness.audit.entriesFor('transition_ticket').map((entry) => entry.status)).toContain(
      'failed',
    );
  });
});

// ── (6): the intake skip ────────────────────────────────────────────────────

describe('the intake skip (TD-029 decision 5)', () => {
  it('(6) creates no task for a ticket assigned to somebody else, and records ticket.intake.skipped', async () => {
    const ticket = tracker({ assignee: 'jane' });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);

    expect(harness.store.snapshot()).toEqual([]);
    const skipped = eventsOf(harness, 'ticket.intake.skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload).toMatchObject({ project_id: PROJECT, reason: 'assigned' });
    expect(ticket.calls).toEqual(['selfIdentity']);
  });

  it('(6) creates a task for a ticket assigned to the binding’s own account', async () => {
    const ticket = tracker({ assignee: SELF_ID });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toHaveLength(1);
    expect(eventsOf(harness, 'ticket.intake.skipped')).toHaveLength(0);
  });

  it('(6) creates a task for an assigned ticket when take_assigned_tickets is true, and the claim takes it', async () => {
    const ticket = tracker({ assignee: 'jane' });
    const harness = harnessFor(
      ticket,
      lifecycle({ in_progress: 'Doing', take_assigned_tickets: true }),
    );
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toHaveLength(1);
    expect(ticket.state.assignee).toBe(SELF_ID);
    expect(eventsOf(harness, 'ticket.claimed')).toHaveLength(1);
  });

  it('takes an assigned ticket on a binding that does not claim', async () => {
    const ticket = tracker({ assignee: 'jane' });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing', claim: false }));
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toHaveLength(1);
    expect(ticket.calls).not.toContain('assignToSelf');
    expect(ticket.state.assignee).toBe('jane');
  });
});

// ── (9): the release ────────────────────────────────────────────────────────

describe('the release (TD-029 decision 5)', () => {
  it('(9) on cancel, unassigns the binding’s own account and moves the ticket back to pick_up_from', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    expect(ticket.state.assignee).toBe(SELF_ID);

    await cancelTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
    });
    await harness.drain();

    expect(ticket.state.assignee).toBeNull();
    expect(ticket.state.status).toBe('Ready for the agent');
    expect(eventsOf(harness, 'ticket.released')[0]?.payload).toMatchObject({
      unassigned: true,
      pick_up_from_written: true,
      cause: 'cancelled',
    });
    expect(await claimOf(harness)).toMatchObject({ release_cause: 'cancelled' });
  });

  it('(9) leaves another person’s assignment alone', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }, null));
    await harness.publish([ticketMatched()]);
    ticket.state.assignee = 'jane';

    await cancelTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
    });
    await harness.drain();

    expect(ticket.state.assignee).toBe('jane');
    // `pick_up_from` is not mapped here (a label pick-up), so the status is not moved either.
    expect(ticket.state.status).toBe('Doing');
    expect(eventsOf(harness, 'ticket.released')[0]?.payload).toMatchObject({
      unassigned: false,
      pick_up_from_written: false,
      cause: 'cancelled',
    });
  });

  it('releases nothing for a task that never claimed', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, null);
    await harness.publish([ticketMatched()]);
    await cancelTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
    });
    await harness.drain();
    expect(ticket.calls).not.toContain('unassign');
    expect(eventsOf(harness, 'ticket.released')).toHaveLength(0);
  });

  it('on a person’s Rework, the ticket ends held by the re-claim, whichever of the release and the claim ran first', async () => {
    const ticket = tracker();
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');

    await reworkStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage: 'implementation' as Slug,
      instructions: 'take the other approach',
    });
    await harness.drain();

    expect(ticket.state.assignee).toBe(SELF_ID);
    const claim = await claimOf(harness);
    expect(claim?.stale).toBe(false);
    expect(claim?.status).toBe('confirmed');
    // The release ran (it records itself) or found the task already re-claimed (it does nothing);
    // either way the agent never works an unassigned ticket.
    expect(ticket.calls.filter((call) => call === 'assignToSelf').length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * WP-178 criterion (17) — PROGRESS backlog 541 and 543: the release and the claim agree about who
 * holds the ticket. One record (`tasks.ticket_claim`), one pair of functions (`ensureTicketClaim`,
 * the release).
 */
describe('the release and the claim agree about who holds the ticket (WP-178 (17))', () => {
  /**
   * (i), backlog 541. The fake `unassign` blocks until a concurrent claim has assigned (or, when no
   * claim runs beside it, until a short real-time bound passes) — the interleaving that undid a
   * re-claim while the Rework's release was a duty on another queue. Every job due after the
   * Rework is run **concurrently**, as two workers would run them. Serialised, the release runs in
   * the reworked stage's own job before its claim, so the ticket ends with the binding's account.
   */
  it('(17)(i) a Rework’s release cannot undo the re-claim: the ticket ends assigned and the claim held', async () => {
    let racing = false;
    let assignedWhileRacing: () => void = () => {};
    const assigned = new Promise<void>((resolve) => {
      assignedWhileRacing = resolve;
    });
    const ticket = tracker({
      afterAssign: async () => {
        if (racing) assignedWhileRacing();
      },
      beforeUnassign: async () => {
        if (!racing) return;
        // Wait for a concurrent assign, or give up after a short real-time bound when none comes.
        await Promise.race([assigned, new Promise((resolve) => setTimeout(resolve, 50))]);
      },
    });
    const harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');

    await reworkStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage: 'implementation' as Slug,
      instructions: 'take the other approach',
    });
    racing = true;
    const due = [JOB_QUEUES.pipelineOutbound, JOB_QUEUES.stageExecute].flatMap((queue) =>
      harness.jobs.takeDue(queue, harness.clock.epochMs).map((request) => ({ queue, request })),
    );
    expect(due.some(({ queue }) => queue === JOB_QUEUES.stageExecute)).toBe(true);
    await Promise.all(
      due.map(({ queue, request }) =>
        harness.jobs.handlers.get(queue)?.({
          id: `job-${queue}`,
          queue,
          data: request.data as never,
          signal: AbortSignal.abort(),
        }),
      ),
    );
    racing = false;
    await harness.drain();

    expect(ticket.state.assignee).toBe(SELF_ID);
    expect(await claimOf(harness)).toMatchObject({
      stale: false,
      released_at: null,
      status: 'confirmed',
    });
    // Released, then claimed — in that order, by the reworked stage's job.
    const types = harness.types();
    expect(types.lastIndexOf('ticket.released')).toBeLessThan(types.lastIndexOf('ticket.claimed'));
  });

  /**
   * (ii), backlog 543. A task that stops between the claim's assign and its record leaves a claim
   * stale with `stale_cause: 'stopped'`. Its `stopped` release then never runs — exhausted, as a
   * `notification_shaped` job leaves nothing behind — and a person takes the ticket. The resumed
   * task's admission is a **first** claim: it reads the assignee and refuses, without an assign.
   */
  it('(17)(ii) after an exhausted stopped release, a resumed task is refused ticket_assigned_elsewhere without an assign', async () => {
    let harness: PipelineHarness | null = null;
    let taskId: Id | null = null;
    let pauseOnAssign = true;
    const ticket = tracker({
      afterAssign: async () => {
        if (!pauseOnAssign) return;
        const of = harness as PipelineHarness;
        await of.memory.transaction(async (scope) => {
          const current = (await of.store.tasks.load(scope.tx, taskId as Id)) as StoredTask;
          await of.store.tasks.save(scope.tx, {
            ...current,
            task: { ...current.task, state: 'paused' },
          });
        });
      },
    });
    harness = harnessFor(ticket, lifecycle({ in_progress: 'Doing' }, null));
    const stored = await insertTask(harness);
    taskId = stored.task.id;
    expect(
      await ensureTicketClaim(claimOptions(harness), stored, { taskId, ...REFINEMENT_1 }),
    ).toEqual({ kind: 'proceed' });
    expect(await claimRecordOf(harness, taskId)).toMatchObject({
      stale: true,
      stale_cause: 'stopped',
      released_at: null,
    });
    // The `stopped` release is enqueued and then exhausted: it never runs.
    const releases = harness.jobs
      .take(JOB_QUEUES.pipelineOutbound)
      .filter((job) => (job.data as { duty?: string }).duty === 'ticket_release');
    expect(releases).toHaveLength(1);
    expect(ticket.state.assignee).toBe(SELF_ID);

    // A person takes the ticket, and the task is resumed: its stage is entered again (attempt 2),
    // so the claim's writes carry a new idempotency key rather than replaying the first assign.
    ticket.state.assignee = 'jane';
    pauseOnAssign = false;
    const resumed = await harness.memory.transaction(async (scope) => {
      const current = (await harness?.store.tasks.load(scope.tx, taskId as Id)) as StoredTask;
      return harness?.store.tasks.save(scope.tx, {
        ...current,
        task: {
          ...current.task,
          state: 'active',
          stageAttempts: { ...current.task.stageAttempts, refinement: 2 },
        },
      });
    });
    const assignsBefore = ticket.calls.filter((call) => call === 'assignToSelf').length;
    expect(
      await ensureTicketClaim(claimOptions(harness), resumed as StoredTask, {
        taskId,
        stage: 'refinement' as Slug,
        attempt: 2,
      }),
    ).toEqual({ kind: 'refused', reason: 'ticket_assigned_elsewhere' });
    expect(ticket.calls.filter((call) => call === 'assignToSelf')).toHaveLength(assignsBefore);
    expect(ticket.state.assignee).toBe('jane');
  });
});
