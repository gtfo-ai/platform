/**
 * **The board card carries the ticket's title** — product/10 § "Board (project)": *"ticket key +
 * title"* (Q48, WP-95).
 *
 * The title is `task.ticket_title`, a projection over `tasks.ticket_snapshot` — the ticket's own
 * words as the platform read them, bounded and redacted at the write — so it is provider text and
 * must reach the DOM as text (BD-022). Both directions are asserted (standing rule 42): a task whose
 * ticket was read shows its title, and a task whose ticket was **not** read says so rather than
 * drawing an empty line or a guess.
 *
 * **And what its cost leaves out** (WP-134, PROGRESS backlog 408): the card's total is
 * `cost_actual_usd`, which adds only measured runs, so a card whose task has a run nobody measured
 * says how many — and one with none says nothing — under a title that no longer claims the figure
 * is provider-reported (it is priced in local provider mode).
 */
import type { TaskRecord } from '@platform/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { BOARD_COST_TITLE } from './cost-text.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'viewer',
  },
  session: { id: 'session-1', expiresAt: '2030-01-01T00:00:00.000Z' },
};

/** Markup in a title a ticket author chose: it must be shown, never parsed. */
const HOSTILE_TITLE = 'Checkout <img src=x onerror="window.__pwned=true"> button';

const task = (overrides: Partial<TaskRecord>): TaskRecord =>
  ({
    id: '00000000-0000-4000-8000-0000000000b1',
    project_id: PROJECT,
    ticket: { provider: 'jira', key: 'ACME-21', url: 'https://tickets.example.invalid/ACME-21' },
    ticket_title: HOSTILE_TITLE,
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
    cost_actual_usd: 0,
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
    updated_at: '2026-06-01T09:00:00.000Z',
    completed_at: null,
    ...overrides,
  }) as TaskRecord;

const UNREAD = task({
  id: '00000000-0000-4000-8000-0000000000b2',
  ticket: { provider: 'jira', key: 'ACME-22', url: 'https://tickets.example.invalid/ACME-22' },
  ticket_title: null,
  // WP-134 (backlog 408): this card's total leaves two runs out; the other card's leaves none.
  cost_actual_usd: 1.5,
  unmeasured_runs: 2,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.includes(`/api/projects/${PROJECT}/tasks`)) {
    return json({ items: [task({}), UNREAD], next_cursor: null, can_start_task: false });
  }
  if (url.endsWith('/api/projects')) {
    return json({
      items: [
        {
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
          open_tasks: 2,
          spent_usd_30d: 0,
        },
      ],
    });
  }
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/projects/acme');
});

describe('the board card’s ticket title (Q48)', () => {
  it('shows the stored title as text, and says so when the ticket has not been read', async () => {
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('ACME-22');

    const read = container.querySelector('[data-ticket-title="read"]');
    expect(read?.textContent).toBe(HOSTILE_TITLE);
    // Text, not markup: the `<img>` a ticket author typed is characters on the card.
    expect(container.querySelector('img')).toBeNull();

    const unread = container.querySelectorAll('[data-ticket-title="unread"]');
    expect(unread).toHaveLength(1);
    expect(unread[0]?.textContent).toBe('Ticket not read yet');
    // Exactly one of each: the read card does not also claim it is unread.
    expect(container.querySelectorAll('[data-ticket-title="read"]')).toHaveLength(1);
  });
});

describe('the board card’s cost (WP-134, backlog 408)', () => {
  it('counts the runs its total excludes, and says nothing when it excludes none', async () => {
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('ACME-22');

    const excluded = container.querySelectorAll('[data-unmeasured-runs]');
    // Exactly one card — ACME-22's — leaves runs out; ACME-21's measured everything it ran.
    expect(excluded).toHaveLength(1);
    expect(excluded[0]?.getAttribute('data-unmeasured-runs')).toBe('2');
    expect(excluded[0]?.textContent).toBe('excl. 2 unmeasured');
    expect(excluded[0]?.getAttribute('title')).toBe('Excludes 2 runs nobody measured.');

    const totals = [...container.querySelectorAll('[data-task-cost="measured"]')];
    expect(totals.map((total) => total.textContent)).toEqual(['$0.00', '$1.50']);
    for (const total of totals) {
      expect(total.getAttribute('title')).toBe(BOARD_COST_TITLE);
      // The label no longer claims a figure that is priced in local mode was reported.
      expect(total.getAttribute('title')).not.toMatch(/^Provider-reported/);
    }
    // The count sits on the same card as its total, not on the neighbour's.
    expect(totals[1]?.parentElement?.contains(excluded[0] ?? null)).toBe(true);
    expect(totals[0]?.parentElement?.querySelector('[data-unmeasured-runs]')).toBeNull();
  });
});
