/**
 * **Start a ticket by its key, from the board** — product/04 S0's manual "Start" (WP-122, PROGRESS
 * backlog 379, criterion 3).
 *
 * Driven through `createApp` with a fake server, so the real endpoint parsers read the page's
 * `can_start_task` and the real client sends the command. Both directions (standing rule 42): the
 * form is offered to a caller who holds `task.create` and to nobody else, and the empty board's
 * hint names only what exists — for the caller reading it.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { emptyBoardHint } from './board.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const EVENT = '00000000-0000-4000-8000-0000000000e1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'viewer',
  },
  session: { id: 'session-1' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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
  open_tasks: 0,
  spent_usd_30d: 0,
};

interface Sent {
  readonly path: string;
  readonly body: unknown;
  readonly key: string | null;
}

const open = (options: {
  readonly canStart: boolean;
  readonly refusal?: { readonly status: number; readonly code: string; readonly message: string };
}) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = new URL(url, 'http://localhost').pathname;
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (path === `/api/projects/${PROJECT}/tasks` && init?.method === 'POST') {
      sent.push({
        path,
        body: JSON.parse(String(init.body ?? '{}')),
        key: new Headers(init.headers).get('idempotency-key'),
      });
      if (options.refusal !== undefined) {
        return json(
          { error: { code: options.refusal.code, message: options.refusal.message } },
          options.refusal.status,
        );
      }
      return json(
        {
          performed: true,
          event_id: EVENT,
          ticket: {
            provider: 'jira',
            key: 'ACME-7',
            url: 'https://tickets.example.invalid/ACME-7',
          },
        },
        202,
      );
    }
    if (path === `/api/projects/${PROJECT}/tasks`) {
      return json({ items: [], next_cursor: null, can_start_task: options.canStart });
    }
    if (path === '/api/projects') return json({ items: [PROJECT_ROW] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  const view = render(createApp({ fetchImpl, realtime: false }).element);
  return { view, sent };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/projects/acme');
});

describe('starting a ticket by hand (WP-122)', () => {
  it('offers the form to a caller who may start, and sends the key with an Idempotency-Key', async () => {
    const user = userEvent.setup();
    const { view, sent } = open({ canStart: true });
    const field = await view.findByLabelText('Start a ticket');
    await user.type(field, ' ACME-7 ');
    await user.click(view.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.path).toBe(`/api/projects/${PROJECT}/tasks`);
    // Trimmed, and nothing but the key: the template and mode are not the caller's to choose.
    expect(sent[0]?.body).toEqual({ ticket_key: 'ACME-7' });
    expect(sent[0]?.key).toMatch(/^[A-Za-z0-9._:-]+$/);
    await waitFor(() => {
      expect(view.container.textContent).toContain('Started ACME-7');
    });
  });

  it('offers no form to a caller who may not start', async () => {
    const { view } = open({ canStart: false });
    await screen.findByText('The board is empty');
    expect(view.queryByLabelText('Start a ticket')).toBeNull();
    expect(view.queryByRole('form', { name: 'Start a ticket by its key' })).toBeNull();
  });

  it('refuses a key outside the character set before sending anything', async () => {
    const user = userEvent.setup();
    const { view, sent } = open({ canStart: true });
    await user.type(await view.findByLabelText('Start a ticket'), 'ACME/7');
    await user.click(view.getByRole('button', { name: 'Start' }));
    expect(await view.findByText('That is not a ticket key.')).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('shows the server’s refusal as the server said it', async () => {
    const user = userEvent.setup();
    const { view, sent } = open({
      canStart: true,
      refusal: {
        status: 409,
        code: 'ticket_has_task',
        message: 'ticket ACME-7 already has a task in this project',
      },
    });
    await user.type(await view.findByLabelText('Start a ticket'), 'ACME-7');
    await user.click(view.getByRole('button', { name: 'Start' }));
    expect(await view.findByText('The ticket was not started.')).toBeTruthy();
    expect(view.container.textContent).toContain('already has a task in this project');
    expect(sent).toHaveLength(1);
  });

  it('names only what exists on an empty board, for the caller reading it', async () => {
    const member = open({ canStart: true });
    await member.view.findByText('The board is empty');
    expect(member.view.container.textContent).toContain(emptyBoardHint(true));
    cleanup();
    const viewer = open({ canStart: false });
    await viewer.view.findByText('The board is empty');
    expect(viewer.view.container.textContent).toContain(emptyBoardHint(false));

    // The rule kinds a binding has (`ticketMatchRuleSchema`) and nothing else: no "component".
    for (const hint of [emptyBoardHint(true), emptyBoardHint(false)]) {
      expect(hint).not.toContain('component');
      expect(hint).toContain('a label, a status, an epic or a query');
    }
    expect(emptyBoardHint(true)).toContain('start one by its key above');
    expect(emptyBoardHint(false)).not.toContain('above');
  });
});
