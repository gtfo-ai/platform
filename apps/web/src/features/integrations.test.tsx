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
  activity: { last_call: null, last_delivery_at: null },
  current_health: { status: 'never_checked', basis: null, at: null },
  used_by: [],
};

const INTEGRATIONS: IntegrationsResponse = { items: [JIRA], can_write: true };

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

/** The project a bound integration names in its `used_by` — the binding's use, as the server words it. */
const ACME_USER: IntegrationSummary['used_by'][number] = {
  project_id: PROJECT,
  project_key: 'acme',
  project_name: 'Acme service',
  uses: [
    { label: 'Tickets from', value: 'AUT' },
    { label: 'Picked up with label', value: 'agentic' },
  ],
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
  /** The list read's `can_write` (S-23.23); an administrator's `true` by default. */
  canWrite?: boolean;
}

const recorder = (world: World = {}) => {
  const sent: Sent[] = [];
  // S-25.3: the list read names the projects that use each integration (`used_by`).
  const items = (world.items ?? INTEGRATIONS.items).map((item) =>
    (world.bound ?? []).includes(item.id) ? { ...item, used_by: [ACME_USER] } : item,
  );
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
    if (url.endsWith('/api/integrations')) {
      return json({ items, can_write: world.canWrite ?? true });
    }
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
  // S-23.23 (the UX audit's item 3): every write is an administrator's (`integration.write`), so a
  // maintainer reads the list with no *New integration*, no write in a row's menu, and a line
  // saying who adds and changes integrations.
  it('offers a caller who may not write no create, test, edit, credentials or retire', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(recorder({ canWrite: false }).fetchImpl);
    await screen.findByRole('list', { name: 'Tickets' });
    expect(screen.queryByRole('link', { name: 'New integration' })).toBeNull();
    expect(container.querySelector('[data-may-not-write]')?.textContent).toBe(
      'Administrators add and change integrations.',
    );
    await user.click(await screen.findByRole('button', { name: 'Actions for ACME Jira' }));
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Setup guide']);
  });

  it('says to a caller who may not write that an administrator adds the first integration', async () => {
    renderApp(recorder({ canWrite: false, items: [] }).fetchImpl);
    expect(await screen.findByText('No integrations yet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New integration' })).toBeNull();
    expect(screen.getByText(/Ask an administrator to add one/)).toBeTruthy();
  });

  it('lists a row with its health, provider, kind, last check and bindings, under one primary', async () => {
    const { container } = renderApp(recorder({ bound: [INTEGRATION] }).fetchImpl);
    // S-25.3: under its role's group, the provider's role glyph beside its name — never a logo.
    const list = await screen.findByRole('list', { name: 'Tickets' });
    expect(screen.getByRole('heading', { level: 2, name: 'Tickets' })).toBeTruthy();
    const row = within(list).getByRole('link', { name: 'ACME Jira' }).closest('li');
    expect(row?.querySelector('[data-provider-icon]')?.textContent).toBe('Jira Cloud');
    expect(row?.querySelector('[data-provider-glyph="task_management"] svg')).not.toBeNull();
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.textContent).toContain('no calls or deliveries yet');
    // Words, never the raw enum.
    expect(row?.textContent).toContain('Never checked');
    expect(row?.textContent).not.toContain('task_management');
    expect(row?.textContent).not.toContain('never_checked');
    expect(row?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Never checked');
    // "Used by Acme service", the project named and linked to its board.
    expect(row?.querySelector('[data-used-by]')?.textContent).toBe('Used by Acme service');
    expect(
      within(row as HTMLElement)
        .getByRole('link', { name: 'Acme service' })
        .getAttribute('href'),
    ).toBe('/projects/acme');
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
      activity: { last_call: { at: '2026-10-01T09:00:00.000Z', ok: true }, last_delivery_at: null },
      current_health: { status: 'working', basis: 'call', at: '2026-10-01T09:00:00.000Z' },
    };
    renderApp(recorder({ items: [checked] }).fetchImpl);
    const list = await screen.findByRole('list', { name: 'Tickets' });
    expect(list.textContent).toContain('last call 5 m ago');
    expect(list.textContent).toContain('Working');
    // The server named no project, so it is used by none.
    expect(list.textContent).toContain('Not used by a project');
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
      activity: { last_call: null, last_delivery_at: null },
      current_health: { status: 'never_checked', basis: null, at: null },
      used_by: [],
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
    // S-23.22: the visible sentence is built from the paths; the server's message — an id and an
    // API path — is a diagnostic, inside a collapsed "Technical details".
    const row = document.querySelector('[data-config-refusal]') as HTMLElement;
    const technical = row.querySelector('details');
    expect(technical?.querySelector('summary')?.textContent).toBe('Technical details');
    expect(technical?.open).toBe(false);
    expect(technical?.textContent).toContain(`PATCH /api/integrations/${INTEGRATION}`);
    const visible = row.cloneNode(true) as HTMLElement;
    visible.querySelector('details')?.remove();
    expect(visible.textContent).toContain('Some settings are invalid: Organisation, Organization.');
    expect(visible.textContent).not.toContain('/api/');
    expect(visible.textContent).not.toContain(INTEGRATION);
    const user = userEvent.setup();
    // The line's own action opens the same dialog the menu does.
    await user.click(within(row).getByRole('button', { name: 'Edit configuration' }));
    expect(
      await screen.findByRole('dialog', { name: 'Edit the configuration of ACME Sentry' }),
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
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
   * WP-282 (TD-031 decision 5, Q124 (a)): the remote-worker opt-in is a GitLab configuration choice,
   * offered as a typed control with the residual it accepts written beside it — and sent as typed.
   */
  it('offers remote_run_credential with its residual beside the switch, and sends the choice', async () => {
    const gitlab: IntegrationSummary = {
      ...JIRA,
      type: 'git',
      provider: 'gitlab',
      name: 'ACME GitLab',
      config: { base_url: 'https://gitlab.example.test', run_credential: 'static' },
    };
    const { sent, fetchImpl } = recorder({ items: [gitlab] });
    renderApp(fetchImpl);
    const user = userEvent.setup();
    await choose(user, 'ACME GitLab', 'Edit configuration');
    const form = await screen.findByRole('form', { name: 'Configuration of ACME GitLab' });
    const control = form.querySelector(
      'select[data-config-key="remote_run_credential"]',
    ) as HTMLSelectElement | null;
    expect(control).not.toBeNull();
    expect([...(control?.options ?? [])].map((option) => option.value)).toEqual([
      '',
      'allow',
      'deny',
    ]);
    // The residual sits beside the switch, as text, and on no other field.
    const residual = control?.parentElement?.querySelector('[data-config-residual]');
    expect(residual?.textContent).toMatch(/90 days/);
    expect(residual?.textContent).toMatch(/every project the key is enabled on/);
    expect(residual?.textContent).toMatch(/Default: deny/);
    expect(form.querySelectorAll('[data-config-residual]')).toHaveLength(1);
    fireEvent.change(control as HTMLSelectElement, { target: { value: 'allow' } });
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => {
      expect(sent.some((each) => each.method === 'PATCH')).toBe(true);
    });
    const patch = sent.find((each) => each.method === 'PATCH')?.body as
      | { config?: Record<string, unknown> }
      | undefined;
    expect(patch?.config?.remote_run_credential).toBe('allow');
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
    const list = await screen.findByRole('list', { name: 'Tickets' });
    expect(list.textContent).toContain('Used by Acme service');
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

/**
 * S-25.3 (research/21 S09, product/08's 2026-11-06 amendment): who an integration is, whether it
 * works now, and who uses it.
 */
describe('the integrations list — identity, health now and use (S-25.3)', () => {
  const NOW_ISO = new Date(NOW).toISOString();
  const DAYS_32 = new Date(NOW - 32 * 86_400_000).toISOString();
  const of = (
    id: string,
    type: IntegrationSummary['type'],
    provider: string,
    name: string,
    over: Partial<IntegrationSummary> = {},
  ): IntegrationSummary => ({ ...JIRA, id, type, provider, name, config: {}, ...over });
  const user = (n: number, name: string): IntegrationSummary['used_by'][number] => ({
    project_id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`,
    project_key: `p${n}`,
    project_name: name,
    uses: [],
  });

  it('groups the rows by what they do for a project, in product/08’s order, each with its role glyph', async () => {
    const { container } = renderApp(
      recorder({
        // Deliberately out of order: the screen orders the groups, not the read.
        items: [
          of('00000000-0000-4000-8000-0000000000c5', 'logs', 'loki', 'ACME Loki'),
          of('00000000-0000-4000-8000-0000000000c3', 'communication', 'slack', 'ACME Slack'),
          of('00000000-0000-4000-8000-0000000000c2', 'git', 'gitlab', 'ACME GitLab'),
          of('00000000-0000-4000-8000-0000000000c4', 'errors', 'sentry', 'ACME Sentry'),
          JIRA,
        ],
      }).fetchImpl,
    );
    await screen.findByRole('list', { name: 'Logs' });
    expect(
      [...container.querySelectorAll('[data-integration-group] h2')].map((h) => h.textContent),
    ).toEqual(['Tickets', 'Code & merge requests', 'Chat', 'Errors', 'Logs']);
    const glyphOf = (list: string) =>
      screen
        .getByRole('list', { name: list })
        .querySelector('[data-provider-glyph]')
        ?.getAttribute('data-provider-glyph');
    expect(glyphOf('Tickets')).toBe('task_management');
    expect(glyphOf('Code & merge requests')).toBe('git');
    expect(glyphOf('Chat')).toBe('communication');
    expect(glyphOf('Errors')).toBe('errors');
    expect(glyphOf('Logs')).toBe('logs');
    // A glyph per role and the provider's own name as text — never an <img> of a brand mark.
    expect(container.querySelector('main img')).toBeNull();
    expect(
      screen
        .getByRole('list', { name: 'Code & merge requests' })
        .querySelector('[data-provider-icon]')?.textContent,
    ).toBe('GitLab (gitlab.com and self-managed)');
  });

  it('carries the trademark line on the list and on an integration’s page', async () => {
    const { container, unmount } = renderApp(recorder().fetchImpl);
    await screen.findByRole('list', { name: 'Tickets' });
    expect(container.querySelector('[data-trademark-notice]')?.textContent).toBe(
      'GitLab, Jira, Slack, Sentry and Loki are trademarks of their respective owners; this project is not affiliated with or endorsed by them.',
    );
    unmount();
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    const page = renderApp(recorder().fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    expect(page.container.querySelector('[data-trademark-notice]')?.textContent).toContain(
      'are trademarks of their respective owners',
    );
  });

  it('names two projects and counts the rest: "Used by Alpha, Beta +2", each named one a link', async () => {
    const used: IntegrationSummary = {
      ...JIRA,
      used_by: [user(1, 'Alpha'), user(2, 'Beta'), user(3, 'Gamma'), user(4, '<b>Delta</b>')],
    };
    renderApp(recorder({ items: [used] }).fetchImpl);
    const list = await screen.findByRole('list', { name: 'Tickets' });
    const usedBy = list.querySelector('[data-used-by]') as HTMLElement;
    expect(usedBy.textContent).toBe('Used by Alpha, Beta +2');
    expect(
      within(usedBy)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(['/projects/p1', '/projects/p2']);
    // The rest are named in the count's tooltip, as text.
    const rest = usedBy.querySelector('[data-used-by-rest]');
    expect(rest?.getAttribute('title')).toBe('Gamma, <b>Delta</b>');
    expect(usedBy.querySelector('b')).toBeNull();
    // Two projects are both named, with no count.
    cleanup();
    renderApp(
      recorder({ items: [{ ...JIRA, used_by: [user(1, 'Alpha'), user(2, 'Beta')] }] }).fetchImpl,
    );
    const two = await screen.findByRole('list', { name: 'Tickets' });
    expect(two.querySelector('[data-used-by]')?.textContent).toBe('Used by Alpha, Beta');
  });

  it('never reads a month-old passed test as healthy: Not checked recently, with Test again in the row', async () => {
    const stale: IntegrationSummary = {
      ...JIRA,
      health: { status: 'ok', checked_at: DAYS_32, detail: null },
      current_health: { status: 'not_checked_recently', basis: 'probe', at: DAYS_32 },
    };
    const { sent, fetchImpl } = recorder({ items: [stale] });
    renderApp(fetchImpl);
    const list = await screen.findByRole('list', { name: 'Tickets' });
    const row = within(list).getByRole('link', { name: 'ACME Jira' }).closest('li') as HTMLElement;
    expect(row.textContent).toContain('Not checked recently · tested 32 d ago');
    expect(row.textContent).not.toContain('Healthy');
    expect(row.textContent).not.toContain('Working');
    // A row command: the row keeps its stretched link, and the button is a control of its own.
    expect(within(row).getByRole('link', { name: 'ACME Jira' }).hasAttribute('data-row-link')).toBe(
      true,
    );
    const again = within(row).getByRole('button', { name: 'Test again' });
    expect(again.closest('a')).toBeNull();
    // Not a second primary on the screen.
    expect(again.className).not.toContain('border-primary-line');
    await userEvent.setup().click(again);
    await waitFor(() => {
      expect(
        sent.filter((each) => each.url.endsWith(`/api/integrations/${INTEGRATION}/test`)),
      ).toHaveLength(1);
    });
    expect(await screen.findByText('Last test: passed')).toBeTruthy();
  });

  it('offers Test again only on a stale row, and only to someone who may test', async () => {
    const stale: IntegrationSummary = {
      ...JIRA,
      current_health: { status: 'not_checked_recently', basis: 'call', at: DAYS_32 },
      activity: { last_call: { at: DAYS_32, ok: true }, last_delivery_at: null },
    };
    const working: IntegrationSummary = {
      ...JIRA,
      id: '00000000-0000-4000-8000-0000000000d2',
      name: 'Fresh Jira',
      current_health: { status: 'working', basis: 'delivery', at: NOW_ISO },
      activity: { last_call: null, last_delivery_at: NOW_ISO },
    };
    renderApp(recorder({ items: [stale, working] }).fetchImpl);
    const list = await screen.findByRole('list', { name: 'Tickets' });
    expect(
      [...list.querySelectorAll('[data-test-again]')].map((b) => b.getAttribute('data-test-again')),
    ).toEqual([INTEGRATION]);
    expect(list.textContent).toContain('Working · last delivery just now');
    cleanup();
    renderApp(recorder({ items: [stale], canWrite: false }).fetchImpl);
    const maintainer = await screen.findByRole('list', { name: 'Tickets' });
    expect(maintainer.textContent).toContain('Not checked recently');
    expect(within(maintainer).queryByRole('button', { name: 'Test again' })).toBeNull();
  });

  it('reads a probe that passed with warnings as a pass on the row and on the page', async () => {
    // Review of PR #75: one meaning in both places — *Passed with warnings*, never Failing.
    const at = new Date(NOW - 2 * 3_600_000).toISOString();
    const warned: IntegrationSummary = {
      ...JIRA,
      health: { status: 'degraded', checked_at: at, detail: null },
      current_health: { status: 'working', basis: 'probe', at },
    };
    const { unmount } = renderApp(recorder({ items: [warned] }).fetchImpl);
    const list = await screen.findByRole('list', { name: 'Tickets' });
    expect(list.textContent).toContain('Working · tested with warnings 2 h ago');
    expect(list.textContent).not.toContain('failed');
    expect(list.textContent).not.toContain('Failing');
    unmount();
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    const page = renderApp(recorder({ items: [warned] }).fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    expect(page.container.querySelector('[data-health-fact="probe"]')?.textContent).toBe(
      'Passed with warnings 2 h ago',
    );
    expect(page.container.textContent).not.toContain('test failed');
  });

  it('says a failing call in words, from the server’s verdict', async () => {
    const failing: IntegrationSummary = {
      ...JIRA,
      activity: {
        last_call: { at: new Date(NOW - 2 * 3_600_000).toISOString(), ok: false },
        last_delivery_at: null,
      },
      current_health: {
        status: 'failing',
        basis: 'call',
        at: new Date(NOW - 2 * 3_600_000).toISOString(),
      },
    };
    renderApp(recorder({ items: [failing] }).fetchImpl);
    const list = await screen.findByRole('list', { name: 'Tickets' });
    expect(list.textContent).toContain('Failing · last call failed 2 h ago');
    expect(list.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Failing');
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

  it('shows the overview: human labels only, each project’s use, and one primary', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    const { sent, fetchImpl } = recorder({ bound: [INTEGRATION] });
    const { container } = renderApp(fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    expect(screen.getByText('Site URL')).toBeTruthy();
    // S-25.3 (research/21 S10): the raw key is not on the page, beside its label or anywhere.
    expect(screen.queryByText('site_url')).toBeNull();
    expect(container.textContent).not.toContain('site_url');
    expect(container.textContent).toContain('Secrets are stored encrypted and never shown.');
    expect(container.textContent).not.toContain('sealed');
    expect(screen.getByText('https://acme.atlassian.example.test')).toBeTruthy();
    const projects = screen.getByRole('list', { name: 'Projects that use it' });
    expect(within(projects).getByRole('link', { name: 'Acme service' }).getAttribute('href')).toBe(
      '/projects/acme/settings',
    );
    // What the project uses it for, in the server's words and values.
    expect(projects.querySelector('[data-integration-user="acme"]')?.textContent).toBe(
      'Acme service · Tickets from AUT · Picked up with label agentic',
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
    // Its label, not its raw key (S-25.3), and never its value.
    expect(screen.getByText('Legacy token')).toBeTruthy();
    expect(container.querySelector('[data-config-undeclared="host"]')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain(PLANTED);
    expect(document.body.innerHTML).not.toContain('old.example.test');
  });

  it('lists the refused deliveries in their tab, the provider’s words as text', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}?tab=refused-deliveries`);
    const { container } = renderApp(recorder().fetchImpl);
    // S-25.3: the tab and its list read "Rejected webhooks"; the address is unchanged.
    expect(await screen.findByRole('link', { name: 'Rejected webhooks' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Rejected webhooks' });
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

  it('shows the evidence its health was read from, each with its age (S-25.3)', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    const read: IntegrationSummary = {
      ...JIRA,
      health: {
        status: 'ok',
        checked_at: new Date(NOW - 32 * 86_400_000).toISOString(),
        detail: null,
      },
      activity: {
        last_call: { at: new Date(NOW - 10 * 60_000).toISOString(), ok: false },
        last_delivery_at: new Date(NOW - 3 * 3_600_000).toISOString(),
      },
      current_health: {
        status: 'degraded',
        basis: 'call',
        at: new Date(NOW - 10 * 60_000).toISOString(),
      },
    };
    const { container } = renderApp(recorder({ items: [read] }).fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    const fact = (name: string) =>
      container.querySelector(`[data-health-fact="${name}"]`)?.textContent;
    expect(fact('call')).toBe('Failed 10 m ago');
    expect(fact('delivery')).toBe('Received 3 h ago');
    expect(fact('probe')).toBe('Passed 32 d ago');
    expect(container.textContent).not.toContain('Healthy');
    expect(container.textContent).toContain('Some calls failing');
    expect(container.querySelector('[data-health-stale]')).toBeNull();
  });

  it('says a stale integration’s health is not known now, naming the bound', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    const stale: IntegrationSummary = {
      ...JIRA,
      current_health: {
        status: 'not_checked_recently',
        basis: 'call',
        at: '2026-09-01T09:00:00.000Z',
      },
      activity: { last_call: { at: '2026-09-01T09:00:00.000Z', ok: true }, last_delivery_at: null },
    };
    const { container } = renderApp(recorder({ items: [stale] }).fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    expect(container.querySelector('[data-health-stale]')?.textContent).toContain(
      'in the last 24 hours',
    );
    expect(container.querySelector('[data-health-fact="delivery"]')?.textContent).toBe('None yet');
    expect(container.querySelector('[data-health-fact="probe"]')?.textContent).toBe('Never tested');
  });

  it('offers no write on a retired integration’s page', async () => {
    window.history.pushState({}, '', `/integrations/${INTEGRATION}`);
    renderApp(recorder({ items: [{ ...JIRA, retired_at: '2026-10-01T09:00:00.000Z' }] }).fetchImpl);
    expect(await screen.findByRole('heading', { level: 1, name: 'ACME Jira' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Actions for ACME Jira' })).toBeNull();
  });
});
