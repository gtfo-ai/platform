/**
 * The conflict warning, driven through the real handler, the real `pipeline.outbound` duty and the
 * real `IntegrationActionExecutor` over the in-memory doubles (WP-26, product/04 S6b).
 *
 * The e2e tier runs the same thing on PostgreSQL inside an `apps/server` instance; this tier is
 * where the **branches** live — the overlap and the non-overlap (standing rule 42), a project with
 * no peer at all, a path carrying a credential, and the second gate entry that must post nothing
 * twice.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import type { Discussion, FileDiff } from '../ports/integrations/git-provider.js';
import {
  createPipelineHarness,
  type HarnessOptions,
  type PipelineHarness,
} from '../testing/pipeline-harness.js';
import { conflictWarningIdempotencyKey, conflictWarningMarker } from './conflict-warning.js';
import type { StoredTask } from './store.js';
import { INITIAL_TASK_VERSION } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const PEER_TASK = '00000000-0000-4000-8000-0000000000c9' as Id;
const IID = 7;
const PEER_IID = 9;
const HEAD = 'b'.repeat(40);

/** An obviously fake credential (BD-002), planted in a *path* so the redaction has a target. */
const PLANTED = 'FAKE-git-token-not-a-real-secret-0000';
const PLACEHOLDER = '[REDACTED:integration:git_token]';

const TICKET = {
  provider: 'fake-jira',
  key: 'ACME-1',
  url: 'https://jira.example.test/browse/ACME-1',
};

const fileDiff = (path: string): FileDiff => ({
  new_path: path,
  old_path: path,
  diff: `@@ -1 +1 @@\n-old\n+new in ${path}\n`,
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  omitted: false,
});

const mergeRequest = (iid: number) => ({
  ref: {
    provider: 'fake-git',
    project_path: 'acme/api',
    iid,
    url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
    branch: 'agentic/acme-1',
    head_sha: HEAD,
  },
  state: 'opened' as const,
  draft: true,
  title: 'Sum the invoice footer',
  description: 'Opened by the developer stage.',
  source_branch: 'agentic/acme-1',
  target_branch: 'main',
  head_sha: HEAD,
  mergeable: true,
  has_conflicts: false,
  labels: [],
  reviewers: [],
  web_url: `https://git.example.test/acme/api/-/merge_requests/${iid}`,
});

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
  mr: {
    url: `https://git.example.test/acme/api/-/merge_requests/${IID}`,
    iid: IID,
    head_sha: HEAD,
    branch: 'agentic/acme-1',
  },
};

const REVIEW = {
  verdict: 'approve',
  findings: [],
  summary: 'ok',
  protected_path_changes_confirmed: [],
};
const ACCEPTANCE = {
  verdict: 'approve',
  criteria: [{ id: 'ac1', status: 'met', evidence: 'totals.test.ts' }],
  scope_creep: [],
  missing: [],
  ux_notes: [],
};

const completedRun = (structuredOutput: unknown) =>
  ({ status: 'completed', terminalReason: 'success', structuredOutput }) as const;

const ticketMatched = (): DomainEvent =>
  domainEventSchemasByType['ticket.matched'].parse({
    id: '00000000-0000-4000-9000-000000000001',
    stream_type: 'project',
    stream_id: PROJECT,
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: { kind: 'system', component: 'test' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'ticket.matched',
    payload: {
      project_id: PROJECT,
      ticket: TICKET,
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  }) as DomainEvent;

interface Posted {
  readonly iid: number;
  readonly markdown: string;
}

interface WarningHarness {
  readonly harness: PipelineHarness;
  readonly posted: readonly Posted[];
  /** Every `getMergeRequestDiff` the duty made, by iid — the read whose cost is bounded. */
  readonly diffReads: readonly number[];
}

const startHarness = (options: {
  /** The peer task's changed paths; no peer task is created when this is absent. */
  readonly peerPaths?: readonly string[];
  readonly ownPaths?: readonly string[];
  readonly harness?: HarnessOptions;
}): WarningHarness => {
  const posted: Posted[] = [];
  const diffReads: number[] = [];
  const harness = createPipelineHarness({
    projectId: PROJECT,
    runs: {
      refinement: completedRun(REFINED_SPEC),
      architecture: completedRun(PLAN),
      implementation: completedRun(NOTES),
      code_review: completedRun(REVIEW),
      business_review: completedRun(ACCEPTANCE),
    },
    gitRedactor: exactSecretRedactor([{ name: 'git_token', value: PLANTED }]),
    git: {
      getPipelineStatus: async () => null,
      getMergeRequest: async (ref) => mergeRequest(ref.iid) as never,
      getMergeRequestDiff: async (ref) => {
        diffReads.push(ref.iid);
        const paths =
          ref.iid === IID ? (options.ownPaths ?? ['src/totals.ts']) : (options.peerPaths ?? []);
        return paths.map(fileDiff);
      },
      createDiscussion: async (ref, note) => {
        posted.push({ iid: ref.iid, markdown: note.markdown });
        return {
          id: `disc-${posted.length}`,
          resolvable: true,
          resolved: false,
          notes: [],
        } as Discussion;
      },
    },
    ...options.harness,
  });
  return { harness, posted, diffReads };
};

/** A peer task, inserted as a row: the feature under test is the *comparison*, not its creation. */
const insertPeer = async (
  harness: PipelineHarness,
  ticketKey: string,
  mode: 'normal' | 'shadow' = 'normal',
): Promise<void> => {
  await harness.memory.transaction(async (scope) => {
    const stored: StoredTask = {
      task: {
        id: PEER_TASK,
        projectId: PROJECT,
        ticket: {
          provider: 'fake-jira',
          key: ticketKey,
          url: `https://jira.example.test/browse/${ticketKey}`,
        },
        template: 'feature',
        mode,
        state: 'active',
        currentStage: 'implementation',
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
      createdAt: '2026-06-01T08:00:00.000Z',
      branch: 'agentic/acme-9',
      mr: {
        provider: 'fake-git',
        project_path: 'acme/api',
        iid: PEER_IID,
        url: `https://git.example.test/acme/api/-/merge_requests/${PEER_IID}`,
        branch: 'agentic/acme-9',
        head_sha: 'c'.repeat(40),
      },
      workpad: null,
      costActualUsd: 0,
      estimateUsd: null,
      estimateBasis: null,
      estimateSamples: null,
      ticketSnapshot: null,
      ticketSnapshotAt: null,
      reviewSubject: null,
      historySample: null,
      riskClasses: [],
      coverage: null,
      dependencies: null,
      requiredReviewers: null,
      requestedByUserId: null,
      version: INITIAL_TASK_VERSION,
    };
    await harness.store.tasks.insert(scope.tx, stored);
  });
};

const warnings = (harness: PipelineHarness) =>
  harness
    .events()
    .filter((entry) => entry.type === 'task.conflict.warned')
    .map((entry) => entry.payload as Record<string, unknown>);

describe('the conflict warning (product/04 S6b, BD-030)', () => {
  it('names the other task and the files both branches touch', async () => {
    const started = startHarness({
      ownPaths: ['src/totals.ts', 'src/footer.ts'],
      peerPaths: ['src/totals.ts', 'src/vat.ts'],
    });
    await insertPeer(started.harness, 'ACME-9');
    await started.harness.publish([ticketMatched()]);

    // **Both** merge requests of the pair (WP-59, backlog 65): until then only this task's was
    // told, and the peer — whose developer may be the one about to push the conflicting change —
    // heard nothing because its own gate had already run.
    expect(started.posted.map((thread) => thread.iid).sort()).toEqual([IID, PEER_IID]);
    const thread = started.posted.find((entry) => entry.iid === IID);
    expect(thread?.markdown).toContain('ACME-9');
    expect(thread?.markdown).toContain('src/totals.ts');
    // The files that are *not* shared are not named — a warning that listed the whole diff would be
    // a warning nobody reads.
    expect(thread?.markdown).not.toContain('src/vat.ts');
    expect(thread?.markdown).not.toContain('src/footer.ts');
    // The peer's thread names **this** task, carries the peer's own marker, and the same paths.
    const peerThread = started.posted.find((entry) => entry.iid === PEER_IID);
    expect(peerThread?.markdown).toContain(TICKET.key);
    expect(peerThread?.markdown).toContain(conflictWarningMarker(PEER_TASK));
    expect(peerThread?.markdown).toContain('src/totals.ts');
    expect(peerThread?.markdown).not.toContain('src/vat.ts');

    const self = warnings(started.harness).filter((entry) => entry.task_id !== PEER_TASK);
    expect(self).toEqual([
      expect.objectContaining({
        project_id: PROJECT,
        other_task_id: PEER_TASK,
        other_ticket_key: 'ACME-9',
        paths: ['src/totals.ts'],
        path_count: 1,
        truncated: false,
      }),
    ]);
    // …and the mirror on the peer's own stream, at no extra provider read (the read count is the
    // next case's), so the board badge is on both cards.
    const peerEvents = started.harness
      .events()
      .filter((entry) => entry.type === 'task.conflict.warned' && entry.stream_id === PEER_TASK);
    expect(peerEvents).toHaveLength(1);
    expect(peerEvents[0]?.payload).toEqual(
      expect.objectContaining({
        task_id: PEER_TASK,
        other_task_id: self[0]?.task_id,
        other_ticket_key: TICKET.key,
        paths: ['src/totals.ts'],
        path_count: 1,
        mr: expect.objectContaining({ iid: PEER_IID }),
      }),
    );
  });

  it('makes a peer writer that loaded before the warning retry at its save, and complete', async () => {
    /**
     * WP-59 review round 1. The peer's half of a warning lands on a **live** stream, and the peer's
     * own writer — a stage executor's closing write, a handler, a human command — loads, decides,
     * saves and appends. Interleaved here exactly where it hurts: the peer's writer has loaded, then
     * the other task's gate warns it, then the writer saves and appends at the sequence it loaded.
     * Without the version bump the save succeeds and the append meets the stream guard's
     * `StreamConflictError`, which nobody retries; with it, the save refuses with
     * `TaskConcurrentModificationError`, `retryOnTaskConflict` runs the unit again, and it
     * completes on the fresh sequence.
     */
    const started = startHarness({ ownPaths: ['src/totals.ts'], peerPaths: ['src/totals.ts'] });
    await insertPeer(started.harness, 'ACME-9');
    let attempts = 0;
    await retryOnTaskConflict({ taskId: PEER_TASK, what: 'the peer’s own write' }, async () =>
      started.harness.memory.transaction(async (scope) => {
        attempts += 1;
        const peer = (await started.harness.store.tasks.load(scope.tx, PEER_TASK)) as StoredTask;
        if (attempts === 1) {
          // The other task's rebase gate runs now and warns this peer, on its stream.
          await started.harness.publish([ticketMatched()]);
        }
        const saved = await started.harness.store.tasks.save(scope.tx, {
          ...peer,
          priorityRank: 1,
        });
        await scope.events.append([
          domainEventSchemasByType['task.escalated'].parse({
            id: '00000000-0000-4000-9000-0000000000e1',
            stream_type: 'task',
            stream_id: PEER_TASK,
            stream_seq: peer.task.sequence,
            correlation_id: PEER_TASK,
            cause_event_id: null,
            actor: { kind: 'system', component: 'test' },
            occurred_at: '2026-06-01T10:00:00.000Z',
            type: 'task.escalated',
            payload: {
              project_id: PROJECT,
              task_id: PEER_TASK,
              reason: 'the peer’s own decision',
              blocker_brief: 'written by the peer’s own writer',
            },
          }) as DomainEvent,
        ]);
        return saved;
      }),
    );

    expect(attempts).toBe(2);
    const peerStream = started.harness
      .events()
      .filter((event) => event.stream_type === 'task' && event.stream_id === PEER_TASK);
    // The warning and then the peer's own event, one after the other: neither was lost.
    expect(peerStream.map((event) => event.type)).toEqual([
      'task.conflict.warned',
      'task.escalated',
    ]);
    expect(peerStream.map((event) => event.stream_seq)).toEqual([1, 2]);
    // And the peer's save committed: one bump by the warning, one by the retried save.
    const peerRow = started.harness.store.snapshot().find((entry) => entry.task.id === PEER_TASK);
    expect(peerRow?.version).toBe(INITIAL_TASK_VERSION + 2);
  });

  it('bumps every stream it appends to in sorted id order, before loading any of them', async () => {
    // Review round 2: two gates warning each other at once must lock the two rows in one global
    // order, or PostgreSQL answers one of them `40P01`. The calls are recorded as a trace of bumps
    // and loads; the warning's own run of bumps is the one that contains the peer's (nothing else
    // bumps the peer here), and it must be sorted and come before the loads that follow it.
    const started = startHarness({ ownPaths: ['src/totals.ts'], peerPaths: ['src/totals.ts'] });
    await insertPeer(started.harness, 'ACME-9');
    const tasks = started.harness.store.tasks as unknown as {
      bumpVersion: (tx: unknown, id: Id) => Promise<void>;
      load: (tx: unknown, id: Id) => Promise<StoredTask | null>;
    };
    const bump = tasks.bumpVersion;
    const load = tasks.load;
    const trace: string[] = [];
    tasks.bumpVersion = async (tx, id) => {
      trace.push(`bump:${id}`);
      return bump(tx, id);
    };
    tasks.load = async (tx, id) => {
      trace.push(`load:${id}`);
      return load(tx, id);
    };
    await started.harness.publish([ticketMatched()]);
    const own = started.harness.store
      .snapshot()
      .find((entry) => entry.task.ticket.key === TICKET.key)?.task.id as Id;

    const at = trace.indexOf(`bump:${PEER_TASK}`);
    expect(at).toBeGreaterThanOrEqual(0);
    let first = at;
    while (first > 0 && trace[first - 1]?.startsWith('bump:')) {
      first -= 1;
    }
    let last = at;
    while (trace[last + 1]?.startsWith('bump:')) {
      last += 1;
    }
    const run = trace.slice(first, last + 1).map((entry) => entry.slice('bump:'.length));
    expect(run).toEqual([own, PEER_TASK].sort());
    // …and only then the loads the appends read their sequences from.
    expect(trace[last + 1]).toMatch(/^load:/);
  });

  it('warns a shadow peer’s stream and records its thread as would_have, posting nothing there', async () => {
    const started = startHarness({ ownPaths: ['src/totals.ts'], peerPaths: ['src/totals.ts'] });
    await insertPeer(started.harness, 'ACME-9', 'shadow');
    await started.harness.publish([ticketMatched()]);

    // Only this task's merge request got a real thread: the peer's mode governs the peer's write.
    expect(started.posted.map((thread) => thread.iid)).toEqual([IID]);
    const peerWrites = started.harness.audit
      .entriesFor('create_discussion')
      .filter((entry) => entry.taskId === PEER_TASK);
    expect(peerWrites.map((entry) => entry.status)).toEqual(['would_have']);
    expect(
      started.harness
        .events()
        .filter((entry) => entry.type === 'task.conflict.warned' && entry.stream_id === PEER_TASK),
    ).toHaveLength(1);
  });

  it('says nothing when the two branches touch different files', async () => {
    const started = startHarness({
      ownPaths: ['src/totals.ts'],
      peerPaths: ['docs/readme.md'],
    });
    await insertPeer(started.harness, 'ACME-9');
    await started.harness.publish([ticketMatched()]);

    expect(started.posted).toEqual([]);
    expect(warnings(started.harness)).toEqual([]);
    /**
     * …and it looked: the negative is a comparison that happened, not a duty that never ran
     * (standing rule 4 — every assertion above is satisfied by a duty that did nothing).
     *
     * **Two reads since WP-59, one per merge request.** Three duties want this task's diff — WP-38's
     * dependency gate when the Developer stage completes, and at the rebase gate the warning and
     * WP-37's classification — and until WP-59 each asked the provider, which was `[IID, IID, IID,
     * PEER_IID]` here (PROGRESS backlog **64**). They now share one read per `(merge request, head
     * sha)` (`diff-coalescer.ts`): this harness reaches the gate at the revision the Developer
     * stage reported, inside the window, so the first asker's answer serves the other two. Counted
     * sorted because the duties are separate jobs and their order on the queue is the queue's.
     */
    expect([...started.diffReads].sort()).toEqual([IID, PEER_IID]);
  });

  it('reads no diff at all when the project has no other task with a merge request', async () => {
    const started = startHarness({ ownPaths: ['src/totals.ts'] });
    await started.harness.publish([ticketMatched()]);

    expect(started.posted).toEqual([]);
    expect(warnings(started.harness)).toEqual([]);
    /**
     * The peer list is read first and *this* duty gives up on an empty one, so an ordinary project
     * pays nothing **for the warning**.
     *
     * The two reads that remain are WP-37's and WP-38's, and neither may be skipped for a project
     * with no peer task: the gate entry classifies this task's own changed paths, and the Developer
     * stage's completion reads them for the dependency policy. That is precisely why each is a duty
     * of its own rather than a branch inside this one (`risk-routing.ts` carries the argument).
     *
     * **One read since WP-59**, where it was `[IID, IID]`: the dependency gate reads the diff when
     * the implementation stage completes, several transitions before the rebase gate, and the
     * classification at the gate asks for the same revision inside the coalescing window
     * (`diff-coalescer.ts`), so it is answered from that read. A gate reached later than the window
     * reads again — the residual the coalescer's docblock states.
     */
    expect(started.diffReads).toEqual([IID]);
  });

  it('pays three provider reads for one gate entry on a project with no peer, and no diff read', async () => {
    /**
     * The per-gate-entry floor, pinned as a **count** (WP-59, backlog 64). The re-entry a
     * `default_branch.moved` causes is a gate entry and nothing else, so the audit rows it adds are
     * exactly what one entry costs: the rebase gate's own mergeability read (`get_merge_request`),
     * and the classification's default branch and `CODEOWNERS`. Its diff read is answered by the
     * coalescer — the revision has not moved — which is the one read WP-59 removed from this floor:
     * it was **four**, measured by running this case with the coalescer bypassed (WP-59's notes).
     */
    const started = startHarness({ ownPaths: ['src/totals.ts'] });
    await started.harness.publish([ticketMatched()]);
    started.harness.audit.reset();

    await started.harness.publish([
      domainEventSchemasByType['default_branch.moved'].parse({
        id: '00000000-0000-4000-9000-000000000003',
        stream_type: 'project',
        stream_id: PROJECT,
        stream_seq: 2,
        correlation_id: null,
        cause_event_id: null,
        actor: { kind: 'system', component: 'test' },
        occurred_at: '2026-06-01T10:00:00.000Z',
        type: 'default_branch.moved',
        payload: { project_id: PROJECT, branch: 'main', new_head: 'd'.repeat(40) },
      }) as DomainEvent,
    ]);

    const task = started.harness.store
      .snapshot()
      .find((entry) => entry.task.ticket.key === TICKET.key);
    // The gate really was entered again — otherwise a count of zero reads would pass too.
    expect(task?.task.stageAttempts.rebase_gate).toBe(2);
    const reads = started.harness.audit.entries
      .filter((entry) => entry.integrationId === '00000000-0000-4000-8000-00000000a001')
      .map((entry) => entry.action)
      .sort();
    expect(reads).toEqual(['get_default_branch_head', 'get_merge_request', 'read_codeowners']);
    expect(started.diffReads).toEqual([IID]);
  });

  it('keeps a credential out of the thread and out of the stored event', async () => {
    // A path is provider text like any other, and nothing upstream redacts it: the duty is the
    // first and only place it can be done (BD-022, TD-012).
    const path = `src/${PLANTED}/totals.ts`;
    const started = startHarness({ ownPaths: [path], peerPaths: [path] });
    await insertPeer(started.harness, 'ACME-9');
    await started.harness.publish([ticketMatched()]);

    // Both threads of the pair, and both events: the peer's half is a second sink of each kind.
    expect(started.posted).toHaveLength(2);
    for (const thread of started.posted) {
      expect(thread.markdown).not.toContain(PLANTED);
      expect(thread.markdown).toContain(PLACEHOLDER);
    }
    expect(warnings(started.harness)).toHaveLength(2);
    const stored = JSON.stringify(warnings(started.harness));
    expect(stored).not.toContain(PLANTED);
    expect(stored).toContain(PLACEHOLDER);
  });

  it('keeps a credential out of the stored event when it is the peer’s ticket key', async () => {
    // The other half of the same rule, and the half that shipped unredacted: the ticket key reaches
    // the thread (where `reviewWrites.thread` redacts it on the way out) *and* the `events` row
    // (where nothing does). A ticket key is provider text like a path — a Jira project key is
    // whatever somebody typed — so the duty redacts it before it is capped.
    const key = `ACME-${PLANTED}`;
    const started = startHarness({ ownPaths: ['src/totals.ts'], peerPaths: ['src/totals.ts'] });
    await insertPeer(started.harness, key);
    await started.harness.publish([ticketMatched()]);

    expect(started.posted).toHaveLength(2);
    for (const thread of started.posted) {
      expect(thread.markdown).not.toContain(PLANTED);
    }
    const stored = JSON.stringify(warnings(started.harness));
    expect(stored).not.toContain(PLANTED);
    expect(warnings(started.harness).filter((entry) => entry.task_id !== PEER_TASK)).toEqual([
      expect.objectContaining({ other_ticket_key: `ACME-${PLACEHOLDER}` }),
    ]);
  });

  it('posts one thread however many times the gate is entered on the same revision', async () => {
    const started = startHarness({ ownPaths: ['src/totals.ts'], peerPaths: ['src/totals.ts'] });
    await insertPeer(started.harness, 'ACME-9');
    await started.harness.publish([ticketMatched()]);
    // One per merge request of the pair (WP-59).
    expect(started.posted).toHaveLength(2);

    // The default branch moves, so the gate is re-armed and the duty runs again (WP-26's criterion
    // 1). The head sha has not moved, so the idempotency key is the same one.
    await started.harness.publish([
      domainEventSchemasByType['default_branch.moved'].parse({
        id: '00000000-0000-4000-9000-000000000002',
        stream_type: 'project',
        stream_id: PROJECT,
        stream_seq: 2,
        correlation_id: null,
        cause_event_id: null,
        actor: { kind: 'system', component: 'test' },
        occurred_at: '2026-06-01T10:00:00.000Z',
        type: 'default_branch.moved',
        payload: { project_id: PROJECT, branch: 'main', new_head: 'd'.repeat(40) },
      }) as DomainEvent,
    ]);

    // The gate really did run again — otherwise this case would pass on a duty that never fired.
    const task = started.harness.store
      .snapshot()
      .find((entry) => entry.task.ticket.key === TICKET.key);
    expect(task?.task.stageAttempts.rebase_gate).toBe(2);
    // One thread per merge request, and the replay is the executor's: both keys are read back out
    // of the store it wrote — the peer's is the peer's own identity, which is also what the peer's
    // own gate would compute for this pair.
    expect(started.posted).toHaveLength(2);
    expect(
      [...started.harness.idempotency.keys()].some((key) =>
        key.includes(
          encodeURIComponent(
            conflictWarningIdempotencyKey(PEER_TASK, 'c'.repeat(40), task?.task.id as Id),
          ),
        ),
      ),
    ).toBe(true);
    expect(
      [...started.harness.idempotency.keys()].some((key) => key.includes('conflict_warning')),
    ).toBe(true);
  });

  it('builds its key out of the platform’s own ids and the provider’s revision, and nothing else', () => {
    // The rule WP-24 round 2 earned: no part of an idempotency key is model output, and the one
    // part that is provider text is a sha rather than anybody's prose.
    expect(conflictWarningIdempotencyKey('task-1' as Id, HEAD, 'task-2' as Id)).toBe(
      `conflict_warning:task-1:${HEAD}:task-2`,
    );
    expect(conflictWarningMarker('task-1' as Id)).toBe('<!-- agentic:conflict-warning:task-1 -->');
  });
});
