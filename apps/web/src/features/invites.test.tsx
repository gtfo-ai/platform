/**
 * *Invite people* under Settings → People → Users (TD-022's 2026-11-26 amendment), driven through
 * `createApp` with a fake server: what an administrator sends, that the link is shown once with who
 * it lets in, that Revoke asks first, and that nobody else sees the card.
 */
import type { InviteSummary } from '@platform/contracts';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import { assertOnePrimaryAtMost, primaryLabels } from '../ui/primary-census.js';
import { INVITE_WORDS } from './invites.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'FAKE-invite-token-not-real-0000000000000000';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const invite = (overrides: Partial<InviteSummary> = {}): InviteSummary => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  role: 'member',
  state: 'pending',
  created_at: '2026-11-26T10:00:00.000Z',
  created_by: ADMIN,
  expires_at: '2026-11-27T10:00:00.000Z',
  accepted_at: null,
  accepted_user_id: null,
  revoked_at: null,
  ...overrides,
});

interface World {
  role: 'admin' | 'member';
  invites: InviteSummary[];
  created: unknown[];
  revoked: string[];
  listReads: number;
}

let world: World;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), 'http://localhost').pathname;
  if (path === '/api/auth/get-session') {
    return json({
      user: {
        id: ADMIN,
        email: 'operator@example.invalid',
        name: 'Fake Operator',
        role: world.role,
      },
      session: { id: '00000000-0000-4000-8000-000000000002' },
    });
  }
  if (path === '/api/org/users/invites' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body)) as { role: InviteSummary['role'] };
    world.created.push(body);
    const made = invite({ id: '00000000-0000-4000-8000-0000000000c2', role: body.role });
    world.invites = [made, ...world.invites];
    return json({ invite: made, url: `http://localhost/invite#${TOKEN}` }, 201);
  }
  if (path === '/api/org/users/invites') {
    world.listReads += 1;
    if (world.role !== 'admin') {
      return json({ error: { code: 'forbidden', message: 'org.users.manage needs admin' } }, 403);
    }
    return json({ items: world.invites });
  }
  const revoke = /^\/api\/org\/users\/invites\/([^/]+)\/revoke$/.exec(path);
  if (revoke !== null && init?.method === 'POST') {
    const id = revoke[1] ?? '';
    world.revoked.push(id);
    world.invites = world.invites.map((row) =>
      row.id === id ? { ...row, state: 'revoked', revoked_at: '2026-11-26T11:00:00.000Z' } : row,
    );
    return json(world.invites.find((row) => row.id === id));
  }
  if (path === '/api/org/users') {
    return json({
      items: [
        {
          id: ADMIN,
          email: 'operator@example.invalid',
          name: 'Fake Operator',
          role: 'admin',
          status: 'active',
        },
      ],
    });
  }
  if (path === '/api/version') return json({ version: '0.0.0-dev', commit: null, built_at: null });
  if (path === '/api/projects') return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  world = { role: 'admin', invites: [], created: [], revoked: [], listReads: 0 };
  window.history.pushState({}, '', '/settings/users');
});

const open = async () => {
  render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByRole('heading', { name: 'Users' });
  return userEvent.setup();
};

describe('Invite people', () => {
  it('makes a member link for 24 hours by default and shows it once, with who it lets in', async () => {
    const user = await open();
    await screen.findByText(INVITE_WORDS.empty);
    expect(primaryLabels()).toContain(INVITE_WORDS.create);
    assertOnePrimaryAtMost(document, 'the Users page');
    await user.click(screen.getByRole('button', { name: INVITE_WORDS.create }));
    await waitFor(() => {
      expect(world.created).toEqual([{ role: 'member', valid_for_hours: 24 }]);
    });
    const field = (await screen.findByLabelText(INVITE_WORDS.link)) as HTMLInputElement;
    expect(field.value).toBe(`http://localhost/invite#${TOKEN}`);
    expect(document.body.textContent).toContain('Shown once');
    expect(document.body.textContent).toContain('join as Member until');
    // The new link is listed, as waiting, with Revoke.
    const list = screen.getByRole('list', { name: INVITE_WORDS.listTitle });
    await within(list).findByText('Waiting');
  });

  it('warns about an administrator link and sends the role and hours chosen', async () => {
    const user = await open();
    expect(screen.queryByText(/becomes an administrator/)).toBeNull();
    await user.selectOptions(screen.getByLabelText(INVITE_WORDS.role), 'admin');
    expect(screen.getByText(/becomes an administrator/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText(INVITE_WORDS.validFor), '168');
    await user.click(screen.getByRole('button', { name: INVITE_WORDS.create }));
    await waitFor(() => {
      expect(world.created).toEqual([{ role: 'admin', valid_for_hours: 168 }]);
    });
  });

  it('offers exactly the six validity choices, 1 hour to 30 days', async () => {
    await open();
    const select = (await screen.findByLabelText(INVITE_WORDS.validFor)) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      '1 hour',
      '24 hours',
      '3 days',
      '7 days',
      '14 days',
      '30 days',
    ]);
    expect(select.value).toBe('24');
  });

  it('revokes a waiting link only after the confirmation', async () => {
    world.invites = [
      invite(),
      invite({
        id: '00000000-0000-4000-8000-0000000000c3',
        state: 'accepted',
        accepted_at: '2026-11-26T10:30:00.000Z',
        accepted_user_id: ADMIN,
      }),
    ];
    const user = await open();
    const list = await screen.findByRole('list', { name: INVITE_WORDS.listTitle });
    await within(list).findByText('Used');
    // Only the waiting link has Revoke.
    expect(within(list).getAllByRole('button', { name: INVITE_WORDS.revoke })).toHaveLength(1);
    await user.click(within(list).getByRole('button', { name: INVITE_WORDS.revoke }));
    const dialog = await screen.findByRole('dialog', { name: INVITE_WORDS.revokeTitle });
    expect(world.revoked).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: INVITE_WORDS.revoke }));
    await waitFor(() => {
      expect(world.revoked).toEqual(['00000000-0000-4000-8000-0000000000c1']);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await within(list).findByText('Revoked');
  });

  it('is not drawn for anybody but an administrator, and asks nothing for them', async () => {
    world.role = 'member';
    await open();
    await waitFor(() => {
      expect(document.body.textContent).toContain('1 person');
    });
    expect(screen.queryByRole('region', { name: INVITE_WORDS.title })).toBeNull();
    expect(screen.queryByRole('button', { name: INVITE_WORDS.create })).toBeNull();
    expect(world.listReads).toBe(0);
  });
});
