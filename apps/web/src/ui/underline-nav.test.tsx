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
import { isCollapsed, UnderlineNav } from './underline-nav.js';

afterEach(() => {
  cleanup();
});

const items = (onSelect: () => void): NavItem[] => [
  {
    id: 'board',
    label: 'Board',
    current: true,
    render: (props) => <button type="button" data-caller-link="" {...props} />,
  },
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
    // A caller's link says `aria-current="page"`; a button item is a toggle and says `aria-pressed`.
    const runs = within(nav).getByRole('button', { name: 'Runs 4' });
    expect(runs.hasAttribute('aria-current')).toBe(false);
    expect(runs.getAttribute('aria-pressed')).toBe('false');
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

/** A `matchMedia` that answers for a viewport `width` pixels wide (happy-dom applies no CSS). */
const viewport = (width: number): void => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0) <= width,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
};

describe('UnderlineNav overflow (S-23.4)', () => {
  const wide = (onSelect: () => void): NavItem[] => [
    { id: 'home', label: 'Home', current: true, onSelect },
    { id: 'agents', label: 'Agents', collapseBelow: 'sm', onSelect },
    { id: 'stats', label: 'Statistics', collapseBelow: 'lg', onSelect },
  ];
  const more = (collapsed: readonly NavItem[]) => (
    <span data-more="">{collapsed.map((item) => item.label).join(',')}</span>
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands the menu only the items collapsed at the current width', () => {
    viewport(800);
    const { container } = render(
      <UnderlineNav label="Primary" items={wide(() => undefined)} more={more} />,
    );
    expect(container.querySelector('[data-more]')?.textContent).toBe('Statistics');
    // The row hides the item with CSS below its breakpoint and the More entry from the widest one.
    const stats = screen.getByRole('button', { name: 'Statistics' }).closest('li');
    expect(stats?.className).toContain('hidden lg:flex');
    expect(container.querySelector('[data-nav-more]')?.className).toContain('lg:hidden');
    cleanup();

    viewport(400);
    const narrow = render(
      <UnderlineNav label="Primary" items={wide(() => undefined)} more={more} />,
    );
    expect(narrow.container.querySelector('[data-more]')?.textContent).toBe('Agents,Statistics');
    cleanup();

    viewport(1440);
    const all = render(<UnderlineNav label="Primary" items={wide(() => undefined)} more={more} />);
    expect(all.container.querySelector('[data-nav-more]')).toBeNull();
  });

  it('decides collapse from the breakpoint order', () => {
    expect(isCollapsed(undefined, null)).toBe(false);
    expect(isCollapsed('sm', null)).toBe(true);
    expect(isCollapsed('sm', 'sm')).toBe(false);
    expect(isCollapsed('lg', 'md')).toBe(true);
    expect(isCollapsed('lg', 'xl')).toBe(false);
  });

  it('draws the line unless the band around it does', () => {
    const { container } = render(
      <UnderlineNav label="Project" items={items(() => undefined)} bordered={false} />,
    );
    expect(container.querySelector('nav')?.className).not.toContain('border-b');
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
    // No `render`: the current item is a pressed toggle, not a page link.
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-pressed')).toBe(
      'true',
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
