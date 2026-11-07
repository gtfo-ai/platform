/**
 * What this machine takes and the runs it may pick, on its local page (WP-293 (5); since S-26.7 the
 * M26 UX spec § 1 and § 6), in happy-dom over a fake `LocalClient`:
 *
 * - **the card** reads the stored setting (a *pick only* machine's projects as stored) and its
 *   *Save* sends the policy and the projects — `null` for every project, never `[]`;
 * - **the offers list**: a task nobody owns reads *Take this one* with "Assigns ACME-7 to you." and
 *   says "Assigned to you · starting on this machine…" after the press; the reader's own task reads
 *   *Run it here* with no assignment line; **another person's task has nothing to press**; an ask is
 *   labelled by its asker (`mine`), never by its task's owner (BACKLOG 1432);
 * - **the two `409`s** in the spec's words, naming the owner the worker answered (and the row's
 *   when it did not), and `offer_not_claimable` in the page's; the list's `as_of` goes back with
 *   every pick;
 * - every untrusted string renders as text; a blocked worker cannot press; the list is polled every
 *   10 s **only while the page is visible**.
 */
import type {
  WorkerClaimPolicy,
  WorkerLocalClaimScope,
  WorkerLocalState,
  WorkerOffer,
} from '@platform/contracts';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalCallError, type LocalClient } from './client.js';
import { storedClaimPolicyOf } from './model.js';
import { OFFERS_POLL_MS, offerActionOf, PickWork } from './pick-work.js';
import { takeBlockedOf } from './worker-app.js';

/** A verb a test here never asks. */
const notAsked = async (): Promise<never> => {
  throw new Error('not asked here');
};

const ACME = '00000000-0000-4000-8000-000000029301';
const OPS = '00000000-0000-4000-8000-000000029302';
const RUN_A = '00000000-0000-4000-8000-0000000293a1';
const RUN_B = '00000000-0000-4000-8000-0000000293a2';
const RUN_C = '00000000-0000-4000-8000-0000000293a3';
const ME = '00000000-0000-4000-8000-0000000293b1';
const VOJTECH = '00000000-0000-4000-8000-0000000293b2';
const AS_OF = '2026-11-07T10:00:00.000Z';
const HOSTILE_TITLE = 'Fix login <img src=x onerror="window.__pwned=1">';

const SCOPE: WorkerLocalClaimScope = {
  claim_project_ids: null,
  claim_policy: 'mine_and_unassigned',
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
  owner: null,
  mine: false,
  ...overrides,
});

const fakeClient = (initial: {
  readonly scope?: WorkerLocalClaimScope;
  readonly offers?: readonly WorkerOffer[];
}) => {
  let scope = initial.scope ?? SCOPE;
  let offers = [...(initial.offers ?? [])];
  return {
    state: vi.fn(notAsked),
    pause: vi.fn(notAsked),
    drain: vi.fn(notAsked),
    cancel: vi.fn(notAsked),
    claimScope: vi.fn(async () => scope),
    setClaimScope: vi.fn(async (policy: WorkerClaimPolicy, ids: readonly string[] | null) => {
      scope = {
        ...scope,
        claim_policy: policy,
        claim_project_ids: ids === null ? null : [...ids].sort(),
      };
      return scope;
    }),
    offers: vi.fn(async () => ({ offers, as_of: AS_OF })),
    take: vi.fn(async (runId: string, _asOf?: string) => {
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
  props: {
    takeBlocked?: string | null;
    onTaken?: () => void;
    onScope?: (scope: WorkerLocalClaimScope) => void;
    visible?: () => boolean;
  } = {},
) =>
  render(
    <PickWork
      client={client}
      takeBlocked={props.takeBlocked ?? null}
      emptyWords="Nothing is waiting."
      onTaken={props.onTaken ?? (() => undefined)}
      pollMs={60_000}
      {...(props.onScope === undefined ? {} : { onScope: props.onScope })}
      {...(props.visible === undefined ? {} : { visible: props.visible })}
    />,
  );

const rowOf = async (container: HTMLElement, runId: string): Promise<Element> =>
  waitFor(() => {
    const row = container.querySelector(`[data-offer="${runId}"]`);
    expect(row).not.toBeNull();
    return row as Element;
  });

describe('what this machine takes, on its page (S-26.7)', () => {
  it('reads the stored setting: a pick only machine’s projects as stored, and an older core', () => {
    expect(
      storedClaimPolicyOf({ ...SCOPE, claim_policy: 'pick_only', claim_project_ids: [OPS] }),
    ).toEqual({ policy: 'pick_only', projectIds: [OPS] });
    expect(storedClaimPolicyOf({ ...SCOPE, claim_policy: 'mine' })).toEqual({
      policy: 'mine',
      projectIds: null,
    });
    // A core below protocol 4 says no policy: `[]` is pick only over every project (S-26.4).
    const { claim_policy: _absent, ...older } = SCOPE;
    expect(storedClaimPolicyOf({ ...older, claim_project_ids: [] })).toEqual({
      policy: 'pick_only',
      projectIds: null,
    });
    expect(storedClaimPolicyOf({ ...older, claim_project_ids: [ACME] })).toEqual({
      policy: 'everything',
      projectIds: [ACME],
    });
  });

  it('says the stored sentence, and Save sends the policy and the projects, never []', async () => {
    const onScope = vi.fn();
    const client = fakeClient({});
    const { container } = renderPick(client, { onScope });
    const sentence = (): string =>
      container.querySelector('[data-claim-policy-sentence]')?.textContent ?? '';
    await waitFor(() =>
      expect(sentence()).toBe(
        'This machine takes your tasks and unassigned ones, in all your projects.',
      ),
    );
    expect(onScope).toHaveBeenCalledWith(SCOPE);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText(/^Only what I pick/));
    await userEvent.click(screen.getByLabelText('Only these:'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Operations' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.setClaimScope).toHaveBeenCalledWith('pick_only', [OPS]));
    expect(await screen.findByText('Saved · applies to the next run')).toBeTruthy();
    expect(sentence()).toBe(
      'This machine takes nothing by itself. You pick runs on its page (Operations only).',
    );
    expect(onScope).toHaveBeenLastCalledWith(
      expect.objectContaining({ claim_policy: 'pick_only', claim_project_ids: [OPS] }),
    );
    // Back to every project: `null`, never `[]`.
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText(/^Only my tasks/));
    await userEvent.click(screen.getByLabelText('All projects you can see'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.setClaimScope).toHaveBeenLastCalledWith('mine', null));
    for (const call of client.setClaimScope.mock.calls) {
      expect(call[1]).not.toEqual([]);
    }
  });

  it('says a refused save in the worker’s words, in the card', async () => {
    const client = fakeClient({});
    client.setClaimScope.mockRejectedValueOnce(
      new LocalCallError(422, 'project_not_eligible', 'the core refused to set the claim scope'),
    );
    renderPick(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText(/^Only my tasks/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('the core refused to set the claim scope')).toBeTruthy();
  });

  it('reads the setting again when the polled state says another screen changed the policy', async () => {
    const client = fakeClient({});
    const { rerender } = render(
      <PickWork
        client={client}
        takeBlocked={null}
        emptyWords="Nothing is waiting."
        onTaken={() => undefined}
        pollMs={60_000}
        statePolicy="mine_and_unassigned"
      />,
    );
    await waitFor(() => expect(client.claimScope).toHaveBeenCalledTimes(1));
    rerender(
      <PickWork
        client={client}
        takeBlocked={null}
        emptyWords="Nothing is waiting."
        onTaken={() => undefined}
        pollMs={60_000}
        statePolicy="mine_and_unassigned"
      />,
    );
    expect(client.claimScope).toHaveBeenCalledTimes(1);
    rerender(
      <PickWork
        client={client}
        takeBlocked={null}
        emptyWords="Nothing is waiting."
        onTaken={() => undefined}
        pollMs={60_000}
        statePolicy="mine"
      />,
    );
    await waitFor(() => expect(client.claimScope).toHaveBeenCalledTimes(2));
  });

  it('shows a skeleton, not text, while the platform answers', async () => {
    const client = fakeClient({});
    client.claimScope.mockImplementationOnce(() => new Promise(() => undefined));
    client.offers.mockImplementationOnce(() => new Promise(() => undefined));
    const { container } = renderPick(client);
    expect(container.querySelectorAll('[role="status"] [data-skeleton-bar]').length).toBe(4);
  });
});

describe('picking a run (the M26 UX spec § 6, S-26.7 (3))', () => {
  it('reads each row’s action off its owner and its asker', () => {
    expect(offerActionOf(offer())).toEqual({ kind: 'take', assigns: true });
    expect(offerActionOf(offer({ owner: { user_id: ME, name: 'Me' }, mine: true }))).toEqual({
      kind: 'run_here',
    });
    expect(offerActionOf(offer({ owner: { user_id: VOJTECH, name: 'Vojtěch' } }))).toEqual({
      kind: 'someones',
      name: 'Vojtěch',
    });
    // An ask: its owner is the task's, its `mine` the asker (BACKLOG 1432).
    expect(
      offerActionOf(offer({ kind: 'ask', owner: { user_id: VOJTECH, name: 'Vojtěch' } })),
    ).toEqual({ kind: 'take', assigns: false });
    expect(
      offerActionOf(
        offer({ kind: 'ask', owner: { user_id: VOJTECH, name: 'Vojtěch' }, mine: true }),
      ),
    ).toEqual({ kind: 'run_here' });
    // A core that said nothing of owners: a take, and no promise of an assignment.
    const { owner: _owner, mine: _mine, ...older } = offer();
    expect(offerActionOf(older)).toEqual({ kind: 'take', assigns: false });
  });

  it('takes a task nobody owns: Assigns ACME-7 to you, the list’s as_of, then Assigned to you', async () => {
    const onTaken = vi.fn();
    const client = fakeClient({ offers: [offer()] });
    const { container } = renderPick(client, { onTaken });
    const row = await rowOf(container, RUN_A);
    expect(row.querySelector('[data-offer-assigns]')?.textContent).toBe('Assigns ACME-7 to you.');
    await userEvent.click(screen.getByRole('button', { name: 'Take this one' }));
    await waitFor(() => expect(client.take).toHaveBeenCalledWith(RUN_A, AS_OF));
    expect(client.take).toHaveBeenCalledOnce();
    expect(onTaken).toHaveBeenCalledOnce();
    expect(
      (await screen.findByText('Assigned to you · starting on this machine…')).getAttribute('role'),
    ).toBe('status');
    await waitFor(() => expect(container.querySelector(`[data-offer="${RUN_A}"]`)).toBeNull());
    expect(screen.getByText('Nothing is waiting.')).toBeTruthy();
  });

  it('reads Run it here on your own task, with no assignment line', async () => {
    const client = fakeClient({
      offers: [offer({ owner: { user_id: ME, name: 'Me' }, mine: true })],
    });
    const { container } = renderPick(client);
    const row = await rowOf(container, RUN_A);
    expect(row.querySelector('[data-offer-assigns]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take this one' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Run it here' }));
    await waitFor(() => expect(client.take).toHaveBeenCalledWith(RUN_A, AS_OF));
    expect(await screen.findByText('Starting on this machine…')).toBeTruthy();
    expect(screen.queryByText('Assigned to you · starting on this machine…')).toBeNull();
  });

  it('gives another person’s task their name and nothing to press', async () => {
    const hostile = 'Vojtěch <img src=x onerror="window.__pwned=1">';
    const client = fakeClient({
      offers: [offer({ owner: { user_id: VOJTECH, name: hostile } })],
    });
    const { container } = renderPick(client);
    const row = await rowOf(container, RUN_A);
    expect(row.getAttribute('data-offer-action')).toBe('someones');
    expect(row.querySelector('[data-offer-someones]')?.textContent).toBe(`${hostile}’s task`);
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(row.querySelector('[data-offer-assigns]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('labels an ask by its asker, never by its task’s owner', async () => {
    const client = fakeClient({
      offers: [
        offer({
          kind: 'ask',
          stage: null,
          role: 'architect',
          owner: { user_id: VOJTECH, name: 'Vojtěch' },
          mine: false,
          automatic: true,
        }),
        offer({
          run_id: RUN_B,
          kind: 'ask',
          stage: null,
          role: 'architect',
          owner: { user_id: VOJTECH, name: 'Vojtěch' },
          mine: true,
        }),
      ],
    });
    const { container } = renderPick(client);
    const theirs = await rowOf(container, RUN_A);
    expect(theirs.textContent).toContain('A question to the');
    expect(theirs.textContent).not.toContain('Vojtěch');
    expect(theirs.textContent).toContain('this machine would take it by itself');
    expect(theirs.querySelector('button')?.textContent).toBe('Take this one');
    expect(theirs.querySelector('[data-offer-assigns]')).toBeNull();
    const mine = await rowOf(container, RUN_B);
    expect(mine.textContent).toContain('Your question');
    expect(mine.querySelector('button')?.textContent).toBe('Run it here');
  });

  it('says task_taken_by_another in the spec’s words, naming who the worker answered', async () => {
    const client = fakeClient({ offers: [offer()] });
    client.take.mockRejectedValueOnce(
      new LocalCallError(409, 'task_taken_by_another', 'the core refused to hand over that run', {
        user_id: VOJTECH,
        name: 'Vojtěch',
      }),
    );
    renderPick(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Take this one' }));
    const flash = await screen.findByTestId('pick-refused');
    expect(flash.textContent).toBe('Vojtěch took ACME-7 a moment ago. Pick another.');
    expect(screen.queryByText('Assigned to you · starting on this machine…')).toBeNull();
  });

  it('says task_owned_by_another in the spec’s words', async () => {
    const client = fakeClient({ offers: [offer()] });
    client.take.mockRejectedValueOnce(
      new LocalCallError(409, 'task_owned_by_another', 'the core refused to hand over that run', {
        user_id: VOJTECH,
        name: 'Vojtěch',
      }),
    );
    renderPick(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Take this one' }));
    expect((await screen.findByTestId('pick-refused')).textContent).toBe(
      'ACME-7 is Vojtěch’s. A maintainer can reassign it on the task page.',
    );
  });

  it('names nobody it does not know: an answer without its owner', async () => {
    const client = fakeClient({ offers: [offer({ ticket_key: null })] });
    client.take.mockRejectedValueOnce(
      new LocalCallError(409, 'task_taken_by_another', 'the core refused to hand over that run'),
    );
    renderPick(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Take this one' }));
    expect((await screen.findByTestId('pick-refused')).textContent).toBe(
      'Another person took this task a moment ago. Pick another.',
    );
  });

  it('says a lost race in its own words', async () => {
    const client = fakeClient({ offers: [offer()] });
    client.take.mockRejectedValueOnce(
      new LocalCallError(409, 'offer_not_claimable', 'the core refused to hand over that run'),
    );
    renderPick(client);
    await userEvent.click(await screen.findByRole('button', { name: 'Take this one' }));
    expect(await screen.findByText(/no longer this machine’s to take/)).toBeTruthy();
  });

  it('renders untrusted text as text', async () => {
    const client = fakeClient({ offers: [offer(), offer({ run_id: RUN_C, title: null })] });
    const { container } = renderPick(client);
    const first = await rowOf(container, RUN_A);
    expect(first.textContent).toContain(HOSTILE_TITLE);
    expect(first.textContent).toContain('ACME · ACME-7');
    expect(first.textContent).toContain('Implementation');
    expect(container.querySelector('img')).toBeNull();
    expect((await rowOf(container, RUN_C)).textContent).toContain('A task with no title');
  });

  it('cannot press on a worker that can take nothing, and says why', async () => {
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
        emptyWords="Nothing is waiting."
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
    started_at: '2026-11-05T09:00:00.000Z',
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
