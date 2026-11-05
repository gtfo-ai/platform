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
 * - a `401` shows how to open the page again, and stops asking.
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
  server_time: '2026-11-05T10:05:00.000Z',
  ...overrides,
});

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
  } satisfies LocalClient;
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
});
