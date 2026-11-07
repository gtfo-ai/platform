/**
 * **Why a task waits, in words** (S-26.8b part 2, the M26 UX spec § 4): every reason of S-26.5's
 * `offerWaitingSchema`, in its long form (the task page) and its short form (a board card, an
 * Agents or Home row), the reader-is-the-owner variant, each `owner_worker_cannot_take` first
 * blocker, and the next steps each role is offered (`WaitingNotice`, over a stand-in owner control).
 *
 * Every fixture is parsed by the contract's own schema, so a field the server would not send fails
 * here rather than passing over a shape nobody publishes.
 */
import {
  OFFER_WAITING_REASONS,
  type OfferWaiting,
  offerWaitingSchema,
  type TaskDetailResponse,
  WORKER_CLAIM_BLOCKERS,
  type WorkerClaimBlocker,
} from '@platform/contracts';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { primaryLabels } from '../ui/primary-census.js';
import type { OwnerControl } from './task-owner.js';
import { WaitingNotice } from './waiting-notice.js';
import {
  CANNOT_TAKE_KIND,
  cannotTakeKind,
  WaitingWords,
  waitingLong,
  waitingPlain,
  waitingShort,
  waitingSteps,
  waitingTail,
} from './waiting-words.js';

const VOJTECH = '00000000-0000-4000-8000-00000000a001';
const READER = '00000000-0000-4000-8000-00000000a002';
/** A right-to-left override: the sentence must never carry it, rendered or plain. */
const BIDI = '‮';
const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const TWO_HOURS_AGO = '2026-11-07T10:00:00.000Z';

const wait = (over: Partial<OfferWaiting> = {}): OfferWaiting =>
  offerWaitingSchema.parse({
    reason: 'owner_worker_offline',
    user: { user_id: VOJTECH, name: 'Vojtěch' },
    last_seen_at: null,
    assignee_name: null,
    blockers: [],
    ...over,
  });

const cannotTake = (blockers: readonly WorkerClaimBlocker[]): OfferWaiting =>
  wait({ reason: 'owner_worker_cannot_take', blockers: [...blockers] });

const CONTEXT = { viewerId: READER, nowMs: NOW, project: 'Autix', tracker: 'Jira' } as const;

const long = (waiting: OfferWaiting, viewerId: string | null = READER): string | null => {
  const parts = waitingLong(waiting, { ...CONTEXT, viewerId });
  return parts === null ? null : waitingPlain(parts);
};

const short = (waiting: OfferWaiting, viewerId: string | null = READER): string | null => {
  const parts = waitingShort(waiting, viewerId);
  return parts === null ? null : waitingPlain(parts);
};

afterEach(() => {
  cleanup();
});

describe('nothing to say', () => {
  it('says nothing when somebody can take it now, or when nothing waits', () => {
    expect(waitingLong(wait({ reason: null, user: null }), CONTEXT)).toBeNull();
    expect(waitingShort(wait({ reason: null, user: null }), READER)).toBeNull();
    expect(waitingLong(null, CONTEXT)).toBeNull();
    expect(waitingShort(null, READER)).toBeNull();
    expect(waitingTail(undefined, READER)).toBeNull();
    expect(waitingSteps(null, READER, true)).toEqual({
      workers: false,
      update: false,
      instance: false,
      link: false,
    });
  });
});

describe('each reason, in the long form and the short form', () => {
  it.each([
    [
      'owner_worker_offline, last seen',
      wait({ last_seen_at: TWO_HOURS_AGO }),
      'Waiting for Vojtěch’s machine. It’s offline (last seen 2 h ago).',
      'Waiting · Vojtěch’s machine is offline',
    ],
    [
      'owner_worker_offline, never connected',
      wait({ last_seen_at: null }),
      'Waiting for Vojtěch’s machine. It’s offline and has never connected.',
      'Waiting · Vojtěch’s machine is offline',
    ],
    [
      'owner_worker_paused',
      wait({ reason: 'owner_worker_paused' }),
      'Waiting for Vojtěch’s machine. It’s paused.',
      'Waiting · Vojtěch’s machine is paused',
    ],
    [
      'owner_no_worker',
      wait({ reason: 'owner_no_worker' }),
      'Waiting for Vojtěch. They have no machine that takes this project.',
      'Waiting · Vojtěch has no machine for it',
    ],
    [
      'owner_pick_only',
      wait({ reason: 'owner_pick_only' }),
      'Waiting for Vojtěch to pick it on their machine.',
      'Waiting · Vojtěch’s machine takes only what they pick',
    ],
    [
      'no_taker',
      wait({ reason: 'no_taker', user: null }),
      'Waiting: no machine takes unassigned tasks in Autix.',
      'Waiting · no machine takes it',
    ],
    [
      'assignee_not_linked',
      wait({ reason: 'assignee_not_linked', user: null, assignee_name: 'Jan Novák' }),
      'Waiting for a machine that takes everyone’s tasks. It’s assigned in Jira to Jan Novák, who isn’t linked to a platform account.',
      'Waiting · assigned to Jan Novák (not linked)',
    ],
    [
      'assignee_not_linked, nameless',
      wait({ reason: 'assignee_not_linked', user: null, assignee_name: null }),
      'Waiting for a machine that takes everyone’s tasks. It’s assigned in Jira to someone, who isn’t linked to a platform account.',
      'Waiting · assigned to someone (not linked)',
    ],
  ])('%s', (_name, waiting, wantLong, wantShort) => {
    expect(long(waiting)).toBe(wantLong);
    expect(short(waiting)).toBe(wantShort);
    // The sub-label is the short form without its lead.
    expect(`Waiting · ${waitingPlain(waitingTail(waiting, READER) ?? [])}`).toBe(wantShort);
  });

  it('words every reason the contract publishes', () => {
    for (const reason of OFFER_WAITING_REASONS) {
      const sentence = long(wait({ reason }));
      expect(sentence, reason).not.toBeNull();
      expect(sentence, reason).not.toMatch(/undefined|null|claim|offer|seat/i);
      expect(short(wait({ reason })), reason).toMatch(/^Waiting · /);
    }
  });

  it('says "this project" when the page does not know the project’s name', () => {
    const parts = waitingLong(wait({ reason: 'no_taker', user: null }), {
      viewerId: READER,
      nowMs: NOW,
    });
    expect(waitingPlain(parts ?? [])).toBe(
      'Waiting: no machine takes unassigned tasks in this project.',
    );
  });
});

describe('owner_worker_cannot_take: the first blocker, worded', () => {
  it.each([
    [
      ['images_outdated'],
      'Waiting for Vojtěch’s machine. It’s online but needs an update before it can take this task.',
      'Waiting · Vojtěch’s machine needs an update',
    ],
    [
      ['protocol_outdated'],
      'Waiting for Vojtěch’s machine. It’s online but needs an update before it can take this task.',
      'Waiting · Vojtěch’s machine needs an update',
    ],
    [
      ['images_missing'],
      'Waiting for Vojtěch’s machine. It’s online but is still getting its run images.',
      'Waiting · Vojtěch’s machine is still setting up',
    ],
    [
      ['draining'],
      'Waiting for Vojtěch’s machine. It’s finishing its current run and taking nothing new.',
      'Waiting · Vojtěch’s machine is finishing a run',
    ],
    [
      ['usage_limited'],
      'Waiting for Vojtěch’s machine. It has reached its Claude usage limit and resumes when the limit resets.',
      'Waiting · Vojtěch’s machine is at its usage limit',
    ],
    [
      ['platform_images_unresolved'],
      'Waiting for Vojtěch’s machine. It can’t take this task until the platform’s run images are fixed.',
      'Waiting · Vojtěch’s machine waits on the platform',
    ],
    [
      [],
      'Waiting for Vojtěch’s machine. It’s online but can’t take this task now.',
      'Waiting · Vojtěch’s machine can’t take it now',
    ],
  ] as const)('%j', (blockers, wantLong, wantShort) => {
    expect(long(cannotTake(blockers))).toBe(wantLong);
    expect(short(cannotTake(blockers))).toBe(wantShort);
  });

  it('words only the first blocker: protocol before images', () => {
    expect(cannotTakeKind(['protocol_outdated', 'images_missing'])).toBe('update');
    expect(short(cannotTake(['platform_images_unresolved', 'draining']))).toBe(
      'Waiting · Vojtěch’s machine waits on the platform',
    );
  });

  it('never says "update" for a draining machine: the owner’s own Drain sets it too', () => {
    expect(long(cannotTake(['draining']))).not.toMatch(/update/i);
    expect(short(cannotTake(['draining']))).not.toMatch(/update/i);
  });

  it('falls to the Workers screen’s words for any other blocker, for every key there is', () => {
    expect(long(cannotTake(['paused']))).toBe(
      'Waiting for Vojtěch’s machine. It’s online but can’t take this task (paused by its owner).',
    );
    expect(short(cannotTake(['paused']))).toBe('Waiting · Vojtěch’s machine can’t take it');
    for (const blocker of WORKER_CLAIM_BLOCKERS) {
      const sentence = long(cannotTake([blocker])) ?? '';
      expect(sentence, blocker).toMatch(/^Waiting for Vojtěch’s machine\. /);
      expect(sentence, blocker).not.toMatch(/undefined/);
      if (CANNOT_TAKE_KIND[blocker] === undefined) {
        expect(sentence, blocker).toMatch(/can’t take this task \(.+\)\.$/);
      }
    }
  });
});

describe('the reader is the person it is about', () => {
  it.each([
    [
      wait({ last_seen_at: TWO_HOURS_AGO }),
      'Waiting for your machine. It’s offline (last seen 2 h ago).',
      'Waiting · your machine is offline',
    ],
    [
      wait({ reason: 'owner_worker_paused' }),
      'Waiting for your machine. It’s paused.',
      'Waiting · your machine is paused',
    ],
    [
      wait({ reason: 'owner_no_worker' }),
      'Waiting for you. You have no machine that takes this project.',
      'Waiting · you have no machine for it',
    ],
    [
      wait({ reason: 'owner_pick_only' }),
      'Waiting for you to pick it on your machine.',
      'Waiting · your machine takes only what you pick',
    ],
    [
      cannotTake(['images_outdated']),
      'Waiting for your machine. It’s online but needs an update before it can take this task.',
      'Waiting · your machine needs an update',
    ],
  ])('says "your machine": %#', (waiting, wantLong, wantShort) => {
    expect(long(waiting, VOJTECH)).toBe(wantLong);
    expect(short(waiting, VOJTECH)).toBe(wantShort);
    expect(long(waiting, VOJTECH)).not.toContain('Vojtěch');
  });

  it('names the person to anybody else, and to a reader nobody signed in as', () => {
    expect(short(wait(), null)).toBe('Waiting · Vojtěch’s machine is offline');
  });
});

describe('names are somebody’s own text', () => {
  it('sanitises a name in the plain form and renders it through UntrustedText', () => {
    const hostile = wait({ user: { user_id: VOJTECH, name: `Vojtěch${BIDI}<b>x</b>` } });
    expect(short(hostile)).not.toContain(BIDI);
    const parts = waitingShort(hostile, READER) ?? [];
    const { container } = render(
      <p>
        <WaitingWords parts={parts} />
      </p>,
    );
    expect(container.textContent).not.toContain(BIDI);
    expect(container.textContent).toContain('<b>x</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('says a nameless owner is its owner, never a blank', () => {
    expect(short(wait({ user: { user_id: VOJTECH, name: '  ' } }))).toBe(
      'Waiting · its owner’s machine is offline',
    );
  });
});

describe('the next steps, by who reads', () => {
  it('offers Open Workers to the machine’s owner on a machine-side reason only', () => {
    for (const reason of [
      'owner_worker_offline',
      'owner_worker_paused',
      'owner_no_worker',
      'owner_pick_only',
    ] as const) {
      expect(waitingSteps(wait({ reason }), VOJTECH, false).workers, reason).toBe(true);
      expect(waitingSteps(wait({ reason }), READER, true).workers, reason).toBe(false);
    }
    expect(waitingSteps(cannotTake(['images_outdated']), VOJTECH, false)).toEqual({
      workers: true,
      update: true,
      instance: false,
      link: false,
    });
    expect(waitingSteps(cannotTake(['images_missing']), VOJTECH, false).update).toBe(false);
    expect(waitingSteps(cannotTake(['images_missing']), VOJTECH, false).workers).toBe(true);
  });

  it('offers the owner nothing for a draining machine, one at its usage limit, or the platform', () => {
    for (const blockers of [
      ['draining'],
      ['usage_limited'],
      ['platform_images_unresolved'],
    ] as const) {
      expect(waitingSteps(cannotTake(blockers), VOJTECH, false), blockers[0]).toEqual({
        workers: false,
        update: false,
        instance: false,
        link: false,
      });
    }
  });

  it('offers an administrator Open Instance when the platform’s images are the reason', () => {
    expect(waitingSteps(cannotTake(['platform_images_unresolved']), READER, true).instance).toBe(
      true,
    );
    expect(waitingSteps(cannotTake(['platform_images_unresolved']), READER, false).instance).toBe(
      false,
    );
  });

  it('offers an administrator Link account… for an unlinked tracker assignee', () => {
    const unlinked = wait({ reason: 'assignee_not_linked', user: null, assignee_name: 'Jan' });
    expect(waitingSteps(unlinked, READER, true).link).toBe(true);
    expect(waitingSteps(unlinked, READER, false).link).toBe(false);
  });
});

// ── The callout's notice ─────────────────────────────────────────────────────

/** Only what the notice reads off the task read. */
const detailWith = (waiting: OfferWaiting | null): TaskDetailResponse =>
  ({
    task: {
      id: '00000000-0000-4000-8000-00000000b001',
      ticket: { provider: 'jira', key: 'DEMO-1', url: 'https://jira.example.invalid/DEMO-1' },
      updated_at: '2026-11-07T11:00:00.000Z',
      waiting,
    },
  }) as unknown as TaskDetailResponse;

/** A stand-in for the header's owner control: the offers the read allows, and a spy on `run`. */
const control = (
  role: 'admin' | 'maintainer' | 'member' | 'viewer',
  offers: readonly string[],
  viewerId = READER,
) =>
  ({
    viewer: { id: viewerId, role },
    offers,
    run: vi.fn(),
    command: { isPending: false },
  }) as unknown as OwnerControl;

const renderNotice = async (waiting: OfferWaiting, owner: OwnerControl): Promise<HTMLElement> => {
  const root = createRootRoute({ component: () => <Outlet /> });
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <WaitingNotice detail={detailWith(waiting)} owner={owner} projectName="Autix" nowMs={NOW} />
    ),
  });
  const workers = createRoute({ getParentRoute: () => root, path: '/workers' });
  const settings = createRoute({ getParentRoute: () => root, path: '/settings/$section' });
  const router = createRouter({
    routeTree: root.addChildren([page, workers, settings]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  return screen.findByTestId('waiting-notice');
};

const actionsIn = (notice: HTMLElement): string[] =>
  [...notice.querySelectorAll('button, a')].map((node) => node.textContent ?? '');

describe('the task callout’s waiting notice', () => {
  it('offers a maintainer Take it and Assign…, as the read allows, and never as the primary', async () => {
    const owner = control('maintainer', ['take', 'assign', 'unassign']);
    const notice = await renderNotice(wait({ last_seen_at: TWO_HOURS_AGO }), owner);
    expect(notice.querySelector('[data-waiting]')?.textContent).toBe(
      'Waiting for Vojtěch’s machine. It’s offline (last seen 2 h ago).',
    );
    // Unassign would not move a waiting task, so it is the header's alone.
    expect(actionsIn(notice)).toEqual(['Take it', 'Assign…']);
    expect(primaryLabels(notice)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Assign…' }));
    expect(owner.run).toHaveBeenCalledWith('assign');
  });

  it('offers a member who may take it Take it, and nothing of the machine', async () => {
    const notice = await renderNotice(wait(), control('member', ['take']));
    expect(actionsIn(notice)).toEqual(['Take it']);
  });

  it('offers everyone else the sentence alone', async () => {
    const notice = await renderNotice(wait(), control('viewer', []));
    expect(notice.querySelector('[data-waiting-steps]')).toBeNull();
    expect(actionsIn(notice)).toEqual([]);
  });

  it('offers the machine’s owner Open Workers, and says to update it from its page', async () => {
    const notice = await renderNotice(
      cannotTake(['images_outdated']),
      control('member', [], VOJTECH),
    );
    expect(notice.querySelector('[data-waiting]')?.textContent).toBe(
      'Waiting for your machine. It’s online but needs an update before it can take this task.',
    );
    expect(notice.querySelector('[data-waiting-update]')?.textContent).toBe(
      'Update it from its page.',
    );
    const link = await screen.findByRole('link', { name: 'Open Workers' });
    expect(link.getAttribute('href')).toBe('/workers');
  });

  it('offers an administrator Open Instance when the platform’s images are what it waits on', async () => {
    const notice = await renderNotice(
      cannotTake(['platform_images_unresolved']),
      control('admin', []),
    );
    expect(actionsIn(notice)).toEqual(['Open Instance']);
    expect((await screen.findByRole('link', { name: 'Open Instance' })).getAttribute('href')).toBe(
      '/settings/instance',
    );
  });

  it('offers an administrator Link account… beside Take it for an unlinked assignee', async () => {
    const notice = await renderNotice(
      wait({ reason: 'assignee_not_linked', user: null, assignee_name: 'Jan Novák' }),
      control('admin', ['take']),
    );
    expect(actionsIn(notice)).toEqual(['Take it', 'Link account…']);
  });

  it('draws nothing when somebody can take it now', () => {
    render(
      <WaitingNotice
        detail={detailWith(wait({ reason: null, user: null }))}
        owner={control('admin', ['take'])}
        projectName={null}
        nowMs={NOW}
      />,
    );
    expect(screen.queryByTestId('waiting-notice')).toBeNull();
  });
});
