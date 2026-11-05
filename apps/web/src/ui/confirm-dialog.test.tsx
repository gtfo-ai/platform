/**
 * ConfirmDialog's contract (S-23.23): the act as the dialog's name, the consequence as its
 * description, *Keep it* sends nothing, a required reason holds the act until it is not blank, the
 * reason reaches the caller trimmed, and a refusal is shown inside the dialog with its reason.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfirmDialog, type ConfirmReason } from './confirm-dialog.js';

afterEach(() => {
  cleanup();
});

const Harness = ({
  reason,
  error,
  confirmed,
}: {
  readonly reason?: ConfirmReason;
  readonly error?: unknown;
  readonly confirmed: string[];
}) => {
  const [open, setOpen] = useState(true);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={setOpen}
      title="Reject this proposal?"
      consequence="The proposal is closed for good."
      confirmLabel="Reject"
      {...(reason === undefined ? {} : { reason })}
      {...(error === undefined ? {} : { error })}
      errorTitle="The decision was not recorded."
      onConfirm={(typed) => {
        confirmed.push(typed);
      }}
    />
  );
};

describe('ConfirmDialog', () => {
  it('names the act, describes its consequence, and Keep it sends nothing', async () => {
    const confirmed: string[] = [];
    render(<Harness confirmed={confirmed} />);
    const dialog = await screen.findByRole('dialog', { name: 'Reject this proposal?' });
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'The proposal is closed for good.',
    );
    await userEvent.setup().click(within(dialog).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(confirmed).toEqual([]);
  });

  it('holds a required reason’s act until it is not blank, and hands it over trimmed', async () => {
    const confirmed: string[] = [];
    const user = userEvent.setup();
    render(<Harness confirmed={confirmed} reason={{ label: 'Why', required: true }} />);
    const dialog = await screen.findByRole('dialog');
    const act = within(dialog).getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    expect(act.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Why'), '   ');
    expect(act.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText('Why'), ' wrong page ');
    expect(act.disabled).toBe(false);
    await user.click(act);
    expect(confirmed).toEqual(['wrong page']);
  });

  it('shows a refusal inside the dialog, with its reason', async () => {
    render(<Harness confirmed={[]} error={new Error('role member may not decide proposals')} />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('The decision was not recorded.')).toBeTruthy();
    expect(dialog.textContent).toContain('role member may not decide proposals');
  });
});
