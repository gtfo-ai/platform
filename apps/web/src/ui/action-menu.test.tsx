/**
 * ActionMenu's contract (TD-033 § 5): the APG menu button Base UI provides — a named trigger that
 * says it has a popup and whether it is open, `role="menu"` with `menuitem`/`menuitemradio`
 * children, arrow-key movement, Escape back to the trigger, and selection that reaches the caller.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        trigger={
          <button type="button" aria-label="Account menu">
            A
          </button>
        }
      >
        <ActionMenuItem>Sign out</ActionMenuItem>
      </ActionMenu>,
    );
    // A name and a custom trigger together do not compile: the trigger carries the name.
    const both = (
      // @ts-expect-error — `label` is only for the default trigger.
      <ActionMenu label="x" trigger={<button type="button">y</button>}>
        {null}
      </ActionMenu>
    );
    expect(both).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });
});

/**
 * The menu's Base UI half is a lazy chunk (S-25.13): `action-menu.tsx` draws a plain trigger when
 * the module is not there yet, and swaps in Base UI's on a press, handing the press on. The ui
 * tier's setup file loads the module before every test file (`test/support/web-lazy-chunks.ts`),
 * so these reset the module registry to meet a menu that first rendered without it.
 */
describe('ActionMenu drawn before its menu module has loaded (S-25.13)', () => {
  it('is already the closed menu button, and a press opens the menu by Base UI’s own path', async () => {
    vi.resetModules();
    const fresh = await import('./action-menu.js');
    render(
      <fresh.ActionMenu label="More actions">
        <fresh.ActionMenuItem onSelect={() => undefined}>Rename</fresh.ActionMenuItem>
      </fresh.ActionMenu>,
    );
    const plain = screen.getByRole('button', { name: 'More actions' });
    expect(plain.getAttribute('aria-haspopup')).toBe('menu');
    expect(plain.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.click(plain);
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    // Base UI's trigger replaced the plain one, and says the menu is open.
    expect(screen.getByRole('button', { name: 'More actions' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('runs a custom trigger’s own click handler once, on the press it hands on', async () => {
    vi.resetModules();
    const fresh = await import('./action-menu.js');
    const onClick = vi.fn();
    render(
      <fresh.ActionMenu
        trigger={
          <button type="button" aria-label="Account menu" onClick={onClick}>
            A
          </button>
        }
      >
        <fresh.ActionMenuItem>Sign out</fresh.ActionMenuItem>
      </fresh.ActionMenu>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('draws Base UI’s Menu at once for a menu that renders after the module has arrived', async () => {
    vi.resetModules();
    const fresh = await import('./action-menu.js');
    await fresh.loadActionMenu();
    render(
      <fresh.ActionMenu label="More actions">
        <fresh.ActionMenuItem>Rename</fresh.ActionMenuItem>
      </fresh.ActionMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'More actions' });
    await userEvent.setup().click(trigger);
    expect(await screen.findByRole('menu')).toBeTruthy();
    // The same element the test held: nothing was swapped.
    expect(trigger.isConnected).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  /** A fresh, unloaded `action-menu.tsx` with two items, its plain trigger focused. */
  const plainMenu = async () => {
    vi.resetModules();
    const fresh = await import('./action-menu.js');
    render(
      <fresh.ActionMenu label="More actions">
        <fresh.ActionMenuItem>Rename</fresh.ActionMenuItem>
        <fresh.ActionMenuItem>Retire</fresh.ActionMenuItem>
      </fresh.ActionMenu>,
    );
    const plain = screen.getByRole('button', { name: 'More actions' });
    plain.focus();
    return fresh;
  };

  it.each([
    ['Enter', '{Enter}', 'Rename'],
    ['ArrowDown', '{ArrowDown}', 'Rename'],
    ['ArrowUp', '{ArrowUp}', 'Retire'],
  ])(
    'opens from the plain trigger on %s, with the focus on the item Base UI chooses',
    async (_key, keys, focused) => {
      await plainMenu();
      await userEvent.setup().keyboard(keys);
      await screen.findByRole('menu');
      await waitFor(() => {
        expect(document.activeElement?.textContent).toBe(focused);
      });
    },
  );

  it('says beside the trigger that the menu could not be loaded, and the next press retries', async () => {
    vi.resetModules();
    const actual =
      await vi.importActual<typeof import('./action-menu-base.js')>('./action-menu-base.js');
    let broken = true;
    vi.doMock('./action-menu-base.js', () => {
      if (broken) {
        throw new Error('the chunk is gone');
      }
      return actual;
    });
    try {
      const fresh = await import('./action-menu.js');
      render(
        <fresh.ActionMenu label="More actions">
          <fresh.ActionMenuItem>Rename</fresh.ActionMenuItem>
        </fresh.ActionMenu>,
      );
      const plain = screen.getByRole('button', { name: 'More actions' });
      fireEvent.click(plain);
      expect((await screen.findByRole('alert')).textContent).toBe(fresh.MENU_LOAD_FAILED);
      expect(screen.queryByRole('menu')).toBeNull();

      broken = false;
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menu')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      vi.doUnmock('./action-menu-base.js');
    }
  });
});
