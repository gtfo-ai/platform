/**
 * The ask-the-task thread on the task page (WP-31, product/10:57).
 *
 * Driven through `createApp` with a fake server, so what is asserted is the composition: the real
 * router, the real query client, the real endpoint parsers and the real intent-key minting. Three
 * things are worth a test here, and each is a criterion of the plan row:
 *
 *  - the answer and the question are rendered as **text**, including when they contain markup —
 *    criterion 2 and BD-022 (`no-html.test.ts` proves there is no sink; this proves the screen does
 *    not need one);
 *  - a citation is a **link this application built** from the row's ids, never a URL a model wrote;
 *  - `dropped_citations` is shown rather than swallowed, because a reader who can see that two
 *    claims lost their evidence knows how much of the answer to trust (product/11:30).
 */
import {
  runTerminalReasonSchema,
  type TaskAsk,
  type TaskDetailResponse,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { TERMINAL_REASON_MEANING } from '../ui/humanize.js';
import { ASK_ENDED_BECAUSE, ASK_HELD_BACK, ASK_WRONG_SHAPE, askEnding } from './ask-thread.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const ARTIFACT = '00000000-0000-4000-8000-0000000000a7';
const RUN = '00000000-0000-4000-8000-0000000000c1';

/**
 * **Annotated rather than bare** (PROGRESS backlog 93, closed by WP-38).
 *
 * These literals are handed to the **real** endpoint parsers by this file's fake `fetch`, so they
 * were always validated; what was missing was the *diagnostic*. A required field added to
 * `taskRecordSchema` used to surface here as seven rendering failures naming a heading — the
 * annotation turns that into a compile error at the fixture, and excess-property checking catches
 * the other direction too.
 */
const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const TASK_DETAIL: TaskDetailResponse = {
  task: {
    id: TASK,
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-1', url: 'https://jira.example.test/browse/ACME-1' },
    ticket_title: null,
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
    // WP-39: this task has been measured by nothing, which is the state a task page starts in.
    coverage: null,
    // WP-38: and no implementation stage has completed, so the dependency gate has not run and
    // nothing has been routed — the two `null`s a task page starts with.
    dependencies: null,
    required_reviewers: null,
    review_threads: null,
    conflict: null,
    cost_actual_usd: 1.25,
    unmeasured_runs: 0,
    budget_cap_usd: 50,
    paused_reason: null,
    paused_budget_scope: null,
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
    ticket_claim: null,
    qa_stage: false,
    tracker_assignee: null,
    owner: null,
    owner_source: null,
    unlinked_assignee: null,
    owner_writes_back: false,
    waiting: null,
  },
  taken_over: null,
  can_raise_budget: false,
  can_export: false,
  can_pause: true,
  can_resume: true,
  can_cancel: true,
  can_return: true,
  can_rework: true,
  can_decide_approval: true,
  can_change_limits: false,
  can_take: false,
  can_assign: false,
  can_unassign: false,
  take_writes_back: false,
  gate_feedback: null,
  returns: [],
  stop: null,
  gate_wait: null,
  last_gate_wait: null,
  escalation: null,
  loop_limits: null,
  // WP-29: required and always present, so a server that forgot to project it fails here rather
  // than rendering a task page with no human-time line.
  human_time: {
    total_minutes: 0,
    by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
    by_user: null,
    entries: 0,
    withheld: { entries: 0, minutes: 0 },
  },
  stages: [],
  // WP-52: the task's own artifacts are what an `artifact` citation's `(type, version)` resolves
  // against — the citation carries no id, by design (`askAnswerCitationSchema`).
  artifacts: [
    {
      id: ARTIFACT,
      artifact_type: 'ImplementationPlan',
      version: 2,
      url: `/api/artifacts/${ARTIFACT}`,
    },
  ],
  questions: [],
  approvals: [],
  runs: [],
};

const ANSWERED: TaskAsk = {
  id: '00000000-0000-4000-8000-0000000000d1',
  task_id: TASK,
  source: 'ui',
  asked_by_user_id: SESSION.user.id,
  question: 'why did you choose a column instead of <b>a table</b>?',
  run_id: RUN,
  run_terminal_reason: 'success',
  status: 'answered',
  answer: 'The plan says a join on every read of the task page would be worse. <script>x</script>',
  citations: [
    { kind: 'run', run_id: RUN, detail: 'the architecture run' },
    { kind: 'artifact', artifact_type: 'ImplementationPlan', version: 2, detail: 'the rationale' },
  ],
  dropped_citations: 2,
  answer_artifact_id: null,
  refusal_reason: null,
  mirrored_at: null,
  created_at: '2026-09-13T05:00:00.000Z',
  answered_at: '2026-09-13T05:01:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (
  thread: readonly unknown[],
  options: { readonly onAsk?: (body: unknown, key: string | null) => void } = {},
) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST' && url.endsWith(`/api/tasks/${TASK}/ask`)) {
      const key = new Headers(init.headers).get('idempotency-key');
      options.onAsk?.(JSON.parse(String(init.body)), key);
      return json({ ask_id: ANSWERED.id, task_id: TASK, performed: true, status: 'pending' });
    }
    if (url.endsWith(`/api/tasks/${TASK}/asks`)) return json({ items: thread });
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

describe('the ask-the-task thread', () => {
  it('renders the question and the answer as text, markup and all (BD-022)', async () => {
    const { container } = render(
      createApp({ fetchImpl: fetchFor([ANSWERED]), realtime: false }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain(
        'a join on every read of the task page would be worse',
      );
    });
    // The markup arrived as **text**: the characters are on the screen and no element was created.
    expect(container.textContent).toContain('<script>x</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<b>a table</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('links a run citation and an artifact citation, and names the ones it cannot link', async () => {
    const { container } = render(
      createApp({ fetchImpl: fetchFor([ANSWERED]), realtime: false }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain('the architecture run');
    });
    // Built from the id by this application, never taken from the answer: `AskAnswer.citations` has
    // no URL field at all, which is the property this assertion rests on.
    const link = [...container.querySelectorAll('a')].find((anchor) =>
      anchor.getAttribute('href')?.includes(`/runs/${RUN}`),
    );
    expect(link).toBeTruthy();
    /**
     * **The artifact citation is a link since WP-52** — it used to be plain text, and this
     * assertion said so (PROGRESS backlog 85: *"there is no screen that addresses [one] by id"*).
     * The id is resolved here from the task's own artifact list, because a citation names a
     * `(type, version)` pair and never an id; the link targets `?artifact=<id>` on this task, which
     * is the panel `task-detail.tsx` renders.
     */
    expect(container.textContent).toContain('ImplementationPlan v2');
    const artifactLink = [...container.querySelectorAll('a')].find((anchor) =>
      anchor.getAttribute('href')?.includes(`artifact=${ARTIFACT}`),
    );
    expect(artifactLink).toBeTruthy();
    // …and `audit`/`knowledge` still do not link, which is declined rather than forgotten
    // (backlog 86; the reasoning is in `ask-thread.tsx`'s `Citation` docblock).
    expect(
      [...container.querySelectorAll('a')].some((anchor) =>
        anchor.getAttribute('href')?.includes('knowledge'),
      ),
    ).toBe(false);
  });

  it('shows how many citations were dropped for naming another task or project', async () => {
    const { container } = render(
      createApp({ fetchImpl: fetchFor([ANSWERED]), realtime: false }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain('2 citation(s)');
    });
    expect(container.textContent).toContain('outside this task');
  });

  it('says nothing about drops when there were none — both directions', async () => {
    const { container } = render(
      createApp({
        fetchImpl: fetchFor([{ ...ANSWERED, dropped_citations: 0 }]),
        realtime: false,
      }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain('the architecture run');
    });
    expect(container.textContent).not.toContain('citation(s) named');
  });

  it('names a refusal rather than showing an empty answer', async () => {
    const refused = {
      ...ANSWERED,
      status: 'refused',
      answer: null,
      answered_at: null,
      citations: [],
      dropped_citations: 0,
      refusal_reason: 'the task has spent its 5 USD cap and one question may spend 0.5 more',
    };
    const { container } = render(
      createApp({ fetchImpl: fetchFor([refused]), realtime: false }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain('has spent its 5 USD cap');
    });
    expect(container.textContent).toContain('not run');
  });

  /**
   * **S-25.17** (AUT-6655): the ask whose model put its citations inside `answer` failed the
   * contract, and the thread said only *the run ended "failed"*. It now says why in words, links its
   * run and offers to ask again with the question filled in — and shows no answer it did not get.
   */
  it('says why a failed ask got no answer, links its run, and asks again with the question filled in', async () => {
    const failed: TaskAsk = {
      ...ANSWERED,
      question: 'what am I supposed to decide?',
      status: 'failed',
      run_terminal_reason: 'error_max_structured_output_retries',
      answer: null,
      answered_at: null,
      citations: [],
      dropped_citations: 0,
      refusal_reason: 'the run ended "failed"',
    };
    const sent: unknown[] = [];
    const { container } = render(
      createApp({
        fetchImpl: fetchFor([failed], { onAsk: (body) => sent.push(body) }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain(ASK_WRONG_SHAPE);
    });
    expect(container.textContent).toContain('The answer didn’t come back in the expected shape.');
    const runLink = screen.getByRole('link', { name: 'Open this ask’s run' });
    expect(runLink.getAttribute('href')).toContain(`/runs/${RUN}`);
    const field = screen.getByLabelText('Your question') as HTMLTextAreaElement;
    expect(field.value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(field.value).toBe('what am I supposed to decide?');
    expect(document.activeElement).toBe(field);
    // A prefill only: nothing is asked (and paid for) until the person presses Ask.
    expect(sent).toEqual([]);
  });

  it('says an answer held back for quoting a credential was held back, not mis-shaped', async () => {
    const held: TaskAsk = {
      ...ANSWERED,
      status: 'failed',
      run_terminal_reason: 'success',
      answer: null,
      answered_at: null,
      citations: [],
      dropped_citations: 0,
      refusal_reason:
        'the answer put a secret this run was given in "citations[0].run_id", which the platform reads as an identifier and therefore refuses to rewrite',
    };
    const { container } = render(
      createApp({ fetchImpl: fetchFor([held]), realtime: false }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain(ASK_HELD_BACK);
    });
    expect(container.textContent).not.toContain(ASK_WRONG_SHAPE);
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open this ask’s run' })).toBeTruthy();
  });

  it('says a cancelled ask was cancelled, and offers it again', async () => {
    const cancelled: TaskAsk = {
      ...ANSWERED,
      status: 'refused',
      run_terminal_reason: 'cancelled',
      answer: null,
      answered_at: null,
      citations: [],
      dropped_citations: 0,
      refusal_reason: 'the run was cancelled',
    };
    const { container } = render(
      createApp({ fetchImpl: fetchFor([cancelled]), realtime: false }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain(TERMINAL_REASON_MEANING.cancelled);
    });
    expect(screen.getByRole('button', { name: 'Ask again' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open this ask’s run' })).toBeTruthy();
  });

  it('offers no Ask again on an answered ask, nor on a refusal no run was started for', async () => {
    const capped: TaskAsk = {
      ...ANSWERED,
      id: '00000000-0000-4000-8000-0000000000d2',
      status: 'refused',
      run_id: null,
      run_terminal_reason: null,
      answer: null,
      answered_at: null,
      citations: [],
      dropped_citations: 0,
      refusal_reason: 'the task has spent its 5 USD cap',
    };
    const { container } = render(
      createApp({ fetchImpl: fetchFor([ANSWERED, capped]), realtime: false }).element,
    );
    await screen.findByText('Ask the task');
    await waitFor(() => {
      expect(container.textContent).toContain('has spent its 5 USD cap');
    });
    expect(container.textContent).toContain('a join on every read');
    expect(screen.queryByRole('button', { name: 'Ask again' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open this ask’s run' })).toBeNull();
  });

  it('words every way a run can end, and the schema failure in the row’s own words', () => {
    for (const reason of runTerminalReasonSchema.options) {
      expect(ASK_ENDED_BECAUSE[reason], reason).toMatch(/\.$/);
    }
    const failed = (run_terminal_reason: TaskAsk['run_terminal_reason']) =>
      askEnding({ ...ANSWERED, status: 'failed', answer: null, run_terminal_reason });
    expect(failed('error_max_structured_output_retries')?.words).toBe(ASK_WRONG_SHAPE);
    // A run that finished but whose result the contract refused is the same failure.
    expect(failed('success')?.words).toBe(ASK_WRONG_SHAPE);
    expect(failed('lease_expired')?.words).toBe(TERMINAL_REASON_MEANING.lease_expired);
    expect(failed(null)?.words).toContain('ended before it wrote an answer');
    expect(askEnding(ANSWERED)).toBeNull();
    // A refusal whose run ended well, or had no recorded ending, is not worded as a run failure.
    expect(askEnding({ ...ANSWERED, status: 'refused', answer: null })).toBeNull();
    expect(
      askEnding({ ...ANSWERED, status: 'refused', answer: null, run_terminal_reason: null }),
    ).toBeNull();
    expect(
      askEnding({ ...ANSWERED, status: 'refused', answer: null, run_terminal_reason: 'cancelled' })
        ?.words,
    ).toBe(TERMINAL_REASON_MEANING.cancelled);
    expect(askEnding({ ...ANSWERED, status: 'pending', answer: null })).toBeNull();
  });

  it('sends one question with an Idempotency-Key the server can recognise', async () => {
    const sent: { body: unknown; key: string | null }[] = [];
    render(
      createApp({
        fetchImpl: fetchFor([], { onAsk: (body, key) => sent.push({ body, key }) }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Ask the task');
    await userEvent.type(screen.getByLabelText('Your question'), 'why a column?');
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.body).toEqual({ question: 'why a column?' });
    // The header is the point: a repeat would start a second run the project pays for.
    expect(typeof sent[0]?.key).toBe('string');
    expect(sent[0]?.key).not.toBe('');
  });

  it('refuses to send an empty question at all', async () => {
    const sent: unknown[] = [];
    render(
      createApp({
        fetchImpl: fetchFor([], { onAsk: (body) => sent.push(body) }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Ask the task');
    const button = screen.getByRole('button', { name: 'Ask' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await userEvent.click(button);
    expect(sent).toEqual([]);
  });
});
