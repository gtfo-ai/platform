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
import { formatCodeAge, PHISHING_WARNING, typedUserCode, workerInstallLines } from './workers.js';

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
  manually_paused_at: null,
  claim_projects: null,
  paused_reason: null,
  paused_until_estimated: false,
  concurrency: 1,
  running: [],
  last_update: null,
  claim_blockers: [],
  can_claim: true,
  last_claimed_at: null,
  ...overrides,
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const fetchFor = (
  device: WorkerDeviceLookup | 'missing',
  workers: WorkerSummary[] = [],
  timezone = 'UTC',
) => {
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
    if (url.endsWith('/api/workers')) return json({ items: workers, scope: 'own', timezone });
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

  it('prefills the code from ?code=, strips it from the address, keeps every warning, and approves only on the press (WP-294 (5))', async () => {
    window.history.pushState({}, '', '/workers/approve?code=bcdf-ghjk');
    const { fetchImpl, sent } = fetchFor(lookup());
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    const field = (await screen.findByLabelText('Code shown by the machine')) as HTMLInputElement;
    expect(field.value).toBe('BCDF-GHJK');
    await waitFor(() => {
      expect(window.location.search).not.toContain('code=');
    });
    expect(window.location.pathname).toBe('/workers/approve');
    // The origin details and the warning, exactly as for a typed code.
    expect(screen.getByText(PHISHING_WARNING)).toBeTruthy();
    await waitFor(() => {
      expect(container.querySelector('[data-device-ip]')?.textContent).toBe('198.51.100.7');
    });
    expect(sent.map((call) => call.url).some((url) => url.includes('/approve'))).toBe(false);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Name this machine'), 'alice-laptop');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toMatchObject({ decision: 'approve', user_code: 'BCDF-GHJK' });
    });
  });

  it('ignores a ?code= that is not a code', async () => {
    window.history.pushState({}, '', '/workers/approve?code=%3Cscript%3E');
    const { fetchImpl, sent } = fetchFor(lookup());
    render(createApp({ fetchImpl, realtime: false }).element);
    const field = (await screen.findByLabelText('Code shown by the machine')) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(sent).toEqual([]);
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

  it('shows the two install lines, built from the page’s own origin (TD-031’s 2026-11-05 amendment §4)', async () => {
    const { fetchImpl } = fetchFor('missing', []);
    render(createApp({ fetchImpl, realtime: false }).element);
    const download = await screen.findByLabelText('1. Download the worker’s compose file');
    expect((download as HTMLInputElement).value).toBe(
      `mkdir agentic-worker && cd agentic-worker && curl -fsSo compose.yaml ${window.location.origin}/api/worker/v1/compose.yml`,
    );
    // No Claude token on the command line any more: the worker's page asks for it (WP-294).
    const start = screen.getByLabelText(
      '2. Start it, then open http://127.0.0.1:7357 on that machine',
    );
    expect((start as HTMLInputElement).value).toBe('docker compose up -d');
  });

  it('lists a worker with its state, protocol and digests, and revokes it through a dialog and DELETE', async () => {
    const { fetchImpl, sent } = fetchFor('missing', [worker()]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector(`[data-worker="${worker().id}"]`)).not.toBeNull();
    });
    const row = container.querySelector(`[data-worker="${worker().id}"]`)?.closest('li');
    const text = row?.textContent ?? '';
    expect(text).toContain('alice-laptop');
    // Never seen: not online, and said in words rather than as `active` (S-23.11a).
    expect(text).toContain('Offline');
    expect(text).not.toContain('active');
    expect(text).toContain('never seen');
    expect(text).toContain('protocol 1');
    expect(text).toContain('0 of 1 busy');
    // The digests are behind Details, still in the row.
    expect(text).toContain(`sha256:${'a'.repeat(64)}`);
    expect(row?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Offline');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    // The first press only asks, and says what revoking does.
    const dialog = await screen.findByRole('dialog', { name: 'Revoke alice-laptop?' });
    expect(dialog.textContent).toContain('planned again');
    expect(sent.some((entry) => entry.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Revoke worker' }));
    await waitFor(() => {
      expect(sent.some((entry) => entry.method === 'DELETE')).toBe(true);
    });
    expect(sent.find((entry) => entry.method === 'DELETE')?.url).toContain(
      `/api/workers/${worker().id}`,
    );
    expect(await screen.findByText('The worker is revoked.')).toBeTruthy();
  });

  it('holds the Revoke trigger while a revoke is in flight', async () => {
    const { fetchImpl: base } = fetchFor('missing', [worker()]);
    let release: (() => void) | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return base(input, init);
    }) as typeof fetch;
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: 'Revoke' });
    await user.click(trigger);
    await user.click(await screen.findByRole('button', { name: 'Revoke worker' }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });
    release?.();
    expect(await screen.findByText('The worker is revoked.')).toBeTruthy();
  });

  it('sends nothing when the revoke is cancelled', async () => {
    const { fetchImpl, sent } = fetchFor('missing', [worker()]);
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(sent.some((entry) => entry.method === 'DELETE')).toBe(false);
  });

  it('says online, paused and how many slots are busy', async () => {
    const NOW = Date.parse('2026-11-04T12:10:00.000Z');
    const online = worker({
      last_seen_at: '2026-11-04T12:09:30.000Z',
      concurrency: 2,
      running: [
        {
          run_id: '00000000-0000-4000-8000-0000000003a0',
          task_id: '00000000-0000-4000-8000-0000000003a1',
          project_id: '00000000-0000-4000-8000-0000000003a2',
        },
      ],
    });
    const paused = worker({
      id: '00000000-0000-4000-8000-0000000002a1',
      name: 'bob-desktop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      paused_until: '2026-11-04T13:00:00.000Z',
      manually_paused_at: null,
      paused_reason: 'usage_limited',
    });
    // WP-292: the owner's hold from the worker's local page.
    const held = worker({
      id: '00000000-0000-4000-8000-0000000002a2',
      name: 'carol-laptop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      manually_paused_at: '2026-11-04T12:05:00.000Z',
    });
    const { fetchImpl } = fetchFor('missing', [online, paused, held]);
    const { container } = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-worker]')).toHaveLength(3);
    });
    const rowOf = (id: string) =>
      container.querySelector(`[data-worker="${id}"]`)?.closest('li')?.textContent ?? '';
    expect(rowOf(online.id)).toContain('Online');
    expect(rowOf(online.id)).toContain('1 of 2 busy');
    expect(rowOf(online.id)).toContain('seen just now');
    // WP-285: the same sentence the worker's own page says, the time in the organisation's zone.
    expect(rowOf(paused.id)).toContain('Paused — usage limit until 13:00');
    expect(rowOf(paused.id)).not.toContain('usage_limited');
    expect(rowOf(paused.id)).not.toContain('Online');
    expect(rowOf(held.id)).toContain('Paused by its owner');
    expect(rowOf(held.id)).not.toContain('Online');
  });

  it('shows each worker’s claim scope, read only: every project, pick only, named projects (WP-293)', async () => {
    const every = worker();
    const pickOnly = worker({
      id: '00000000-0000-4000-8000-0000000002c1',
      name: 'gil-laptop',
      claim_projects: [],
    });
    const named = worker({
      id: '00000000-0000-4000-8000-0000000002c2',
      name: 'hana-desktop',
      claim_projects: [
        { id: '00000000-0000-4000-8000-0000000002d1', key: 'ACME' },
        { id: '00000000-0000-4000-8000-0000000002d2', key: null },
      ],
    });
    const { fetchImpl, sent } = fetchFor('missing', [every, pickOnly, named]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-worker]')).toHaveLength(3);
    });
    const scopeOf = (id: string) =>
      container.querySelector(`[data-worker="${id}"] [data-claim-scope]`)?.textContent;
    expect(scopeOf(every.id)).toBe('takes every project');
    expect(scopeOf(pickOnly.id)).toBe('pick only');
    expect(scopeOf(named.id)).toBe('takes ACME, a removed project');
    // Read only: the screen offers no way to change it.
    expect(sent.some((entry) => entry.method === 'PUT')).toBe(false);
    expect(screen.queryByRole('button', { name: /scope/i })).toBeNull();
  });

  it('shows a usage pause in the organisation’s zone, *about* for a default one, and a past one as none (WP-285)', async () => {
    const NOW = Date.parse('2026-11-04T12:10:00.000Z');
    const named = worker({
      id: '00000000-0000-4000-8000-0000000002b1',
      name: 'dana-laptop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      paused_until: '2026-11-04T13:00:00.000Z',
      paused_reason: 'usage_limited',
    });
    const guessed = worker({
      id: '00000000-0000-4000-8000-0000000002b2',
      name: 'eve-laptop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      paused_until: '2026-11-04T13:30:00.000Z',
      paused_reason: 'usage_limited',
      paused_until_estimated: true,
    });
    const lapsed = worker({
      id: '00000000-0000-4000-8000-0000000002b3',
      name: 'finn-laptop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      paused_until: '2026-11-04T11:00:00.000Z',
      paused_reason: 'usage_limited',
    });
    // A person's hold and a limit at once: the person's hold is what the row says.
    const both = worker({
      id: '00000000-0000-4000-8000-0000000002b4',
      name: 'gus-laptop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      paused_until: '2026-11-04T13:00:00.000Z',
      paused_reason: 'usage_limited',
      manually_paused_at: '2026-11-04T12:00:00.000Z',
    });
    const { fetchImpl } = fetchFor('missing', [named, guessed, lapsed, both], 'Europe/Prague');
    const { container } = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-worker]')).toHaveLength(4);
    });
    const rowOf = (id: string) =>
      container.querySelector(`[data-worker="${id}"]`)?.closest('li')?.textContent ?? '';
    expect(rowOf(named.id)).toContain('Paused — usage limit until 14:00');
    expect(rowOf(guessed.id)).toContain('Paused — usage limit until about 14:30');
    expect(rowOf(lapsed.id)).toContain('Online');
    expect(rowOf(lapsed.id)).not.toContain('Paused');
    expect(rowOf(both.id)).toContain('Paused by its owner');
  });

  it('shows the last update its updater reported, its own words as text (WP-287 (4))', async () => {
    const NOW = Date.parse('2026-11-04T12:10:00.000Z');
    const digests = (hex: string) => ({
      platform: `sha256:${hex.repeat(64)}`,
      platform_launcher: `sha256:${'1'.repeat(64)}`,
      platform_runtime: `sha256:${'2'.repeat(64)}`,
      platform_egress: `sha256:${'3'.repeat(64)}`,
    });
    const updated = worker({
      last_update: {
        result: 'succeeded',
        from: digests('a'),
        to: digests('b'),
        detail: null,
        reported_at: '2026-11-04T12:09:30.000Z',
      },
    });
    const refused = worker({
      id: '00000000-0000-4000-8000-0000000002a3',
      name: 'dave-laptop',
      last_update: {
        result: 'failed',
        from: digests('a'),
        to: digests('c'),
        detail: `the attestation does not verify ${HOSTILE_AGENT}`,
        reported_at: '2026-11-04T12:09:30.000Z',
      },
    });
    const never = worker({ id: '00000000-0000-4000-8000-0000000002a4', name: 'erin-laptop' });
    const { fetchImpl } = fetchFor('missing', [updated, refused, never]);
    const { container } = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-worker]')).toHaveLength(3);
    });
    const rowOf = (id: string) => container.querySelector(`[data-worker="${id}"]`)?.closest('li');
    expect(rowOf(updated.id)?.textContent).toContain('Updated just now');
    expect(rowOf(updated.id)?.textContent).toContain(
      `platform ${'a'.repeat(12)} → ${'b'.repeat(12)}`,
    );
    expect(rowOf(refused.id)?.textContent).toContain('Update not applied just now');
    expect(rowOf(refused.id)?.textContent).toContain('the attestation does not verify');
    // The updater's words are text: the hostile markup is in the row as characters, not as an element.
    expect(rowOf(refused.id)?.querySelector('img')).toBeNull();
    expect(rowOf(never.id)?.textContent).not.toContain('Update');
    expect(rowOf(never.id)?.querySelector('[data-last-update]')).toBeNull();
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
    expect(container.querySelector('[data-worker]')?.textContent).toContain('Revoked');
  });
});

describe('the page’s pure helpers', () => {
  it('builds the download line from an origin with or without a trailing slash', () => {
    expect(workerInstallLines('https://core.example.test/')[0]).toBe(
      'mkdir agentic-worker && cd agentic-worker && curl -fsSo compose.yaml https://core.example.test/api/worker/v1/compose.yml',
    );
  });

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
