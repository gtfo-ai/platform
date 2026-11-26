/**
 * The invite page, `/invite#<token>` (TD-022's 2026-11-26 amendment), driven through `createApp`
 * with a fake server: the token goes in POST bodies from the fragment, the form refuses what the
 * server would before it sends, accept is followed by Better Auth's sign-in, and every way a link
 * can fail to work has its own sentence.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import { inviteTokenFrom, INVITE_PAGE_WORDS as WORDS } from './invite.js';

const TOKEN = 'FAKE-invite-token-not-real-0000000000000000';
const PASSWORD = 'a-fake-invite-password-1234';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  inspect: { readonly status: number; readonly body: unknown };
  accept: { readonly status: number; readonly body: unknown };
  signIn: { readonly status: number; readonly body: unknown };
  inspected: unknown[];
  accepted: unknown[];
  signedIn: unknown[];
  urls: string[];
}

let world: World;

const pending = { role: 'member', state: 'pending', expires_at: '2026-11-27T10:00:00.000Z' };

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  world.urls.push(url);
  const path = new URL(url, 'http://localhost').pathname;
  if (path === '/api/invites/inspect') {
    world.inspected.push(JSON.parse(String(init?.body)));
    return json(world.inspect.body, world.inspect.status);
  }
  if (path === '/api/invites/accept') {
    world.accepted.push(JSON.parse(String(init?.body)));
    return json(world.accept.body, world.accept.status);
  }
  if (path === '/api/auth/sign-in/email') {
    world.signedIn.push(JSON.parse(String(init?.body)));
    return json(world.signIn.body, world.signIn.status);
  }
  if (path === '/api/auth/get-session') {
    return world.signedIn.length > 0 && world.signIn.status === 200
      ? json({
          user: {
            id: '00000000-0000-4000-8000-0000000000b2',
            email: 'new.person@example.invalid',
            name: 'New Person',
            role: 'member',
          },
          session: { id: '00000000-0000-4000-8000-000000000002' },
        })
      : json(null);
  }
  if (path === '/api/version') return json({ version: '0.0.0-dev', commit: null, built_at: null });
  if (path === '/api/projects') return json({ items: [] });
  return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
}) as typeof fetch;

const refusal = (status: number, code: string) => ({
  status,
  body: { error: { code, message: code } },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  world = {
    inspect: { status: 200, body: pending },
    accept: {
      status: 201,
      body: {
        user_id: '00000000-0000-4000-8000-0000000000b2',
        email: 'new.person@example.invalid',
        role: 'member',
      },
    },
    signIn: { status: 200, body: { token: 'fake-session-token', user: {} } },
    inspected: [],
    accepted: [],
    signedIn: [],
    urls: [],
  };
});

const openInvite = (hash = `#${TOKEN}`) => {
  window.history.pushState({}, '', `/invite${hash}`);
  render(createApp({ fetchImpl, realtime: false }).element);
  return userEvent.setup();
};

const fill = async (
  user: ReturnType<typeof userEvent.setup>,
  password = PASSWORD,
  confirm = password,
) => {
  await user.type(await screen.findByLabelText(WORDS.email), 'new.person@example.invalid');
  await user.type(screen.getByLabelText(WORDS.name), 'New Person');
  await user.type(screen.getByLabelText(WORDS.password), password);
  await user.type(screen.getByLabelText(WORDS.confirm), confirm);
};

const submit = () => screen.getByRole('button', { name: WORDS.submit });

describe('the invite page', () => {
  it('reads the token from the fragment, sends it only in bodies, and says the role', async () => {
    openInvite();
    await screen.findByText(/join as a member/);
    expect(world.inspected).toEqual([{ token: TOKEN }]);
    expect(world.urls.some((url) => url.includes(TOKEN))).toBe(false);
  });

  it('accepts, signs in with the same credentials, and opens Home', async () => {
    const replaced = vi.spyOn(window.history, 'replaceState');
    const user = openInvite();
    await fill(user);
    await user.click(submit());
    await waitFor(() => {
      expect(world.accepted).toEqual([
        {
          token: TOKEN,
          email: 'new.person@example.invalid',
          name: 'New Person',
          password: PASSWORD,
        },
      ]);
    });
    await waitFor(() => {
      expect(world.signedIn).toEqual([{ email: 'new.person@example.invalid', password: PASSWORD }]);
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });
    expect(replaced).toHaveBeenCalledWith(null, '', '/invite');
  });

  it('refuses a short password and a mismatch before sending anything', async () => {
    const user = openInvite();
    await fill(user, 'eleven-char');
    expect(screen.getByText(WORDS.tooShort)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const again = openInvite();
    await fill(again, PASSWORD, `${PASSWORD}x`);
    expect(screen.getByText(WORDS.mismatch)).toBeTruthy();
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    expect(world.accepted).toEqual([]);
  });

  it('says an email in use, and keeps the form so another can be tried', async () => {
    world.accept = refusal(409, 'email_taken');
    const user = openInvite();
    await fill(user);
    await user.click(submit());
    await screen.findByText(WORDS.emailTaken);
    expect(screen.getByRole('button', { name: WORDS.submit })).toBeTruthy();
    expect(world.signedIn).toEqual([]);
  });

  it('never offers the form again once the account exists but the sign-in failed', async () => {
    world.signIn = { status: 401, body: { code: 'INVALID', message: 'no' } };
    const user = openInvite();
    await fill(user);
    await user.click(submit());
    await screen.findByText(WORDS.createdNotSignedIn);
    // The spent token left this tab's history entry.
    expect(window.location.pathname).toBe('/invite');
    expect(window.location.hash).toBe('');
    expect(screen.queryByRole('button', { name: WORDS.submit })).toBeNull();
    expect(screen.getByRole('link', { name: WORDS.signIn })).toBeTruthy();
  });

  it.each([
    ['used', { ...pending, state: 'accepted' }, WORDS.used],
    ['expired', { ...pending, state: 'expired' }, WORDS.expired(pending.expires_at)],
    ['revoked', { ...pending, state: 'revoked' }, WORDS.revoked],
  ] as const)('says a %s link plainly, with no form', async (_name, body, sentence) => {
    world.inspect = { status: 200, body };
    openInvite();
    await screen.findByText(sentence);
    expect(sentence).toContain('Ask an administrator for a new link');
    expect(screen.queryByRole('button', { name: WORDS.submit })).toBeNull();
  });

  it('says an unknown link plainly', async () => {
    world.inspect = refusal(404, 'invite_not_found');
    openInvite();
    await screen.findByText(WORDS.notFound);
  });

  it('says a missing token without asking the server', async () => {
    openInvite('');
    await screen.findByText(WORDS.missing);
    expect(world.inspected).toEqual([]);
  });

  it('switches to the ending an accept was refused with', async () => {
    world.accept = refusal(410, 'invite_used');
    const user = openInvite();
    await fill(user);
    await user.click(submit());
    await screen.findByText(WORDS.used);
  });
});

describe('inviteTokenFrom', () => {
  it('takes the fragment’s token and refuses anything else', () => {
    expect(inviteTokenFrom(`#${TOKEN}`)).toBe(TOKEN);
    expect(inviteTokenFrom('')).toBeNull();
    expect(inviteTokenFrom('#')).toBeNull();
    expect(inviteTokenFrom('#has spaces')).toBeNull();
    expect(inviteTokenFrom(`#${'a'.repeat(129)}`)).toBeNull();
  });
});
