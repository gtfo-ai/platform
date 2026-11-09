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
import {
  type AgentEntry,
  asksLabel,
  cardActivity,
  loopBadges,
  menuCommandsFor,
  needsYou,
  stageEnteredAt,
} from './board-card.js';

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
    tracker_assignee: null,
    owner: null,
    owner_source: null,
    unlinked_assignee: null,
    owner_writes_back: false,
    waiting: null,
    stages: [],
    open_questions: 0,
    pending_approvals: 0,
    loop_limits: null,
    gate_wait: null,
    latest_return: null,
    stop: null,
    escalation_reason: null,
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
  gate_wait: null,
  latest_return: null,
  stop: null,
  escalation_reason: null,
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
      waiting: null,
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

  // S-25.23 (BACKLOG 1375): Pause opens a dialog whose optional why is the reason recorded.
  it('pauses through a dialog with the person’s why and no Idempotency-Key, then re-reads the board', async () => {
    const user = userEvent.setup();
    const { sent, taskReads } = open();
    const menu = await menuOf(user, 'ACME-1');
    expect(menu.queryByRole('menuitem', { name: 'Resume' })).toBeNull();
    const before = taskReads();
    await user.click(menu.getByRole('menuitem', { name: 'Pause…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause ACME-1' });
    // Nothing is sent by opening it.
    expect(sent).toHaveLength(0);
    await user.type(
      within(dialog).getByLabelText('Why are you pausing it? — optional'),
      'waiting for the release freeze',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]).toEqual({
      path: `/api/tasks/${BUSY.id}/pause`,
      body: { reason: 'waiting for the release freeze' },
      key: null,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Pause ACME-1' })).toBeNull();
    });
    await waitFor(() => {
      expect(taskReads()).toBeGreaterThan(before);
    });
  });

  it('pauses with no reason at all when the why is left blank (S-25.23)', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    const menu = await menuOf(user, 'ACME-1');
    await user.click(menu.getByRole('menuitem', { name: 'Pause…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause ACME-1' });
    await user.type(within(dialog).getByLabelText('Why are you pausing it? — optional'), '   ');
    await user.click(within(dialog).getByRole('button', { name: 'Pause' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    // Not the fixed "paused from the UI" the button used to send: no words, no reason.
    expect(sent[0]).toEqual({ path: `/api/tasks/${BUSY.id}/pause`, body: {}, key: null });
  });

  it('resumes a paused task, and offers no pause for it', async () => {
    const user = userEvent.setup();
    const { sent } = open();
    const menu = await menuOf(user, 'ACME-3');
    expect(menu.queryByRole('menuitem', { name: 'Pause…' })).toBeNull();
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
      'Pause…',
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

/**
 * S-26.8b part 2: why a task waits, in short form (the M26 UX spec § 4), and a CI check held at a
 * manual job — the board item's `gate_wait` (BACKLOG 1300) — which is *Needs you* through the one
 * rule, for an active task only.
 */
describe('a card that waits for a machine, or for a person to start a CI job', () => {
  const OWNER = '00000000-0000-4000-8000-00000000a001';
  const HELD_WAIT = {
    pipeline_id: '41',
    pipeline_url: null,
    status: 'manual',
    held_job: 'deploy',
    held_job_url: null,
    draft: false,
    checked_at: '2026-06-01T11:58:00.000Z',
    waiting_since: '2026-06-01T11:30:00.000Z',
    timeout_minutes: 60,
  } as const;
  const waiting = (over: Partial<NonNullable<TaskListItem['waiting']>>) => ({
    reason: 'owner_worker_offline' as const,
    user: { user_id: OWNER, name: 'Vojtěch' },
    last_seen_at: '2026-06-01T10:00:00.000Z',
    assignee_name: null,
    blockers: [],
    ...over,
  });
  const HELD = task(5, { state: 'active', current_stage: 'ci_gate', gate_wait: HELD_WAIT });
  const HELD_PAUSED = task(6, {
    state: 'paused',
    paused_reason: 'manual',
    current_stage: 'ci_gate',
    gate_wait: HELD_WAIT,
  });
  const OFFLINE = task(7, { current_stage: 'implementation', waiting: waiting({}) });
  const MINE = task(8, {
    current_stage: 'implementation',
    waiting: waiting({
      reason: 'owner_worker_paused',
      user: { user_id: '00000000-0000-4000-8000-000000000001', name: 'Fake Operator' },
    }),
  });
  const ASKING = task(10, {
    current_stage: 'implementation',
    open_questions: 1,
    waiting: waiting({}),
  });
  const FREE = task(9, {
    current_stage: 'implementation',
    waiting: waiting({ reason: null, user: null, last_seen_at: null }),
  });

  it('says CI held · start the job on an active task, puts it in Needs you, and not a paused one', async () => {
    open({ items: [HELD, HELD_PAUSED], agents: false });
    const held = await card('ACME-5');
    expect(held.querySelector('[data-card-setback="ci_held"]')?.textContent).toBe(
      'CI held · start the job',
    );
    expect(held.querySelector('[data-needs-you]')).not.toBeNull();
    expect(held.closest('[data-column]')?.getAttribute('data-column')).toBe('waiting');
    const paused = await card('ACME-6');
    expect(paused.querySelector('[data-card-setback]')).toBeNull();
    expect(paused.querySelector('[data-needs-you]')).toBeNull();
    expect(needsYou(HELD)).toBe(true);
    expect(needsYou(HELD_PAUSED)).toBe(false);
  });

  it('says why it waits in short form, "your machine" to its owner, and nothing when it can be taken', async () => {
    open({ items: [OFFLINE, MINE, FREE], agents: false });
    const offline = await card('ACME-7');
    await waitFor(() => {
      expect(offline.querySelector('[data-card-waiting]')?.textContent).toBe(
        'Waiting · Vojtěch’s machine is offline',
      );
    });
    expect(offline.querySelector('[data-needs-you]')).toBeNull();
    expect((await card('ACME-8')).querySelector('[data-card-waiting]')?.textContent).toBe(
      'Waiting · your machine is paused',
    );
    const free = await card('ACME-9');
    expect(free.querySelector('[data-card-waiting]')).toBeNull();
    expect(free.querySelector('[data-task-state="active"]')?.textContent).toBe('Active');
  });

  it('keeps Needs you on a waiting task with an open ask, rather than the waiting words', async () => {
    open({ items: [ASKING], agents: false });
    const asking = await card('ACME-10');
    await waitFor(() => {
      expect(asking.querySelector('[data-task-state="active"]')?.textContent).toBe('Needs you');
    });
    expect(asking.querySelector('[data-card-waiting]')).toBeNull();
    expect(asking.querySelector('[data-needs-you]')).not.toBeNull();
  });

  it('makes the waiting activity’s sub-label the reason while a run waits to start', () => {
    const created = {
      ...AGENTS.items[0],
      run: runRecord({ ...AGENTS.items[0]?.run, status: 'created', started_at: null }),
      waiting: OFFLINE.waiting,
    } as unknown as AgentEntry;
    expect(cardActivity(OFFLINE, created, NOW)).toEqual({
      activity: 'waiting',
      detail: 'Vojtěch’s machine is offline',
    });
    expect(cardActivity(FREE, created, NOW).detail).toBe('Starting');
  });
});

/**
 * S-25.15 part B: a task stopped for a person (`needs_human`) says why on its card and its list
 * row, from the item's `escalation_reason` — whose ticket it is, a key's short words, or *Needs a
 * person* with the stage — and a structured stop keeps its own short form (S-25.11).
 */
describe('a card stopped for a person says why it waits', () => {
  const VOJTECH = 'Vojtěch <img src=x onerror=alert(1)>';
  const stopped = (n: number, reason: string | null, over: Partial<TaskListItem> = {}) =>
    task(n, {
      state: 'needs_human',
      current_stage: 'refinement',
      escalation_reason: reason,
      ...over,
    });
  const NAMED = stopped(21, 'ticket_assigned_elsewhere', {
    tracker_assignee: { display_name: VOJTECH, user_id: null },
    unlinked_assignee: { display_name: VOJTECH },
  });
  const NAMELESS = stopped(22, 'ticket_assigned_elsewhere', {
    unlinked_assignee: { display_name: null },
  });
  const KEYED = stopped(23, 'converged', { current_stage: 'ci_gate' });
  const SENTENCE = stopped(24, 'stage "refinement" rejected the task');
  const UNWORDED = stopped(25, 'escalated');
  const ACTIVE = task(26, { state: 'active', current_stage: 'refinement' });

  const stopOn = (element: HTMLElement): Element | null =>
    element.querySelector('[data-card-setback="escalated"]');

  it('names whose ticket it is, says a key’s words, and Needs a person with the stage otherwise', async () => {
    open({ items: [NAMED, NAMELESS, KEYED, SENTENCE, UNWORDED, ACTIVE], agents: false });
    const said = async (key: string) => {
      const line = stopOn(await card(key));
      return [line?.getAttribute('data-card-escalation'), line?.textContent];
    };
    expect(await said('ACME-21')).toEqual([
      'held_elsewhere',
      `Waiting for: ${VOJTECH}’s Jira ticket`,
    ]);
    expect(await said('ACME-22')).toEqual([
      'held_nameless',
      'Waiting for: a Jira ticket someone else holds',
    ]);
    expect(await said('ACME-23')).toEqual(['worded', 'The same failure repeated']);
    // A sentence is not a key, and a key nobody words gets no words of its own.
    expect(await said('ACME-24')).toEqual(['generic', 'Needs a person · Refinement']);
    expect(await said('ACME-25')).toEqual(['generic', 'Needs a person · Refinement']);
    // A provider's name is text, never markup (BD-022).
    expect((await card('ACME-21')).querySelector('img')).toBeNull();
    // The other direction: a task that is not stopped says nothing of the kind.
    expect(stopOn(await card('ACME-26'))).toBeNull();
  });

  it('says it on the list view’s row too', async () => {
    open({ items: [NAMED, ACTIVE], agents: false, path: '/projects/acme?view=list' });
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(`[data-board-row="${NAMED.id}"]`);
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(stopOn(row)?.textContent).toBe(`Waiting for: ${VOJTECH}’s Jira ticket`);
    const other = document.querySelector<HTMLElement>(`[data-board-row="${ACTIVE.id}"]`);
    expect(stopOn(other as HTMLElement)).toBeNull();
  });

  it('keeps a structured stop’s own short form, which says more (S-25.11)', async () => {
    const STRUCTURED = stopped(27, 'converged', {
      current_stage: 'ci_gate',
      stop: {
        stage: 'ci_gate',
        attempt: 1,
        cause: 'no_answer',
        loop: null,
        ci_failure: null,
        recorded: null,
        recorded_cut: false,
        ci_ending: 'ci_timed_out',
      },
    });
    open({ items: [STRUCTURED], agents: false });
    const element = await card('ACME-27');
    expect(stopOn(element)).toBeNull();
    expect(element.querySelector('[data-card-setback="stopped"]')?.textContent).toBe(
      'CI did not finish',
    );
  });
});

describe('the Queued column says what holds it (S-25.16)', () => {
  const HOLDERS = [31, 32, 33, 34, 35].map((n) => ({
    task_id: id(n),
    ticket_key: `ACME-${n}`,
    state: 'needs_human' as const,
  }));
  const waitAt = (position: number): NonNullable<TaskListItem['queue_wait']> => ({
    status: 'waiting',
    reason: 'max_tasks_in_pipeline',
    count: 5,
    limit: 5,
    position,
    queued: 2,
    running: { count: 0, limit: 2 },
    pipeline: { count: 5, limit: 5 },
    holders: { total: 5, needs_human: 5, items: HOLDERS },
  });
  const FIRST = task(41, { state: 'queued', queue_wait: waitAt(1) });
  const SECOND = task(42, { state: 'queued', queue_wait: waitAt(2) });
  const STOPPED = HOLDERS.map((_holder, index) =>
    task(31 + index, { state: 'needs_human', current_stage: 'refinement' }),
  );
  const NOTE =
    'Waiting for a place: this project holds at most 5 tasks in its pipeline, and 5 are in it — ' +
    '5 of them wait for you. A place frees when one of them finishes or is cancelled, so decide ' +
    'them or cancel one.';

  it('says the sentence once, as the column’s note, and each card its own place', async () => {
    open({ items: [FIRST, SECOND, ...STOPPED], agents: false });
    await card('ACME-42');
    const column = screen.getByRole('region', { name: 'Queued' });
    expect(column.id).toBe('queued-tasks');
    const notes = column.querySelectorAll('[data-queue-note]');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toBe(NOTE);
    // No other column carries it.
    expect(document.querySelectorAll('[data-queue-note]')).toHaveLength(1);
    expect((await card('ACME-41')).querySelector('[data-card-queue]')?.textContent).toBe(
      '1st in queue · 5 of 5 places taken',
    );
    expect((await card('ACME-42')).querySelector('[data-card-queue]')?.textContent).toBe(
      '2nd in queue · 5 of 5 places taken',
    );
  });

  it('says the holders wait for a person to a reader who may not cancel them', async () => {
    open({ items: [FIRST, SECOND, ...STOPPED], agents: false, may: MEMBER });
    await card('ACME-42');
    const note = document.querySelector('[data-queue-note]')?.textContent ?? '';
    expect(note).toContain('5 of them wait for a person.');
    expect(note).not.toMatch(/for you|decide them/);
  });

  it('draws no note and the state’s word for a queued task the read gives no wait', async () => {
    const plain = task(43, { state: 'queued' });
    const admitted = task(44, {
      state: 'queued',
      queue_wait: {
        status: 'admitted',
        position: 1,
        queued: 2,
        running: { count: 0, limit: 2 },
        pipeline: { count: 0, limit: 5 },
      },
    });
    open({ items: [plain, admitted], agents: false });
    const bare = await card('ACME-43');
    expect(bare.querySelector('[data-card-queue]')).toBeNull();
    expect(bare.textContent).toContain('Queued');
    // Admitted: nothing holds it, so no note; the card says a place is free.
    expect((await card('ACME-44')).querySelector('[data-card-queue]')?.textContent).toBe(
      '1st in queue · a place is free',
    );
    expect(document.querySelector('[data-queue-note]')).toBeNull();
  });
});
