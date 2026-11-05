/**
 * Dialog's contract (TD-033 § 5): a modal `role="dialog"` named by its title and described by its
 * description; Escape and the named close button dismiss it; focus goes back to what opened it.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button.js';
import { Dialog } from './dialog.js';

afterEach(() => {
  cleanup();
});

const renderDialog = (onOpenChange?: (open: boolean) => void) =>
  render(
    <Dialog
      title="Retire this integration?"
      description="Its credentials are deleted; the audit keeps its name."
      trigger={<Button>Retire…</Button>}
      footer={<Button tone="danger">Retire</Button>}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <p>Nothing is bound to it.</p>
    </Dialog>,
  );

describe('Dialog', () => {
  it('opens from its trigger as a named, described modal dialog', async () => {
    renderDialog();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retire…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retire this integration?' });
    const describedBy = dialog.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Its credentials are deleted; the audit keeps its name.',
    );
    expect(screen.getByText('Nothing is bound to it.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retire' })).toBeTruthy();
  });

  it('closes on Escape and returns focus to its trigger', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderDialog(onOpenChange);
    const trigger = screen.getByRole('button', { name: 'Retire…' });
    await user.click(trigger);
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([true, false]);
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('closes from its named close button', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Retire…' }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('gives the focus to the caller’s `initialFocus` rather than the first tabbable', async () => {
    const WithField = () => {
      const field = useRef<HTMLInputElement>(null);
      return (
        <Dialog open title="Start a ticket" initialFocus={field}>
          <button type="button">Help</button>
          <input ref={field} aria-label="Ticket key" />
        </Dialog>
      );
    };
    render(<WithField />);
    await screen.findByRole('dialog', { name: 'Start a ticket' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Ticket key'));
    });
  });

  it('is controlled when the caller holds `open`', async () => {
    render(
      <Dialog open title="Take over this run?">
        <p>body</p>
      </Dialog>,
    );
    expect(await screen.findByRole('dialog', { name: 'Take over this run?' })).toBeTruthy();
  });
});
