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
import type {
  TranscriptEvent,
  WorkerClaimPolicy,
  WorkerLocalRun,
  WorkerLocalState,
} from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORKER_CLAIM_BLOCKER_WORDS } from '../ui/humanize.js';
import { LocalCallError, type LocalClient } from './client.js';
import { CONNECTION_STATUS } from './model.js';
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
  launcher: 'ok',
  update_pending: false,
  concurrency: 2,
  runs: [run()],
  logs: ['{"level":30,"time":1762337100000,"msg":"this worker claimed a run"}'],
  setup: setup(),
  claim_blockers: [],
  error_reporting: { source: null, host: null },
  started_at: '2026-11-05T09:00:00.000Z',
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
    setClaimScope: vi.fn(async (policy: WorkerClaimPolicy, ids: readonly string[] | null) => ({
      claim_project_ids: ids === null ? null : [...ids],
      claim_policy: policy,
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
    // The *Error reporting* setting (WP-295): a DSN saved is shown by its host, never echoed.
    setErrorReporting: vi.fn(async (dsn: string | null) => {
      current = {
        ...current,
        error_reporting:
          dsn === null ? { source: null, host: null } : { source: 'file', host: new URL(dsn).host },
      };
      return current;
    }),
    testErrorReporting: vi.fn(async () => ({
      event_id: '0123456789abcdef0123456789abcdef',
      delivered: true,
    })),
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

  it('says under Pause and Drain what each does, and under Resume once paused (owner, PR #42)', async () => {
    const client = fakeClient(state());
    const { container } = renderPage(client);
    const pause = await screen.findByRole('button', { name: 'Pause' });
    expect(pause.getAttribute('aria-describedby')).toBe('worker-pause-hint');
    expect(container.querySelector('[data-hint="pause"]')?.textContent).toBe(
      'Stops taking new runs. A run already going keeps going. Resume to take work again.',
    );
    expect(container.querySelector('[data-hint="drain"]')?.textContent).toBe(
      'Finishes the current run, then takes nothing new, until the worker restarts or you resume. Use it before updating or switching off.',
    );
    await userEvent.click(pause);
    await screen.findByRole('button', { name: 'Resume' });
    expect(container.querySelector('[data-hint="pause"]')?.textContent).toBe(
      'Takes new runs again.',
    );
  });

  it('does not offer Change platform under auth none when the Claude token comes from the environment (PR #42)', async () => {
    renderPage(
      fakeClient(
        state({
          runs: [],
          setup: setup({ idle: true, claude_source: 'environment', auth: 'none' }),
        }),
      ),
    );
    await screen.findByText('Runs on this machine');
    expect(screen.queryByRole('button', { name: 'Change platform' })).toBeNull();
    cleanup();
    renderPage(
      fakeClient(
        state({
          runs: [],
          setup: setup({ idle: true, claude_source: 'environment', auth: 'token' }),
        }),
      ),
    );
    await screen.findByText('Runs on this machine');
    expect(screen.getByRole('button', { name: 'Change platform' })).toBeTruthy();
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

describe('a launcher that does not answer (backlog 980)', () => {
  it.each([
    [
      'the wizard',
      { ...unconnected('needs_platform', {}, null), launcher: 'unreachable' as const },
    ],
    ['the room', state({ launcher: 'unreachable' })],
  ])('says so on %s — the page comes up without it', async (_, value) => {
    const { container } = renderPage(fakeClient(value));
    await screen.findByText('This worker’s launcher does not answer');
    expect(container.textContent).toContain('docker compose logs launcher');
  });

  it('says it once in the room: the status line, when that is what keeps it from work (S-22.19)', async () => {
    const { container } = renderPage(
      fakeClient(state({ launcher: 'unreachable', claim_blockers: ['launcher_unreachable'] })),
    );
    await screen.findByText('Runs on this machine');
    expect(container.querySelector('[data-hold-line]')?.textContent).toContain(
      'its launcher isn’t answering',
    );
    expect(container.textContent).not.toContain('This worker’s launcher does not answer');
  });

  it('says nothing while it answers, or before the first probe', async () => {
    for (const launcher of ['ok', 'unknown'] as const) {
      const { container, unmount } = renderPage(fakeClient(state({ launcher })));
      await waitFor(() => expect(container.querySelector('[data-room]')).not.toBeNull());
      expect(container.textContent).not.toContain('launcher does not answer');
      unmount();
    }
  });
});

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

  /** An obviously fake token of the measured shape (`sk-ant-oat01-` + 95). */
  const FAKE_TOKEN = `sk-ant-oat01-${'F'.repeat(95)}`;
  const checking = () =>
    unconnected('needs_claude', {
      claude_source: null,
      sign_in: { phase: 'checking', url: null, failure: null },
    });
  const openPaste = async (): Promise<HTMLElement> => {
    await userEvent.click(await screen.findByText('Paste a token instead'));
    return screen.getByLabelText('Token');
  };

  it('never traps the Claude step at “Checking with Claude”: seconds shown, Cancel there, and Enter sends a wrapped token joined', async () => {
    const client = fakeClient(checking());
    const { container } = renderPage(client);
    await waitFor(() =>
      expect(container.querySelector('[data-sign-in-checking]')?.textContent).toMatch(
        /^Checking with Claude… \(\d+ s\)$/,
      ),
    );
    // Cancel is offered while checking, too.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel the sign-in' }));
    expect(client.signIn).toHaveBeenCalledWith('cancel');
    const field = await openPaste();
    const use = screen.getByRole('button', { name: 'Use this token' }) as HTMLButtonElement;
    expect(use.disabled).toBe(true);
    // Copied from a terminal: wrapped over two lines, the second one indented.
    await userEvent.click(field);
    await userEvent.paste(`  ${FAKE_TOKEN.slice(0, 79)}\n    ${FAKE_TOKEN.slice(79)} `);
    // Enabled while the worker is still checking: a paste wins over the browser sign-in.
    await waitFor(() => expect(use.disabled).toBe(false));
    await userEvent.type(field, '{Enter}');
    await waitFor(() => expect(client.claudeToken).toHaveBeenCalledWith(FAKE_TOKEN));
  });

  it('says a pasted value is not a Claude token before anything is sent', async () => {
    const client = fakeClient(checking());
    renderPage(client);
    const field = await openPaste();
    await userEvent.click(field);
    await userEvent.paste('sk-ant-api03-not-a-subscription-token');
    await userEvent.click(screen.getByRole('button', { name: 'Use this token' }));
    expect(
      await screen.findByText(
        'That isn’t a Claude token: it starts with sk-ant-oat01-. Copy the whole line claude setup-token printed.',
      ),
    ).toBeTruthy();
    expect(client.claudeToken).not.toHaveBeenCalled();
  });

  it('says the worker’s refusal of a paste beside the field, never as silence', async () => {
    const client = fakeClient(checking());
    client.claudeToken.mockRejectedValueOnce(
      new LocalCallError(409, 'token_check_running', 'Claude is checking a token now'),
    );
    renderPage(client);
    const field = await openPaste();
    await userEvent.click(field);
    await userEvent.paste(FAKE_TOKEN);
    await userEvent.type(field, '{Enter}');
    expect(
      await screen.findByText(
        'Claude is still checking a token. Wait for it, or cancel the sign-in and paste again.',
      ),
    ).toBeTruthy();
    expect(client.claudeToken).toHaveBeenCalledWith(FAKE_TOKEN);
  });

  it('says what to do when the sign-in showed no token after the code, or could not be checked', async () => {
    for (const [failure, words] of [
      ['no_token_after_code', /Paste a token instead: run claude setup-token/],
      ['check_failed', /reaches api\.anthropic\.com, then paste the token again/],
    ] as const) {
      const { unmount } = renderPage(
        fakeClient(
          unconnected('needs_claude', {
            claude_source: null,
            sign_in: { phase: 'failed', url: null, failure },
          }),
        ),
      );
      expect(await screen.findByText(words)).toBeTruthy();
      unmount();
    }
  });

  it('clears a failed read’s error on the next good poll — a worker that restarted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = fakeClient(unconnected('needs_claude', { claude_source: null }));
      render(<WorkerApp client={client} now={() => NOW} pollMs={2_000} newKey={() => 'key-1'} />);
      await screen.findByRole('button', { name: 'Sign in with Claude' });
      client.state.mockRejectedValueOnce(new Error('fetch failed'));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await screen.findByText('That did not work')).toBeTruthy();
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(screen.queryByText('That did not work')).toBeNull());
    } finally {
      vi.useRealTimers();
    }
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

describe('a restart mid-sign-in, and a drain (BACKLOG 1053, 1054)', () => {
  const RESTARTED =
    'This worker restarted (probably to update itself). Sign in again — it only takes a minute.';
  const FIRST_BOOT = '2026-11-05T09:00:00.000Z';
  const SECOND_BOOT = '2026-11-05T10:04:30.000Z';
  const at = (value: WorkerLocalState, startedAt: string): WorkerLocalState => ({
    ...value,
    started_at: startedAt,
  });
  const claudeStep = (phase: WorkerLocalState['setup']['sign_in']['phase']): WorkerLocalState =>
    unconnected('needs_claude', {
      claude_source: null,
      sign_in: {
        phase,
        url:
          phase === 'waiting_for_code'
            ? 'https://claude.com/cai/oauth/authorize?code=true&state=abc'
            : null,
        failure: null,
      },
    });
  const notice = () => screen.queryByText(RESTARTED);

  /** Renders the page over `first`, then answers each of `then` on one poll each. */
  const polls = async (first: WorkerLocalState, ...then: WorkerLocalState[]) => {
    const client = fakeClient(first);
    render(<WorkerApp client={client} now={() => NOW} pollMs={2_000} newKey={() => 'key-1'} />);
    await waitFor(() => expect(client.state).toHaveBeenCalledTimes(1));
    for (const [index, next] of then.entries()) {
      client.advance(next);
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(client.state).toHaveBeenCalledTimes(index + 2));
    }
    // The last answer is taken before anything is asserted about it.
    await vi.advanceTimersByTimeAsync(0);
    return client;
  };

  it('says it at the Claude step after the worker restarted mid-sign-in, until a sign-in starts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = await polls(
        at(claudeStep('waiting_for_code'), FIRST_BOOT),
        at(claudeStep('waiting_for_code'), FIRST_BOOT),
      );
      await screen.findByRole('link', { name: 'Open Claude sign-in' });
      // The same process: nothing to say.
      expect(notice()).toBeNull();
      // Read failures while the worker restarts, then the new process at a fresh Claude step.
      client.state.mockRejectedValueOnce(new Error('fetch failed'));
      await vi.advanceTimersByTimeAsync(2_000);
      client.advance(at(claudeStep('idle'), SECOND_BOOT));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await screen.findByText(RESTARTED)).toBeTruthy();
      // It stays on the next poll of the same process …
      await vi.advanceTimersByTimeAsync(2_000);
      expect(notice()).not.toBeNull();
      // … and goes once a sign-in starts on it.
      client.signIn.mockImplementationOnce(async () => {
        const started = at(claudeStep('starting'), SECOND_BOOT);
        client.advance(started);
        return started;
      });
      await userEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
      expect(client.signIn).toHaveBeenCalledWith('start');
      await waitFor(() => expect(notice()).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('never says it off the Claude step: leaving the step ends it, and coming back does not bring it back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = await polls(
        at(claudeStep('waiting_for_code'), FIRST_BOOT),
        at(claudeStep('idle'), SECOND_BOOT),
      );
      expect(await screen.findByText(RESTARTED)).toBeTruthy();
      // A token pasted elsewhere (another tab): the worker moves to the approval step.
      client.advance(at(unconnected('logging_in', { device: DEVICE }), SECOND_BOOT));
      await vi.advanceTimersByTimeAsync(2_000);
      await screen.findByRole('button', { name: 'Copy code' });
      expect(notice()).toBeNull();
      client.advance(at(claudeStep('idle'), SECOND_BOOT));
      await vi.advanceTimersByTimeAsync(2_000);
      await screen.findByRole('button', { name: 'Sign in with Claude' });
      expect(notice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it after a restart during the token check, too', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await polls(at(claudeStep('checking'), FIRST_BOOT), at(claudeStep('idle'), SECOND_BOOT));
      expect(await screen.findByText(RESTARTED)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  const SILENT: readonly (readonly [string, WorkerLocalState, readonly WorkerLocalState[]])[] = [
    ['the page’s first read', at(claudeStep('idle'), SECOND_BOOT), []],
    [
      'a sign-in that ended on the same process',
      at(claudeStep('checking'), FIRST_BOOT),
      [at(claudeStep('idle'), FIRST_BOOT)],
    ],
    [
      'a restart while approving the machine',
      at(unconnected('logging_in', { device: DEVICE }), FIRST_BOOT),
      [
        at(unconnected('logging_in', { device: DEVICE }), SECOND_BOOT),
        at(claudeStep('idle'), SECOND_BOOT),
      ],
    ],
    ['a restart of a connected worker', at(state(), FIRST_BOOT), [at(state(), SECOND_BOOT)]],
    [
      'a restart while the page sat at the Claude step, nothing running',
      at(claudeStep('idle'), FIRST_BOOT),
      [at(claudeStep('idle'), SECOND_BOOT)],
    ],
  ];

  it.each(SILENT)('says nothing after %s', async (_what, first, then) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await polls(first, ...then);
      expect(notice()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says a drain’s refusal of a new sign-in in plain words, and the paste still works', async () => {
    const client = fakeClient({ ...claudeStep('idle'), draining: true });
    client.signIn.mockRejectedValueOnce(
      new LocalCallError(409, 'draining', 'this worker is draining: it starts no new sign-in'),
    );
    const { container } = renderPage(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    expect(client.signIn).toHaveBeenCalledWith('start');
    expect(
      await screen.findByText('This worker is updating; it will be back in a minute.'),
    ).toBeTruthy();
    // Said in the page's words, never the worker's.
    expect(container.textContent).not.toContain('starts no new sign-in');
    expect(screen.queryByText('That did not work')).toBeNull();
    // The paste field stays usable.
    await userEvent.click(screen.getByText('Paste a token instead'));
    const field = screen.getByLabelText('Token');
    await userEvent.click(field);
    await userEvent.paste(`sk-ant-oat01-${'F'.repeat(95)}`);
    const use = screen.getByRole('button', { name: 'Use this token' }) as HTMLButtonElement;
    expect(use.disabled).toBe(false);
    await userEvent.click(use);
    await waitFor(() =>
      expect(client.claudeToken).toHaveBeenCalledWith(`sk-ant-oat01-${'F'.repeat(95)}`),
    );
  });

  const UPDATING = 'This worker is updating; it will be back in a minute.';
  const refusedOnce = (client: ReturnType<typeof fakeClient>): void => {
    client.signIn.mockRejectedValueOnce(
      new LocalCallError(409, 'draining', 'this worker is draining for an update'),
    );
  };

  it('stops saying it is updating once a poll reads the drain over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = fakeClient({ ...claudeStep('idle'), draining: true });
      refusedOnce(client);
      render(<WorkerApp client={client} now={() => NOW} pollMs={2_000} newKey={() => 'key-1'} />);
      await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
      expect(await screen.findByText(UPDATING)).toBeTruthy();
      client.advance({ ...claudeStep('idle'), draining: false });
      await vi.advanceTimersByTimeAsync(2_000);
      await waitFor(() => expect(screen.queryByText(UPDATING)).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops saying it once the worker takes a sign-in again — a drain the updater gave up on', async () => {
    const client = fakeClient({ ...claudeStep('idle'), draining: true });
    refusedOnce(client);
    renderPage(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in with Claude' }));
    expect(await screen.findByText(UPDATING)).toBeTruthy();
    // Still draining, but past the hold: the worker starts the sign-in.
    client.signIn.mockImplementationOnce(async () => {
      const started = { ...claudeStep('starting'), draining: true };
      client.advance(started);
      return started;
    });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Claude' }));
    await waitFor(() => expect(screen.queryByText(UPDATING)).toBeNull());
    expect(client.signIn).toHaveBeenCalledTimes(2);
  });
});

describe('why it takes nothing, and one control for its hold (S-22.19)', () => {
  it('says Taking work only when nothing blocks it, and Connected to its platform', async () => {
    const { container } = renderPage(fakeClient(state()));
    await screen.findByText('Runs on this machine');
    expect(container.querySelector('[data-hold-line]')?.textContent).toBe('Taking work');
    expect(container.querySelector('[data-connection]')?.textContent).toBe(
      'Connected to core.example.test',
    );
    expect(container.querySelector('[data-mode]')?.getAttribute('data-mode')).toBe('claiming');
  });

  it('says why a connected worker takes nothing, in the shared words, and Try now asks again', async () => {
    const client = fakeClient(state({ claim_blockers: ['launcher_unreachable'] }));
    const { container } = renderPage(client);
    await screen.findByText('Runs on this machine');
    const line = container.querySelector('[data-hold-line]')?.textContent ?? '';
    expect(line).toBe(
      `Connected, but not taking work: its launcher isn’t answering. ${WORKER_CLAIM_BLOCKER_WORDS.launcher_unreachable.fix}`,
    );
    expect(container.textContent).not.toContain('Taking work');
    expect(container.querySelector('[data-mode]')?.textContent).toBe(
      'Connected, but not taking work',
    );
    expect(container.querySelector('[data-desk="free"]')?.textContent).toContain('Not taking work');
    await userEvent.click(screen.getByRole('button', { name: 'Try now' }));
    expect(client.retry).toHaveBeenCalled();
    // A blocker Try now cannot clear offers no button that would only be refused.
    cleanup();
    renderPage(fakeClient(state({ claim_blockers: ['images_outdated'] })));
    await screen.findByText('Runs on this machine');
    expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull();
  });

  it('says a stopping worker is stopping, never connected but not taking work (review of PR #54)', async () => {
    const { container } = renderPage(
      fakeClient(state({ connection: 'stopped', claim_blockers: ['offline'] })),
    );
    await screen.findByText('Runs on this machine');
    expect(container.querySelector('[data-hold-line]')?.textContent).toBe(
      'Stopping: the worker is shutting down and takes no new work.',
    );
    expect(container.textContent).not.toContain('Connected, but not taking work');
  });

  it('keeps Drain behind More with its explanation, and a drain makes Resume the one primary', async () => {
    const client = fakeClient(state());
    const { container } = renderPage(client);
    const drain = await screen.findByRole('button', { name: 'Drain' });
    expect(drain.closest('details')?.querySelector('summary')?.textContent).toBe('More');
    expect(drain.getAttribute('aria-describedby')).toBe('worker-drain-hint');
    await userEvent.click(drain);
    await screen.findByRole('button', { name: 'Resume' });
    expect(container.querySelector('[data-hold-line]')?.textContent).toBe(
      'Draining: finishing 1 run, then taking nothing new until you resume or restart the worker.',
    );
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Drain' })).toBeNull();
    // One primary for the worker's state, in the header and its status line (R1).
    const primaries = [
      ...container.querySelectorAll('main > header button, [data-hold] button'),
    ].filter((button) => button.className.includes('primary'));
    expect(primaries.map((button) => button.textContent)).toEqual(['Resume']);
  });

  it('says an update comes by itself, never asking for a drain by hand', async () => {
    const { container } = renderPage(fakeClient(state({ update_pending: true })));
    await screen.findByText('Runs on this machine');
    const flash = screen.getByText(/The platform runs a newer build/);
    expect(flash.textContent).toContain('updates itself after its current run');
    expect(flash.textContent).not.toContain('Drain');
    expect(container.textContent).not.toContain('lost worker');
  });

  it('links back to the platform’s own setup, on the platform’s origin', async () => {
    const { container } = renderPage(fakeClient(state()));
    await screen.findByText('Runs on this machine');
    const link = container.querySelector('[data-platform-wizard] a');
    expect(link?.textContent).toBe('Finish setting up on the platform');
    expect(link?.getAttribute('href')).toBe('https://core.example.test/workers/new?step=ready');
  });

  it('says why the waiting runs are empty: a blocker, or where runs that never reach a worker wait', async () => {
    const { container } = renderPage(fakeClient(state({ claim_blockers: ['images_outdated'] })));
    await waitFor(() =>
      expect(container.querySelector('[data-offers-empty]')?.textContent).toBe(
        'Nothing is listed because this worker can’t take work: it has an older build than this platform.',
      ),
    );
    cleanup();
    const open = renderPage(fakeClient(state()));
    await waitFor(() =>
      expect(open.container.querySelector('[data-offers-empty]')?.textContent).toMatch(
        /^No run is waiting for a worker\. On projects that prefer the platform server/,
      ),
    );
  });
});

describe('what this machine takes, in the page’s header (S-26.7, the M26 UX spec § 1)', () => {
  const AUTIX = '00000000-0000-4000-8000-000000026711';
  it('repeats the card’s sentence from the stored setting under the machine’s name', async () => {
    const client = fakeClient(state({ claim_policy: 'pick_only' }));
    client.claimScope.mockResolvedValue({
      claim_project_ids: [AUTIX],
      claim_policy: 'pick_only',
      projects: [{ id: AUTIX, key: 'AUT', name: 'Autix' }],
    } as never);
    const { container } = renderPage(client);
    const sentence =
      'This machine takes nothing by itself. You pick runs on its page (Autix only).';
    await waitFor(() =>
      expect(
        container.querySelector('main > header [data-claim-policy-sentence]')?.textContent,
      ).toBe(sentence),
    );
    const card = screen.getByRole('region', { name: 'What this machine takes' });
    expect(card.querySelector('[data-claim-policy-sentence]')?.textContent).toBe(sentence);
    // The page's one primary stays its own (TD-033): the card adds none.
    expect(card.querySelectorAll('[class~="border-primary-line"]')).toHaveLength(0);
  });
});

describe('the connection’s icon (S-22.19, R-L6)', () => {
  it('draws a failure as a failure and only a step under way as a wait', () => {
    expect(CONNECTION_STATUS.revoked).toBe('failure');
    expect(CONNECTION_STATUS.core_unreachable).toBe('failure');
    expect(CONNECTION_STATUS.upgrade_required).toBe('needs_you');
    expect(
      Object.entries(CONNECTION_STATUS)
        .filter(([, status]) => status === 'waiting')
        .map(([connection]) => connection)
        .sort(),
    ).toEqual(['handshaking', 'logging_in']);
  });
});

describe('why nothing (more) runs here — the core’s one sentence (S-28.6)', () => {
  const PROJECT = '00000000-0000-4000-8000-0000000028a1';
  const CASES: readonly [
    NonNullable<WorkerLocalState['idle_reason']>,
    RegExp,
    { readonly link?: string; readonly button?: string },
  ][] = [
    [
      { kind: 'slots_busy', running: 2, concurrency: 2 },
      /^All 2 of its places are busy/,
      { link: 'https://core.example.test/agents' },
    ],
    [
      {
        kind: 'project_limit',
        project_id: PROJECT,
        project_key: 'AUT',
        limit_kind: 'max_tasks_in_pipeline',
        count: 5,
        limit: 5,
        queued: 4,
        organisation_bound: false,
      },
      /^Project AUT is full: 5 of 5 places in its pipeline are taken/,
      { link: 'https://core.example.test/projects/AUT' },
    ],
    [
      { kind: 'policy_skips', skipped: 3, claim_policy: 'mine' },
      /^It takes only your tasks, and 3 waiting runs belong to others\./,
      { button: 'Change what it takes' },
    ],
    [
      { kind: 'nothing_queued' },
      /^Nothing is queued or waiting for this machine in the projects it serves\.$/,
      { link: 'https://core.example.test/projects' },
    ],
  ];

  it.each(CASES)(
    'says %o in exactly one sentence, with its next step',
    async (reason, text, next) => {
      const { container } = renderPage(fakeClient(state({ runs: [], idle_reason: reason })));
      await screen.findByText('Runs on this machine');
      const lines = container.querySelectorAll('[data-idle-reason]');
      expect(lines).toHaveLength(1);
      const line = lines[0] as HTMLElement;
      expect(line.getAttribute('data-idle-reason')).toBe(reason.kind);
      expect(line.querySelector('span')?.textContent ?? line.textContent).toMatch(text);
      expect(line.querySelector('a')?.getAttribute('href') ?? undefined).toBe(next.link);
      expect(line.querySelector('button')?.textContent ?? undefined).toBe(next.button);
      // The idle sentence replaces "Nothing runs here right now." rather than adding to it.
      expect(container.textContent).not.toContain('Nothing runs here right now.');
    },
  );

  it('says nothing while a blocker stands, and the old line when the core said nothing', async () => {
    const blocked = renderPage(
      fakeClient(
        state({
          runs: [],
          manually_paused_at: '2026-11-05T10:04:00.000Z',
          claim_blockers: ['paused'],
          idle_reason: { kind: 'nothing_queued' },
        }),
      ),
    );
    await screen.findByText('Runs on this machine');
    expect(blocked.container.querySelectorAll('[data-idle-reason]')).toHaveLength(0);
    cleanup();
    const silent = renderPage(fakeClient(state({ runs: [], idle_reason: null })));
    await screen.findByText('Runs on this machine');
    expect(silent.container.querySelectorAll('[data-idle-reason]')).toHaveLength(0);
    expect(silent.container.textContent).toContain('Nothing runs here right now.');
  });
});
