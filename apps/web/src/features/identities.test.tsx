/**
 * The provider-identity section of the organisation settings page (WP-43, criterion 8).
 *
 * Driven through `createApp` with a fake server, so the real router, query client and endpoint
 * parsers are what is asserted: the screen **calls** `GET` and `POST /api/org/identities` — which
 * nothing in the SPA did until this row, so every chat decision stayed `unmapped_identity` — and
 * it renders a provider's strings as text (BD-022).
 */
import type { IdentityCandidate, IdentityMapping, UserSummary } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  readonly candidates?: IdentityCandidate[];
  /** S-26.8a: every admin unlink's path, and what it answers (200 and the row removed by default). */
  readonly onUnlink?: (path: string) => Response | undefined;
}) => {
  const identities = options.identities ?? [{ ...MAPPED }];
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    const unlink = /\/api\/org\/identities\/([^/]+)\/([^/]+)$/.exec(url);
    if (unlink !== null && init?.method === 'DELETE') {
      const path = new URL(url, 'http://localhost').pathname;
      const answer = options.onUnlink?.(path);
      if (answer !== undefined) return answer;
      const provider = decodeURIComponent(unlink[1] ?? '');
      const externalId = decodeURIComponent(unlink[2] ?? '');
      if (Array.isArray(identities)) {
        const at = identities.findIndex(
          (row) => row.provider === provider && row.external_id === externalId,
        );
        if (at >= 0) identities.splice(at, 1);
      }
      return json({ provider, external_id: externalId });
    }
    if (url.endsWith('/api/org/identities/candidates')) {
      return json({ items: options.candidates ?? [] });
    }
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
  window.history.pushState({}, '', '/settings/identities');
});

describe('provider identities on the settings page', () => {
  it('lists the mapped accounts, with the provider’s strings as text (BD-022)', async () => {
    const { container } = render(createApp({ fetchImpl: fetchFor({}), realtime: false }).element);
    await screen.findByRole('heading', { name: 'Linked accounts' });
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
    await screen.findByRole('heading', { name: 'Linked accounts' });
    await waitFor(() => {
      expect(container.textContent).toContain('The identity mappings could not be loaded.');
    });
    expect(container.textContent).not.toContain('Nobody is mapped yet');
    expect(screen.queryByRole('button', { name: 'Save mapping' })).toBeNull();
  });
});

describe('the refused accounts nobody has mapped (WP-44, PROGRESS backlog 198)', () => {
  it('offers them, fills the form with one, and writes nothing until the admin saves', async () => {
    const posted: unknown[] = [];
    const user = userEvent.setup();
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({
          identities: [],
          candidates: [
            {
              provider: 'slack',
              external_id: 'U0FAKE<i>NEW</i>',
              deliveries: 2,
              last_seen_at: '2026-09-26T09:00:00.000Z',
            },
          ],
          onMap: (body) => {
            posted.push(body);
          },
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Accounts nobody has linked');
    // The provider's id is text (BD-022).
    expect(container.textContent).toContain('U0FAKE<i>NEW</i>');
    expect(container.querySelector('li i')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use this account' }));
    expect((screen.getByLabelText('Account id in the provider') as HTMLInputElement).value).toBe(
      'U0FAKE<i>NEW</i>',
    );
    // Proposing, never writing: choosing a candidate posted nothing.
    expect(posted).toEqual([]);
  });
});

describe('an administrator unlinks an account (S-26.8a)', () => {
  it('asks first, naming the account and the person, then sends the DELETE and re-reads the list', async () => {
    const unlinked: string[] = [];
    const user = userEvent.setup();
    render(
      createApp({
        fetchImpl: fetchFor({
          onUnlink: (path) => {
            unlinked.push(path);
            return undefined;
          },
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('U0FAKEDANA');
    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Unlink Slack account <b>dana</b> from Dana (dana@example.invalid)?',
    });
    // Nothing is sent until the act itself is pressed.
    expect(unlinked).toEqual([]);
    expect(dialog.textContent).toContain('stop counting as Dana (dana@example.invalid)’s');
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => {
      expect(unlinked).toEqual(['/api/org/identities/slack/U0FAKEDANA']);
    });
    await waitFor(() => {
      expect(screen.queryByText('U0FAKEDANA')).toBeNull();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says a machine is a machine in the confirmation', async () => {
    const user = userEvent.setup();
    render(
      createApp({
        fetchImpl: fetchFor({
          identities: [
            { ...MAPPED, kind: 'machine', user_id: null, external_id: '4242', display_name: null },
          ],
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('4242');
    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(
      await screen.findByRole('dialog', { name: 'Unlink the Slack machine account 4242?' }),
    ).toBeTruthy();
  });

  it('keeps the dialog open with the refusal in words when the account is already gone', async () => {
    const user = userEvent.setup();
    render(
      createApp({
        fetchImpl: fetchFor({
          onUnlink: () =>
            json(
              {
                error: {
                  code: 'identity_not_found',
                  message: 'no mapping exists for that account',
                },
              },
              404,
            ),
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('U0FAKEDANA');
    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    expect(await within(dialog).findByText('The account was not unlinked.')).toBeTruthy();
    // The refusal in the page's words, not the 404's status sentence.
    expect(dialog.textContent).toContain('That account is not linked any more.');
  });
});

describe('the unlinked assignees of live tasks (S-26.6, S-26.8a)', () => {
  it('says how many tasks the tracker assigns them, never "0 refused", with the name as text', async () => {
    const { container } = render(
      createApp({
        fetchImpl: fetchFor({
          identities: [],
          candidates: [
            {
              provider: 'jira-cloud',
              external_id: '5b10ac8d82e05b22cc7d4ef5',
              deliveries: 0,
              assigned_tasks: 3,
              display_name: 'Jan <b>Novák</b>',
              last_seen_at: '2026-11-07T09:00:00.000Z',
            },
            {
              provider: 'slack',
              external_id: 'U0FAKEREFUSED',
              deliveries: 2,
              last_seen_at: '2026-11-07T09:00:00.000Z',
            },
          ],
        }),
        realtime: false,
      }).element,
    );
    await screen.findByText('Accounts nobody has linked');
    const rows = within(
      screen.getByRole('list', { name: 'Unmapped provider accounts' }),
    ).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('assigned to 3 tasks');
    expect(rows[0]?.textContent).toContain('Jan <b>Novák</b>');
    expect(rows[0]?.textContent).not.toContain('refused');
    expect(container.querySelector('li b')).toBeNull();
    expect(rows[1]?.textContent).toContain('2 refused');
    expect(rows[1]?.textContent).not.toContain('assigned to');
  });
});
