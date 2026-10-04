/**
 * The default branch in the wizard and on the settings page (WP-139, criterion 1's ui case).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are in the path. Asserted on the **requests** the screen sends, because the defect this
 * row closes was a request that never carried the field: the wizard's create sent key, name and
 * repository URL, and every project became `main`.
 */
import type { ProjectSummary } from '@platform/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const projectRow = (branch: string): ProjectSummary => ({
  id: PROJECT,
  key: 'autix',
  name: 'Autix',
  repo_url: 'https://gitlab.example.test/acme/autix.git',
  default_branch: branch,
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 0,
  status: 'active',
  created_at: '2026-10-04T04:00:00.000Z',
  updated_at: '2026-10-04T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/**
 * A fake server: `projects` is the list, `repository` the WP-139 read, and every request with a
 * body is recorded. Anything a screen asks that this world does not answer is a 404, which the
 * screens show as a notice — none of it is what these cases assert.
 */
const server = (world: {
  projects: ProjectSummary[];
  repository: unknown;
  sent: Sent[];
}): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      world.sent.push({
        method,
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
    }
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (method === 'POST' && url.endsWith('/api/projects')) {
      const body = JSON.parse(String(init?.body)) as { default_branch: string };
      const {
        open_tasks: _open,
        spent_usd_30d: _spent,
        ...record
      } = projectRow(body.default_branch);
      world.projects.push(projectRow(body.default_branch));
      return json(record, 201);
    }
    if (method === 'PUT' && url.endsWith('/default-branch')) {
      const body = JSON.parse(String(init?.body)) as { default_branch: string };
      const {
        open_tasks: _open,
        spent_usd_30d: _spent,
        ...record
      } = projectRow(body.default_branch);
      return json({ project: record, performed: true });
    }
    if (url.includes('/repository')) return json(world.repository);
    if (url.endsWith('/api/projects')) return json({ items: world.projects });
    if (url.endsWith('/api/integrations')) return json({ items: [] });
    if (url.includes('/bindings')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the default branch (WP-139)', () => {
  it('is required by the wizard’s create, and sent with it', async () => {
    window.history.pushState({}, '', '/onboarding');
    const sent: Sent[] = [];
    render(
      createApp({
        fetchImpl: server({ projects: [], repository: null, sent }),
        realtime: false,
      }).element,
    );
    fireEvent.change(await screen.findByLabelText('Key'), { target: { value: 'autix' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Autix' } });
    fireEvent.change(screen.getByLabelText('Repository URL'), {
      target: { value: 'https://gitlab.example.test/acme/autix.git' },
    });
    const create = screen.getByRole('button', { name: 'Create project' });
    // Empty, the create is not offered: the column's `main` default is never chosen by omission.
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Default branch'), { target: { value: ' develop ' } });
    expect((create as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(sent.some((entry) => entry.method === 'POST')).toBe(true));
    expect(sent.find((entry) => entry.method === 'POST')?.body).toEqual({
      key: 'autix',
      name: 'Autix',
      repo_url: 'https://gitlab.example.test/acme/autix.git',
      default_branch: 'develop',
    });
  });

  it('prefills the change from the git provider’s answer, and sends it only when pressed', async () => {
    window.history.pushState({}, '', '/onboarding');
    const sent: Sent[] = [];
    render(
      createApp({
        fetchImpl: server({
          projects: [projectRow('main')],
          repository: {
            default_branch: 'main',
            provider: {
              provider: 'gitlab',
              default_branch: 'develop',
              ci_config: { kind: 'repository', path: '.gitlab-ci.yml' },
            },
            provider_unavailable: null,
            live_tasks: 0,
          },
          sent,
        }),
        realtime: false,
      }).element,
    );
    // The create form's field shows until the project list arrives; the change control replaces it.
    await screen.findByRole('button', { name: 'Save default branch' });
    const field = screen.getByLabelText('Default branch') as HTMLInputElement;
    expect(field.value).toBe('develop');
    expect(screen.getByText(/The stored branch is not the provider’s/)).toBeTruthy();
    expect(sent.filter((entry) => entry.url.endsWith('/default-branch'))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save default branch' }));
    await waitFor(() =>
      expect(sent.filter((entry) => entry.url.endsWith('/default-branch'))).toEqual([
        {
          method: 'PUT',
          url: expect.stringContaining(`/api/projects/${PROJECT}/default-branch`),
          body: { default_branch: 'develop' },
        },
      ]),
    );
  });

  it('says why it cannot change the branch while a task is live, rather than offering a 409', async () => {
    window.history.pushState({}, '', '/onboarding');
    const sent: Sent[] = [];
    render(
      createApp({
        fetchImpl: server({
          projects: [projectRow('main')],
          repository: {
            default_branch: 'main',
            provider: null,
            provider_unavailable:
              'this project has no git binding, so the platform cannot ask its provider',
            live_tasks: 2,
          },
          sent,
        }),
        realtime: false,
      }).element,
    );
    expect(await screen.findByText(/2 tasks are not finished/)).toBeTruthy();
    // Nothing from the provider: the field holds the stored branch.
    expect((screen.getByLabelText('Default branch') as HTMLInputElement).value).toBe('main');
    fireEvent.change(screen.getByLabelText('Default branch'), { target: { value: 'dev' } });
    const save = screen.getByRole('button', { name: 'Save default branch' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(
      screen.getByText('this project has no git binding, so the platform cannot ask its provider'),
    ).toBeTruthy();
  });
});
