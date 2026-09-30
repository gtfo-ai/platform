/**
 * The Integrations screen's create and test controls — PROGRESS backlog 55, and 53 with them.
 *
 * `POST /api/integrations` was served by WP-21 and **no component called it**: the wizard's own
 * docblock said this screen owned the control and this screen's said the wizard did. So the two
 * assertions here are the ones no existing tier made — that pressing a control produces the request
 * — plus the property backlog 53 is about, which only a double-submit can show.
 */

import type { IntegrationSummary, IntegrationsResponse } from '@platform/contracts';
import {
  configIssuesOf,
  findShippedProvider,
  type ProviderCatalogueEntry,
  SHIPPED_PROVIDERS,
  toIntegrationProvider,
} from '@platform/integrations';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000000d1';

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

const INTEGRATIONS: IntegrationsResponse = {
  items: [
    {
      id: INTEGRATION,
      type: 'task_management',
      provider: 'jira-cloud',
      name: 'ACME Jira',
      config: { base_url: 'https://acme.atlassian.net' },
      health: { status: 'unknown', checked_at: null, detail: null },
      config_refusal: null,
    },
  ],
};

/**
 * `GET /api/integrations/providers` as the server answers it — built from the **real** catalogue
 * through the server's own projection (`toIntegrationProvider`), so these cases drive the form with
 * the fields the shipped providers actually require rather than a copy (WP-100, criterion 2).
 */
const PROVIDERS = { items: SHIPPED_PROVIDERS.map(toIntegrationProvider) };

/**
 * A value per required field **name**, never per provider: a sixth provider whose required field is
 * not here fails the per-provider case by name, which is the point.
 */
const SAMPLE_VALUES: Readonly<Record<string, string>> = {
  base_url: 'https://provider.example.test',
  site_url: 'https://acme.atlassian.example.test',
  user_email: 'ops@example.test',
  organization: 'acme',
  channel: '#agentic',
};

/** The setup guide as the server answers it: the guide's text and the URL built from `APP_BASE_URL`. */
const WEBHOOK_URL = `https://agentic.example.test/webhooks/jira-cloud/${INTEGRATION}`;
const GUIDE = {
  provider: 'jira-cloud',
  title: 'Jira Cloud',
  markdown: 'Create a webhook in Jira and paste the URL shown above.',
  webhook_url: WEBHOOK_URL,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly body: unknown;
}

const recorder = () => {
  const sent: Sent[] = [];
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
      return json({ id: INTEGRATION, provider: 'jira-cloud', name: 'ACME Jira' });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/integrations')) return json(INTEGRATIONS);
    if (url.endsWith('/api/integrations/providers')) return json(PROVIDERS);
    if (url.endsWith(`/api/integrations/${INTEGRATION}/setup-guide`)) return json(GUIDE);
    if (url.endsWith('/api/projects')) return json({ items: [] });
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

const fillCreateForm = async (): Promise<void> => {
  const select = await screen.findByLabelText('Provider');
  await screen.findByRole('option', { name: /Jira Cloud/ });
  fireEvent.change(select, { target: { value: 'jira-cloud' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Jira' } });
  fireEvent.change(screen.getByLabelText('site_url'), {
    target: { value: 'https://acme.atlassian.example.test' },
  });
  fireEvent.change(screen.getByLabelText('user_email'), { target: { value: 'ops@example.test' } });
  fireEvent.change(screen.getByLabelText('Environment variable for api_token'), {
    target: { value: 'JIRA_API_TOKEN' },
  });
};

describe('the integrations screen', () => {
  it('creates an integration by naming an environment variable, never a credential', async () => {
    const { sent, fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('Add an integration');
    await fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));

    await waitFor(() => {
      expect(sent.some((entry) => entry.url.endsWith('/api/integrations'))).toBe(true);
    });
    const created = sent.find((entry) => entry.url.endsWith('/api/integrations'));
    expect(created?.method).toBe('POST');
    expect(created?.body).toEqual({
      type: 'task_management',
      provider: 'jira-cloud',
      name: 'ACME Jira',
      // The provider's required fields (WP-100, backlog 328) — `{}` here was the defect.
      config: { site_url: 'https://acme.atlassian.example.test', user_email: 'ops@example.test' },
      // The **name** of the variable, never its value: the server reads its own environment and
      // seals what it finds (TD-020, BD-002). A body carrying a token would be the defect.
      secret_refs: { api_token: 'JIRA_API_TOKEN' },
    });
    // A create carries a key, because a double-clicked create is what the header exists for.
    expect(created?.key).toMatch(/^[A-Za-z0-9._:-]+$/);
  });

  /**
   * **PROGRESS backlog 53, end to end.**
   *
   * The client minted a fresh `crypto.randomUUID()` **per request**, so two sends of one intent
   * carried two keys and the server — which answers a replay from the key — saw two first requests.
   * Two clicks still make two requests (the client cannot know whether the first arrived); what
   * changes is that the second carries a key the server recognises.
   */
  it('sends one key for a double-submitted create, and a new one for a corrected form', async () => {
    const { sent, fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('Add an integration');
    await fillCreateForm();
    const submit = screen.getByRole('button', { name: 'Add integration' });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => {
      expect(sent.filter((entry) => entry.url.endsWith('/api/integrations'))).toHaveLength(2);
    });
    const creates = sent.filter((entry) => entry.url.endsWith('/api/integrations'));
    expect(creates[0]?.key).toBe(creates[1]?.key);

    // A corrected form is a different intent, and the same key with a different body would be
    // refused — so it must mint a new one (standing rule 42: the other direction).
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Jira EU' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));
    await waitFor(() => {
      expect(sent.filter((entry) => entry.url.endsWith('/api/integrations'))).toHaveLength(3);
    });
    expect(sent.at(-1)?.key).not.toBe(creates[0]?.key);
  });

  it('tests a connection and renders the provider’s own words as text', async () => {
    const { sent, fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    await waitFor(() => {
      expect(
        sent.some((entry) => entry.url.includes(`/api/integrations/${INTEGRATION}/test`)),
      ).toBe(true);
    });
    // The result reaches the screen — a button that fired and showed nothing is the control
    // product/10 asks for only in the sense that it exists.
    expect(await screen.findByText('Last test: passed')).toBeTruthy();
    expect(document.body.textContent).toContain('reachable');
  });

  it('shows the server’s own refusal of a configuration, naming the path', async () => {
    const { fetchImpl: base } = recorder();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/api/integrations')) {
        return json(
          {
            error: {
              code: 'invalid_integration_config',
              message:
                'the configuration is refused by provider "jira-cloud"\'s schema at: user_email (Invalid email address)',
              details: [{ path: 'user_email', message: 'Invalid email address' }],
            },
          },
          400,
        );
      }
      return base(input, init);
    }) as typeof fetch;

    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('Add an integration');
    await fillCreateForm();
    fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));
    expect(await screen.findByText('The integration was not created.')).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain('user_email (Invalid email address)');
    });
  });

  /**
   * WP-100, criterion 2: **each** shipped provider created through the real client, with the form
   * rendering the fields the provider's own schema requires — and the body it sends is then parsed
   * with that same schema here (`configIssuesOf`), so "the form sends each provider's required
   * fields" is a statement about a document the provider accepts, not about a list of keys.
   */
  it.each(SHIPPED_PROVIDERS.map((entry) => [entry.id, entry] as const))(
    'creates a %s integration with every field its schema requires',
    async (id, entry) => {
      const { sent, fetchImpl } = recorder();
      render(createApp({ fetchImpl, realtime: false }).element);
      const select = await screen.findByLabelText('Provider');
      await waitFor(() => {
        expect(select.querySelector(`option[value="${id}"]`), id).not.toBeNull();
      });
      fireEvent.change(select, { target: { value: id } });
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: `acme ${id}` } });
      const required = entry.configFields.filter((field) => field.required).map((f) => f.name);
      expect(required.length, id).toBeGreaterThan(0);
      for (const name of required) {
        const value = SAMPLE_VALUES[name];
        expect(value, `a sample value for ${id}'s ${name}`).toBeDefined();
        fireEvent.change(screen.getByLabelText(name), { target: { value } });
      }
      // No credential field is offered as configuration: each is an environment-variable name.
      for (const field of entry.secretFields) {
        expect(screen.queryByLabelText(field), field).toBeNull();
        expect(screen.getByLabelText(`Environment variable for ${field}`)).toBeTruthy();
      }
      const firstSecret = entry.secretFields[0] as string;
      fireEvent.change(screen.getByLabelText(`Environment variable for ${firstSecret}`), {
        target: { value: 'FAKE_PROVIDER_TOKEN_ENV' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));

      await waitFor(() => {
        expect(sent.some((each) => each.url.endsWith('/api/integrations'))).toBe(true);
      });
      const body = sent.find((each) => each.url.endsWith('/api/integrations'))?.body as {
        type: string;
        provider: string;
        config: Record<string, unknown>;
        secret_refs: Record<string, string>;
      };
      expect(body.provider).toBe(id);
      expect(body.type).toBe(entry.type);
      expect(Object.keys(body.config).sort()).toEqual([...required].sort());
      expect(configIssuesOf(entry, body.config as never)).toEqual([]);
      expect(body.secret_refs).toEqual({ [firstSecret]: 'FAKE_PROVIDER_TOKEN_ENV' });
    },
  );

  /**
   * WP-100, criterion 4 on the screen: a stored row that would not load says so on its card, and
   * *Edit configuration* sends the `PATCH` the refusal names — the required field set, and the
   * key the provider does not declare removed.
   */
  it('shows a stored configuration’s refusal and repairs it with the PATCH it names', async () => {
    const sentry = findShippedProvider('sentry') as ProviderCatalogueEntry;
    const broken: IntegrationSummary = {
      id: INTEGRATION,
      type: 'errors',
      provider: 'sentry',
      name: 'ACME Sentry',
      config: { organisation: 'acme', base_url: 'https://sentry.example.test' },
      health: { status: 'unknown', checked_at: null, detail: null },
      config_refusal: {
        code: 'invalid_integration_config',
        message: `integration ${INTEGRATION} has configuration that provider "sentry"'s schema refuses at: organisation, organization. Correct it with PATCH /api/integrations/${INTEGRATION}`,
        paths: ['organisation', 'organization'],
      },
    };
    const { sent, fetchImpl: base } = recorder();
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/api/integrations')) {
        return json({ items: [broken] });
      }
      if (init?.method === 'PATCH') {
        await base(input, init);
        return json({ ...broken, config_refusal: null });
      }
      return base(input, init);
    }) as typeof fetch;

    render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByText('This configuration would not load.')).toBeTruthy();
    expect(document.body.textContent).toContain(`PATCH /api/integrations/${INTEGRATION}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit configuration' }));
    const field = await screen.findByLabelText('organization');
    fireEvent.change(field, { target: { value: 'acme' } });
    expect(document.querySelector('[data-config-remove]')?.textContent).toContain('organisation');
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));

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
  });

  /**
   * PROGRESS backlog 272 (WP-95): the webhook URL the API has published since WP-21 reaches the
   * setup-guide card, as text with a copy control — and a provider with no inbound half says it has
   * none rather than drawing an empty field (standing rule 42: both directions).
   */
  it('shows the webhook URL on the setup-guide card and copies it', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text);
        },
      },
    });
    const { fetchImpl } = recorder();
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    fireEvent.click(await screen.findByRole('button', { name: 'Setup guide' }));
    await waitFor(() => {
      expect(container.querySelector('[data-copyable-url]')?.textContent).toBe(WEBHOOK_URL);
    });
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
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    fireEvent.click(await screen.findByRole('button', { name: 'Setup guide' }));
    await waitFor(() => {
      expect(container.querySelector('[data-webhook-url="none"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-copyable-url]')).toBeNull();
  });
});
