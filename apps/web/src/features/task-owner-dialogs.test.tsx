/**
 * The owner control's dialogs (S-26.8b, the M26 UX spec § 2), rendered alone.
 *
 * - `OwnerPicker` (*Assign…*) is built ahead of its read (BACKLOG 1297): it lists the candidates it
 *   is given, marks the current owner and does not let them be chosen, holds *Assign* until somebody
 *   is chosen, hands back who, and says so when nobody else can own the task. Names are text.
 * - `TakeFromDialog` names the owner in its title and its act, and mentions the tracker only when
 *   the project writes the assignment back.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type OwnerCandidate, OwnerPicker, TakeFromDialog } from './task-owner-dialogs.js';

const ADA = '00000000-0000-4000-8000-000000000011';
const VOJTECH = '00000000-0000-4000-8000-000000000012';
const HOSTILE = '<img src=x onerror=alert(1)>';

afterEach(() => {
  cleanup();
});

const Picker = ({
  candidates,
  currentOwnerId = null,
  assigned,
  error,
}: {
  readonly candidates: readonly OwnerCandidate[];
  readonly currentOwnerId?: string | null;
  readonly assigned: [string, string][];
  readonly error?: unknown;
}) => {
  const [open, setOpen] = useState(true);
  return (
    <OwnerPicker
      open={open}
      onOpenChange={setOpen}
      ticketKey="ACME-12"
      candidates={candidates}
      currentOwnerId={currentOwnerId}
      pending={false}
      error={error ?? null}
      onAssign={(userId, name) => {
        assigned.push([userId, name]);
      }}
    />
  );
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
        currentOwnerId={VOJTECH}
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
    const assign = within(dialog).getByRole('button', { name: 'Assign' });
    expect((assign as HTMLButtonElement).disabled).toBe(true);
    const user = userEvent.setup();
    await user.selectOptions(field, ADA);
    expect((assign as HTMLButtonElement).disabled).toBe(false);
    await user.click(assign);
    expect(assigned).toEqual([[ADA, `Ada ${HOSTILE}`]]);
  });

  it('says so when nobody else can own it, and offers nothing to assign', async () => {
    const assigned: [string, string][] = [];
    render(
      <Picker
        candidates={[{ user_id: VOJTECH, name: 'Vojtěch' }]}
        currentOwnerId={VOJTECH}
        assigned={assigned}
      />,
    );
    const dialog = await screen.findByRole('dialog', { name: 'Assign ACME-12' });
    expect(within(dialog).getByText('Nobody else in this project can own it.')).toBeTruthy();
    expect(within(dialog).queryByLabelText('Person')).toBeNull();
    expect(
      (within(dialog).getByRole('button', { name: 'Assign' }) as HTMLButtonElement).disabled,
    ).toBe(true);
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

const TakeFrom = ({
  writesBack,
  confirmed,
}: {
  readonly writesBack: boolean;
  readonly confirmed: number[];
}) => {
  const [open, setOpen] = useState(true);
  return (
    <TakeFromDialog
      open={open}
      onOpenChange={setOpen}
      ticketKey="DEMO-1"
      ownerName="Vojtěch"
      writesBack={writesBack}
      tracker="Jira"
      pending={false}
      error={null}
      onConfirm={() => {
        confirmed.push(1);
      }}
    />
  );
};

describe('taking a task from its owner', () => {
  it('names them, says their machine stops getting it, and nothing of the tracker', async () => {
    const confirmed: number[] = [];
    render(<TakeFrom writesBack={false} confirmed={confirmed} />);
    const dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Their machine stops getting it.',
    );
    expect(dialog.textContent).not.toContain('Jira');
    await userEvent
      .setup()
      .click(within(dialog).getByRole('button', { name: 'Take it from Vojtěch' }));
    expect(confirmed).toEqual([1]);
  });

  it('says it also assigns the ticket in the tracker when the project writes it back', async () => {
    render(<TakeFrom writesBack confirmed={[]} />);
    const dialog = await screen.findByRole('dialog', { name: 'Take DEMO-1 from Vojtěch?' });
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Their machine stops getting it, and this also assigns DEMO-1 in Jira.',
    );
  });
});
