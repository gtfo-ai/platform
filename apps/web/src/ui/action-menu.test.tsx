/**
 * ActionMenu's contract (TD-033 § 5): the APG menu button Base UI provides — a named trigger that
 * says it has a popup and whether it is open, `role="menu"` with `menuitem`/`menuitemradio`
 * children, arrow-key movement, Escape back to the trigger, and selection that reaches the caller.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActionMenu,
  ActionMenuHeader,
  ActionMenuItem,
  ActionMenuRadioGroup,
  ActionMenuRadioItem,
  ActionMenuSeparator,
} from './action-menu.js';

afterEach(() => {
  cleanup();
});

const Harness = ({ onRetire }: { readonly onRetire: () => void }) => {
  const [size, setSize] = useState<'small' | 'large'>('small');
  return (
    <>
      <output aria-label="chosen size">{size}</output>
      <ActionMenu label="More actions">
        <ActionMenuHeader>Signed in as Ada</ActionMenuHeader>
        <ActionMenuItem onSelect={() => undefined}>Rename</ActionMenuItem>
        <ActionMenuItem tone="danger" onSelect={onRetire}>
          Retire
        </ActionMenuItem>
        <ActionMenuSeparator />
        <ActionMenuRadioGroup label="Size" value={size} onValueChange={setSize}>
          <ActionMenuRadioItem value="small">Small</ActionMenuRadioItem>
          <ActionMenuRadioItem value="large">Large</ActionMenuRadioItem>
        </ActionMenuRadioGroup>
      </ActionMenu>
    </>
  );
};

describe('ActionMenu', () => {
  it('is a named menu button that is closed until it is pressed', async () => {
    render(<Harness onRetire={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    await userEvent.setup().click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Rename',
      'Retire',
    ]);
    expect(screen.getByText('Signed in as Ada')).toBeTruthy();
  });

  it('calls the item’s handler and closes', async () => {
    const onRetire = vi.fn();
    const user = userEvent.setup();
    render(<Harness onRetire={onRetire} />);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Retire' }));
    expect(onRetire).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('opens from the keyboard on its first item, moves with the arrows, and Escape returns to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness onRetire={() => undefined} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    // Opened from the keyboard, the first item takes focus (APG menu button).
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Rename');
    });
    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Retire');
    });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('offers a labelled radio group whose choice reaches the caller', async () => {
    const user = userEvent.setup();
    render(<Harness onRetire={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const small = await screen.findByRole('menuitemradio', { name: 'Small' });
    const large = screen.getByRole('menuitemradio', { name: 'Large' });
    expect(small.getAttribute('aria-checked')).toBe('true');
    expect(large.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('group', { name: 'Size' })).toBeTruthy();

    await user.click(large);
    expect(screen.getByLabelText('chosen size').textContent).toBe('large');
    expect(screen.getByRole('menuitemradio', { name: 'Large' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('takes a custom trigger, which keeps its own name', async () => {
    render(
      <ActionMenu
        label="ignored"
        trigger={
          <button type="button" aria-label="Account menu">
            A
          </button>
        }
      >
        <ActionMenuItem>Sign out</ActionMenuItem>
      </ActionMenu>,
    );
    expect(screen.queryByRole('button', { name: 'ignored' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });
});
