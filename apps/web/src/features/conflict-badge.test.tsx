/**
 * **The board warns when two active tasks touch the same files** — product/04 S6b, product/18's
 * *"touches the same files as PROJ-98"* (WP-26's event, WP-41's field; PROGRESS backlog **63**).
 *
 * The feature's only human-visible output used to be a thread inside a merge request — the place a
 * maintainer goes *after* deciding what to work on — while the promise in two product documents is
 * about the screen where that decision is made. This file is the screen's half, driven through the
 * real application against a fake API.
 *
 * Both directions are asserted (standing rule 42): a task with a warning carries the badge, and a
 * task without one carries **nothing** — because the comparison is not symmetric (backlog 65) and a
 * badge drawn on both cards would be the platform claiming a comparison it never made.
 */
import type { TaskRecord } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: 'session-1', expiresAt: '2030-01-01T00:00:00.000Z' },
} as unknown as SessionResponse;

const task = (overrides: Partial<TaskRecord>): TaskRecord =>
  ({
    id: '00000000-0000-4000-8000-0000000000b1',
    project_id: PROJECT,
    ticket: {
      provider: 'jira',
      key: 'ACME-12',
      url: 'https://tickets.example.invalid/browse/ACME-12',
    },
    template: 'feature',
    mode: 'normal',
    state: 'active',
    current_stage: 'rebase_gate',
    size: null,
    branch: null,
    mr_ref: null,
    workpad_ref: null,
    iteration_counters: {},
    risk_classes: [],
    coverage: null,
    dependencies: null,
    required_reviewers: null,
    conflict: null,
    cost_actual_usd: 0,
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

const WARNED = task({
  id: '00000000-0000-4000-8000-0000000000b2',
  ticket: {
    provider: 'jira',
    key: 'ACME-13',
    url: 'https://tickets.example.invalid/browse/ACME-13',
  },
  conflict: {
    other_task_id: '00000000-0000-4000-8000-0000000000b1',
    other_ticket_key: 'ACME-12',
    path_count: 3,
    truncated: false,
    warned_at: '2026-06-01T10:00:00.000Z',
  },
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.includes(`/api/projects/${PROJECT}/tasks`)) {
    return json({ items: [task({}), WARNED], next_cursor: null });
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

describe('the conflict badge on the board', () => {
  it('names the other ticket and how many paths overlap, on the warned card only', async () => {
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('ACME-13');
    await waitFor(() => {
      expect(container.textContent).toContain('touches');
    });

    const text = container.textContent ?? '';
    expect(text).toContain('touches');
    expect(text).toContain('ACME-12');
    expect(text).toContain('3 files');
    // One badge, not two: the pair was compared once, and the card that was not warned says
    // nothing rather than "no conflicts" (backlog 65).
    expect(text.match(/touches/g) ?? []).toHaveLength(1);
  });

  it('says in the tooltip that the comparison may not have read every file', async () => {
    const truncatedFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes(`/api/projects/${PROJECT}/tasks`)) {
        return json({
          items: [
            {
              ...WARNED,
              conflict: { ...WARNED.conflict, path_count: 0, truncated: true },
            },
          ],
          next_cursor: null,
        });
      }
      return fetchImpl(input);
    }) as typeof fetch;

    const { container } = render(createApp({ fetchImpl: truncatedFetch, realtime: false }).element);
    await screen.findByText('ACME-13');
    await waitFor(() => {
      expect(container.textContent).toContain('touches');
    });

    // `path_count: 0` under `truncated: true` is "nothing found in what was compared" rather than
    // "nothing to find" (backlog 64), and the tooltip is where a reader is told so.
    const badge = container.querySelector('[title*="did not read every file"]');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('title')).toContain('ACME-12');
  });
});
