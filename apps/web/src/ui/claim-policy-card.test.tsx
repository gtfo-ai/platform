/**
 * *What this machine takes* (the M26 UX spec § 1, S-26.7), in happy-dom:
 *
 * - **the sentence per policy × projects** — every policy over every project, one project, two,
 *   three and five (the overflow) — built from the **stored** setting, and never from a draft;
 * - *Save* sends the policy and the projects (`null` for every project, never `[]`), says *Saved ·
 *   applies to the next run*, and is a **secondary** button (no primary on the card);
 * - *Change* is offered only to a caller that can save (read only otherwise); *Only these:* with no
 *   project chosen cannot be saved; a refused save keeps the controls open and says why;
 * - the consequence line only when it is known to be true;
 * - a project's name is text, never markup.
 */
import type { WorkerClaimPolicy } from '@platform/contracts';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ClaimPolicyCard,
  type ClaimPolicyProject,
  type ClaimPolicyValue,
  claimPolicyKey,
  nowhereToRunOf,
} from './claim-policy-card.js';
import { projectListWords } from './humanize.js';
import { primaryActions } from './primary-census.js';

const AUTIX = '00000000-0000-4000-8000-000000026701';
const FONTAI = '00000000-0000-4000-8000-000000026702';
const KIWI = '00000000-0000-4000-8000-000000026703';
const ORBIT = '00000000-0000-4000-8000-000000026704';
const PULSE = '00000000-0000-4000-8000-000000026705';

const PROJECTS: readonly ClaimPolicyProject[] = [
  { id: AUTIX, key: 'AUT', name: 'Autix' },
  { id: FONTAI, key: 'FON', name: 'Fontai' },
  { id: KIWI, key: 'KIW', name: 'Kiwi' },
  { id: ORBIT, key: 'ORB', name: 'Orbit' },
  { id: PULSE, key: 'PUL', name: 'Pulse' },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const sentenceOf = (container: HTMLElement): string =>
  container.querySelector('[data-claim-policy-sentence]')?.textContent ?? '';

const renderCard = (
  stored: ClaimPolicyValue,
  props: {
    onSave?: (next: ClaimPolicyValue) => Promise<void>;
    unassignedHasTaker?: Readonly<Record<string, boolean>>;
    projects?: readonly ClaimPolicyProject[];
  } = {},
) =>
  render(
    <ClaimPolicyCard
      stored={stored}
      projects={props.projects ?? PROJECTS}
      {...(props.onSave === undefined ? {} : { onSave: props.onSave })}
      {...(props.unassignedHasTaker === undefined
        ? {}
        : { unassignedHasTaker: props.unassignedHasTaker })}
    />,
  );

describe('the sentence, per policy × projects, from the stored setting (S-26.7 (2))', () => {
  const PROJECT_CASES: readonly {
    readonly label: string;
    readonly ids: readonly string[] | null;
    readonly names: string;
  }[] = [
    { label: 'every project', ids: null, names: 'all your projects' },
    { label: 'one project', ids: [AUTIX], names: 'Autix' },
    { label: 'two projects', ids: [AUTIX, FONTAI], names: 'Autix and Fontai' },
    { label: 'three projects', ids: [AUTIX, FONTAI, KIWI], names: 'Autix, Fontai and Kiwi' },
    {
      label: 'five projects (the overflow)',
      ids: [AUTIX, FONTAI, KIWI, ORBIT, PULSE],
      names: 'Autix, Fontai +3',
    },
  ];
  const expected = (policy: WorkerClaimPolicy, ids: readonly string[] | null, names: string) => {
    switch (policy) {
      case 'mine_and_unassigned':
        return `This machine takes your tasks and unassigned ones, in ${names}.`;
      case 'mine':
        return `This machine takes only your tasks, in ${names}.`;
      case 'everything':
        return `This machine takes every task, in ${names}.`;
      case 'pick_only':
        return ids === null
          ? 'This machine takes nothing by itself. You pick runs on its page.'
          : `This machine takes nothing by itself. You pick runs on its page (${names} only).`;
    }
  };
  for (const policy of ['mine_and_unassigned', 'mine', 'everything', 'pick_only'] as const) {
    for (const projects of PROJECT_CASES) {
      it(`says ${policy} over ${projects.label}`, () => {
        const { container } = renderCard({ policy, projectIds: projects.ids });
        expect(sentenceOf(container)).toBe(expected(policy, projects.ids, projects.names));
      });
    }
  }

  it('emphasises what it takes and where, as the spec’s examples do', () => {
    const { container } = renderCard({
      policy: 'mine_and_unassigned',
      projectIds: [AUTIX, FONTAI],
    });
    const strong = [...container.querySelectorAll('[data-claim-policy-sentence] strong')].map(
      (element) => element.textContent,
    );
    expect(strong).toEqual(['your tasks and unassigned ones', 'Autix and Fontai']);
  });

  it('names a stored project the person left once, in words', () => {
    const LEFT = '00000000-0000-4000-8000-0000000267ee';
    const { container } = renderCard({ policy: 'mine', projectIds: [AUTIX, LEFT] });
    expect(sentenceOf(container)).toBe(
      'This machine takes only your tasks, in Autix and a project you left.',
    );
  });

  it('keeps the stored sentence while a draft is open, and says the saved one after Save', async () => {
    const stored: ClaimPolicyValue = { policy: 'mine_and_unassigned', projectIds: null };
    const onSave = vi.fn(async (_next: ClaimPolicyValue) => undefined);
    const { container, rerender } = renderCard(stored, { onSave });
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText(/^Only what I pick/));
    await userEvent.click(screen.getByLabelText('Only these:'));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Autix' }));
    // The draft is not the setting: the sentence still says what is stored.
    expect(sentenceOf(container)).toBe(
      'This machine takes your tasks and unassigned ones, in all your projects.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ policy: 'pick_only', projectIds: [AUTIX] }),
    );
    expect(await screen.findByText('Saved · applies to the next run')).toBeTruthy();
    // Still the stored setting until the caller hands the new one in.
    expect(sentenceOf(container)).toBe(
      'This machine takes your tasks and unassigned ones, in all your projects.',
    );
    rerender(
      <ClaimPolicyCard
        stored={{ policy: 'pick_only', projectIds: [AUTIX] }}
        projects={PROJECTS}
        onSave={onSave}
      />,
    );
    expect(sentenceOf(container)).toBe(
      'This machine takes nothing by itself. You pick runs on its page (Autix only).',
    );
  });
});

describe('Change and Save (the M26 UX spec § 1)', () => {
  it('offers the four options with their help, the default first, and both project choices', async () => {
    renderCard(
      { policy: 'mine_and_unassigned', projectIds: null },
      { onSave: async () => undefined },
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    const radios = screen
      .getAllByRole('radio')
      .map((radio) => (radio.closest('label')?.textContent ?? '').trim());
    expect(radios).toEqual([
      'My tasks and unassigned ones',
      'Only my tasks',
      'Everything',
      'Only what I pick',
      'All projects you can see',
      'Only these:',
    ]);
    // One line of help each, visible and the radio's description.
    expect(
      screen
        .getAllByRole('radio')
        .slice(0, 4)
        .map(
          (radio) =>
            document.getElementById(radio.getAttribute('aria-describedby') ?? '')?.textContent,
        ),
    ).toEqual([
      'Runs tasks assigned to you, and tasks nobody owns yet.',
      'Runs only tasks assigned to you. Unassigned tasks wait for another machine or the server.',
      'Runs any task in the projects below, including tasks assigned to someone else.',
      'Takes nothing by itself. You choose each run on this page, and choosing one assigns the task to you.',
    ]);
    const mine = screen.getByRole('radio', { name: 'My tasks and unassigned ones' });
    expect((mine as HTMLInputElement).checked).toBe(true);
    expect(mine.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(mine.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Runs tasks assigned to you, and tasks nobody owns yet.',
    );
  });

  it('sends the policy over every project as null, never []', async () => {
    const onSave = vi.fn(async (_next: ClaimPolicyValue) => undefined);
    renderCard({ policy: 'mine', projectIds: [AUTIX] }, { onSave });
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText(/^Everything/));
    await userEvent.click(screen.getByLabelText('All projects you can see'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ policy: 'everything', projectIds: null }),
    );
  });

  it('saves nothing unchanged, and nothing under Only these: with no project chosen', async () => {
    const onSave = vi.fn(async (_next: ClaimPolicyValue) => undefined);
    renderCard({ policy: 'mine_and_unassigned', projectIds: null }, { onSave });
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    const save = (): HTMLButtonElement =>
      screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    await userEvent.click(screen.getByLabelText('Only these:'));
    expect(save().disabled).toBe(true);
    expect(screen.getByText('Choose at least one project.')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Kiwi' }));
    expect(save().disabled).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('is read only without a save: the sentence and no Change', () => {
    const { container } = renderCard({ policy: 'mine', projectIds: null });
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
    expect(sentenceOf(container)).toBe('This machine takes only your tasks, in all your projects.');
  });

  it('keeps the controls open and says a refused save as text', async () => {
    const onSave = vi.fn(async (_next: ClaimPolicyValue) => {
      throw new Error('the core refused to set the claim scope');
    });
    renderCard({ policy: 'mine_and_unassigned', projectIds: null }, { onSave });
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText(/^Only my tasks/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('the core refused to set the claim scope')).toBeTruthy();
    expect(screen.getByText('That did not work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(screen.queryByText('Saved · applies to the next run')).toBeNull();
  });

  it('draws no primary: Change and Save are secondary (TD-033)', async () => {
    const { container } = renderCard(
      { policy: 'mine_and_unassigned', projectIds: null },
      { onSave: async () => undefined },
    );
    expect(primaryActions(container)).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(primaryActions(container)).toEqual([]);
  });

  it('renders a hostile project name as text', async () => {
    const hostile = 'Autix <img src=x onerror="window.__pwned=1">';
    const { container } = renderCard(
      { policy: 'mine', projectIds: [AUTIX] },
      { onSave: async () => undefined, projects: [{ id: AUTIX, key: 'AUT', name: hostile }] },
    );
    expect(sentenceOf(container)).toContain(hostile);
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText('Only these:'));
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('the consequence line (the M26 UX spec § 1)', () => {
  it('says it only for Only my tasks, and only where it is known that nobody else takes unassigned tasks', () => {
    renderCard({ policy: 'mine', projectIds: null });
    expect(screen.queryByText(/have nowhere to run/)).toBeNull();
    cleanup();
    renderCard(
      { policy: 'mine', projectIds: [AUTIX, FONTAI, KIWI] },
      { unassignedHasTaker: { [AUTIX]: false, [FONTAI]: true } },
    );
    expect(screen.getByText(/have nowhere to run/).textContent).toBe(
      'Unassigned tasks in Autix have nowhere to run.',
    );
    cleanup();
    renderCard(
      { policy: 'mine_and_unassigned', projectIds: [AUTIX] },
      { unassignedHasTaker: { [AUTIX]: false } },
    );
    expect(screen.queryByText(/have nowhere to run/)).toBeNull();
  });

  it('reads every project the person can see when the scope is every project', () => {
    expect(
      nowhereToRunOf({ policy: 'mine', projectIds: null }, PROJECTS, {
        [AUTIX]: false,
        [ORBIT]: false,
        [KIWI]: true,
      }),
    ).toEqual(['Autix', 'Orbit']);
    expect(
      nowhereToRunOf({ policy: 'mine', projectIds: [KIWI] }, PROJECTS, { [AUTIX]: false }),
    ).toEqual([]);
    expect(
      nowhereToRunOf({ policy: 'everything', projectIds: null }, PROJECTS, { [AUTIX]: false }),
    ).toEqual([]);
  });
});

describe('the pure halves', () => {
  it('lists up to three names, then two and the rest counted', () => {
    expect(projectListWords([])).toBe('');
    expect(projectListWords(['Autix'])).toBe('Autix');
    expect(projectListWords(['Autix', 'Fontai'])).toBe('Autix and Fontai');
    expect(projectListWords(['Autix', 'Fontai', 'Kiwi'])).toBe('Autix, Fontai and Kiwi');
    expect(projectListWords(['Autix', 'Fontai', 'Kiwi', 'Orbit'])).toBe('Autix, Fontai +2');
  });

  it('compares two settings by policy and project set', () => {
    const key = claimPolicyKey;
    expect(key({ policy: 'mine', projectIds: [AUTIX, FONTAI] })).toBe(
      key({ policy: 'mine', projectIds: [FONTAI, AUTIX] }),
    );
    expect(key({ policy: 'mine', projectIds: null })).not.toBe(
      key({ policy: 'mine', projectIds: [AUTIX] }),
    );
    expect(key({ policy: 'mine', projectIds: null })).not.toBe(
      key({ policy: 'everything', projectIds: null }),
    );
  });
});

describe('focus and announcements (the review of #106)', () => {
  it('keeps Change mounted with aria-expanded, focuses the checked radio on open and Change on close', async () => {
    const onSave = vi.fn(async (_next: ClaimPolicyValue) => undefined);
    renderCard({ policy: 'mine', projectIds: null }, { onSave });
    const change = screen.getByRole('button', { name: 'Change' });
    expect(change.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(change);
    expect(screen.getByRole('button', { name: 'Change' })).toBe(change);
    expect(change.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Only my tasks' }));
    // Cancel: focus back on Change, not the top of the page.
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(change.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(change);
    // Save: the same.
    await userEvent.click(change);
    await userEvent.click(screen.getByLabelText(/^Everything/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.activeElement).toBe(change));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('keeps the status region mounted while empty, so the save is announced', async () => {
    renderCard({ policy: 'mine', projectIds: null }, { onSave: async () => undefined });
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByLabelText(/^Everything/));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(status.textContent).toBe('Saved · applies to the next run'));
    expect(screen.getByRole('status')).toBe(status);
  });

  it('says a refused save by its code or status, never the core’s text', async () => {
    const refusal = (status: number, code: string) =>
      Object.assign(new Error(`claim-scope: refused ${AUTIX}`), { status, code });
    for (const [error, words] of [
      [
        refusal(422, 'project_not_eligible'),
        'One of those projects no longer gives you work. Choose the projects again.',
      ],
      [
        refusal(403, 'claim_policy_owner_only'),
        'Only this machine’s owner can change what it takes.',
      ],
      [refusal(404, 'not_found'), 'The platform no longer knows this machine. Reload the page.'],
    ] as const) {
      const onSave = vi.fn(async (_next: ClaimPolicyValue) => {
        throw error;
      });
      renderCard({ policy: 'mine', projectIds: null }, { onSave });
      await userEvent.click(screen.getByRole('button', { name: 'Change' }));
      await userEvent.click(screen.getByLabelText(/^Everything/));
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(words)).toBeTruthy();
      expect(document.body.textContent).not.toContain(AUTIX);
      cleanup();
    }
  });
});

describe('the card on the Workers screen (S-26.8a’s props)', () => {
  it('ownerName: somebody else’s machine is theirs in the sentence, and the name is text', () => {
    const hostile = 'Vojtěch <img src=x onerror="window.__pwned=1">';
    const { container, rerender } = render(
      <ClaimPolicyCard
        stored={{ policy: 'mine_and_unassigned', projectIds: null }}
        projects={PROJECTS}
        ownerName="Vojtěch"
      />,
    );
    expect(sentenceOf(container)).toBe(
      'This machine takes Vojtěch’s tasks and unassigned ones, in all their projects.',
    );
    rerender(
      <ClaimPolicyCard
        stored={{ policy: 'mine', projectIds: [AUTIX] }}
        projects={PROJECTS}
        ownerName="Vojtěch"
      />,
    );
    expect(sentenceOf(container)).toBe('This machine takes only Vojtěch’s tasks, in Autix.');
    rerender(
      <ClaimPolicyCard
        stored={{ policy: 'pick_only', projectIds: null }}
        projects={PROJECTS}
        ownerName={hostile}
      />,
    );
    expect(sentenceOf(container)).toBe(
      `This machine takes nothing by itself. ${hostile} picks runs on its page.`,
    );
    expect(container.querySelector('img')).toBeNull();
    rerender(
      <ClaimPolicyCard
        stored={{ policy: 'everything', projectIds: null }}
        projects={PROJECTS}
        ownerName="Vojtěch"
      />,
    );
    expect(sentenceOf(container)).toBe('This machine takes every task, in all their projects.');
  });

  it('surface: Only what I pick says “on this page” on the worker page and “on its page” elsewhere', async () => {
    const helpOf = (): string | null | undefined => {
      const radio = screen.getByRole('radio', { name: 'Only what I pick' });
      return document.getElementById(radio.getAttribute('aria-describedby') ?? '')?.textContent;
    };
    render(
      <ClaimPolicyCard
        stored={{ policy: 'mine', projectIds: null }}
        projects={PROJECTS}
        onSave={async () => undefined}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(helpOf()).toContain('on this page');
    cleanup();
    render(
      <ClaimPolicyCard
        stored={{ policy: 'mine', projectIds: null }}
        projects={PROJECTS}
        onSave={async () => undefined}
        surface="workers"
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(helpOf()).toBe(
      'Takes nothing by itself. You choose each run on its page, and choosing one assigns the task to you.',
    );
  });

  it('headingLevel: h2 by default, the level asked otherwise, and the region is named by it', () => {
    render(<ClaimPolicyCard stored={{ policy: 'mine', projectIds: null }} projects={PROJECTS} />);
    expect(screen.getByRole('heading', { level: 2, name: 'What this machine takes' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'What this machine takes' })).toBeTruthy();
    cleanup();
    render(
      <ClaimPolicyCard
        stored={{ policy: 'mine', projectIds: null }}
        projects={PROJECTS}
        headingLevel="h3"
      />,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'What this machine takes' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('framed: a card of its own by default, no frame when false', () => {
    render(<ClaimPolicyCard stored={{ policy: 'mine', projectIds: null }} projects={PROJECTS} />);
    const framed = screen.getByRole('region', { name: 'What this machine takes' });
    expect(framed.className).toContain('border');
    expect(framed.className).toContain('bg-surface');
    cleanup();
    render(
      <ClaimPolicyCard
        stored={{ policy: 'mine', projectIds: null }}
        projects={PROJECTS}
        framed={false}
      />,
    );
    const bare = screen.getByRole('region', { name: 'What this machine takes' });
    expect(bare.className).not.toContain('border');
    expect(bare.className).not.toContain('bg-surface');
  });

  it('onOpenChange: told true when Change opens, false when Change, Cancel or a save closes', async () => {
    const onOpenChange = vi.fn((_open: boolean) => undefined);
    const onSave = vi.fn(async (_next: ClaimPolicyValue) => undefined);
    render(
      <ClaimPolicyCard
        stored={{ policy: 'mine_and_unassigned', projectIds: null }}
        projects={PROJECTS}
        onSave={onSave}
        onOpenChange={onOpenChange}
      />,
    );
    const user = userEvent.setup();
    const change = screen.getByRole('button', { name: 'Change' });
    // Nothing is said before a press: the card starts closed.
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(change);
    expect(onOpenChange.mock.calls).toEqual([[true]]);
    await user.click(change);
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
    await user.click(change);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    await user.click(change);
    await user.click(screen.getByRole('radio', { name: 'Everything' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onOpenChange.mock.calls.at(-1)).toEqual([false]));
    expect(onOpenChange.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]]);
  });

  it('onOpenChange: a refused save keeps the controls open and says nothing', async () => {
    const onOpenChange = vi.fn((_open: boolean) => undefined);
    render(
      <ClaimPolicyCard
        stored={{ policy: 'mine_and_unassigned', projectIds: null }}
        projects={PROJECTS}
        onSave={async () => {
          throw new Error('refused');
        }}
        onOpenChange={onOpenChange}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Change' }));
    await user.click(screen.getByRole('radio', { name: 'Everything' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('refused')).toBeTruthy();
    expect(onOpenChange.mock.calls).toEqual([[true]]);
  });
});
