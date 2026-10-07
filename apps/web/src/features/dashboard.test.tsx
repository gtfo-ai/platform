/**
 * One broken organisation account, named once (WP-157 (a), PROGRESS backlog 413).
 *
 * A communication account whose credentials will not decrypt withholds the prompt files of every
 * project. Before WP-157 the only signals were per project; the dashboard now renders exactly one
 * banner for it however many projects there are, none when it decrypts, and nothing — not even
 * the request — for a role that cannot read integrations. Driven through `createApp` with a fake
 * server, so the real endpoint parser (`integrationSummarySchema`, strict) reads the DTO.
 */
import type { IntegrationSummary, UserRole } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const CONSEQUENCE =
  'Its credentials cannot be decrypted (a changed APP_SECRET_KEY or a damaged secrets row), so the prompt files of every project are withheld: each repository reading stores the configuration and none of .agentic/prompts/ until the credentials are re-sealed or the account is retired.';

const session = (role: UserRole): SessionResponse => ({
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role,
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
});

const account = (readable: boolean | null): IntegrationSummary => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  type: 'communication',
  provider: 'slack',
  name: '<b>acme workspace</b>',
  config: {},
  health: { status: 'unknown', checked_at: null, detail: null },
  config_refusal: null,
  retired_at: null,
  credentials_readable: readable,
  credentials_consequence: readable === false ? CONSEQUENCE : null,
});

const project = (n: number) => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
  key: `p${n}`,
  name: `Project ${n}`,
  repo_url: `https://git.example.invalid/acme/p${n}.git`,
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
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (options: {
  readonly role: UserRole;
  readonly integrations: readonly IntegrationSummary[];
  readonly projects: number;
  readonly asked?: string[];
}) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    options.asked?.push(url);
    if (url.includes('/api/auth/get-session')) return json(session(options.role));
    if (url.endsWith('/api/integrations')) return json({ items: options.integrations });
    if (url.endsWith('/api/projects')) {
      return json({
        items: Array.from({ length: options.projects }, (_, index) => project(index + 1)),
      });
    }
    if (url.endsWith('/api/org/agents')) return json({ items: [] });
    if (url.endsWith('/api/org/inbox')) return json({ questions: [], approvals: [] });
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/');
});

describe('the dashboard and a broken organisation account (WP-157 (a), backlog 413)', () => {
  it('renders exactly one banner for one undecryptable account, whatever the project count', async () => {
    for (const projects of [1, 5]) {
      const { container, unmount } = render(
        createApp({
          fetchImpl: fetchFor({ role: 'maintainer', integrations: [account(false)], projects }),
          realtime: false,
        }).element,
      );
      await screen.findByText(`Project ${projects}`);
      await waitFor(() => {
        expect(container.querySelectorAll('[data-unreadable-accounts]')).toHaveLength(1);
      });
      const banner = container.querySelector('[data-unreadable-accounts]');
      // The account is named, as text (BD-022), with the consequence the server wrote.
      expect(banner?.textContent).toContain('<b>acme workspace</b> (slack)');
      expect(banner?.textContent).toContain('the prompt files of every project are withheld');
      expect(container.querySelector('b')).toBeNull();
      // One signal, not one per project card.
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
      unmount();
    }
  });

  it('renders none when the account decrypts, or when the read did not check it', async () => {
    for (const readable of [true, null]) {
      const asked: string[] = [];
      const { container, unmount } = render(
        createApp({
          fetchImpl: fetchFor({
            role: 'admin',
            integrations: [account(readable)],
            projects: 3,
            asked,
          }),
          realtime: false,
        }).element,
      );
      await screen.findByText('Project 3');
      // The list was read, so the absence below is an answer and not a pending query.
      await waitFor(() => {
        expect(asked.some((url) => url.endsWith('/api/integrations'))).toBe(true);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(container.querySelector('[data-unreadable-accounts]')).toBeNull();
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      unmount();
    }
  });

  it('does not ask a role that cannot read integrations', async () => {
    const asked: string[] = [];
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({
          role: 'member',
          integrations: [account(false)],
          projects: 2,
          asked,
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Project 2');
    expect(container.querySelector('[data-unreadable-accounts]')).toBeNull();
    expect(asked.some((url) => url.endsWith('/api/integrations'))).toBe(false);
  });
});
