/**
 * UnderlineNav: the sections of the current object (TD-033 § 1, the second row of every screen).
 *
 * The current item carries `aria-current="page"` and the beacon underline (`--accent-selected`,
 * held to 3:1 on both grounds by `contrast.test.ts`; a darker amber in light, where the beacon is
 * 1.8:1 on white). Narrow widths scroll the row horizontally rather than wrapping it.
 *
 * **Overflow, as GitHub's** (S-23.4): an item with `collapseBelow` leaves the row below that
 * breakpoint, and `more` draws the menu that holds it there. The row hides the item with CSS, so a
 * resize never flashes; the menu is handed **only** the items collapsed at the current width (read
 * through `matchMedia`), so its keyboard navigation never lands on an entry that is also in the row.
 * The caller draws the menu because `ui/` writes no `href` and knows no router (`nav-item.ts`).
 */
import { type ReactElement, type ReactNode, useSyncExternalStore } from 'react';
import { cx, FOCUS_RING } from './cx.js';
import { NAV_BREAKPOINT_PX, type NavBreakpoint, type NavItem } from './nav-item.js';
import { renderNavItem } from './nav-render.js';

/** The row's item: hidden below its breakpoint. Literal strings, so Tailwind's scanner sees them. */
const SHOWN_FROM: Readonly<Record<NavBreakpoint, string>> = {
  sm: 'hidden sm:flex',
  md: 'hidden md:flex',
  lg: 'hidden lg:flex',
  xl: 'hidden xl:flex',
};

/** The "More" entry: shown until the widest collapsing item is back in the row. */
const HIDDEN_FROM: Readonly<Record<NavBreakpoint, string>> = {
  sm: 'flex sm:hidden',
  md: 'flex md:hidden',
  lg: 'flex lg:hidden',
  xl: 'flex xl:hidden',
};

const ORDER: readonly NavBreakpoint[] = ['sm', 'md', 'lg', 'xl'];

const query = (breakpoint: NavBreakpoint): string =>
  `(min-width: ${NAV_BREAKPOINT_PX[breakpoint]}px)`;

/** The widest breakpoint the viewport has reached, or `null` below `sm`. */
const widthTier = (): NavBreakpoint | null => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'xl';
  }
  let reached: NavBreakpoint | null = null;
  for (const breakpoint of ORDER) {
    if (window.matchMedia(query(breakpoint)).matches) {
      reached = breakpoint;
    }
  }
  return reached;
};

const subscribe = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const lists = ORDER.map((breakpoint) => window.matchMedia(query(breakpoint)));
  for (const list of lists) {
    list.addEventListener('change', onChange);
  }
  return () => {
    for (const list of lists) {
      list.removeEventListener('change', onChange);
    }
  };
};

/** Whether an item with this breakpoint is out of the row at the given width. */
export const isCollapsed = (
  breakpoint: NavBreakpoint | undefined,
  reached: NavBreakpoint | null,
): boolean =>
  breakpoint !== undefined &&
  (reached === null || ORDER.indexOf(reached) < ORDER.indexOf(breakpoint));

export const UnderlineNav = ({
  label,
  items,
  more,
  bordered = true,
  className,
}: {
  /** The landmark's name ("Project", "Task"). */
  readonly label: string;
  readonly items: readonly NavItem[];
  /** Draws the overflow menu for the items collapsed at the current width (never empty). */
  readonly more?: (collapsed: readonly NavItem[]) => ReactNode;
  /** `false` when the band around the nav draws the line across the whole page. */
  readonly bordered?: boolean;
  readonly className?: string;
}): ReactElement => {
  const reached = useSyncExternalStore(subscribe, widthTier, () => 'xl' as const);
  const collapsing = items.flatMap((item) =>
    item.collapseBelow === undefined ? [] : [item.collapseBelow],
  );
  const widest = ORDER.filter((breakpoint) => collapsing.includes(breakpoint)).at(-1);
  const collapsed = items.filter((item) => isCollapsed(item.collapseBelow, reached));
  return (
    <nav aria-label={label} className={cx(bordered ? 'border-b border-line' : null, className)}>
      <ul className="flex gap-1 overflow-x-auto">
        {items.map((item) => (
          <li
            key={item.id}
            className={cx(
              'relative shrink-0',
              item.collapseBelow === undefined ? 'flex' : SHOWN_FROM[item.collapseBelow],
            )}
          >
            {renderNavItem(
              item,
              cx(
                'my-2 inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm whitespace-nowrap hover:bg-muted',
                FOCUS_RING,
                item.current === true ? 'font-semibold text-fg' : 'text-fg-muted hover:text-fg',
              ),
            )}
            {item.current === true ? (
              <span
                aria-hidden="true"
                data-underline=""
                className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-selected"
              />
            ) : null}
          </li>
        ))}
        {more === undefined || widest === undefined || collapsed.length === 0 ? null : (
          <li
            data-nav-more=""
            className={cx('relative shrink-0 items-center', HIDDEN_FROM[widest])}
          >
            {more(collapsed)}
            {collapsed.some((item) => item.current === true) ? (
              <span
                aria-hidden="true"
                data-underline=""
                className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-selected"
              />
            ) : null}
          </li>
        )}
      </ul>
    </nav>
  );
};
