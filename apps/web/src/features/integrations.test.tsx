/**
 * The Integrations list and one integration's page (S-23.11a), driven through `createApp` with a
 * fake server so the real router, query client and endpoint parsers are asserted.
 *
 * Every command the old cards carried is still pressed here and still produces its request — the
 * probe, the `PATCH` a `config_refusal` names (WP-100), the re-seal and the retire (WP-114) — now
 * through each row's `···` and a dialog, which is the one interaction step TD-033's consequences
 * budget per moved control. The create moved to the wizard (`integration-wizard.test.tsx`).
 * Labels changed deliberately where a config key became a human label: `poll_enabled` is *Poll for
 * changes*, `api_token` is *API token*, and each key is still named in its control's hint.
 */
import type { IntegrationSummary, IntegrationsResponse } from '@platform/contracts';
import {
  configIssuesOf,
  findShippedProvider,
  type ProviderCatalogueEntry,
  SHIPPED_PROVIDERS,
  toIntegrationProvider,
} from '@platform/integrations';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000000d1';
const PROJECT = '00000000-0000-4000-8000-0000000000e1';
const NOW = Date.parse('2026-10-01T09:05:00.000Z');

/** Annotated rather than bare — PROGRESS backlog 93, closed by WP-38. */
const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const JIRA: IntegrationSummary = {
  id: INTEGRATION,
  type: 'task_management',
  provider: 'jira-cloud',
  name: 'ACME Jira',
  config: { site_url: 'https://acme.atlassian.example.test', user_email: 'ops@example.test' },
  health: { status: 'unknown', checked_at: null, detail: null },
  config_refusal: null,
  retired_at: null,
  credentials_readable: null,
  credentials_consequence: null,
};

const INTEGRATIONS: IntegrationsResponse = { items: [JIRA] };

/**
 * `GET /api/integrations/providers` as the server answers it — built from the **real** catalogue
 * through the server's own projection (`toIntegrationProvider`), so the forms are driven with the
 * fields the shipped providers actually declare rather than a copy (WP-100, criterion 2).
 */
const PROVIDERS = { items: SHIPPED_PROVIDERS.map(toIntegrationProvider) };

/** The setup guide as the server answers it: the guide's text and the URL built from `APP_BASE_URL`. */
const WEBHOOK_URL = `https://agentic.example.test/webhooks/jira-cloud/${INTEGRATION}`;
const GUIDE = {
  provider: 'jira-cloud',
  title: 'Jira Cloud',
  markdown: 'Create a webhook in Jira and paste the URL shown above.',
  webhook_url: WEBHOOK_URL,
};

const PROJECT_ROW = {
  id: PROJECT,
  key: 'acme',
  name: 'Acme service',
  repo_url: 'https://git.example.invalid/acme/service.git',
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: 'knowledge',
  autonomy_level: 'supervised',
  readiness_level: 2,
  status: 'active',
  created_at: '2026-06-01T09:00:00.000Z',
  updated_at: '2026-06-01T09:00:00.000Z',
  open_tasks: 1,
  spent_usd_30d: 0,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly body: unknown;
}

interface World {
  items?: IntegrationSummary[];
  /** Projects and the integrations each binds; none by default. */
  bound?: readonly string[];
}

const recorder = (world: World = {}) => {
  const sent: Sent[] = [];
  const items = world.items ?? INTEGRATIONS.items;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const headers = new Headers(init?.headers);
      sent.push({
        url,
        method,
        key: headers.get('Idempotency-Key'),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      if (url.includes('/test')) {
        return json({ ok: true, checks: [{ name: 'auth', ok: true, detail: 'reachable' }] });
      }
      if (url.endsWith('/secrets')) {
        return json({ integration: items[0], sealed_fields: ['api_token'], performed: true });
      }
      if (method === 'DELETE') {
        return json({
          integration: { ...items[0], retired_at: '2026-10-01T09:00:00.000Z' },
          destroyed_secrets: 1,
          performed: true,
        });
      }
      if (method === 'PATCH') {
        return json({ ...items[0], config_refusal: null });
      }
      return json({ id: INTEGRATION, provider: 'jira-cloud', name: 'ACME Jira' });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/integrations')) return json({ items });
    if (url.endsWith('/api/integrations/providers')) return json(PROVIDERS);
    if (url.endsWith(`/api/integrations/${INTEGRATION}/setup-guide`)) return json(GUIDE);
    if (url.endsWith(`/api/integrations/${INTEGRATION}/refused-deliveries`)) {
      return json({
        items: [
          {
            delivery_id: 'jira:delivery-1',
            received_at: '2026-10-01T08:00:00.000Z',
            error: 'unmapped_identity: <b>U123</b>',
            reasons: ['unmapped_identity'],
            unmapped: [{ provider: 'slack', external_id: 'U123' }],
          },
        ],
      });
    }
    if (url.endsWith('/api/projects')) {
      return json({ items: world.bound === undefined ? [] : [PROJECT_ROW] });
    }
    if (url.endsWith(`/api/projects/${PROJECT}/bindings`)) {
      return json({
        items: (world.bound ?? []).map((integrationId) => ({
          integration_id: integrationId,
          type: 'task_management',
          provider: 'jira-cloud',
          name: 'ACME Jira',
          config: {},
        })),
      });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  return { sent, fetchImpl };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/integrations');
});

const renderApp = (fetchImpl: typeof fetch) =>
  render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);

/** Open a row's `···` and choose one of its items. */
const choose = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  item: string,
): Promise<void> => {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
};

// Six titles below are cited by name in PROGRESS.md (frozen history, `scripts/citations.test.ts`), so
// they keep their words although a card became a row, a tab or a dialog: "says on the card…",
// "offers an optional boolean…", "changes an optional boolean…", "retires after a confirmation…",
// "lists a retired integration…" and "shows the webhook URL on the setup-guide card…".
describe('the integrations list', () => {
  it('lists a row with its health, provider, kind, last check and bindings, under one primary', async () => {
    const { container } = renderApp(recorder({ bound: [INTEGRATION] }).fetchImpl);
    const list = await screen.findByRole('list', { name: 'Integrations' });
    const row = within(list).getByRole('link', { name: 'ACME Jira' }).closest('li');
    expect(row?.textContent).toContain('Jira Cloud');
    expect(row?.textContent).toContain('Ticket tracker');
    expect(row?.textContent).toContain('never checked');
    // Words, never the raw enum.
    expect(row?.textContent).toContain('Not checked');
    expect(row?.textContent).not.toContain('task_management');
    expect(row?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Not checked');
    await waitFor(() => {
      expect(row?.textContent).toContain('Bound to 1 project');
    });
    // The row is the way into its own page.
    expect(within(list).getByRole('link', { name: 'ACME Jira' }).getAttribute('href')).toBe(
      `/integrations/${INTEGRATION}`,
    );
    // One primary action on the page: New integration, to the wizard.
    const primaries = [...container.querySelectorAll('a, button')].filter((element) =>
      element.className.includes('border-primary-line'),
    );
    expect(primaries.map((element) => element.textContent)).toEqual(['New integration']);
    expect(primaries[0]?.getAttribute('href')).toBe('/integrations/new');
  });

  it('says when it was checked, in the row’s own units', async () => {
    const checked: IntegrationSummary = {
      ...JIRA,
      health: { status: 'ok', checked_at: '2026-10-01T09:00:00.000Z', detail: null },
    };
    renderApp(recorder({ items: [checked] }).fetchImpl);
    const list = await screen.findByRole('list', { name: 'Integrations' });
    expect(list.textContent).toContain('checked 5 m ago');
    expect(list.textContent).toContain('Healthy');
    // No project read answered with a project, so it is bound to none.
    await waitFor(() => {
      expect(list.textContent).toContain('Not bound');
    });
  });

  it('tests a connection from the row’s menu and draws the provider’s words under the row', async () => {
    const { sent, fetchImpl } = recorder();
    const { container } = renderApp(fetchImpl);
    await choose(userEvent.setup(), 'ACME Jira', 'Test connection');
    await waitFor(() => {
      expect(
        sent.some((entry) => entry.url.includes(`/api/integrations/${INTEGRATION}/test`)),
      ).toBe(true);
    });
    expect(await screen.findByText('Last test: passed')).toBeTruthy();
    const result = container.querySelector(`[data-connection-test-for="${INTEGRATION}"]`);
    expect(result?.textContent).toContain('reachable');
    // The check's name is said in words.
    expect(result?.textContent).toContain('Auth');
  });

  /**
   * WP-157 (a), PROGRESS backlog 413: an organisation account whose credentials will not decrypt
   * says so on its own row, once, with the consequence the server wrote; a readable or unchecked
   * one says nothing.
   */
  it('says on the card that an organisation account’s credentials cannot be decrypted, and nothing otherwise', async () => {
    const chat = (id: string, name: string, readable: boolean | null): IntegrationSummary => ({
      id,
      type: 'communication',
      provider: 'slack',
      name,
      config: {},
      health: { status: 'unknown', checked_at: null, detail: null },
      config_refusal: null,
      retired_at: null,
      credentials_readable: readable,
      credentials_consequence:
        readable === false ? 'the prompt files of every project are withheld' : null,
    });
    renderApp(
      recorder({
        items: [
          chat('00000000-0000-4000-8000-0000000000b1', 'Broken chat', false),
          chat('00000000-0000-4000-8000-0000000000b2', 'Readable chat', true),
          chat('00000000-0000-4000-8000-0000000000b3', 'Unchecked chat', null),
        ],
      }).fetchImpl,
    );
    expect(await screen.findByText('Readable chat')).toBeTruthy();
    const notices = document.querySelectorAll('[data-credentials-unreadable]');
    expect(
      [...notices].map((notice) => notice.getAttribute('data-credentials-unreadable')),
    ).toEqual(['00000000-0000-4000-8000-0000000000b1']);
    expect(notices[0]?.textContent).toContain('the prompt files of every project are withheld');
  });

  /**
   * WP-100, criterion 4 on the screen: a stored row that would not load says so on its row, and
   * *Edit configuration* sends the `PATCH` the refusal names — the required field set, and the key
   * the provider does not declare removed.
   */
  it('shows a stored configuration’s refusal and repairs it with the PATCH it names', async () => {
    const sentry = findShippedProvider('sentry') as ProviderCatalogueEntry;
    const broken: IntegrationSummary = {
      ...JIRA,
      type: 'errors',
      provider: 'sentry',
      name: 'ACME Sentry',
      config: { organisation: 'acme', base_url: 'https://sentry.example.test' },
      config_refusal: {
        code: 'invalid_integration_config',
        message: `integration ${INTEGRATION} has configuration that provider "sentry"'s schema refuses at: organisation, organization. Correct it with PATCH /api/integrations/${INTEGRATION}`,
        paths: ['organisation', 'organization'],
      },
    };
    const { sent, fetchImpl } = recorder({ items: [broken] });
    renderApp(fetchImpl);
    expect(await screen.findByText('This configuration would not load.')).toBeTruthy();
    expect(document.body.textContent).toContain(`PATCH /api/integrations/${INTEGRATION}`);
    const user = userEvent.setup();
    await choose(user, 'ACME Sentry', 'Edit configuration');
    const dialog = await screen.findByRole('dialog', {
      name: 'Edit the configuration of ACME Sentry',
    });
    // The human label, with the key in its hint.
    const field = within(dialog).getByLabelText('Organization');
    expect(field.getAttribute('data-config-key')).toBe('organization');
    expect(dialog.textContent).toContain('Key: organization.');
    fireEvent.change(field, { target: { value: 'acme' } });
    expect(document.querySelector('[data-config-remove]')?.textContent).toContain('organisation');
    await user.click(within(dialog).getByRole('button', { name: 'Save configuration' }));

    await waitFor(() => {
      expect(sent.some((each) => each.method === 'PATCH')).toBe(true);
    });
    const patch = sent.find((each) => each.method === 'PATCH');
    expect(patch?.url).toMatch(new RegExp(`/api/integrations/${INTEGRATION}$`));
    expect(patch?.body).toEqual({ config: { organization: 'acme' }, remove: ['organisation'] });
    // The document the PATCH leaves behind parses (the base_url is kept: it is not named).
    expect(
      configIssuesOf(sentry, { base_url: 'https://sentry.example.test', organization: 'acme' }),
    ).toEqual([]);
    // A saved configuration closes its dialog.
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('changes an optional boolean through Edit configuration and sends only what changed', async () => {
    const jira: IntegrationSummary = {
      ...JIRA,
      config: { ...JIRA.config, pickup_label: 'agentic' },
    };
    const { sent, fetchImpl } = recorder({ items: [jira] });
    renderApp(fetchImpl);
    const user = userEvent.setup();
    await choose(user, 'ACME Jira', 'Edit configuration');
    const form = await screen.findByRole('form', { name: 'Configuration of ACME Jira' });
    // `poll_enabled` is a yes/no choice under its human label; its values are still sent typed.
    const poll = within(form).getByLabelText('Poll for changes') as HTMLSelectElement;
    expect(poll.getAttribute('data-config-key')).toBe('poll_enabled');
    expect([...poll.options].map((option) => [option.value, option.textContent])).toEqual([
      ['', 'Provider default'],
      ['true', 'Yes'],
      ['false', 'No'],
    ]);
    fireEvent.change(poll, { target: { value: 'false' } });
    fireEvent.change(within(form).getByLabelText('Pickup label'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => {
      expect(sent.some((each) => each.method === 'PATCH')).toBe(true);
    });
    expect(sent.find((each) => each.method === 'PATCH')?.body).toEqual({
      config: {
        site_url: 'https://acme.atlassian.example.test',
        user_email: 'ops@example.test',
        poll_enabled: false,
      },
      // A stored optional value the operator cleared is removed; untouched ones are not sent.
      remove: ['pickup_label'],
    });
  });

  /**
   * WP-114, PROGRESS backlog 332: each optional field is a control of its declared type, and what
   * it sends is typed — a boolean as a boolean, a number as a number, a list as a list. (The same
   * holds in the wizard's *Optional settings*, `integration-wizard.test.tsx`.)
   */
  it('offers an optional boolean as a typed control and sends a boolean', async () => {
    const { sent, fetchImpl } = recorder();
    renderApp(fetchImpl);
    const user = userEvent.setup();
    await choose(user, 'ACME Jira', 'Edit configuration');
    const form = await screen.findByRole('form', { name: 'Configuration of ACME Jira' });
    const poll = within(form).getByLabelText('Poll for changes');
    expect(poll.tagName).toBe('SELECT');
    expect(poll.getAttribute('data-config-kind')).toBe('boolean');
    fireEvent.change(poll, { target: { value: 'true' } });
    fireEvent.change(within(form).getByLabelText('Poll interval (seconds)'), {
      target: { value: '120' },
    });
    fireEvent.change(within(form).getByLabelText('Project keys'), {
      target: { value: 'ACME, OPS ,' },
    });
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => {
      expect(sent.some((each) => each.method === 'PATCH')).toBe(true);
    });
    const body = sent.find((each) => each.method === 'PATCH')?.body as {
      config: Record<string, unknown>;
    };
    expect(body.config).toEqual({
      site_url: 'https://acme.atlassian.example.test',
      user_email: 'ops@example.test',
      poll_enabled: true,
      poll_interval_seconds: 120,
      project_keys: ['ACME', 'OPS'],
    });
    const jira = findShippedProvider('jira-cloud') as ProviderCatalogueEntry;
    expect(configIssuesOf(jira, body.config as never)).toEqual([]);
  });

  /** WP-114, PROGRESS backlog 331: the two commands, from the row's menu. */
  it('re-seals a credential by naming a new environment variable, with an Idempotency-Key', async () => {
    const { sent, fetchImpl } = recorder();
    renderApp(fetchImpl);
    const user = userEvent.setup();
    await choose(user, 'ACME Jira', 'Replace credentials');
    const dialog = await screen.findByRole('dialog', {
      name: 'Replace the credentials of ACME Jira',
    });
    const field = within(dialog).getByLabelText('New environment variable for API token');
    expect(field.getAttribute('data-secret-key')).toBe('api_token');
    fireEvent.change(field, { target: { value: 'JIRA_API_TOKEN_2026_10' } });
    await user.click(within(dialog).getByRole('button', { name: 'Re-seal credentials' }));
    await waitFor(() => {
      expect(sent.some((each) => each.url.endsWith('/secrets'))).toBe(true);
    });
    const reseal = sent.find((each) => each.url.endsWith('/secrets'));
    expect(reseal?.url).toMatch(new RegExp(`/api/integrations/${INTEGRATION}/secrets$`));
    expect(reseal?.method).toBe('POST');
    expect(reseal?.body).toEqual({ secret_refs: { api_token: 'JIRA_API_TOKEN_2026_10' } });
    expect(reseal?.key).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(await screen.findByText(/Re-sealed API token \(api_token\)/)).toBeTruthy();
  });

  it('retires after a confirmation, and shows the server’s refusal as it is', async () => {
    const { sent, fetchImpl: base } = recorder({ bound: [INTEGRATION] });
    let refuse = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE' && refuse) {
        refuse = false;
        return json(
          {
            error: {
              code: 'integration_bound',
              message: `integration ${INTEGRATION} is bound to project acme; remove it from each project's bindings first`,
            },
          },
          409,
        );
      }
      return base(input, init);
    }) as typeof fetch;
    renderApp(fetchImpl);
    const list = await screen.findByRole('list', { name: 'Integrations' });
    await waitFor(() => {
      expect(list.textContent).toContain('Bound to 1 project');
    });
    const user = userEvent.setup();
    await choose(user, 'ACME Jira', 'Retire');
    const dialog = await screen.findByRole('dialog', { name: 'Retire ACME Jira?' });
    // The consequence, before anything is sent: credentials deleted, row kept, and the binding.
    expect(dialog.textContent).toContain('credentials are deleted');
    expect(dialog.textContent).toContain('It is bound to one project');
    expect(sent.filter((each) => each.method === 'DELETE')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Retire integration' }));
    expect(await screen.findByText('The integration was not retired.')).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain('is bound to project acme');
    });
    await user.click(within(dialog).getByRole('button', { name: 'Retire integration' }));
    await waitFor(() => {
      expect(sent.filter((each) => each.method === 'DELETE')).toHaveLength(1);
    });
    expect(sent.find((each) => each.method === 'DELETE')?.url).toMatch(
      new RegExp(`/api/integrations/${INTEGRATION}$`),
    );
  });

  it('lists a retired integration as retired, with no control that writes', async () => {
    const retired: IntegrationSummary = { ...JIRA, retired_at: '2026-10-01T09:00:00.000Z' };
    const { container } = renderApp(recorder({ items: [retired] }).fetchImpl);
    await waitFor(() => {
      expect(container.querySelector(`[data-integration-retired="${INTEGRATION}"]`)).not.toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Actions for ACME Jira' })).toBeNull();
    expect(container.textContent).toContain('Retired');
    expect(container.textContent).toContain('1 retired');
  });

  /** WP-114, backlog 327's reading on this screen: only a 403 is the maintainer role. */
  it('does not name a 503 a permission problem', async () => {
    const { fetchImpl: base } = recorder();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET' && String(input).endsWith('/api/integrations')
        ? json({ error: { code: 'unavailable', message: 'the database is not answering' } }, 503)
        : base(input, init)) as typeof fetch;
    const { container } = renderApp(fetchImpl);
    // The app retries a failed read once (`app.tsx`), so the notice arrives after that retry.
    expect(
      await screen.findByText('Integrations could not be loaded.', {}, { timeout: 5_000 }),
    ).toBeTruthy();
    expect(container.textContent).not.toContain('needs the maintainer role');
    expect(container.textContent).toContain('the database is not answering');
  });

  it('offers a blankslate that leads to the wizard when there is none', async () => {
    const { container } = renderApp(recorder({ items: [] }).fetchImpl);
    expect(await screen.findByText('No integrations yet')).toBeTruthy();
    expect(container.querySelector('[data-blankslate="actionable"] a')?.getAttribute('href')).toBe(
      '/integrations/new',
    );
  });
});

describe('an integration’s page', () => {
  /**
   * PROGRESS backlog 272 (WP-95): the webhook URL the API has published since WP-21 reaches the
   * setup guide, as text with a copy control — and a provider with no inbound half says it has none
   * rather than drawing an empty field (standing rule 42: both directions).
   */
  it('shows the webhook URL on the setup-guide card and copies it', async () => {
    // Before the clipboard is replaced: `userEvent.setup()` installs a clipboard stub of its own.
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    const { container } = renderApp(recorder().fetchImpl);
    await choose(user, 'ACME Jira', 'Setup guide');
    await waitFor(() => {
      expect(container.querySelector('[data-copyable-url]')?.textContent).toBe(WEBHOOK_URL);
    });
    expect(window.location.pathname).toBe(`/integrations/${INTEGRATION}`);
    expect(window.location.search).toBe('?tab=setup-guide');
    const tabs = screen.getByRole('navigation', { name: 'Integration' });
    expect(
      within(tabs).getByRole('link', { name: 'Setup guide' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(document.body.textContent).toContain('Create a webhook in Jira');
    // Copied, never followed: the webhook route answers a provider's signed POST.
    expect(
      [...container.querySelectorAll('a')].some((anchor) => anchor.textContent === WEBHOOK_URL),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Copy Webhook URL' }));
    await waitFor(() => {
      expect(copied).toEqual([WEBHOOK_URL]);
    });
  });

  it('says a provider with no inbound half has no webhook URL', async () => {
    const { fetchImpl: base } = recorder();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/setup-guide')) {
        return json({ ...GUIDE, webhook_url: null });
      }
      return base(input, init);
    }) as typeof fetch;
    window.history.pushState({}, '', `/integrations/${INTEGRATION}?tab=setup-guide`);
    const { container } = renderApp(fetchImpl);
    await waitFor(() => {
      expect(container.querySelector('[data-webhook-url="none"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-copyable-url]')).toBeNull();
  });

  it('shows the overview: human labels with their keys, the binding projects, and one primary', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    const { sent, fetchImpl } = recorder({ bound: [INTEGRATION] });
    const { container } = renderApp(fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    expect(screen.getByText('Site URL')).toBeTruthy();
    expect(screen.getByText('site_url')).toBeTruthy();
    expect(screen.getByText('https://acme.atlassian.example.test')).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Acme service' })).getAttribute('href')).toBe(
      '/projects/acme/settings',
    );
    const primaries = [...container.querySelectorAll('a, button')].filter((element) =>
      element.className.includes('border-primary-line'),
    );
    expect(primaries.map((element) => element.textContent)).toEqual(['Test connection']);
    await userEvent.setup().click(primaries[0] as HTMLElement);
    await waitFor(() => {
      expect(
        sent.some((entry) => entry.url.endsWith(`/api/integrations/${INTEGRATION}/test`)),
      ).toBe(true);
    });
    expect(await screen.findByText('Last test: passed')).toBeTruthy();
  });

  /**
   * The server strips only the provider's **declared** credential fields from `config`, so a token
   * once stored under a key the provider does not declare is published as it is. The page names such
   * a key and never shows its value — as the old card did, which listed undeclared keys by name.
   */
  it('shows the name of a key the provider does not declare, never its value', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    const PLANTED = 'FAKE-legacy-token-value-0123456789';
    const legacy: IntegrationSummary = {
      ...JIRA,
      config: { ...JIRA.config, legacy_token: PLANTED, host: 'old.example.test' },
    };
    const { container } = renderApp(recorder({ items: [legacy] }).fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    // Positive first: a declared field's value is on the page, so "nothing shown" cannot pass.
    await waitFor(() => {
      expect(container.textContent).toContain('https://acme.atlassian.example.test');
    });
    expect(container.querySelector('[data-config-undeclared="legacy_token"]')?.textContent).toBe(
      'Not a field this provider declares; value hidden.',
    );
    expect(screen.getByText('legacy_token')).toBeTruthy();
    expect(container.querySelector('[data-config-undeclared="host"]')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain(PLANTED);
    expect(document.body.innerHTML).not.toContain('old.example.test');
  });

  it('lists the refused deliveries in their tab, the provider’s words as text', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}?tab=refused-deliveries`);
    const { container } = renderApp(recorder().fetchImpl);
    const list = await screen.findByRole('list', { name: 'Refused deliveries' });
    expect(list.textContent).toContain('unmapped_identity: <b>U123</b>');
    expect(list.querySelector('b')).toBeNull();
    expect(list.textContent).toContain('slack:U123');
    expect(container.querySelector('[data-setup-guide]')).toBeNull();
  });

  it('says plainly when the id is not one of the organisation’s integrations', async () => {
    window.history.pushState({}, '', '/integrations/00000000-0000-4000-8000-0000000000ff');
    renderApp(recorder().fetchImpl);
    expect(await screen.findByText('No such integration')).toBeTruthy();
  });

  it('offers no write on a retired integration’s page', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    renderApp(recorder({ items: [{ ...JIRA, retired_at: '2026-10-01T09:00:00.000Z' }] }).fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for ACME Jira' })).toBeNull();
  });
});
