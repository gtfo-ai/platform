/**
 * A component that throws must not take the application with it.
 *
 * The first three suites are about the boundary itself. The last one is the claim that matters and
 * it is made against the **whole application**: `createApp` with a collaborator that throws, the
 * real router, the real shell, the real screens — no mock of React and no mock of the router, so
 * what is asserted is the composition rather than a rehearsal of it.
 *
 * Two collaborators are used to reach the two boundaries, because they fail in different places:
 *
 * - a **clock** that throws is called by `AgentsScreen` during render, so the failure is inside a
 *   route match and the route-level boundary (`defaultErrorComponent`) is what contains it. The
 *   assertion is that the navigation is *still on screen*, which is precisely what was not true
 *   before this change;
 * - a **`matchMedia`** that throws is called by `ThemeProvider`, which sits outside
 *   `RouterProvider`, so nothing the router installs can see it. The assertion is that the
 *   document still says something at all.
 *
 * A third arrangement was tried and rejected as evidence: an `EventSource` factory that throws is
 * reached through `useTopics` **inside a screen**, so the route boundary catches it and it tests
 * the first claim twice rather than the second once.
 *
 * Both are mutation-checked: deleting `defaultErrorComponent` kills the first, deleting the
 * `ErrorBoundary` from `app/app.tsx` kills the second.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, ErrorFallback, errorMessage } from '../ui/error-boundary.js';
import { createApp } from './app.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * React reports every error a boundary catches to `console.error` as well (`onCaughtError`), which
 * is deliberate and is why an unset `onError` is not a swallowed error — but it makes the runner
 * unreadable, so it is silenced here and asserted where it matters.
 */
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const Boom = ({ message = 'boom' }: { readonly message?: string }): ReactElement => {
  throw new Error(message);
};

describe('errorMessage', () => {
  it('describes an Error, a string and a thrown object', () => {
    expect(errorMessage(new Error('the pipe broke'))).toBe('the pipe broke');
    expect(errorMessage('not an error at all')).toBe('not an error at all');
    expect(errorMessage({ toString: () => 'a thing' })).toBe('a thing');
  });

  it('neutralises a bidi override in the message (BD-022)', () => {
    // An error message can carry a provider's string — a failed parse quotes what it was given —
    // so it is untrusted text like any other, and U+202E reverses the line a human is reading.
    const message = errorMessage(new Error('parse failed at ‮slairtnederc'));
    expect(message).not.toContain('‮');
    expect(message).toContain('�');
  });

  it('bounds a message that is a payload and says how much it cut', () => {
    const message = errorMessage(new Error('x'.repeat(1000)));
    expect(message.length).toBeLessThan(500);
    expect(message).toContain('600 more characters');
  });

  it('never throws, whatever it is handed', () => {
    const hostile = new Error('unused');
    Object.defineProperty(hostile, 'message', {
      get: () => {
        throw new Error('the message itself throws');
      },
    });
    expect(errorMessage(hostile)).toBe('The error could not be described.');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(new Error(''))).toBe('No message was attached to the error.');
  });
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary area="screen">
        <p>the screen</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the screen')).toBeTruthy();
    expect(screen.queryByTestId('error-fallback')).toBeNull();
  });

  it('shows the failure and leaves everything outside it standing', () => {
    render(
      <div>
        <nav>the navigation</nav>
        <ErrorBoundary area="screen">
          <Boom message="the screen exploded" />
        </ErrorBoundary>
      </div>,
    );

    // The part of the page outside the boundary is untouched: this is the whole point.
    expect(screen.getByText('the navigation')).toBeTruthy();
    expect(screen.getByTestId('error-fallback').getAttribute('data-error-area')).toBe('screen');
    expect(screen.getByRole('alert').textContent).toContain('the screen exploded');
  });

  it('reports what it caught to the collaborator it was given', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary area="application" onError={onError}>
        <Boom message="reported once" />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'reported once' }),
      expect.anything(),
    );
  });

  it('is recoverable: Try again re-renders, and a new resetKey clears the failure', () => {
    let shouldThrow = true;
    const Sometimes = (): ReactElement => {
      if (shouldThrow) {
        throw new Error('first attempt');
      }
      return <p>the screen came back</p>;
    };

    const { rerender } = render(
      <ErrorBoundary area="screen" resetKey="/a">
        <Sometimes />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-fallback')).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('the screen came back')).toBeTruthy();

    // And the other route out: navigating (a new key) clears a failure without a reload.
    shouldThrow = true;
    rerender(
      <ErrorBoundary area="screen" resetKey="/a">
        <Sometimes />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-fallback')).toBeTruthy();
    shouldThrow = false;
    rerender(
      <ErrorBoundary area="screen" resetKey="/b">
        <Sometimes />
      </ErrorBoundary>,
    );
    expect(screen.getByText('the screen came back')).toBeTruthy();
  });

  it('offers a reload that is wired to something', () => {
    const onReload = vi.fn();
    render(
      <ErrorFallback
        area="application"
        error={new Error('x')}
        onRetry={() => {}}
        onReload={onReload}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('renders a hostile error message as text, never as markup', () => {
    render(
      <ErrorBoundary area="screen">
        <Boom message={'<img src=x onerror="window.__pwned = 1">'} />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('<img src=x onerror=');
    expect(alert.querySelector('img')).toBeNull();
  });
});

// ── The application, composed the way it ships ───────────────────────────────

const SESSION = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'admin',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  if (url.includes('/api/auth/get-session')) {
    return json(SESSION);
  }
  if (url.includes('/api/org/agents')) {
    return json({ items: [] });
  }
  if (url.includes('/api/org/inbox')) {
    return json({ questions: [], approvals: [] });
  }
  return json({ error: { code: 'not_found', message: 'the fake server has no such route' } }, 404);
}) as typeof fetch;

const openAt = (path: string): void => {
  window.history.pushState({}, '', path);
};

describe('the application when a component throws', () => {
  it('keeps the shell and the navigation when a screen fails', async () => {
    openAt('/agents');
    // `AgentsScreen` reads the clock during render, so this is a real component throwing on real
    // data flow rather than a component written to throw.
    const app = createApp({
      fetchImpl,
      realtime: false,
      now: () => {
        throw new Error('the clock is broken');
      },
    });
    render(app.element);

    const fallback = await screen.findByTestId('error-fallback');
    expect(fallback.getAttribute('data-error-area')).toBe('screen');
    expect(fallback.textContent).toContain('the clock is broken');

    // The assertion this test exists for: the app is not blank. The header, every navigation link
    // and the connection badge are still in the document, and the failure is inside `<main>`.
    expect(screen.getByRole('link', { name: 'Agentic' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    expect(screen.getByTestId('connection-status')).toBeTruthy();
    expect(document.querySelector('main')?.contains(fallback)).toBe(true);
  });

  it('recovers when the user navigates away from the screen that failed', async () => {
    openAt('/agents');
    const app = createApp({
      fetchImpl,
      realtime: false,
      now: () => {
        throw new Error('the clock is broken');
      },
    });
    render(app.element);
    await screen.findByTestId('error-fallback');

    // The navigation the previous test proved is still there is also still *usable*.
    fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));

    await waitFor(() => {
      expect(screen.getByText('Inbox')).toBeTruthy();
    });
    expect(screen.queryByTestId('error-fallback')).toBeNull();
  });

  it('does not go blank when a provider outside the router fails', async () => {
    openAt('/agents');
    // A browser API that misbehaves, which is the shape of failure the router cannot see:
    // `ThemeProvider` asks `matchMedia` for the OS preference while it renders, and it sits
    // outside `RouterProvider`. (`localStorage` is *not* usable for this — `readStoredTheme`
    // already catches a storage that throws, which is the right behaviour and no test of a
    // boundary.)
    vi.spyOn(globalThis, 'matchMedia').mockImplementation(() => {
      throw new Error('matchMedia is not available');
    });
    const onError = vi.fn();
    const app = createApp({ fetchImpl, realtime: false, onError });
    const { container } = render(app.element);

    const fallback = await screen.findByTestId('error-fallback');
    // Nothing the router installs can reach this, so the area is the application's and the whole
    // tree — shell included — has been replaced by the fallback rather than by an empty document.
    expect(fallback.getAttribute('data-error-area')).toBe('application');
    expect(fallback.textContent).toContain('matchMedia is not available');
    expect(container.textContent).not.toBe('');
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
