/**
 * The New project wizard's step 1 starts from the repository (S-25.8; product/06 § "Step 1",
 * amended 2026-11-06; research/21 § 2 S19, F11): the repository URL is asked first, the name and
 * the key are proposed from it and stay editable, a field the person edited is never overwritten
 * by a later URL change, the default branch is never invented, and the create sends what the form
 * shows with its `Idempotency-Key`. The derivation's own rules are `repository-proposal.test.ts`.
 *
 * Driven through `createApp` with a fake server, as `onboarding.test.tsx` is.
 */
import type { ProjectSummary } from '@platform/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { assertOnePrimaryAtMost } from '../ui/primary-census.js';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const CREATED: ProjectSummary = {
  id: '00000000-0000-4000-8000-0000000000a2',
  key: 'autix_core',
  name: 'autix-core',
  repo_url: 'https://gitlab.example.test/autix/autix-core.git',
  default_branch: 'develop',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 0,
  status: 'active',
  created_at: '2026-11-06T09:00:00.000Z',
  updated_at: '2026-11-06T09:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A deployment with no project yet; it records every write it is sent. */
const server = () => {
  const sent: { url: string; method: string; body: unknown; key: string | null }[] = [];
  let projects: ProjectSummary[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({
        url,
        method,
        body: JSON.parse(String(init?.body ?? '{}')),
        key: new Headers(init?.headers).get('idempotency-key'),
      });
      if (url.endsWith('/api/projects')) {
        projects = [CREATED];
        const { open_tasks: _open, spent_usd_30d: _spent, ...record } = CREATED;
        return json(record, 201);
      }
      return json({ error: { code: 'not_found', message: 'no such command' } }, 404);
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/projects')) return json({ items: projects });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
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
});

/** `/onboarding` — a new project — over the fake. */
const openNewProject = (fetchImpl: typeof fetch) => {
  window.history.pushState({}, '', '/onboarding');
  return render(createApp({ fetchImpl, realtime: false }).element);
};

const field = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;

const type = (label: string, value: string): void => {
  fireEvent.change(field(label), { target: { value } });
};

/** The four fields' values, in the form's order. */
const values = (): Record<string, string> => ({
  url: field('Repository URL').value,
  name: field('Name').value,
  key: field('Key').value,
  branch: field('Default branch').value,
});

describe('step 1 starts from the repository', () => {
  it('asks for the repository URL first, then the name, the key and the default branch', async () => {
    openNewProject(server().fetchImpl);
    const details = await screen.findByRole('region', { name: 'Project details' });
    const labels = [...details.querySelectorAll('label')].map((label) => label.textContent);
    expect(labels).toEqual(['Repository URL', 'Name', 'Key', 'Default branch']);
    // And the inputs are in that order too, so Tab walks them so.
    const inputs = within(details).getAllByRole('textbox');
    expect(inputs.map((input) => input.id)).toEqual(
      ['Repository URL', 'Name', 'Key', 'Default branch'].map((label) => field(label).id),
    );
  });

  it('proposes the name and key from the URL, explains the key, and invents no default branch', async () => {
    openNewProject(server().fetchImpl);
    await screen.findByLabelText('Repository URL');
    expect(values()).toEqual({ url: '', name: '', key: '', branch: '' });
    type('Repository URL', 'git@gitlab.example.test:autix/autix-core.git');
    expect(values()).toEqual({
      url: 'git@gitlab.example.test:autix/autix-core.git',
      name: 'autix-core',
      key: 'autix_core',
      branch: '',
    });
    // The key's hint explains the default it now holds.
    const keyHint = document.getElementById(field('Key').getAttribute('aria-describedby') ?? '');
    expect(keyHint?.textContent).toMatch(/^Proposed from the name/);
    // A later URL, nothing edited: the proposals follow it.
    type('Repository URL', 'https://gitlab.example.test/autix/billing-api.git');
    expect([values().name, values().key]).toEqual(['billing-api', 'billing_api']);
    // A URL with no repository in it proposes nothing rather than the host.
    type('Repository URL', 'https://gitlab.example.test/');
    expect([values().name, values().key]).toEqual(['', '']);
    // One beacon on the step, as before (S-23.23).
    assertOnePrimaryAtMost(document, 'the new project’s Connect step');
  });

  it('never overwrites a field the person edited when the URL changes', async () => {
    openNewProject(server().fetchImpl);
    await screen.findByLabelText('Repository URL');
    type('Repository URL', 'https://gitlab.example.test/autix/autix-core.git');
    type('Key', 'core');
    type('Repository URL', 'https://gitlab.example.test/autix/other.git');
    expect([values().name, values().key]).toEqual(['other', 'core']);

    type('Name', 'Autix Core');
    type('Repository URL', 'https://gitlab.example.test/autix/third.git');
    expect([values().name, values().key]).toEqual(['Autix Core', 'core']);

    type('Default branch', 'develop');
    type('Repository URL', 'https://gitlab.example.test/autix/fourth.git');
    expect(values().branch).toBe('develop');
  });

  it('lets an unedited key follow a name the person typed', async () => {
    openNewProject(server().fetchImpl);
    await screen.findByLabelText('Repository URL');
    type('Repository URL', 'https://gitlab.example.test/autix/ac.git');
    type('Name', 'Acme Billing');
    expect(values().key).toBe('acme_billing');
  });

  it('creates the project from what the form shows, with an Idempotency-Key', async () => {
    const { sent, fetchImpl } = server();
    openNewProject(fetchImpl);
    await screen.findByLabelText('Repository URL');
    type('Repository URL', 'https://gitlab.example.test/autix/autix-core.git');
    type('Default branch', 'develop');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    await waitFor(() => {
      expect(window.location.search).toBe('?project=autix_core&step=connect');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toEqual({
      key: 'autix_core',
      name: 'autix-core',
      repo_url: 'https://gitlab.example.test/autix/autix-core.git',
      default_branch: 'develop',
    });
    expect(sent[0]?.key).toMatch(/\S/);
  });
});
