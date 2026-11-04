/**
 * The Workers screen and the device-approval page (WP-280, TD-031 §10c), driven through `createApp`
 * with a fake server, so the real router, query client and endpoint parsers are asserted: the page
 * **calls** `POST /api/workers/device/lookup` (the code in the body, never the URL) before any decision and shows the requesting address,
 * user agent and the code's age as text with the phishing warning; a code older than five minutes
 * cannot be approved without the second confirmation, and the approval it then sends carries
 * `confirm_stale: true`; the Workers screen lists and revokes through `DELETE /api/workers/:id`.
 */
import type { WorkerDeviceLookup, WorkerSummary } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { formatCodeAge, PHISHING_WARNING, typedUserCode } from './workers.js';

const SESSION: SessionResponse = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'dev@example.invalid',
    name: 'Fake Developer',
    role: 'member',
  },
  session: { id: '00000000-0000-4000-8000-000000000002' },
};

const HOSTILE_AGENT = 'curl/8 <img src=x onerror="window.__pwned=1">';

const lookup = (overrides: Partial<WorkerDeviceLookup> = {}): WorkerDeviceLookup => ({
  user_code: 'BCDF-GHJK',
  requested_ip: '198.51.100.7',
  user_agent: HOSTILE_AGENT,
  requested_at: '2026-11-04T12:00:00.000Z',
  expires_at: '2026-11-04T12:10:00.000Z',
  age_seconds: 75,
  needs_confirmation: false,
  ...overrides,
});

const worker = (overrides: Partial<WorkerSummary> = {}): WorkerSummary => ({
  id: '00000000-0000-4000-8000-0000000002a0',
  name: 'alice-laptop',
  user: { id: SESSION.user.id, email: 'dev@example.invalid', name: 'Fake Developer' },
  created_at: '2026-11-04T12:00:00.000Z',
  last_seen_at: null,
  protocol_version: 1,
  image_digests: [`sha256:${'a'.repeat(64)}`],
  state: 'active',
  revoked_at: null,
  paused_until: null,
  paused_reason: null,
  concurrency: 1,
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const fetchFor = (device: WorkerDeviceLookup | 'missing', workers: WorkerSummary[] = []) => {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/api/auth/get-session')) return json(SESSION);
    if (url.includes('/api/workers/device/approve')) {
      sent.push({ method, url, body: JSON.parse(String(init?.body)) });
      const body = JSON.parse(String(init?.body)) as { decision: string };
      return json({
        decision: body.decision,
        decided_at: '2026-11-04T12:02:00.000Z',
        performed: true,
      });
    }
    if (url.includes('/api/workers/device/lookup')) {
      sent.push({ method, url, body: JSON.parse(String(init?.body)) });
      return device === 'missing'
        ? json({ error: { code: 'device_code_not_found', message: 'no pending code' } }, 404)
        : json(device);
    }
    if (url.includes('/api/workers/') && method === 'DELETE') {
      sent.push({ method, url, body: null });
      return json({
        worker_id: workers[0]?.id,
        performed: true,
        revoked_at: '2026-11-04T12:05:00.000Z',
        expired_runs: 0,
      });
    }
    if (url.endsWith('/api/workers')) return json({ items: workers, scope: 'own' });
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  return { sent, fetchImpl };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the approval page', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/workers/approve');
  });

  it('shows the requesting address, the user agent as text and the age, with the warning', async () => {
    const { fetchImpl, sent } = fetchFor(lookup());
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByText(PHISHING_WARNING)).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Code shown by the machine'), 'bcdf ghjk');
    await waitFor(() => {
      expect(container.querySelector('[data-device-ip]')?.textContent).toBe('198.51.100.7');
    });
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).not.toContain('BCDF');
    expect(sent[0]?.body).toEqual({ user_code: 'BCDF-GHJK' });
    expect(container.querySelector('[data-device-agent]')?.textContent).toBe(HOSTILE_AGENT);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-device-age]')?.textContent).toBe('1 min 15 s');
    expect(screen.queryByText(/older than five minutes/)).toBeNull();

    const approve = screen.getByRole('button', { name: 'Approve' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Name this machine'), 'alice-laptop');
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    await user.click(approve);
    await waitFor(() => {
      expect(screen.getByText(/^Approved\./)).toBeTruthy();
    });
    expect(sent.at(-1)?.body).toEqual({
      decision: 'approve',
      user_code: 'BCDF-GHJK',
      name: 'alice-laptop',
      confirm_stale: false,
    });
  });

  it('needs a second confirmation for a code older than five minutes, and sends it', async () => {
    const { fetchImpl, sent } = fetchFor(lookup({ age_seconds: 400, needs_confirmation: true }));
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Code shown by the machine'), 'BCDF-GHJK');
    const confirm = await screen.findByRole('checkbox');
    await user.type(screen.getByLabelText('Name this machine'), 'alice-laptop');
    const approve = screen.getByRole('button', { name: 'Approve' });
    // Named, but not confirmed: still refused here (and by the server).
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await user.click(confirm);
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    await user.click(approve);
    await waitFor(() => {
      expect(sent.at(-1)?.body).toMatchObject({ decision: 'approve', confirm_stale: true });
    });
  });

  it('denies without a name', async () => {
    const { fetchImpl, sent } = fetchFor(lookup());
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Code shown by the machine'), 'BCDFGHJK');
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ decision: 'deny', user_code: 'BCDF-GHJK' });
    });
  });

  it('looks nothing up until a whole code is typed, and names an unknown one', async () => {
    const { fetchImpl, sent } = fetchFor('missing');
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    const input = await screen.findByLabelText('Code shown by the machine');
    await user.type(input, 'BCDF-GHJ');
    expect(sent).toEqual([]);
    await user.type(input, 'K');
    expect(await screen.findByText(/No pending code matches/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });
});

describe('the Workers screen', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/workers');
  });

  it('lists a worker with its protocol and digests, and revokes it through DELETE', async () => {
    const { fetchImpl, sent } = fetchFor('missing', [worker()]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector(`[data-worker="${worker().id}"]`)).not.toBeNull();
    });
    const card = container.querySelector(`[data-worker="${worker().id}"]`)?.textContent ?? '';
    expect(card).toContain('alice-laptop');
    expect(card).toContain('active');
    expect(card).toContain(`sha256:${'a'.repeat(64)}`);
    expect(card).toContain('never');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.method === 'DELETE')).toBe(true);
    });
    expect(sent.find((entry) => entry.method === 'DELETE')?.url).toContain(
      `/api/workers/${worker().id}`,
    );
    expect(await screen.findByText('The worker is revoked.')).toBeTruthy();
  });

  it('offers no revoke for a revoked worker', async () => {
    const { fetchImpl } = fetchFor('missing', [
      worker({ state: 'revoked', revoked_at: '2026-11-04T12:05:00.000Z' }),
    ]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-worker]')).not.toBeNull();
    });
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});

describe('the page’s pure helpers', () => {
  it('normalises a typed code and refuses a partial or foreign one', () => {
    expect(typedUserCode('bcdf ghjk')).toBe('BCDF-GHJK');
    expect(typedUserCode('BCDF-GHJ')).toBeNull();
    expect(typedUserCode('ACDF-GHJK')).toBeNull();
  });

  it('formats a code age', () => {
    expect(formatCodeAge(9)).toBe('9 s');
    expect(formatCodeAge(301)).toBe('5 min 1 s');
  });
});
