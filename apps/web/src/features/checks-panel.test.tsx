/**
 * **The Checks panel against product/10:38** — the eleven-item census (WP-38, criterion 5).
 *
 * product/10:38 is one sentence and it is the specification of this panel:
 *
 * > *"Right: **Checks** panel — merge-readiness at a glance: acceptance criteria met, CI green,
 * > rebase status, review threads open/resolved, business verdict, tamper check, coverage delta,
 * > dependency status, risk classes and required reviewers, budget vs estimate, questions pending"*
 *
 * All eleven are rendered since WP-81, which gave the last one — the tamper check, BD-024's gate —
 * its producer; until then ten were, and the one that was not was named on the screen in a *"Not on
 * this panel"* sentence. The list of which is which lives **here** rather than in a comment on the
 * screen — the shape `apps/server/src/routes/client-census.test.ts` uses, and for the same reason:
 * a prose caveat is a claim nobody re-checks, and this one had already gone stale once (it named
 * WP-15 and WP-38 as *"the pipeline that produces them"* after both had shipped).
 *
 * **Both directions** (standing rule 42): a shown item must appear on the panel, and the panel's list
 * of absent items is **compared** with the census's rather than searched for each entry (standing
 * rule 3: a list is compared, not pinned). With nothing absent that list is empty, so the panel must
 * carry **no** *"Not on this panel"* sentence at all — an item that starts being apologised for
 * again fails, and so does one that stops rendering without being listed absent. A one-sided test
 * would pass a panel that both rendered an item and apologised for it, and — much worse — one that
 * quietly stopped rendering an item while nothing said so.
 *
 * The fixture is **typed** rather than an untyped literal (PROGRESS backlog 93): a required field
 * added to `taskRecordSchema` fails at this line rather than three layers away as a missing heading.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const TASK_ROW: TaskRecord = {
  id: TASK,
  project_id: PROJECT,
  ticket: { provider: 'jira', key: 'ACME-1', url: 'https://jira.example.test/browse/ACME-1' },
  ticket_title: null,
  template: 'feature',
  mode: 'normal',
  state: 'active',
  current_stage: 'ci_gate',
  size: null,
  branch: null,
  mr_ref: null,
  workpad_ref: null,
  iteration_counters: {},
  risk_classes: ['auth'],
  coverage: null,
  review_threads: null,
  dependencies: {
    head_sha: 'b'.repeat(40),
    decision: 'ask',
    added: [
      {
        ecosystem: 'npm',
        name: 'lodash',
        from: 'manifest',
        path: 'package.json',
        policy: 'ask',
        allowlisted: false,
        metadata: {
          status: 'checked',
          license: 'MIT',
          last_published_at: '2026-04-02T11:00:00.000Z',
          deprecated: false,
          source_url: 'https://www.npmjs.com/package/lodash',
        },
      },
    ],
    unread: [{ ecosystem: 'maven', path: 'services/pom.xml' }],
    truncated: false,
    // The question the gate opened: the panel says "waiting" only when one exists.
    question_id: '00000000-0000-4000-8000-0000000000c9',
    checked_at: '2026-09-13T04:30:00.000Z',
  },
  conflict: null,
  required_reviewers: {
    source: 'codeowners',
    handles: ['@ana', '@billing-team'],
    assigned: ['4242'],
    unresolved: ['@billing-team'],
    truncated: false,
    routed_at: '2026-09-13T04:30:00.000Z',
  },
  cost_actual_usd: 1.25,
  cost_estimated_usd: 0,
  estimate_usd: 2.5,
  estimate_basis: 'project_history',
  estimate_samples: 6,
  estimate_accuracy: 0.5,
  requested_by_user_id: null,
  requested_by_identity: null,
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T04:00:00.000Z',
  completed_at: null,
};

const TASK_DETAIL: TaskDetailResponse = {
  task: TASK_ROW,
  taken_over: null,
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
};

/**
 * product/10:38's eleven, in the document's own order.
 *
 * `shown` names the label the panel renders it under; `absent` is the wording the screen uses for
 * it in the sentence that lists what this build does not answer. Changing either half is a decision
 * somebody makes here rather than a line somebody edits on the screen.
 */
const CHECKS: readonly {
  readonly item: string;
  readonly shown?: string;
  readonly absent?: string;
}[] = [
  // WP-46: the latest Acceptance Verdict's own `criteria[]`, read through WP-52's artifact route.
  { item: 'acceptance criteria met', shown: 'Acceptance criteria' },
  // WP-46 on WP-55's rows: the CI gate's latest `task_stages` row, closed with its verdict.
  { item: 'CI green', shown: 'CI status' },
  // The same, for the rebase gate.
  { item: 'rebase status', shown: 'Rebase status' },
  // WP-46: `tasks.review_threads`, written by BD-007's review window where it counts them.
  { item: 'review threads open/resolved', shown: 'Review threads' },
  // WP-46: the same Acceptance Verdict's `verdict`.
  { item: 'business verdict', shown: 'Business verdict' },
  // WP-81: BD-024's gate, made by the CI gate as part of its read — the word its row is closed with.
  { item: 'tamper check', shown: 'Tamper check' },
  { item: 'coverage delta', shown: 'Coverage delta' },
  { item: 'dependency status', shown: 'Dependencies' },
  { item: 'risk classes', shown: 'Risk classes' },
  { item: 'required reviewers', shown: 'Required reviewers' },
  { item: 'budget vs estimate', shown: 'Estimate' },
  { item: 'questions pending', shown: 'Questions pending' },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: [] });
  if (url.endsWith(`/api/tasks/${TASK}/audit`)) return json({ items: [] });
  if (url.endsWith(`/api/tasks/${TASK}`)) return json(TASK_DETAIL);
  if (url.endsWith('/api/projects')) return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/tasks/${TASK}`);
});

const renderPanel = async (): Promise<HTMLElement> => {
  const { container } = render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByText('Checks');
  await waitFor(() => {
    expect(container.textContent).toContain('Tamper check');
  });
  return container;
};

describe('the Checks panel against product/10:38', () => {
  it('renders every item it claims to, and names every one it does not — both ways', async () => {
    const container = await renderPanel();
    const text = container.textContent ?? '';
    // Empty when the panel names nothing absent — which is the case since WP-81.
    const absentAt = text.indexOf('Not on this panel');
    const absentSentence = absentAt < 0 ? '' : text.slice(absentAt);

    // The census is complete: product/10:38 lists eleven checks and every one of them is decided
    // here. `risk classes and required reviewers` is one phrase in the document and two items on
    // the panel, which is why this list has twelve rows for eleven checks.
    expect(CHECKS).toHaveLength(12);
    for (const check of CHECKS) {
      if (check.shown !== undefined) {
        expect(text, `${check.item} is rendered`).toContain(check.shown);
        expect(absentSentence, `${check.item} is not apologised for`).not.toContain(check.shown);
      }
    }
    // The sentence's own list — everything between "Not on this panel:" and the first full stop —
    // **compared** with the census's absent entries, so the list cannot hold an item the panel now
    // answers, nor lose one it does not.
    const listed = (absentSentence.match(/^Not on this panel:([^.]*)\./)?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const absent = CHECKS.flatMap((check) => (check.absent === undefined ? [] : [check.absent]));
    expect(listed.sort()).toEqual([...absent].sort());
    // WP-81: nothing is absent, so the panel carries no apology at all — the sentence returns only
    // with an entry in the census, which is then compared above.
    expect(absent).toEqual([]);
    expect(text).not.toContain('Not on this panel');
    // Eleven items answered (twelve rows: one phrase of the document is two items on the panel).
    expect(CHECKS.filter((check) => check.shown !== undefined)).toHaveLength(12);
  });

  it('shows what the dependency gate found, as text and with its licence', async () => {
    const container = await renderPanel();
    const text = container.textContent ?? '';

    expect(text).toContain('1 added · waiting');
    expect(text).toContain('npm:lodash');
    expect(text).toContain('MIT');
    expect(text).toContain('last release 2026-04-02');
    // The manifest this build cannot read is named on the screen rather than answered with silence.
    expect(text).toContain('services/pom.xml');
    expect(text).toContain('maven');
  });

  it('shows who the merge request needs, including the handle it could not resolve', async () => {
    const container = await renderPanel();
    const text = container.textContent ?? '';

    expect(text).toContain('1 of 2 assigned, 1 unresolved');
    expect(text).toContain('@ana');
    expect(text).toContain('CODEOWNERS on the default branch');
    expect(text).toContain('No account on this provider for @billing-team');
  });

  it('renders a handle out of CODEOWNERS as text, markup and all (BD-022)', async () => {
    const hostile = {
      ...TASK_DETAIL,
      task: {
        ...TASK_ROW,
        required_reviewers: {
          ...TASK_ROW.required_reviewers,
          source: 'codeowners' as const,
          handles: ['<img src=x onerror=alert(1)>'],
          assigned: [],
          unresolved: ['<img src=x onerror=alert(1)>'],
          truncated: false,
          routed_at: '2026-09-13T04:30:00.000Z',
        },
      },
    } satisfies TaskDetailResponse;
    const hostileFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith(`/api/tasks/${TASK}`)) return json(hostile);
      return fetchImpl(input);
    }) as typeof fetch;

    const { container } = render(createApp({ fetchImpl: hostileFetch, realtime: false }).element);
    await screen.findByText('Checks');
    await waitFor(() => {
      expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    });
    expect(container.querySelector('img')).toBeNull();
  });
});

/**
 * **The five items WP-46 brought onto the panel**, each from the record its producer wrote — the
 * gates' `task_stages` rows, `tasks.review_threads`, and the latest Acceptance Verdict's body
 * through `GET /api/artifacts/:id`. The fixtures are the DTO shapes those producers write; that the
 * producers write them is asserted in the tiers that run them (the saga harness for the rows and the
 * review window, the e2e for the verdict body), which is where rule 82 puts it.
 */
describe('the Checks panel’s gate, thread and verdict items (WP-46)', () => {
  const VERDICT_V1 = '00000000-0000-4000-8000-0000000000d1';
  const VERDICT_V2 = '00000000-0000-4000-8000-0000000000d2';
  const AT = '2026-09-13T05:00:00.000Z';

  const stage = (
    name: string,
    attempt: number,
    state: TaskDetailResponse['stages'][number]['state'],
    outcome: TaskDetailResponse['stages'][number]['outcome'],
  ): TaskDetailResponse['stages'][number] => ({
    stage: name,
    attempt,
    state,
    entered_at: AT,
    exited_at: state === 'running' ? null : AT,
    outcome,
  });

  const detailWith = (overrides: Partial<TaskDetailResponse>): TaskDetailResponse => ({
    ...TASK_DETAIL,
    task: { ...TASK_ROW, review_threads: { open: 2, resolved: 1, checked_at: AT } },
    stages: [
      stage('ci_gate', 1, 'returned', 'returned'),
      stage('ci_gate', 2, 'completed', 'pass'),
      stage('rebase_gate', 1, 'failed', 'undecided'),
    ],
    artifacts: [
      { id: VERDICT_V1, artifact_type: 'AcceptanceVerdict', version: 1, url: null },
      { id: VERDICT_V2, artifact_type: 'AcceptanceVerdict', version: 2, url: null },
    ],
    ...overrides,
  });

  const verdictBody = (id: string, version: number, data: unknown) => ({
    id,
    task_id: TASK,
    artifact_type: 'AcceptanceVerdict',
    version,
    schema_version: '1',
    produced_by_run_id: null,
    created_at: AT,
    redaction_count: 0,
    markdown: null,
    data,
  });

  const V2_DATA = {
    verdict: 'request_changes',
    criteria: [
      { id: 'AC-1', status: 'met', evidence: 'totals add up' },
      {
        id: 'AC-2',
        status: 'not_met',
        evidence: '<img src=x onerror=alert(2)> footer rounds twice',
      },
      { id: 'AC-3', status: 'untestable', evidence: 'needs a real printer' },
    ],
    scope_creep: [],
    missing: [],
    ux_notes: [],
  };

  const render$ = async (
    detail: TaskDetailResponse,
    artifact: (url: string) => Response | null = () => null,
  ): Promise<{ text: () => string; container: HTMLElement; requested: string[] }> => {
    const requested: string[] = [];
    const fetchWith = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/artifacts/')) {
        requested.push(url);
        return artifact(url) ?? json({ error: { code: 'not_found', message: 'no' } }, 404);
      }
      if (url.endsWith(`/api/tasks/${TASK}`)) return json(detail);
      return fetchImpl(input);
    }) as typeof fetch;
    const { container } = render(createApp({ fetchImpl: fetchWith, realtime: false }).element);
    await screen.findByText('Checks');
    return { text: () => container.textContent ?? '', container, requested };
  };

  it('reads each gate’s latest attempt, and names an escalation by its word', async () => {
    const view = await render$(detailWith({ artifacts: [] }));
    await waitFor(() => expect(view.text()).toContain('CI status'));
    // ci_gate: attempt 1 sent the task back, attempt 2 passed — the latest is what the head is.
    expect(view.text()).toContain('green');
    expect(view.text()).toContain('ci_gate, attempt 2, decided');
    // rebase_gate: parked, closed `failed` with the escalation's own word (backlog 160).
    expect(view.text()).toContain('escalated (undecided)');
  });

  it('says a gate the task never reached is not reached, never a tick', async () => {
    const view = await render$(detailWith({ stages: [], artifacts: [] }));
    await waitFor(() => expect(view.text()).toContain('CI status'));
    expect(view.text()).toContain('This task has not entered ci_gate.');
    expect(view.text()).toContain('This task has not entered rebase_gate.');
    expect(view.text()).not.toContain('green');
  });

  /**
   * **The tamper check** (WP-81): the CI gate's row, read for the word the check closed it with —
   * each answer one the row supports, and never a tick for a gate that has not decided.
   */
  it('reads the tamper check off the CI gate’s latest row, each word its own answer', async () => {
    const cases: readonly [TaskDetailResponse['stages'], string][] = [
      [
        [stage('ci_gate', 1, 'returned', 'protected_paths_changed')],
        'protected paths changed, sent back',
      ],
      [
        [stage('ci_gate', 1, 'completed', 'protected_paths_awaiting_review')],
        'declared changes await the code review',
      ],
      [
        [
          stage('ci_gate', 1, 'returned', 'protected_paths_changed'),
          stage('ci_gate', 2, 'completed', 'pass'),
        ],
        'clean',
      ],
      [[stage('ci_gate', 1, 'running', null)], 'checking'],
      [[], 'not reached'],
    ];
    for (const [stages, expected] of cases) {
      const view = await render$(detailWith({ stages, artifacts: [] }));
      await waitFor(() => expect(view.text()).toContain('Tamper check'));
      expect(view.text(), expected).toContain(`Tamper check${expected}`);
      cleanup();
    }
  });

  /**
   * **The rebase settlement's outcome** (WP-102, Q109 (b)): after a provisional CI pass the Code
   * review's confirmation is read by the rebase gate's settlement, so the item reads the rebase
   * row entered after the CI row — and never one from an earlier round.
   */
  it('reads a declared change’s confirmation off the rebase settlement after the provisional CI pass (WP-102)', async () => {
    const later = (row: TaskDetailResponse['stages'][number], at: string) => ({
      ...row,
      entered_at: at,
      exited_at: row.exited_at === null ? null : at,
    });
    const provisional = later(
      stage('ci_gate', 2, 'completed', 'protected_paths_awaiting_review'),
      '2026-09-12T10:00:00.000Z',
    );
    const cases: readonly [TaskDetailResponse['stages'], string, string][] = [
      [
        [
          provisional,
          later(
            stage('rebase_gate', 1, 'completed', 'protected_paths_confirmed'),
            '2026-09-12T10:30:00.000Z',
          ),
        ],
        'declared changes confirmed by the code review',
        'Rebase statusup to date',
      ],
      [
        [
          provisional,
          later(
            stage('rebase_gate', 1, 'returned', 'protected_paths_changed'),
            '2026-09-12T10:30:00.000Z',
          ),
        ],
        'declared changes not confirmed, sent back',
        'Rebase statussent back by the tamper check',
      ],
      [
        [provisional, later(stage('rebase_gate', 1, 'running', null), '2026-09-12T10:30:00.000Z')],
        'declared changes await the code review',
        'Rebase statuschecking',
      ],
      // A rebase row from the round **before** this CI pass says nothing about it.
      [
        [
          later(
            stage('rebase_gate', 1, 'completed', 'protected_paths_confirmed'),
            '2026-09-12T09:00:00.000Z',
          ),
          provisional,
        ],
        'declared changes await the code review',
        'Rebase statusup to date',
      ],
    ];
    for (const [stages, expected, rebase] of cases) {
      const view = await render$(detailWith({ stages, artifacts: [] }));
      await waitFor(() => expect(view.text()).toContain('Tamper check'));
      expect(view.text(), expected).toContain(`Tamper check${expected}`);
      expect(view.text(), rebase).toContain(rebase);
      cleanup();
    }
  });

  it('does not call a tamper return red CI, nor a provisional pass anything but green', async () => {
    const returned = await render$(
      detailWith({
        stages: [stage('ci_gate', 1, 'returned', 'protected_paths_changed')],
        artifacts: [],
      }),
    );
    await waitFor(() => expect(returned.text()).toContain('CI status'));
    expect(returned.text()).toContain('CI statussent back by the tamper check');
    expect(returned.text()).not.toContain('red, sent back');
    cleanup();
    const provisional = await render$(
      detailWith({
        stages: [stage('ci_gate', 1, 'completed', 'protected_paths_awaiting_review')],
        artifacts: [],
      }),
    );
    await waitFor(() => expect(provisional.text()).toContain('CI status'));
    expect(provisional.text()).toContain('CI statusgreen');
  });

  it('shows the review window’s counts, and "not read" when it has read nothing', async () => {
    const read = await render$(detailWith({ artifacts: [] }));
    await waitFor(() => expect(read.text()).toContain('2 open · 1 resolved'));
    cleanup();
    const unread = await render$(
      detailWith({ task: { ...TASK_ROW, review_threads: null }, artifacts: [] }),
    );
    await waitFor(() => expect(unread.text()).toContain('Review threads'));
    expect(unread.text()).toContain('not read');
    expect(unread.text()).not.toContain('0 open');
  });

  it('says the count is as of its reading and which resolutions re-read it (backlog 210, WP-90)', async () => {
    const view = await render$(detailWith({ artifacts: [] }));
    await waitFor(() => expect(view.text()).toContain('2 open · 1 resolved'));
    expect(view.text()).toContain('when the merge request reports every thread resolved');
    expect(view.text()).toContain('requires resolved threads before merging');
    expect(view.text()).toContain('A thread resolved without a comment while others stay open');
    // The WP-73a sentence said no resolution refreshed it — false since WP-90.
    expect(view.text()).not.toContain('is not counted until the next comment');
  });

  it('labels a review-only task’s count as the platform’s own findings (backlog 209)', async () => {
    const view = await render$(
      detailWith({
        task: {
          ...TASK_ROW,
          review_threads: { open: 1, resolved: 3, checked_at: AT, counts: 'platform_findings' },
        },
        artifacts: [],
      }),
    );
    await waitFor(() => expect(view.text()).toContain('1 findings open · 3 resolved'));
    expect(view.text()).toContain('The platform’s own review findings on this merge request');
    // Not the human-review wording: this is not what BD-007's window counts.
    expect(view.text()).not.toContain('a thread is open while it is resolvable');
  });

  it('reads the business verdict and the criteria from the latest Acceptance Verdict, as text', async () => {
    const view = await render$(detailWith({}), (url) =>
      url.endsWith(VERDICT_V2)
        ? json(verdictBody(VERDICT_V2, 2, V2_DATA))
        : json(verdictBody(VERDICT_V1, 1, { ...V2_DATA, verdict: 'approve' })),
    );
    await waitFor(() => expect(view.text()).toContain('changes requested'));
    // Only the newest version is read: v1's `approve` never reaches the screen.
    expect(view.requested.every((url) => url.endsWith(VERDICT_V2))).toBe(true);
    expect(view.text()).not.toContain('approved');
    expect(view.text()).toContain('1 of 3 met, 1 not met, 1 untestable');
    expect(view.text()).toContain('Acceptance Verdict v2.');
    expect(view.text()).toContain('AC-2 — <img src=x onerror=alert(2)> footer rounds twice');
    // Model output is text, markup and all (BD-022).
    expect(view.container.querySelector('img')).toBeNull();
  });

  it('names a verdict the route refuses, rather than drawing it as no verdict', async () => {
    const view = await render$(detailWith({}), () =>
      json(
        { error: { code: 'artifact_not_redacted', message: 'stored before migration 0038' } },
        409,
      ),
    );
    await waitFor(() => expect(view.text()).toContain('was not served'));
    expect(view.text()).toContain('unavailable');
    expect(view.text()).not.toContain('no verdict');
  });

  it('says no business review has judged the task when there is no verdict, and asks for none', async () => {
    const view = await render$(detailWith({ artifacts: [] }));
    await waitFor(() => expect(view.text()).toContain('no verdict'));
    expect(view.text()).toContain('not judged');
    expect(view.requested).toEqual([]);
  });
});

/**
 * **Which review checklists the Reviewer was given** (WP-73, PROGRESS backlog 217): the three
 * values of `ReviewVerdict.checklists_applied`, each its own sentence, and `null` never drawn as
 * *none* (standing rule 16).
 */
describe('the review checklists line (backlog 217)', () => {
  const REVIEW = '00000000-0000-4000-8000-0000000000e1';
  const reviewBody = (checklists: unknown) => ({
    id: REVIEW,
    task_id: TASK,
    artifact_type: 'ReviewVerdict',
    version: 1,
    schema_version: '1',
    produced_by_run_id: null,
    created_at: '2026-09-13T05:00:00.000Z',
    redaction_count: 0,
    markdown: null,
    data: {
      verdict: 'approve',
      findings: [],
      summary: 'Looks right.',
      protected_path_changes_confirmed: [],
      ...(checklists === undefined ? {} : { checklists_applied: checklists }),
    },
  });

  const renderWith = async (checklists: unknown): Promise<() => string> => {
    const detail: TaskDetailResponse = {
      ...TASK_DETAIL,
      artifacts: [{ id: REVIEW, artifact_type: 'ReviewVerdict', version: 1, url: null }],
    };
    const fetchWith = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith(`/api/artifacts/${REVIEW}`)) return json(reviewBody(checklists));
      if (url.endsWith(`/api/tasks/${TASK}`)) return json(detail);
      return fetchImpl(input);
    }) as typeof fetch;
    const { container } = render(createApp({ fetchImpl: fetchWith, realtime: false }).element);
    await screen.findByText('Checks');
    return () => container.textContent ?? '';
  };

  it('names each list the reviewer was given, with its count and the class that required it', async () => {
    const text = await renderWith([
      { name: 'payments', item_count: 2, required_by: ['payments'], truncated: false },
    ]);
    await waitFor(() =>
      expect(text()).toContain(
        'Reviewer given 2 items from checklist payments (required by: payments).',
      ),
    );
  });

  it('says "given none" for an empty list and "not recorded" for a missing one — never the other', async () => {
    const none = await renderWith([]);
    await waitFor(() => expect(none()).toContain('the reviewer was given none'));
    expect(none()).not.toContain('not recorded');
    cleanup();
    const unrecorded = await renderWith(undefined);
    await waitFor(() => expect(unrecorded()).toContain('Review checklists: not recorded'));
    expect(unrecorded()).not.toContain('given none');
  });
});
