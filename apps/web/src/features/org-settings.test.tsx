/**
 * The organisation settings document on the settings page (WP-93).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are what is asserted: the screen **reads** `GET /api/org`, **writes** one section at a
 * time through `PATCH /api/org` with an `Idempotency-Key`, shows the server's refusal, and renders
 * the stored command lists and an account's name as text (BD-022).
 */
import type { CappedProject, IntegrationSummary, OrganisationSettings } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const CHAT = '00000000-0000-4000-8000-0000000000c1';

const SESSION: SessionResponse = {
  user: { id: ADMIN, email: 'operator@example.invalid', name: 'Fake Operator', role: 'admin' },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const CHAT_ACCOUNT: IntegrationSummary = {
  id: CHAT,
  type: 'communication',
  provider: 'slack',
  name: '<i>acme workspace</i>',
  config: {},
  health: { status: 'unknown', checked_at: null, detail: null },
  config_refusal: null,
  retired_at: null,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (options: {
  settings?: OrganisationSettings;
  onPatch?: (body: unknown, headers: Headers) => Response | undefined;
  /** WP-113: what the write answers it capped. */
  capped?: readonly CappedProject[];
}) => {
  let stored: OrganisationSettings = options.settings ?? {};
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/org') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const refused = options.onPatch?.(body, new Headers(init.headers));
      if (refused !== undefined) return refused;
      const next: Record<string, unknown> = { ...stored };
      for (const [key, value] of Object.entries(body)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      stored = next as OrganisationSettings;
      return json({
        settings: stored,
        changed: Object.keys(body),
        performed: true,
        capped_projects: options.capped ?? [],
      });
    }
    if (url.endsWith('/api/org')) {
      return json({ settings: stored, updated_at: '2026-09-29T08:00:00.000Z' });
    }
    if (url.endsWith('/api/integrations')) return json({ items: [CHAT_ACCOUNT] });
    if (url.endsWith('/api/org/identities/candidates')) return json({ items: [] });
    if (url.endsWith('/api/org/identities')) return json({ items: [] });
    if (url.endsWith('/api/org/users')) return json({ items: [] });
    if (url.endsWith('/api/org/budgets')) return json({ items: [] });
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/settings');
});

describe('the organisation settings document on the settings page', () => {
  it('shows what is stored, with a command list as text (BD-022)', async () => {
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({
          settings: {
            commands: { block: ['<script>rm -rf *</script>'] },
            autonomy: { maximum: 'supervised' },
          },
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Organisation settings');
    const block = (await screen.findByLabelText(
      'Organisation command block list',
    )) as HTMLTextAreaElement;
    expect(block.value).toBe('<script>rm -rf *</script>');
    expect(container.querySelector('script')).toBeNull();
    expect(
      (screen.getByLabelText('Organisation autonomy maximum') as HTMLSelectElement).value,
    ).toBe('supervised');
  });

  it('saves the autonomy maximum through PATCH /api/org, with an Idempotency-Key, and only that section', async () => {
    const patched: unknown[] = [];
    const keys: (string | null)[] = [];
    render(
      createApp({
        fetchImpl: fetchFor({
          onPatch: (body, headers) => {
            patched.push(body);
            keys.push(headers.get('idempotency-key'));
            return undefined;
          },
        }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText('Organisation autonomy maximum'),
      'assist',
    );
    await user.click(screen.getByRole('button', { name: 'Save autonomy maximum' }));
    await waitFor(() => {
      expect(patched).toEqual([{ autonomy: { maximum: 'assist' } }]);
    });
    expect(keys[0]).toMatch(/.+/);
  });

  it('says which projects a lowered maximum caps, before and after, with the key as text (WP-113)', async () => {
    render(
      createApp({
        fetchImpl: fetchFor({
          capped: [
            {
              project_id: '00000000-0000-4000-8000-0000000000a1',
              project_key: '<b>alpha</b>',
              setting: 'autonomy',
              before: 'supervised',
              after: 'assist',
            },
            {
              project_id: '00000000-0000-4000-8000-0000000000a1',
              project_key: '<b>alpha</b>',
              setting: 'pipeline.wip.max_parallel_tasks',
              before: 2,
              after: 1,
            },
          ],
        }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText('Organisation autonomy maximum'),
      'assist',
    );
    await user.click(screen.getByRole('button', { name: 'Save autonomy maximum' }));
    const list = await screen.findByRole('list', { name: 'Projects this change caps' });
    expect(list.textContent).toContain('<b>alpha</b> — autonomy level supervised → assist');
    expect(list.textContent).toContain('parallel tasks 2 → 1');
    expect(list.querySelector('b')).toBeNull();
    expect(document.body.textContent).toContain('raising the maximum again restores it');
  });

  it('says a change that lowers nothing caps nobody (WP-113)', async () => {
    render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText('Organisation autonomy maximum'),
      'supervised',
    );
    await user.click(screen.getByRole('button', { name: 'Save autonomy maximum' }));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'This change lowers no project’s value in force.',
      );
    });
  });

  it('saves quiet hours and flags the default chat account, whose name renders as text', async () => {
    const patched: unknown[] = [];
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({
          onPatch: (body) => {
            patched.push(body);
            return undefined;
          },
        }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Quiet from'), '22:00');
    await user.type(screen.getByLabelText('Quiet until'), '07:00');
    await user.selectOptions(screen.getByLabelText('Organisation default chat account'), CHAT);
    await user.click(screen.getByRole('button', { name: 'Save notifications' }));
    await waitFor(() => {
      expect(patched).toEqual([
        {
          notifications: {
            quiet_hours: { from: '22:00', to: '07:00' },
            organisation_default: CHAT,
          },
        },
      ]);
    });
    expect(container.textContent).toContain('<i>acme workspace</i>');
    expect(container.querySelector('p i')).toBeNull();
  });

  it('removes the command maximum when every list is empty, and saves the WIP maximum as numbers', async () => {
    const patched: unknown[] = [];
    render(
      createApp({
        fetchImpl: fetchFor({
          settings: { commands: { allow: ['git status'] } },
          onPatch: (body) => {
            patched.push(body);
            return undefined;
          },
        }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Organisation command allow list'));
    await user.click(screen.getByRole('button', { name: 'Save command maximum' }));
    await waitFor(() => {
      expect(patched).toEqual([{ commands: null }]);
    });
    await user.type(await screen.findByLabelText('Parallel tasks'), '3');
    await user.click(screen.getByRole('button', { name: 'Save WIP maximum' }));
    await waitFor(() => {
      expect(patched[1]).toEqual({ pipeline: { wip: { max_parallel_tasks: 3 } } });
    });
  });

  it('shows the server’s refusal when the caller may not write it', async () => {
    render(
      createApp({
        fetchImpl: fetchFor({
          onPatch: () =>
            json(
              { error: { code: 'forbidden', message: 'org.settings.write needs the admin role' } },
              403,
            ),
        }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText('Organisation autonomy maximum'),
      'observe',
    );
    await user.click(screen.getByRole('button', { name: 'Save autonomy maximum' }));
    await screen.findByText('The organisation settings were not saved.');
  });
});
