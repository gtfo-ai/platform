/**
 * **The owner on the board** (S-26.8b, the M26 UX spec § 3), driven through `createApp` against a
 * fake server, as `board-card.test.tsx` is.
 *
 * - *Everyone* · *Mine* · *Unassigned* is a segmented control — beside the view toggle on the board,
 *   in the list box's header on the list — that puts `?owner=me|none` in the URL **and in the
 *   request** (the server filters), remembers the choice for this person, and opens it again on a
 *   board URL that names none; *Everyone* drops both.
 * - A card shows its owner's avatar only — initials, *Owner: Vojtěch* as its accessible name and its
 *   tooltip — and an unassigned card shows nothing. The *Needs you* column is unchanged.
 */
import type { TaskListItem } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { ownerFilterStorageKey } from './board-owner-filter.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const ME = '00000000-0000-4000-8000-000000000001';
const VOJTECH = '00000000-0000-4000-8000-000000000009';
const NOW = Date.parse('2026-06-01T12:00:00.000Z');
/** A bidi override (CVE-2021-42574), at the end so the initials stay the name's own. */
const BIDI = '\u202E';

const session = (userId: string): SessionResponse =>
  ({
    user: { id: userId, email: 'operator@example.invalid', name: 'Fake Operator', role: 'member' },
    session: { id: 'session-1', expiresAt: '2030-01-01T00:00:00.000Z' },
  }) as unknown as SessionResponse;

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

/** Owned by somebody else, and waiting on a person: the column rule does not change with owners. */
const OWNED = task(1, {
  owner: { user_id: VOJTECH, name: `Vojtěch Dvořák${BIDI}` },
  owner_source: 'platform',
  state: 'waiting_answers',
  open_questions: 1,
});
/** Nobody owns it. */
const UNASSIGNED = task(2, { owner: null, unlinked_assignee: null });
/** Mine. */
const MINE = task(3, { owner: { user_id: ME, name: 'Fake Operator' } });

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
  open_tasks: 3,
  spent_usd_30d: 0,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const open = (path = '/projects/acme', userId = ME) => {
  /** The `owner` each task-page read carried (`null` for none). */
  const owners: (string | null)[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname.includes('/api/auth/get-session')) return json(session(userId));
    if (url.pathname === `/api/projects/${PROJECT}/tasks`) {
      const owner = url.searchParams.get('owner');
      owners.push(owner);
      const items =
        owner === 'me' ? [MINE] : owner === 'none' ? [UNASSIGNED] : [OWNED, UNASSIGNED, MINE];
      return json({
        items,
        next_cursor: null,
        can_start_task: true,
        can_cancel_task: false,
        can_return_to_stage: false,
        can_pause_task: true,
        can_resume_task: true,
      });
    }
    if (url.pathname === '/api/org/agents') return json({ items: [] });
    if (url.pathname === '/api/projects') return json({ items: [PROJECT_ROW] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  window.history.pushState({}, '', path);
  const view = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
  return { view, owners };
};

const filter = async (): Promise<HTMLElement> =>
  screen.findByRole('group', { name: 'Whose tasks' });

const pressed = (group: HTMLElement): string[] =>
  within(group)
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent ?? '');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the owner filter', () => {
  it('reads Everyone by default, and asks the server for no owner filter', async () => {
    const { owners } = open();
    const group = await filter();
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Everyone', 'Mine', 'Unassigned']);
    expect(pressed(group)).toEqual(['Everyone']);
    await screen.findByRole('article', { name: 'ACME-1' });
    expect(owners).toEqual([null]);
  });

  it('puts Mine in the URL and the request, and remembers it for this person', async () => {
    const { owners } = open();
    const group = await filter();
    await userEvent.setup().click(within(group).getByRole('button', { name: 'Mine' }));
    await waitFor(() => {
      expect(window.location.search).toBe('?owner=me');
    });
    await waitFor(() => {
      expect(owners).toContain('me');
    });
    expect(pressed(group)).toEqual(['Mine']);
    expect(await screen.findByRole('article', { name: 'ACME-3' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: 'ACME-1' })).toBeNull();
    });
    expect(localStorage.getItem(ownerFilterStorageKey(ME))).toBe('me');
  });

  it('opens a board URL with no filter on this person’s last one, and says so in the URL', async () => {
    localStorage.setItem(ownerFilterStorageKey(ME), 'none');
    const { owners } = open('/projects/acme');
    const group = await filter();
    await waitFor(() => {
      expect(window.location.search).toBe('?owner=none');
    });
    expect(pressed(group)).toEqual(['Unassigned']);
    await screen.findByRole('article', { name: 'ACME-2' });
    expect(owners).toContain('none');
  });

  it('lets a URL that names a filter win over the remembered one', async () => {
    localStorage.setItem(ownerFilterStorageKey(ME), 'none');
    const { owners } = open('/projects/acme?owner=me');
    const group = await filter();
    await screen.findByRole('article', { name: 'ACME-3' });
    expect(pressed(group)).toEqual(['Mine']);
    expect(owners).not.toContain('none');
  });

  it('does not hand one person’s choice to another on the same browser', async () => {
    localStorage.setItem(ownerFilterStorageKey(VOJTECH), 'me');
    const { owners } = open('/projects/acme', ME);
    const group = await filter();
    await screen.findByRole('article', { name: 'ACME-1' });
    expect(pressed(group)).toEqual(['Everyone']);
    expect(window.location.search).toBe('');
    expect(owners).toEqual([null]);
  });

  it('forgets the choice and drops the parameter on Everyone', async () => {
    localStorage.setItem(ownerFilterStorageKey(ME), 'me');
    open('/projects/acme?owner=me');
    const group = await filter();
    await userEvent.setup().click(within(group).getByRole('button', { name: 'Everyone' }));
    await waitFor(() => {
      expect(window.location.search).toBe('');
    });
    expect(localStorage.getItem(ownerFilterStorageKey(ME))).toBeNull();
    await screen.findByRole('article', { name: 'ACME-1' });
  });

  it('sits in the list box’s header on the list view, and the view toggle keeps it', async () => {
    open('/projects/acme?view=list&owner=none');
    const list = await screen.findByRole('list', { name: 'Tasks' });
    const box = list.parentElement as HTMLElement;
    const group = await within(box).findByRole('group', { name: 'Whose tasks' });
    expect(pressed(group)).toEqual(['Unassigned']);
    const toggle = screen.getByRole('navigation', { name: 'Board view' });
    expect(within(toggle).getByRole('link', { name: 'Board' }).getAttribute('href')).toBe(
      '/projects/acme?owner=none',
    );
    expect(within(toggle).getByRole('link', { name: 'List' }).getAttribute('href')).toBe(
      '/projects/acme?view=list&owner=none',
    );
  });
});

describe('the card’s owner', () => {
  it('shows the owner’s initials, named and with a tooltip, and nothing for nobody', async () => {
    open();
    const owned = await screen.findByRole('article', { name: 'ACME-1' });
    // The name is sanitised: the bidi override is a visible replacement, never a reordering.
    const said = 'Owner: Vojtěch Dvořák\uFFFD';
    const avatar = within(owned).getByRole('img', { name: said });
    expect(avatar.textContent).toBe('VD');
    expect(owned.querySelector('[data-card-owner]')?.getAttribute('title')).toBe(said);
    const unassigned = await screen.findByRole('article', { name: 'ACME-2' });
    expect(unassigned.querySelector('[data-card-owner]')).toBeNull();
    expect(unassigned.querySelector('[data-avatar]')).toBeNull();
  });

  it('keeps the Needs you rule: an owned task waiting on a person is still there', async () => {
    open();
    const waiting = await screen.findByRole('region', { name: 'Needs you' });
    expect(await within(waiting).findByRole('article', { name: 'ACME-1' })).toBeTruthy();
    expect(within(waiting).queryByRole('article', { name: 'ACME-3' })).toBeNull();
  });
});
