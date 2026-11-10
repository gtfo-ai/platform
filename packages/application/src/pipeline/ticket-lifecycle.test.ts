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
  IsoDateTime,
  Slug,
  StoredTicketClaim,
  TicketStatusCategory,
} from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { resolveIterationLimits, ticketStatusPolicyOf } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { IntegrationError } from '../ports/integrations/common.js';
import type { TaskManagementPort, TicketRefInput } from '../ports/integrations/task-management.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import { recoverTicketStatusSweep } from '../recovery/ticket-status-sweep.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import type { BindingLifecycle } from './binding-lifecycle.js';
import { cancelTaskCommand, handBackTaskCommand, reworkStageCommand } from './commands.js';
import { staticPipelineIntegrations } from './integrations.js';
import { claimRunOffer } from './offers.js';
import { setTaskOwnerCommand } from './owner-sync.js';
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
  /** The first this many reads answer no ticket — a port that answered nothing. */
  readonly nullReads?: number;
  /**
   * Somebody takes the ticket in the tracker just before the first claim reads it — on the claim's
   * first `selfIdentity`, which intake never asks for an unassigned ticket (AUT-6676's shape).
   */
  readonly takenBeforeTheClaimBy?: string;
  /** The port declares `assignOthers` and answers `assignTo` — the owner write-back (S-26.3). */
  readonly assignsOthers?: boolean;
  /** The status's tracker category the read reports (S-28.4); absent reports none. */
  readonly statusCategory?: TicketStatusCategory;
  /**
   * A person moves the ticket just before the first claim reads it — on the claim's first
   * `selfIdentity`, which intake never asks for an unassigned ticket (S-28.4: closed while queued).
   */
  readonly movedBeforeTheClaimTo?: {
    readonly status: string;
    readonly category: TicketStatusCategory;
  };
}

/** One ticket's assignee, status and comments, and every lifecycle call made on it, in order. */
const tracker = (options: TrackerOptions = {}) => {
  const state = {
    assignee: options.assignee ?? null,
    status: options.status ?? 'Ready for the agent',
    statusCategory: (options.statusCategory ?? null) as TicketStatusCategory | null,
    comments: [] as { readonly markerId: string | null; readonly body: string }[],
  };
  const calls: string[] = [];
  /** Every `readTicket`, kept apart from `calls` because the snapshot and the planner read too. */
  const reads: string[] = [];
  const port: Partial<TaskManagementPort> = {
    readTicket: async (ref: TicketRefInput) => {
      reads.push(ref.key);
      if (reads.length <= (options.nullReads ?? 0)) {
        // The port's type promises a ticket; `ticketReads.ticket` answers `null` past it.
        return null as never;
      }
      return {
        ref,
        issue_type: 'Story',
        title: 'Show the totals in the invoice footer',
        description: 'The footer sums the visible rows rather than all of them.',
        status: state.status,
        ...(state.statusCategory === null ? {} : { status_category: state.statusCategory }),
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
      if (options.takenBeforeTheClaimBy !== undefined && !calls.includes('selfIdentity')) {
        state.assignee = options.takenBeforeTheClaimBy;
      }
      if (options.movedBeforeTheClaimTo !== undefined && !calls.includes('selfIdentity')) {
        state.status = options.movedBeforeTheClaimTo.status;
        state.statusCategory = options.movedBeforeTheClaimTo.category;
      }
      calls.push('selfIdentity');
      return identity(SELF_ID);
    },
    ...(options.assignsOthers === true
      ? {
          capabilities: () =>
            ({ commentsRead: false, assignOthers: true }) as ReturnType<
              TaskManagementPort['capabilities']
            >,
          assignTo: async (_ref: TicketRefInput, assignee: ExternalIdentity) => {
            calls.push(`assignTo:${assignee.external_id}`);
            const changed = state.assignee !== assignee.external_id;
            state.assignee = assignee.external_id;
            return { changed, assignee };
          },
        }
      : {}),
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
      {
        markerId: `agentic:claim-refused:${stored.task.id}`,
        body: `agentic:claim-refused:${stored.task.id}\n${CLAIM_REFUSED_COMMENT}`,
      },
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
      {
        markerId: `agentic:claim-refused:${stored.task.id}`,
        body: `agentic:claim-refused:${stored.task.id}\n${CLAIM_REFUSED_COMMENT}`,
      },
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
  eventStore: harness.memory.store,
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

/**
 * **A failed lifecycle move is visible** (S-28.10, TD-029's amendment C (2)). AUT-6655 left twenty
 * failed `transition_ticket` calls and the task page said nothing. The failure is now recorded on
 * the task — the slot, the status wanted, what the ticket showed, the statuses it could take, the
 * provider's reason and code — and a later move that goes through clears it. Canary: the record
 * call removed from `moveTicket` leaves `providerSync` empty in the first case.
 */
describe('a failed lifecycle move is recorded as out of sync (S-28.10)', () => {
  const failingOn = (
    ticket: ReturnType<typeof tracker>,
    refused: string,
  ): Partial<TaskManagementPort> => ({
    ...ticket.port,
    capabilities: () =>
      ({ commentsRead: false, transitionsRead: true }) as ReturnType<
        TaskManagementPort['capabilities']
      >,
    listTransitions: async () => [
      { id: '31', name: 'Back to work', to: { name: 'In Progress', category: 'in_progress' } },
      { id: '41', name: 'Ship it', to: { name: 'Released', category: 'done' } },
    ],
    transition: async (_ref: TicketRefInput, to: string) => {
      ticket.calls.push(`transition:${to}`);
      if (to === refused) {
        throw new IntegrationError(
          'invalid_request',
          'fake-jira',
          `no transition to ${to} from ${ticket.state.status}`,
        );
      }
      const from = ticket.state.status;
      ticket.state.status = to;
      return { changed: from !== to, from, to };
    },
  });

  const syncOf = async (harness: PipelineHarness) =>
    harness.memory.transaction(async (scope) =>
      harness.store.tasks.providerSync(scope.tx, taskOf(harness).task.id),
    );

  it('records the slot, the target, what the ticket showed, the moves it offered and the reason', async () => {
    const ticket = tracker({ status: 'Ready for Merge' });
    const harness = harnessFor(
      { ...ticket, port: failingOn(ticket, 'Gone') },
      lifecycle({ in_review: 'Gone' }),
    );
    await harness.publish([ticketMatched()]);
    // The stage still ran (decision 4)…
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    // …and the failure is on the task, not only in a log.
    const rows = await syncOf(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: 'ticket_status',
      slot: 'in_review',
      target: 'Gone',
      observed: 'Ready for Merge',
      available: ['In Progress', 'Released'],
      reason_code: 'invalid_request',
    });
    expect(rows[0]?.reason).toContain('no transition to Gone');
    expect(rows[0]?.attempts).toBeGreaterThanOrEqual(1);
    // The audit row keeps the error too (amendment C (1)).
    const failed = harness.audit
      .entriesFor('transition_ticket')
      .filter((entry) => entry.status === 'failed');
    expect(failed[0]?.errorCode).toBe('invalid_request');
    expect(failed[0]?.error).toContain('no transition to Gone');
  });

  it('clears the record when a later move goes through', async () => {
    const ticket = tracker({ status: 'Ready for Merge' });
    const harness = harnessFor(
      { ...ticket, port: failingOn(ticket, 'Gone') },
      lifecycle({ in_review: 'Gone', approved: 'Approved' }),
    );
    await harness.publish([ticketMatched()]);
    expect(ticket.calls).toContain('transition:Gone');
    expect(ticket.calls).toContain('transition:Approved');
    expect(await syncOf(harness)).toEqual([]);
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

// ── S-28.4: a ticket is started only from a startable status ───────────────

describe('S-28.4 — the status policy at intake and at the claim (M28 ruling 3 (c), (d))', () => {
  /** The defaults: To Do starts, Done is finished; `pickup_status` beside them. */
  const withPolicy = (
    ticket: ReturnType<typeof tracker>,
    slots: BindingLifecycle['slots'] = { in_progress: 'Doing' },
  ) =>
    harnessFor(ticket, lifecycle(slots), {
      settings: { ticketStatusPolicy: ticketStatusPolicyOf('Ready for the agent', slots) },
    });

  it('creates no task for a released ticket that still carries the label, and records why', async () => {
    const ticket = tracker({ status: 'Released', statusCategory: 'done' });
    const harness = withPolicy(ticket);
    await harness.publish([ticketMatched()]);

    expect(harness.store.snapshot()).toEqual([]);
    const skipped = eventsOf(harness, 'ticket.intake.skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload).toMatchObject({
      project_id: PROJECT,
      reason: 'status_not_startable',
      status: 'Released',
    });
    // Nothing was written to the tracker: no claim, no assign.
    expect(ticket.lifecycleCalls()).toEqual([]);
  });

  it('creates no task for a ticket a person is working on (an In Progress status)', async () => {
    const ticket = tracker({ status: 'Ready for Merge', statusCategory: 'in_progress' });
    const harness = withPolicy(ticket);
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toEqual([]);
    expect(eventsOf(harness, 'ticket.intake.skipped')[0]?.payload).toMatchObject({
      reason: 'status_not_startable',
      status: 'Ready for Merge',
    });
  });

  it('creates a task for a To Do ticket, and for one in pickup_status whatever its category', async () => {
    const todo = tracker({ status: 'To Do', statusCategory: 'todo' });
    const first = withPolicy(todo);
    await first.publish([ticketMatched()]);
    expect(first.store.snapshot()).toHaveLength(1);
    expect(eventsOf(first, 'ticket.intake.skipped')).toHaveLength(0);

    const pickup = tracker({ status: 'Ready for the agent', statusCategory: 'in_progress' });
    const second = withPolicy(pickup);
    await second.publish([ticketMatched()]);
    expect(second.store.snapshot()).toHaveLength(1);
  });

  it('takes a ticket it could not read, as before', async () => {
    const ticket = tracker({ status: 'Released', statusCategory: 'done', nullReads: 1 });
    const harness = withPolicy(ticket);
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toHaveLength(1);
    expect(eventsOf(harness, 'ticket.intake.skipped')).toHaveLength(0);
  });

  it('a start_from list decides: a To Do status outside it waits', async () => {
    const slots = { in_progress: 'Doing', start_from: ['Ready'] };
    const ticket = tracker({ status: 'Idea', statusCategory: 'todo' });
    const harness = withPolicy(ticket, slots);
    await harness.publish([ticketMatched()]);
    expect(harness.store.snapshot()).toEqual([]);
    expect(eventsOf(harness, 'ticket.intake.skipped')[0]?.payload).toMatchObject({
      reason: 'status_not_startable',
      status: 'Idea',
    });
  });

  it('under stop, the claim refuses a ticket released while its task waited: needs_human, the status named, no assign, no run', async () => {
    const ticket = tracker({
      status: 'To Do',
      statusCategory: 'todo',
      movedBeforeTheClaimTo: { status: 'Released', category: 'done' },
    });
    const harness = withPolicy(ticket, { in_progress: 'Doing', on_ticket_closed: 'stop' });
    await harness.publish([ticketMatched()]);

    const stored = taskOf(harness);
    expect(stored.task.state).toBe('needs_human');
    const escalated = eventsOf(harness, 'task.escalated')[0]?.payload as {
      reason: string;
      blocker_brief: string;
    };
    expect(escalated.reason).toBe('ticket_closed_in_tracker');
    expect(escalated.blocker_brief).toContain('"Released"');
    expect(eventsOf(harness, 'ticket.claim.refused')[0]?.payload).toMatchObject({
      reason: 'ticket_closed_in_tracker',
    });
    expect(ticket.calls).not.toContain('assignToSelf');
    expect(runsCreated(harness)).toBe(0);
    // A status refusal is not somebody else's ticket: no comment on it.
    expect(ticket.state.comments).toEqual([]);
  });

  it('by default, the claim of a ticket released while its task waited cancels the task, says why, and leaves the ticket where it is (S-28.14)', async () => {
    const ticket = tracker({
      status: 'To Do',
      statusCategory: 'todo',
      movedBeforeTheClaimTo: { status: 'Released', category: 'done' },
    });
    const harness = withPolicy(ticket);
    await harness.publish([ticketMatched()]);
    await harness.drain();

    expect(taskOf(harness).task.state).toBe('cancelled');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);
    expect(eventsOf(harness, 'ticket.claim.refused')[0]?.payload).toMatchObject({
      reason: 'ticket_closed_in_tracker',
    });
    const cancelled = eventsOf(harness, 'task.cancelled');
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0]?.payload as { outcome: string } | undefined)?.outcome).toBe(
      'Cancelled automatically: ACME-1 is "Released" in the tracker, a status that means it is finished.',
    );
    expect(cancelled[0]?.actor).toMatchObject({ kind: 'system' });
    expect(ticket.calls).not.toContain('assignToSelf');
    expect(ticket.state.status).toBe('Released');
    expect(runsCreated(harness)).toBe(0);
  });

  it('the claim refuses a first claim of a ticket a person took meanwhile (ticket_not_startable)', async () => {
    const ticket = tracker({
      status: 'To Do',
      statusCategory: 'todo',
      movedBeforeTheClaimTo: { status: 'Review In Progress', category: 'in_progress' },
    });
    const harness = withPolicy(ticket);
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(
      (eventsOf(harness, 'task.escalated')[0]?.payload as { reason: string } | undefined)?.reason,
    ).toBe('ticket_not_startable');
    expect(runsCreated(harness)).toBe(0);
  });

  it('a block with no slot keeps status_mapping, and the claim reads the mapping’s move as the platform’s own (review finding 1)', async () => {
    const slots = { assign_owner: true };
    const ticket = tracker({
      status: 'To Do',
      statusCategory: 'todo',
      movedBeforeTheClaimTo: { status: 'In Progress', category: 'in_progress' },
    });
    const harness = harnessFor(ticket, lifecycle(slots), {
      settings: {
        ticketStatusPolicy: ticketStatusPolicyOf('Ready for the agent', slots),
        config: { status_mapping: { refinement: 'In Progress' } },
      },
    });
    await harness.publish([ticketMatched()]);
    expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(0);
    expect(eventsOf(harness, 'ticket.claimed')).toHaveLength(1);
    expect(runsCreated(harness)).toBeGreaterThan(0);
  });

  it('a hand-back after a status refusal is a person’s instruction: the claim does not refuse again (review ruling (a))', async () => {
    const ticket = tracker({
      status: 'To Do',
      statusCategory: 'todo',
      movedBeforeTheClaimTo: { status: 'Review In Progress', category: 'in_progress' },
    });
    const harness = withPolicy(ticket);
    await harness.publish([ticketMatched()]);
    const taskId = taskOf(harness).task.id;
    expect(taskOf(harness).task.state).toBe('needs_human');
    await handBackTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'refinement' as Slug,
      summary: 'I readied it, go',
    });
    await harness.drain();
    expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(1);
    expect(eventsOf(harness, 'ticket.claimed')).toHaveLength(1);
  });

  /**
   * S-28.11 (the production defect, AUT-6743): a first claim is a task that never ran, so the
   * platform has written no status for it — not even a lifecycle slot's. A ticket a person moved to
   * the `in_progress` slot's status (or the `done` slot's, *Ready for Merge*) is a person's move.
   * Until S-28.11 every slot's status was exempt, and this claim proceeded.
   */
  it('a first claim does not treat a lifecycle slot’s status as the platform’s own: refused (S-28.11)', async () => {
    for (const status of ['Doing', 'Ready for Merge']) {
      const ticket = tracker({
        status: 'To Do',
        statusCategory: 'todo',
        movedBeforeTheClaimTo: { status, category: 'in_progress' },
      });
      const harness = withPolicy(ticket, { in_progress: 'Doing', done: 'Ready for Merge' });
      await harness.publish([ticketMatched()]);
      expect(taskOf(harness).task.state, status).toBe('needs_human');
      expect(
        (eventsOf(harness, 'task.escalated')[0]?.payload as { reason: string } | undefined)?.reason,
        status,
      ).toBe('ticket_not_startable');
      expect(ticket.calls, status).not.toContain('assignToSelf');
      expect(runsCreated(harness), status).toBe(0);
    }
  });
});

// ── S-28.5: the reverse sync and the sweep ─────────────────────────────────

describe('S-28.5 — a ticket a person finished or took stops its task (M28 ruling 4), under on_ticket_closed: stop', () => {
  const slots = { in_progress: 'Doing' };
  // S-28.14: `stop` is the explicit choice now — the default is `cancel` (its own describe below).
  const policy = ticketStatusPolicyOf('Ready for the agent', {
    ...slots,
    on_ticket_closed: 'stop',
  });
  /** A task stopped at the claim (somebody else holds the ticket): `needs_human`, nothing running. */
  const stoppedAtTheClaim = async (
    settings: Record<string, unknown> = {},
    mrState: 'opened' | 'merged' = 'opened',
  ) => {
    const ticket = tracker({ stealAfterAssign: 'jane', status: 'To Do', statusCategory: 'todo' });
    const harness = harnessFor(ticket, lifecycle(slots), {
      settings: { ticketStatusPolicy: policy, ...settings },
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
        getMergeRequest: async () => ({ ...mergeRequest, state: mrState }),
      },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('needs_human');
    return { ticket, harness };
  };
  /** Puts the task in `state`, as a pause, a resume or the WIP queue would have. */
  const putIn = async (
    harness: PipelineHarness,
    state: 'paused' | 'queued',
    withMergeRequest = false,
    /** S-28.11: how far the task got — the stages it entered, and the one it is at. */
    reached?: {
      readonly stageAttempts: Record<string, number>;
      readonly currentStage: string | null;
    },
  ) => {
    await harness.memory.transaction(async (scope) => {
      const stored = taskOf(harness);
      await harness.store.tasks.save(scope.tx, {
        ...stored,
        task: {
          ...stored.task,
          state,
          ...(reached === undefined
            ? {}
            : {
                stageAttempts: reached.stageAttempts,
                currentStage: reached.currentStage as Slug | null,
              }),
        },
      });
      if (withMergeRequest) {
        // The merge request is its own column's (`recordMergeRequest`), never `save`'s (WP-138).
        await harness.store.tasks.recordMergeRequest(scope.tx, stored.task.id, mergeRequest.ref);
      }
    });
  };
  /** A webhook's status change, moved by a person the delivery names. */
  const moved = (from: string, to: string): DomainEvent =>
    ({
      ...event('ticket.status.changed', {
        project_id: PROJECT,
        task_id: null,
        ticket: { ...TICKET },
        from,
        to,
      }),
      actor: {
        kind: 'integration',
        integration_id: PROJECT,
        provider: 'fake-jira',
        identity: { ...identity('vk'), display_name: 'Vojtěch Kaizr' },
      },
    }) as DomainEvent;
  /** A polled edit: no field names. */
  const edited = () =>
    event('ticket.updated', {
      project_id: PROJECT,
      ticket: { ...TICKET },
      updated_at: '2026-06-02T09:00:00.000Z',
      changed_fields: [],
      truncated: false,
    });
  const lastEscalation = (harness: PipelineHarness) =>
    eventsOf(harness, 'task.escalated').at(-1)?.payload as
      | { reason: string; blocker_brief: string }
      | undefined;

  it('closed while waiting: the task stops in needs_human with the brief, and its ticket is not touched', async () => {
    const { ticket, harness } = await stoppedAtTheClaim();
    await putIn(harness, 'paused');
    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    const calls = ticket.lifecycleCalls().length;
    await harness.publish([moved('To Do', 'Released')]);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
    const escalation = lastEscalation(harness);
    expect(escalation?.reason).toBe('ticket_closed_in_tracker');
    expect(escalation?.blocker_brief).toContain(
      'ACME-1 was moved to "Released" in the tracker by Vojtěch Kaizr',
    );
    expect(escalation?.blocker_brief).toContain('Cancel the task, or move the ticket back');
    expect(ticket.lifecycleCalls()).toHaveLength(calls);
  });

  it('a person’s resume is not undone: a later polled edit of a still-closed ticket stops nothing (review finding 3)', async () => {
    const { ticket, harness } = await stoppedAtTheClaim();
    await putIn(harness, 'paused');
    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    await harness.publish([moved('To Do', 'Released')]);
    await harness.drain();
    expect(lastEscalation(harness)?.reason).toBe('ticket_closed_in_tracker');
    const stops = eventsOf(harness, 'task.escalated').length;
    // A person resumes it, the ticket still Released; then any edit arrives (a comment, say).
    await putIn(harness, 'paused');
    await harness.publish([edited()]);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('paused');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(stops);
  });

  it('a merge request merged by hand closed the ticket: the task is not stopped (review ruling 4)', async () => {
    const { ticket, harness } = await stoppedAtTheClaim({}, 'merged');
    await putIn(harness, 'paused', true);
    const before = eventsOf(harness, 'task.escalated').length;
    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    await harness.publish([moved('Ready for Merge', 'Released')]);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('paused');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(before);
  });

  it('closed while queued: the task is cancelled with the reason', async () => {
    const { ticket, harness } = await stoppedAtTheClaim();
    await putIn(harness, 'queued');
    ticket.state.status = 'Done';
    ticket.state.statusCategory = 'done';
    await harness.publish([moved('To Do', 'Done')]);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('cancelled');
    // S-28.14: the outcome is a sentence a person reads, never the reason's code.
    expect(eventsOf(harness, 'task.cancelled').at(-1)?.payload).toMatchObject({
      outcome:
        'Cancelled automatically: ACME-1 is "Done" in the tracker, a status that means it is finished.',
    });
  });

  it('a task already stopped for a held ticket becomes one-click cancellable with the closed words', async () => {
    const { ticket, harness } = await stoppedAtTheClaim();
    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    await harness.publish([moved('To Do', 'Released')]);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(lastEscalation(harness)?.reason).toBe('ticket_closed_in_tracker');
  });

  it('a person taking the ticket into their own work stops a waiting task with ticket_taken_by_person', async () => {
    const { ticket, harness } = await stoppedAtTheClaim();
    await putIn(harness, 'paused');
    ticket.state.status = 'Review In Progress';
    ticket.state.statusCategory = 'in_progress';
    await harness.publish([moved('To Do', 'Review In Progress')]);
    await harness.drain();
    expect(lastEscalation(harness)?.reason).toBe('ticket_taken_by_person');
  });

  it('the platform’s own status write stops nothing — a slot, or a status_mapping target, Done included', async () => {
    const { ticket, harness } = await stoppedAtTheClaim();
    // A task past its first stages: the slot's status is the platform's own.
    await putIn(harness, 'paused', false, {
      stageAttempts: { refinement: 1, architecture: 1, implementation: 1 },
      currentStage: 'implementation',
    });
    const before = eventsOf(harness, 'task.escalated').length;
    ticket.state.status = 'Doing';
    ticket.state.statusCategory = 'in_progress';
    await harness.publish([moved('To Do', 'Doing')]);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('paused');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(before);

    const mapped = await stoppedAtTheClaim({
      ticketLifecycle: lifecycle({ assign_owner: true }),
      ticketStatusPolicy: ticketStatusPolicyOf('Ready for the agent', { assign_owner: true }),
      config: { status_mapping: { refinement: 'Shipped' } },
    });
    await putIn(mapped.harness, 'paused');
    const mappedBefore = eventsOf(mapped.harness, 'task.escalated').length;
    mapped.ticket.state.status = 'Shipped';
    mapped.ticket.state.statusCategory = 'done';
    await mapped.harness.publish([moved('To Do', 'Shipped')]);
    await mapped.harness.drain();
    expect(taskOf(mapped.harness).task.state).toBe('paused');
    expect(eventsOf(mapped.harness, 'task.escalated')).toHaveLength(mappedBefore);
  });

  describe('S-28.11 — a never-run task exempts no status; a running one keeps the exemption', () => {
    const delivered = {
      in_progress: 'Doing',
      in_review: 'Waiting for review',
      done: 'Ready for Merge',
    };
    const reached = async (settings: Record<string, unknown> = {}) => {
      const ticket = tracker({ stealAfterAssign: 'jane', status: 'To Do', statusCategory: 'todo' });
      const harness = harnessFor(ticket, lifecycle(delivered), {
        settings: {
          ticketStatusPolicy: ticketStatusPolicyOf('Ready for the agent', delivered),
          ...settings,
        },
      });
      await harness.publish([ticketMatched()]);
      return { ticket, harness };
    };
    const sweep = (harness: PipelineHarness) =>
      recoverTicketStatusSweep(
        { unitOfWork: harness.memory, jobs: harness.jobs },
        { tasks: harness.store.tasks },
        {
          now: '2026-06-02T09:00:00.000Z' as IsoDateTime,
          olderThan: '2999-01-01T00:00:00.000Z' as IsoDateTime,
          limit: 100,
        },
      );

    it('AUT-6743: a queued task that never ran, its ticket a person delivered to the done slot’s status, is cancelled by the sweep', async () => {
      const { ticket, harness } = await reached();
      await putIn(harness, 'queued', false, { stageAttempts: {}, currentStage: null });
      ticket.state.status = 'Ready for Merge';
      ticket.state.statusCategory = 'in_progress';
      expect(await sweep(harness)).toEqual({ found: 1, enqueued: 1 });
      await harness.drain();
      expect(taskOf(harness).task.state).toBe('cancelled');
      expect(eventsOf(harness, 'task.cancelled').at(-1)?.payload).toMatchObject({
        outcome:
          'Cancelled automatically: ACME-1 was moved to "Ready for Merge" in the tracker, a status the platform did not set — a person seems to be working on it.',
      });
    });

    it('AUT-6655: a task returned from Ready to Implementation, its ticket still at the done slot’s status, is not stopped', async () => {
      const { ticket, harness } = await reached();
      await putIn(harness, 'paused', false, {
        stageAttempts: { refinement: 1, implementation: 2, code_review: 1, ready_for_merge: 1 },
        currentStage: 'implementation',
      });
      const before = eventsOf(harness, 'task.escalated').length;
      // The workflow has no way back from Ready for Merge, so the ticket stays there.
      ticket.state.status = 'Ready for Merge';
      ticket.state.statusCategory = 'in_progress';
      await harness.publish([moved('Waiting for review', 'Ready for Merge')]);
      await harness.drain();
      expect(taskOf(harness).task.state).toBe('paused');
      expect(eventsOf(harness, 'task.escalated')).toHaveLength(before);
    });

    it('a task at refinement whose own In Progress write is re-checked before its claim record commits is not stopped', async () => {
      const { ticket, harness } = await reached();
      await putIn(harness, 'paused', false, {
        stageAttempts: { refinement: 1 },
        currentStage: 'refinement',
      });
      const before = eventsOf(harness, 'task.escalated').length;
      ticket.state.status = 'Doing';
      ticket.state.statusCategory = 'in_progress';
      await harness.publish([moved('To Do', 'Doing')]);
      await harness.drain();
      expect(taskOf(harness).task.state).toBe('paused');
      expect(eventsOf(harness, 'task.escalated')).toHaveLength(before);
    });

    it('a closed status still ends a task that ran and has not merged — cancelled, by default (S-28.14)', async () => {
      const { ticket, harness } = await reached();
      await putIn(harness, 'paused', false, {
        stageAttempts: { refinement: 1, implementation: 1 },
        currentStage: 'implementation',
      });
      ticket.state.status = 'Released';
      ticket.state.statusCategory = 'done';
      await harness.publish([moved('Doing', 'Released')]);
      await harness.drain();
      expect(taskOf(harness).task.state).toBe('cancelled');
    });

    it('a task past its code review, whose ticket the platform’s own in_review moment moved, is left alone', async () => {
      const { ticket, harness } = await reached();
      await putIn(harness, 'paused', false, {
        stageAttempts: { refinement: 1, architecture: 1, implementation: 1, code_review: 1 },
        currentStage: 'code_review',
      });
      const before = eventsOf(harness, 'task.escalated').length;
      ticket.state.status = 'Waiting for review';
      ticket.state.statusCategory = 'in_progress';
      await harness.publish([moved('Doing', 'Waiting for review')]);
      await harness.drain();
      expect(taskOf(harness).task.state).toBe('paused');
      expect(eventsOf(harness, 'task.escalated')).toHaveLength(before);
    });

    it('re-judges a task an earlier sweep revision recorded, once', async () => {
      const { ticket, harness } = await reached();
      await putIn(harness, 'queued', false, { stageAttempts: {}, currentStage: null });
      // S-28.5's pass recorded it (and, under its rule, left it alone).
      await harness.memory.transaction(async (scope) =>
        harness.store.tasks.claimTicketStatusSweep(
          scope.tx,
          taskOf(harness).task.id,
          '2026-06-02T08:00:00.000Z' as IsoDateTime,
          '2026-06-02T08:00:00.000Z' as IsoDateTime,
        ),
      );
      ticket.state.status = 'Ready for Merge';
      ticket.state.statusCategory = 'in_progress';
      expect(await sweep(harness)).toEqual({ found: 1, enqueued: 1 });
      await harness.drain();
      expect(taskOf(harness).task.state).toBe('cancelled');
      expect(await sweep(harness)).toEqual({ found: 0, enqueued: 0 });
    });
  });

  it('the one-off sweep re-reads each live task once, and stops one whose ticket was finished before', async () => {
    const { ticket, harness } = await stoppedAtTheClaim();
    await putIn(harness, 'paused');
    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    const pass = () =>
      recoverTicketStatusSweep(
        { unitOfWork: harness.memory, jobs: harness.jobs },
        { tasks: harness.store.tasks },
        {
          now: '2026-06-02T09:00:00.000Z' as IsoDateTime,
          olderThan: '2999-01-01T00:00:00.000Z' as IsoDateTime,
          limit: 100,
        },
      );
    expect(await pass()).toEqual({ found: 1, enqueued: 1 });
    await harness.drain();
    expect(lastEscalation(harness)?.reason).toBe('ticket_closed_in_tracker');
    // Idempotent: the task is recorded, so the next pass finds nothing.
    expect(await pass()).toEqual({ found: 0, enqueued: 0 });
  });
});

// ── S-28.14: a finished ticket cancels its task (M28 ruling 4b) ─────────────

describe('S-28.14 — a ticket a person finished cancels its task automatically (M28 ruling 4b)', () => {
  const slots = { in_progress: 'Doing' };
  /** The default policy: no `on_ticket_closed`, so `cancel`. */
  const policy = ticketStatusPolicyOf('Ready for the agent', slots);
  const released = (from: string): DomainEvent =>
    event('ticket.status.changed', {
      project_id: PROJECT,
      task_id: null,
      ticket: { ...TICKET },
      from,
      to: 'Released',
    });
  const notified = (harness: PipelineHarness, notificationClass: string) =>
    harness.jobs.history.filter((request) => {
      const data = request.data as { duty?: string; notification_class?: string };
      return data.duty === 'notify' && data.notification_class === notificationClass;
    });
  const sweep = (harness: PipelineHarness) =>
    recoverTicketStatusSweep(
      { unitOfWork: harness.memory, jobs: harness.jobs },
      { tasks: harness.store.tasks },
      {
        now: '2026-06-02T09:00:00.000Z' as IsoDateTime,
        olderThan: '2999-01-01T00:00:00.000Z' as IsoDateTime,
        limit: 100,
      },
    );
  /** Writes the task's row as a stage, a gate or the merge left it. */
  const putAt = async (
    harness: PipelineHarness,
    task: Partial<StoredTask['task']>,
    withMergeRequest = false,
  ) =>
    harness.memory.transaction(async (scope) => {
      const stored = taskOf(harness);
      await harness.store.tasks.save(scope.tx, { ...stored, task: { ...stored.task, ...task } });
      if (withMergeRequest) {
        await harness.store.tasks.recordMergeRequest(scope.tx, stored.task.id, mergeRequest.ref);
      }
    });

  it('a running task: cancelled, its run told to stop, its people told once, its merge request and its ticket left alone', async () => {
    const ticket = tracker({ status: 'Ready for the agent', statusCategory: 'todo' });
    const harness = harnessFor(ticket, lifecycle(slots), {
      runsAgents: false,
      settings: { ticketStatusPolicy: policy },
      git: {
        getMergeRequest: async () => mergeRequest,
        closeMergeRequest: async () => {
          throw new Error('the platform must never touch the merge request');
        },
      },
    });
    await harness.publish([ticketMatched()]);
    const [offer] = harness.store.offerRows();
    if (offer === undefined) throw new Error('the stage offered no run');
    // A claimant holds the run: it is running.
    await harness.memory.transaction(async (scope) =>
      claimRunOffer(harness.store.offers, scope.tx, {
        eligibility: { runId: offer.runId },
        claimantKind: 'server',
        owner: 'server:holder',
        expiresAt: new Date(Date.parse(harness.clock.now()) + 300_000).toISOString() as never,
        now: harness.clock.now() as never,
      }),
    );
    await putAt(harness, {}, true);
    expect(taskOf(harness).task.state).toBe('active');
    const callsBefore = ticket.calls.length;

    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    await harness.publish([released('Doing')]);
    await harness.drain();

    expect(taskOf(harness).task.state).toBe('cancelled');
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(0);
    const cancelled = eventsOf(harness, 'task.cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.actor).toMatchObject({ kind: 'system' });
    expect((cancelled[0]?.payload as { outcome: string } | undefined)?.outcome).toBe(
      'Cancelled automatically: ACME-1 is "Released" in the tracker, a status that means it is finished. Its merge request #7 is still open — close or merge it yourself: https://git.example.test/acme/api/-/merge_requests/7',
    );
    // The person's *Cancel task* path: the claimed run is told to stop through its lease holder.
    expect(harness.store.runCommandRows().map((row) => row.instruction.kind)).toEqual(['cancel']);
    expect(notified(harness, 'task_cancelled')).toHaveLength(1);
    expect(notified(harness, 'escalation')).toHaveLength(0);
    // The ticket stays Released: the release unassigns, and never moves it back to pick up.
    const after = ticket.calls.slice(callsBefore);
    expect(after.filter((call) => call.startsWith('transition:'))).toEqual([]);
    expect(ticket.state.status).toBe('Released');

    // Seen again — a polled edit, the sweep — nothing more happens.
    await harness.publish([released('Released')]);
    await harness.drain();
    expect(eventsOf(harness, 'task.cancelled')).toHaveLength(1);
    expect(notified(harness, 'task_cancelled')).toHaveLength(1);
  });

  it('AUT-6676: a task an earlier rule stopped in needs_human for its released ticket is cancelled by the sweep, nobody clicking', async () => {
    const ticket = tracker({ stealAfterAssign: 'jane', status: 'To Do', statusCategory: 'todo' });
    const harness = harnessFor(ticket, lifecycle(slots), {
      settings: { ticketStatusPolicy: policy },
    });
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('needs_human');
    const taskId = taskOf(harness).task.id;
    // S-28.5's rule stopped it for *Released* and its sweep recorded it, at an earlier revision.
    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    await harness.memory.transaction(async (scope) => {
      await harness.store.tasks.recordTicketStatusStop(
        scope.tx,
        taskId,
        'Released',
        '2026-06-02T08:00:00.000Z' as IsoDateTime,
      );
      await harness.store.tasks.claimTicketStatusSweep(
        scope.tx,
        taskId,
        '2026-06-02T08:00:00.000Z' as IsoDateTime,
        '2026-06-02T08:00:00.000Z' as IsoDateTime,
      );
    });

    expect(await sweep(harness)).toEqual({ found: 1, enqueued: 1 });
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('cancelled');
    expect(eventsOf(harness, 'task.cancelled')).toHaveLength(1);
    expect(notified(harness, 'task_cancelled')).toHaveLength(1);
    expect(await sweep(harness)).toEqual({ found: 0, enqueued: 0 });
  });

  it('leaves a task at a human stage, and a merged one, alone', async () => {
    for (const shape of [
      {
        state: 'ready_for_merge',
        currentStage: 'ready_for_merge',
        stageAttempts: { refinement: 1, implementation: 1, ready_for_merge: 1 },
      },
      {
        state: 'needs_human',
        currentStage: 'retrospective',
        stageAttempts: { refinement: 1, implementation: 1, merged_gate: 1, retrospective: 1 },
      },
    ] as const) {
      const ticket = tracker({ stealAfterAssign: 'jane', status: 'To Do', statusCategory: 'todo' });
      const harness = harnessFor(ticket, lifecycle(slots), {
        settings: { ticketStatusPolicy: policy },
      });
      await harness.publish([ticketMatched()]);
      await putAt(harness, {
        state: shape.state,
        currentStage: shape.currentStage as Slug,
        stageAttempts: shape.stageAttempts,
      });
      ticket.state.status = 'Released';
      ticket.state.statusCategory = 'done';
      await harness.publish([released('Doing')]);
      await harness.drain();
      expect(taskOf(harness).task.state, shape.state).toBe(shape.state);
      expect(eventsOf(harness, 'task.cancelled'), shape.state).toHaveLength(0);
    }
  });

  it('under stop, a running task still escalates with one click to cancel', async () => {
    const ticket = tracker({ stealAfterAssign: 'jane', status: 'To Do', statusCategory: 'todo' });
    const harness = harnessFor(ticket, lifecycle(slots), {
      settings: {
        ticketStatusPolicy: ticketStatusPolicyOf('Ready for the agent', {
          ...slots,
          on_ticket_closed: 'stop',
        }),
      },
    });
    await harness.publish([ticketMatched()]);
    await putAt(harness, {
      state: 'paused',
      currentStage: 'implementation' as Slug,
      stageAttempts: { refinement: 1, implementation: 1 },
    });
    ticket.state.status = 'Released';
    ticket.state.statusCategory = 'done';
    await harness.publish([released('Doing')]);
    await harness.drain();
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(
      (eventsOf(harness, 'task.escalated').at(-1)?.payload as { reason: string } | undefined)
        ?.reason,
    ).toBe('ticket_closed_in_tracker');
    expect(eventsOf(harness, 'task.cancelled')).toHaveLength(0);
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

// ── S-26.2: the claim keeps a member's ticket ───────────────────────────────

/** A linked member of the project (S-26.2), a linked person below member, and a platform-set owner. */
const ALICE = '00000000-0000-4000-8000-00000000a11c' as Id;
const VIEWER = '00000000-0000-4000-8000-0000000000c0' as Id;
const BOB = '00000000-0000-4000-8000-0000000000b0' as Id;

/**
 * {@link harnessFor}, with the owner directory seeded (the memory store's divergence 14): `alice`
 * is a linked member, `viewer` is linked to a user below `member`, `jane` is linked to nobody, and
 * the binding acts as `agentic-bot`.
 */
const memberHarnessFor = (
  ticket: ReturnType<typeof tracker>,
  ticketLifecycle: BindingLifecycle | null,
  options: HarnessOptions = {},
): PipelineHarness => {
  const harness = harnessFor(ticket, ticketLifecycle, options);
  harness.store.seedIdentity('fake-jira', 'alice', ALICE);
  harness.store.seedIdentity('fake-jira', 'viewer', VIEWER);
  harness.store.seedProjectMember(PROJECT, ALICE);
  harness.store.seedProjectMember(PROJECT, BOB);
  harness.store.seedBindingAccount(PROJECT, 'fake-jira', SELF_ID);
  return harness;
};

const assigns = (ticket: ReturnType<typeof tracker>): number =>
  ticket.calls.filter((call) => call === 'assignToSelf').length;

const ticketUpdated = () =>
  event('ticket.updated', {
    project_id: PROJECT,
    ticket: { ...TICKET },
    updated_at: '2026-06-01T10:00:00.000Z',
    changed_fields: ['assignee'],
    truncated: false,
  });

describe('S-26.2 — the claim keeps a member’s ticket (BD-031 amendment 2, TD-031 amendment item 5)', () => {
  it('(1) intake takes a linked member’s ticket with take_assigned_tickets false; an unlinked person or a non-member is still skipped', async () => {
    for (const [assignee, taken] of [
      ['alice', true],
      ['jane', false],
      ['viewer', false],
    ] as const) {
      const ticket = tracker({ assignee });
      const harness = memberHarnessFor(
        ticket,
        lifecycle({ in_progress: 'Doing', take_assigned_tickets: false }),
        { runsAgents: false },
      );
      await harness.publish([ticketMatched()]);
      expect(harness.store.snapshot().length, assignee).toBe(taken ? 1 : 0);
      expect(eventsOf(harness, 'ticket.intake.skipped').length, assignee).toBe(taken ? 0 : 1);
      if (taken) {
        expect(harness.store.ownershipOf(taskOf(harness).task.id).ownerUserId).toBe(ALICE);
      }
      // Intake writes nothing to the tracker either way.
      expect(assigns(ticket), assignee).toBe(0);
    }
  });

  it('(2) the first claim of a member-held ticket writes no assign, records held_by member, moves to in_progress and runs', async () => {
    const ticket = tracker({ assignee: 'alice' });
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);

    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    // Canary: before S-26.2 intake skipped this ticket, and with take_assigned_tickets the claim
    // re-assigned it to the binding's own account.
    expect(assigns(ticket)).toBe(0);
    expect(harness.audit.entriesFor('assign_to_self')).toHaveLength(0);
    expect(ticket.state.assignee).toBe('alice');
    expect(ticket.calls).toContain('transition:Doing');
    expect(await claimOf(harness)).toMatchObject({
      account_id: SELF_ID,
      status: 'confirmed',
      in_progress_written: true,
      held_by: 'member',
      stale: false,
    });
    const claimed = eventsOf(harness, 'ticket.claimed');
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.payload).toMatchObject({ held_by: 'member', in_progress_written: true });
    expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(0);
    expect(runsCreated(harness)).toBeGreaterThan(1);
    expect(harness.store.ownershipOf(taskOf(harness).task.id).ownerUserId).toBe(ALICE);
  });

  it('(2) a re-claim after a human return reads the holder first and keeps a linked member’s ticket', async () => {
    const ticket = tracker({ assignee: 'alice' });
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
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
        stale_cause: 'human_return',
      });
    });
    const reads = ticket.reads.length;
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId: stored.task.id,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'proceed' });
    // The pre-read a re-claim skipped before S-26.2, and no re-read: the platform wrote nothing.
    expect(ticket.reads.length - reads).toBe(1);
    expect(ticket.calls).toEqual(['selfIdentity', 'transition:Doing']);
    expect(ticket.state.assignee).toBe('alice');
    expect(await claimRecordOf(harness, stored.task.id)).toMatchObject({
      held_by: 'member',
      stale: false,
      stale_cause: null,
    });
    // The pre-read synced the owner (backlog 1087).
    expect(harness.store.ownershipOf(stored.task.id)).toMatchObject({
      ownerUserId: ALICE,
      ownerSource: 'tracker',
      ticketAssignee: { external_id: 'alice', platform: false },
    });
  });

  it('(3) a non-member holder keeps ticket_assigned_elsewhere and its marked comment, with no assign', async () => {
    const ticket = tracker({ assignee: 'viewer' });
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness);
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId: stored.task.id,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'refused', reason: 'ticket_assigned_elsewhere' });
    expect(ticket.calls).toEqual(['selfIdentity']);
    expect(ticket.state.assignee).toBe('viewer');
    expect(ticket.state.comments.map((comment) => comment.markerId)).toEqual([
      `agentic:claim-refused:${stored.task.id}`,
    ]);
    expect(await claimRecordOf(harness, stored.task.id)).toBeNull();
  });

  it('(3) take_assigned_tickets re-assigns only a holder who is not a linked member', async () => {
    for (const [holder, reassigned] of [
      ['jane', true],
      ['viewer', true],
      ['alice', false],
    ] as const) {
      const ticket = tracker({ assignee: holder });
      const harness = memberHarnessFor(
        ticket,
        lifecycle({ in_progress: 'Doing', take_assigned_tickets: true }),
      );
      const stored = await insertTask(harness);
      const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
        taskId: stored.task.id,
        ...REFINEMENT_1,
      });
      expect(outcome, holder).toEqual({ kind: 'proceed' });
      expect(assigns(ticket), holder).toBe(reassigned ? 1 : 0);
      expect(ticket.state.assignee, holder).toBe(reassigned ? SELF_ID : holder);
      const record = await claimRecordOf(harness, stored.task.id);
      expect(record?.held_by, holder).toBe(reassigned ? undefined : 'member');
    }
  });

  it('(4) the claim’s assign sets ticket_assignee in its transaction, and the next owner_sync changes nothing', async () => {
    const ticket = tracker();
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness);
    const taskId = stored.task.id;
    // A maintainer gives the task to Bob on the platform before its first claim.
    await setTaskOwnerCommand(
      {
        unitOfWork: harness.commands.unitOfWork,
        store: harness.store,
        ids: harness.ids,
        clock: harness.clock,
      },
      { taskId, actorUserId: VIEWER, actorRole: 'maintainer', targetUserId: BOB },
    );
    await ensureTicketClaim(claimOptions(harness), stored, { taskId, ...REFINEMENT_1 });
    expect(ticket.state.assignee).toBe(SELF_ID);
    const afterClaim = harness.store.ownershipOf(taskId);
    expect(afterClaim).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'platform',
      ticketAssignee: {
        provider: 'fake-jira',
        external_id: SELF_ID,
        display_name: null,
        platform: true,
      },
    });
    const ownerChanges = eventsOf(harness, 'task.owner.changed').length;

    // The tracker announces the edit the claim made; the duty reads the binding's own account.
    const reads = ticket.reads.length;
    await harness.publish([ticketUpdated()]);
    expect(ticket.reads.length - reads).toBe(1);
    expect(harness.store.ownershipOf(taskId)).toEqual(afterClaim);
    expect(eventsOf(harness, 'task.owner.changed')).toHaveLength(ownerChanges);
  });

  it('a claim whose pre-read answers no ticket syncs nothing: the tracker owner is kept', async () => {
    // The pre-read answers `null`; the re-read after the assign finds the ticket.
    const ticket = tracker({ nullReads: 1 });
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    const stored = await insertTask(harness);
    const taskId = stored.task.id;
    const alice = {
      provider: 'fake-jira',
      external_id: 'alice',
      display_name: null,
      platform: false,
    };
    await harness.memory.transaction(async (scope) => {
      const written = await harness.store.tasks.saveOwner(scope.tx, taskId, {
        expected: { ownerUserId: null, ticketAssignee: null },
        next: {
          ownerUserId: ALICE,
          ownerSource: 'tracker',
          ownerChangedAt: '2026-06-01T08:00:00.000Z' as StoredTicketClaim['claimed_at'],
          ticketAssignee: alice,
        },
      });
      expect(written).toBe(true);
    });
    const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
      taskId,
      ...REFINEMENT_1,
    });
    expect(outcome).toEqual({ kind: 'proceed' });
    expect(ticket.reads).toHaveLength(2);
    // Canary: syncing the null read cleared Alice as a `tracker_sync`.
    expect(eventsOf(harness, 'task.owner.changed')).toHaveLength(0);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: ALICE,
      ownerSource: 'tracker',
    });
  });

  it('(5) a cancel never unassigns a member-held ticket', async () => {
    const ticket = tracker({ assignee: 'alice' });
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    await cancelTaskCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
    });
    await harness.drain();

    expect(ticket.calls).not.toContain('unassign');
    expect(harness.audit.entriesFor('unassign')).toHaveLength(0);
    expect(ticket.state.assignee).toBe('alice');
    expect(eventsOf(harness, 'ticket.released')[0]?.payload).toMatchObject({
      unassigned: false,
      cause: 'cancelled',
    });
  });

  it('(5) a Rework never unassigns a member-held ticket, and its re-claim keeps it with them', async () => {
    const ticket = tracker({ assignee: 'alice' });
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    await reworkStageCommand(harness.humanCommands, {
      taskId: taskOf(harness).task.id,
      userId: USER,
      stage: 'implementation' as Slug,
      instructions: 'take the other approach',
    });
    await harness.drain();

    expect(ticket.calls).not.toContain('unassign');
    expect(assigns(ticket)).toBe(0);
    expect(ticket.state.assignee).toBe('alice');
    expect(eventsOf(harness, 'ticket.released').at(-1)?.payload).toMatchObject({
      unassigned: false,
      cause: 'rework',
    });
    expect(await claimOf(harness)).toMatchObject({ held_by: 'member', stale: false });
    expect(eventsOf(harness, 'ticket.claimed')).toHaveLength(2);
  });

  it('a Rework’s unassign is recorded as the last-seen assignee, so a platform-set owner survives the re-claim’s read', async () => {
    const ticket = tracker();
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    const taskId = taskOf(harness).task.id;
    await setTaskOwnerCommand(
      {
        unitOfWork: harness.commands.unitOfWork,
        store: harness.store,
        ids: harness.ids,
        clock: harness.clock,
      },
      { taskId, actorUserId: VIEWER, actorRole: 'maintainer', targetUserId: BOB },
    );
    await reworkStageCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'implementation' as Slug,
      instructions: 'take the other approach',
    });
    await harness.drain();

    // The release unassigned the binding's account and the re-claim assigned it again.
    expect(ticket.calls.filter((call) => call === 'unassign')).toHaveLength(1);
    expect(ticket.state.assignee).toBe(SELF_ID);
    // Canary: without the release's record, the re-claim's read (nobody) differs from the stored
    // binding account and costs Bob the task.
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'platform',
      ticketAssignee: { external_id: SELF_ID, platform: true },
    });
  });
});

// ── A take unblocks the claim (TD-031's amendment item 5, as amended for a take) ──────────────

/** The maintainer who takes the task on the platform — Bob, a member of the project. */
const takeAs = async (harness: PipelineHarness, taskId: Id): Promise<void> => {
  await setTaskOwnerCommand(
    {
      unitOfWork: harness.commands.unitOfWork,
      store: harness.store,
      ids: harness.ids,
      clock: harness.clock,
    },
    { taskId, actorUserId: BOB, actorRole: 'maintainer', targetUserId: BOB },
  );
};

/** AUT-6676's shape: unassigned at intake, then Jane — linked to nobody — takes it in Jira. */
const janeTakesBeforeTheClaim = (options: TrackerOptions = {}) =>
  tracker({ takenBeforeTheClaimBy: 'jane', ...options });

describe('a take unblocks the claim (TD-031 amendment item 5 as amended for a take, AUT-6676)', () => {
  it.each([
    ['a maintainer takes the task', true],
    ['nobody takes it (canary)', false],
  ])('the claim refuses Jane’s ticket, then the hand-back: %s', async (_label, take) => {
    const ticket = janeTakesBeforeTheClaim();
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    const taskId = taskOf(harness).task.id;
    expect(taskOf(harness).task.state).toBe('needs_human');
    expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(1);
    expect(runsCreated(harness)).toBe(0);
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: null,
      ticketAssignee: { external_id: 'jane', platform: false },
    });

    if (take) {
      await takeAs(harness, taskId);
      expect(harness.store.ownershipOf(taskId)).toMatchObject({
        ownerUserId: BOB,
        ownerSource: 'platform',
      });
    }
    await handBackTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'refinement' as Slug,
      summary: 'Bob works this one',
    });
    await harness.drain();

    // Jane keeps the ticket in the tracker either way: the platform never writes over her.
    expect(assigns(ticket)).toBe(0);
    expect(harness.audit.entriesFor('assign_to_self')).toHaveLength(0);
    expect(ticket.state.assignee).toBe('jane');
    if (!take) {
      // Before the amendment this was the taken task's fate too: refused again, escalated again.
      expect(taskOf(harness).task.state).toBe('needs_human');
      expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(2);
      expect(eventsOf(harness, 'task.escalated')).toHaveLength(2);
      expect(runsCreated(harness)).toBe(0);
      return;
    }
    expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(1);
    expect(eventsOf(harness, 'task.escalated')).toHaveLength(1);
    expect(runsCreated(harness)).toBeGreaterThan(0);
    expect(harness.specs.map((spec) => spec.stage)).toContain('refinement');
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(ticket.calls).toContain('transition:Doing');
    expect(await claimOf(harness)).toMatchObject({
      account_id: SELF_ID,
      status: 'confirmed',
      held_by: 'platform_owner',
      stale: false,
    });
    expect(eventsOf(harness, 'ticket.claimed').map((entry) => entry.payload)).toEqual([
      expect.objectContaining({ held_by: 'platform_owner', in_progress_written: true }),
    ]);
    // The owner the take set survives every read of Jane since.
    expect(harness.store.ownershipOf(taskId)).toMatchObject({
      ownerUserId: BOB,
      ownerSource: 'platform',
      ticketAssignee: { external_id: 'jane', platform: false },
    });

    // The release of a kept claim makes no unassign call: the platform assigned nothing.
    await cancelTaskCommand(harness.humanCommands, { taskId, userId: USER });
    await harness.drain();
    expect(ticket.calls).not.toContain('unassign');
    expect(ticket.state.assignee).toBe('jane');
    expect(eventsOf(harness, 'ticket.released').at(-1)?.payload).toMatchObject({
      unassigned: false,
      cause: 'cancelled',
    });
  });

  it('a re-claim after a human return keeps Jane’s ticket on a taken task, and assigns it on one nobody took', async () => {
    for (const take of [true, false]) {
      const ticket = tracker({ assignee: 'jane' });
      const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
      const stored = await insertTask(harness);
      const taskId = stored.task.id;
      await harness.memory.transaction(async (scope) => {
        await harness.store.tasks.saveTicketClaim(scope.tx, taskId, {
          account_id: SELF_ID,
          claimed_at: '2026-06-01T08:00:00.000Z' as StoredTicketClaim['claimed_at'],
          status: 'confirmed',
          in_progress_written: true,
          stale: true,
          released_at: null,
          release_cause: null,
          stale_cause: 'human_return',
        });
        // The platform last read Jane (the human return's own read), as on a live task.
        const written = await harness.store.tasks.saveOwner(scope.tx, taskId, {
          expected: { ownerUserId: null, ticketAssignee: null },
          next: {
            ownerUserId: null,
            ownerSource: null,
            ownerChangedAt: null,
            ticketAssignee: {
              provider: 'fake-jira',
              external_id: 'jane',
              display_name: null,
              platform: false,
            },
          },
        });
        expect(written).toBe(true);
      });
      if (take) {
        await takeAs(harness, taskId);
      }
      const outcome = await ensureTicketClaim(claimOptions(harness), stored, {
        taskId,
        ...REFINEMENT_1,
      });
      expect(outcome, String(take)).toEqual({ kind: 'proceed' });
      if (take) {
        // No assign and no re-read: the platform wrote nothing, so there is no race to decide.
        expect(ticket.calls).toEqual(['selfIdentity', 'transition:Doing']);
        expect(ticket.state.assignee).toBe('jane');
        expect(await claimRecordOf(harness, taskId)).toMatchObject({
          held_by: 'platform_owner',
          stale: false,
          stale_cause: null,
        });
      } else {
        // Canary: a re-claim takes the ticket back from anybody else when nobody took the task.
        expect(assigns(ticket)).toBe(1);
        expect(ticket.state.assignee).toBe(SELF_ID);
        expect((await claimRecordOf(harness, taskId))?.held_by).toBeUndefined();
      }
    }
  });

  it('a platform owner who may no longer own the project’s tasks keeps nothing: the claim refuses as before', async () => {
    const ticket = janeTakesBeforeTheClaim();
    const harness = memberHarnessFor(ticket, lifecycle({ in_progress: 'Doing' }));
    await harness.publish([ticketMatched()]);
    const taskId = taskOf(harness).task.id;
    await takeAs(harness, taskId);
    // Bob leaves the project after the take (`mayOwn` answers false).
    harness.store.unseedProjectMember(PROJECT, BOB);
    await handBackTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'refinement' as Slug,
      summary: 'Bob works this one',
    });
    await harness.drain();
    expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(2);
    expect(assigns(ticket)).toBe(0);
  });

  it('with the owner write-back on, the take assigns Bob in the tracker and the claim keeps him as a member: no fight', async () => {
    const ticket = janeTakesBeforeTheClaim({ assignsOthers: true });
    const harness = memberHarnessFor(
      ticket,
      lifecycle({ in_progress: 'Doing', assign_owner: true }),
    );
    harness.store.seedIdentity('fake-jira', 'bob', BOB);
    await harness.publish([ticketMatched()]);
    const taskId = taskOf(harness).task.id;
    expect(eventsOf(harness, 'ticket.claim.refused')).toHaveLength(1);

    await takeAs(harness, taskId);
    await harness.drain();
    expect(ticket.state.assignee).toBe('bob');
    await handBackTaskCommand(harness.humanCommands, {
      taskId,
      userId: USER,
      stage: 'refinement' as Slug,
      summary: 'Bob works this one',
    });
    await harness.drain();

    expect(ticket.calls.filter((call) => call.startsWith('assignTo:'))).toEqual(['assignTo:bob']);
    expect(assigns(ticket)).toBe(0);
    expect(ticket.state.assignee).toBe('bob');
    expect(await claimOf(harness)).toMatchObject({ held_by: 'member', stale: false });
    expect(taskOf(harness).task.state).toBe('ready_for_merge');
    expect(harness.store.ownershipOf(taskId)).toMatchObject({ ownerUserId: BOB });
  });
});
