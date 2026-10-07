/**
 * The re-evaluate control on the project settings page — WP-94, Q107 (a).
 *
 * Driven through `createApp` with a fake server, so the router, the query client and the endpoint
 * parsers are the real ones. Four claims: the button shows the **server's** ceiling (and the last
 * discovery's cost) before anything is started; pressing it sends a keyed command; a blocked
 * project sees the reason and a disabled button rather than a button that answers 409; and a
 * refusal the server returns (a member's 403) is shown, with every server sentence rendered as text.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000d1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme_api',
  name: 'ACME API',
  repo_url: 'https://git.example.test/acme/api.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 1,
  status: 'active',
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const HOSTILE = '<img src=x onerror=alert(1)> discovery task is parked';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  readonly blocker?: { code: string; detail: string; task_id: string | null } | null;
  readonly refuse?: boolean;
  /** WP-124: the recovery pass's reason for a discovery whose findings were never recorded. */
  readonly unrecorded?: string;
}

let started: { url: string; key: string | null }[];

const fetchFor = (world: World = {}) =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/rediscovery')) {
      if ((init?.method ?? 'GET') === 'POST') {
        started.push({ url, key: new Headers(init?.headers).get('idempotency-key') });
        if (world.refuse === true) {
          return json(
            { error: { code: 'forbidden', message: 'your role on this project may not do this' } },
            403,
          );
        }
        return json(
          { task_id: TASK, started: true, detail: 'the Discovery agent is queued again' },
          202,
        );
      }
      return json({
        can_start: world.blocker === undefined || world.blocker === null,
        blocker: world.blocker ?? null,
        ceiling_usd: 2,
        last_discovery: {
          task_id: TASK,
          state: 'done',
          cost_usd: 0.84,
          findings_unrecorded:
            world.unrecorded === undefined
              ? null
              : { at: '2026-09-13T05:00:00.000Z', reason: world.unrecorded },
          escalation: null,
        },
      });
    }
    if (url.includes('/readiness')) {
      return json({
        level: 1,
        evaluated_at: '2026-09-13T04:00:00.000Z',
        source: 'rediscovery',
        criteria: [],
        next_improvements: [],
      });
    }
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    if (url.includes('/bindings')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  started = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/projects/acme_api/settings');
});

const button = async (): Promise<HTMLButtonElement> =>
  (await screen.findByRole('button', { name: /Re-evaluate readiness/ })) as HTMLButtonElement;

describe('the re-evaluate control', () => {
  it('shows the server’s ceiling and the last discovery’s cost before anything is started', async () => {
    render(createApp({ fetchImpl: fetchFor(), realtime: false }).element);
    expect((await button()).textContent).toContain('up to $2.00');
    expect(
      screen.getByText(/the run’s budget cap, not a prediction; the last discovery cost \$0\.84/),
    ).toBeTruthy();
    // The evaluation shown names who recorded it.
    expect(await screen.findByText('a re-evaluation')).toBeTruthy();
    expect(started).toEqual([]);
  });

  it('sends one keyed command when pressed, and shows what the server said', async () => {
    render(createApp({ fetchImpl: fetchFor(), realtime: false }).element);
    fireEvent.click(await button());
    await waitFor(() => {
      expect(started).toHaveLength(1);
    });
    expect(started[0]?.url).toContain(`/api/projects/${PROJECT}/rediscovery`);
    expect(started[0]?.key).toBeTruthy();
    expect(await screen.findByText('the Discovery agent is queued again')).toBeTruthy();
  });

  it('disables the button and states the reason, as text, for a project that may not start one', async () => {
    render(
      createApp({
        fetchImpl: fetchFor({
          blocker: { code: 'discovery_in_flight', detail: HOSTILE, task_id: TASK },
        }),
        realtime: false,
      }).element,
    );
    const control = await button();
    expect(control.disabled).toBe(true);
    expect(await screen.findByText(HOSTILE)).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    fireEvent.click(control);
    expect(started).toEqual([]);
  });

  it('shows the server’s refusal when the caller’s role may not run it (403)', async () => {
    render(createApp({ fetchImpl: fetchFor({ refuse: true }), realtime: false }).element);
    fireEvent.click(await button());
    expect(await screen.findByText('Discovery was not run again.')).toBeTruthy();
    expect(screen.getByText(/may not do this/)).toBeTruthy();
  });

  it('says, as text, that the last discovery’s findings were never recorded (WP-124, backlog 366)', async () => {
    render(createApp({ fetchImpl: fetchFor({ unrecorded: HOSTILE }), realtime: false }).element);
    await button();
    const notice = document.querySelector('[data-findings-unrecorded="true"]');
    expect(notice?.textContent).toContain('The last discovery’s findings were never recorded');
    expect(notice?.textContent).toContain(HOSTILE);
    expect(document.querySelector('img')).toBeNull();
  });

  it('says nothing of the kind when nothing was lost (the other side)', async () => {
    render(createApp({ fetchImpl: fetchFor(), realtime: false }).element);
    await button();
    expect(document.querySelector('[data-findings-unrecorded="true"]')).toBeNull();
  });
});
