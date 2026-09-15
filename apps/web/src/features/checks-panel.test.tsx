/**
 * **The Checks panel against product/10:38** — the eleven-item census (WP-38, criterion 5).
 *
 * product/10:38 is one sentence and it is the specification of this panel:
 *
 * > *"Right: **Checks** panel — merge-readiness at a glance: acceptance criteria met, CI green,
 * > rebase status, review threads open/resolved, business verdict, tamper check, coverage delta,
 * > dependency status, risk classes and required reviewers, budget vs estimate, questions pending"*
 *
 * Five of the eleven are rendered and six are not, and the list of which is which lives **here**
 * rather than in a comment on the screen — the shape `apps/server/src/routes/client-census.test.ts`
 * uses, and for the same reason: a prose caveat is a claim nobody re-checks, and this one had
 * already gone stale once (it named WP-15 and WP-38 as *"the pipeline that produces them"* after
 * both had shipped).
 *
 * **Both directions** (standing rule 42): a shown item must appear on the panel *and not* in the
 * "not on this panel" sentence, and an absent item must appear in that sentence *and not* as a
 * label. A one-sided test would pass a panel that both rendered an item and apologised for it, and
 * — much worse — one that quietly stopped rendering an item while the sentence still called it
 * present.
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
  // Absent: a Refined Spec carries the criteria and a Business Review Verdict judges them; nothing
  // projects "met / not met" onto the task. **No work package owns it.**
  { item: 'acceptance criteria met', absent: 'acceptance criteria met' },
  // Absent: the CI gate settles from `ci.pipeline.finished` (WP-15) and records the outcome on
  // `task_stages`; no field of this screen's DTO carries it. **No work package owns it.**
  { item: 'CI green', absent: 'CI green' },
  // Absent: the rebase gate records `task.rebase.checked` on every entry (WP-26); same gap.
  { item: 'rebase status', absent: 'rebase status' },
  // Absent: the review window counts unresolved threads to decide a return (BD-007); it stores no
  // count.
  { item: 'review threads open/resolved', absent: 'review threads' },
  // Absent as a *check*: the verdict is an artifact and is openable in the artifacts tab.
  { item: 'business verdict', absent: 'business verdict' },
  // Absent with no producer at all: BD-024's test-integrity check exists in the Reviewer's prompt
  // and nowhere in the platform's data.
  { item: 'tamper check', absent: 'tamper check' },
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
    expect(container.textContent).toContain('Not on this panel');
  });
  return container;
};

describe('the Checks panel against product/10:38', () => {
  it('renders every item it claims to, and names every one it does not — both ways', async () => {
    const container = await renderPanel();
    const text = container.textContent ?? '';
    const absentSentence = text.slice(text.indexOf('Not on this panel'));

    // The census is complete: product/10:38 lists eleven checks and every one of them is decided
    // here. `risk classes and required reviewers` is one phrase in the document and two items on
    // the panel, which is why this list has twelve rows for eleven checks.
    expect(CHECKS).toHaveLength(12);
    for (const check of CHECKS) {
      if (check.shown !== undefined) {
        expect(text, `${check.item} is rendered`).toContain(check.shown);
        expect(absentSentence, `${check.item} is not apologised for`).not.toContain(check.shown);
        continue;
      }
      expect(absentSentence, `${check.item} is named absent`).toContain(check.absent);
    }
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
