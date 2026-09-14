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
const insertPeer = async (harness: PipelineHarness, ticketKey: string): Promise<void> => {
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
        mode: 'normal',
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

    expect(started.posted).toHaveLength(1);
    const thread = started.posted[0];
    // On **this** task's merge request, not the peer's: the warning is for the branch that is about
    // to be made ready, and the peer's own gate will tell it in its turn.
    expect(thread?.iid).toBe(IID);
    expect(thread?.markdown).toContain('ACME-9');
    expect(thread?.markdown).toContain('src/totals.ts');
    // The files that are *not* shared are not named — a warning that listed the whole diff would be
    // a warning nobody reads.
    expect(thread?.markdown).not.toContain('src/vat.ts');
    expect(thread?.markdown).not.toContain('src/footer.ts');

    expect(warnings(started.harness)).toEqual([
      expect.objectContaining({
        project_id: PROJECT,
        other_task_id: PEER_TASK,
        other_ticket_key: 'ACME-9',
        paths: ['src/totals.ts'],
        path_count: 1,
        truncated: false,
      }),
    ]);
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
    // …and it looked: the negative is a comparison that happened, not a duty that never ran
    // (standing rule 4 — every assertion above is satisfied by a duty that did nothing).
    expect(started.diffReads).toEqual([IID, PEER_IID]);
  });

  it('reads no diff at all when the project has no other task with a merge request', async () => {
    const started = startHarness({ ownPaths: ['src/totals.ts'] });
    await started.harness.publish([ticketMatched()]);

    expect(started.posted).toEqual([]);
    expect(warnings(started.harness)).toEqual([]);
    // The peer list is read first and the duty gives up on an empty one, so an ordinary project
    // pays nothing for this feature.
    expect(started.diffReads).toEqual([]);
  });

  it('keeps a credential out of the thread and out of the stored event', async () => {
    // A path is provider text like any other, and nothing upstream redacts it: the duty is the
    // first and only place it can be done (BD-022, TD-012).
    const path = `src/${PLANTED}/totals.ts`;
    const started = startHarness({ ownPaths: [path], peerPaths: [path] });
    await insertPeer(started.harness, 'ACME-9');
    await started.harness.publish([ticketMatched()]);

    expect(started.posted).toHaveLength(1);
    expect(started.posted[0]?.markdown).not.toContain(PLANTED);
    expect(started.posted[0]?.markdown).toContain(PLACEHOLDER);
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

    expect(started.posted).toHaveLength(1);
    expect(started.posted[0]?.markdown).not.toContain(PLANTED);
    const stored = JSON.stringify(warnings(started.harness));
    expect(stored).not.toContain(PLANTED);
    expect(warnings(started.harness)).toEqual([
      expect.objectContaining({ other_ticket_key: `ACME-${PLACEHOLDER}` }),
    ]);
  });

  it('posts one thread however many times the gate is entered on the same revision', async () => {
    const started = startHarness({ ownPaths: ['src/totals.ts'], peerPaths: ['src/totals.ts'] });
    await insertPeer(started.harness, 'ACME-9');
    await started.harness.publish([ticketMatched()]);
    expect(started.posted).toHaveLength(1);

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
    // One thread, and the replay is the executor's: the key is read back out of the store it wrote.
    expect(started.posted).toHaveLength(1);
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
