/**
 * UnderlineNav: the sections of the current object (TD-033 § 1, the second row of every screen).
 *
 * The current item carries `aria-current="page"` and the beacon underline (`--accent-selected`,
 * held to 3:1 on both grounds by `contrast.test.ts`; a darker amber in light, where the beacon is
 * 1.8:1 on white). Narrow widths scroll the row horizontally rather than wrapping it.
 */
import type { ReactElement } from 'react';
import { cx, FOCUS_RING } from './cx.js';
import type { NavItem } from './nav-item.js';
import { renderNavItem } from './nav-render.js';

export const UnderlineNav = ({
  label,
  items,
  className,
}: {
  /** The landmark's name ("Project", "Task"). */
  readonly label: string;
  readonly items: readonly NavItem[];
  readonly className?: string;
}): ReactElement => (
  <nav aria-label={label} className={cx('border-b border-line', className)}>
    <ul className="flex gap-1 overflow-x-auto">
      {items.map((item) => (
        <li key={item.id} className="relative flex shrink-0">
          {renderNavItem(
            item,
            cx(
              'my-2 inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
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
    </ul>
  </nav>
);
