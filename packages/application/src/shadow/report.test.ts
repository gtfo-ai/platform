/**
 * The ShadowReport — the pure assembly and the whole walk that produces one (WP-34).
 *
 * The **branches** are in `buildShadowReport`, which takes every input as an argument, so the four
 * combinations of "which diff was missing" are driven without a provider. The **composition** is
 * the second half: a shadow batch's task walked to its human stage writes exactly one
 * `shadow_reports` row, appends exactly one `shadow.report.created`, and the batch's completion is
 * the event's first consumer.
 *
 * Every assertion is on a row or an event (standing rule 79), and the idempotency case is the one
 * that matters most: the duty is at-least-once and the event is not.
 */
import type { DomainEvent, Id, IsoDateTime, MergeRequestRef } from '@platform/contracts';
import { materialiseAutonomy } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { staticPipelineIntegrations } from '../pipeline/integrations.js';
import { staticProjectSettings } from '../pipeline/settings.js';
import type {
  Discussion,
  FileDiff,
  MergedMergeRequest,
  MergeRequest,
} from '../ports/integrations/git-provider.js';
import type { Ticket } from '../ports/integrations/task-management.js';
import { createPipelineHarness, type PipelineHarness } from '../testing/pipeline-harness.js';
import { startShadowBatch } from './batch.js';
import type { ShadowBatchTicketRow } from './ports.js';
import { buildShadowReport, runShadowReport } from './report.js';

const PROJECT = '00000000-0000-4000-8000-0000000000f1' as Id;
const USER = '00000000-0000-4000-8000-0000000000f2' as Id;
const AT = '2026-09-14T10:00:00.000Z' as IsoDateTime;
const HOST = 'https://git.example.test/acme/api/-/merge_requests';
const BASE = 'b'.repeat(40);

const HUMAN_MR: MergeRequestRef = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 7,
  url: `${HOST}/7`,
  branch: 'feature/acme-1',
  head_sha: 'a'.repeat(40),
};

const AGENT_MR: MergeRequestRef = {
  provider: 'fake-git',
  project_path: 'acme/api',
  iid: 21,
  url: `${HOST}/21`,
  branch: 'agentic/acme-1',
  head_sha: 'c'.repeat(40),
};

const patch = (path: string, added: number, removed: number): FileDiff => ({
  new_path: path,
  old_path: path,
  diff: [
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,4 +1,5 @@',
    ...Array.from({ length: added }, (_, index) => `+line ${index}`),
    ...Array.from({ length: removed }, (_, index) => `-old ${index}`),
  ].join('\n'),
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  omitted: false,
});

const AGENT_FILES = [patch('src/totals.ts', 20, 2), patch('src/totals.test.ts', 10, 0)];
const HUMAN_FILES = [
  patch('src/totals.ts', 30, 4),
  patch('src/format.ts', 10, 0),
  patch('src/totals.test.ts', 20, 0),
  patch('src/format.test.ts', 10, 0),
];

describe('buildShadowReport', () => {
  const row = (overrides: Partial<ShadowBatchTicketRow> = {}): ShadowBatchTicketRow => ({
    ticketKey: 'ACME-1',
    taskId: null,
    baseSha: BASE,
    humanMr: HUMAN_MR,
    humanMrSource: 'title_scan',
    mergedAt: null,
    candidates: 1,
    refusedReason: null,
    ...overrides,
  });

  const both = () =>
    buildShadowReport({
      ticketKey: 'ACME-1',
      humanMr: HUMAN_MR,
      ticketRow: row(),
      agentFiles: AGENT_FILES,
      humanFiles: HUMAN_FILES,
      discussions: [],
      predictedCostUsd: 12,
      shadowCostUsd: 9.5,
    });

  it('carries every field product/19 §13 asks for when both diffs were read', () => {
    const report = both();
    expect(report.agent_diff_stats).toEqual({
      files_changed: 2,
      insertions: 30,
      deletions: 2,
    });
    expect(report.overlap?.files_jaccard).toBeCloseTo(2 / 4, 10);
    expect(report.overlap?.tests_added_ratio).toBeCloseTo(0.5, 10);
    expect(report.predicted_cost).toBe(12);
    expect(report.shadow_cost).toBe(9.5);
    // Q82 (b): the report says which lookup produced the comparison.
    expect(report.notes).toContain('matching the ticket key');
    expect(report.notes).toContain(BASE);
  });

  it('says "not looked at" rather than "nothing found" for the human merge request’s review', () => {
    // `null`, never `[]`: nothing on this build reviews somebody else's diff during a shadow task,
    // and an empty array would claim a reviewer looked (standing rule 16).
    expect(both().agent_review_of_human_mr).toBeNull();
    expect(both().notes).toContain('no reviewer looked at the human merge request');
  });

  it('carries no overlap block at all when the ticket has no human merge request', () => {
    // Q82 (b) is explicit: never an overlap of zero, *"which reads as 'the agent built something
    // completely different'"*.
    const report = buildShadowReport({
      ticketKey: 'ACME-1',
      humanMr: null,
      ticketRow: null,
      agentFiles: AGENT_FILES,
      humanFiles: null,
      discussions: [],
      predictedCostUsd: null,
      shadowCostUsd: 3,
    });
    expect(report.overlap).toBeNull();
    expect(report.agent_diff_stats).not.toBeNull();
    expect(report.predicted_cost).toBeNull();
    expect(report.notes).toContain('no human merge request was found');
  });

  it('carries no diff stats when the shadow run produced no merge request of its own', () => {
    const report = buildShadowReport({
      ticketKey: 'ACME-1',
      humanMr: HUMAN_MR,
      ticketRow: null,
      agentFiles: null,
      humanFiles: HUMAN_FILES,
      discussions: [],
      predictedCostUsd: 1,
      shadowCostUsd: 1,
    });
    expect(report.agent_diff_stats).toBeNull();
    expect(report.overlap).toBeNull();
    expect(report.notes).toContain('recorded no merge request');
  });

  it('derives reviewer minutes from the human merge request’s own notes, and says when it cannot', () => {
    const discussion = (at: string): Discussion =>
      ({
        id: at,
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: at,
            author: { provider: 'fake-git', external_id: 'dana', email: null, verified: false },
            body: 'looks good',
            created_at: at,
            path: null,
            line: null,
            system: false,
          },
        ],
      }) as Discussion;
    const withNotes = buildShadowReport({
      ticketKey: 'ACME-1',
      humanMr: HUMAN_MR,
      ticketRow: null,
      agentFiles: AGENT_FILES,
      humanFiles: HUMAN_FILES,
      discussions: [discussion('2026-04-01T09:00:00.000Z'), discussion('2026-04-01T09:25:00.000Z')],
      predictedCostUsd: null,
      shadowCostUsd: 0,
    });
    expect(withNotes.reviewer_minutes_estimate).toBe(25);
    // …and the other direction (standing rule 42): no human note is `null` with the reason named.
    expect(both().reviewer_minutes_estimate).toBeNull();
    expect(both().notes).toContain('carries no human note');
  });

  it('runs the review window to the merge instant the batch recorded, not to the last comment', () => {
    /**
     * product/19 §16's *"to merge or last activity"*, whose first half never applied until round 2:
     * `until` was hard-coded `null` while the merge instant sat unstored on the match. Same
     * discussions, two rows — one with the merge instant, one without — so the figure moves for
     * exactly one reason.
     */
    const note = (at: string): Discussion =>
      ({
        id: at,
        resolvable: true,
        resolved: false,
        notes: [
          {
            id: at,
            author: { provider: 'fake-git', external_id: 'dana', email: null, verified: false },
            body: 'looks good',
            created_at: at,
            path: null,
            line: null,
            system: false,
          },
        ],
      }) as Discussion;
    const withMerge = (mergedAt: string | null) =>
      buildShadowReport({
        ticketKey: 'ACME-1',
        humanMr: HUMAN_MR,
        ticketRow: row({ mergedAt }),
        agentFiles: AGENT_FILES,
        humanFiles: HUMAN_FILES,
        discussions: [note('2026-04-01T09:00:00.000Z'), note('2026-04-01T09:20:00.000Z')],
        predictedCostUsd: null,
        shadowCostUsd: 0,
      });
    expect(withMerge(null).reviewer_minutes_estimate).toBe(20);
    expect(withMerge('2026-04-01T09:50:00.000Z').reviewer_minutes_estimate).toBe(50);
    // …and the gap rule still decides: a merge a week after the last comment is not a week of
    // review, which is what stops "to merge" from swallowing the window it was meant to close.
    expect(withMerge('2026-04-08T09:00:00.000Z').reviewer_minutes_estimate).toBe(20);
  });

  it('says how many merge requests matched when the most recent one is not the only one', () => {
    // The direction of the error, carried: `candidates` was computed and discarded while the
    // resolver's docblock claimed the report said so (standing rule 86).
    expect(
      buildShadowReport({
        ticketKey: 'ACME-1',
        humanMr: HUMAN_MR,
        ticketRow: row({ candidates: 3 }),
        agentFiles: AGENT_FILES,
        humanFiles: HUMAN_FILES,
        discussions: [],
        predictedCostUsd: null,
        shadowCostUsd: 0,
      }).notes,
    ).toContain('3 merged merge requests name this ticket');
    // …and a single match says nothing, so the sentence means something when it appears.
    expect(both().notes).not.toContain('merged merge requests name this ticket');
  });

  it('refuses a size ratio when the provider rendered no patch, and says so', () => {
    /**
     * Round 2's major finding, end to end through the assembly.
     *
     * A file the provider declined to render (`omitted`, a null body) contributes its path and no
     * lines, so the human side counts zero. `compareShadowDiffs` answers `size_ratio: null` and
     * these notes are what tell a reader which side was not rendered — the old answer was `0`,
     * which the Shadow screen printed as *"size ratio: 0.00"*.
     */
    const unrendered: FileDiff[] = [
      { ...patch('src/totals.ts', 0, 0), diff: null, omitted: true },
      { ...patch('src/format.ts', 0, 0), diff: null, omitted: true },
    ];
    const report = buildShadowReport({
      ticketKey: 'ACME-1',
      humanMr: HUMAN_MR,
      ticketRow: row(),
      agentFiles: AGENT_FILES,
      humanFiles: unrendered,
      discussions: [],
      predictedCostUsd: null,
      shadowCostUsd: 0,
    });
    expect(report.overlap?.size_ratio).toBeNull();
    expect(report.notes).toContain('no patch for 2 of the human merge request’s 2 changed file(s)');
    expect(report.notes).toContain('no size ratio to take');
    // The overlap block itself is still published: both diffs *were* read, and the file overlap is
    // a measurement the paths alone support.
    expect(report.overlap?.files_jaccard).toBeCloseTo(1 / 3, 10);
    // …and the other direction (standing rule 42): a rendered human diff is a number and says
    // nothing about unrendered patches.
    expect(both().overlap?.size_ratio).toBeCloseTo(32 / 74, 10);
    expect(both().notes).not.toContain('no size ratio to take');
  });
});

// ── The composition ──────────────────────────────────────────────────────────

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
  ref: HUMAN_MR,
  author: { provider: 'fake-git', external_id: 'dana', email: null, verified: false },
  merged_at: '2026-04-01T09:00:00.000Z',
  title: `Sum the totals (${key})`,
  diff_stats: null,
  discussion_count: 1,
});

const asMergeRequest = (ref: MergeRequestRef): MergeRequest =>
  ({
    ref,
    state: 'opened' as const,
    draft: false,
    title: 'Sum the totals',
    description: '',
    source_branch: ref.branch,
    target_branch: 'main',
    head_sha: ref.head_sha,
    base_sha: BASE,
    mergeable: true,
    has_conflicts: false,
    coverage_pct: null,
    labels: [],
    reviewers: [],
    web_url: ref.url,
    merged_at: null,
  }) as MergeRequest;

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
    url: AGENT_MR.url,
    iid: AGENT_MR.iid,
    head_sha: AGENT_MR.head_sha,
    branch: AGENT_MR.branch,
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

const walkedHarness = (options: { readonly merged?: readonly MergedMergeRequest[] } = {}) =>
  createPipelineHarness({
    projectId: PROJECT,
    settings: {
      config: { features: { shadow_mode: { enabled: true } } },
      autonomy: materialiseAutonomy({ level: 'observe', at: AT, appliedBy: null }),
    },
    runs: {
      refinement: completedRun(REFINED_SPEC),
      architecture: completedRun(PLAN),
      implementation: completedRun(NOTES),
      code_review: completedRun(REVIEW),
      business_review: completedRun(ACCEPTANCE),
    },
    git: {
      getMergeRequest: async (ref: { iid: number }) =>
        asMergeRequest(ref.iid === HUMAN_MR.iid ? HUMAN_MR : AGENT_MR),
      getMergeRequestDiff: async (ref: { iid: number }) =>
        ref.iid === HUMAN_MR.iid ? HUMAN_FILES : AGENT_FILES,
      listMergedMergeRequests: async () => options.merged ?? [mergedMr('ACME-1')],
      listDiscussions: async () => [],
    },
    taskManagement: { readTicket: async (ref: { key: string }) => ticket(ref.key) },
  });

const startBatch = async (harness: PipelineHarness, keys: readonly string[]) =>
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

const reportEvents = (harness: PipelineHarness): readonly DomainEvent[] =>
  harness.events().filter((event) => event.type === 'shadow.report.created');

describe('the shadow report, through the whole walk', () => {
  it('writes one row and announces it once when the task reaches its human stage', async () => {
    const harness = walkedHarness();
    await startBatch(harness, ['ACME-1']);
    await harness.drain();

    expect(harness.shadow.reportRows).toHaveLength(1);
    expect(reportEvents(harness)).toHaveLength(1);

    const stored = harness.shadow.reportRows[0];
    expect(stored?.humanMr?.iid).toBe(HUMAN_MR.iid);
    const comparison = stored?.comparison as { overlap: { files_jaccard: number } | null };
    // Both diffs were read through the real `pipeline.outbound` duty, so this is a measurement of
    // the composition rather than of `buildShadowReport`.
    expect(comparison.overlap?.files_jaccard).toBeCloseTo(2 / 4, 10);
  });

  it('publishes the same document on the task’s own artifact list', async () => {
    const harness = walkedHarness();
    await startBatch(harness, ['ACME-1']);
    await harness.drain();
    const taskId = harness.shadow.reportRows[0]?.taskId as Id;
    const artifact = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.latest(scope.tx, taskId, 'ShadowReport'),
    );
    expect(artifact).not.toBeNull();
    expect(artifact?.data).toEqual(harness.shadow.reportRows[0]?.comparison);
  });

  it('marks the batch complete once every one of its tasks has a report', async () => {
    const harness = walkedHarness();
    await startBatch(harness, ['ACME-1']);
    await harness.drain();
    // `shadow.report.created`'s first consumer, and a countable effect rather than a log line.
    expect(harness.shadow.batches[0]?.completedAt).not.toBeNull();
  });

  it('performs nothing twice when the **duty** fires again, not just the store', async () => {
    /**
     * The at-least-once case, driven through `runShadowReport` itself.
     *
     * The case below asserts the *store's* answer, and a mutation that made the duty ignore it —
     * `if (false) { return false; }` in place of `if (!inserted)` — survived that case entirely:
     * the store still refused the second row, and the duty went on to write a second artifact and
     * append a second `shadow.report.created`. So the wake-up is delivered twice here, which is the
     * only way the early return is exercised at all (standing rules 3 and 68).
     */
    const harness = walkedHarness();
    await startBatch(harness, ['ACME-1']);
    await harness.drain();
    const taskId = harness.shadow.reportRows[0]?.taskId as Id;

    await runShadowReport(
      {
        unitOfWork: harness.memory,
        store: harness.store,
        shadow: harness.shadow,
        settings: staticProjectSettings(() => harness.settings),
        integrations: staticPipelineIntegrations(harness.integrations),
        jobs: harness.jobs,
        calendar: harness.calendar,
        ids: harness.ids,
        clock: { now: () => harness.clock.now() },
      },
      {
        duty: 'shadow_report',
        project_id: PROJECT,
        task_id: taskId,
        cause_event_id: harness.ids.next(),
        stage: 'ready_for_merge',
      },
    );

    expect(harness.shadow.reportRows).toHaveLength(1);
    expect(reportEvents(harness)).toHaveLength(1);
    const artifacts = await harness.memory.transaction(async (scope) =>
      harness.store.artifacts.listFor(scope.tx, taskId),
    );
    expect(artifacts.filter((entry) => entry.type === 'ShadowReport')).toHaveLength(1);
  });

  it('performs nothing twice when the store already has the row', async () => {
    const harness = walkedHarness();
    await startBatch(harness, ['ACME-1']);
    await harness.drain();
    const taskId = harness.shadow.reportRows[0]?.taskId as Id;

    // The at-least-once case: the same wake-up delivered a second time. `shadow_reports` is keyed
    // by task, so the second pass writes nothing **and appends nothing** — which is the half a
    // row-count assertion alone would miss.
    const inserted = await harness.memory.transaction(async (scope) =>
      harness.shadow.insertReport(scope.tx, {
        taskId,
        humanMr: HUMAN_MR,
        comparison: { anything: true },
      }),
    );
    expect(inserted).toBe(false);
    expect(harness.shadow.reportRows).toHaveLength(1);
    expect(reportEvents(harness)).toHaveLength(1);
  });

  it('still reports a ticket with no human merge request, with no overlap block', async () => {
    const harness = walkedHarness({ merged: [] });
    await startBatch(harness, ['ACME-1']);
    await harness.drain();
    expect(harness.shadow.reportRows).toHaveLength(1);
    const comparison = harness.shadow.reportRows[0]?.comparison as {
      overlap: unknown;
      human_mr: unknown;
    };
    expect(comparison.overlap).toBeNull();
    expect(comparison.human_mr).toBeNull();
  });

  it('runs the whole walk as a shadow run — `runs.mode` is asserted, not assumed', async () => {
    const harness = walkedHarness();
    await startBatch(harness, ['ACME-1']);
    await harness.drain();
    // The planner maps `tasks.mode` onto `RunSpec.mode` and no tier had ever driven it.
    expect(harness.specs.length).toBeGreaterThan(0);
    expect(harness.specs.every((spec) => spec.mode === 'shadow')).toBe(true);
  });
});
