/**
 * The Workers screen and the device-approval page (WP-280, TD-031 §10c), driven through `createApp`
 * with a fake server, so the real router, query client and endpoint parsers are asserted: the page
 * **calls** `POST /api/workers/device/lookup` (the code in the body, never the URL) before any decision and shows the requesting address,
 * user agent and the code's age as text with the phishing warning; a code older than five minutes
 * cannot be approved without the second confirmation, and the approval it then sends carries
 * `confirm_stale: true`; after an approval it watches for the machine to connect (S-23.24) and,
 * after two minutes, says what to check. The Workers screen says whether each machine can take work
 * from the server's `claim_blockers` (S-23.24), refreshes on a clock, and revokes through
 * `DELETE /api/workers/:id`.
 */
import type { WorkerDeviceLookup, WorkerSummary } from '@platform/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app/app.js';
import type { SessionResponse } from '../auth/session.js';
import { WORKER_CLAIM_BLOCKER_WORDS } from '../ui/humanize.js';
import {
  APPROVE_WATCH_INTERVAL_MS,
  APPROVE_WATCH_LIMIT_MS,
  approvedWorkerOf,
  formatCodeAge,
  PHISHING_WARNING,
  typedUserCode,
  WORKERS_REFRESH_MS,
  workersCountText,
} from './workers.js';

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
  /** How many times `GET /api/workers` was asked (it is not a command, so not in `sent`). */
  const reads = { workers: 0 };
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
    if (url.endsWith('/api/workers')) {
      reads.workers += 1;
      return json({ items: workers, scope: 'own', timezone });
    }
    if (url.endsWith('/api/version')) {
      return json({ version: '0.0.0-dev', commit: null, built_at: null });
    }
    if (url.endsWith('/api/projects')) return json({ items: [] });
    return json({ error: { code: 'not_found', message: 'no such route' } }, 404);
  }) as typeof fetch;
  return { sent, reads, fetchImpl };
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

describe('the approval page, after Approve (S-23.24)', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/workers/approve');
  });

  /** Types the code and the name with `fireEvent` (fake timers), and presses Approve. */
  const approveAs = async (name: string) => {
    fireEvent.change(await screen.findByLabelText('Code shown by the machine'), {
      target: { value: 'BCDF-GHJK' },
    });
    fireEvent.change(await screen.findByLabelText('Name this machine'), {
      target: { value: name },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  };

  it('watches for the machine every 5 s, says it is connected and continues to Ready', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const workers: WorkerSummary[] = [];
    const { fetchImpl, reads } = fetchFor(lookup(), workers);
    render(createApp({ fetchImpl, realtime: false }).element);
    await approveAs('alice-laptop');
    await screen.findByText(/^Approved\. Waiting for/);
    await waitFor(() => expect(reads.workers).toBeGreaterThan(0));
    const before = reads.workers;

    // The machine collects its credential and connects.
    const created = new Date(Date.now()).toISOString();
    workers.push(
      worker({ created_at: created, last_seen_at: created }),
      // Somebody else's machine of the same name is not this approval's.
      worker({
        id: '00000000-0000-4000-8000-0000000002f0',
        user: {
          id: '00000000-0000-4000-8000-0000000000ff',
          email: 'x@example.invalid',
          name: null,
        },
        created_at: created,
        last_seen_at: created,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_WATCH_INTERVAL_MS);
    });
    expect(reads.workers).toBeGreaterThan(before);
    expect(await screen.findByText(/is connected\./)).toBeTruthy();
    const next = screen.getByRole('link', { name: 'Continue: check it’s ready' });
    expect(next.getAttribute('href')).toBe(
      `/workers/new?step=ready&since=${encodeURIComponent(created)}`,
    );
    // It stops asking once the machine is there.
    const settled = reads.workers;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_WATCH_INTERVAL_MS * 3);
    });
    expect(reads.workers).toBe(settled);
  });

  it('says what to check when the machine has not connected in two minutes, and stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchImpl, reads } = fetchFor(lookup(), []);
    render(createApp({ fetchImpl, realtime: false }).element);
    await approveAs('alice-laptop');
    await screen.findByText(/^Approved\. Waiting for/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_WATCH_LIMIT_MS);
    });
    expect(await screen.findByText('alice-laptop hasn’t connected yet')).toBeTruthy();
    expect(screen.getByText(/Is the worker still running on that computer\?/)).toBeTruthy();
    expect(screen.getByText(/Was it set up with this platform’s address/)).toBeTruthy();
    expect(screen.getByText(window.location.origin)).toBeTruthy();
    const after = reads.workers;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(APPROVE_WATCH_INTERVAL_MS * 3);
    });
    expect(reads.workers).toBe(after);
    // *Keep waiting* starts another round.
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }));
    expect(await screen.findByText(/^Approved\. Waiting for/)).toBeTruthy();
  });

  it('says a denial in words, with nothing to watch', async () => {
    const { fetchImpl, reads } = fetchFor(lookup(), []);
    render(createApp({ fetchImpl, realtime: false }).element);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Code shown by the machine'), 'BCDFGHJK');
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(
      await screen.findByText(/^Denied\. The machine’s page says it was refused/),
    ).toBeTruthy();
    expect(reads.workers).toBe(0);
  });

  it('matches the approval’s own worker: its person, its name, made since the approval', () => {
    const at = Date.parse('2026-11-04T12:00:00.000Z');
    const mine = worker({ created_at: '2026-11-04T12:00:05.000Z' });
    const approval = { userId: SESSION.user.id, name: 'alice-laptop', atMs: at };
    expect(approvedWorkerOf([mine], approval)).toBe(mine);
    expect(approvedWorkerOf([worker({ name: 'bob-desktop' })], approval)).toBeNull();
    expect(
      approvedWorkerOf([worker({ created_at: '2026-11-04T11:00:00.000Z' })], approval),
    ).toBeNull();
    expect(
      approvedWorkerOf(
        [worker({ state: 'revoked', created_at: '2026-11-04T12:00:05.000Z' })],
        approval,
      ),
    ).toBeNull();
  });
});

describe('the Workers screen', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/workers');
  });

  it('leads with Add a worker, links the approval page, and teaches when empty (S-23.24)', async () => {
    const { fetchImpl } = fetchFor('missing', []);
    render(createApp({ fetchImpl, realtime: false }).element);
    expect(await screen.findByRole('heading', { name: 'No worker yet' })).toBeTruthy();
    const main = within(document.querySelector('main') as HTMLElement);
    const adds = main.getAllByRole('link', { name: 'Add a worker' });
    expect(adds.map((link) => link.getAttribute('href'))).toEqual(['/workers/new', '/workers/new']);
    // One primary action on the page: the header's.
    expect(adds.filter((link) => link.className.includes('border-primary-line'))).toHaveLength(1);
    expect(main.getByRole('link', { name: 'Approve a machine' }).getAttribute('href')).toBe(
      '/workers/approve',
    );
    // The install commands live in the wizard now, not on this page.
    expect(document.querySelector('[data-worker-install]')).toBeNull();
    expect(screen.queryByText(/compose\.yml/)).toBeNull();
  });

  it('lists a worker with its state, version and digests, and revokes it through a dialog and DELETE', async () => {
    const { fetchImpl, sent } = fetchFor('missing', [
      worker({ claim_blockers: ['offline'], can_claim: false }),
    ]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector(`[data-worker="${worker().id}"]`)).not.toBeNull();
    });
    const row = container.querySelector(`[data-worker="${worker().id}"]`)?.closest('li');
    const text = row?.textContent ?? '';
    expect(text).toContain('alice-laptop');
    // The server's blocker, in words rather than as `offline` or `active` (S-23.11a, S-23.24).
    expect(text).toContain('Can’t take work: Not connected to the platform — not seen yet');
    expect(text).not.toContain('active');
    expect(text).toContain('Has not taken work yet');
    expect(text).toContain('0 of 1 busy');
    // The version and the digests are behind Details, still in the row.
    expect(text).toContain('protocol 1');
    expect(text).toContain(`sha256:${'a'.repeat(64)}`);
    expect(row?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Can’t take work');

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

  it('says Ready from the server’s answer, a hold as the blocker, and how many slots are busy', async () => {
    const NOW = Date.parse('2026-11-04T12:10:00.000Z');
    const ready = worker({
      last_seen_at: '2026-11-04T12:09:30.000Z',
      last_claimed_at: '2026-11-04T12:05:00.000Z',
      concurrency: 2,
      running: [
        {
          run_id: '00000000-0000-4000-8000-0000000003a0',
          task_id: '00000000-0000-4000-8000-0000000003a1',
          project_id: '00000000-0000-4000-8000-0000000003a2',
        },
      ],
    });
    const limited = worker({
      id: '00000000-0000-4000-8000-0000000002a1',
      name: 'bob-desktop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      paused_until: '2026-11-04T13:00:00.000Z',
      paused_reason: 'usage_limited',
      claim_blockers: ['usage_limited'],
      can_claim: false,
    });
    // WP-292: the owner's hold from the worker's local page.
    const held = worker({
      id: '00000000-0000-4000-8000-0000000002a2',
      name: 'carol-laptop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      manually_paused_at: '2026-11-04T12:05:00.000Z',
      claim_blockers: ['paused'],
      can_claim: false,
    });
    // Seen just now, yet the core says it cannot take work: the row says so, not "Online".
    const outdated = worker({
      id: '00000000-0000-4000-8000-0000000002a3',
      name: 'dave-mbp',
      last_seen_at: '2026-11-04T12:09:55.000Z',
      claim_blockers: ['images_outdated'],
      can_claim: false,
    });
    const { fetchImpl } = fetchFor('missing', [ready, limited, held, outdated]);
    const { container } = render(createApp({ fetchImpl, realtime: false, now: () => NOW }).element);
    await waitFor(() => {
      expect(container.querySelectorAll('[data-worker]')).toHaveLength(4);
    });
    const rowOf = (id: string) =>
      container.querySelector(`[data-worker="${id}"]`)?.closest('li')?.textContent ?? '';
    const stateOf = (id: string) =>
      container.querySelector(`[data-worker="${id}"] [data-worker-state]`);
    expect(stateOf(ready.id)?.textContent).toBe('Ready');
    expect(stateOf(ready.id)?.getAttribute('data-worker-state')).toBe('success');
    expect(rowOf(ready.id)).toContain('1 of 2 busy');
    expect(rowOf(ready.id)).toContain('Last took work 5 m ago');
    // WP-285: the same sentence the worker's own page says, the time in the organisation's zone.
    expect(stateOf(limited.id)?.textContent).toBe(
      'Can’t take work: Paused — usage limit until 13:00',
    );
    expect(rowOf(limited.id)).not.toContain('usage_limited');
    expect(stateOf(held.id)?.textContent).toBe('Can’t take work: Paused by its owner');
    expect(stateOf(outdated.id)?.textContent).toBe(
      'Can’t take work: It has an older build than this platform',
    );
    expect(stateOf(outdated.id)?.getAttribute('data-worker-state')).toBe('needs_you');
    expect(rowOf(outdated.id)).not.toContain('Online');
    expect(screen.getByText('1 ready · 3 can’t take work')).toBeTruthy();
  });

  it('lists every blocker with its fix under Why?, in the vocabulary’s order', async () => {
    const blocked = worker({
      last_seen_at: null,
      claim_blockers: ['offline', 'images_missing', 'no_eligible_project'],
      can_claim: false,
    });
    const { fetchImpl } = fetchFor('missing', [
      blocked,
      worker({ id: '00000000-0000-4000-8000-0000000002e1', name: 'ready-one' }),
    ]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector(`[data-worker="${blocked.id}"] [data-why]`)).not.toBeNull();
    });
    const why = container.querySelector(`[data-worker="${blocked.id}"] [data-why]`) as HTMLElement;
    expect(why.closest('details')?.querySelector('summary')?.textContent).toBe('Why?');
    expect(
      [...why.querySelectorAll('[data-blocker]')].map((li) => li.getAttribute('data-blocker')),
    ).toEqual(['offline', 'images_missing', 'no_eligible_project']);
    for (const blocker of ['offline', 'images_missing', 'no_eligible_project'] as const) {
      expect(why.textContent).toContain(WORKER_CLAIM_BLOCKER_WORDS[blocker].word);
      expect(why.textContent).toContain(WORKER_CLAIM_BLOCKER_WORDS[blocker].fix);
    }
    // A ready worker has nothing to explain.
    expect(
      container.querySelector('[data-worker="00000000-0000-4000-8000-0000000002e1"] [data-why]'),
    ).toBeNull();
  });

  it('says a pick-only worker takes only what its owner picks, not that it is broken', async () => {
    const pickOnly = worker({
      claim_projects: [],
      claim_blockers: ['pick_only'],
      can_claim: false,
    });
    const { fetchImpl } = fetchFor('missing', [pickOnly]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-worker-state]')).not.toBeNull();
    });
    const state = container.querySelector('[data-worker-state]');
    expect(state?.textContent).toBe('Takes only runs its owner picks');
    expect(state?.getAttribute('data-worker-state')).toBe('idle');
    expect(screen.getByText('1 ready')).toBeTruthy();
  });

  it('asks for the list again every 15 s while the page is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetchImpl, reads } = fetchFor('missing', [worker()]);
    const { container } = render(createApp({ fetchImpl, realtime: false }).element);
    await waitFor(() => {
      expect(container.querySelector('[data-worker]')).not.toBeNull();
    });
    const first = reads.workers;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKERS_REFRESH_MS);
    });
    expect(reads.workers).toBeGreaterThan(first);
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
    expect(scopeOf(every.id)).toBe('Takes runs of every project');
    expect(scopeOf(pickOnly.id)).toBe('Takes only runs its owner picks');
    expect(scopeOf(named.id)).toBe('Takes runs of ACME, a removed project');
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
      claim_blockers: ['usage_limited'],
      can_claim: false,
    });
    const guessed = worker({
      id: '00000000-0000-4000-8000-0000000002b2',
      name: 'eve-laptop',
      last_seen_at: '2026-11-04T12:09:30.000Z',
      paused_until: '2026-11-04T13:30:00.000Z',
      paused_reason: 'usage_limited',
      paused_until_estimated: true,
      claim_blockers: ['usage_limited'],
      can_claim: false,
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
      claim_blockers: ['paused', 'usage_limited'],
      can_claim: false,
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
    // The server names no blocker for a lapsed pause: it is ready.
    expect(rowOf(lapsed.id)).toContain('Ready');
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
      worker({
        state: 'revoked',
        revoked_at: '2026-11-04T12:05:00.000Z',
        claim_blockers: ['revoked'],
        can_claim: false,
      }),
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
  it('counts the rows in the rows’ own words', () => {
    expect(
      workersCountText([
        worker(),
        worker({ claim_blockers: ['offline'], can_claim: false }),
        worker({ state: 'revoked', claim_blockers: ['revoked'], can_claim: false }),
      ]),
    ).toBe('1 ready · 1 can’t take work · 1 revoked');
    expect(workersCountText([worker()])).toBe('1 ready');
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
