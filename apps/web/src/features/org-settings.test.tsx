/**
 * The organisation settings document on the settings pages (WP-93; two pages since S-23.11b).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are what is asserted: the *Policies* and *Notifications* pages **read** `GET /api/org`,
 * each **writes** through `PATCH /api/org` with an `Idempotency-Key` from its one Save — sending
 * only the sections whose draft differs from what is stored — shows the server's refusal, and
 * renders the stored command lists and an account's name as text (BD-022).
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
  credentials_readable: null,
  credentials_consequence: null,
  activity: { last_call: null, last_delivery_at: null },
  current_health: { status: 'never_checked', basis: null, at: null },
  used_by: [],
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

/**
 * WP-122 (PROGRESS backlog 388): a live and a retired integration, for the picker case. The retired
 * one's name is a sentence a test can search for, so its absence is a fact about this screen.
 */
const pickerIntegrations = {
  items: [
    {
      id: '00000000-0000-4000-8000-0000000000f1',
      type: 'communication',
      provider: 'slack',
      name: 'Live workspace',
      config: {},
      health: { status: 'unknown', checked_at: null, detail: null },
      config_refusal: null,
      retired_at: null,
      credentials_readable: null,
      credentials_consequence: null,
      activity: { last_call: null, last_delivery_at: null },
      current_health: { status: 'never_checked', basis: null, at: null },
      used_by: [],
    },
    {
      id: '00000000-0000-4000-8000-0000000000f2',
      type: 'communication',
      provider: 'slack',
      name: 'Retired workspace',
      config: {},
      health: { status: 'unknown', checked_at: null, detail: null },
      config_refusal: null,
      retired_at: '2026-09-30T09:00:00.000Z',
      credentials_readable: null,
      credentials_consequence: null,
      activity: { last_call: null, last_delivery_at: null },
      current_health: { status: 'never_checked', basis: null, at: null },
      used_by: [],
    },
  ],
};

/** The screen's own fake server, with `GET /api/integrations` answering the picker fixture. */
const withPickerIntegrations =
  (base: typeof fetch): typeof fetch =>
  async (input, init) =>
    String(input).endsWith('/api/integrations') ? json(pickerIntegrations) : base(input, init);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/settings/policies');
});

const SAVE_POLICIES = { name: 'Save policies' } as const;

describe('the organisation settings document on the settings pages', () => {
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
    await screen.findByRole('heading', { name: 'Policies' });
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
    // One Save for three sections (S-23.11b): the commands and the WIP maximum were not touched,
    // so they are not in the body — a PATCH replaces each section it names.
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
    await user.click(screen.getByRole('button', SAVE_POLICIES));
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
    await user.click(screen.getByRole('button', SAVE_POLICIES));
    const list = await screen.findByRole('list', { name: 'Projects this change caps' });
    expect(list.textContent).toContain('<b>alpha</b> — autonomy level Supervised → Assist');
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
    await user.click(screen.getByRole('button', SAVE_POLICIES));
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        'This change lowers no project’s value in force.',
      );
    });
  });

  it('leaves a retired account out of the default chat account picker (WP-122)', async () => {
    window.history.pushState({}, '', '/settings/notifications');
    render(createApp({ fetchImpl: withPickerIntegrations(fetchFor({})), realtime: false }).element);
    const picker = (await screen.findByLabelText(
      'Organisation default chat account',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect([...picker.options].map((option) => option.textContent)).toContain('Live workspace');
    });
    expect([...picker.options].map((option) => option.textContent)).not.toContain(
      'Retired workspace',
    );
  });

  it('saves quiet hours and flags the default chat account, whose name renders as text', async () => {
    window.history.pushState({}, '', '/settings/notifications');
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
    await user.click(screen.getByRole('button', SAVE_POLICIES));
    await waitFor(() => {
      expect(patched).toEqual([{ commands: null }]);
    });
    // Read back: the emptied lists are now what the server holds, so they are no longer a change.
    await screen.findByText('Nothing has changed.');
    await user.type(await screen.findByLabelText('Parallel tasks'), '3');
    await user.click(screen.getByRole('button', SAVE_POLICIES));
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
    await user.click(screen.getByRole('button', SAVE_POLICIES));
    await screen.findByText('The organisation settings were not saved.');
  });
});

describe('one Save per settings page (S-23.11b)', () => {
  it('sends every section that changed in one PATCH, and none that did not', async () => {
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
    await user.selectOptions(
      await screen.findByLabelText('Organisation autonomy maximum'),
      'supervised',
    );
    await user.type(screen.getByLabelText('Tasks in the pipeline'), '8');
    await user.click(screen.getByRole('button', SAVE_POLICIES));
    await waitFor(() => {
      expect(patched).toEqual([
        {
          autonomy: { maximum: 'supervised' },
          pipeline: { wip: { max_tasks_in_pipeline: 8 } },
        },
      ]);
    });
  });

  it('offers no Save until something has changed, and says so', async () => {
    render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    const save = (await screen.findByRole('button', SAVE_POLICIES)) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText('Nothing has changed.')).toBeTruthy();
    // …and the other direction: one edit enables it.
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Organisation autonomy maximum'), 'observe');
    expect(save.disabled).toBe(false);
    expect(screen.queryByText('Nothing has changed.')).toBeNull();
  });

  it('shows the server’s refusal of a notifications save', async () => {
    window.history.pushState({}, '', '/settings/notifications');
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
    await user.type(await screen.findByLabelText('Digest at'), '09:00');
    await user.click(screen.getByRole('button', { name: 'Save notifications' }));
    await screen.findByText('The organisation settings were not saved.');
    expect(document.body.textContent).toContain('org.settings.write needs the admin role');
  });
});
