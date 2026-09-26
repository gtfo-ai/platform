/**
 * The provider-identity section of the organisation settings page (WP-43, criterion 8).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are what is asserted: the screen **calls** `GET` and `POST /api/org/identities` — which
 * nothing in the SPA did until this row, so every chat decision stayed `unmapped_identity` — and
 * it renders a provider's strings as text (BD-022).
 */
import type { IdentityMapping, UserSummary } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const MAINTAINER = '00000000-0000-4000-8000-000000000003';

const SESSION: SessionResponse = {
  user: { id: ADMIN, email: 'operator@example.invalid', name: 'Fake Operator', role: 'admin' },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const USERS: UserSummary[] = [
  {
    id: ADMIN,
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
    status: 'active',
  },
  {
    id: MAINTAINER,
    email: 'dana@example.invalid',
    name: 'Dana',
    role: 'maintainer',
    status: 'active',
  },
];

const MAPPED: IdentityMapping = {
  provider: 'slack',
  external_id: 'U0FAKEDANA',
  kind: 'person',
  user_id: MAINTAINER,
  display_name: '<b>dana</b>',
  created_at: '2026-09-26T10:00:00.000Z',
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fetchFor = (options: {
  readonly identities?: IdentityMapping[] | 'forbidden';
  readonly onMap?: (body: unknown, headers: Headers) => void;
}) => {
  const identities = options.identities ?? [MAPPED];
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/org/identities') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as IdentityMapping;
      options.onMap?.(body, new Headers(init.headers));
      const row: IdentityMapping = {
        provider: body.provider,
        external_id: body.external_id,
        kind: body.kind ?? 'person',
        user_id: body.kind === 'machine' ? null : body.user_id,
        display_name: body.display_name ?? null,
        created_at: '2026-09-26T10:05:00.000Z',
      };
      if (Array.isArray(identities)) identities.push(row);
      return json(row);
    }
    if (url.endsWith('/api/org/identities')) {
      return identities === 'forbidden'
        ? json({ error: { code: 'forbidden', message: 'org.users.manage needs admin' } }, 403)
        : json({ items: identities });
    }
    if (url.endsWith('/api/org/users')) return json({ items: USERS });
    if (url.endsWith('/api/org/budgets')) return json({ items: [] });
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/settings');
});

describe('provider identities on the settings page', () => {
  it('lists the mapped accounts, with the provider’s strings as text (BD-022)', async () => {
    const { container } = render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    await screen.findByText('Provider identities');
    await waitFor(() => {
      expect(container.textContent).toContain('U0FAKEDANA');
    });
    // Resolved to the person through the user list, not shown as a bare uuid.
    expect(container.textContent).toContain('dana@example.invalid');
    expect(container.textContent).toContain('<b>dana</b>');
    expect(container.querySelector('li b')).toBeNull();
  });

  it('maps a Slack account to a person through POST /api/org/identities', async () => {
    const posted: unknown[] = [];
    const keys: (string | null)[] = [];
    render(
      createApp({
        fetchImpl: fetchFor({
          identities: [],
          onMap: (body, headers) => {
            posted.push(body);
            keys.push(headers.get('idempotency-key'));
          },
        }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await screen.findByText('Nobody is mapped yet');

    await user.type(screen.getByLabelText('Account id in the provider'), 'U0FAKENEW');
    await user.selectOptions(await screen.findByLabelText('Platform user'), MAINTAINER);
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));

    await waitFor(() => {
      expect(posted).toEqual([
        { provider: 'slack', external_id: 'U0FAKENEW', kind: 'person', user_id: MAINTAINER },
      ]);
    });
    // The route takes no key, and says why (an upsert on the natural key).
    expect(keys).toEqual([null]);
    await screen.findByText('U0FAKENEW');
  });

  it('declares a machine with no user, which acts for nobody', async () => {
    const posted: unknown[] = [];
    render(
      createApp({
        fetchImpl: fetchFor({ identities: [], onMap: (body) => posted.push(body) }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await screen.findByText('Nobody is mapped yet');

    await user.selectOptions(screen.getByLabelText('Provider'), 'gitlab');
    await user.type(screen.getByLabelText('Account id in the provider'), '4242');
    await user.click(screen.getByLabelText('A machine (a bot — acts for nobody)'));
    await user.click(screen.getByRole('button', { name: 'Save mapping' }));

    await waitFor(() => {
      expect(posted).toEqual([{ provider: 'gitlab', external_id: '4242', kind: 'machine' }]);
    });
  });

  it('does not submit a person with no user chosen', async () => {
    const posted: unknown[] = [];
    render(
      createApp({
        fetchImpl: fetchFor({ identities: [], onMap: (body) => posted.push(body) }),
        realtime: false,
      }).element,
    );
    const user = userEvent.setup();
    await screen.findByText('Nobody is mapped yet');
    await user.type(screen.getByLabelText('Account id in the provider'), 'U0FAKENEW');

    expect(screen.getByRole('button', { name: 'Save mapping' })).toHaveProperty('disabled', true);
    expect(posted).toEqual([]);
  });

  it('names the admin requirement instead of drawing an empty list for a non-admin', async () => {
    const { container } = render(
      createApp({ fetchImpl: fetchFor({ identities: 'forbidden' }), realtime: false }).element,
    );
    await screen.findByText('Provider identities');
    await waitFor(() => {
      expect(container.textContent).toContain('The identity mappings could not be loaded.');
    });
    expect(container.textContent).not.toContain('Nobody is mapped yet');
    expect(screen.queryByRole('button', { name: 'Save mapping' })).toBeNull();
  });
});
