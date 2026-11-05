/**
 * What the worker picks up, on its local page (WP-293 (5)), in happy-dom over a fake `LocalClient`:
 *
 * - the **scope editor** shows the stored scope, offers the user's projects by key, saves `null`,
 *   a list or `[]`, refuses to save *only these* with none chosen, and saves nothing unchanged;
 * - the **offers list** renders every untrusted string as text (a hostile title renders no element),
 *   names an ask as a question and never shows its text (the core sends none), marks the offers the
 *   scope takes by itself, and *Take this one* asks the worker once and refreshes;
 * - a `409 offer_not_claimable` is said in the page's words; a blocked worker cannot press *Take*;
 * - the list is polled every 10 s **only while the page is visible**.
 */
import type { WorkerLocalClaimScope, WorkerLocalState, WorkerOffer } from '@platform/contracts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCallError, type LocalClient } from './client.js';
import { OFFERS_POLL_MS, PickWork, scopeModeOf, scopeWords } from './pick-work.js';
import { takeBlockedOf } from './worker-app.js';

/** A verb a test here never asks. */
const notAsked = async (): Promise<never> => {
  throw new Error('not asked here');
};

const ACME = '00000000-0000-4000-8000-000000029301';
const OPS = '00000000-0000-4000-8000-000000029302';
const RUN_A = '00000000-0000-4000-8000-0000000293a1';
const RUN_B = '00000000-0000-4000-8000-0000000293a2';
const HOSTILE_TITLE = 'Fix login <img src=x onerror="window.__pwned=1">';

const SCOPE: WorkerLocalClaimScope = {
  claim_project_ids: null,
  projects: [
    { id: ACME, key: 'ACME', name: 'Acme storefront' },
    { id: OPS, key: 'OPS', name: 'Operations' },
  ],
};

const offer = (overrides: Partial<WorkerOffer> = {}): WorkerOffer => ({
  run_id: RUN_A,
  kind: 'stage',
  project_key: 'ACME',
  ticket_key: 'ACME-7',
  title: HOSTILE_TITLE,
  stage: 'implementation',
  role: 'developer',
  offered_at: '2026-11-05T10:00:00.000Z',
  automatic: false,
  ...overrides,
});

const fakeClient = (initial: {
  readonly scope?: WorkerLocalClaimScope;
  readonly offers?: readonly WorkerOffer[];
}) => {
  let scope = initial.scope ?? SCOPE;
  let offers = [...(initial.offers ?? [])];
  return {
    state: vi.fn(async () => {
      throw new Error('not asked here');
    }),
    pause: vi.fn(async () => {
      throw new Error('not asked here');
    }),
    drain: vi.fn(async () => {
      throw new Error('not asked here');
    }),
    cancel: vi.fn(async () => {
      throw new Error('not asked here');
    }),
    claimScope: vi.fn(async () => scope),
    setClaimScope: vi.fn(async (ids: readonly string[] | null) => {
      scope = { ...scope, claim_project_ids: ids === null ? null : [...ids].sort() };
      return scope;
    }),
    offers: vi.fn(async () => ({ offers })),
    take: vi.fn(async (runId: string) => {
      offers = offers.filter((entry) => entry.run_id !== runId);
      return { run_id: runId };
    }),
    // The first-run wizard's verbs (WP-294): never asked here.
    checkCore: vi.fn(notAsked),
    setCore: vi.fn(notAsked),
    signIn: vi.fn(notAsked),
    claudeCode: vi.fn(notAsked),
    claudeToken: vi.fn(notAsked),
    signOut: vi.fn(notAsked),
    connectAgain: vi.fn(notAsked),
    retry: vi.fn(notAsked),
    // The *Error reporting* setting (WP-295): never asked here.
    setErrorReporting: vi.fn(notAsked),
    testErrorReporting: vi.fn(notAsked),
  } satisfies LocalClient;
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const renderPick = (
  client: LocalClient,
  props: { takeBlocked?: string | null; onTaken?: () => void; visible?: () => boolean } = {},
) =>
  render(
    <PickWork
      client={client}
      takeBlocked={props.takeBlocked ?? null}
      onTaken={props.onTaken ?? (() => undefined)}
      pollMs={60_000}
      {...(props.visible === undefined ? {} : { visible: props.visible })}
    />,
  );

describe('the claim scope on the worker’s page (WP-293)', () => {
  it('reads the three meanings in words', () => {
    expect(scopeModeOf(null)).toBe('every');
    expect(scopeModeOf([])).toBe('pick_only');
    expect(scopeModeOf([ACME])).toBe('some');
    expect(scopeWords(SCOPE)).toContain('every project');
    expect(scopeWords({ ...SCOPE, claim_project_ids: [] })).toContain('only the runs you pick');
    expect(scopeWords({ ...SCOPE, claim_project_ids: [OPS] })).toContain('OPS');
  });

  it('saves only these projects, then pick only, and nothing that is unchanged', async () => {
    const client = fakeClient({});
    renderPick(client);
    const save = await screen.findByRole('button', { name: 'Save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByLabelText('Only these projects'));
    // None chosen: not a scope anybody meant.
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose at least one project, or pick only.')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: /OPS/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.setClaimScope).toHaveBeenCalledWith([OPS]));
    expect(await screen.findByText(/It takes runs of OPS by itself/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Nothing — only the runs I pick below'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.setClaimScope).toHaveBeenLastCalledWith([]));
    expect(client.setClaimScope).toHaveBeenCalledTimes(2);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('drops a stale id (a project the user left) so Save cannot wedge on a 422', async () => {
    const STALE = '00000000-0000-4000-8000-0000000293ee';
    const client = fakeClient({ scope: { ...SCOPE, claim_project_ids: [OPS, STALE] } });
    renderPick(client);
    const ops = (await screen.findByRole('checkbox', { name: /OPS/ })) as HTMLInputElement;
    expect(ops.checked).toBe(true);
    // The stored scope still names the stale id, so the chosen one differs and may be saved.
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() => expect(client.setClaimScope).toHaveBeenCalledWith([OPS]));
  });

  it('shows a skeleton, not text, while the platform answers', async () => {
    const client = fakeClient({});
    client.claimScope.mockImplementationOnce(() => new Promise(() => undefined));
    client.offers.mockImplementationOnce(() => new Promise(() => undefined));
    const { container } = renderPick(client);
    expect(container.querySelectorAll('[role="status"] [data-skeleton-bar]').length).toBe(4);
    expect(container.textContent).not.toContain('Asking the platform…');
  });

  it('says a refused scope in the worker’s words', async () => {
    const client = fakeClient({});
    client.setClaimScope.mockRejectedValueOnce(
      new LocalCallError(422, 'project_not_eligible', 'the core refused to set the claim scope'),
    );
    renderPick(client);
    await userEvent.click(await screen.findByLabelText('Nothing — only the runs I pick below'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('the core refused to set the claim scope')).toBeTruthy();
  });
});

describe('the runs waiting for a worker (WP-293)', () => {
  it('renders untrusted text as text, an ask as a question, and the scope’s own takes', async () => {
    const client = fakeClient({
      offers: [
        offer(),
        offer({ run_id: RUN_B, kind: 'ask', stage: null, role: 'architect', automatic: true }),
      ],
    });
    const { container } = renderPick(client);
    const first = await waitFor(() => {
      const row = container.querySelector(`[data-offer="${RUN_A}"]`);
      expect(row).not.toBeNull();
      return row as Element;
    });
    expect(first.textContent).toContain(HOSTILE_TITLE);
    expect(first.textContent).toContain('ACME · ACME-7');
    expect(first.textContent).toContain('Implementation');
    expect(container.querySelector('img')).toBeNull();
    const ask = container.querySelector(`[data-offer="${RUN_B}"]`);
    expect(ask?.textContent).toContain('A question to the');
    expect(ask?.textContent).toContain('would take it by itself');
    expect(first.textContent).not.toContain('would take it by itself');
  });

  it('takes one offer once and refreshes the page', async () => {
    const onTaken = vi.fn();
    const client = fakeClient({ offers: [offer()] });
    const { container } = renderPick(client, { onTaken });
    await userEvent.click(await screen.findByRole('button', { name: 'Take this one' }));
    await waitFor(() => expect(client.take).toHaveBeenCalledWith(RUN_A));
    expect(client.take).toHaveBeenCalledOnce();
    expect(onTaken).toHaveBeenCalledOnce();
    await waitFor(() => expect(container.querySelector(`[data-offer="${RUN_A}"]`)).toBeNull());
    expect(screen.getByText('Nothing is waiting for this worker right now.')).toBeTruthy();
  });

  it('says a lost race in its own words', async () => {
    const client = fakeClient({ offers: [offer()] });
    client.take.mockRejectedValueOnce(
      new LocalCallError(409, 'offer_not_claimable', 'the core refused to hand over that run'),
    );
    renderPick(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Take this one' }));
    expect(await screen.findByText(/no longer this worker’s to take/)).toBeTruthy();
  });

  it('cannot press Take on a worker that can take nothing, and says why', async () => {
    const client = fakeClient({ offers: [offer()] });
    const { container } = renderPick(client, {
      takeBlocked: 'This worker is paused: resume it to take a run.',
    });
    expect(
      ((await screen.findByRole('button', { name: 'Take this one' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(container.querySelector('[data-take-blocked]')?.textContent).toContain('paused');
  });

  it('asks every 10 s only while the page is visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let shown = true;
    const client = fakeClient({ offers: [] });
    render(
      <PickWork
        client={client}
        takeBlocked={null}
        onTaken={() => undefined}
        visible={() => shown}
      />,
    );
    await waitFor(() => expect(client.offers).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFERS_POLL_MS);
    });
    expect(client.offers).toHaveBeenCalledTimes(2);
    shown = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OFFERS_POLL_MS * 3);
    });
    // The tick that found the page hidden asked nothing and scheduled nothing.
    expect(client.offers).toHaveBeenCalledTimes(2);
    shown = true;
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(client.offers).toHaveBeenCalledTimes(3));
  });
});

describe('takeBlockedOf (WP-293)', () => {
  const base: WorkerLocalState = {
    worker_id: null,
    worker_name: null,
    connection: 'connected',
    protocol: 3,
    core_protocol: null,
    core_url: 'https://core.example.test',
    last_handshake_at: null,
    manually_paused_at: null,
    usage_paused_until: null,
    usage_paused_estimated: false,
    draining: false,
    launcher: 'ok',
    update_pending: null,
    concurrency: 1,
    runs: [],
    logs: [],
    setup: {
      core_source: 'environment',
      candidates: [],
      claude_source: 'environment',
      claude_rejected: false,
      sign_in: { phase: 'idle', url: null, failure: null },
      device: null,
      unreachable: null,
      idle: true,
      auth: 'none',
    },
    claim_blockers: [],
    error_reporting: { source: null, host: null },
    server_time: '2026-11-05T10:00:00.000Z',
  };
  const now = Date.parse('2026-11-05T10:00:00.000Z');

  it('admits a connected, idle worker and names each reason it cannot take', () => {
    expect(takeBlockedOf({ ...base }, now)).toBeNull();
    expect(takeBlockedOf({ ...base, connection: 'handshaking' }, now)).toContain('not connected');
    expect(takeBlockedOf({ ...base, draining: true }, now)).toContain('paused');
    expect(
      takeBlockedOf({ ...base, manually_paused_at: '2026-11-05T09:00:00.000Z' }, now),
    ).toContain('paused');
    expect(
      takeBlockedOf({ ...base, usage_paused_until: '2026-11-05T11:00:00.000Z' }, now),
    ).toContain('usage limit');
    // A usage pause that has passed is no pause.
    expect(
      takeBlockedOf({ ...base, usage_paused_until: '2026-11-05T09:00:00.000Z' }, now),
    ).toBeNull();
    expect(takeBlockedOf({ ...base, concurrency: 1, runs: [{} as never] }, now)).toContain('busy');
  });
});
