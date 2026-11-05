/**
 * UnderlineNav and NavList (TD-033 § 1): a named navigation landmark, the current item marked with
 * `aria-current="page"` and drawn with its underline (or bar), counters read with the label, and an
 * item that is either the caller's link (`render`) or a button that calls `onSelect`.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NavItem } from './nav-item.js';
import { NavList } from './nav-list.js';
import { UnderlineNav } from './underline-nav.js';

afterEach(() => {
  cleanup();
});

const items = (onSelect: () => void): NavItem[] => [
  { id: 'board', label: 'Board', current: true },
  { id: 'runs', label: 'Runs', counter: 4, onSelect },
  {
    id: 'settings',
    label: 'Settings',
    // A stand-in for the router's `<Link>`: the caller's element, given the props `ui/` decided.
    render: (props) => <button type="button" data-caller-link="" {...props} />,
  },
];

describe('UnderlineNav', () => {
  it('is a named landmark whose current item is marked and underlined', () => {
    const { container } = render(<UnderlineNav label="Project" items={items(() => undefined)} />);
    const nav = screen.getByRole('navigation', { name: 'Project' });
    const board = within(nav).getByRole('button', { name: 'Board' });
    expect(board.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('button', { name: 'Runs 4' }).hasAttribute('aria-current')).toBe(
      false,
    );
    const underlines = container.querySelectorAll('[data-underline]');
    expect(underlines).toHaveLength(1);
    expect(underlines[0]?.parentElement?.contains(board)).toBe(true);
    expect(underlines[0]?.className).toContain('bg-selected');
  });

  it('calls onSelect, and hands a `render` item the class and content it decided', async () => {
    const onSelect = vi.fn();
    render(<UnderlineNav label="Project" items={items(onSelect)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Runs 4' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    const settings = screen.getByRole('button', { name: 'Settings' });
    expect(settings.hasAttribute('data-caller-link')).toBe(true);
    expect(settings.className).toContain('rounded-md');
  });

  it('is reachable from the keyboard in order', async () => {
    const user = userEvent.setup();
    render(<UnderlineNav label="Project" items={items(() => undefined)} />);
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Board');
    await user.tab();
    expect(document.activeElement?.textContent).toBe('Runs4');
  });
});

describe('NavList', () => {
  it('groups items under named lists and marks the current one with its bar', () => {
    const { container } = render(
      <NavList
        label="Settings"
        groups={[
          { label: 'Organisation', items: [{ id: 'general', label: 'General', current: true }] },
          { label: 'Access', items: [{ id: 'users', label: 'Users', counter: 2 }] },
        ]}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('list', { name: 'Organisation' })).toBeTruthy();
    expect(within(nav).getByRole('list', { name: 'Access' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Users 2' })).toBeTruthy();
    expect(container.querySelectorAll('[data-selected-bar]')).toHaveLength(1);
  });

  it('takes a group without a heading', () => {
    render(<NavList label="Filters" groups={[{ items: [{ id: 'open', label: 'Open' }] }]} />);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy();
  });
});
