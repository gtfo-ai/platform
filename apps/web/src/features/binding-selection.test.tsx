/**
 * The bindings selection never unbinds unasked (S-23.21, the final UX audit's § 0 item 1).
 *
 * `PUT /api/projects/:id/bindings` replaces the whole set, and the wizard's *Connect* step started
 * its selection at empty: binding the tracker and then the git host in a second press unbound the
 * tracker, and "Bind 0 integrations" unbound everything. Both screens that edit the set — the
 * wizard and the project settings' *Connections* — are driven here through `createApp` against a
 * fake server that **keeps** what it was sent, so the second save is answered from the first.
 */
import type {
  IntegrationSummary,
  ProjectBindingSummary,
  ProjectSummary,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1';
const TRACKER = '00000000-0000-4000-8000-0000000000d2';
const GIT = '00000000-0000-4000-8000-0000000000d3';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const PROJECT_ROW: ProjectSummary = {
  id: PROJECT,
  key: 'demo_bindings',
  name: 'Demo bindings',
  repo_url: 'https://git.example.test/demo/bindings.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 1,
  status: 'active',
  created_at: '2026-11-05T04:00:00.000Z',
  updated_at: '2026-11-05T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const integration = (
  id: string,
  type: IntegrationSummary['type'],
  provider: string,
  name: string,
): IntegrationSummary => ({
  id,
  type,
  provider,
  name,
  config: {},
  health: { status: 'ok', checked_at: null, detail: null },
  config_refusal: null,
  retired_at: null,
  credentials_readable: null,
  credentials_consequence: null,
  activity: { last_call: null, last_delivery_at: null },
  current_health: { status: 'never_checked', basis: null, at: null },
  used_by: [],
});

const INTEGRATIONS: readonly IntegrationSummary[] = [
  integration(TRACKER, 'task_management', 'jira-cloud', 'Tracker (fake)'),
  integration(GIT, 'git', 'gitlab', 'Git host (fake)'),
];

/** Bound to the project but not offered by the picker (retired, or not readable for this role). */
const UNLISTED = integration(
  '00000000-0000-4000-8000-0000000000d4',
  'communication',
  'slack',
  'Chat (unlisted)',
);

const bindingOf = (id: string, config: Record<string, unknown> = {}): ProjectBindingSummary => {
  const found = [...INTEGRATIONS, UNLISTED].find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`no fixture integration ${id}`);
  }
  return {
    integration_id: id,
    type: found.type,
    provider: found.provider,
    name: found.name,
    config,
  };
};

interface PutBody {
  readonly items: readonly { readonly integration_id: string; readonly config?: unknown }[];
}

interface World {
  bindings: ProjectBindingSummary[];
  readonly puts: PutBody[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server that stores the set a PUT sends — the replace semantics of `PUT …/bindings`. */
const server = (state: World): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (method === 'PUT' && url.endsWith(`/api/projects/${PROJECT}/bindings`)) {
      const body = JSON.parse(String(init?.body)) as PutBody;
      state.puts.push(body);
      state.bindings = body.items.map((item) =>
        bindingOf(item.integration_id, (item.config ?? {}) as Record<string, unknown>),
      );
      return json({ items: state.bindings });
    }
    if (url.endsWith(`/api/projects/${PROJECT}/bindings`)) return json({ items: state.bindings });
    if (url.endsWith('/api/projects')) return json({ items: [PROJECT_ROW] });
    if (url.endsWith('/api/integrations')) return json({ items: INTEGRATIONS });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

const SCREENS = {
  'the New project wizard’s Connect step': `/onboarding?project=${PROJECT_ROW.key}&step=connect`,
  'the project settings’ Connections section': `/projects/${PROJECT_ROW.key}/settings/connections`,
} as const;

/** The checkbox of one integration, once the picker lists it (settings' label adds the kind). */
const checkbox = async (name: string): Promise<HTMLInputElement> =>
  (await screen.findByRole(
    'checkbox',
    { name: (accessible) => accessible.startsWith(name) },
    { timeout: 5_000 },
  )) as HTMLInputElement;

const putIds = (body: PutBody | undefined): readonly string[] =>
  (body?.items ?? []).map((item) => item.integration_id).sort();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each(Object.entries(SCREENS))('%s', (_screen, path) => {
  const open = (state: World): void => {
    window.history.pushState({}, '', path);
    render(createApp({ fetchImpl: server(state), realtime: false }).element);
  };

  it('binds the tracker, then the git host, and the second save carries both', async () => {
    const state: World = { bindings: [], puts: [] };
    open(state);
    const user = userEvent.setup();
    await user.click(await checkbox('Tracker (fake)'));
    await user.click(screen.getByRole('button', { name: 'Save 1 connection' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(putIds(state.puts[0])).toEqual([TRACKER]);
    // Re-seeded from the read the save invalidated: the tracker stays checked, nothing to save.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'No changes to save' })).toBeTruthy(),
    );
    expect((await checkbox('Tracker (fake)')).checked).toBe(true);
    await user.click(await checkbox('Git host (fake)'));
    // Enabled once the first save's follow-up reads are done (the mutation is pending until then).
    const second = await waitFor(() => {
      const button = screen.getByRole('button', { name: 'Save 2 connections' });
      expect((button as HTMLButtonElement).disabled).toBe(false);
      return button;
    });
    await user.click(second);
    await waitFor(() => expect(state.puts).toHaveLength(2));
    expect(putIds(state.puts[1])).toEqual([TRACKER, GIT].sort());
  });

  it('starts at the stored bindings, and an unchanged selection cannot be saved', async () => {
    const state: World = { bindings: [bindingOf(TRACKER), bindingOf(GIT)], puts: [] };
    open(state);
    await waitFor(async () => expect((await checkbox('Tracker (fake)')).checked).toBe(true));
    expect((await checkbox('Git host (fake)')).checked).toBe(true);
    const save = screen.getByRole('button', { name: 'No changes to save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Unchecking and checking again is no change either.
    const user = userEvent.setup();
    await user.click(await checkbox('Git host (fake)'));
    await user.click(await checkbox('Git host (fake)'));
    expect(
      (screen.getByRole('button', { name: 'No changes to save' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(state.puts).toHaveLength(0);
  });

  it('asks before removing a connection, names what stops, and only then sends the set without it', async () => {
    const state: World = {
      bindings: [bindingOf(TRACKER, { lifecycle: { claim: false } }), bindingOf(GIT)],
      puts: [],
    };
    open(state);
    const user = userEvent.setup();
    await waitFor(async () => expect((await checkbox('Git host (fake)')).checked).toBe(true));
    await user.click(await checkbox('Git host (fake)'));
    await user.click(screen.getByRole('button', { name: 'Remove the git host connection' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove Git host (fake)?')).toBeTruthy();
    expect(dialog.querySelector(`[data-removed-binding="${GIT}"]`)?.textContent).toContain(
      'no task reaches a merge request',
    );
    expect(state.puts).toHaveLength(0);
    // Cancel sends nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.puts).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Remove the git host connection' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove connection' }),
    );
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0]?.items).toEqual([
      { integration_id: TRACKER, config: { lifecycle: { claim: false } } },
    ]);
  });
  it('keeps a stored binding the picker does not list through a save', async () => {
    const state: World = {
      bindings: [bindingOf(UNLISTED.id, { channel: '#delivery' })],
      puts: [],
    };
    open(state);
    const user = userEvent.setup();
    await user.click(await checkbox('Tracker (fake)'));
    expect(screen.queryByRole('checkbox', { name: /Chat \(unlisted\)/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save 2 connections' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(state.puts[0]?.items).toEqual([
      { integration_id: UNLISTED.id, config: { channel: '#delivery' } },
      // The wizard adds the tracker's default lifecycle block; the settings page sends none.
      expect.objectContaining({ integration_id: TRACKER }),
    ]);
  });

  it('labels a save that adds and removes with both, and says "them" for two removals', async () => {
    const state: World = { bindings: [bindingOf(TRACKER)], puts: [] };
    open(state);
    const user = userEvent.setup();
    await waitFor(async () => expect((await checkbox('Tracker (fake)')).checked).toBe(true));
    await user.click(await checkbox('Tracker (fake)'));
    await user.click(await checkbox('Git host (fake)'));
    await user.click(screen.getByRole('button', { name: 'Save 1 connection, remove 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The project stops using it as soon as you confirm.');
    await user.click(within(dialog).getByRole('button', { name: 'Remove connection' }));
    await waitFor(() => expect(state.puts).toHaveLength(1));
    expect(putIds(state.puts[0])).toEqual([GIT]);
    cleanup();
    open({ bindings: [bindingOf(TRACKER), bindingOf(GIT)], puts: [] });
    await waitFor(async () => expect((await checkbox('Git host (fake)')).checked).toBe(true));
    await user.click(await checkbox('Tracker (fake)'));
    await user.click(await checkbox('Git host (fake)'));
    await user.click(screen.getByRole('button', { name: 'Remove 2 connections' }));
    const both = await screen.findByRole('dialog');
    expect(both.textContent).toContain('The project stops using them as soon as you confirm.');
    expect(both.textContent).toContain('The integrations themselves are kept');
  });
});
