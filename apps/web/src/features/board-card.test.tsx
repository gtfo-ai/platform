/**
 * **The board card says the phase and whether it needs you** — research/19 § 5.2 "Board", TD-033
 * decisions 6–7 (S-23.9a).
 *
 * Driven through `createApp` against a fake server, so the real endpoint parsers read the page's
 * glance (`stages`, `open_questions`, `pending_approvals`, `loop_limits`) and the agents read, and
 * the real client sends each command. Every assertion has its other direction (standing rule 42): a
 * card an agent works on pulses and one it does not says its state's word; a task waiting on a
 * person carries the ◆ and one that is not carries nothing; a menu offers what its state allows and
 * not the rest.
 *
 * The list view (`?view=list`) is the same cards' data as Issues-style rows, filtered by state,
 * template and needs-you over the **same** page read — so it is asserted here, on the same fixture.
 *
 * The commands are the task page's (`useTaskCommands`): pause, resume and cancel send the page's
 * reasons with **no** `Idempotency-Key` — exactly as the task page sends them — and return-to-stage
 * sends the stage and the person's reason **with** one (`endpoints.returnToStage`'s `idempotent`).
 */
import type { TaskListItem } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { ROW_LINK_ATTRIBUTE, ROW_LINK_HOST } from '../ui/row-link.js';
import { filterTasks, NO_FILTERS } from './board.js';
import { asksLabel, loopBadges, menuCommandsFor, needsYou, stageEnteredAt } from './board-card.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const NOW = Date.parse('2026-06-01T12:00:00.000Z');

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: 'session-1', expiresAt: '2030-01-01T00:00:00.000Z' },
} as unknown as SessionResponse;

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const task = (n: number, overrides: Partial<TaskListItem>): TaskListItem =>
  ({
    id: id(n),
    project_id: PROJECT,
    ticket: {
      provider: 'jira',
      key: `ACME-${n}`,
      url: `https://tickets.example.invalid/ACME-${n}`,
    },
    ticket_title: `Ticket ${n}`,
    template: 'feature',
    mode: 'normal',
    state: 'active',
    current_stage: null,
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
    cost_actual_usd: 0.84,
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
    created_at: '2026-06-01T09:00:00.000Z',
    updated_at: '2026-06-01T11:00:00.000Z',
    completed_at: null,
    ticket_claim: null,
    qa_stage: false,
    stages: [],
    open_questions: 0,
    pending_approvals: 0,
    loop_limits: null,
    latest_return: null,
    stop: null,
    ...overrides,
  }) as TaskListItem;

/** An agent at work on it: code review, attempt 2, after a return. */
const BUSY = task(1, {
  state: 'active',
  current_stage: 'code_review',
  template: 'bug',
  stages: [
    { stage: 'refinement', attempt: 1, state: 'completed', entered_at: '2026-06-01T09:00:00.000Z' },
    {
      stage: 'implementation',
      attempt: 1,
      state: 'completed',
      entered_at: '2026-06-01T10:00:00.000Z',
    },
    { stage: 'code_review', attempt: 1, state: 'returned', entered_at: '2026-06-01T11:00:00.000Z' },
    { stage: 'code_review', attempt: 2, state: 'running', entered_at: '2026-06-01T11:50:00.000Z' },
  ],
  iteration_counters: { code_review: 2, ci_fix: 0 },
  loop_limits: { code_review: 3, ci_fix: 3 },
  latest_return: null,
  stop: null,
  mr_ref: {
    provider: 'gitlab',
    project_path: 'acme/api',
    iid: 7,
    url: 'https://git.example.invalid/acme/api/-/merge_requests/7',
  },
});

/** Waiting on a person: two questions and an approval. */
const WAITING = task(2, {
  state: 'waiting_answers',
  current_stage: 'refinement',
  stages: [
    { stage: 'refinement', attempt: 1, state: 'running', entered_at: '2026-06-01T11:30:00.000Z' },
  ],
  open_questions: 2,
  pending_approvals: 1,
});

/** Paused by a person; nothing open, no agent. Its ticket link is a `javascript:` URL. */
const PAUSED = task(3, {
  state: 'paused',
  paused_reason: 'manual',
  current_stage: 'implementation',
  ticket: { provider: 'jira', key: 'ACME-3', url: 'javascript:alert(1)' },
  stages: [
    {
      stage: 'implementation',
      attempt: 1,
      state: 'running',
      entered_at: '2026-06-01T10:00:00.000Z',
    },
  ],
});

/** Finished: the menu offers only the links. */
const DONE = task(4, { state: 'done', current_stage: null, template: 'chore' });

const AGENTS = {
  items: [
    {
      run: {
        id: id(91),
        task_id: BUSY.id,
        stage: 'code_review',
        role: 'reviewer',
        model: 'claude-opus-5',
        status: 'running',
        started_at: '2026-06-01T11:50:00.000Z',
      },
      project_id: PROJECT,
      task_id: BUSY.id,
      role: 'reviewer',
      last_output_at: '2026-06-01T11:59:30.000Z',
      seat: null,
      activity: { kind: 'tool', tool_name: 'Read', at: '2026-06-01T11:59:30.000Z' },
    },
  ],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
}

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme',
  name: 'ACME',
  repo_url: 'https://git.example.invalid/acme/api.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: '2026-06-01T09:00:00.000Z',
  updated_at: '2026-06-01T09:00:00.000Z',
  open_tasks: 4,
  spent_usd_30d: 0,
};

/** The run record the agents read publishes, completed from the minimal one above. */
const runRecord = (run: Record<string, unknown>) => ({
  project_id: PROJECT,
  mode: 'normal',
  attempt: 2,
  session_id: null,
  effort: 'high',
  provider_mode: 'api',
  prompt_version: 'test@1',
  terminal_reason: null,
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
  cost: null,
  wall_ms: 0,
  redaction_count: 0,
  settings_hash: null,
  start_failure: null,
  saved_work: null,
  latest_progress: null,
  ...run,
});

/** The caller may do everything the menu offers; `MEMBER` may cancel and return nothing. */
const ALL = { cancel: true, returnToStage: true } as const;
const MEMBER = { cancel: false, returnToStage: false } as const;

const open = (
  options: {
    readonly agents?: boolean;
    readonly path?: string;
    readonly items?: readonly TaskListItem[];
    readonly may?: { readonly cancel: boolean; readonly returnToStage: boolean };
  } = {},
) => {
  const may = options.may ?? ALL;
  const sent: Sent[] = [];
  let taskReads = 0;
  const asked: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    asked.push(path);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (init?.method === 'POST' && path.startsWith('/api/tasks/')) {
      sent.push({
        path,
        body: JSON.parse(String(init.body ?? '{}')),
        key: new Headers(init.headers).get('idempotency-key'),
      });
      return json({ task_id: BUSY.id, state: 'paused', current_stage: null, performed: true });
    }
    if (path === `/api/projects/${PROJECT}/tasks`) {
      taskReads += 1;
      return json({
        items: options.items ?? [BUSY, WAITING, PAUSED, DONE],
        next_cursor: null,
        can_start_task: true,
        can_cancel_task: may.cancel,
        can_return_to_stage: may.returnToStage,
        can_pause_task: true,
        can_resume_task: true,
      });
    }
    if (path === '/api/org/agents') {
      return options.agents === false
        ? json({ items: [] })
        : json({
            items: AGENTS.items.map((entry) => ({ ...entry, run: runRecord(entry.run) })),
          });
    }
    if (path === '/api/projects') return json({ items: [PROJECT_ROW] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', options.path ?? '/projects/acme');
  const view = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
  return { view, sent, taskReads: () => taskReads, asked };
};

const card = async (key: string): Promise<HTMLElement> =>
  screen.findByRole('article', { name: key });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a whole card and a whole row open the task (S-23.26)', () => {
  it('stretches the title link over the card and the row, and nothing else', async () => {
    open();
    const article = await card('ACME-1');
    // The card is the host and its one row link is the title, into the task.
    expect(article.classList.contains(ROW_LINK_HOST)).toBe(true);
    const stretched = article.querySelectorAll(`[${ROW_LINK_ATTRIBUTE}]`);
    expect(stretched).toHaveLength(1);
    expect(stretched[0]?.hasAttribute('data-ticket-title')).toBe(true);
    expect(stretched[0]?.getAttribute('href')).toBe(`/projects/acme/tasks/${BUSY.id}`);
    // The menu is not the stretched control: it keeps its own click above the link.
    expect(
      within(article)
        .getByRole('button', { name: /^Actions for/ })
        .hasAttribute(ROW_LINK_ATTRIBUTE),
    ).toBe(false);

    cleanup();
    open({ path: '/projects/acme?view=list' });
    const list = await screen.findByRole('list', { name: 'Tasks' });
    const row = list.querySelector<HTMLElement>(`[data-board-row="${BUSY.id}"]`);
    expect(row?.classList.contains(ROW_LINK_HOST)).toBe(true);
    expect(row?.querySelectorAll(`[${ROW_LINK_ATTRIBUTE}]`)).toHaveLength(1);
    expect(row?.querySelector(`[${ROW_LINK_ATTRIBUTE}]`)?.hasAttribute('data-ticket-title')).toBe(
      true,
    );
  });
});

describe('the board’s columns', () => {
  it('name each column with its count, and light the Needs you column', async () => {
    open();
    await card('ACME-1');
    // The name, then the Counter: its number for the eye and its sentence for a screen reader.
    const headers = [...document.querySelectorAll('[data-column-header]')].map((header) => [
      header.getAttribute('data-column-header'),
      header.querySelector('[data-counter] [aria-hidden="true"]')?.textContent,
      header.querySelector('[data-counter] .sr-only')?.textContent,
    ]);
    // S-25.4: the paused-by-hand ACME-3 waits on nobody, so it is under Active beside ACME-1, and
    // Needs you holds the one task `needsYou` says waits on a person.
    expect(headers).toEqual([
      ['queued', '0', '0 tasks'],
      ['active', '2', '2 tasks'],
      ['waiting', '1', '1 task'],
      ['review', '0', '0 tasks'],
      ['done', '1', '1 task'],
    ]);
    expect(
      [...document.querySelectorAll('[data-column-header]')].map((header) =>
        header.textContent?.replace(/\d.*$/, ''),
      ),
    ).toEqual(['Queued', 'Active', 'Needs you', 'Ready to merge', 'Done']);
    const waiting = screen.getByRole('region', { name: 'Needs you' });
    expect(waiting.className).toContain('border-running');
    expect(waiting.querySelector('[data-column-header] [data-counter]')?.className ?? '').toContain(
      'bg-primary',
    );
    // The beacon is the waiting column's alone.
    expect(screen.getByRole('region', { name: 'Active' }).className).not.toContain(
      'border-running',
    );
    // Below `xl` the columns scroll sideways and snap, rather than wrap.
    const columns = document.querySelector('[data-board-columns]');
    expect(columns?.className).toContain('overflow-x-auto');
    expect(columns?.className).toContain('snap-x');
    expect(columns?.className).toContain('xl:grid-cols-5');
  });
});

describe('a card’s phase (TD-033 decision 7)', () => {
  it('draws the stages the task entered, the current one highlighted, with what the agent is doing', async () => {
    open();
    const busy = await card('ACME-1');
    const strip = within(busy).getByRole('list', { name: 'Pipeline stages' });
    const phases = [...strip.querySelectorAll('li')].map((item) => item.getAttribute('data-phase'));
    // One entry per stage entered, in the order first entered, each its latest attempt's state.
    expect(phases).toEqual(['done', 'done', 'current']);
    expect(strip.querySelector('[aria-current="step"]')?.getAttribute('title')).toBe(
      'Code review: current',
    );
    // The agents read says a reviewer is reading files.
    await waitFor(() => {
      expect(busy.textContent).toContain('Code review · Now: Reading files');
    });
    expect(busy.getAttribute('data-agent-working')).toBe('true');
    expect(within(busy).getByRole('img', { name: 'An agent is working on it' })).toBeTruthy();
    // The template's icon, named; and the title first, the key muted beside it.
    expect(busy.querySelector('[data-template="bug"]')?.textContent).toBe('Bug');
    expect(busy.textContent).toContain('Ticket 1');
  });

  it('says the state’s word when no agent works on it, and does not pulse', async () => {
    open();
    const paused = await card('ACME-3');
    expect(paused.querySelector('[data-task-state="paused"]')?.textContent).toBe('Paused');
    expect(paused.hasAttribute('data-agent-working')).toBe(false);
    expect(within(paused).queryByRole('img', { name: 'An agent is working on it' })).toBeNull();
    expect(paused.textContent).not.toContain('Now:');
  });

  it('reads the agent’s state words without the agents read too', async () => {
    open({ agents: false });
    const busy = await card('ACME-1');
    await waitFor(() => {
      expect(busy.querySelector('[data-task-state="active"]')?.textContent).toBe('Active');
    });
    expect(busy.hasAttribute('data-agent-working')).toBe(false);
  });

  it('says the time in the current stage, the cost, and the loop against its frozen limit', async () => {
    open();
    const busy = await card('ACME-1');
    // Entered code review attempt 2 at 11:50, now is 12:00.
    expect(busy.querySelector('[data-time="in-stage"]')?.textContent).toBe('10m 0s in stage');
    expect(busy.querySelector('[data-task-cost="measured"]')?.textContent).toBe('$0.84');
    expect(busy.querySelector('[data-loop="code_review"]')?.textContent).toBe(
      'Review round 2 of 3',
    );
    // A loop not yet gone round is not shown.
    expect(busy.querySelector('[data-loop="ci_fix"]')).toBeNull();
    // A task in no stage says how long since it was updated instead.
    const done = await card('ACME-4');
    expect(done.querySelector('[data-time="updated"]')?.textContent).toBe('updated 1h 0m ago');
  });
});

describe('the needs-you marker', () => {
  it('marks a task waiting on a person, with the count of what waits, and nothing else', async () => {
    open();
    const waiting = await card('ACME-2');
    const marker = waiting.querySelector('[data-needs-you]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain('Needs you');
    expect(marker?.querySelector('[data-asks]')?.getAttribute('data-asks')).toBe('3');
    expect(marker?.textContent).toContain('2 open questions and 1 approval waiting');

    for (const key of ['ACME-1', 'ACME-3', 'ACME-4']) {
      expect((await card(key)).querySelector('[data-needs-you]'), key).toBeNull();
    }
  });
});

describe('the card’s menu', () => {
  const menuOf = async (user: ReturnType<typeof userEvent.setup>, key: string) => {
    await user.click(within(await card(key)).getByRole('button', { name: `Actions for ${key}` }));
    return within(await screen.findByRole('menu'));
  };

  it('pauses with the task page’s reason and no Idempotency-Key, then re-reads the board', async () => {
    const user = userEvent.setup();
    const { sent, taskReads } = open();
    const menu = await menuOf(user, 'ACME-1');
    expect(menu.queryByRole('menuitem', { name: 'Resume' })).toBeNull();
    const before = taskReads();
    await user.click(menu.getByRole('menuitem', { name: 'Pause' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      path: `/api/tasks/${BUSY.id}/pause`,
      body: { reason: 'paused from the UI' },
      key: null,
    });
    await waitFor(() => {
      expect(taskReads()).toBeGreaterThan(before);
    });
  });

  it('resumes a paused task, and offers no pause for it', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    const menu = await menuOf(user, 'ACME-3');
    expect(menu.queryByRole('menuitem', { name: 'Pause' })).toBeNull();
    await user.click(menu.getByRole('menuitem', { name: 'Resume' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      path: `/api/tasks/${PAUSED.id}/resume`,
      body: { reason: 'resumed from the UI' },
      key: null,
    });
  });

  it('cancels only after a dialog that says what cancelling does', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    const menu = await menuOf(user, 'ACME-1');
    await user.click(menu.getByRole('menuitem', { name: 'Cancel…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel ACME-1?' });
    expect(dialog.textContent).toContain('cannot be resumed');
    // Nothing is sent by opening it, nor by keeping the task.
    await user.click(within(dialog).getByRole('button', { name: 'Keep the task' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent).toHaveLength(0);

    await user.click((await menuOf(user, 'ACME-1')).getByRole('menuitem', { name: 'Cancel…' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel task' }),
    );
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      path: `/api/tasks/${BUSY.id}/cancel`,
      body: { reason: 'cancelled from the UI' },
      key: null,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('returns to a stage the task entered, with the person’s reason and an Idempotency-Key', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    const menu = await menuOf(user, 'ACME-1');
    await user.click(menu.getByRole('menuitem', { name: 'Return to stage…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Return ACME-1 to a stage' }));
    const picker = dialog.getByLabelText('Stage') as HTMLSelectElement;
    // The stages the task entered, once each, in words; the one before the current is chosen.
    expect([...picker.options].map((option) => [option.value, option.textContent])).toEqual([
      ['refinement', 'Refinement'],
      ['implementation', 'Implementation'],
      ['code_review', 'Code review'],
    ]);
    expect(picker.value).toBe('implementation');
    const submit = dialog.getByRole('button', { name: 'Return to stage' });
    // The reason is required, as `returnToStageRequestSchema` requires it.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(picker, 'refinement');
    await user.type(dialog.getByLabelText('Reason'), 'The scope changed');
    await user.click(submit);
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.path).toBe(`/api/tasks/${BUSY.id}/return-to-stage`);
    expect(sent[0]?.body).toEqual({ stage: 'refinement', reason: 'The scope changed' });
    expect(sent[0]?.key).toMatch(/^[A-Za-z0-9._:-]+$/);
  });

  it('links the ticket and the MR through safeHref, and refuses a hostile scheme by name', async () => {
    const user = userEvent.setup();
    open();
    const menu = await menuOf(user, 'ACME-1');
    const ticket = menu.getByRole('menuitem', { name: 'Open ticket' });
    expect(ticket.getAttribute('href')).toBe('https://tickets.example.invalid/ACME-1');
    expect(ticket.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(menu.getByRole('menuitem', { name: 'Open merge request' }).getAttribute('href')).toBe(
      'https://git.example.invalid/acme/api/-/merge_requests/7',
    );
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });

    // ACME-3's ticket URL is `javascript:`: the label stays, as refused text with no href.
    const hostile = await menuOf(user, 'ACME-3');
    const refused = hostile.getByRole('menuitem', { name: 'Open ticket' });
    expect(refused.getAttribute('data-link-refused')).toBe('true');
    expect(refused.hasAttribute('href')).toBe(false);
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    // No merge request, no *Open MR*.
    expect(hostile.queryByRole('menuitem', { name: 'Open merge request' })).toBeNull();
  });

  it('offers a member neither Cancel nor Return to stage, which are a maintainer’s', async () => {
    const user = userEvent.setup();
    open({ may: MEMBER });
    const menu = await menuOf(user, 'ACME-1');
    expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Pause',
      'Open ticket',
      'Open merge request',
    ]);
  });

  it('offers nothing but the links once the task has ended', async () => {
    const user = userEvent.setup();
    open();
    const menu = await menuOf(user, 'ACME-4');
    expect(menu.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Open ticket']);
  });
});

describe('what a card says, as functions', () => {
  it('counts what waits, and calls a waiting state or an open ask "needs you"', () => {
    expect(needsYou(WAITING)).toBe(true);
    expect(asksLabel(WAITING)).toBe('2 open questions and 1 approval waiting');
    expect(needsYou(task(9, { state: 'needs_human' }))).toBe(true);
    // A question that does not block still waits on a person.
    expect(needsYou(task(9, { state: 'active', open_questions: 1 }))).toBe(true);
    expect(asksLabel(task(9, { pending_approvals: 1 }))).toBe('1 approval waiting');
    expect(needsYou(BUSY)).toBe(false);
    // A pause only a person ends waits on one; a manual pause is somebody's choice.
    expect(needsYou(PAUSED)).toBe(false);
    expect(needsYou(task(9, { state: 'paused', paused_reason: 'budget' }))).toBe(true);
    expect(needsYou(task(9, { state: 'paused', paused_reason: 'taken_over' }))).toBe(true);
    expect(needsYou(task(9, { state: 'paused', paused_reason: null }))).toBe(false);
  });

  it('times the latest attempt of the current stage, and nothing without one', () => {
    expect(stageEnteredAt(BUSY)).toBe('2026-06-01T11:50:00.000Z');
    expect(stageEnteredAt(DONE)).toBeNull();
    // A current stage the task has no row for yet has no time in it.
    expect(stageEnteredAt(task(9, { current_stage: 'ci_gate', stages: BUSY.stages }))).toBeNull();
  });

  it('says a loop against its limit only when the limit is known', () => {
    expect(loopBadges(BUSY)).toEqual([{ loop: 'code_review', text: 'Review round 2 of 3' }]);
    expect(
      loopBadges(task(9, { iteration_counters: { code_review: 1 }, loop_limits: null })),
    ).toEqual([{ loop: 'code_review', text: 'Review round 1' }]);
    expect(loopBadges(task(9, { iteration_counters: { house_loop: 2 }, loop_limits: {} }))).toEqual(
      [{ loop: 'house_loop', text: 'House Loop round 2' }],
    );
  });

  it('offers each command only where its state allows it', () => {
    expect(menuCommandsFor(BUSY, ALL)).toEqual({
      pause: true,
      resume: false,
      cancel: true,
      returnTo: ['refinement', 'implementation', 'code_review'],
    });
    expect(menuCommandsFor(PAUSED, ALL)).toMatchObject({
      pause: false,
      resume: true,
      cancel: true,
    });
    expect(menuCommandsFor(task(9, { state: 'needs_human' }), ALL)).toMatchObject({
      pause: false,
      resume: true,
    });
    expect(menuCommandsFor(DONE, ALL)).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      returnTo: [],
    });
    // A queued task entered no stage; a merged one is never sent back.
    expect(menuCommandsFor(task(9, { state: 'queued' }), ALL).returnTo).toEqual([]);
    expect(
      menuCommandsFor(
        task(9, {
          state: 'needs_human',
          stages: [
            {
              stage: 'merged_gate',
              attempt: 1,
              state: 'completed',
              entered_at: '2026-06-01T09:00:00.000Z',
            },
          ],
        }),
        ALL,
      ),
    ).toEqual({ pause: false, resume: true, cancel: true, returnTo: [] });
    // Merged and in its retrospective: still cancellable (the domain allows it, as the task page
    // offers it), never paused, never sent back before the merge.
    for (const state of ['merged', 'retro'] as const) {
      expect(menuCommandsFor(task(9, { state, stages: BUSY.stages }), ALL), state).toEqual({
        pause: false,
        resume: false,
        cancel: true,
        returnTo: [],
      });
    }
    // The caller's role decides cancel and return; the state rules still decide the rest.
    expect(menuCommandsFor(BUSY, MEMBER)).toEqual({
      pause: true,
      resume: false,
      cancel: false,
      returnTo: [],
    }); // S-23.23: and pause and resume — a viewer is offered neither, whatever the state allows.
    const VIEWER = { cancel: false, returnToStage: false, pause: false, resume: false } as const;
    expect(menuCommandsFor(BUSY, VIEWER)).toEqual({
      pause: false,
      resume: false,
      cancel: false,
      returnTo: [],
    });
    expect(menuCommandsFor(PAUSED, VIEWER).resume).toBe(false);
    expect(menuCommandsFor(PAUSED, { ...VIEWER, resume: true }).resume).toBe(true);
  });
});

describe('the list view (?view=list)', () => {
  const rows = (): string[] =>
    [...document.querySelectorAll('[data-board-row] [data-ticket-title]')].map(
      (title) => title.textContent ?? '',
    );

  it('lists every task of the same page, and the toggle says which view is current', async () => {
    const user = userEvent.setup();
    const { asked } = open();
    await card('ACME-1');
    const toggle = screen.getByRole('navigation', { name: 'Board view' });
    expect(within(toggle).getByRole('link', { name: 'Board' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await user.click(within(toggle).getByRole('link', { name: 'List' }));
    await waitFor(() => {
      expect(window.location.search).toBe('?view=list');
    });
    const list = await screen.findByRole('list', { name: 'Tasks' });
    expect(rows()).toEqual(['Ticket 1', 'Ticket 2', 'Ticket 3', 'Ticket 4']);
    expect(within(toggle).getByRole('link', { name: 'List' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // No columns in the list, and no second read of its own: the board's one page.
    expect(document.querySelector('[data-board-columns]')).toBeNull();
    expect(asked.filter((path) => path === `/api/projects/${PROJECT}/tasks`)).toHaveLength(1);
    // A row carries the same glance as a card: the needs-you ◆ on the waiting one only.
    expect(list.querySelectorAll('[data-needs-you]')).toHaveLength(1);
    expect(list.querySelector(`[data-board-row="${WAITING.id}"] [data-needs-you]`)).not.toBeNull();
  });

  it('filters by state, by template and by needs you, and clears them', async () => {
    const user = userEvent.setup();
    open({ path: '/projects/acme?view=list' });
    await screen.findByRole('list', { name: 'Tasks' });

    await user.selectOptions(screen.getByLabelText('State'), 'paused');
    expect(rows()).toEqual(['Ticket 3']);
    await user.selectOptions(screen.getByLabelText('State'), 'all');

    await user.selectOptions(screen.getByLabelText('Template'), 'bug');
    expect(rows()).toEqual(['Ticket 1']);
    // The template list is the page's own templates, in words.
    expect(
      [...(screen.getByLabelText('Template') as HTMLSelectElement).options].map(
        (option) => option.textContent,
      ),
    ).toEqual(['All', 'Bug', 'Chore', 'Feature']);
    await user.selectOptions(screen.getByLabelText('Template'), 'all');

    await user.click(screen.getByRole('checkbox', { name: 'Needs you' }));
    expect(rows()).toEqual(['Ticket 2']);

    await user.selectOptions(screen.getByLabelText('State'), 'done');
    expect(rows()).toEqual([]);
    expect(screen.getByText('No task matches these filters.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rows()).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });

  it('reads an unknown view as the board', async () => {
    open({ path: '/projects/acme?view=gallery' });
    await card('ACME-1');
    expect(screen.queryByRole('list', { name: 'Tasks' })).toBeNull();
  });

  it('keeps every task with no filter, and only matches with one (filterTasks)', () => {
    const all = [BUSY, WAITING, PAUSED, DONE];
    expect(filterTasks(all, NO_FILTERS)).toEqual(all);
    expect(filterTasks(all, { ...NO_FILTERS, state: 'done' })).toEqual([DONE]);
    expect(filterTasks(all, { ...NO_FILTERS, template: 'chore' })).toEqual([DONE]);
    expect(filterTasks(all, { ...NO_FILTERS, needsYou: true })).toEqual([WAITING]);
    expect(filterTasks(all, { state: 'active', template: 'feature', needsYou: false })).toEqual([]);
  });
});

describe('a pause that waits on a person (needs you)', () => {
  const BUDGET = task(5, { state: 'paused', paused_reason: 'budget', current_stage: null });
  const TAKEN = task(6, { state: 'paused', paused_reason: 'taken_over', current_stage: null });

  it('marks a budget pause and a take-over, not a manual pause, on the card and in the filter', async () => {
    const user = userEvent.setup();
    open({ items: [PAUSED, BUDGET, TAKEN], path: '/projects/acme?view=list' });
    await screen.findByRole('list', { name: 'Tasks' });
    const marked = (id: string) =>
      document.querySelector(`[data-board-row="${id}"] [data-needs-you]`) !== null;
    expect(marked(BUDGET.id)).toBe(true);
    expect(marked(TAKEN.id)).toBe(true);
    expect(marked(PAUSED.id)).toBe(false);

    await user.click(screen.getByRole('checkbox', { name: 'Needs you' }));
    expect(
      [...document.querySelectorAll('[data-board-row]')].map((row) =>
        row.getAttribute('data-board-row'),
      ),
    ).toEqual([BUDGET.id, TAKEN.id]);
  });
});
