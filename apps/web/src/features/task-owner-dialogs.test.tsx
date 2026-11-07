/**
 * The owner control's dialogs (S-26.8b, the M26 UX spec § 2), rendered alone.
 *
 * - `OwnerPicker` (*Assign…*): it lists the candidates it is given, marks the current owner and
 *   does not let them be chosen, holds *Assign* until somebody is chosen, hands back who, and says
 *   why when nobody else can own tasks, or that the people are being read or could not be. Once
 *   somebody is chosen it says what follows, both ways on each fact: the current owner's machine
 *   (or the reader's), the tracker reassigned only on that candidate's `writes_back` (replacing whom
 *   the tracker shows — off `tracker_assignee`, a linked person who gave the task back included —
 *   and nobody when it already shows the chosen person), and *Jira still shows …* when it does not
 *   write back. Names are text.
 * - `TakeConfirmDialog` names the owner in its title and its act, and mentions the tracker only when
 *   the take writes the assignment back — with the tracker assignee it replaces, as text, when
 *   the tracker shows one; on a task held only by such an assignee it says the ticket is
 *   reassigned to the reader in the tracker, named from the ticket's provider.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type OwnerCandidate,
  OwnerPicker,
  type PickerOwner,
  type TakeConfirm,
  TakeConfirmDialog,
} from './task-owner-dialogs.js';
import { type TrackerShows, trackerShowsFor } from './tracker-shows.js';

const ADA = '00000000-0000-4000-8000-000000000011';
const VOJTECH = '00000000-0000-4000-8000-000000000012';
const HOSTILE = '<img src=x onerror=alert(1)>';

afterEach(() => {
  cleanup();
});

const Picker = ({
  candidates,
  currentOwner = null,
  trackerShows = null,
  assigned,
  readError = null,
  error,
}: {
  readonly candidates: readonly OwnerCandidate[] | null;
  readonly currentOwner?: PickerOwner | null;
  readonly trackerShows?: TrackerShows;
  readonly assigned: [string, string][];
  readonly readError?: unknown;
  readonly error?: unknown;
}) => {
  const [open, setOpen] = useState(true);
  return (
    <OwnerPicker
      open={open}
      onOpenChange={setOpen}
      ticketKey="ACME-12"
      tracker="Jira"
      candidates={candidates}
      readError={readError}
      currentOwner={currentOwner}
      trackerShows={trackerShows}
      pending={false}
      error={error ?? null}
      onAssign={(userId, name) => {
        assigned.push([userId, name]);
      }}
    />
  );
};

const VOJTECH_OWNS: PickerOwner = { user_id: VOJTECH, name: 'Vojtěch', you: false };

/** Choose `userId` in the open picker and answer what it says will follow. */
const chooseAndRead = async (userId: string): Promise<string> => {
  const dialog = await screen.findByRole('dialog', { name: 'Assign ACME-12' });
  await userEvent.setup().selectOptions(within(dialog).getByLabelText('Person'), userId);
  return dialog.querySelector('[data-owner-assign-consequence]')?.textContent ?? '';
};

describe('the person picker (Assign…)', () => {
  it('lists the candidates, marks the owner, and assigns only somebody else', async () => {
    const assigned: [string, string][] = [];
    render(
      <Picker
        candidates={[
          { user_id: VOJTECH, name: 'Vojtěch' },
          { user_id: ADA, name: `Ada ${HOSTILE}` },
        ]}
        currentOwner={VOJTECH_OWNS}
        assigned={assigned}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Assign ACME-12' });
    const field = within(dialog).getByLabelText('Person') as HTMLSelectElement;
    const options = [...field.options].map((option) => [option.textContent, option.disabled]);
    expect(options).toEqual([
      ['—', true],
      ['Vojtěch (owner now)', true],
      [`Ada ${HOSTILE}`, false],
    ]);
    expect(dialog.querySelector('img')).toBeNull();
    // Nothing is said of what follows until somebody is chosen.
    expect(dialog.querySelector('[data-owner-assign-consequence]')).toBeNull();
    const assign = within(dialog).getByRole('button', { name: 'Assign' });
    expect((assign as HTMLButtonElement).disabled).toBe(true);
    const user = userEvent.setup();
    await user.selectOptions(field, ADA);
    expect((assign as HTMLButtonElement).disabled).toBe(false);
    await user.click(assign);
    expect(assigned).toEqual([[ADA, `Ada ${HOSTILE}`]]);
  });

  it('says why when nobody else can own tasks, and offers nothing to assign', async () => {
    for (const candidates of [[], [{ user_id: VOJTECH, name: 'Vojtěch' }]]) {
      cleanup();
      render(<Picker candidates={candidates} currentOwner={VOJTECH_OWNS} assigned={[]} />);
      const dialog = await screen.findByRole('dialog', { name: 'Assign ACME-12' });
      expect(dialog.querySelector('[data-owner-picker-empty]')?.textContent).toBe(
        'Nobody else in this project can own tasks: owning one takes the member role or above here.',
      );
      expect(within(dialog).queryByLabelText('Person')).toBeNull();
      expect(
        (within(dialog).getByRole('button', { name: 'Assign' }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
  });

  it('says it is reading the people, and says so when they could not be read', async () => {
    render(<Picker candidates={null} assigned={[]} />);
    let dialog = await screen.findByRole('dialog', { name: 'Assign ACME-12' });
    expect(dialog.querySelector('[data-owner-picker-loading]')?.textContent).toBe(
      'Reading who can own it…',
    );
    expect(dialog.querySelector('[data-owner-picker-empty]')).toBeNull();

    cleanup();
    render(<Picker candidates={null} readError={new Error('unreadable')} assigned={[]} />);
    dialog = await screen.findByRole('dialog', { name: 'Assign ACME-12' });
    expect(within(dialog).getByText('The people who can own it could not be read.')).toBeTruthy();
    expect(dialog.querySelector('[data-owner-picker-loading]')).toBeNull();
    expect(within(dialog).queryByLabelText('Person')).toBeNull();
  });

  it('shows a refusal inside the dialog, and Cancel closes it', async () => {
    const assigned: [string, string][] = [];
    render(
      <Picker
        candidates={[{ user_id: ADA, name: 'Ada' }]}
        assigned={assigned}
        error={new Error('refused')}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Assign ACME-12' });
    expect(within(dialog).getByText('The owner was not changed.')).toBeTruthy();
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(assigned).toEqual([]);
  });
});

describe('what choosing a person says (the candidate’s writes_back, the owner, the tracker)', () => {
  const ada = (writesBack: boolean): OwnerCandidate => ({
    user_id: ADA,
    name: 'Ada',
    writes_back: writesBack,
  });

  it('asks only the question when nobody owns it and nothing reaches or shows in the tracker', async () => {
    render(<Picker candidates={[ada(false)]} assigned={[]} />);
    expect(await chooseAndRead(ADA)).toBe('Assign ACME-12 to Ada?');
  });

  it('names the current owner whose machine stops getting it, and says “your” to the reader', async () => {
    render(<Picker candidates={[ada(false)]} currentOwner={VOJTECH_OWNS} assigned={[]} />);
    expect(await chooseAndRead(ADA)).toBe(
      'Assign ACME-12 to Ada? Vojtěch’s machine stops getting it.',
    );

    cleanup();
    render(
      <Picker
        candidates={[ada(false)]}
        currentOwner={{ user_id: VOJTECH, name: 'Fake Operator', you: true }}
        assigned={[]}
      />,
    );
    expect(await chooseAndRead(ADA)).toBe('Assign ACME-12 to Ada? Your machine stops getting it.');
  });

  it('says it also assigns the ticket in the tracker only when that candidate writes back', async () => {
    render(
      <Picker
        candidates={[ada(true)]}
        currentOwner={VOJTECH_OWNS}
        trackerShows={{ name: `Jan Novák ${HOSTILE}`, userId: null }}
        assigned={[]}
      />,
    );
    expect(await chooseAndRead(ADA)).toBe(
      `Assign ACME-12 to Ada? Vojtěch’s machine stops getting it. This also assigns ACME-12 in Jira to Ada, replacing Jan Novák ${HOSTILE}.`,
    );
    expect(document.querySelector('img')).toBeNull();

    cleanup();
    render(<Picker candidates={[ada(true)]} assigned={[]} />);
    expect(await chooseAndRead(ADA)).toBe(
      'Assign ACME-12 to Ada? This also assigns ACME-12 in Jira to Ada.',
    );

    cleanup();
    render(
      <Picker candidates={[ada(true)]} trackerShows={{ name: null, userId: null }} assigned={[]} />,
    );
    expect(await chooseAndRead(ADA)).toBe(
      'Assign ACME-12 to Ada? This also assigns ACME-12 in Jira to Ada, replacing its current assignee there.',
    );
  });

  it('says plainly that the tracker still shows somebody else when the candidate does not write back', async () => {
    render(
      <Picker
        candidates={[ada(false)]}
        currentOwner={VOJTECH_OWNS}
        trackerShows={{ name: 'Jan Novák', userId: null }}
        assigned={[]}
      />,
    );
    const said = await chooseAndRead(ADA);
    expect(said).toBe(
      'Assign ACME-12 to Ada? Vojtěch’s machine stops getting it. Jira still shows Jan Novák.',
    );
    expect(said).not.toContain('assigns');

    cleanup();
    // An older server that sends no writes_back is read as not writing back.
    render(
      <Picker
        candidates={[{ user_id: ADA, name: 'Ada' }]}
        trackerShows={{ name: null, userId: null }}
        assigned={[]}
      />,
    );
    expect(await chooseAndRead(ADA)).toBe('Assign ACME-12 to Ada? Jira still shows someone else.');
  });

  it('names a linked person the tracker still shows after they gave the task back, both ways', async () => {
    // Vojtěch owned it, was written back, then unassigned: no owner, and Jira still shows him.
    const vojtechInJira: TrackerShows = { name: 'Vojtěch in Jira', userId: VOJTECH };
    render(<Picker candidates={[ada(true)]} trackerShows={vojtechInJira} assigned={[]} />);
    expect(await chooseAndRead(ADA)).toBe(
      'Assign ACME-12 to Ada? This also assigns ACME-12 in Jira to Ada, replacing Vojtěch in Jira.',
    );

    cleanup();
    render(<Picker candidates={[ada(false)]} trackerShows={vojtechInJira} assigned={[]} />);
    expect(await chooseAndRead(ADA)).toBe(
      'Assign ACME-12 to Ada? Jira still shows Vojtěch in Jira.',
    );
  });

  it('replaces nobody when the tracker already shows the chosen person', async () => {
    const adaInJira: TrackerShows = { name: 'Ada in Jira', userId: ADA };
    render(<Picker candidates={[ada(true)]} trackerShows={adaInJira} assigned={[]} />);
    expect(await chooseAndRead(ADA)).toBe(
      'Assign ACME-12 to Ada? This also assigns ACME-12 in Jira to Ada.',
    );

    cleanup();
    render(<Picker candidates={[ada(false)]} trackerShows={adaInJira} assigned={[]} />);
    expect(await chooseAndRead(ADA)).toBe('Assign ACME-12 to Ada?');
  });

  it('reads who the tracker shows off the task’s tracker_assignee, never off owner_writes_back', () => {
    expect(trackerShowsFor({ tracker_assignee: null, unlinked_assignee: null })).toBeNull();
    expect(
      trackerShowsFor({
        tracker_assignee: { display_name: 'Vojtěch', user_id: VOJTECH },
        unlinked_assignee: null,
      }),
    ).toEqual({ name: 'Vojtěch', userId: VOJTECH });
    expect(
      trackerShowsFor({
        tracker_assignee: { display_name: null, user_id: null },
        unlinked_assignee: { display_name: null },
      }),
    ).toEqual({ name: null, userId: null });
    // The server's tracker_assignee decides, null included: it says the tracker shows nobody else.
    expect(
      trackerShowsFor({ tracker_assignee: null, unlinked_assignee: { display_name: 'Jan Novák' } }),
    ).toBeNull();
    // An older server that sends no tracker_assignee: only the unlinked assignee is known.
    expect(trackerShowsFor({ unlinked_assignee: { display_name: 'Jan Novák' } })).toEqual({
      name: 'Jan Novák',
      userId: null,
    });
    expect(trackerShowsFor({ unlinked_assignee: null })).toBeNull();
  });
});

const Take = ({
  confirm,
  writesBack,
  tracker = 'Jira',
  confirmed,
}: {
  readonly confirm: TakeConfirm;
  readonly writesBack: boolean;
  readonly tracker?: string;
  readonly confirmed: number[];
}) => {
  const [open, setOpen] = useState(true);
  return (
    <TakeConfirmDialog
      open={open}
      onOpenChange={setOpen}
      ticketKey="DEMO-1"
      confirm={confirm}
      writesBack={writesBack}
      tracker={tracker}
      pending={false}
      error={null}
      onConfirm={() => {
        confirmed.push(1);
      }}
    />
  );
};

/** The dialog's consequence sentence: its description. */
const consequenceOf = (dialog: HTMLElement): string =>
  document.getElementById(dialog.getAttribute('aria-describedby') ?? '')?.textContent ?? '';

const FROM_VOJTECH: TakeConfirm = { kind: 'owner', ownerName: 'Vojtěch', replacing: null };

describe('taking a task from its owner', () => {
  it('names them, says their machine stops getting it, and nothing of the tracker', async () => {
    const confirmed: number[] = [];
    render(<Take confirm={FROM_VOJTECH} writesBack={false} confirmed={confirmed} />);
    const dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    expect(consequenceOf(dialog)).toBe('Their machine stops getting it.');
    expect(dialog.textContent).not.toContain('Jira');
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Take it from Vojtěch' }));
    expect(confirmed).toEqual([1]);
  });

  it('says it also assigns the ticket in the tracker when the project writes it back', async () => {
    render(<Take confirm={FROM_VOJTECH} writesBack confirmed={[]} />);
    const dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    expect(consequenceOf(dialog)).toBe(
      'Their machine stops getting it, and this also assigns DEMO-1 in Jira.',
    );
  });

  it('names the tracker assignee it replaces, as text, only when it writes back', async () => {
    const replacing: TakeConfirm = {
      ...FROM_VOJTECH,
      replacing: { name: `Jan Novák ${HOSTILE}`, userId: null },
    };
    render(<Take confirm={replacing} writesBack confirmed={[]} />);
    let dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    expect(consequenceOf(dialog)).toBe(
      `Their machine stops getting it, and this also assigns DEMO-1 in Jira, replacing Jan Novák ${HOSTILE}.`,
    );
    expect(dialog.querySelector('img')).toBeNull();

    cleanup();
    render(<Take confirm={replacing} writesBack={false} confirmed={[]} />);
    dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    expect(consequenceOf(dialog)).toBe('Their machine stops getting it.');
    expect(dialog.textContent).not.toContain('Jan Novák');
  });

  it('names the owner it replaces in the tracker when the tracker shows them, and a nameless one plainly', async () => {
    render(
      <Take
        confirm={{ ...FROM_VOJTECH, replacing: { name: 'Vojtěch', userId: VOJTECH } }}
        writesBack
        confirmed={[]}
      />,
    );
    let dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    expect(consequenceOf(dialog)).toBe(
      'Their machine stops getting it, and this also assigns DEMO-1 in Jira, replacing Vojtěch.',
    );

    cleanup();
    render(
      <Take
        confirm={{ ...FROM_VOJTECH, replacing: { name: null, userId: null } }}
        writesBack
        confirmed={[]}
      />,
    );
    dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    expect(consequenceOf(dialog)).toBe(
      'Their machine stops getting it, and this also assigns DEMO-1 in Jira, replacing its current assignee there.',
    );
  });
});

describe('taking a task the tracker assigns to somebody the platform cannot link', () => {
  it('says the ticket is reassigned to the reader there, replacing them, as text', async () => {
    const confirmed: number[] = [];
    render(
      <Take
        confirm={{ kind: 'held', assignee: `Jan Novák ${HOSTILE}` }}
        writesBack
        confirmed={confirmed}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1?' });
    expect(consequenceOf(dialog)).toBe(
      `This also assigns DEMO-1 in Jira to you, replacing Jan Novák ${HOSTILE}.`,
    );
    expect(dialog.querySelector('img')).toBeNull();
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Take it and assign in Jira' }));
    expect(confirmed).toEqual([1]);
  });

  it('names the tracker from the ticket’s provider, and a nameless assignee plainly', async () => {
    render(
      <Take
        confirm={{ kind: 'held', assignee: null }}
        writesBack
        tracker="GitLab"
        confirmed={[]}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1?' });
    expect(consequenceOf(dialog)).toBe(
      'This also assigns DEMO-1 in GitLab to you, replacing its current assignee there.',
    );
    expect(
      within(dialog).getByRole('button', { name: 'Take it and assign in GitLab' }),
    ).toBeTruthy();
  });
});
