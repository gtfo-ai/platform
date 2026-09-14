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
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';

const SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const TASK_DETAIL = {
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
  stages: [],
  artifacts: [],
  questions: [],
  approvals: [],
  runs: [],
};

const ANSWERED = {
  id: '00000000-0000-4000-8000-0000000000d1',
  task_id: TASK,
  source: 'ui',
  asked_by_user_id: SESSION.user.id,
  question: 'why did you choose a column instead of <b>a table</b>?',
  run_id: RUN,
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

  it('links a run citation through the router, and names the ones it cannot link', async () => {
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
    // The artifact citation is named and **not** linked: no screen addresses an artifact version.
    expect(container.textContent).toContain('ImplementationPlan v2');
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
