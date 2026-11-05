/**
 * The sign-in page (WP-291): the bootstrap hint follows `GET /api/setup-state`, and the redesign
 * kept the form's behaviour — the credentials go to Better Auth, a refusal is said in words, and a
 * success lands on the deep link that was refused.
 *
 * Driven through `createApp` with a fake server, so the router, the query client and the endpoint
 * parsers are the real ones. The dither field's drawing is `dither-field.test.ts`; happy-dom has no
 * 2D context, so here the canvas is only asserted to be present and hidden from assistive tech.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import { SIGN_IN_HEADLINE } from './sign-in.js';

const SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const HINT = /Nobody has signed in here yet\. Sign in with the administrator email/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  /** What the setup-state read answers: a bit, or a failure. */
  setup: boolean | 'fails' | 'malformed';
  signedIn: boolean;
  signInBodies: unknown[];
  setupReads: number;
}

let world: World;

const fetchFor = () =>
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(world.signedIn ? SESSION : null);
    if (url.includes('/api/setup-state')) {
      world.setupReads += 1;
      if (world.setup === 'fails') {
        return json({ error: { code: 'internal', message: 'the database is down' } }, 500);
      }
      if (world.setup === 'malformed') return json({ pending: 'maybe' });
      return json({ first_sign_in_pending: world.setup });
    }
    if (url.includes('/api/auth/sign-in/email')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { password?: string };
      world.signInBodies.push(body);
      if (body.password === 'server-breaks') {
        return json({ error: { code: 'internal', message: 'pool exhausted on db-1' } }, 500);
      }
      if (body.password !== 'fake-password-0000') {
        return json(
          { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
          401,
        );
      }
      world.signedIn = true;
      return json({ redirect: false });
    }
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  world = { setup: true, signedIn: false, signInBodies: [], setupReads: 0 };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', '/sign-in?redirect=%2Faudit');
});

const renderPage = async (): Promise<void> => {
  render(createApp({ fetchImpl: fetchFor(), realtime: false }).element);
  await screen.findByRole('heading', { level: 1, name: SIGN_IN_HEADLINE });
};

describe('the bootstrap hint', () => {
  it('says it plainly while nobody has signed in, the variable only for administrators', async () => {
    await renderPage();
    const hint = await screen.findByText(HINT);
    expect(hint.textContent).toBe(
      'Nobody has signed in here yet. Sign in with the administrator email set when this instance was installed.',
    );
    // S-23.22: the variable's name is behind "For administrators", never in the sentence.
    expect(hint.textContent).not.toContain('APP_BOOTSTRAP_ADMIN_EMAIL');
    const note = document.querySelector('[data-admin-note="bootstrap_admin"]');
    expect(note?.closest('details')?.querySelector('summary')?.textContent).toBe(
      'For administrators',
    );
    expect(note?.textContent).toContain('APP_BOOTSTRAP_ADMIN_EMAIL');
    // The old footer's wording is gone.
    expect(document.body.textContent).not.toContain('Accounts are created by an administrator');
  });

  it('is absent once somebody has signed in', async () => {
    world.setup = false;
    await renderPage();
    await waitFor(() => {
      expect(world.setupReads).toBe(1);
    });
    expect(screen.queryByText(HINT)).toBeNull();
    expect(document.body.textContent).not.toContain('APP_BOOTSTRAP_ADMIN_EMAIL');
  });

  it.each([
    ['answers 500', 'fails'],
    ['answers a shape the contract refuses', 'malformed'],
  ] as const)('shows nothing, and no error, when the read %s', async (_label, setup) => {
    world.setup = setup;
    await renderPage();
    await waitFor(() => {
      expect(world.setupReads).toBe(1);
    });
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // Asked once: a failed hint is not retried (the app's default is one retry).
    expect(world.setupReads).toBe(1);
  });
});

describe('the form', () => {
  it('binds its labels, asks the browser for the right autofill, and draws a decorative field', async () => {
    await renderPage();
    const email = screen.getByLabelText('Email') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(email.autocomplete).toBe('username');
    expect(password.autocomplete).toBe('current-password');
    expect(screen.getByRole('img', { name: 'Agentic platform' })).toBeTruthy();
    expect(
      screen.getByText('Sign in to see what your agents are working on — and what needs you.'),
    ).toBeTruthy();
    const canvas = document.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('says a refusal in words and stays on the page', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'operator@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Those credentials were not accepted.',
    );
    expect(window.location.pathname).toBe('/sign-in');
  });

  // Review of PR #51: any other failure is our sentence, the server's text behind Technical details.
  it('says any other failure in its own words, the server’s message folded away', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'operator@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'server-breaks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Sign-in failed.');
    expect(alert.textContent).toContain('The server could not do this right now.');
    const details = alert.querySelector('details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('pool exhausted on db-1');
    const visible = alert.cloneNode(true) as HTMLElement;
    visible.querySelector('details')?.remove();
    expect(visible.textContent).not.toContain('pool exhausted');
  });

  it('signs in and lands on the deep link that was refused', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'operator@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'fake-password-0000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(window.location.pathname).toBe('/audit');
    });
    expect(world.signInBodies).toEqual([
      { email: 'operator@example.invalid', password: 'fake-password-0000' },
    ]);
  });
});
