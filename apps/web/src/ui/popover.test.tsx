/**
 * Popover's contract (TD-033 § 5): closed until its trigger is pressed, opened by a **click** and by
 * the **keyboard** (Enter and Space on a button), a dialog named by its title that may hold a
 * control, closed by Escape with the focus back on the trigger, and the caller told each change.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Popover } from './popover.js';

afterEach(() => {
  cleanup();
});

const renderPopover = (changes: boolean[] = []) =>
  render(
    <Popover
      title="Level 0 · Unverified"
      trigger={<button type="button">Plans need your OK</button>}
      onOpenChange={(open) => {
        changes.push(open);
      }}
    >
      <p>What the level means now.</p>
      <button type="button">Inside</button>
    </Popover>,
  );

describe('Popover', () => {
  it('renders the caller’s trigger and nothing else until it is pressed', () => {
    renderPopover();
    const trigger = screen.getByRole('button', { name: 'Plans need your OK' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('What the level means now.')).toBeNull();
  });

  it('opens on a click as a dialog named by its title, and tells the caller', async () => {
    const changes: boolean[] = [];
    renderPopover(changes);
    const trigger = screen.getByRole('button', { name: 'Plans need your OK' });
    await userEvent.setup().click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Level 0 · Unverified' });
    expect(dialog.textContent).toContain('What the level means now.');
    expect(dialog.hasAttribute('data-popover')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(changes).toEqual([true]);
  });

  it('opens from the keyboard and closes on Escape with the focus back on the trigger', async () => {
    const user = userEvent.setup();
    renderPopover();
    await user.tab();
    const trigger = screen.getByRole('button', { name: 'Plans need your OK' });
    expect(document.activeElement).toBe(trigger);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Level 0 · Unverified' })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
    await user.keyboard(' ');
    expect(await screen.findByRole('dialog', { name: 'Level 0 · Unverified' })).toBeTruthy();
  });
});
