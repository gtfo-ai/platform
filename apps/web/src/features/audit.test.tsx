/**
 * The audit log in the new language (S-23.11b): a row is **avatar · who · what, in words · when**,
 * the raw diff and the entity's id sit behind *Details*, and the entity filter is a menu of the
 * known types whose choice is what the server is asked for.
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are what is asserted. The diff and the keys are opaque text from the server (BD-022): a
 * planted element must reach the page as characters. Since S-25.7 (research/21 F15) a project's row
 * names the project and the *Project* filter keeps one project's rows — over the loaded pages, on the
 * client, over the page on screen, because the read filters by type only.
 */
import type { OrgAuditResponse } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const ADA = '00000000-0000-4000-8000-0000000000b1';

const SESSION: SessionResponse = {
  user: { id: ADA, email: 'ada@example.invalid', name: 'Ada Lovelace', role: 'viewer' },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ACME = '00000000-0000-4000-8000-0000000000a1';
const WEB = '00000000-0000-4000-8000-0000000000a2';

const projectRow = (id: string, key: string, name: string) => ({
  id,
  key,
  name,
  repo_url: `https://git.example.test/acme/${key}.git`,
  default_branch: 'main',
  agentic_dir: '.agentic',
  knowledge_dir: '.agentic/knowledge',
  autonomy_level: 'supervised',
  readiness_level: 0,
  status: 'active',
  created_at: '2026-09-13T04:00:00.000Z',
  updated_at: '2026-09-13T04:00:00.000Z',
  open_tasks: 0,
  spent_usd_30d: 0,
});

const AUDIT: OrgAuditResponse = {
  items: [
    {
      id: '00000000-0000-4000-8000-0000000000e1',
      entity_type: 'project',
      entity_id: '00000000-0000-4000-8000-0000000000a1',
      user_id: ADA,
      diff: { autonomy_level: ['assist', 'supervised'] },
      created_at: '2026-09-29T08:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-0000000000e2',
      entity_type: 'retention_policy',
      entity_id: null,
      user_id: null,
      diff: { '<img src=x>': 'changed' },
      created_at: '2026-09-28T08:00:00.000Z',
    },
    {
      id: '00000000-0000-4000-8000-0000000000e3',
      entity_type: 'project',
      entity_id: WEB,
      user_id: ADA,
      diff: { autonomy_level: ['observe', 'assist'] },
      created_at: '2026-09-27T08:00:00.000Z',
    },
  ],
  next_cursor: null,
};

let requested: string[] = [];

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) return json(SESSION);
  if (url.includes('/api/org/audit')) {
    requested.push(url);
    return json(AUDIT);
  }
  if (url.endsWith('/api/org/users')) {
    return json({
      items: [
        {
          id: ADA,
          email: 'ada@example.invalid',
          name: 'Ada Lovelace',
          role: 'admin',
          status: 'active',
        },
      ],
    });
  }
  if (url.endsWith('/api/projects')) {
    // A project name is operator text: the hostile one must reach the row as characters.
    return json({
      items: [projectRow(ACME, 'acme', 'ACME <b>API</b>'), projectRow(WEB, 'web', 'Web')],
    });
  }
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  requested = [];
  window.history.pushState({}, '', '/audit');
});

const renderScreen = async (): Promise<HTMLElement> => {
  const { container } = render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByRole('list', { name: 'Audit entries' });
  return container;
};

describe('the audit log (S-23.11b)', () => {
  it('says who changed what in words, with the person resolved from the user list', async () => {
    await renderScreen();
    const list = await screen.findByRole('list', { name: 'Audit entries' });
    await waitFor(() => {
      // S-25.7: the row names its project, as text.
      expect(list.textContent).toContain(
        'Ada Lovelace changed the settings of ACME <b>API</b>: Autonomy level',
      );
    });
    expect(list.querySelector('b')).toBeNull();
    // An unknown type is title-cased, never dropped; a removed user is said, never invented.
    expect(list.textContent).toContain('A removed account changed Retention Policy');
    expect(list.querySelectorAll('[data-avatar]')).toHaveLength(3);
  });

  it('keeps the raw diff and the id behind Details, as text', async () => {
    const container = await renderScreen();
    const details = await waitFor(() => {
      const found = container.querySelectorAll('details');
      expect(found).toHaveLength(3);
      return found;
    });
    expect(details[0]?.open).toBe(false);
    expect(details[0]?.textContent).toContain('autonomy_level');
    expect(details[0]?.textContent).toContain('00000000-0000-4000-8000-0000000000a1');
    // The planted key is characters, never an element.
    expect(details[1]?.textContent).toContain('<img src=x>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('asks the server for the type chosen in the filter menu, and goes back to every type', async () => {
    await renderScreen();
    const user = userEvent.setup();
    expect(requested.at(-1)).not.toContain('entity_type');
    await user.click(screen.getByRole('button', { name: 'Filter by type: All types' }));
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Integration' }));
    await waitFor(() => {
      expect(requested.at(-1)).toContain('entity_type=integration');
    });
    await user.click(screen.getByRole('button', { name: 'Filter by type: Integration' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'All types' }));
    // Every type's page was read first and is answered from the cache: the label is the evidence.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Filter by type: All types' })).toBeTruthy();
    });
  });

  it('keeps one project’s rows when a project is picked, asking the server for its type (S-25.7)', async () => {
    await renderScreen();
    const user = userEvent.setup();
    const list = await screen.findByRole('list', { name: 'Audit entries' });
    await waitFor(() => {
      expect(list.querySelectorAll('[data-audit-project]')).toHaveLength(2);
    });
    await user.click(screen.getByRole('button', { name: 'Filter by project: All projects' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Web' }));
    // The read filters by type only: the project's rows are of type `project`.
    await waitFor(() => {
      expect(requested.at(-1)).toContain('entity_type=project');
    });
    await waitFor(() => {
      expect(list.querySelectorAll('[data-audit-project]')).toHaveLength(1);
    });
    expect(list.textContent).toContain('changed the settings of Web: Autonomy level');
    expect(list.textContent).not.toContain('ACME');
    expect(list.textContent).not.toContain('Retention Policy');
    // The filter says it is over the loaded entries, not the whole log.
    // *Load older entries* replaces the page, so the filter covers the page on screen (review of #86).
    expect(document.querySelector('[data-audit-project-filter]')?.textContent).toContain(
      'on this page',
    );
  });
});
