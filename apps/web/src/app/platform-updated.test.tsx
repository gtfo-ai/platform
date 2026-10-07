/**
 * **An upgraded server asks for a reload instead of showing a schema error** — WP-154 ruling (d),
 * criterion (3), PROGRESS backlog 487.
 *
 * The whole application through `createApp` with a fake server, so the real API client, the real
 * watch over `/api/version`, the real realtime client and the shell's banner are in the path. The
 * screen is the task page, whose read is made to fail its schema the way an old bundle's strict
 * schema fails a new server's field (an unknown key). Three worlds, one per side of the rule:
 *
 * - **a different build** — the banner, and no error text at all on the screen;
 * - **the same build** — the schema error stands, because then it is a real contract defect;
 * - **`dev`** on either side — the schema error stands: nothing to compare.
 *
 * And the second trigger: an SSE **reconnect** re-reads `/api/version` with no failed read at all.
 */
import { QueryClient } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResponse } from '../auth/session.js';
import type { EventStream } from '../realtime/client.js';
import { createApp } from './app.js';
import { createPlatformVersionWatch } from './platform-version.js';

const TASK = '00000000-0000-4000-8000-0000000000b1';
const OLD = '1111111111111111111111111111111111111111';
const NEW = '2222222222222222222222222222222222222222';
const SCHEMA_ERROR = 'did not match the published schema';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'operator@example.invalid',
    name: 'Fake Operator',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

/** The page's read fails once and stays failed: the retry's delay is not what is under test. */
const noRetry = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A server at `commit` whose task answer carries a field this bundle's schema does not know. */
const server = (state: { commit: string | null; versionReads: number }) =>
  (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.endsWith('/api/version')) {
      state.versionReads += 1;
      return json({
        version: '0.0.0-edge',
        commit: state.commit,
        built_at: null,
        // A key a newer server added: the watch's read is loose, so it still reads `commit`.
        channel: 'edge',
      });
    }
    if (url.endsWith(`/api/tasks/${TASK}`)) return json({ task: { id: TASK }, a_new_field: 1 });
    if (url.endsWith('/api/projects')) return json({ items: [] });
    if (url.endsWith('/events/subscriptions')) return json({});
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.pushState({}, '', `/tasks/${TASK}`);
});

describe('an invalid response, read against the server’s build (WP-154 (d))', () => {
  it('shows the reload banner and no error text when the server is a different build', async () => {
    const state = { commit: NEW, versionReads: 0 };
    render(
      createApp({
        queryClient: noRetry(),
        fetchImpl: server(state),
        realtime: false,
        bundleCommit: OLD,
      }).element,
    );
    const banner = await screen.findByTestId('platform-updated');
    expect(banner.textContent).toContain('The platform was updated — reload this page.');
    expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull();
    // No error text: neither the schema sentence nor the screen's own failure notice.
    await waitFor(() => {
      expect(screen.queryByText('Loading task…')).toBeNull();
    });
    expect(document.body.textContent).not.toContain(SCHEMA_ERROR);
    expect(screen.queryByText('Task could not be loaded.')).toBeNull();
    expect(screen.getAllByRole('alert')).toEqual([banner]);
  });

  it('shows the schema error, and no banner, when the server is the same build', async () => {
    const state = { commit: OLD, versionReads: 0 };
    render(
      createApp({
        queryClient: noRetry(),
        fetchImpl: server(state),
        realtime: false,
        bundleCommit: OLD,
      }).element,
    );
    expect(await screen.findByText('Task could not be loaded.')).not.toBeNull();
    expect(document.body.textContent).toContain(SCHEMA_ERROR);
    // It asked, and the answer was "same build" — a real contract defect stays visible.
    expect(state.versionReads).toBeGreaterThan(0);
    expect(screen.queryByTestId('platform-updated')).toBeNull();
  });

  it.each([
    { name: 'this bundle is dev', bundle: 'dev', commit: NEW as string | null },
    { name: 'the server is dev', bundle: OLD, commit: 'dev' as string | null },
    { name: 'the server reports no commit', bundle: OLD, commit: null as string | null },
  ])('shows the schema error, and no banner, when $name', async ({ bundle, commit }) => {
    const state = { commit, versionReads: 0 };
    render(
      createApp({
        queryClient: noRetry(),
        fetchImpl: server(state),
        realtime: false,
        bundleCommit: bundle,
      }).element,
    );
    expect(await screen.findByText('Task could not be loaded.')).not.toBeNull();
    expect(document.body.textContent).toContain(SCHEMA_ERROR);
    expect(screen.queryByTestId('platform-updated')).toBeNull();
  });
});

describe('an SSE reconnect re-reads /api/version (WP-154 (d))', () => {
  it('shows the banner after a reconnect to a server that is now a different build', async () => {
    const state = { commit: OLD as string | null, versionReads: 0 };
    const streams: { fail: () => void; open: () => void }[] = [];
    const openStream = (): EventStream => {
      const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
      const fire = (type: string) => {
        for (const listener of listeners.get(type) ?? []) {
          listener(new MessageEvent<string>(type, { data: '' }));
        }
      };
      streams.push({ fail: () => fire('error'), open: () => fire('open') });
      return {
        addEventListener: (type, listener) => {
          listeners.set(type, [...(listeners.get(type) ?? []), listener]);
        },
        close: () => undefined,
      };
    };
    // The task page retains `task:<id>`, which opens the stream; its read fails, which is fine.
    render(
      createApp({ queryClient: noRetry(), fetchImpl: server(state), openStream, bundleCommit: OLD })
        .element,
    );
    await waitFor(() => {
      expect(streams).toHaveLength(1);
    });
    act(() => {
      streams[0]?.open();
    });
    // The first connect is not a reconnect: whatever was read so far was the page's own doing.
    await screen.findByText('Task could not be loaded.');
    const before = state.versionReads;
    expect(screen.queryByTestId('platform-updated')).toBeNull();

    // The server restarts as a new build; the stream drops and the client reopens it on its backoff.
    state.commit = NEW;
    act(() => {
      streams[0]?.fail();
    });
    await waitFor(
      () => {
        expect(streams).toHaveLength(2);
      },
      { timeout: 5_000 },
    );
    act(() => {
      streams[1]?.open();
    });
    expect(await screen.findByTestId('platform-updated')).not.toBeNull();
    expect(state.versionReads).toBe(before + 1);
  });
});

describe('the watch itself', () => {
  it('shares one read between concurrent askers, stays updated, and never throws', async () => {
    let reads = 0;
    let answer: Promise<string | null> = Promise.resolve(OLD);
    const watch = createPlatformVersionWatch({
      bundleCommit: OLD,
      readServerCommit: () => {
        reads += 1;
        return answer;
      },
    });
    expect(await Promise.all([watch.check(), watch.check()])).toEqual([false, false]);
    expect(reads).toBe(1);

    answer = Promise.reject(new Error('the server is restarting'));
    expect(await watch.check()).toBe(false);

    const seen: boolean[] = [];
    const unsubscribe = watch.subscribe(() => seen.push(watch.updated()));
    answer = Promise.resolve(NEW);
    expect(await watch.check()).toBe(true);
    expect(seen).toEqual([true]);
    // Only a reload loads the new bundle, so a later "same" answer does not un-see it.
    answer = Promise.resolve(OLD);
    expect(await watch.check()).toBe(true);
    expect(seen).toEqual([true]);
    unsubscribe();
  });
});
