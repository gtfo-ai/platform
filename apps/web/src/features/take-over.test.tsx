/**
 * Take over, hand back and the two downloads on the task and run screens (WP-44, criteria 1, 2 and
 * 9; PROGRESS backlog 68, 70, 164, 168 and 172).
 *
 * Driven through `createApp` with a fake server, as `ask-thread.test.tsx` is: the real router, the
 * real query client, the real endpoint parsers and the real intent-key minting. What is asserted is
 * what a person can see and press, and what the request carried.
 */
import type {
  ContextPackRecord,
  RunRecord,
  TakenOver,
  TaskDetailResponse,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { admittedDocuments, textSearchText } from './run-detail.js';
import { interruptedRunOf, workspaceExportText } from './take-over.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';
const LATER_RUN = '00000000-0000-4000-8000-0000000000c2';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const run = (id: string, startedAt: string): RunRecord => ({
  id,
  task_id: TASK,
  project_id: PROJECT,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  session_id: null,
  model: 'claude-test',
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'test@1',
  status: 'cancelled',
  terminal_reason: 'cancelled',
  started_at: startedAt,
  ended_at: null,
  last_output_at: null,
  num_turns: 3,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  model_usage: [],
  cost: { usd: 0.5, is_estimate: false, price_list_id: null },
  wall_ms: 1_000,
  redaction_count: 0,
});

const TAKEN_OVER: TakenOver = {
  at: '2026-09-13T06:00:00.000Z',
  branch: 'agentic/acme-1',
  session_id: 'sess-1',
  stage: 'implementation',
  resume_commands: ['git fetch && git checkout agentic/acme-1', 'claude --resume sess-1'],
  held_by: SESSION.user.id,
  run_id: RUN,
  run_recorded: true,
  hand_back_stages: ['refinement', 'implementation', 'code_review'],
};

const detail = (over: Partial<TaskDetailResponse> = {}): TaskDetailResponse => ({
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-1', url: 'https://jira.example.test/browse/ACME-1' },
    template: 'feature',
    mode: 'normal',
    state: 'active',
    current_stage: 'implementation',
    size: null,
    branch: null,
    mr_ref: null,
    workpad_ref: null,
    iteration_counters: {},
    risk_classes: [],
    coverage: null,
    dependencies: null,
    required_reviewers: null,
    review_threads: null,
    conflict: null,
    cost_actual_usd: 1.25,
    cost_estimated_usd: 0,
    estimate_usd: null,
    estimate_basis: null,
    estimate_samples: null,
    estimate_accuracy: null,
    requested_by_user_id: null,
    requested_by_identity: null,
    created_at: '2026-09-13T04:00:00.000Z',
    updated_at: '2026-09-13T04:00:00.000Z',
    completed_at: null,
  },
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
  runs: [run(RUN, '2026-09-13T05:00:00.000Z'), run(LATER_RUN, '2026-09-13T07:00:00.000Z')],
  ...over,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
}

const fetchFor = (
  task: TaskDetailResponse,
  sent: Sent[],
  extra: (url: string) => Response | null = () => null,
) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST') {
      const path = new URL(url, 'http://localhost').pathname;
      sent.push({
        path,
        body: JSON.parse(String(init.body)),
        key: new Headers(init.headers).get('idempotency-key'),
      });
      if (path.endsWith('/take-over')) {
        return json({
          task_id: TASK,
          state: 'paused',
          current_stage: 'implementation',
          performed: true,
          branch: 'agentic/acme-1',
          session_id: null,
          resume_commands: ['git fetch && git checkout agentic/acme-1'],
          workspace_export: 'requested',
        });
      }
      if (path.endsWith('/hand-back')) {
        return json({
          task_id: TASK,
          state: 'active',
          current_stage: 'code_review',
          performed: true,
        });
      }
    }
    const answered = extra(url);
    if (answered !== null) return answered;
    if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}/audit`)) return json({ items: [] });
    if (url.endsWith(`/api/tasks/${TASK}`)) return json(task);
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

describe('the take-over control on the task screen', () => {
  it('takes the task over and renders the four fields the response carries', async () => {
    const sent: Sent[] = [];
    const user = userEvent.setup();
    const { container } = render(
      createApp({ fetchImpl: fetchFor(detail(), sent), realtime: false }).element,
    );
    await screen.findByRole('button', { name: 'Take over' });
    await user.type(screen.getByLabelText('Why you are taking it over'), 'the agent is looping');
    await user.click(screen.getByRole('checkbox', { name: /archive the workspace/ }));
    await user.click(screen.getByRole('button', { name: 'Take over' }));

    await waitFor(() => {
      expect(container.textContent).toContain('git fetch && git checkout agentic/acme-1');
    });
    const takeOver = sent.find((entry) => entry.path.endsWith('/take-over'));
    expect(takeOver?.body).toEqual({ tarball: true, reason: 'the agent is looping' });
    // The SPA's per-intent key (`app/idempotency.ts`), never a request without one.
    expect(takeOver?.key).toMatch(/.+/);
    // The four fields: the branch, the session (none, said as such), the lines, the export's tense.
    expect(container.textContent).toContain('agentic/acme-1');
    expect(container.textContent).toContain('the interrupted run had no session');
    expect(container.textContent).toContain(workspaceExportText('requested'));
  });

  it('offers no take-over on a finished task', async () => {
    const finished = detail();
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({ ...finished, task: { ...finished.task, state: 'done' } }, []),
        realtime: false,
      }).element,
    );
    await screen.findByText('Stage commands');
    expect(container.textContent).not.toContain('Take over');
  });
});

describe('a take-over in force', () => {
  it('shows it after an escalation, with the downloads and a hand-back over the compiled stages', async () => {
    const sent: Sent[] = [];
    const user = userEvent.setup();
    const held = detail({ taken_over: TAKEN_OVER });
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({ ...held, task: { ...held.task, state: 'needs_human' } }, sent),
        realtime: false,
      }).element,
    );
    await screen.findByText('Taken over by a human');
    // Backlog 164: the escalation does not end the take-over, and the page says both.
    expect(container.textContent).toContain('escalated — still held');
    expect(container.textContent).toContain('claude --resume sess-1');

    // The two downloads name the run the take-over recorded (WP-73, backlog 203), and are
    // same-origin paths composed by the client.
    const hrefs = [...container.querySelectorAll('a[download]')].map((anchor) =>
      anchor.getAttribute('href'),
    );
    expect(hrefs).toEqual([`/api/runs/${RUN}/transcript.jsonl`, `/api/runs/${RUN}/export.tar`]);

    // The picker is the compiled pipeline's enabled stages, exactly — nothing the route refuses.
    const picker = screen.getByLabelText('Resume at') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual(TAKEN_OVER.hand_back_stages);
    expect(picker.value).toBe('implementation');
    const submit = screen.getByRole('button', { name: 'Hand back' });
    expect(submit).toHaveProperty('disabled', true);
    await user.selectOptions(picker, 'code_review');
    await user.type(screen.getByLabelText('What you did'), 'fixed the rounding by hand');
    await user.click(submit);
    await waitFor(() => {
      expect(sent.some((entry) => entry.path.endsWith('/hand-back'))).toBe(true);
    });
    const handBack = sent.find((entry) => entry.path.endsWith('/hand-back'));
    expect(handBack?.body).toEqual({ stage: 'code_review', summary: 'fixed the rounding by hand' });
    // Required by the route: a hand-back creates a run, so a repeat must be recognisable.
    expect(handBack?.key).toMatch(/.+/);
  });

  it('says there is nothing to hand back to when the pipeline cannot be read', async () => {
    const { container } = render(
      createApp({
        fetchImpl: fetchFor(detail({ taken_over: { ...TAKEN_OVER, hand_back_stages: [] } }), []),
        realtime: false,
      }).element,
    );
    await screen.findByText('Taken over by a human');
    expect(container.textContent).toContain('No stage to hand back to');
    expect(screen.queryByRole('button', { name: 'Hand back' })).toBeNull();
  });
});

/**
 * WP-73, PROGRESS backlog 203: the panel reads the run `task.taken_over` recorded, and infers only
 * for an event written before the field existed — saying so.
 */
describe('which run the take-over panel offers', () => {
  const downloads = (container: HTMLElement) =>
    [...container.querySelectorAll('a[download]')].map((anchor) => anchor.getAttribute('href'));
  const renderHeld = async (takenOver: TakenOver) => {
    const view = render(
      createApp({
        fetchImpl: fetchFor(detail({ taken_over: takenOver }), []),
        realtime: false,
      }).element,
    );
    await screen.findByText('Taken over by a human');
    return view.container;
  };

  it('offers no downloads for a take-over that recorded no live run', async () => {
    // The inference would have named RUN, a run that had finished before the take-over.
    const container = await renderHeld({ ...TAKEN_OVER, run_id: null });
    expect(downloads(container)).toEqual([]);
    expect(container.textContent).toContain('No run was live when the task was taken over');
  });

  it('offers the recorded run, not the newest one started by the take-over’s instant', async () => {
    const container = await renderHeld({ ...TAKEN_OVER, run_id: LATER_RUN });
    expect(downloads(container)).toEqual([
      `/api/runs/${LATER_RUN}/transcript.jsonl`,
      `/api/runs/${LATER_RUN}/export.tar`,
    ]);
    expect(container.textContent).not.toContain('is inferred');
  });

  it('infers the run for a take-over recorded before WP-73, and says it is an inference', async () => {
    const container = await renderHeld({ ...TAKEN_OVER, run_id: null, run_recorded: false });
    expect(downloads(container)).toEqual([
      `/api/runs/${RUN}/transcript.jsonl`,
      `/api/runs/${RUN}/export.tar`,
    ]);
    expect(container.textContent).toContain('the run below is inferred');
  });
});

describe('the run a take-over interrupted', () => {
  it('is the newest run started by the take-over’s instant, and none before any started', () => {
    const runs = [
      { id: 'a', started_at: '2026-09-13T05:00:00.000Z' },
      { id: 'b', started_at: '2026-09-13T05:30:00.000Z' },
      { id: 'c', started_at: '2026-09-13T07:00:00.000Z' },
      { id: 'd', started_at: null },
    ];
    expect(interruptedRunOf(runs, '2026-09-13T06:00:00.000Z')).toBe('b');
    expect(interruptedRunOf(runs, '2026-09-13T04:00:00.000Z')).toBeNull();
  });
});

describe('the run screen’s context pack (backlog 168 and 172)', () => {
  const pack = (tier1Validated: readonly boolean[]): ContextPackRecord => ({
    tier0: [{ path: '.agentic/knowledge/index.md', tokens: 300 }],
    tier1: tier1Validated.map((validated, index) => ({
      path: `.agentic/knowledge/page-${index}.md`,
      reason: 'paths' as const,
      score: 0.5,
      tokens: 100,
      validated,
    })),
    budget_tokens: 12_000,
    total_tokens: 400,
    kb_commit: null,
    text_search: {
      outcome: 'all_uninformative',
      kept_terms: [],
      dropped_terms: ['demo'],
      floor: 'applied',
      matched_documents: 0,
      omitted_terms: 0,
    },
  });

  const renderRun = async (record: ContextPackRecord) => {
    window.history.pushState({}, '', `/runs/${RUN}`);
    const user = userEvent.setup();
    const view = render(
      createApp({
        fetchImpl: fetchFor(detail(), [], (url) => {
          if (url.endsWith(`/api/runs/${RUN}/context-pack`)) return json(record);
          if (url.includes(`/api/runs/${RUN}/messages`)) return json({ items: [], next_seq: null });
          if (url.endsWith(`/api/runs/${RUN}`)) return json(run(RUN, '2026-09-13T05:00:00.000Z'));
          return null;
        }),
        realtime: false,
      }).element,
    );
    await user.click(await screen.findByRole('tab', { name: 'Context pack' }));
    await screen.findByText('Documents');
    return view;
  };

  it('counts tier 0 and the admitted tier-1 pages, and marks the one not admitted', async () => {
    const { container } = await renderRun(pack([true, false]));
    expect(admittedDocuments(pack([true, false]))).toBe(2);
    // The value beside the label, not the definition beneath it.
    expect(screen.getByText('Documents').nextElementSibling?.textContent).toBe('2');
    expect(container.querySelectorAll('[data-not-admitted]')).toHaveLength(1);
    // Backlog 172: why tier 1 has no text match, naming the dropped word.
    expect(container.textContent).toContain(textSearchText(pack([true, false])) ?? 'unreachable');
    expect(container.textContent).toContain('demo');
    // And the run's own transcript download, a same-origin link.
    expect(
      [...container.querySelectorAll('a[download]')].map((anchor) => anchor.getAttribute('href')),
    ).toContain(`/api/runs/${RUN}/transcript.jsonl`);
  });

  it('marks nothing when every tier-1 page was admitted', async () => {
    const { container } = await renderRun(pack([true, true]));
    expect(container.querySelectorAll('[data-not-admitted]')).toHaveLength(0);
    expect(screen.getByText('Documents').nextElementSibling?.textContent).toBe('3');
  });
});

describe('the text step in words', () => {
  it('names each outcome differently, and says so when nothing was recorded', () => {
    const base: ContextPackRecord = {
      tier0: [],
      tier1: [],
      budget_tokens: 1,
      total_tokens: 0,
    };
    const lines = (
      [
        ['not_searched', null],
        ['no_terms', 'applied'],
        ['all_uninformative', 'applied'],
        ['no_match', 'applied'],
        ['no_match', 'no_statistics'],
        ['matched', 'applied'],
      ] as const
    ).map(([outcome, floor]) =>
      textSearchText({
        ...base,
        text_search: {
          outcome,
          kept_terms: ['session'],
          dropped_terms: ['demo'],
          floor,
          matched_documents: 1,
          omitted_terms: 0,
        },
      }),
    );
    expect(new Set(lines).size).toBe(6);
    expect(textSearchText(base)).toBeNull();
  });
});
