/**
 * The add-integration wizard (S-23.11a) — the create that was the Integrations screen's form, in
 * four steps. PROGRESS backlog 55 is still the reason this file exists: `POST /api/integrations` was
 * served and no component called it, so the assertions are that pressing the controls produces the
 * request, with the body the provider's own schema accepts — plus backlog 53's, which only a
 * double-submit can show.
 *
 * The labels changed deliberately: a configuration field is labelled in words (*Site URL*), its key
 * (`site_url`) in the hint; a credential field is *Environment variable for API token*.
 */
import {
  configIssuesOf,
  findShippedProvider,
  type ProviderCatalogueEntry,
  SHIPPED_PROVIDERS,
  toIntegrationProvider,
} from '@platform/integrations';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { configFieldLabel } from '../ui/humanize.js';

const INTEGRATION = '00000000-0000-4000-8000-0000000000d1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly key: string | null;
  readonly body: unknown;
}

/** The created integration as the list publishes it once the create has run. */
const CREATED_ROW = {
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

const PROJECT_ROW = {
  id: '00000000-0000-4000-8000-0000000000a1',
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

/**
 * `refuseCreates`: answer every create with the server's 400, naming the path. `listed`: the list
 * already holds the created integration (a reload after the create). `canWrite`: the list's
 * `can_write`, an administrator's `true` by default. `projects`: the projects the caller reads.
 */
const recorder = (
  options: {
    readonly refuseCreates?: boolean;
    readonly listed?: boolean;
    readonly canWrite?: boolean;
    readonly projects?: readonly (typeof PROJECT_ROW)[];
  } = {},
) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        url,
        method,
        key: new Headers(init?.headers).get('Idempotency-Key'),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      if (url.endsWith('/test')) {
        return json({
          ok: false,
          checks: [{ name: 'authenticated', ok: false, detail: '401 <b>no</b>' }],
        });
      }
      if (options.refuseCreates === true) {
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
      return json({ id: INTEGRATION, provider: 'jira-cloud', name: 'ACME Jira' });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/integrations')) {
      return json({
        items: options.listed === true ? [CREATED_ROW] : [],
        can_write: options.canWrite ?? true,
      });
    }
    if (url.endsWith('/api/integrations/providers')) return json(PROVIDERS);
    if (url.endsWith('/api/projects')) return json({ items: options.projects ?? [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  return { sent, fetchImpl };
};

const creates = (sent: readonly Sent[]) =>
  sent.filter((entry) => entry.url.endsWith('/api/integrations'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  // The wizard keeps its draft in this tab's storage (S-23.23); every case starts with none.
  window.sessionStorage.clear();
  window.history.pushState({}, '', '/integrations/new');
});

const currentStep = (): string | null =>
  document.querySelector('[data-wizard-step]')?.getAttribute('data-wizard-step') ?? null;

/** Step 1 → step 3 for a provider, with its required fields from {@link SAMPLE_VALUES}. */
const walkTo = async (
  user: ReturnType<typeof userEvent.setup>,
  providerId: string,
  name: string,
): Promise<void> => {
  const entry = findShippedProvider(providerId) as ProviderCatalogueEntry;
  await user.click(
    await screen.findByRole('radio', {
      name: new RegExp(entry.displayName.split(' ')[0] as string),
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Continue to configuration' }));
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: name } });
  for (const field of entry.configFields.filter((each) => each.required)) {
    const value = SAMPLE_VALUES[field.name];
    expect(value, `a sample value for ${providerId}'s ${field.name}`).toBeDefined();
    fireEvent.change(screen.getByLabelText(configFieldLabel(field.name)), { target: { value } });
  }
  await user.click(screen.getByRole('button', { name: 'Continue to credentials' }));
  await waitFor(() => {
    expect(currentStep()).toBe('credentials');
  });
};

describe('the add-integration wizard', () => {
  it('offers a card per shipped provider, each with its purpose, and continues only once one is chosen', async () => {
    const { fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    const radios = await screen.findAllByRole('radio');
    expect(radios).toHaveLength(SHIPPED_PROVIDERS.length);
    expect(document.body.textContent).toContain('Ticket tracker — Where tickets come from');
    const next = screen.getByRole('button', { name: 'Continue to configuration' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    const steps = screen.getByRole('list', { name: 'New integration' });
    expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain(
      'Choose a provider',
    );
  });

  it('labels each field in words, names its key in the hint, and creates with an environment variable', async () => {
    const { sent, fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Jira Cloud/ }));
    await user.click(screen.getByRole('button', { name: 'Continue to configuration' }));
    expect(window.location.search).toBe('?step=configuration');
    const site = await screen.findByLabelText('Site URL');
    expect(
      document.getElementById(site.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('Key: site_url.');
    // The required fields first; the step continues only once they and the name are filled.
    const next = screen.getByRole('button', { name: 'Continue to credentials' });
    expect((next as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Jira' } });
    fireEvent.change(site, { target: { value: 'https://acme.atlassian.example.test' } });
    fireEvent.change(screen.getByLabelText('User email'), {
      target: { value: 'ops@example.test' },
    });
    await user.click(next);

    // Step 3: one line on why, and a variable's name per credential — never a value.
    expect(await screen.findByText(/never crosses the browser/)).toBeTruthy();
    expect(screen.queryByLabelText('API token')).toBeNull();
    fireEvent.change(screen.getByLabelText('Environment variable for API token'), {
      target: { value: 'JIRA_API_TOKEN' },
    });
    expect(sent).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Create integration' }));

    await waitFor(() => {
      expect(creates(sent)).toHaveLength(1);
    });
    const created = creates(sent)[0];
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
    await waitFor(() => {
      expect(currentStep()).toBe('test');
    });
  });

  /**
   * **PROGRESS backlog 53, end to end.** Two sends of one intent carry one key; a corrected form is
   * a different intent and must carry a new one, because the same key with a different body is
   * refused (standing rule 42: the other direction). The creates are refused here so the wizard
   * stays on the form and the correction can be made.
   */
  it('sends one key for a double-submitted create, and a new one for a corrected form', async () => {
    const { sent, fetchImpl } = recorder({ refuseCreates: true });
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await walkTo(user, 'jira-cloud', 'ACME Jira');
    fireEvent.change(screen.getByLabelText('Environment variable for API token'), {
      target: { value: 'JIRA_API_TOKEN' },
    });
    const submit = screen.getByRole('button', { name: 'Create integration' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => {
      expect(creates(sent)).toHaveLength(2);
    });
    expect(creates(sent)[0]?.key).toBe(creates(sent)[1]?.key);
    // The server's own words, naming the path it refused.
    expect(await screen.findByText('The integration was not created.')).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain('user_email (Invalid email address)');
    });

    // Back to step 2 through the step list, correct the name, and create again.
    await user.click(screen.getByRole('link', { name: 'Configure it' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'ACME Jira EU' } });
    await user.click(screen.getByRole('button', { name: 'Continue to credentials' }));
    // What was typed on the later step is still there.
    expect(
      ((await screen.findByLabelText('Environment variable for API token')) as HTMLInputElement)
        .value,
    ).toBe('JIRA_API_TOKEN');
    await user.click(screen.getByRole('button', { name: 'Create integration' }));
    await waitFor(() => {
      expect(creates(sent)).toHaveLength(3);
    });
    expect(creates(sent)[2]?.key).not.toBe(creates(sent)[0]?.key);
  });

  /**
   * WP-100, criterion 2: **each** shipped provider created through the real client, with the
   * wizard rendering the fields the provider's own schema requires — and the body it sends is then
   * parsed with that same schema (`configIssuesOf`), so "the form sends each provider's required
   * fields" is a statement about a document the provider accepts, not about a list of keys.
   */
  it.each(SHIPPED_PROVIDERS.map((entry) => [entry.id, entry] as const))(
    'creates a %s integration with every field its schema requires',
    async (id, entry) => {
      const { sent, fetchImpl } = recorder();
      render(createApp({ fetchImpl, realtime: false }).element);
      const user = userEvent.setup();
      await walkTo(user, id, `acme ${id}`);
      // No credential field is offered as configuration: each is an environment-variable name.
      for (const field of entry.secretFields) {
        expect(screen.queryByLabelText(configFieldLabel(field)), field).toBeNull();
        expect(
          screen.getByLabelText(`Environment variable for ${configFieldLabel(field)}`),
        ).toBeTruthy();
      }
      const firstSecret = entry.secretFields[0] as string;
      fireEvent.change(
        screen.getByLabelText(`Environment variable for ${configFieldLabel(firstSecret)}`),
        { target: { value: 'FAKE_PROVIDER_TOKEN_ENV' } },
      );
      await user.click(screen.getByRole('button', { name: 'Create integration' }));

      await waitFor(() => {
        expect(creates(sent)).toHaveLength(1);
      });
      const body = creates(sent)[0]?.body as {
        type: string;
        provider: string;
        config: Record<string, unknown>;
        secret_refs: Record<string, string>;
      };
      const required = entry.configFields.filter((field) => field.required).map((f) => f.name);
      expect(body.provider).toBe(id);
      expect(body.type).toBe(entry.type);
      expect(Object.keys(body.config).sort()).toEqual([...required].sort());
      expect(configIssuesOf(entry, body.config as never)).toEqual([]);
      expect(body.secret_refs).toEqual({ [firstSecret]: 'FAKE_PROVIDER_TOKEN_ENV' });
    },
  );

  /**
   * WP-114, PROGRESS backlog 332: an optional field is offered with a control of its declared type,
   * behind *Optional settings*, and the value it sends is typed — a boolean as a boolean, a number
   * as a number, a list as a list — while an optional field left alone is not sent at all.
   */
  it('offers the optional settings as typed controls and sends typed values', async () => {
    const { sent, fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('radio', { name: /Jira Cloud/ }));
    await user.click(screen.getByRole('button', { name: 'Continue to configuration' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'ACME Jira' } });
    fireEvent.change(screen.getByLabelText('Site URL'), {
      target: { value: 'https://acme.atlassian.example.test' },
    });
    fireEvent.change(screen.getByLabelText('User email'), {
      target: { value: 'ops@example.test' },
    });
    const poll = screen.getByLabelText('Poll for changes');
    expect(poll.tagName).toBe('SELECT');
    expect(poll.closest('details')).not.toBeNull();
    expect(poll.getAttribute('data-config-kind')).toBe('boolean');
    fireEvent.change(poll, { target: { value: 'true' } });
    fireEvent.change(screen.getByLabelText('Poll interval (seconds)'), {
      target: { value: '120' },
    });
    fireEvent.change(screen.getByLabelText('Project keys'), { target: { value: 'ACME, OPS ,' } });
    await user.click(screen.getByRole('button', { name: 'Continue to credentials' }));
    await user.click(await screen.findByRole('button', { name: 'Create integration' }));

    await waitFor(() => {
      expect(creates(sent)).toHaveLength(1);
    });
    const body = creates(sent)[0]?.body as { config: Record<string, unknown> };
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

  it('shows the first incomplete step for a step deep-linked before its turn', async () => {
    window.history.pushState({}, '', '/integrations/new?step=credentials');
    const { fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findAllByRole('radio');
    expect(currentStep()).toBe('provider');
    expect(screen.queryByRole('button', { name: 'Create integration' })).toBeNull();
  });

  it('tests what it created, then ends on the next screen: binding it to a project', async () => {
    const { sent, fetchImpl } = recorder({ projects: [PROJECT_ROW] });
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await walkTo(user, 'jira-cloud', 'ACME Jira');
    await user.click(screen.getByRole('button', { name: 'Create integration' }));
    await waitFor(() => {
      expect(currentStep()).toBe('test');
    });
    // Created: the earlier steps are done and no longer links, so it cannot be created twice.
    expect(screen.queryByRole('link', { name: 'Configure it' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => {
      expect(
        sent.some((entry) => entry.url.endsWith(`/api/integrations/${INTEGRATION}/test`)),
      ).toBe(true);
    });
    expect(await screen.findByText('Last test: failed')).toBeTruthy();
    // The provider's words, as text (BD-022).
    expect(document.body.textContent).toContain('401 <b>no</b>');
    expect(document.querySelector('main b')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByText('The integration is added.')).toBeTruthy();
    // S-23.23: the ending is addressable too, so a reload lands on it again.
    expect(new URLSearchParams(window.location.search).get('step')).toBe('done');
    expect(screen.getByRole('link', { name: 'Use in a new project' }).getAttribute('href')).toBe(
      '/onboarding',
    );
    expect(screen.getByRole('link', { name: 'Open the integration' }).getAttribute('href')).toBe(
      `/integrations/${INTEGRATION}`,
    );
    const steps = screen.getByRole('list', { name: 'New integration' });
    expect(
      [...steps.querySelectorAll('[data-step-state]')].map((step) =>
        step.getAttribute('data-step-state'),
      ),
    ).toEqual(['done', 'done', 'done', 'done']);

    // …and the other way on: an existing project's Connections.
    await user.click(screen.getByRole('button', { name: /Add to an existing project/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Acme service' }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/projects/acme/settings/connections');
    });
  });
});

/**
 * S-23.23 (the UX audit's item 10, BACKLOG 830): a reload resumes the wizard. Before the create, the
 * non-secret draft is in this tab's storage; after it, the integration's id is in the URL.
 */
describe('the add-integration wizard after a reload', () => {
  const reload = (fetchImpl: typeof fetch) => {
    cleanup();
    return render(createApp({ fetchImpl, realtime: false }).element);
  };

  it('resumes on the step it was on, with what was typed — but never the credentials’ names', async () => {
    const { fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await walkTo(user, 'jira-cloud', 'ACME Jira');
    fireEvent.change(screen.getByLabelText('Environment variable for API token'), {
      target: { value: 'JIRA_API_TOKEN' },
    });

    reload(fetchImpl);
    await waitFor(() => {
      expect(currentStep()).toBe('credentials');
    });
    expect(
      (screen.getByLabelText('Environment variable for API token') as HTMLInputElement).value,
    ).toBe('');
    // What the tab keeps: the provider, the name and the configuration — nothing of the credentials.
    const stored = window.sessionStorage.getItem('agentic.integration-wizard.draft') ?? '';
    expect(JSON.parse(stored)).toEqual({
      providerId: 'jira-cloud',
      name: 'ACME Jira',
      config: { site_url: 'https://acme.atlassian.example.test', user_email: 'ops@example.test' },
    });
    expect(stored).not.toContain('JIRA_API_TOKEN');
    await user.click(screen.getByRole('link', { name: 'Configure it' }));
    expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('ACME Jira');
  });

  it('carries the created integration’s id, and a reload resumes at its test — never at the form', async () => {
    const { sent, fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await walkTo(user, 'jira-cloud', 'ACME Jira');
    await user.click(screen.getByRole('button', { name: 'Create integration' }));
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get('id')).toBe(INTEGRATION);
    });
    expect(new URLSearchParams(window.location.search).get('step')).toBe('test');
    // The draft is gone: the URL is what resumes the wizard now.
    expect(window.sessionStorage.getItem('agentic.integration-wizard.draft')).toBeNull();

    reload(recorder({ listed: true }).fetchImpl);
    await waitFor(() => {
      expect(currentStep()).toBe('test');
    });
    expect(await screen.findByRole('button', { name: 'Test connection' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create integration' })).toBeNull();
    expect(creates(sent)).toHaveLength(1);
  });

  it('says so for an id the organisation does not have, rather than offering a create', async () => {
    window.history.pushState({}, '', `/integrations/new?step=test&id=${INTEGRATION}`);
    const { fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByText('That integration is not here')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create integration' })).toBeNull();
  });

  it('tells a caller who may not write integrations who adds them, and offers no form', async () => {
    const { fetchImpl } = recorder({ canWrite: false });
    render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByText('Administrators add integrations')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});
