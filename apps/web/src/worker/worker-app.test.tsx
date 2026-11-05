/**
 * The worker's local page (WP-292 (2)), in happy-dom, over a fake `LocalClient`:
 *
 * - one **desk per slot** (`ui/bot/seat.tsx`): a run's desk posed by the shared activity
 *   vocabulary read off its transcript tail ("Now: Reading files"), a free one asleep, a paused
 *   worker's sipping its coffee; the room's door plate names the worker;
 * - each run with its project and ticket key, its title **as text** (a hostile title renders no
 *   element), its stage, agent, tokens and cost — *not reported yet* until the run reported them;
 * - *Pause* asks the worker to pause and the button becomes *Resume*;
 * - *Cancel run* is confirmed **in the page** — never `window.confirm` — says the task pauses,
 *   and sends one key however often the confirmed press is retried;
 * - a `401` shows how to open the page again, and stops asking;
 * - **the first-run wizard** (WP-294 (2)–(5)): while any step is open the page is a Stepper and the
 *   current step only — no *Taking work*, no Pause, Drain or Cancel, per open step; each step
 *   advances by itself on the next state poll, with no reload; the approval code is the dominant
 *   element, with *Copy*, a countdown and an approval link only on the platform's own origin.
 */
import type { TranscriptEvent, WorkerLocalRun, WorkerLocalState } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCallError, type LocalClient } from './client.js';
import { WorkerApp } from './worker-app.js';

const NOW = Date.parse('2026-11-05T10:05:00.000Z');
const RUN_ID = '00000000-0000-4000-8000-0000000029a1';
const HOSTILE_TITLE = 'Fix login <img src=x onerror="window.__pwned=1">';

const toolCall = (seq: number): TranscriptEvent =>
  ({
    run_id: RUN_ID,
    seq,
    created_at: '2026-11-05T10:04:50.000Z',
    redaction_count: 0,
    kind: 'assistant',
    model: 'claude-opus-5',
    content: [
      { type: 'tool_use', tool_use_id: `toolu_${seq}`, tool_name: 'Read', input: { path: 'a.ts' } },
    ],
  }) as TranscriptEvent;

const run = (overrides: Partial<WorkerLocalRun> = {}): WorkerLocalRun => ({
  run_id: RUN_ID,
  task_id: '00000000-0000-4000-8000-0000000029a2',
  project_id: '00000000-0000-4000-8000-0000000029a3',
  project_key: 'ACME',
  ticket_key: 'ACME-7',
  title: HOSTILE_TITLE,
  stage: 'implementation',
  role: 'developer',
  attempt: 1,
  phase: 'running',
  started_at: '2026-11-05T10:01:00.000Z',
  elapsed_ms: 240_000,
  tokens: null,
  cost_usd: null,
  cancel_requested: false,
  transcript: [toolCall(1)],
  ...overrides,
});

const state = (overrides: Partial<WorkerLocalState> = {}): WorkerLocalState => ({
  worker_id: '00000000-0000-4000-8000-0000000029f1',
  worker_name: 'alice-laptop',
  connection: 'connected',
  protocol: 2,
  core_protocol: { current: 2, accepted: [1, 2] },
  core_url: 'https://core.example.test',
  last_handshake_at: '2026-11-05T10:00:00.000Z',
  manually_paused_at: null,
  usage_paused_until: null,
  usage_paused_estimated: false,
  draining: false,
  update_pending: false,
  concurrency: 2,
  runs: [run()],
  logs: ['{"level":30,"time":1762337100000,"msg":"this worker claimed a run"}'],
  setup: setup(),
  server_time: '2026-11-05T10:05:00.000Z',
  ...overrides,
});

function setup(overrides: Partial<WorkerLocalState['setup']> = {}): WorkerLocalState['setup'] {
  return {
    core_source: 'file',
    candidates: [],
    claude_source: 'file',
    claude_rejected: false,
    sign_in: { phase: 'idle', url: null, failure: null },
    device: null,
    unreachable: null,
    idle: false,
    auth: 'none',
    ...overrides,
  };
}

const fakeClient = (initial: WorkerLocalState) => {
  let current = initial;
  const client = {
    state: vi.fn(async () => current),
    pause: vi.fn(async (paused: boolean) => {
      current = { ...current, manually_paused_at: paused ? '2026-11-05T10:05:01.000Z' : null };
      return current;
    }),
    drain: vi.fn(async () => {
      current = { ...current, draining: true };
      return current;
    }),
    cancel: vi.fn(async (runId: string) => ({
      run_id: runId,
      accepted: true,
      task_state: 'paused',
    })),
    // WP-293's two sections: nothing waiting, every project (`pick-work.test.tsx` drives them).
    claimScope: vi.fn(async () => ({ claim_project_ids: null, projects: [] })),
    setClaimScope: vi.fn(async (ids: readonly string[] | null) => ({
      claim_project_ids: ids === null ? null : [...ids],
      projects: [],
    })),
    offers: vi.fn(async () => ({ offers: [] })),
    take: vi.fn(async (runId: string) => ({ run_id: runId })),
    checkCore: vi.fn(async (url: string) => ({
      url,
      host: new URL(url).host,
      version: '0.4.0',
      protocol_fit: 'fits' as const,
    })),
    setCore: vi.fn(async (_url: string | null) => current),
    signIn: vi.fn(async (_action: 'start' | 'cancel') => current),
    claudeCode: vi.fn(async (_code: string) => current),
    claudeToken: vi.fn(async (_token: string) => current),
    signOut: vi.fn(async () => current),
    connectAgain: vi.fn(async () => current),
    retry: vi.fn(async () => current),
    /** The worker moves on: the next poll answers this. */
    advance: (next: WorkerLocalState) => {
      current = next;
    },
  } satisfies LocalClient & { advance: (next: WorkerLocalState) => void };
  return client;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = (client: LocalClient | null) =>
  render(<WorkerApp client={client} now={() => NOW} pollMs={60_000} newKey={() => 'key-1'} />);

describe('the worker’s local page (WP-292)', () => {
  it('draws one desk per slot in a room named by the door plate: the run working, the free desk asleep', async () => {
    const { container } = renderPage(fakeClient(state()));
    await screen.findByText('Runs on this machine');
    expect(container.querySelector('[data-door-plate]')?.textContent).toBe('alice-laptop');
    const desks = [...container.querySelectorAll('[data-desk]')];
    expect(desks).toHaveLength(2);
    expect(desks[0]?.getAttribute('data-pose')).toBe('typing');
    expect(desks[0]?.textContent).toContain('Now: Reading files');
    expect(desks[0]?.textContent).toContain('ACME-7');
    expect(desks[1]?.getAttribute('data-desk')).toBe('free');
    expect(desks[1]?.getAttribute('data-pose')).toBe('sleeping');
    expect(container.textContent).toContain('1 of 2 busy');
    // One known stage is its name as text, never a strip of one dot (review of PR #30).
    expect(container.querySelector('[data-phase-track]')).toBeNull();
    expect(container.querySelector(`[data-run="${RUN_ID}"] [data-stage]`)?.textContent).toBe(
      'Implementation',
    );
    // "Now: …" once on the desk and once in the Doing row — not a third time under the title.
    expect(container.textContent?.split('Now: Reading files')).toHaveLength(3);
  });

  it('puts the ticket key and the stage on two nameplate lines, whole', async () => {
    const { container } = renderPage(
      fakeClient(state({ runs: [run({ ticket_key: 'AUT-1234', stage: 'conflict_resolution' })] })),
    );
    await screen.findByText('Runs on this machine');
    const plate = container.querySelector(`[data-desk="${RUN_ID}"] [data-nameplate]`);
    expect([...(plate?.children ?? [])].map((line) => line.textContent)).toEqual([
      'AUT-1234',
      'Conflict resolution',
    ]);
  });

  it('shows what a tool call is about — its path — never its raw JSON input', async () => {
    const { container } = renderPage(fakeClient(state()));
    await screen.findByText('Runs on this machine');
    const latest = container.querySelector('[aria-label="What the agent did last"]')?.textContent;
    expect(latest).toContain('a.ts');
    expect(latest).not.toContain('{"path"');
  });

  it('says a failed read in the page’s layout, as a sentence, with a Reload button', async () => {
    const client = fakeClient(state());
    client.state.mockRejectedValue(
      new LocalCallError(200, 'unreadable', 'the worker’s answer is not one this page can read'),
    );
    renderPage(client);
    const flash = await screen.findByText('The worker’s answer is not one this page can read');
    expect(flash.closest('[data-flash="danger"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'This worker' })).toBeTruthy();
  });

  it('renders the title as text, and says tokens and cost are not reported until they are', async () => {
    const { container } = renderPage(fakeClient(state()));
    await screen.findByText('Runs on this machine');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Fix login');
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    const card = container.querySelector(`[data-run="${RUN_ID}"]`);
    expect(card?.textContent).toContain('not reported yet');
    expect(card?.textContent).toContain('ACME · ACME-7');
    expect(card?.textContent).toContain('Developer, attempt 1');

    cleanup();
    const reported = renderPage(
      fakeClient(state({ runs: [run({ tokens: 1234, cost_usd: 0.4 })] })),
    );
    await screen.findByText('Runs on this machine');
    const reportedCard = reported.container.querySelector(`[data-run="${RUN_ID}"]`);
    expect(reportedCard?.textContent).toContain('1,234 so far');
    expect(reportedCard?.textContent).toContain('$0.40');

    // Once the run is finishing its figure is the result's total, not "so far" (backlog 772).
    cleanup();
    const finished = renderPage(
      fakeClient(state({ runs: [run({ tokens: 1500, cost_usd: 0.4, phase: 'finishing' })] })),
    );
    await screen.findByText('Runs on this machine');
    const finishedCard = finished.container.querySelector(`[data-run="${RUN_ID}"]`);
    expect(finishedCard?.textContent).toContain('1,500');
    expect(finishedCard?.textContent).not.toContain('so far');
  });

  it('pauses through the worker, and a paused worker’s free desk sips its coffee', async () => {
    const client = fakeClient(state());
    const { container } = renderPage(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(client.pause).toHaveBeenCalledWith(true);
    await screen.findByRole('button', { name: 'Resume' });
    expect(container.querySelector('[data-desk="free"]')?.getAttribute('data-pose')).toBe(
      'sipping',
    );
    expect(container.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('paused');
  });

  it('confirms a cancel in the page — never window.confirm — saying the task pauses, with one key', async () => {
    // happy-dom ships no `window.confirm`: a planted one proves the page never reaches for it.
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true });
    const client = fakeClient(state());
    renderPage(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    const group = screen.getByRole('group', { name: 'Confirm the cancel' });
    expect(group.textContent).toContain('paused');
    await userEvent.click(screen.getByRole('button', { name: 'Keep it running' }));
    expect(client.cancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the run' }));
    await waitFor(() => expect(client.cancel).toHaveBeenCalledWith(RUN_ID, 'key-1'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('shows a refused cancel in the core’s words', async () => {
    const client = fakeClient(state());
    client.cancel.mockRejectedValueOnce(
      new LocalCallError(403, 'forbidden', 'role viewer may not perform run.cancel'),
    );
    renderPage(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the run' }));
    expect(await screen.findByText(/You may not cancel this run/)).toBeTruthy();
  });

  it('shows how to open the page again on a 401, and stops asking', async () => {
    const client = fakeClient(state());
    client.state.mockRejectedValue(new LocalCallError(401, 'unauthenticated', 'no token'));
    renderPage(client);
    expect(
      await screen.findByText(/Open this page from the address the worker printed/),
    ).toBeTruthy();
    expect(client.state).toHaveBeenCalledTimes(1);
  });

  it('asks for the printed address when there is no token at all', () => {
    renderPage(null);
    expect(screen.getByText(/grep token=/)).toBeTruthy();
  });

  it('offers Sign out of Claude and Change platform in the room only while nothing runs', async () => {
    const client = fakeClient(state({ runs: [], setup: setup({ idle: true }) }));
    renderPage(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out of Claude' }));
    expect(client.signOut).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Change platform' })).toBeTruthy();
  });
});

/** A state for a worker that is not connected yet: nothing runs, no name, no handshake. */
const unconnected = (
  connection: WorkerLocalState['connection'],
  patch: Partial<WorkerLocalState['setup']> = {},
  core: string | null = 'https://core.example.test',
): WorkerLocalState =>
  state({
    worker_id: null,
    worker_name: null,
    connection,
    core_protocol: null,
    core_url: core,
    last_handshake_at: null,
    update_pending: null,
    runs: [],
    setup: setup({ idle: true, core_source: core === null ? null : 'file', ...patch }),
  });

const CODE = 'BCDF-GHJK';
const DEVICE = {
  user_code: CODE,
  approve_url: `https://core.example.test/workers/approve?code=${CODE}`,
  expires_at: '2026-11-05T10:14:30.000Z',
};

describe('the first-run wizard (WP-294)', () => {
  const OPEN: readonly [string, WorkerLocalState, string][] = [
    ['platform', unconnected('needs_platform', {}, null), 'Connect to a platform'],
    ['claude', unconnected('needs_claude', { claude_source: null }), 'Sign in to Claude'],
    ['approve', unconnected('logging_in', { device: DEVICE }), 'Approve this machine'],
    [
      'approve',
      unconnected('core_unreachable', {
        unreachable: { failure: 'no_answer', retry_at: '2026-11-05T10:05:12.000Z' },
      }),
      'Approve this machine',
    ],
    ['approve', unconnected('revoked'), 'Approve this machine'],
  ];

  it.each(OPEN)(
    'shows the Stepper and the %s step only — no Taking work, no Pause, Drain or Cancel',
    async (step, value, label) => {
      const { container } = renderPage(fakeClient(value));
      await screen.findByRole('list', { name: 'Setup steps' });
      expect(container.querySelector('[data-wizard]')?.getAttribute('data-wizard')).toBe(step);
      expect(container.querySelector('[aria-current="step"]')?.textContent).toContain(label);
      expect(container.querySelector('[data-room]')).toBeNull();
      expect(container.querySelector('[data-mode]')).toBeNull();
      expect(container.textContent).not.toContain('Taking work');
      for (const name of ['Pause', 'Resume', 'Drain', 'Cancel run']) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
    },
  );

  it('advances by itself: platform → Claude → approval → the room, on the polls, with no reload', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = fakeClient(
        unconnected(
          'needs_platform',
          { candidates: [{ url: 'http://host.docker.internal:8080', version: '0.4.0' }] },
          null,
        ),
      );
      const { container } = render(
        <WorkerApp client={client} now={() => NOW} pollMs={2_000} newKey={() => 'key-1'} />,
      );
      await screen.findByText('Use the platform running on this machine');
      await userEvent.click(screen.getByRole('button', { name: 'Use this platform' }));
      expect(client.setCore).toHaveBeenCalledWith('http://host.docker.internal:8080');
      const wizardStep = () =>
        container.querySelector('[data-wizard]')?.getAttribute('data-wizard');
      client.advance(unconnected('needs_claude', { claude_source: null }));
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(wizardStep()).toBe('claude'));
      // The platform's host is named before the Claude step (the no-bearer amendment §3).
      expect(container.querySelector('[data-step-state="done"]')?.textContent).toContain(
        'core.example.test',
      );
      client.advance(unconnected('logging_in', { device: DEVICE }));
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(wizardStep()).toBe('approve'));
      client.advance(state());
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(container.querySelector('[data-room]')).not.toBeNull());
      expect(container.querySelector('[data-wizard]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks a typed address through the worker, and names a failure by its class — never a body', async () => {
    const client = fakeClient(unconnected('needs_platform', {}, null));
    renderPage(client);
    const field = await screen.findByLabelText('Platform address');
    await userEvent.type(field, 'https://core.example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Check the address' }));
    expect(client.checkCore).toHaveBeenCalledWith('https://core.example.test');
    expect(await screen.findByText('Found the platform at core.example.test')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(client.setCore).toHaveBeenCalledWith('https://core.example.test');

    client.checkCore.mockRejectedValueOnce(
      new LocalCallError(422, 'certificate', '<html>the body of whatever answered</html>'),
    );
    await userEvent.clear(field);
    await userEvent.type(field, 'https://self-signed.example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Check the address' }));
    expect(await screen.findByText('The address’s certificate is not trusted.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('the body of whatever answered');
  });

  it('signs in to Claude: opens Claude’s page, takes the pasted code, and always offers a token', async () => {
    const client = fakeClient(
      unconnected('needs_claude', {
        claude_source: null,
        sign_in: {
          phase: 'waiting_for_code',
          url: 'https://claude.com/cai/oauth/authorize?code=true&state=abc',
          failure: null,
        },
      }),
    );
    const { container } = renderPage(client);
    const open = await screen.findByRole('link', { name: 'Open Claude sign-in' });
    expect(open.getAttribute('href')).toBe(
      'https://claude.com/cai/oauth/authorize?code=true&state=abc',
    );
    await userEvent.type(screen.getByLabelText('Paste the code Claude shows you'), 'abc#def');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(client.claudeCode).toHaveBeenCalledWith('abc#def');
    // The fallback is always there, with the command to copy.
    expect(container.querySelector('[data-paste-token]')).not.toBeNull();
    expect(screen.getByDisplayValue('claude setup-token')).toBeTruthy();
  });

  it('says why a sign-in failed, and offers to sign in again', async () => {
    renderPage(
      fakeClient(
        unconnected('needs_claude', {
          claude_source: 'file',
          claude_rejected: true,
          sign_in: { phase: 'failed', url: null, failure: 'token_rejected' },
        }),
      ),
    );
    expect(await screen.findByText('Claude no longer accepts this sign-in')).toBeTruthy();
    expect(screen.getByText('Claude did not accept this sign-in. Sign in again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
  });

  it('makes the approval code the dominant element: large monospace, Copy, the prefilled link, a countdown', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (text: string) => copied.push(text) },
      configurable: true,
    });
    const { container } = renderPage(fakeClient(unconnected('logging_in', { device: DEVICE })));
    const code = await waitFor(() => {
      const found = container.querySelector('[data-user-code]');
      expect(found).not.toBeNull();
      return found as Element;
    });
    expect(code.textContent).toBe(CODE);
    expect(code.className).toContain('font-mono');
    expect(code.className).toContain('text-5xl');
    const link = screen.getByRole('link', { name: 'Open the approval page' });
    expect(link.getAttribute('href')).toBe(DEVICE.approve_url);
    expect(link.className).toContain('bg-primary');
    // 10:05:00 → 10:14:30 is 9:30 by the worker's own clock (`server_time`).
    expect(container.querySelector('[data-countdown]')?.textContent).toContain('9:30');
    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(copied).toEqual([CODE]);
  });

  it('renders no approval link off the platform’s own origin — the code stays to type', async () => {
    renderPage(
      fakeClient(
        unconnected('logging_in', {
          device: {
            ...DEVICE,
            approve_url: `https://phish.example.test/workers/approve?code=${CODE}`,
          },
        }),
      ),
    );
    await screen.findByText(CODE);
    expect(screen.queryByRole('link', { name: 'Open the approval page' })).toBeNull();
    expect(screen.getByText(/core\.example\.test\/workers\/approve/)).toBeTruthy();
  });

  it('shows a new code without a reload when the old one expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = fakeClient(unconnected('logging_in', { device: DEVICE }));
      render(<WorkerApp client={client} now={() => NOW} pollMs={2_000} newKey={() => 'k'} />);
      await screen.findByText(CODE);
      client.advance(
        unconnected('logging_in', {
          device: {
            ...DEVICE,
            user_code: 'LMNP-QRST',
            approve_url: DEVICE.approve_url.replace(CODE, 'LMNP-QRST'),
          },
        }),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await screen.findByText('LMNP-QRST')).toBeTruthy();
      expect(screen.queryByText(CODE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the platform is not answering, with the address, the class, Retrying in N s and Try now', async () => {
    const client = fakeClient(
      unconnected('core_unreachable', {
        unreachable: { failure: 'no_answer', retry_at: '2026-11-05T10:05:12.000Z' },
      }),
    );
    renderPage(client);
    expect(
      await screen.findByText('The platform at core.example.test is not answering'),
    ).toBeTruthy();
    expect(document.body.textContent).toContain('Nothing answered at that address.');
    expect(document.body.textContent).toContain('Retrying in 12 s.');
    await userEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(client.retry).toHaveBeenCalled();
  });

  it('says this machine was removed, and Connect again starts over', async () => {
    const client = fakeClient(unconnected('revoked'));
    renderPage(client);
    expect(await screen.findByText('This machine was removed from core.example.test')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect again' }));
    expect(client.connectAgain).toHaveBeenCalled();
  });

  it('offers Change platform only while idle, confirmed in the page, saying the Claude sign-in goes too', async () => {
    const client = fakeClient(unconnected('logging_in', { device: DEVICE }));
    renderPage(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Change platform' }));
    expect(
      screen.getByRole('group', { name: 'Confirm the change of platform' }).textContent,
    ).toContain('Claude sign-in on this worker is removed too');
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Change platform' })[0] as HTMLElement,
    );
    expect(client.setCore).toHaveBeenCalledWith(null);
    cleanup();
    renderPage(fakeClient(state()));
    await screen.findByText('Runs on this machine');
    // A run in flight: neither undo is offered.
    expect(screen.queryByRole('button', { name: 'Change platform' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out of Claude' })).toBeNull();
  });
});
