/**
 * *Settings → Password*, driven through `createApp` with a fake server so the real router,
 * the real API client and the real auth API decide: what is sent to Better Auth's
 * `change-password`, what the form refuses before sending, and how each answer reads.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import { CHANGE_PASSWORD_WORDS as WORDS } from './change-password.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  changes: unknown[];
  /** What `POST /api/auth/change-password` answers. */
  answer: { readonly status: number; readonly body: unknown };
  sessionReads: number;
}

let world: World;

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const path = new URL(String(input), 'http://localhost').pathname;
  if (path === '/api/auth/get-session') {
    world.sessionReads += 1;
    return json({
      user: {
        id: '00000000-0000-4000-8000-000000000001',
        email: 'operator@example.invalid',
        name: 'Fake Operator',
        role: 'member',
      },
      session: { id: '00000000-0000-4000-8000-000000000002' },
    });
  }
  if (path === '/api/auth/change-password' && init?.method === 'POST') {
    world.changes.push(JSON.parse(String(init.body)));
    return json(world.answer.body, world.answer.status);
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
  world = {
    changes: [],
    answer: { status: 200, body: { token: 'fake-token', user: {} } },
    sessionReads: 0,
  };
});

const openPasswordPage = async () => {
  window.history.pushState({}, '', '/settings/password');
  render(createApp({ fetchImpl, realtime: false }).element);
  await screen.findByRole('heading', { name: WORDS.title });
  return userEvent.setup();
};

const fill = async (
  user: ReturnType<typeof userEvent.setup>,
  current: string,
  next: string,
  confirm = next,
) => {
  await user.type(screen.getByLabelText(WORDS.current), current);
  await user.type(screen.getByLabelText(WORDS.next), next);
  await user.type(screen.getByLabelText(WORDS.confirm), confirm);
};

const save = () => screen.getByRole('button', { name: WORDS.save });

describe('Settings → Password', () => {
  it('is in the Personal group for every role, and sends nothing until the form is complete', async () => {
    const user = await openPasswordPage();
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(nav.querySelector('a[href="/settings/password"]')?.getAttribute('aria-current')).toBe(
      'page',
    );
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(WORDS.current), 'old-password-1');
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(world.changes).toEqual([]);
  });

  it('changes the password and signs out the other sessions by default', async () => {
    const user = await openPasswordPage();
    const readsBefore = world.sessionReads;
    await fill(user, 'old-password-1', 'new-password-2');
    await user.click(save());
    expect(await screen.findByText(WORDS.changedAndRevoked)).toBeTruthy();
    expect(world.changes).toEqual([
      {
        currentPassword: 'old-password-1',
        newPassword: 'new-password-2',
        revokeOtherSessions: true,
      },
    ]);
    // The fields are emptied, and the session (a new one, after a revoke) is read again.
    expect((screen.getByLabelText(WORDS.current) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(WORDS.next) as HTMLInputElement).value).toBe('');
    await waitFor(() => {
      expect(world.sessionReads).toBeGreaterThan(readsBefore);
    });
  });

  it('keeps the other sessions when the box is cleared', async () => {
    const user = await openPasswordPage();
    await fill(user, 'old-password-1', 'new-password-2');
    await user.click(screen.getByRole('checkbox', { name: new RegExp(WORDS.revokeOthers) }));
    await user.click(save());
    expect(await screen.findByText(WORDS.changed)).toBeTruthy();
    expect(world.changes).toEqual([expect.objectContaining({ revokeOtherSessions: false })]);
  });

  it.each([
    ['a short new password', 'old-password-1', 'short', 'short', WORDS.tooShort],
    [
      'two different new passwords',
      'old-password-1',
      'new-password-2',
      'new-password-3',
      WORDS.mismatch,
    ],
    [
      'the current password again',
      'old-password-1',
      'old-password-1',
      'old-password-1',
      WORDS.unchanged,
    ],
  ])('refuses %s before sending anything', async (_name, current, next, confirm, words) => {
    const user = await openPasswordPage();
    await fill(user, current, next, confirm);
    expect(await screen.findByText(words)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
    expect(world.changes).toEqual([]);
  });

  it('says a wrong current password in its own words, and keeps what was typed', async () => {
    // Better Auth's refusal: a bare `{ code, message }`, not the platform's problem document.
    world.answer = { status: 400, body: { code: 'INVALID_PASSWORD', message: 'Invalid password' } };
    const user = await openPasswordPage();
    await fill(user, 'wrong-password', 'new-password-2');
    await user.click(save());
    expect(await screen.findByText(WORDS.wrongCurrent)).toBeTruthy();
    expect(screen.queryByText(WORDS.changedAndRevoked)).toBeNull();
    expect((screen.getByLabelText(WORDS.next) as HTMLInputElement).value).toBe('new-password-2');
  });
});
