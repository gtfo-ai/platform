/**
 * The Integrations screen's create and test controls — PROGRESS backlog 55, and 53 with them.
 *
 * `POST /api/integrations` was served by WP-21 and **no component called it**: the wizard's own
 * docblock said this screen owned the control and this screen's said the wizard did. So the two
 * assertions here are the ones no existing tier made — that pressing a control produces the request
 * — plus the property backlog 53 is about, which only a double-submit can show.
 */

import type { IntegrationsResponse } from '@platform/contracts';
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
    },
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

const fillCreateForm = (): void => {
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'jira-cloud' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ACME Jira' } });
  fireEvent.change(screen.getByLabelText('Credential field'), { target: { value: 'api_token' } });
  fireEvent.change(screen.getByLabelText('Environment variable'), {
    target: { value: 'JIRA_API_TOKEN' },
  });
};

describe('the integrations screen', () => {
  it('creates an integration by naming an environment variable, never a credential', async () => {
    const { sent, fetchImpl } = recorder();
    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('Add an integration');
    fillCreateForm();
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
      config: {},
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
    fillCreateForm();
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

  it('shows the server’s own refusal when a provider is not one this build ships', async () => {
    // The form is a thin shell over the API and the server's message names every shipped provider,
    // so a catalogue copied into the SPA — a second list to keep true — is not needed.
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if ((init?.method ?? 'GET') !== 'GET') {
        return json(
          {
            error: {
              code: 'provider_not_shipped',
              message: 'this build does not ship provider "acme-tracker"; the shipped ones are …',
            },
          },
          400,
        );
      }
      if (url.includes('/api/auth/get-session')) return json(SESSION);
      if (url.endsWith('/api/integrations')) return json(INTEGRATIONS);
      if (url.endsWith('/api/projects')) return json({ items: [] });
      return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
    }) as typeof fetch;

    render(createApp({ fetchImpl, realtime: false }).element);
    await screen.findByText('Add an integration');
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'acme-tracker' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add integration' }));
    expect(await screen.findByText('The integration was not created.')).toBeTruthy();
    await waitFor(() => {
      expect(document.body.textContent).toContain('does not ship provider');
    });
  });
});
